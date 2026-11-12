// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id read from GitHub at attach,
// a sync backfilling projects that have none, the operator's re-read from the Admin page, and a rename or
// transfer applied once nest's grant names the new name. Only nest's client interface: a token for the
// repo, and the grant.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { applyRename } from "../src/binding";
import type { RepoBinding } from "../src/do/directory";
import type { Env } from "../src/env";
import { nestFrom } from "../src/nest";
import { AccessTeam, api, deliverGithub, FakeNest, GH_INSTALLATION_ID, installFetch, ownerIdOf, prEvent, repoIdOf, shaOf } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
let restore: () => void;
let token: string;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());
beforeEach(() => {
  fake.grantRepos = null;
  fake.pushRepos = null;
  fake.grantListing = null;
  fake.tokenInstallation = GH_INSTALLATION_ID;
  gh.failures = [];
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  // Issues from anyone: these tests route events, renamed and transferred repos' among them.
  await api(token, "PATCH", `/api/projects/${p.id}/settings`, { issues_from: "anyone" });
  return { id: p.id as string, repo };
}
type P = Awaited<ReturnType<typeof newProject>>;
const directory = () => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
const dirSql = (q: string, ...args: unknown[]) => runInDurableObject(directory(), (_o, st) => st.storage.sql.exec(q, ...args).toArray());
const binding = async (p: P) => ((await api(token, "GET", "/api/admin/bindings")).body as RepoBinding[]).find((b) => b.project === p.id)!;
const reread = (p: P) => api(token, "POST", `/api/admin/bindings/${p.id}`);
const bind = (p: P, repo_id: number) => api(token, "POST", `/api/admin/bindings/${p.id}/bind`, { repo_id });
const sync = () => api(token, "POST", "/api/admin/sync");
const issue = (n: number, repository: Record<string, unknown>) => ({
  action: "opened", sender: { id: 1, login: "x" },
  issue: { number: n, title: `Issue ${n}`, body: "b", state: "open", user: { login: "someone" }, html_url: `https://github.com/x/y/issues/${n}` },
  repository,
});
const numbers = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/issues`)).body as { number: number }[]).map((i) => i.number);
const settingsRepo = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}`)).body.repo as string;
const oldOwnerCopy = (p: P) => runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) =>
  st.storage.sql.exec<{ repo_owner_id: number | null; repo_owner_login: string | null }>("SELECT repo_owner_id, repo_owner_login FROM settings").one());
const reviewRepo = (p: P) => runInDurableObject(env.REVIEW.get(env.REVIEW.idFromName(p.id)), (_o, st) =>
  st.storage.sql.exec<{ v: string }>("SELECT v FROM settings WHERE k = 'repo'").one().v);

