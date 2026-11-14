// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id read from GitHub at attach,
// a sync backfilling projects that have none, the operator's re-read from the Admin page, and a rename or
// transfer applied once nest's grant names the new name. A token of the app's own App for the repo, its
// installation looked up from GitHub (or nest's token, in the fallback), and nest's grant.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { applyRename } from "../src/binding";
import type { RepoBinding } from "../src/do/directory";
import type { Env } from "../src/env";
import { PERMISSIONS } from "../src/github";
import { AppTokens, resetAppTokens } from "../src/github-app";
import { nestFrom } from "../src/nest";
import { AccessTeam, api, deliverGithub, FakeNest, GH_APP_OWNER, GH_APP_SLUG, GH_INSTALLATION_ID, GRANT_PERMISSIONS, installFetch, ownerIdOf, prEvent, repoIdOf, shaOf, withEnv, withNestTokens } from "./fake-nest";

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
  // The default installation only: each test installs on its own accounts.
  gh.installations = [{ id: GH_INSTALLATION_ID, account: null, repos: "all", permissions: { ...GRANT_PERMISSIONS } }];
  gh.lookupIgnoresSelection = false;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
async function newProject(repo = `o-${rand()}/r-${rand()}`.toLowerCase()) {
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
  it("attach binds the repo's id from GitHub, and the App's installation on it as GitHub answers, so no event's id binds it", async () => {
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

  it("an App reinstalled: the binding follows GitHub's lookup at once, its first event is taken; a token cached from the old installation is never used again", async () => {
    const p = await newProject();
    const account = p.repo.split("/")[0]!;
    // A token from the installation the project was bound to, cached by the import.
    gh.issues.set(p.repo, new Map());
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/import`)).status).toBe(200);
    const before = gh.mints().length;
    // Reinstalled on the repo's account: the old installation is gone, and GitHub sends events from the new one.
    const reinstalled = GH_INSTALLATION_ID + 100;
    gh.reinstall(account, reinstalled);
    const r = await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: p.repo }));
    expect(await r.json()).toEqual({ ok: true });
    expect(await numbers(p)).toEqual([1]);
    expect(await binding(p)).toMatchObject({ installation_id: reinstalled, refused: null });
    // The import again: its token minted from the new installation, not the one cached from the old.
    expect((await api(token, "POST", `/api/projects/${p.id}/issues/import`)).status).toBe(200);
    expect(gh.mints().slice(before).map((m) => m.installation)).toContain(reinstalled);
    expect(gh.mints().slice(before).map((m) => m.installation)).not.toContain(GH_INSTALLATION_ID);
    const reads = gh.callsTo("GET", new RegExp(`^/repos/${p.repo}/issues$`));
    expect(gh.tokens.get(reads.at(-1)!.token!)!.installation).toBe(reinstalled);
  });

  it("an event from an installation GitHub doesn't answer for the repo is refused and counted, and a Re-read changes nothing; GitHub reads it at most once a minute", async () => {
    const p = await newProject();
    const reads = () => gh.callsTo("GET", new RegExp(`^/repos/${p.repo}$`)).length;
    for (const n of [1, 2]) {
      const r = await deliverGithub("issues", { ...issue(n, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: 999 } });
      expect(((await r.json()) as { ignored: string }).ignored).toContain(`installation (999) isn't the project's (${GH_INSTALLATION_ID})`);
    }
    expect(await numbers(p)).toEqual([]);
    // Shown on the Admin page's binding: how many, from which installation, when.
    expect((await binding(p)).refused).toEqual({ installation: 999, count: 2, last_ms: expect.any(Number) });
    const before = reads();
    await deliverGithub("issues", { ...issue(3, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: 999 } });
    expect(reads()).toBe(before);
    expect((await reread(p)).status).toBe(200);
    expect(await binding(p)).toMatchObject({ installation_id: GH_INSTALLATION_ID, refused: { installation: 999, count: 3 } });
  });

  it("with nest's tokens (the fallback): a re-read while nest names the old installation changes nothing, then takes the one nest names", async () => {
    await withNestTokens(async () => {
      const p = await newProject();
      const reinstalled = GH_INSTALLATION_ID + 150;
      const r = await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: p.repo }), installation: { id: reinstalled } });
      expect(((await r.json()) as { ignored: string }).ignored).toContain(`installation (${reinstalled}) isn't the project's (${GH_INSTALLATION_ID})`);
      expect((await reread(p)).status).toBe(200);
      expect(await binding(p)).toMatchObject({ installation_id: GH_INSTALLATION_ID, refused: { count: 1 } });
      fake.tokenInstallation = reinstalled;
      expect((await reread(p)).status).toBe(200);
      expect(await binding(p)).toMatchObject({ installation_id: reinstalled, refused: null });
    });
  });

  it("a project with none yet takes events as before (its repo owner the App's), until a sync reads it; then it's held to it", async () => {
    const p = await newProject(`${GH_APP_OWNER}/r-${rand()}`);
    await dirSql("UPDATE projects SET installation_id = NULL WHERE id = ?", p.id);
    await deliverGithub("issues", { ...issue(1, { full_name: p.repo }), installation: { id: 5 } });
    expect(await numbers(p)).toEqual([1]);
    expect((await sync()).status).toBe(200);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    await deliverGithub("issues", { ...issue(2, { full_name: p.repo }), installation: { id: 5 } });
    expect(await numbers(p)).toEqual([1]);
  });

  it("a project with none yet refuses its events while the accounts the app acts for can't be read (GET /app failing): fails closed", async () => {
    const p = await newProject(`${GH_APP_OWNER}/r-${rand()}`);
    await dirSql("UPDATE projects SET installation_id = NULL WHERE id = ?", p.id);
    resetAppTokens();
    gh.fail(/^GET \/app$/, 502, { times: 20 });
    const r = await deliverGithub("issues", { ...issue(1, { full_name: p.repo }), installation: { id: 5 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("repo owner isn't an account the app acts for");
    expect(await numbers(p)).toEqual([]);
  });

  it("a project with none yet refuses an event whose repo owner isn't an account the app acts for, until GITHUB_ACCOUNTS names it", async () => {
    const p = await newProject();
    await dirSql("UPDATE projects SET installation_id = NULL WHERE id = ?", p.id);
    // Its installation can't be read meanwhile (so the refused event's re-read binds none).
    gh.fail(new RegExp(`^GET /repos/${p.repo}/installation$`), 502, { times: 10 });
    const r = await deliverGithub("issues", { ...issue(1, { full_name: p.repo }), installation: { id: 5 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("repo owner isn't an account the app acts for");
    expect(await numbers(p)).toEqual([]);
    expect((await binding(p)).refused).toMatchObject({ count: 1 });
    // An event naming no installation is refused all the same.
    const none = await deliverGithub("issues", { ...issue(3, { full_name: p.repo }), installation: undefined });
    expect(((await none.json()) as { ignored: string }).ignored).toContain("repo owner isn't an account the app acts for");
    expect(await numbers(p)).toEqual([]);
    await withEnv("GITHUB_ACCOUNTS", String(ownerIdOf(p.repo.split("/")[0]!)), async () => {
      await deliverGithub("issues", { ...issue(2, { full_name: p.repo }), installation: { id: 5 } });
    });
    expect(await numbers(p)).toEqual([2]);
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

  it("an installation looked up by a name GitHub redirects (moved, no event naming the new name yet) is never stored: it's taken only once the repo is read by its own name", async () => {
    const p = await newProject();
    const to = `elsewhere-${rand()}/moved`;
    gh.rename(p.repo, to);
    // GitHub answers the old name with the installation on the account the repo moved to.
    gh.install({ id: 31_337, account: to.split("/")[0]! });
    const first = await reread(p);
    expect(first.status).toBe(200);
    // Read by the old name: the new name noted and applied (the App reaches it), the installation not stored.
    expect(first.body.rename).toEqual({ applied: to });
    expect(await binding(p)).toMatchObject({ repo: to, repo_id: repoIdOf(p.repo), installation_id: GH_INSTALLATION_ID });
    // Read again, by its own name now: the installation GitHub answers for it.
    expect((await reread(p)).status).toBe(200);
    expect((await binding(p)).installation_id).toBe(31_337);
  });

  it("a new name the App doesn't reach: neither it nor an installation is bound, and its events are refused; once the App reaches it, the binding follows", async () => {
    const p = await newProject();
    const account = `n-${rand()}`;
    const to = `${account}/moved`;
    gh.rename(p.repo, to);
    // Moved to an account whose installation of the App doesn't select the repo.
    gh.install({ id: 31_338, account, repos: [] });
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    expect((await binding(p)).renamed_to).toBe(to);
    const r = await reread(p);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("isn't installed");
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo: p.repo, repo_id: repoIdOf(p.repo), installation_id: GH_INSTALLATION_ID, renamed_to: to });
    const refused = await deliverGithub("issues", { ...issue(2, { id: repoIdOf(p.repo), full_name: to }), installation: { id: 31_338 } });
    expect(((await refused.json()) as { ignored: string }).ignored).toContain("isn't the project's");
    // The installation selects it now: the next read binds the new name and its installation.
    gh.install({ id: 31_338, account, repos: [to] });
    expect((await reread(p)).body.rename).toEqual({ applied: to });
    expect(await binding(p)).toMatchObject({ repo: to, installation_id: 31_338 });
    await deliverGithub("issues", { ...issue(3, { id: repoIdOf(p.repo), full_name: to }), installation: { id: 31_338 } });
    expect(await numbers(p)).toEqual([1, 3]);
  });

  it("with nest's tokens (the fallback), a nest that doesn't name it keeps the stored one; another repo chosen takes its own", async () => {
    await withNestTokens(async () => {
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

  it("another repo chosen takes the installation GitHub answers for it", async () => {
    const p = await newProject();
    gh.rename(p.repo, `${p.repo}-gone`);
    // The name is another account's repo now (its login taken over), on that account's own installation.
    gh.install({ id: 4_242_424, account: p.repo.split("/")[0]! });
    const impostor = gh.take(p.repo, 31_337);
    expect((await reread(p)).body.mismatch.github.id).toBe(impostor);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    await bind(p, impostor);
    expect(await binding(p)).toMatchObject({ repo_id: impostor, installation_id: 4_242_424 });
  });
});

describe("a renamed or transferred repo", () => {
  it("its events' new name is noted; the project switches to it once the App reaches it, everywhere at once", async () => {
    const p = await newProject();
    const account = `elsewhere-${rand()}`;
    const to = `${account}/moved`;
    gh.rename(p.repo, to);
    // Moved to an account the App's installation there doesn't reach it on yet (no repos selected).
    gh.install({ id: 41_001, account, repos: [] });
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    expect(await numbers(p)).toEqual([1]);
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: to });
    // Not reached: kept by its old name, and the re-read says why.
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: to });
    const blocked = await reread(p);
    expect(blocked.body.error).toContain("isn't installed");
    expect(await settingsRepo(p)).toBe(p.repo);
    // Reached (the installation selects it): the re-read switches ProjectDO, ReviewDO and the directory, and the catalog names it.
    gh.install({ id: 41_001, account, repos: [to] });
    const done = await reread(p);
    expect(done.status).toBe(200);
    expect(done.body.rename).toEqual({ applied: to });
    expect(await binding(p)).toMatchObject({ repo: to, renamed_to: null, repo_id: repoIdOf(p.repo), installation_id: 41_001 });
    expect(await settingsRepo(p)).toBe(to);
    expect(await reviewRepo(p)).toBe(to);
    expect(((await api(token, "GET", "/api/admin/sync-state")).body.repos as string[])).toContain(to);
    // GitHub is called by the new name from now on.
    const before = gh.callsTo("GET", new RegExp(`^/repos/${to}/`)).length + gh.callsTo("GET", new RegExp(`^/repos/${to}$`)).length;
    await reread(p);
    expect(gh.callsTo("GET", new RegExp(`^/repos/${to}$`)).length + gh.callsTo("GET", new RegExp(`^/repos/${to}/`)).length).toBeGreaterThan(before);
    // Events by the new name, from its installation, reach it.
    await deliverGithub("issues", issue(2, { id: repoIdOf(p.repo), full_name: to }));
    expect(await numbers(p)).toEqual([1, 2]);
  });

  it("a rename is applied by GitHub's answer alone: nest's grant isn't asked", async () => {
    const p = await newProject();
    const to = `owner-${rand()}/moved`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    // nest's grant names neither name: the App reaches the new one, which is what counts.
    fake.grantRepos = ["someone/else"];
    fake.grantListing = { repos: [], unlisted: [], complete: true };
    expect((await reread(p)).body.rename).toEqual({ applied: to });
    expect(await settingsRepo(p)).toBe(to);
    expect(fake.calls.filter((c) => c.path === "/v1/clients/self/grant/repos")).toEqual([]);
  });

  it("a sync applies a rename the App reaches; never onto another project's name", async () => {
    const a = await newProject();
    const b = await newProject();
    // b's repo moved away on GitHub, and a's took its name (b still calls it by it).
    gh.rename(b.repo, `${b.repo}-gone`);
    gh.rename(a.repo, b.repo);
    await deliverGithub("issues", issue(1, { id: repoIdOf(a.repo), full_name: b.repo }));
    const r = await reread(a);
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ rename: { blocked: `${b.repo} is another project's repo` } });
    expect(await settingsRepo(a)).toBe(a.repo);
    expect(await reviewRepo(a)).toBe(a.repo);
    // A name nobody holds: the sync applies it.
    const to = `${a.repo}-renamed`;
    await deliverGithub("issues", issue(2, { id: repoIdOf(a.repo), full_name: to }));
    expect((await sync()).status).toBe(200);
    expect(await binding(a)).toMatchObject({ repo: to, renamed_to: null });
    expect(await settingsRepo(a)).toBe(to);
  });

  it("a rename reaches every reader at once: the directory holds the one name, and ProjectDO, ReviewDO and the Worker read it, whatever their old copies say", async () => {
    const p = await newProject();
    const to = `${p.repo}-renamed`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
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
    // Read by the new name: the repo the project is bound to, not the one under its old name now.
    const r = await reread(p);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, rename: { applied: to }, binding: { repo: to, repo_id: repoIdOf(p.repo) } });
  });
});

