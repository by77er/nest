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
    expect(await binding(c)).toMatchObject({ repo_id: 42, bound: "event", error: expect.stringContaining(`is repo ${repoIdOf(c.repo)} now`) });
    // The operator's re-read binds it to GitHub's.
    const r = await reread(c);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ changed: true, previous_id: 42, binding: { repo_id: repoIdOf(c.repo), bound: "github", error: null } });
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
    expect(r.body.error).toContain(`is project ${a.id}'s`);
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
    // A name nobody holds: the sync applies it.
    const to = `${a.repo}-renamed`;
    await deliverGithub("issues", issue(2, { id: repoIdOf(a.repo), full_name: to }));
    fake.grantRepos = [a.repo, b.repo, to];
    expect((await sync()).status).toBe(200);
    expect(await binding(a)).toMatchObject({ repo: to, renamed_to: null });
    expect(await settingsRepo(a)).toBe(to);
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