describe("read from GitHub, not taken from an event", () => {
  it("attach binds the repo's id from GitHub, and the installation nest minted its token from, so no event's id binds it", async () => {
    const p = await newProject();
    expect(await binding(p)).toMatchObject({ repo: p.repo, repo_id: repoIdOf(p.repo), bound: "github", renamed_to: null, installation_id: GH_INSTALLATION_ID, error: null });
    // Another repo's id under this name (or an event with none) reaches nothing.
    expect(await (await deliverGithub("issues", issue(1, { id: 7, full_name: p.repo }))).json()).toEqual({ ignored: "no project for this repo" });
    expect(await (await deliverGithub("issues", issue(2, { id: undefined, full_name: p.repo }))).json()).toEqual({ ignored: "no project for this repo" });
    await deliverGithub("issues", issue(3, { full_name: p.repo }));
    expect(await numbers(p)).toEqual([3]);
    expect((await binding(p)).repo_id).toBe(repoIdOf(p.repo));
  });

  it("a sync reads the id of a project that has none, and confirms one an event bound; one that doesn't match is shown, not changed", async () => {
    const a = await newProject();
    const b = await newProject();
    const c = await newProject();
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL, repo_bound_ms = NULL WHERE id = ?", a.id);
    await dirSql("UPDATE projects SET repo_bound = 'event' WHERE id = ?", b.id);
    await dirSql("UPDATE projects SET repo_id = 42, repo_bound = 'event' WHERE id = ?", c.id);
    expect((await binding(a)).bound).toBeNull();
    // Until it's read, a project without an id is found by its name (#211).
    await deliverGithub("issues", issue(1, { id: undefined, full_name: a.repo }));
    expect(await numbers(a)).toEqual([1]);
    expect((await sync()).status).toBe(200);
    expect(await binding(a)).toMatchObject({ repo_id: repoIdOf(a.repo), bound: "github", error: null });
    expect(await binding(b)).toMatchObject({ repo_id: repoIdOf(b.repo), bound: "github" });
    // Kept, said plainly: its events still go to the bound repo, and what to check.
    expect(await binding(c)).toMatchObject({ repo_id: 42, bound: "event" });
    expect((await binding(c)).error).toContain(`is repo ${repoIdOf(c.repo)} now, but the project is bound to repo 42, and its events still go to that one`);
    expect((await binding(c)).error).toContain("renamed, transferred or deleted");
    // The operator's re-read shows both and binds neither; choosing GitHub's binds it.
    const r = await reread(c);
    expect(r.status).toBe(200);
    expect(r.body.mismatch).toMatchObject({ bound: { id: 42, full_name: c.repo }, github: { id: repoIdOf(c.repo), full_name: c.repo } });
    expect((await binding(c)).repo_id).toBe(42);
    const chosen = await bind(c, repoIdOf(c.repo));
    expect(chosen.status).toBe(200);
    expect(chosen.body).toMatchObject({ changed: true, previous_id: 42, binding: { repo_id: repoIdOf(c.repo), bound: "github", error: null } });
  });

  it("a GitHub read that fails leaves the project as it was, and the sync goes on", async () => {
    const a = await newProject();
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL WHERE id = ?", a.id);
    gh.fail(new RegExp(`^GET /repos/${a.repo}$`), 502, { times: 1000 });
    expect((await sync()).status).toBe(200);
    expect(await binding(a)).toMatchObject({ repo_id: null, bound: null });
    const r = await reread(a);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/GitHub couldn't be read: .*502/);
  });

  it("never binds a repo another project holds: attach goes on, the binding says why", async () => {
    const a = await newProject();
    const b = await newProject();
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL WHERE id = ?", b.id);
    await dirSql("UPDATE projects SET repo_id = ? WHERE id = ?", repoIdOf(b.repo), a.id);
    const r = await reread(b);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(`Didn't bind: GitHub's repo ${b.repo} (${repoIdOf(b.repo)}) is already project ${a.id}'s`);
    expect(await binding(b)).toMatchObject({ repo_id: null, error: expect.stringContaining(a.id) });
    expect((await api(token, "GET", `/api/projects/${b.id}`)).body.settings ?? (await api(token, "GET", `/api/projects/${b.id}/settings`)).body).toBeTruthy();
  });

  it("re-read answers 404 for no such project, and only takes POST", async () => {
    expect((await api(token, "POST", "/api/admin/bindings/prj_nope0000")).status).toBe(404);
    expect((await api(token, "POST", "/api/admin/bindings/nope")).status).toBe(404);
    const p = await newProject();
    expect((await api(token, "GET", `/api/admin/bindings/${p.id}`)).status).toBe(405);
  });
});

describe("a re-read never rebinds by itself", () => {
  it("no event, old name taken: Re-read doesn't rebind; confirm does, with the shown id only", async () => {
    const p = await newProject();
    const owner = p.repo.split("/")[0]!;
    // Renamed on GitHub with no event since, and the old name registered again by another account.
    gh.rename(p.repo, `${p.repo}-moved`);
    const impostor = gh.take(p.repo, 31_337);
    const before = await binding(p);
    expect(before.owner).toMatchObject({ login: owner });
    const r = await reread(p);
    expect(r.status).toBe(200);
    expect(r.body.mismatch).toEqual({
      bound: { full_name: p.repo, id: repoIdOf(p.repo), owner: { id: before.owner!.id, login: before.owner!.login } },
      github: { full_name: p.repo, id: impostor, owner: { id: 31_337, login: owner }, same_owner: false },
    });
    // Nothing written: still the owner's repo, and its events still reach the project.
    expect(await binding(p)).toEqual(before);
    // Only the id shown binds: any other is refused, as is one GitHub no longer answers.
    const wrong = await bind(p, impostor + 1);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error).toContain(`not the repo ${impostor + 1} you were shown`);
    expect((await binding(p)).repo_id).toBe(repoIdOf(p.repo));
    expect((await api(token, "POST", `/api/admin/bindings/${p.id}/bind`, { repo_id: "x" })).status).toBe(400);
    const ok = await bind(p, impostor);
    expect(ok.status).toBe(200);
    expect(ok.body.binding).toMatchObject({ repo_id: impostor, owner: { id: 31_337 } });
  });

  it("an id learned from an event is recorded as one, so a sync reads it from GitHub", async () => {
    const p = await newProject();
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL, repo_bound_ms = NULL WHERE id = ?", p.id);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: p.repo }));
    expect(await binding(p)).toMatchObject({ repo_id: repoIdOf(p.repo), bound: "event", owner: null });
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo_id: repoIdOf(p.repo), bound: "github", owner: { login: p.repo.split("/")[0] } });
  });
});