describe("a sync reads again what may have moved", () => {
  it("a binding with a rename noted, or events refused: its owner and installation as GitHub and nest answer now, and the previous release's owner copy with them", async () => {
    // Transferred: its events name the new name, and a sync reads it there.
    const a = await newProject();
    const newOwner = `n-${rand()}`;
    const to = `${newOwner}/moved`;
    gh.rename(a.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(a.repo), full_name: to }));
    expect(await binding(a)).toMatchObject({ renamed_to: to, owner: { login: a.repo.split("/")[0] } });
    expect((await sync()).status).toBe(200);
    expect((await binding(a)).owner).toMatchObject({ id: ownerIdOf(newOwner), login: newOwner });
    // The copy a rolled-back release trusts is the owner now, not the one at attach.
    expect(await oldOwnerCopy(a)).toEqual({ repo_owner_id: ownerIdOf(newOwner), repo_owner_login: newOwner });
    // Events refused while GitHub still answered the old installation (the minute's read spent on that).
    const b = await newProject();
    const reinstalled = GH_INSTALLATION_ID + 300;
    await deliverGithub("issues", { ...issue(1, { id: repoIdOf(b.repo), full_name: b.repo }), installation: { id: reinstalled } });
    expect(await binding(b)).toMatchObject({ installation_id: GH_INSTALLATION_ID, refused: { count: 1 } });
    gh.reinstall(b.repo.split("/")[0]!, reinstalled);
    expect((await sync()).status).toBe(200);
    expect(await binding(b)).toMatchObject({ installation_id: reinstalled, refused: null });
  });

  it("an owner the previous release wrote (without its kind) has no kind, so no sync copies it as a user's", async () => {
    const p = await newProject();
    const owner = p.repo.split("/")[0]!;
    expect((await binding(p)).owner).toEqual({ id: ownerIdOf(owner), login: owner, type: "User" });
    // A rolled-back release's read: another owner (an organization, say), its kind column left as it was.
    await dirSql("UPDATE projects SET repo_owner_id = 55503, repo_owner_login = 'an-org' WHERE id = ?", p.id);
    expect((await binding(p)).owner).toEqual({ id: 55503, login: "an-org", type: null });
    expect((await sync()).status).toBe(200);
    expect(await oldOwnerCopy(p)).toEqual({ repo_owner_id: ownerIdOf(owner), repo_owner_login: owner });
  });

  it("attach takes the installation it looked up only for the name GitHub answers with: a redirected name's may be another account's", async () => {
    const from = `o-${rand()}/r-${rand()}`;
    const to = `elsewhere-${rand()}/moved`;
    gh.repo(from);
    gh.rename(from, to);
    // GitHub answers the old name with the installation on the account it moved to.
    gh.install({ id: 31_337, account: to.split("/")[0]! });
    const p = (await api(token, "POST", "/api/projects", { name: from, repo: from })).body;
    expect(p.settings).toMatchObject({ attached: true });
    expect((await api(token, "GET", "/api/admin/bindings")).body.find((b: RepoBinding) => b.project === p.id)).toMatchObject({ repo_id: repoIdOf(from), installation_id: null, renamed_to: to });
  });
});

