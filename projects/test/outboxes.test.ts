// The outboxes in ProjectDO (README.md#outboxes), against the real DO and the fake nest: the chat's real
// state and an idempotent Retry (B9), stops that nest refuses for good, pruning, and the one-off cleanup
// of PR rows left by deleted drafts.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MIGRATIONS } from "../src/do/project";
import { migrate } from "../src/sql";
import { AccessTeam, api, deliver, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
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
async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, manager: p.settings.manager as string, repo };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const chat = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}/chat`)).body as { seq: number; text: string; status: string; delivered: boolean; error: string | null }[];
const due = (p: P, table: string) => runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec(`UPDATE ${table} SET next_ms = 0 WHERE next_ms IS NOT NULL`); });

describe("the chat (B9)", () => {
  it("a message waiting for a manager is still being sent, with why: not failed, no Retry", async () => {
    const p = await newProject();
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager = NULL"); });
    const r = await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "hello" });
    expect(r.body).toMatchObject({ delivered: false, status: "retrying" });
    const m = (await chat(p)).at(-1)!;
    expect(m).toMatchObject({ text: "hello", status: "retrying", delivered: false, error: "the manager isn't started yet" });
    // Retry on it changes nothing (and sends nothing): only a failed one is sent again.
    expect((await api(token, "POST", `/api/projects/${p.id}/chat/${m.seq}/retry`)).body.status).toBe("retrying");
  });

  it("one nest refuses for good is failed; Retry sends it again, once however often it's asked", async () => {
    const p = await newProject();
    fake.fail(new RegExp(`^POST /v1/agents/${p.manager}/inbox$`), 403);
    const r = await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "are you there?" });
    expect(r.body).toMatchObject({ status: "failed", delivered: false });
    const seq = r.body.seq as number;
    expect((await chat(p)).find((m) => m.seq === seq)).toMatchObject({ status: "failed", error: expect.stringContaining("403") });
    const sent = () => fake.inbox.filter((m) => m.agent === p.manager && m.text === "are you there?").length;
    expect(sent()).toBe(0);
    const again = await Promise.all([1, 2, 3].map(() => api(token, "POST", `/api/projects/${p.id}/chat/${seq}/retry`)));
    expect(again.map((a) => a.status)).toEqual([200, 200, 200]);
    await stub(p).drain();
    expect((await chat(p)).find((m) => m.seq === seq)).toMatchObject({ status: "done", delivered: true, error: null });
    expect(sent()).toBe(1);
    expect((await chat(p)).filter((m) => m.text === "are you there?")).toHaveLength(1);
    // Another's message, or one that isn't there: not the owner's to retry.
    expect((await api(token, "POST", `/api/projects/${p.id}/chat/99999/retry`)).status).toBe(404);
  });

  it("a post under a request id seen before is the same message, sent once", async () => {
    const p = await newProject();
    const body = { text: "only once", request_id: `req${rand()}` };
    const a = await api(token, "POST", `/api/projects/${p.id}/chat`, body);
    const b = await api(token, "POST", `/api/projects/${p.id}/chat`, body);
    expect(b.body.seq).toBe(a.body.seq);
    expect((await chat(p)).filter((m) => m.text === "only once")).toHaveLength(1);
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text === "only once")).toHaveLength(1);
    // Without one, each post is its own message, as before.
    await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "twice" });
    await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "twice" });
    expect((await chat(p)).filter((m) => m.text === "twice")).toHaveLength(2);
    expect((await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "x", request_id: "bad id!" })).status).toBe(400);
  });
});

describe("stops", () => {
  async function cancelledWorker(p: P) {
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
    return { task: t.id as string, worker: a.assignee as string };
  }
  const live = (p: P) => runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE worker_live = 1").one().n);

  it("a transient failure is retried until the stop goes; the worker counts until then", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    const stop = new RegExp(`^POST /v1/agents/${w.worker}/stop$`);
    fake.fail(stop, 503, { retryable: true, times: 1000 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    expect(await live(p)).toBe(1);
    await due(p, "stops");
    await stub(p).drain();
    expect(await live(p)).toBe(1);
    const row = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT failed_ms, attempts FROM stops WHERE agent = ?", w.worker).one());
    expect(row).toMatchObject({ failed_ms: null, attempts: 2 });
    fake.failures = fake.failures.filter((f) => f.match !== stop);
    await due(p, "stops");
    await stub(p).drain();
    expect(await live(p)).toBe(0);
    expect(fake.agents.get(w.worker)!.ended).toBe(true);
  });

  it("an auth failure or a page that isn't nest's is retried, never failed: the agent may still be running", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    const stop = new RegExp(`^POST /v1/agents/${w.worker}/stop$`);
    fake.fail(stop, 403, { times: 2 });
    fake.fail(stop, 401, { times: 2 });
    fake.fail(stop, 403, { times: 2, page: true });
    // A 400 or a 409 that isn't nest's own (an edge's page) is no refusal of the request either.
    fake.fail(stop, 409, { times: 1, page: true });
    fake.fail(stop, 400, { times: 1, page: true });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    for (let i = 0; i < 7; i++) {
      await due(p, "stops");
      await stub(p).drain();
    }
    const row = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT failed_ms, attempts FROM stops WHERE agent = ?", w.worker).one());
    expect(row.failed_ms).toBeNull();
    expect(row.attempts).toBe(8);
    expect(await live(p)).toBe(1);
    // Still being tried: not the owner's to dismiss, and the owner's Retry leaves its schedule as it is.
    expect((await api(token, "DELETE", `/api/projects/${p.id}/stops/${w.worker}`)).status).toBe(409);
    expect(await live(p)).toBe(1);
    fake.failures = [];
    fake.fail(stop, 503, { retryable: true, times: 1000 });
    const before = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT attempts FROM stops WHERE agent = ?", w.worker).one().attempts as number);
    await api(token, "POST", `/api/projects/${p.id}/stops/${w.worker}/retry`);
    const after = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT attempts FROM stops WHERE agent = ?", w.worker).one().attempts as number);
    expect(after).toBeGreaterThanOrEqual(before);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${w.task}`)).body.history.map((h: { action: string }) => h.action)).not.toContain("stop_retried");
    fake.failures = [];
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toEqual([]);
  });

  it("nest's own refusal fails it, shown everywhere, its place still counted; Retry and Dismiss are the owner's", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    const stop = new RegExp(`^POST /v1/agents/${w.worker}/stop$`);
    fake.fail(stop, 409, { times: 1 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    const row = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT failed_ms, next_ms, error FROM stops WHERE agent = ?", w.worker).one());
    expect(row.failed_ms).not.toBeNull();
    expect(row.error).toContain("409");
    // Not due again before the owner acts: the alarm never spins on it.
    expect(row.next_ms as number).toBeGreaterThan(Date.now() + 86_400_000);
    // Still counted: auto-assign doesn't run past max_workers on a worker that may be running.
    expect(await live(p)).toBe(1);
    // Shown: the Network page, the task's history, the manager, the errors.
    const net = (await api(token, "GET", `/api/projects/${p.id}/network`)).body;
    expect(net.failed_stops).toEqual([expect.objectContaining({ agent: w.worker, task: w.task, reason: "cancelled", error: expect.stringContaining("409") })]);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${w.task}`)).body.history.map((h: { action: string }) => h.action)).toContain("stop_failed");
    await stub(p).drain();
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text.includes(`refused to stop ${w.worker}`))).toHaveLength(1);
    // Sent: its end recorded, which its pruning counts from.
    const ended = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT ended_ms FROM messages WHERE to_agent = ? AND text LIKE '%refused to stop%'", p.manager).one().ended_ms);
    expect(ended).not.toBeNull();
    const errors = (await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { agent: string; code: string }[];
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ agent: w.worker, code: "stop_failed" })]));
    // Not tried again by itself.
    const calls = fake.callsTo("POST", new RegExp(`^/v1/agents/${w.worker}/stop$`)).length;
    await due(p, "stops");
    await stub(p).drain();
    expect(fake.callsTo("POST", new RegExp(`^/v1/agents/${w.worker}/stop$`))).toHaveLength(calls);
    // The owner's Retry: tried now, and it goes.
    const r = await api(token, "POST", `/api/projects/${p.id}/stops/${w.worker}/retry`);
    expect(r.body).toEqual({ agent: w.worker, state: "done" });
    expect(await live(p)).toBe(0);
    expect(fake.agents.get(w.worker)!.ended).toBe(true);
  });

  it("dismissed by the owner, it stops counting; only a failed stop is dismissed", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    fake.fail(new RegExp(`^POST /v1/agents/${w.worker}/stop$`), 409, { times: 1 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    expect(await live(p)).toBe(1);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/stops/${w.worker}`)).body).toEqual({ dismissed: w.worker });
    expect(await live(p)).toBe(0);
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toEqual([]);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/stops/${w.worker}`)).status).toBe(409);
    expect((await api(token, "POST", `/api/projects/${p.id}/stops/${w.worker}/retry`)).status).toBe(404);
  });

  it("a failed stop is never pruned: however old, its place stays counted until it's resolved (F1b)", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    fake.fail(new RegExp(`^POST /v1/agents/${w.worker}/stop$`), 409, { times: 1 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    await runInDurableObject(stub(p), (_o, st) => { st.storage.sql.exec("UPDATE stops SET failed_ms = ? WHERE agent = ?", Date.now() - 400 * 86_400_000, w.worker); });
    await stub(p).drain();
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toHaveLength(1);
    expect(await live(p)).toBe(1);
  });

  it("a stop whose agent exits while nest refuses it says nothing: its row is gone, nothing to show", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    const stop = new RegExp(`^POST /v1/agents/${w.worker}/stop$`);
    let release!: () => void;
    const hold = { match: stop, release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    fake.fail(stop, 409, { times: 1 });
    const cancelling = api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold.reached).toBe(true);
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: w.worker, reason: "ended" });
    release();
    await cancelling;
    await stub(p).drain();
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toEqual([]);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${w.task}`)).body.history.map((h: { action: string }) => h.action)).not.toContain("stop_failed");
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text.includes(`refused to stop ${w.worker}`))).toEqual([]);
  });

  it("nest's word that any agent ended (a routine run's, a manager's) clears its failed stop", async () => {
    const p = await newProject();
    await runInDurableObject(stub(p), (_o, st) => {
      st.storage.sql.exec("INSERT INTO stops (agent, task, reason, next_ms, attempts, error, failed_ms) VALUES (?, NULL, 'manager replaced', 0, 1, 'nest 409 refused: injected', ?)", p.manager, Date.now());
    });
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toHaveLength(1);
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: p.manager, reason: "ended" });
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toEqual([]);
  });

  it("nest's word that the agent ended clears a failed stop and frees its place", async () => {
    const p = await newProject();
    const w = await cancelledWorker(p);
    fake.fail(new RegExp(`^POST /v1/agents/${w.worker}/stop$`), 409, { times: 1 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${w.task}/cancel`, {});
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: w.worker, reason: "ended" });
    expect(await live(p)).toBe(0);
    expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.failed_stops).toEqual([]);
  });
});

describe("pruning", () => {
  it("drops messages sent or failed over a week ago, and keeps the rest", async () => {
    const p = await newProject();
    const old = Date.now() - 8 * 86_400_000;
    await runInDurableObject(stub(p), (_o, st) => {
      const ins = (at: number, next: number | null, error: string | null) =>
        st.storage.sql.exec("INSERT INTO messages (to_agent, text, relayed, at_ms, next_ms, attempts, error) VALUES ('agt_x', 'm', 0, ?, ?, 1, ?)", at, next, error);
      ins(old, null, null);
      ins(old, null, "refused");
      ins(old, Date.now() + 3_600_000, "busy");
      ins(Date.now(), null, null);
      // Owed long ago, but it ended (sent, after a week of retries) just now: kept, by its end.
      st.storage.sql.exec("INSERT INTO messages (to_agent, text, relayed, at_ms, next_ms, attempts, error, ended_ms) VALUES ('agt_x', 'late', 0, ?, NULL, 9, NULL, ?)", old, Date.now());
    });
    await stub(p).drain();
    const left = await runInDurableObject(stub(p), (_o, st) => st.storage.sql.exec("SELECT text, at_ms, next_ms FROM messages WHERE to_agent = 'agt_x'").toArray());
    expect(left).toHaveLength(3);
    expect(left.map((r) => r.text)).toContain("late");
    expect(left.every((r) => r.next_ms !== null || r.text === "late" || (r.at_ms as number) > old)).toBe(true);
  });
});

describe("the outboxes' migration", () => {
  it("drops PR rows whose task is gone (left by deleting drafts before the task machine), and nothing else", async () => {
    const p = await newProject();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "kept" })).body;
    await runInDurableObject(stub(p), (_o, st) => {
      const sql = st.storage.sql;
      const step = MIGRATIONS.findIndex((m) => m.some((q) => q.includes("chat_request")));
      sql.exec("DROP INDEX chat_request");
      sql.exec("ALTER TABLE chat DROP COLUMN request_id");
      sql.exec("ALTER TABLE stops DROP COLUMN failed_ms");
      sql.exec("ALTER TABLE messages DROP COLUMN ended_ms");
      for (const t of ["pr_facts", "comments_seen"]) sql.exec(`DROP TABLE ${t}`);
      sql.exec("ALTER TABLE settings DROP COLUMN manager_restarts");
      sql.exec("ALTER TABLE settings DROP COLUMN listed_ms");
      for (const c of ["manager_model", "worker_model"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      for (const t of ["model_templates", "agent_templates"]) sql.exec(`DROP TABLE ${t}`);
      // And the step after them (an attach's generation, early exits).
      sql.exec("ALTER TABLE settings DROP COLUMN attach_gen");
      sql.exec("DROP TABLE early_exits");
      // And the triage-trust step's columns.
      for (const c of ["issues_from", "issues_dropped", "issues_dropped_ms"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      for (const c of ["manager_running_model", "switch_next_ms", "switch_after_turn", "switch_attempts", "switch_refusals", "refusal_seen_ms", "refusal_check_ms", "switch_gave_up_model"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      // And the PR upkeep step's (README.md#pr-upkeep).
      sql.exec("DROP TABLE pr_told");
      for (const c of ["pr_read_next_ms", "pr_read_last_ms", "pr_read_attempts"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      // And the comments default's step (README.md#pr-comments).
      for (const c of ["comments_default_id", "comments_cleared", "comments_marked"]) sql.exec(`ALTER TABLE settings DROP COLUMN ${c}`);
      // And the GitHub access step's (README.md#repo-authority).
      for (const t of ["gh_access", "gh_tokens", "sandbox_ends"]) sql.exec(`DROP TABLE ${t}`);
      sql.exec("ALTER TABLE settings DROP COLUMN gh_unreachable");
      sql.exec("ALTER TABLE settings DROP COLUMN gh_repo_id");
      sql.exec("ALTER TABLE routine_runs DROP COLUMN nest_repos");
      sql.exec("ALTER TABLE layers DROP COLUMN github");
      sql.exec("UPDATE schema_version SET v = ?", step);
      sql.exec("INSERT INTO task_prs (pr, task, state, attached_by, attached_ms) VALUES (61, 'tsk_gone', 'open', 'owner', 1), (62, 'tsk_gone', 'detached', 'owner', 1), (63, ?, 'open', 'owner', 1)", t.id);
      migrate(st.storage, MIGRATIONS);
      expect(sql.exec("SELECT pr FROM task_prs WHERE pr IN (61, 62, 63) ORDER BY pr").toArray().map((r) => r.pr)).toEqual([63]);
    });
    // PR #61 is free for a task again.
    fake.github.pull(p.repo, 61);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/prs`, { pr: 61 })).status).toBe(200);
  });
});