describe("the App installation", () => {
  it("a project whose installation is known takes events only from it: another, or none, is refused and acts on nothing", async () => {
    const p = await newProject();
    const other = await deliverGithub("issues", { ...issue(1, { full_name: p.repo }), installation: { id: GH_INSTALLATION_ID + 1 } });
    expect(await other.json()).toEqual({ ignored: `the event's installation (${GH_INSTALLATION_ID + 1}) isn't the project's (${GH_INSTALLATION_ID})` });
    const none = await deliverGithub("issues", { ...issue(2, { full_name: p.repo }), installation: undefined });
    expect(((await none.json()) as { ignored: string }).ignored).toContain("installation (none)");
    // A refused event notes nothing either (a name it gives isn't taken as a rename).
    await deliverGithub("issues", { ...issue(3, { id: repoIdOf(p.repo), full_name: `${p.repo}-x` }), installation: { id: 5 } });
    expect((await binding(p)).renamed_to).toBeNull();
    await deliverGithub("issues", issue(4, { full_name: p.repo }));
    expect(await numbers(p)).toEqual([4]);
  });

  it("an App reinstalled: the right repo's events from the new installation are refused, counted on the binding for the owner to see, until Re-read takes it", async () => {
    const p = await newProject();
    const reinstalled = GH_INSTALLATION_ID + 100;
    for (const n of [1, 2]) {
      const r = await deliverGithub("issues", { ...issue(n, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: reinstalled } });
      expect(((await r.json()) as { ignored: string }).ignored).toContain(`installation (${reinstalled}) isn't the project's (${GH_INSTALLATION_ID})`);
    }
    expect(await numbers(p)).toEqual([]);
    // Shown on the Admin page's binding: how many, from which installation, when.
    expect((await binding(p)).refused).toEqual({ installation: reinstalled, count: 2, last_ms: expect.any(Number) });
    // A re-read while nest still names the old installation changes nothing.
    expect((await reread(p)).status).toBe(200);
    expect(await binding(p)).toMatchObject({ installation_id: GH_INSTALLATION_ID, refused: { count: 2 } });
    // nest mints from the new installation now: Re-read takes it, the refusals are over, its events act.
    fake.tokenInstallation = reinstalled;
    expect((await reread(p)).status).toBe(200);
    expect(await binding(p)).toMatchObject({ installation_id: reinstalled, refused: null });
    await deliverGithub("issues", { ...issue(3, { full_name: p.repo }), installation: { id: reinstalled } });
    expect(await numbers(p)).toEqual([3]);
  });

  it("a project with none yet takes events as before, until a sync reads it; then it's held to it", async () => {
    const p = await newProject();
    await dirSql("UPDATE projects SET installation_id = NULL WHERE id = ?", p.id);
    await deliverGithub("issues", { ...issue(1, { full_name: p.repo }), installation: { id: 5 } });
    expect(await numbers(p)).toEqual([1]);
    expect((await sync()).status).toBe(200);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    await deliverGithub("issues", { ...issue(2, { full_name: p.repo }), installation: { id: 5 } });
    expect(await numbers(p)).toEqual([1]);
  });

  it("a project bound from an event (name only) is held to a stored installation too", async () => {
    const p = await newProject();
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL WHERE id = ?", p.id);
    const r = await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: 5 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("isn't the project's");
    // The refused event's id isn't taken (the binding read again for its installation reads the id from GitHub).
    expect((await binding(p)).bound).not.toBe("event");
    expect(await numbers(p)).toEqual([]);
  });

  it("a reinstalled App: once nest mints from the new installation, its events are taken by themselves, no Re-read; one nest doesn't name is still refused", async () => {
    const p = await newProject();
    const reinstalled = GH_INSTALLATION_ID + 200;
    fake.tokenInstallation = reinstalled;
    const r = await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: reinstalled } });
    expect(await r.json()).toEqual({ ok: true });
    expect(await numbers(p)).toEqual([1]);
    expect(await binding(p)).toMatchObject({ installation_id: reinstalled, refused: null });
    // Another installation, which nest doesn't mint from: refused and counted, the binding as it was, and
    // GitHub read at most once a minute for it however many come.
    const reads = () => gh.callsTo("GET", new RegExp(`^/repos/${p.repo}$`)).length;
    const before = reads();
    for (const n of [2, 3]) {
      const x = await deliverGithub("issues", { ...issue(n, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: 999 } });
      expect(((await x.json()) as { ignored: string }).ignored).toContain("installation (999)");
    }
    expect(await numbers(p)).toEqual([1]);
    expect(await binding(p)).toMatchObject({ installation_id: reinstalled, refused: { installation: 999, count: 2 } });
    expect(reads()).toBe(before);
  });

  it("a token for a name GitHub redirects (moved, no event naming the new name yet) never stores its installation", async () => {
    const p = await newProject();
    const to = `elsewhere-${rand()}/moved`;
    gh.rename(p.repo, to);
    // nest mints for the old name from the installation on the account the repo moved to (and its grant
    // doesn't name the new one, so the rename waits).
    fake.grantRepos = [p.repo];
    fake.tokenInstallation = 31_337;
    expect((await reread(p)).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo_id: repoIdOf(p.repo), installation_id: GH_INSTALLATION_ID, renamed_to: to });
    // So that account's events are still refused.
    const r = await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: to }), installation: { id: 31_337 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("isn't the project's");
  });

  it("a token minted for the old name (the new one not in nest's grant yet) never stores its installation", async () => {
    const p = await newProject();
    const to = `${p.repo}-renamed`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    expect((await binding(p)).renamed_to).toBe(to);
    // The grant names only the old name, whose token comes from another installation (the name's owner now).
    fake.grantRepos = [p.repo];
    fake.tokenInstallation = 31_337;
    expect((await reread(p)).status).toBe(200);
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo_id: repoIdOf(p.repo), installation_id: GH_INSTALLATION_ID });
    // The real repo's events still reach the project.
    fake.grantRepos = null;
    await deliverGithub("issues", issue(2, { id: repoIdOf(p.repo), full_name: to }));
    expect(await numbers(p)).toEqual([1, 2]);
  });

  it("a nest that doesn't name it keeps the stored one; another repo chosen takes its own", async () => {
    const p = await newProject();
    fake.tokenInstallation = null;
    expect((await reread(p)).status).toBe(200);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    // The repo replaced on GitHub, and the operator binds the new one: the installation is the one nest names for it now.
    gh.rename(p.repo, `${p.repo}-gone`);
    const impostor = gh.take(p.repo);
    expect((await reread(p)).body.mismatch.github.id).toBe(impostor);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    // Chosen while nest names none: the old repo's installation isn't kept for the new one.
    await bind(p, impostor);
    expect(await binding(p)).toMatchObject({ repo_id: impostor, installation_id: null });
    // Read again with nest naming it: that one.
    fake.tokenInstallation = 4_242_424;
    await reread(p);
    expect(await binding(p)).toMatchObject({ repo_id: impostor, installation_id: 4_242_424 });
  });
});