describe("a binding not read from GitHub yet (no id, or one from an event)", () => {
  it("an event routed by the repo's name alone trusts nobody by owning it", async () => {
    // A repo of the App owner's account: a binding with no installation takes only its events.
    const p = await newProject(`${GH_APP_OWNER}/r-${rand()}`);
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
    // The name is another repo now, mallory's (the login taken over), on mallory's installation, which GitHub answers for it.
    gh.rename(p.repo, `${p.repo}-gone`);
    const taken = gh.take(p.repo, mallory.id);
    gh.install({ id: 777, account: p.repo.split("/")[0]! });
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

  it("Settings shows the owner of the bound repo only: GitHub's repo for the name being another, nobody", async () => {
    const p = await newProject();
    const owner = p.repo.split("/")[0]!;
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.repo_owner).toEqual({ id: ownerIdOf(owner), login: owner });
    // Bound to another id than GitHub's repo for the name (a fresh one, so nothing shown before is reused).
    await dirSql("UPDATE projects SET repo_id = ? WHERE id = ?", repoIdOf(p.repo) + 7, p.id);
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.repo_owner).toBeNull();
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
    expect(gh.callsBesideUpkeep(before)).toEqual([]);
    // Tried again shortly, not at once (no spinning on a DirectoryDO that doesn't answer).
    const alarm = await runInDurableObject(rv, (_o, st) => st.storage.getAlarm());
    expect(alarm).toBeGreaterThan(Date.now() + 1_000);
  });
});

