// The state-machine sweep's lower-severity fixes (sm-inventory-projects.md): an agent's exit that overtakes
// its create's answer (B12), an attach owed while one runs (B14), two catalog syncs at once (B15),
// `PATCH settings` all or nothing (B18), and pruning terminal history-like rows by age (B20).
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { ENDED_RUNS_KEEP_MS, ERRORS_KEEP_MS, REVIEW_JOBS_KEEP_MS, TRIAGED_PROPOSALS_KEEP_MS } from "../src/retention";
import { RUN_EXIT_GRACE_MS } from "../src/do/project";
import { PERMISSIONS } from "../src/github";
import { AccessTeam, api, deliver, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
let restore: () => void;
let token: string;
let nest: Signer;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
  nest = await Signer.create("k1");
  fake.jwks = { keys: [await nest.jwk()] };
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const eid = () => `evt-${rand()}`;
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
let clock = Date.parse("2026-11-08T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

interface P { id: string; repo: string }
async function newProject(o: Record<string, unknown> = {}): Promise<P> {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo };
}
const projectStub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const reviewStub = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const inProject = <T>(p: P, f: (sql: SqlStorage) => T) => runInDurableObject(projectStub(p), (_i: unknown, st: DurableObjectState) => f(st.storage.sql));
const inReview = <T>(p: P, f: (sql: SqlStorage) => T) => runInDurableObject(reviewStub(p), (_i: unknown, st: DurableObjectState) => f(st.storage.sql));
const exited = (agent: string) => deliver({ id: eid(), type: "agent.exited", agent, reason: "exited", text: "" });
const until = async (f: () => boolean) => {
  for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe("B12: an exit that overtakes its create's answer", () => {
  it("a worker: the start that learns its agent sees it exited, and the task stalls instead of briefing a dead agent", async () => {
    const p = await newProject();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    fake.lost.push({ match: /^POST \/v1\/agents$/, times: 1 });
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body.state).toBe("assigned");
    const agent = [...fake.agents.values()].find((a) => a.labels.task === t.id)!.agent;
    expect((await exited(agent)).status).toBe(200);
    await inProject(p, (sql) => sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id));
    await projectStub(p).drain();
    const after = (await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body;
    expect(after).toMatchObject({ state: "stalled", assignee: agent });
    expect(fake.inbox.filter((m) => m.agent === agent)).toEqual([]);
    expect(await inProject(p, (sql) => sql.exec("SELECT worker_live FROM tasks WHERE id = ?", t.id).one().worker_live)).toBe(0);
  });

  it("a reviewer: its exit is an attempt spent once the job learns it", async () => {
    const p = await newProject();
    const s = sha();
    fake.lost.push({ match: /^POST \/v1\/agents$/, times: 1 });
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 3, sha: s, action: "opened", updated_at: later() }));
    await reviewStub(p).drain();
    const agent = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.sha === s)!.agent;
    await exited(agent);
    await inReview(p, (sql) => sql.exec("UPDATE jobs SET next_ms = 0 WHERE next_ms IS NOT NULL"));
    await reviewStub(p).drain();
    const job = ((await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[]).find((j) => j.sha === s);
    expect(job).toMatchObject({ state: "running", attempts: 1, agent: null, error: expect.stringMatching(/exited without a verdict/) });
    expect(fake.inbox.filter((m) => m.agent === agent)).toEqual([]);
  });

  it("a routine run: its exit waits for a turn as any exit before one, then fails the run", async () => {
    const p = await newProject();
    const r = (await api(token, "POST", `/api/projects/${p.id}/routines`, {
      name: "R", kind: "review", prompt: "p", enabled: true, triggers: { timer: null, tasks_done: null, prs_merged: null },
      cooldown_min: 0, max_minutes: 30, max_turns: 3, proposals: "triage",
    })).body;
    fake.lost.push({ match: /^POST \/v1\/agents$/, times: 1 });
    await api(token, "POST", `/api/projects/${p.id}/routines/${r.id}/run`);
    const agent = [...fake.agents.values()].find((a) => a.labels.routine === r.id)!.agent;
    await exited(agent);
    await inProject(p, (sql) => sql.exec("UPDATE routine_runs SET next_ms = 0 WHERE state = 'starting'"));
    await projectStub(p).drain();
    expect(await inProject(p, (sql) => sql.exec("SELECT exited_ms FROM routine_runs WHERE agent = ?", agent).one().exited_ms)).not.toBeNull();
    await inProject(p, (sql) => sql.exec("UPDATE routine_runs SET exited_ms = ? WHERE agent = ?", Date.now() - RUN_EXIT_GRACE_MS - 1, agent));
    await projectStub(p).drain();
    const runs = (await api(token, "GET", `/api/projects/${p.id}/routines/${r.id}/runs`)).body;
    expect(runs[0]).toMatchObject({ state: "ended", outcome: "failed", error: expect.stringMatching(/before finishing a turn/) });
  });
});

describe("B14: an attach owed while one runs", () => {
  it("stays owed when the running one succeeds", async () => {
    const p = await newProject();
    // Each attach asks nest for one token with the attach's permissions.
    const attaches = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/clients/self/github-token"
      && c.body?.repo === p.repo && JSON.stringify(c.body?.permissions) === JSON.stringify(PERMISSIONS.attach)).length;
    const before = attaches();
    let release!: () => void;
    const hold = { match: /^POST \/v1\/clients\/self\/github-token$/, release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const retrying = api(token, "POST", `/api/projects/${p.id}/attach`);
    await until(() => hold.reached);
    // The App's id is learned meanwhile (a check run told it): the project must attach again.
    await projectStub(p).appIdLearned(999_001);
    release();
    await retrying;
    await projectStub(p).drain();
    // The retry's attach, then the one owed while it ran (not erased by the first one's success).
    expect(attaches() - before).toBe(2);
  });
});