describe("a renamed or transferred repo", () => {
  it("its events' new name is noted; the project switches to it once nest's grant names it, everywhere at once", async () => {
    const p = await newProject();
    const to = `elsewhere-${rand()}/moved`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    expect(await numbers(p)).toEqual([1]);
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: to });
    // Not in the grant: kept by its old name (nest mints only for the repos it names), and the re-read says why.
    fake.grantRepos = [p.repo];
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: to });
    const blocked = await reread(p);
    expect(blocked.body.rename).toEqual({ blocked: expect.stringContaining(`doesn't cover ${to}`) });
    expect(await settingsRepo(p)).toBe(p.repo);
    // Named: the re-read switches ProjectDO, ReviewDO and the directory, and the catalog names it.
    fake.grantRepos = [p.repo, to];
    const done = await reread(p);
    expect(done.status).toBe(200);
    expect(done.body.rename).toEqual({ applied: to });
    expect(await binding(p)).toMatchObject({ repo: to, renamed_to: null, repo_id: repoIdOf(p.repo) });
    expect(await settingsRepo(p)).toBe(to);
    expect(await reviewRepo(p)).toBe(to);
    expect(((await api(token, "GET", "/api/admin/sync-state")).body.repos as string[])).toContain(to);
    // GitHub is called by the new name from now on.
    const before = gh.callsTo("GET", new RegExp(`^/repos/${to}/`)).length + gh.callsTo("GET", new RegExp(`^/repos/${to}$`)).length;
    await reread(p);
    expect(gh.callsTo("GET", new RegExp(`^/repos/${to}$`)).length + gh.callsTo("GET", new RegExp(`^/repos/${to}/`)).length).toBeGreaterThan(before);
    // Events by the new name reach it; its old name reaches nothing.
    await deliverGithub("issues", issue(2, { id: repoIdOf(p.repo), full_name: to }));
    expect(await numbers(p)).toEqual([1, 2]);
  });

  it("a rename to a repo nest's grant covers only through an owner-wide entry is applied: nest answers, the app matches nothing itself", async () => {
    const p = await newProject();
    const to = `owner-${rand()}/moved`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    // The grant names only the old repo exactly; nest's answer covers the new one (owner/* matched by the owner's id).
    fake.grantRepos = [p.repo];
    fake.grantListing = { repos: [{ repo: p.repo, push: true, read: true, github: true }], unlisted: [], complete: true };
    expect((await reread(p)).body.rename).toEqual({ blocked: expect.stringContaining(`doesn't cover ${to}`) });
    // nest covers it for reading only: still not attachable (workers push to it).
    fake.grantListing.repos.push({ repo: to, push: false, read: true, github: true });
    expect((await reread(p)).body.rename).toEqual({ blocked: expect.stringContaining(`doesn't cover ${to}`) });
    fake.grantListing.repos[1] = { repo: to, push: true, read: true, github: true };
    expect((await reread(p)).body.rename).toEqual({ applied: to });
    expect(await settingsRepo(p)).toBe(to);
  });

  it("a sync applies a rename the grant names; never onto another project's name", async () => {
    const a = await newProject();
    const b = await newProject();
    // b's repo moved away on GitHub, and a's took its name (b still calls it by it).
    gh.rename(b.repo, `${b.repo}-gone`);
    gh.rename(a.repo, b.repo);
    await deliverGithub("issues", issue(1, { id: repoIdOf(a.repo), full_name: b.repo }));
    fake.grantRepos = [a.repo, b.repo];
    const r = await reread(a);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ rename: { blocked: `${b.repo} is another project's repo` } });
    expect(await settingsRepo(a)).toBe(a.repo);
    expect(await reviewRepo(a)).toBe(a.repo);
    // A name nobody holds: the sync applies it.
    const to = `${a.repo}-renamed`;
    await deliverGithub("issues", issue(2, { id: repoIdOf(a.repo), full_name: to }));
    fake.grantRepos = [a.repo, b.repo, to];
    expect((await sync()).status).toBe(200);
    expect(await binding(a)).toMatchObject({ repo: to, renamed_to: null });
    expect(await settingsRepo(a)).toBe(to);
  });

  it("a rename reaches every reader at once: the directory holds the one name, and ProjectDO, ReviewDO and the Worker read it, whatever their old copies say", async () => {
    const p = await newProject();
    const to = `${p.repo}-renamed`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    fake.grantRepos = [p.repo, to];
    // ReviewDO's old copy (the previous release's) can't be written: the rename is applied all the same.
    const rv = env.REVIEW.get(env.REVIEW.idFromName(p.id));
    await runInDurableObject(rv, (_o, st) => { st.storage.sql.exec("ALTER TABLE settings RENAME TO settings_hidden"); });
    expect((await reread(p)).body.rename).toEqual({ applied: to });
    await runInDurableObject(rv, (_o, st) => { st.storage.sql.exec("ALTER TABLE settings_hidden RENAME TO settings"); });
    expect(await reviewRepo(p)).toBe(p.repo);
    // ProjectDO's old copy says the old name too.
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE settings SET repo = ?", p.repo); });
    // The Worker answers the new name.
    expect(await settingsRepo(p)).toBe(to);
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.repo).toBe(to);
    // ProjectDO calls GitHub by it.
    await api(token, "POST", `/api/projects/${p.id}/issues/import`);
    expect(gh.callsTo("GET", new RegExp(`^/repos/${to}/issues`)).length).toBeGreaterThan(0);
    expect(gh.callsTo("GET", new RegExp(`^/repos/${p.repo}/issues`))).toEqual([]);
    // ReviewDO makes its check runs under it.
    const head = shaOf("renamed-head");
    const e = prEvent({ repo: to, number: 3, sha: head, action: "opened" });
    await deliverGithub("pull_request", { ...e, repository: { ...e.repository, id: repoIdOf(p.repo) } });
    await rv.drain();
    expect(gh.runsOf(to, head)).toHaveLength(1);
    expect(gh.callsTo("POST", new RegExp(`^/repos/${p.repo}/check-runs`))).toEqual([]);
    // The next sync writes the old copies again, for a rollback to find.
    expect((await sync()).status).toBe(200);
    expect(await reviewRepo(p)).toBe(to);
    expect(await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => st.storage.sql.exec<{ repo: string }>("SELECT repo FROM settings").one().repo)).toBe(to);
  });

  it("a directory rename that's refused (its state moved after the name check) renames neither ProjectDO nor ReviewDO", async () => {
    const p = await newProject();
    const to = `${p.repo}-elsewhere`;
    fake.grantRepos = [p.repo, to];
    // The binding as read before the directory moved on: its own rename note is gone, so its guarded
    // rename writes nothing, as when another project takes the name between the check and the rename.
    const stale = { ...(await binding(p)), renamed_to: to };
    const r = await applyRename(env as unknown as Env, nestFrom(env as unknown as Env)!, stale);
    expect(r).toEqual({ blocked: "the rename changed while it was applied: re-read" });
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: null });
    expect(await settingsRepo(p)).toBe(p.repo);
    expect(await reviewRepo(p)).toBe(p.repo);
  });

  it("a re-read follows the name GitHub last gave it, so an old name taken by another repo doesn't rebind it", async () => {
    const p = await newProject();
    const to = `${p.repo}-new`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    const impostor = gh.take(p.repo);
    expect(impostor).not.toBe(repoIdOf(p.repo));
    // nest's grant covers only the old name, so the rename itself waits (this test is about the read).
    fake.grantListing = { repos: [{ repo: p.repo, push: true, read: true, github: true }], unlisted: [], complete: true };
    const r = await reread(p);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, binding: { repo_id: repoIdOf(p.repo), renamed_to: to } });
  });
});