describe("the repos the owner may attach (GET /api/repos)", () => {
  const all = { ...GRANT_PERMISSIONS };
  const grantCalls = () => fake.calls.filter((c) => c.path === "/v1/clients/self/grant/repos");

  it("lists the repos the App's installations reach, each its own selection, as GitHub answers, each with the project already on it; nest's grant isn't asked", async () => {
    const p = await newProject();
    const acct = `acct-${rand()}`;
    gh.repo(`${acct}/picked`);
    gh.repo(`${acct}/not-picked`);
    gh.installations = [
      { id: 5_001, account: p.repo.split("/")[0]!, repos: "all", permissions: all },
      { id: 5_002, account: acct, repos: new Set([`${acct}/picked`]), permissions: all },
    ];
    // nest's grant names none of them: it isn't what decides.
    fake.grantRepos = ["someone/else"];
    fake.grantListing = { repos: [], unlisted: [], complete: true };
    const before = grantCalls().length;
    const r = await api(token, "GET", "/api/repos");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      repos: [{ repo: `${acct}/picked`, project: null }, { repo: p.repo, project: p.id }], unlisted: [], complete: true,
      // The App by name, and where it's installed or its repos chosen.
      app: { slug: GH_APP_SLUG, install_url: `https://github.com/apps/${GH_APP_SLUG}/installations/new` },
    });
    expect(grantCalls().length).toBe(before);
    expect((await api(token, "POST", "/api/repos")).status).toBe(405);
  });

  it("an installation whose repos can't be listed is named, not dropped silently; one with more than a page is listed whole", async () => {
    const big = `big-${rand()}`;
    for (let n = 0; n < 130; n++) gh.repo(`${big}/r${String(n).padStart(3, "0")}`);
    const broken = `broken-${rand()}`;
    gh.repo(`${broken}/x`);
    gh.installations = [
      { id: 6_001, account: broken, repos: "all", permissions: all },
      { id: 6_002, account: big, repos: "all", permissions: all },
    ];
    // The first installation's listing fails (its own installation token's read).
    gh.fail(/^GET \/installation\/repositories$/, 502);
    const r = await api(token, "GET", "/api/repos");
    expect(r.status).toBe(200);
    expect(r.body.unlisted).toEqual([broken]);
    expect(r.body.repos).toHaveLength(130);
    expect(r.body.complete).toBe(true);
    // Each listing's token: metadata only, for the installation's repos (none named).
    expect(gh.mints().filter((m) => m.installation === 6_002)).toEqual([{ installation: 6_002, repositories: undefined, permissions: { metadata: "read" } }]);
  });

  it("a project can be created only on a repo the App reaches: a typed name outside its installations, or not selected, is refused, and nothing is left stuck", async () => {
    const acct = `sel-${rand()}`;
    gh.installations = [{ id: 7_001, account: acct, repos: new Set([`${acct}/in`]), permissions: all }];
    for (const repo of [`${acct}/out`, `nobody-${rand()}/x`]) {
      const r = await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo });
      expect(r.status, repo).toBe(403);
      expect(r.body.error).toContain(repo);
    }
    expect(((await api(token, "GET", "/api/projects")).body.projects as { repo: string }[]).map((p) => p.repo)).not.toContain(`${acct}/out`);
    // Selected later: the same name is created at once (no project stuck on it from the refused try).
    gh.install({ id: 7_001, account: acct, repos: [`${acct}/in`, `${acct}/out`] });
    expect((await api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo: `${acct}/out` })).status).toBe(201);
    expect(grantCalls()).toEqual([]);
  });

  it("GitHub's failure is said, not an empty list", async () => {
    gh.fail(/^GET \/app\/installations$/, 502, { times: 10 });
    const r = await api(token, "GET", "/api/repos");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("GitHub couldn't say");
  });
});

