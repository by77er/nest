// Auto-merge (README.md#auto-merge): the project's setting written back to the repo's "Allow
// auto-merge", GitHub's auto-merge enabled on task PRs (never others) and disabled when the setting goes
// off, failures shown and retried, and a change made by hand on GitHub shown as drift. Against the fake
// GitHub (test/fake-nest.ts), which checks each token's permissions.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, api, deliverGithub, FakeNest, installFetch, prEvent, prNode } from "./fake-nest";

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

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
let clock = Date.parse("2026-11-02T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

interface P {
  id: string;
  repo: string;
}

async function newProject(o: Record<string, unknown> = {}): Promise<P & { settings: any }> {
  const repo = `o-${rand()}/r-${rand()}`;
  const r = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id, repo: repo.toLowerCase(), settings: r.body.settings };
}

const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const settings = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}`)).body.settings;
const patch = async (p: P, body: unknown) => {
  const r = await api(token, "PATCH", `/api/projects/${p.id}/settings`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const task = async (p: P, id: string) => (await api(token, "GET", `/api/projects/${p.id}/tasks/${id}`)).body;
const repoWrites = (p: P) => gh.calls.filter((c) => c.method === "PATCH" && c.path === `/repos/${p.repo}`);
const mintsFor = (p: P) => fake.calls.filter((c) => c.path === "/v1/clients/self/github-token" && c.body.repo.toLowerCase() === p.repo).map((c) => c.body.permissions);

async function taskWithWorker(p: P) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
  expect(a.state).toBe("in_progress");
  return t.id as string;
}

/** A PR opened (or another action), then the project's alarm work done. */
async function pr(p: P, number: number, o: { ref?: string; headRepo?: string; action?: string; merged?: boolean } = {}) {
  expect((await deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: sha(), action: o.action ?? "opened", updated_at: later(), ...o }))).status).toBe(200);
  await stub(p).drain();
}

describe("the repo's setting", () => {
  it("turning auto-merge on writes allow_auto_merge true to the repo, and off writes false", async () => {
    const p = await newProject();
    expect(p.settings).toMatchObject({ auto_merge: false, merge_method: "squash", repo_auto_merge: { state: "none" } });
    expect(repoWrites(p)).toHaveLength(0);
    const on = await patch(p, { auto_merge: true, merge_method: "rebase" });
    expect(on).toMatchObject({ auto_merge: true, merge_method: "rebase", repo_auto_merge: { state: "applied", want: true, repo: true, error: null } });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(true);
    const off = await patch(p, { auto_merge: false });
    expect(off.repo_auto_merge).toMatchObject({ state: "applied", want: false, repo: false });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(false);
    expect(repoWrites(p).map((c) => c.body)).toEqual([{ allow_auto_merge: true }, { allow_auto_merge: false }]);
    // Each write's token: administration only.
    expect(mintsFor(p).filter((x) => !x.checks && !x.metadata)).toEqual([{ administration: "write" }, { administration: "write" }]);
  });

  it("is written when a project is created with auto-merge on", async () => {
    const p = await newProject({ auto_merge: true });
    expect(p.settings.repo_auto_merge.state).toBe("applied");
    expect(gh.repo(p.repo).allow_auto_merge).toBe(true);
  });

  it("a refusal is shown, the setting kept, and the owner's retry writes it; PRs wait for it", async () => {
    const p = await newProject();
    const id = await taskWithWorker(p);
    gh.fail(/^PATCH \/repos\/[^/]+\/[^/]+$/, 403, { message: "Resource not accessible by integration" });
    const s = await patch(p, { auto_merge: true });
    expect(s.auto_merge).toBe(true);
    expect(s.repo_auto_merge).toMatchObject({ state: "error", error: "GitHub 403: Resource not accessible by integration" });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(false);
    // A task PR opened meanwhile waits for the repo to allow auto-merge.
    await pr(p, 3, { ref: `task/${id}` });
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toMatchObject({ state: "pending" });
    expect(gh.autoMerge.has(prNode(p.repo, 3))).toBe(false);
    const r = await api(token, "POST", `/api/projects/${p.id}/auto-merge/retry`);
    expect(r.body.repo_auto_merge).toMatchObject({ state: "applied", error: null });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(true);
    expect(gh.autoMerge.get(prNode(p.repo, 3))).toEqual({ method: "SQUASH" });
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toMatchObject({ state: "enabled", method: "squash" });
  });

  it("a failure for now is retried from the alarm, twice", async () => {
    const p = await newProject();
    gh.fail(/^PATCH \/repos\/[^/]+\/[^/]+$/, 502, { times: 2 });
    expect((await patch(p, { auto_merge: true })).repo_auto_merge).toMatchObject({ state: "pending", error: "GitHub 502: injected" });
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET am_write_next_ms = 0 WHERE am_write_next_ms IS NOT NULL"); });
      await stub(p).drain();
    }
    expect((await settings(p)).repo_auto_merge).toMatchObject({ state: "applied", error: null });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(true);
  });

  it("a change made by hand on GitHub shows as drift when the project is next looked at, and a retry writes it back", async () => {
    const p = await newProject({ auto_merge: true });
    gh.repo(p.repo).allow_auto_merge = false;
    // Read at most once a minute: the write just now is fresh.
    await settings(p);
    await stub(p).drain();
    expect((await settings(p)).repo_auto_merge.state).toBe("applied");
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET am_applied = json_set(am_applied, '$.at_ms', 0), am_observed = NULL"); });
    await settings(p);
    await stub(p).drain();
    expect((await settings(p)).repo_auto_merge).toMatchObject({ state: "drifted", want: true, repo: false });
    // The read's token: what GitHub shows merge settings to.
    expect(mintsFor(p).at(-1)).toEqual({ metadata: "read", contents: "write" });
    const r = await api(token, "POST", `/api/projects/${p.id}/auto-merge/retry`);
    expect(r.body.repo_auto_merge).toMatchObject({ state: "applied", repo: true });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(true);
  });
});

describe("a PR's auto-merge", () => {
  it("is enabled on a task's PR with the project's method when it opens, and never on another PR or a fork's", async () => {
    const p = await newProject({ auto_merge: true, merge_method: "rebase" });
    const id = await taskWithWorker(p);
    await pr(p, 7, { ref: `task/${id}` });
    expect(gh.autoMerge.get(prNode(p.repo, 7))).toEqual({ method: "REBASE" });
    const t = await task(p, id);
    expect(t.prs[0]?.auto_merge ?? null).toMatchObject({ state: "enabled", method: "rebase", error: null });
    expect(t.history.at(-1)).toMatchObject({ action: "auto_merge_enabled", actor: "app:github" });
    // Its token, exactly (the review's check-run token may be minted before or after it: two objects' alarms).
    expect(mintsFor(p)).toContainEqual({ pull_requests: "write", contents: "write" });
    expect(mintsFor(p).filter((m) => "pull_requests" in m)).toEqual([{ pull_requests: "write", contents: "write" }]);
    // Not a task's PR; a fork's branch named like the task's.
    await pr(p, 8, { ref: "feature/x" });
    const other = await taskWithWorker(p);
    await pr(p, 9, { ref: `task/${other}`, headRepo: `stranger/${rand()}` });
    expect(gh.autoMerge.has(prNode(p.repo, 8))).toBe(false);
    expect(gh.autoMerge.has(prNode(p.repo, 9))).toBe(false);
    expect((await task(p, other)).prs[0]?.auto_merge ?? null).toBeNull();
    // A PR a worker reported by number, from a branch that isn't its task's, isn't the task's own.
    const third = await taskWithWorker(p);
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET state = 'in_review', pr = 10 WHERE id = ?", third); });
    await pr(p, 10, { ref: "elsewhere" });
    expect(gh.autoMerge.has(prNode(p.repo, 10))).toBe(false);
    expect((await task(p, third)).prs[0]?.auto_merge ?? null).toBeNull();
  });

  it("isn't enabled while the setting is off; turning it on enables open task PRs, and off disables them", async () => {
    const p = await newProject();
    const id = await taskWithWorker(p);
    await pr(p, 4, { ref: `task/${id}` });
    expect(gh.autoMerge.has(prNode(p.repo, 4))).toBe(false);
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toBeNull();
    await patch(p, { auto_merge: true });
    expect(gh.autoMerge.get(prNode(p.repo, 4))).toEqual({ method: "SQUASH" });
    await patch(p, { auto_merge: false });
    expect(gh.autoMerge.get(prNode(p.repo, 4))).toBeNull();
    const t = await task(p, id);
    expect(t.prs[0]?.auto_merge ?? null).toMatchObject({ state: "disabled" });
    expect(t.history.at(-1)).toMatchObject({ action: "auto_merge_disabled" });
    expect(gh.repo(p.repo).allow_auto_merge).toBe(false);
  });

  it("a refusal from GitHub is recorded on the task with its reason", async () => {
    const p = await newProject({ auto_merge: true });
    const id = await taskWithWorker(p);
    gh.gqlErrors.push({ match: /enablePullRequestAutoMerge/, message: "Pull request is in clean status", times: 1 });
    await pr(p, 5, { ref: `task/${id}` });
    const t = await task(p, id);
    expect(t.prs[0]?.auto_merge ?? null).toMatchObject({ state: "failed", error: "GitHub 422: Pull request is in clean status" });
    expect(t.history.at(-1)).toMatchObject({ action: "auto_merge_failed" });
    expect(gh.autoMerge.has(prNode(p.repo, 5))).toBe(false);
    // Reopening the PR asks again.
    await pr(p, 5, { ref: `task/${id}`, action: "closed" });
    await pr(p, 5, { ref: `task/${id}`, action: "reopened" });
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toMatchObject({ state: "enabled" });
  });

  it("a failure for now is retried from the alarm", async () => {
    const p = await newProject({ auto_merge: true });
    const id = await taskWithWorker(p);
    gh.fail(/^POST \/graphql$/, 502, { times: 2 });
    await pr(p, 6, { ref: `task/${id}` });
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toMatchObject({ state: "pending", error: "GitHub 502: injected" });
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE task_prs SET am_next_ms = 0 WHERE am_next_ms IS NOT NULL"); });
      await stub(p).drain();
    }
    expect((await task(p, id)).prs[0]?.auto_merge ?? null).toMatchObject({ state: "enabled", error: null });
  });
});