describe("a sync reads again what may have moved", () => {
  it("a binding with a rename noted, or events refused: its owner and installation as GitHub and nest answer now, and the previous release's owner copy with them", async () => {
    // Transferred: its events name the new name; the rename waits (not in nest's grant), the read doesn't.
    const a = await newProject();
    const newOwner = `n-${rand()}`;
    const to = `${newOwner}/moved`;
    gh.rename(a.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(a.repo), full_name: to }));
    expect(await binding(a)).toMatchObject({ renamed_to: to, owner: { login: a.repo.split("/")[0] } });
    fake.grantRepos = [a.repo];
    expect((await sync()).status).toBe(200);
    expect((await binding(a)).owner).toMatchObject({ id: ownerIdOf(newOwner), login: newOwner });
    // The copy a rolled-back release trusts is the owner now, not the one at attach.
    expect(await oldOwnerCopy(a)).toEqual({ repo_owner_id: ownerIdOf(newOwner), repo_owner_login: newOwner });
    // Events refused while nest still answered the old installation (the minute's read spent on that).
    fake.grantRepos = null;
    const b = await newProject();
    const reinstalled = GH_INSTALLATION_ID + 300;
    await deliverGithub("issues", { ...issue(1, { id: repoIdOf(b.repo), full_name: b.repo }), installation: { id: reinstalled } });
    expect(await binding(b)).toMatchObject({ installation_id: GH_INSTALLATION_ID, refused: { count: 1 } });
    fake.tokenInstallation = reinstalled;
    expect((await sync()).status).toBe(200);
    expect(await binding(b)).toMatchObject({ installation_id: reinstalled, refused: null });
  });

  it("attach takes a token's installation only for the name GitHub answers with: a redirected name's may be another account's", async () => {
    const from = `o-${rand()}/r-${rand()}`;
    const to = `elsewhere-${rand()}/moved`;
    gh.repo(from);
    gh.rename(from, to);
    // nest's grant names the old name only, and mints for it from the installation on the account it moved to.
    fake.grantRepos = [from];
    fake.tokenInstallation = 31_337;
    const p = (await api(token, "POST", "/api/projects", { name: from, repo: from })).body;
    expect(p.settings).toMatchObject({ attached: true });
    expect((await api(token, "GET", "/api/admin/bindings")).body.find((b: RepoBinding) => b.project === p.id)).toMatchObject({ repo_id: repoIdOf(from), installation_id: null, renamed_to: to });
  });
});

