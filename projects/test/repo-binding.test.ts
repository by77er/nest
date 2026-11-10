// A project's repo binding (README.md#the-repos-binding): the repo's GitHub id read from GitHub at attach,
// a sync backfilling projects that have none, the operator's re-read from the Admin page, and a rename or
// transfer applied once nest's grant names the new name. Only nest's client interface: a token for the
// repo, and the grant.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import type { RepoBinding } from "../src/do/directory";
import { AccessTeam, api, deliverGithub, FakeNest, installFetch, repoIdOf } from "./fake-nest";

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
  gh.failures = [];
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
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
const reviewRepo = (p: P) => runInDurableObject(env.REVIEW.get(env.REVIEW.idFromName(p.id)), (_o, st) =>
  st.storage.sql.exec<{ v: string }>("SELECT v FROM settings WHERE k = 'repo'").one().v);

describe("read from GitHub, not taken from an event", () => {
  it("attach binds the repo's id from GitHub, so no event's id binds it; the installation id is empty until nest names it", async () => {
    const p = await newProject();
    expect(await binding(p)).toMatchObject({ repo: p.repo, repo_id: repoIdOf(p.repo), bound: "github", renamed_to: null, installation_id: null, error: null });
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
      bound: { full_name: p.repo, id: repoIdOf(p.repo), owner: before.owner },
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
    expect(blocked.body.rename).toEqual({ blocked: expect.stringContaining(`doesn't name ${to}`) });
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

  it("a rename ReviewDO can't follow is taken back everywhere: the directory and ProjectDO keep the old name, and it's tried again", async () => {
    const p = await newProject();
    const to = `${p.repo}-renamed`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    fake.grantRepos = [p.repo, to];
    const rv = env.REVIEW.get(env.REVIEW.idFromName(p.id));
    await runInDurableObject(rv, (_o, st) => { st.storage.sql.exec("ALTER TABLE settings RENAME TO settings_hidden"); });
    const r = await reread(p);
    expect(r.body.rename).toEqual({ blocked: expect.stringContaining("couldn't be applied") });
    await runInDurableObject(rv, (_o, st) => { st.storage.sql.exec("ALTER TABLE settings_hidden RENAME TO settings"); });
    expect(await binding(p)).toMatchObject({ repo: p.repo, renamed_to: to });
    expect(await settingsRepo(p)).toBe(p.repo);
    expect(await reviewRepo(p)).toBe(p.repo);
    expect((await reread(p)).body.rename).toEqual({ applied: to });
    expect(await settingsRepo(p)).toBe(to);
    expect(await reviewRepo(p)).toBe(to);
  });

  it("a re-read follows the name GitHub last gave it, so an old name taken by another repo doesn't rebind it", async () => {
    const p = await newProject();
    const to = `${p.repo}-new`;
    gh.rename(p.repo, to);
    await deliverGithub("issues", issue(1, { id: repoIdOf(p.repo), full_name: to }));
    const impostor = gh.take(p.repo);
    expect(impostor).not.toBe(repoIdOf(p.repo));
    const r = await reread(p);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: false, binding: { repo_id: repoIdOf(p.repo), renamed_to: to } });
  });
});