describe("creating a project asks GitHub now", () => {
  const create = (repo: string) => api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo });

  it("looks the installation up afresh and mints a token for the repo, never a cached one, and revokes it", async () => {
    const acct = `fresh-${rand()}`;
    const repo = `${acct}/r`;
    gh.install({ id: 8_201, account: acct });
    // A lookup and a token cached from an installation since replaced.
    await new AppTokens(env as unknown as Env).token(repo, PERMISSIONS.metadata);
    gh.reinstall(acct, 8_202);
    const before = gh.minted.length;
    expect((await create(repo)).status).toBe(201);
    const check = gh.minted.slice(before)[0]!;
    expect(check).toMatchObject({ installation: 8_202, repositories: ["r"], permissions: { metadata: "read" } });
    // That very token revoked: GitHub was asked to, with it, and knows it no more.
    expect(gh.callsTo("DELETE", /^\/installation\/token$/).some((c) => c.token === check.token)).toBe(true);
    expect(gh.tokens.has(check.token)).toBe(false);
  });

  it("a failing GET /app (the App's owner unknown) fails closed: nothing minted, a create is GitHub's outage (502), and the listing isn't widened", () => withEnv("GITHUB_ACCOUNTS", undefined, async () => {
    // Nothing known of the App yet in this isolate.
    resetAppTokens();
    const acct = `noapp-${rand()}`;
    const repo = `${acct}/r`;
    gh.install({ id: 8_401, account: acct, accountId: ownerIdOf(acct) });
    gh.fail(/^GET \/app$/, 502, { times: 20 });
    const before = gh.minted.length;
    const r = await create(repo);
    expect(r.status).toBe(502);
    expect(gh.minted.length).toBe(before);
    const listed = await api(token, "GET", "/api/repos");
    expect(listed.status).toBe(502);
    expect(gh.minted.length).toBe(before);
    gh.failures = [];
  }));

  it("an answer from GET /app naming no owner isn't kept: refused as GitHub's trouble (502), and the next answer counts", () => withEnv("GITHUB_ACCOUNTS", undefined, async () => {
    resetAppTokens();
    const repo = `${GH_APP_OWNER}/r-${rand()}`;
    gh.appOwnerMissing = true;
    try {
      const r = await create(repo);
      expect(r.status).toBe(502);
      expect(r.body.error).toContain("names no owner");
    } finally {
      gh.appOwnerMissing = false;
    }
    expect((await create(repo)).status).toBe(201);
  }));

  it("a cached lookup is checked again against the accounts the app acts for: one narrowed out since is refused, nothing minted", async () => {
    const acct = `narrowed-${rand()}`;
    const repo = `${acct}/r`;
    gh.install({ id: 8_501, account: acct, accountId: ownerIdOf(acct) });
    const src = new AppTokens(env as unknown as Env);
    await withEnv("GITHUB_ACCOUNTS", String(ownerIdOf(acct)), () => src.token(repo, PERMISSIONS.metadata));
    const lookups = gh.callsTo("GET", new RegExp(`^/repos/${repo}/installation$`)).length;
    const before = gh.minted.length;
    await withEnv("GITHUB_ACCOUNTS", undefined, async () => {
      await expect(src.token(repo, PERMISSIONS.checks)).rejects.toMatchObject({ status: 404, message: expect.stringContaining("not one the app acts for") });
    });
    expect(gh.minted.length).toBe(before);
    // Refused at the lookup GitHub answered again (the cached one no longer counts).
    expect(gh.callsTo("GET", new RegExp(`^/repos/${repo}/installation$`)).length).toBe(lookups + 1);
  });

  it("a repo its account's installation doesn't select is refused (GitHub's 422 at the mint), even with a token cached for it", async () => {
    const acct = `sel422-${rand()}`;
    const repo = `${acct}/r`;
    gh.install({ id: 8_301, account: acct, repos: [repo] });
    await new AppTokens(env as unknown as Env).token(repo, PERMISSIONS.metadata);
    // Dropped from the selection; the lookup still answers the account's installation, so only the mint refuses.
    gh.lookupIgnoresSelection = true;
    gh.install({ id: 8_301, account: acct, repos: [] });
    const r = await create(repo);
    expect(r.status).toBe(403);
    expect(r.body.error).toContain(repo);
  });

  it("GitHub's outage is said as one (502), never a refusal", async () => {
    gh.fail(/^GET \/repos\/[^/]+\/[^/]+\/installation$/, 502, { times: 5 });
    const r = await create(`out-${rand()}/r`);
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("GitHub couldn't say");
  });
});