describe("a binding not read from GitHub yet (no id, or one from an event)", () => {
  it("an event routed by the repo's name alone trusts nobody by owning it", async () => {
    const p = await newProject();
    // Someone else is the comments user, so only ownership is tested.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { comments_from_id: 4321, issues_from: "trusted" });
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL, installation_id = NULL WHERE id = ?", p.id);
    // The repo under the name now (its owner's, as far as the event says): routed by the name.
    const owner = { id: ownerIdOf(p.repo.split("/")[0]!), login: p.repo.split("/")[0]!, type: "User" };
    await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: p.repo, owner }), issue: { ...issue(1, {}).issue, user: { login: owner.login, id: owner.id } } });
    expect(await numbers(p)).toEqual([]);
    // Bound from GitHub (a sync), the same owner's events count.
    expect((await sync()).status).toBe(200);
    await deliverGithub("issues", { ...issue(2, { full_name: p.repo }), issue: { ...issue(2, {}).issue, user: { login: owner.login, id: owner.id } } });
    expect(await numbers(p)).toEqual([2]);
  });

  it("is bound to GitHub's repo for its name only with the owner recorded at attach: a name taken over isn't bound by a sync, a refused event or attach; Re-read shows both", async () => {
    const p = await newProject();
    const mallory = { id: 987_654, login: "mallory" };
    // No id yet, and none of the binding's own owner (learned from an event): the owner recorded at attach decides.
    await dirSql("UPDATE projects SET repo_id = NULL, repo_bound = NULL, repo_owner_id = NULL, repo_owner_login = NULL WHERE id = ?", p.id);
    // The name is another repo now, mallory's, on mallory's installation, and nest mints for it from there.
    gh.rename(p.repo, `${p.repo}-gone`);
    const taken = gh.take(p.repo, mallory.id);
    fake.tokenInstallation = 777;
    const r = await deliverGithub("issues", { ...issue(1, { id: taken, full_name: p.repo, owner: { ...mallory, type: "User" } }), installation: { id: 777 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("isn't the project's");
    expect(await binding(p)).toMatchObject({ repo_id: null, installation_id: GH_INSTALLATION_ID, error: expect.stringContaining("the owner recorded for the project") });
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo_id: null, installation_id: GH_INSTALLATION_ID });
    expect((await api(token, "POST", `/api/projects/${p.id}/attach`)).status).toBe(200);
    expect((await binding(p)).repo_id).toBeNull();
    // The operator's Re-read: both, and nothing written; their choice binds it.
    const rr = await reread(p);
    expect(rr.body.mismatch).toMatchObject({ bound: { id: null, owner: { id: ownerIdOf(p.repo.split("/")[0]!) } }, github: { id: taken, owner: { id: mallory.id }, same_owner: false } });
    expect((await binding(p)).repo_id).toBeNull();
    expect((await bind(p, taken)).body.binding).toMatchObject({ repo_id: taken });
  });

  it("\"Use the repo owner\" and an import read the owner of the bound repo only: GitHub's repo for the name being another, they're refused", async () => {
    const p = await newProject();
    gh.rename(p.repo, `${p.repo}-gone`);
    gh.take(p.repo, 987_654);
    const use = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { comments_from_repo_owner: true });
    expect(use.status).toBe(409);
    expect(use.body.error).toContain("not the bound repo");
    const imp = await api(token, "POST", `/api/projects/${p.id}/issues/import`);
    expect(imp.status).toBe(409);
    expect(imp.body.error).toContain("not the bound repo");
  });
});