describe("B15: two catalog syncs at once", () => {
  it("the catalog ends with both projects' repos, though the older snapshot's writes land last", async () => {
    let release!: () => void;
    // The first project's sync is held at its first write, after it read the repos (its own only).
    const hold = { match: /^PUT \/v1\/catalog\/capabilities\/projects\/board$/, release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const a = `o-${rand()}/a-${rand()}`;
    const creatingA = api(token, "POST", "/api/projects", { name: a, repo: a });
    await until(() => hold.reached);
    const b = `o-${rand()}/b-${rand()}`;
    expect((await api(token, "POST", "/api/projects", { name: b, repo: b })).status).toBe(201);
    release();
    expect((await creatingA).status).toBe(201);
    const worker = fake.catalog.get("templates/projects/worker") as { repos: string[] };
    expect(worker.repos).toEqual(expect.arrayContaining([a.toLowerCase(), b.toLowerCase()]));
  });
});

describe("B18: PATCH settings is all or nothing", () => {
  it("a refused part (a GitHub login that doesn't exist) changes nothing, max_concurrent_reviews included", async () => {
    const p = await newProject();
    const r = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_concurrent_reviews: 3, max_workers: 5, comments_from_login: "ghost-nobody" });
    expect(r.status).toBe(400);
    const s = (await api(token, "GET", `/api/projects/${p.id}/settings`)).body;
    expect(s.max_concurrent_reviews).toBeNull();
    expect(s.max_workers).toBe(2);
    const ok = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_concurrent_reviews: 3 });
    expect(ok.body.max_concurrent_reviews).toBe(3);
  });
});

describe("B20: terminal history-like rows pruned by age", () => {
  it("ProjectDO: old errors, triaged proposals and ended runs go; recent ones, untriaged proposals and task history stay", async () => {
    const p = await newProject();
    const now = Date.now();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "keep my history" })).body;
    await inProject(p, (sql) => {
      sql.exec("INSERT INTO errors (event_id, at_ms, agent) VALUES ('e-old', ?, 'agt_x'), ('e-new', ?, 'agt_x')", now - ERRORS_KEEP_MS - 1, now);
      // A refused stop (#178's record): the only sign an agent may still run, kept however old.
      sql.exec("INSERT INTO errors (event_id, at_ms, agent, code, message) VALUES ('e-stop', ?, 'agt_y', 'stop_failed', 'refused')", now - ERRORS_KEEP_MS - 1);
      for (const [id, state, at] of [["prp_old", "declined", now - TRIAGED_PROPOSALS_KEEP_MS - 1], ["prp_new", "accepted", now], ["prp_wait", "untriaged", null]] as const) {
        sql.exec("INSERT INTO proposals (id, routine, routine_name, run, agent, title, body, state, tainted, created_ms, triaged_ms) VALUES (?, 'rtn_x', 'R', 'run_x', 'agt_x', 't', 'b', ?, 1, 0, ?)", id, state, at);
      }
      for (const [id, ended] of [["run_old", now - ENDED_RUNS_KEEP_MS - 1], ["run_new", now]] as const) {
        sql.exec("INSERT INTO routine_runs (id, routine, n, trigger, state, outcome, max_turns, created, queued_ms, ended_ms) VALUES (?, 'rtn_x', 1, 'manual', 'ended', 'done', 3, '[]', 0, ?)", id, ended);
        sql.exec("INSERT INTO run_turns (run, event) VALUES (?, 'evt')", id);
      }
      sql.exec("UPDATE history SET at_ms = 0 WHERE task = ?", t.id);
    });
    await runInDurableObject(projectStub(p), (inst: unknown) => (inst as { prune(now: number): void }).prune(Date.now()));
    await inProject(p, (sql) => {
      const col = (q: string) => sql.exec(q).toArray().map((r) => Object.values(r)[0]);
      expect(col("SELECT event_id FROM errors ORDER BY event_id")).toEqual(["e-new", "e-stop"]);
      expect(col("SELECT id FROM proposals ORDER BY id")).toEqual(["prp_new", "prp_wait"]);
      expect(col("SELECT id FROM routine_runs ORDER BY id")).toEqual(["run_new"]);
      // The recent run's turns stay a day (a redelivered turn); the old run's went with it.
      expect(col("SELECT run FROM run_turns ORDER BY run")).toEqual(["run_new"]);
      expect(sql.exec("SELECT COUNT(*) AS n FROM history WHERE task = ?", t.id).one().n).toBeGreaterThan(0);
    });
  });

  it("ReviewDO: old ended jobs go, but not an open PR's head's", async () => {
    const p = await newProject();
    const head = sha();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 9, sha: head, action: "opened", updated_at: later() }));
    const old = Date.now() - REVIEW_JOBS_KEEP_MS - 1;
    await inReview(p, (sql) => {
      sql.exec("UPDATE jobs SET state = 'done', updated_ms = ? WHERE pr = 9", old);
      sql.exec("INSERT INTO jobs (pr, sha, state, attempts, created_ms, updated_ms) VALUES (8, ?, 'superseded', 0, 0, ?), (8, ?, 'done', 0, 0, ?)", sha(), old, sha(), Date.now());
    });
    await runInDurableObject(reviewStub(p), (inst: unknown) => (inst as { prune(now: number): void }).prune(Date.now()));
    const left = await inReview(p, (sql) => sql.exec("SELECT pr, state FROM jobs ORDER BY pr").toArray());
    expect(left).toEqual([{ pr: 8, state: "done" }, { pr: 9, state: "done" }]);
  });
});