describe("the accounts the app acts for (the App's owner, and GITHUB_ACCOUNTS)", () => {
  const all = { ...GRANT_PERMISSIONS };
  const create = (repo: string) => api(token, "POST", "/api/projects", { name: `n-${rand()}`, repo });

  it("by default the App owner's account only: another account's installation isn't listed, attachable, or ever minted for; GITHUB_ACCOUNTS widens it", () => withEnv("GITHUB_ACCOUNTS", undefined, async () => {
    const mine = `${GH_APP_OWNER}/r-${rand()}`;
    const stranger = `stranger-${rand()}`;
    const theirs = `${stranger}/r`;
    gh.repo(mine);
    gh.repo(theirs);
    gh.installations = [
      { id: 8_001, account: GH_APP_OWNER, repos: "all", permissions: all },
      { id: 8_002, account: stranger, accountId: ownerIdOf(stranger), repos: "all", permissions: all },
    ];
    const listed = (await api(token, "GET", "/api/repos")).body.repos.map((x: { repo: string }) => x.repo);
    expect(listed).toContain(mine);
    expect(listed).not.toContain(theirs);
    const refused = await create(theirs);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain(theirs);
    expect((await create(mine)).status).toBe(201);
    expect(gh.mints().filter((m) => m.installation === 8_002)).toEqual([]);
    // There's no wildcard: `*` names no account.
    await withEnv("GITHUB_ACCOUNTS", "*", async () => {
      expect((await create(theirs)).status).toBe(403);
    });
    // The operator adds the account: listed and attachable.
    await withEnv("GITHUB_ACCOUNTS", String(ownerIdOf(stranger)), async () => {
      expect((await api(token, "GET", "/api/repos")).body.repos.map((x: { repo: string }) => x.repo)).toContain(theirs);
      expect((await create(theirs)).status).toBe(201);
    });
  }));

  it("a repo transferred to another account's installation isn't followed: its events are refused, its reads too, and nothing is minted there", () => withEnv("GITHUB_ACCOUNTS", undefined, async () => {
    const p = await newProject(`${GH_APP_OWNER}/r-${rand()}`);
    expect((await binding(p)).installation_id).toBe(GH_INSTALLATION_ID);
    const stranger = `stranger-${rand()}`;
    const to = `${stranger}/moved`;
    gh.install({ id: 8_102, account: stranger, accountId: ownerIdOf(stranger) });
    gh.rename(p.repo, to);
    const r = await deliverGithub("issues", { ...issue(1, { id: repoIdOf(p.repo), full_name: to }), installation: { id: 8_102 } });
    expect(((await r.json()) as { ignored: string }).ignored).toContain("isn't the project's");
    const rr = await reread(p);
    expect(rr.status).toBe(409);
    expect(rr.body.error).toContain("not one the app acts for");
    expect((await sync()).status).toBe(200);
    expect(await binding(p)).toMatchObject({ repo: p.repo, installation_id: GH_INSTALLATION_ID });
    expect(await numbers(p)).toEqual([]);
    expect(gh.mints().filter((m) => m.installation === 8_102)).toEqual([]);
  }));
});