describe("DirectoryDO not answering", () => {
  /** DirectoryDO's projects unreadable for `f`'s length, as when it doesn't answer. */
  const directoryDown = async <T>(f: () => Promise<T>): Promise<T> => {
    await dirSql("ALTER TABLE projects RENAME TO projects_hidden");
    try {
      return await f();
    } finally {
      await dirSql("ALTER TABLE projects_hidden RENAME TO projects");
    }
  };

  it("ProjectDO's drain goes on: a routine run that needs the repo's name is retried, a stop owed still goes", async () => {
    const p = await newProject();
    const routine = (await api(token, "POST", `/api/projects/${p.id}/routines`, {
      name: "R", kind: "custom", prompt: "Look around.", enabled: true, triggers: { timer: null, tasks_done: null, prs_merged: null },
      cooldown_min: 0, max_minutes: 30, max_turns: 3, proposals: "triage",
    })).body.id as string;
    // Its first start fails (nest), so it waits to be tried again.
    fake.failures.push({ match: /^POST \/v1\/sandboxes$/, status: 503, retryable: true, times: 50 });
    expect((await api(token, "POST", `/api/projects/${p.id}/routines/${routine}/run`)).status).toBe(200);
    fake.failures = [];
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    await runInDurableObject(stub, (_o, st) => {
      st.storage.sql.exec("UPDATE routine_runs SET next_ms = 0, spawn = NULL WHERE state = 'starting'");
      st.storage.sql.exec("INSERT INTO stops (agent, task, reason, next_ms) VALUES ('agt_owed', NULL, 'test', 0)");
    });
    await directoryDown(() => stub.drain());
    expect(fake.calls.some((c) => c.path === "/v1/agents/agt_owed/stop")).toBe(true);
    const run = await runInDurableObject(stub, (_o, st) => st.storage.sql.exec("SELECT state, error, next_ms FROM routine_runs").one());
    expect(run).toMatchObject({ state: "starting", error: expect.stringContaining("projects") });
    expect(run.next_ms as number).toBeGreaterThan(Date.now());
  });

  it("ReviewDO's drain goes on: a reviewer's stop owed still goes, and the rest is tried again shortly", async () => {
    const p = await newProject();
    const rv = env.REVIEW.get(env.REVIEW.idFromName(p.id));
    await runInDurableObject(rv, (_o, st) => {
      st.storage.sql.exec("INSERT INTO stops (agent, reason, next_ms) VALUES ('agt_review_owed', 'test', 0)");
      // A check's update owed to GitHub, which needs the name.
      st.storage.sql.exec("INSERT INTO check_updates (check_run, body, next_ms) VALUES (4712, '{}', 0)");
    });
    const before = gh.calls.length;
    await directoryDown(() => rv.drain());
    expect(fake.calls.some((c) => c.path === "/v1/agents/agt_review_owed/stop")).toBe(true);
    expect(gh.calls.length).toBe(before);
    // Tried again shortly, not at once (no spinning on a DirectoryDO that doesn't answer).
    const alarm = await runInDurableObject(rv, (_o, st) => st.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 1_000);
  });
});

describe("the repos the owner may attach (GET /api/repos)", () => {
  it("lists what nest's grant lets the app attach (push and tokens), by nest's answer, each with the project already on it", async () => {
    const p = await newProject();
    const free = `owner-${rand()}/free`;
    fake.grantListing = {
      repos: [
        { repo: p.repo, push: true, read: true, github: true },
        { repo: free, push: true, read: true, github: true },
        { repo: `owner-${rand()}/read-only`, push: false, read: true, github: true },
        { repo: `owner-${rand()}/no-tokens`, push: true, read: true, github: false },
      ],
      unlisted: ["elsewhere/*"], complete: true,
    };
    const r = await api(token, "GET", "/api/repos");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ repos: [{ repo: p.repo, project: p.id }, { repo: free, project: null }], unlisted: ["elsewhere/*"], complete: true });
    expect((await api(token, "POST", "/api/repos")).status).toBe(405);
  });

  it("a nest from before its grant routes: the repos named exactly in both of the grant's lists, never an owner-wide entry", async () => {
    fake.grantListing = "missing";
    // An owner-wide entry in both lists: a previous nest has no answer for it, so it's never offered (nor `owner/*` itself).
    fake.grantRepos = ["a/one", "a/two", "a/tokens-only", "wide/*"];
    fake.pushRepos = ["a/one", "a/two", "a/push-only", "wide/*"];
    const r = await api(token, "GET", "/api/repos");
    expect(r.body).toEqual({ repos: [{ repo: "a/one", project: null }, { repo: "a/two", project: null }], unlisted: [], complete: true });
  });

  it("a project can be created only on a repo nest's grant lets the app attach: a typed name outside it is refused, and nothing is left stuck", async () => {
    fake.grantListing = { repos: [{ repo: "in/side", push: true, read: true, github: true }, { repo: "read/only", push: false, read: true, github: true }], unlisted: [], complete: true };
    for (const repo of ["out/side", "read/only"]) {
      const r = await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo });
      expect(r.status, repo).toBe(403);
      expect(r.body.error).toContain(repo);
    }
    expect(((await api(token, "GET", "/api/projects")).body.projects as { repo: string }[]).map((p) => p.repo)).not.toContain("out/side");
    // Granted later: the same name is created at once (no project stuck on it from the refused try).
    fake.grantListing.repos.push({ repo: "out/side", push: true, read: true, github: true });
    expect((await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo: "out/side" })).status).toBe(201);
    // An older nest: its exact entries decide.
    fake.grantListing = "missing";
    fake.grantRepos = ["old/one"];
    expect((await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo: "old/two" })).status).toBe(403);
    expect((await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo: "old/one" })).status).toBe(201);
  });

  it("nest's failure is said, not an empty list", async () => {
    fake.failures.push({ match: /^GET \/v1\/clients\/self\/grant\/repos$/, status: 503, retryable: true, times: 10 });
    fake.grantListing = { repos: [], unlisted: [], complete: true };
    const r = await api(token, "GET", "/api/repos");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("nest couldn't say");
  });
});
