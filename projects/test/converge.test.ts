// Phase B4 of taking GitHub out of nest's kernel (README.md#converging-onto-the-apps-own-access): what still
// ran on nest's kernel repos when the app gave its sandboxes their GitHub access itself (B3) converges onto
// it. A layer write can't take an agent's repos from its sandbox (nest attaches them from the agent's own
// spawn), so a manager on them is replaced between turns by one on a fresh sandbox with the app's access;
// a start frozen on them is begun again as a new attempt, what the old one may have made found by its labels
// and destroyed. (A routine run tried on them ends: test/routines.test.ts. A shared template is written before
// each start from it: test/github-access.test.ts.)
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CONVERGE_NOTE, CONVERGE_QUIET_MS, MIGRATIONS } from "../src/do/project";
import { githubGuards } from "../src/github-access";
import { migrate } from "../src/sql";
import { AccessTeam, agentClaims, api, callTool, CLIENT, deliver, deliverGithub, eventually, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let token: string;
let signer: Signer;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
  signer = await Signer.create("k1");
  fake.jwks = { keys: [await signer.jwk()] };
});
afterAll(() => restore());
beforeEach(() => { fake.failures = []; fake.holds = []; });

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const r = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, repo, manager: r.body.settings.manager as string };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const drain = (p: P) => stub(p).drain();
const sql = <T>(p: P, f: (s: SqlStorage) => T) => runInDurableObject(stub(p), (_o, st) => f(st.storage.sql));
const settingsOf = (p: P) => sql(p, (s) => s.exec("SELECT manager, manager_next_ms, manager_starts, manager_error, converge_next_ms FROM settings").one());
const appChat = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/chat`)).body as { sender: string; text: string }[]).filter((m) => m.sender === "app").map((m) => m.text);
const sandboxCreate = (agent: string) => {
  const sb = fake.agents.get(agent)!.sandbox!;
  return fake.callsTo("POST", /^\/v1\/sandboxes$/).find((c) => c.body.labels?.start === fake.sandboxes.get(sb)!.labels.start && c.body.labels?.role === fake.sandboxes.get(sb)!.labels.role && c.body.labels?.project === fake.sandboxes.get(sb)!.labels.project)!;
};
const stops = (agent: string) => fake.callsTo("POST", new RegExp(`^/v1/agents/${agent}/stop$`));
const live = (labels: Record<string, string>) => [...fake.sandboxes.values()].filter((s) => !s.ended && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
const due = (p: P) => sql(p, (x) => x.exec("UPDATE settings SET converge_next_ms = 0"));
/** A new manager runs in the old one's place, on the app's access, and the old one was stopped. */
async function replaced(p: P) {
  const s = await settingsOf(p);
  expect(typeof s.manager === "string" ? s.manager : JSON.stringify(s)).toMatch(/^agt_/);
  expect(s.manager).not.toBe(p.manager);
  expect(await sql(p, (x) => x.exec("SELECT github FROM layers WHERE agent = ?", s.manager).one().github)).toBe(1);
  expect(stops(p.manager)).toHaveLength(1);
}

/**
 * What an abandoned start attempt made is gone after the first pass; a create of its landing after that (past nest's
 * idempotency lease) goes at the second, and then its row.
 */
async function sweptTwice(p: P, first: Record<string, string>) {
  const key = JSON.stringify(Object.fromEntries(Object.entries(first).sort(([a], [b]) => (a < b ? -1 : 1))));
  const row = () => sql(p, (x) => x.exec("SELECT passes FROM abandoned_starts WHERE labels = ?", key).toArray()[0]);
  await sql(p, (x) => x.exec("UPDATE abandoned_starts SET next_ms = 0 WHERE passes = 0"));
  await drain(p);
  expect(live(first)).toEqual([]);
  expect(await row()).toEqual({ passes: 1 });
  const [old] = [...fake.sandboxes.values()].filter((x) => Object.entries(first).every(([k, v]) => x.labels[k] === v));
  const late = `sbx_late${rand()}`;
  fake.sandboxes.set(late, { ...old!, sandbox: late, ended: false });
  expect(live(first)).toHaveLength(1);
  await sql(p, (x) => x.exec("UPDATE abandoned_starts SET next_ms = 0"));
  await drain(p);
  expect(live(first)).toEqual([]);
  expect(await row()).toBeUndefined();
}

/** The manager as a release before B3 left it: its sandbox on nest's repos (its layer without the app's part), its check due. */
const onNestRepos = (p: P) => sql(p, (s) => {
  s.exec("UPDATE layers SET github = 0 WHERE agent = ?", p.manager);
  s.exec("UPDATE settings SET converge_next_ms = 0");
});
/** Every start spec frozen so far, as a release before B3 froze it: without the app's access. */
const frozenBefore = (p: P) => sql(p, (s) => {
  for (const r of s.exec<{ key: string; spec: string }>("SELECT key, spec FROM start_specs").toArray()) {
    const { github: _g, overrides: _o, ...old } = JSON.parse(r.spec);
    s.exec("UPDATE start_specs SET spec = ? WHERE key = ?", JSON.stringify({ ...old, extras: {}, names: [], brief: "" }), r.key);
  }
});

describe("a manager on nest's repos", () => {
  it("is replaced between turns by one on a fresh sandbox with the app's access; the old one and its sandbox go, the app's waits stay", async () => {
    const p = await newProject();
    // It has spoken, and holds a wait; then the chat has been quiet.
    await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, turn: 1, text: "Specced the board." });
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "w" })).body;
    const old = await signer.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" }));
    expect((await callTool("board", old, "await_task", { task: t.id, states: ["done"], timeout_s: 600 })).result?.isError).toBeFalsy();
    await sql(p, (x) => x.exec("UPDATE chat SET at_ms = ?", Date.now() - CONVERGE_QUIET_MS - 1000));
    await onNestRepos(p);
    await drain(p);
    const s = await settingsOf(p);
    const next = s.manager as string;
    expect(typeof next === "string" ? next : JSON.stringify(s)).toMatch(/^agt_/);
    expect(next).not.toBe(p.manager);
    expect(s.converge_next_ms).toBeNull();
    // The old one ended, and its sandbox destroyed.
    expect(stops(p.manager)).toHaveLength(1);
    expect(fake.sandboxes.get(fake.agents.get(p.manager)!.sandbox!)!.ended).toBe(true);
    // The new one's sandbox has the app's own access, and its spawn names no repo of nest's.
    const create = sandboxCreate(next);
    expect((create.body.inject as { name: string }[]).map((b) => b.name)).toEqual(["gh_read"]);
    expect(create.body.guards).toEqual(githubGuards(p.repo, "read"));
    expect(create.body.env.GH_TOKEN).toBe(`nest-ph.${CLIENT}.gh_read.`);
    expect(fake.agents.get(next)!.overrides).toEqual({ repos: [], read_repos: [] });
    expect(await sql(p, (x) => x.exec("SELECT github FROM layers WHERE agent = ?", next).one().github)).toBe(1);
    // Told, in the chat and in its brief; the waits the app holds are the new one's.
    expect(await appChat(p)).toContain(CONVERGE_NOTE);
    expect(fake.inbox.find((m) => m.agent === next)!.text).toContain("A manager ran this project before you, and its conversation didn't carry over");
    expect((await api(token, "GET", `/api/projects/${p.id}/waits`)).body.pending).toHaveLength(1);
    // Not counted among its automatic restarts, and done once: looked at again, nothing changes.
    expect(await sql(p, (x) => x.exec("SELECT manager_restarts FROM settings").one().manager_restarts)).toBe("[]");
    await due(p);
    await drain(p);
    expect((await settingsOf(p)).manager).toBe(next);
    expect(stops(next)).toEqual([]);
  });

  it("not in a turn (nor with an ask of its open, nor starting): looked at again later, and replaced once the turn has ended", async () => {
    const p = await newProject();
    await onNestRepos(p);
    for (const state of ["working", "waiting_input", "waiting_permission", "starting", "errored"]) {
      fake.agents.get(p.manager)!.state = state;
      await due(p);
      await drain(p);
      const s = await settingsOf(p);
      expect(s.manager, state).toBe(p.manager);
      expect(s.converge_next_ms, state).toBeGreaterThan(Date.now());
      expect(stops(p.manager), state).toEqual([]);
      // Nothing prepared for a successor while it's busy: no sandbox but its own.
      expect(live({ project: p.id, role: "manager" }), state).toHaveLength(1);
    }
    fake.agents.get(p.manager)!.state = "idle";
    await due(p);
    await drain(p);
    await replaced(p);
  });

  it("not while the owner's message waits for it, nor within the quiet time after the chat's last word", async () => {
    const p = await newProject();
    await onNestRepos(p);
    // The owner's message can't be delivered for now: it waits for this manager.
    fake.fail(/^POST \/v1\/agents\/[^/]+\/inbox$/, 503, { retryable: true, times: 1000 });
    await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "Still there?" });
    await sql(p, (x) => x.exec("UPDATE chat SET at_ms = ?", Date.now() - CONVERGE_QUIET_MS - 1000));
    await due(p);
    await drain(p);
    expect((await settingsOf(p)).manager).toBe(p.manager);
    fake.failures = [];
    await sql(p, (x) => x.exec("UPDATE chat SET next_ms = 0 WHERE next_ms IS NOT NULL"));
    await drain(p);
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text === "Still there?")).toHaveLength(1);
    // Delivered, and said just now: still too soon.
    await sql(p, (x) => x.exec("UPDATE chat SET at_ms = ? WHERE sender = 'owner'", Date.now()));
    await due(p);
    await drain(p);
    expect((await settingsOf(p)).manager).toBe(p.manager);
    // Its last word that long ago: replaced.
    await sql(p, (x) => x.exec("UPDATE chat SET at_ms = ?", Date.now() - CONVERGE_QUIET_MS - 1000));
    await due(p);
    await drain(p);
    await replaced(p);
  });

  it("not when the owner writes while nest's state is being read: looked at again, the message the old one's", async () => {
    const p = await newProject();
    await onNestRepos(p);
    let release!: () => void;
    const hold = { match: new RegExp(`^GET /v1/agents/${p.manager}$`), release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const draining = drain(p);
    for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold.reached).toBe(true);
    const sent = api(token, "POST", `/api/projects/${p.id}/chat`, { text: "One more thing." });
    for (let i = 0; i < 400; i++) {
      if ((await sql(p, (x) => x.exec("SELECT COUNT(*) AS n FROM chat WHERE sender = 'owner'").one().n)) === 1) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    release();
    await Promise.all([draining, sent]);
    await drain(p);
    const s = await settingsOf(p);
    expect(s.manager).toBe(p.manager);
    expect(s.converge_next_ms).toBeGreaterThan(Date.now());
    expect(stops(p.manager)).toEqual([]);
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text === "One more thing.")).toHaveLength(1);
  });

  it("make before break: while nest can't make its successor's sandbox (a host doesn't apply guards yet), the old one keeps running; then its successor takes the sandbox made for it", async () => {
    const p = await newProject();
    await onNestRepos(p);
    fake.hostsBehind = 1;
    try {
      await drain(p);
      const s = await settingsOf(p);
      expect(s.manager).toBe(p.manager);
      expect(s.manager_next_ms).toBeNull();
      expect(s.converge_next_ms).toBeGreaterThan(Date.now());
      expect(stops(p.manager)).toEqual([]);
      expect(fake.sandboxes.get(fake.agents.get(p.manager)!.sandbox!)!.ended).toBe(false);
      expect(live({ project: p.id, role: "manager" })).toHaveLength(1);
      // Shown among the project's errors, with nest's reason; the same keys kept (not refused for good).
      const errors = (await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { code: string; message: string }[];
      expect(errors.filter((e) => e.code === "converge_failed").map((e) => e.message)).toEqual([expect.stringMatching(/every sandbox host of cell/)]);
      expect((await settingsOf(p)).manager_starts).toBe(s.manager_starts);
    } finally {
      fake.hostsBehind = 0;
    }
    await due(p);
    await drain(p);
    await replaced(p);
    const next = (await settingsOf(p)).manager as string;
    // One sandbox for it: made before the old one went, then its start's, by the same key.
    const mine = fake.callsTo("POST", /^\/v1\/sandboxes$/).filter((c) => c.body.labels?.project === p.id && c.body.labels?.start === fake.agents.get(next)!.labels.start);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(new Set(mine.map((c) => c.idempotencyKey)).size).toBe(1);
    expect(fake.calls.indexOf(mine[0]!)).toBeLessThan(fake.calls.indexOf(stops(p.manager)[0]!));
    expect(live({ project: p.id, role: "manager" }).map((x) => x.sandbox)).toEqual([fake.agents.get(next)!.sandbox]);
  });

  it("a successor's sandbox made earlier and destroyed since (its idle TTL shorter than its key's): no move, shown; the next try makes one under fresh keys", async () => {
    const p = await newProject();
    await onNestRepos(p);
    // The first try makes the successor's sandbox, then finds the manager in a turn: no move.
    let release!: () => void;
    const hold = { match: /^POST \/v1\/sandboxes$/, release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const draining = drain(p);
    for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold.reached).toBe(true);
    fake.agents.get(p.manager)!.state = "working";
    release();
    await draining;
    const before = await settingsOf(p);
    expect(before.manager).toBe(p.manager);
    const made = live({ project: p.id, role: "manager", start: String((before.manager_starts as number) + 2) });
    expect(made).toHaveLength(1);
    // Destroyed since, as nest's idle TTL would: its key replays it so.
    made[0]!.ended = true;
    fake.agents.get(p.manager)!.state = "idle";
    await due(p);
    await drain(p);
    const s = await settingsOf(p);
    expect(s.manager).toBe(p.manager);
    expect(stops(p.manager)).toEqual([]);
    expect(s.manager_starts).toBe((before.manager_starts as number) + 1);
    const errors = (await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { code: string; message: string }[];
    expect(errors.filter((e) => e.code === "converge_failed").map((e) => e.message)).toEqual([expect.stringMatching(/was destroyed since/)]);
    // The next try: fresh keys, a new sandbox, and the move; the error goes.
    await due(p);
    await drain(p);
    await replaced(p);
    const next = (await settingsOf(p)).manager as string;
    expect(fake.sandboxes.get(fake.agents.get(next)!.sandbox!)!.ended).toBe(false);
    expect(fake.agents.get(next)!.labels.start).toBe(String((before.manager_starts as number) + 3));
    expect(((await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { code: string }[]).filter((e) => e.code === "converge_failed")).toEqual([]);
  });

  it("a successor's sandbox nest refuses for good: shown, and frozen again under fresh keys at the next try", async () => {
    const p = await newProject();
    await onNestRepos(p);
    const before = await settingsOf(p);
    fake.fail(/^POST \/v1\/sandboxes$/, 400, { times: 1 });
    await drain(p);
    const s = await settingsOf(p);
    expect(s.manager).toBe(p.manager);
    expect(stops(p.manager)).toEqual([]);
    expect(s.manager_starts).toBe((before.manager_starts as number) + 1);
    expect(((await api(token, "GET", `/api/projects/${p.id}/errors`)).body as { code: string }[]).filter((e) => e.code === "converge_failed")).toHaveLength(1);
    await due(p);
    await drain(p);
    await replaced(p);
    expect(fake.agents.get((await settingsOf(p)).manager as string)!.labels.start).toBe(String((before.manager_starts as number) + 3));
  });

  it("the old one is stopped right after nest's state is read, before anything else the drain owes nest", async () => {
    const p = await newProject();
    // A worker's start is owed in the same drain.
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    fake.fail(/^POST \/v1\/sandboxes$/, 503, { retryable: true, times: 3 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("assigned");
    await sql(p, (x) => x.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"));
    await onNestRepos(p);
    const mark = fake.calls.length;
    await drain(p);
    await replaced(p);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("in_progress");
    const stop = fake.calls.indexOf(stops(p.manager)[0]!);
    const worker = fake.calls.findIndex((c, i) => i >= mark && c.method === "POST" && c.path === "/v1/sandboxes" && c.body.labels?.task === t.id);
    expect(worker).toBeGreaterThan(stop);
  });

  it("not while the App can't reach the repo, nor while a message of the app's waits for it, nor within the quiet time after its own last turn", async () => {
    const p = await newProject();
    await onNestRepos(p);
    const kept = async (why: string) => {
      await due(p);
      await drain(p);
      expect((await settingsOf(p)).manager, why).toBe(p.manager);
      expect(stops(p.manager), why).toEqual([]);
    };
    await sql(p, (x) => x.exec("UPDATE settings SET gh_unreachable = 1"));
    await kept("unreachable");
    await sql(p, (x) => x.exec("UPDATE settings SET gh_unreachable = 0"));
    await sql(p, (x) => x.exec("INSERT INTO messages (to_agent, text, relayed, at_ms, next_ms) VALUES (?, 'a note', 0, 1, ?)", p.manager, Date.now() + 3_600_000));
    await kept("a message owed");
    await sql(p, (x) => x.exec("UPDATE messages SET next_ms = NULL"));
    await deliver({ id: `evt-${rand()}`, type: "agent.turn_completed", agent: p.manager, turn: 2, text: "Done for now." });
    await kept("its own turn just now");
    await sql(p, (x) => x.exec("UPDATE chat SET at_ms = ?", Date.now() - CONVERGE_QUIET_MS - 1000));
    await due(p);
    await drain(p);
    await replaced(p);
  });

  it("what the app owes the manager while none runs (a wait resolved, a worker's block) is kept for its successor, after its brief", async () => {
    const p = await newProject();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "w" })).body;
    const old = await signer.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" }));
    expect((await callTool("board", old, "await_task", { task: t.id, states: ["done"], timeout_s: 600 })).result?.isError).toBeFalsy();
    // A worker at work on another task.
    const w = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "x" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${w.id}/spec`, spec);
    const worker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${w.id}/assign`)).body.assignee as string;
    expect(worker).toMatch(/^agt_/);
    await onNestRepos(p);
    // The successor's agent can't be made for now: the old one is gone, its successor not started.
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    await drain(p);
    expect((await settingsOf(p)).manager).toBeNull();
    expect(stops(p.manager)).toHaveLength(1);
    // Meanwhile the wait resolves, and the worker reports its task blocked.
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/done`)).status).toBe(200);
    const wt = await signer.sign(agentClaims("task", worker, { project: p.id, role: "worker", task: w.id, start: "1" }));
    expect((await callTool("task", wt, "report_blocked", { reason: "No staging credentials" })).result?.isError).toBeFalsy();
    await drain(p);
    expect(fake.inbox.filter((m) => m.agent === p.manager && /No staging credentials|^await/.test(m.text))).toEqual([]);
    fake.failures = [];
    await sql(p, (x) => x.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"));
    await drain(p);
    await drain(p);
    const next = (await settingsOf(p)).manager as string;
    expect(next).toMatch(/^agt_/);
    const told = fake.inbox.filter((m) => m.agent === next).map((m) => m.text);
    expect(told[0]).toContain("You manage project");
    expect(told.slice(1).some((x) => x.includes(`task ${t.id}`) && x.startsWith("await"))).toBe(true);
    expect(told.slice(1).some((x) => x.includes(`blocked task ${w.id}`) && x.includes("No staging credentials"))).toBe(true);
  });

  it("not while the grant lacks the GitHub hosts: the old one keeps running, rather than none", async () => {
    const p = await newProject();
    await onNestRepos(p);
    const saved = [...fake.grant.inject_hosts];
    fake.grant.inject_hosts = saved.filter((h) => h !== "api.github.com");
    try {
      await drain(p);
      expect((await settingsOf(p)).manager).toBe(p.manager);
      expect(stops(p.manager)).toEqual([]);
    } finally {
      fake.grant.inject_hosts = saved;
    }
    await due(p);
    await drain(p);
    await replaced(p);
  });

  it("one made on nest's repos whose brief is still owed: not replaced before it's briefed, and looked at once it is", async () => {
    // Its brief can't be delivered for now: made, its start not done.
    fake.fail(/^POST \/v1\/agents\/[^/]+\/inbox$/, 503, { retryable: true, times: 1000 });
    const p = await newProject();
    expect(p.manager).toMatch(/^agt_/);
    // As a start B3 froze on nest's repos left it (its agent made on them): its spec and layer without the app's part.
    await frozenBefore(p);
    await sql(p, (x) => x.exec("UPDATE layers SET github = 0 WHERE agent = ?", p.manager));
    expect((await settingsOf(p)).manager_next_ms).not.toBeNull();
    await due(p);
    await drain(p);
    // Looked at again later, not at every drain while the brief is retried.
    expect((await settingsOf(p)).converge_next_ms).toBeGreaterThan(Date.now());
    expect((await settingsOf(p)).manager).toBe(p.manager);
    expect(stops(p.manager)).toEqual([]);
    // Briefed now: its start done, it's looked at, and replaced.
    fake.failures = [];
    await sql(p, (x) => x.exec("UPDATE settings SET manager_next_ms = 0, converge_next_ms = NULL"));
    await drain(p);
    expect(fake.inbox.filter((m) => m.agent === p.manager)).toHaveLength(1);
    await drain(p);
    await replaced(p);
  });

  it("one on the app's access already is left as it is", async () => {
    const p = await newProject();
    await due(p);
    await drain(p);
    const s = await settingsOf(p);
    expect(s.manager).toBe(p.manager);
    expect(s.converge_next_ms).toBeNull();
    expect(stops(p.manager)).toEqual([]);
  });

  it("after a deploy, the project's first use (whatever it is) arms the look, with no alarm set: the manager is replaced", async () => {
    const p = await newProject();
    // As B4's migration leaves a project at the deploy: the look owed, no alarm for it, and a new instance.
    await runInDurableObject(stub(p), async (_o, st) => {
      st.storage.sql.exec("UPDATE layers SET github = 0 WHERE agent = ?", p.manager);
      st.storage.sql.exec("UPDATE settings SET converge_next_ms = 0");
      await st.storage.deleteAlarm();
    });
    await runInDurableObject(stub(p), (_o, st) => st.abort("deployed")).catch(() => {});
    // A read that drains nothing.
    expect((await api(token, "GET", `/api/projects/${p.id}/waits`)).status).toBe(200);
    await eventually(async () => {
      const s = await settingsOf(p);
      return s.manager && s.manager !== p.manager ? s.manager : null;
    }, "the manager replaced by the alarm the constructor armed");
    await replaced(p);
  });

  it("a live manager's layer made anew (none kept for it) takes its access from its start's frozen spec: the app's, or with none found, nest's repos", async () => {
    const p = await newProject();
    const github = () => sql(p, (x) => x.exec("SELECT github FROM layers WHERE agent = ?", p.manager).toArray()[0]?.github);
    await sql(p, (x) => x.exec("DELETE FROM layers WHERE agent = ?", p.manager));
    expect((await api(token, "PUT", `/api/projects/${p.id}/network`, { worker: [], manager: [{ host: "pypi.org" }] })).status).toBe(200);
    expect(await github()).toBe(1);
    await sql(p, (x) => {
      x.exec("DELETE FROM layers WHERE agent = ?", p.manager);
      x.exec("DELETE FROM start_specs");
    });
    expect((await api(token, "PUT", `/api/projects/${p.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] })).status).toBe(200);
    expect(await github()).toBe(0);
  });

  it("a manager's layer made anew while its brief is still owed takes its access from the start being briefed", async () => {
    // Its brief can't be delivered for now: made, its start not done (`manager_starts` not moved on to it yet).
    fake.fail(/^POST \/v1\/agents\/[^/]+\/inbox$/, 503, { retryable: true, times: 1000 });
    const p = await newProject();
    expect((await settingsOf(p)).manager_next_ms).not.toBeNull();
    await sql(p, (x) => x.exec("DELETE FROM layers WHERE agent = ?", p.manager));
    expect((await api(token, "PUT", `/api/projects/${p.id}/network`, { worker: [], manager: [{ host: "pypi.org" }] })).status).toBe(200);
    expect(await sql(p, (x) => x.exec("SELECT github FROM layers WHERE agent = ?", p.manager).one().github)).toBe(1);
  });

  it("the migration owes the look to a project with a manager, from the release before it", async () => {
    const p = await newProject();
    await runInDurableObject(stub(p), (_o, st) => {
      const x = st.storage.sql;
      // As the release before left it: none of this release's step.
      x.exec("DROP TABLE abandoned_starts");
      x.exec("ALTER TABLE settings DROP COLUMN converge_next_ms");
      x.exec("UPDATE schema_version SET v = ?", MIGRATIONS.length - 1);
      migrate(st.storage, MIGRATIONS);
      expect(x.exec("SELECT converge_next_ms FROM settings").one().converge_next_ms).toBe(0);
    });
  });
});

describe("a start frozen on nest's repos", () => {
  it("a worker's is begun again as a new attempt with the app's access; what the old one made goes", async () => {
    const p = await newProject();
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    // Its agent's create fails for now: the attempt is frozen, its sandbox made.
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    const first = { project: p.id, role: "worker", task: t.id, start: "1" };
    expect(live(first)).toHaveLength(1);
    await frozenBefore(p);
    fake.failures = [];
    await sql(p, (x) => x.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"));
    await drain(p);
    const now = (await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body;
    expect(now.state).toBe("in_progress");
    expect(fake.agents.get(now.assignee)!.labels.start).toBe("2");
    expect(fake.agents.get(now.assignee)!.overrides).toEqual({ repos: [], read_repos: [] });
    expect(fake.sandboxes.get(fake.agents.get(now.assignee)!.sandbox!)!.layer.guards).toEqual(githubGuards(p.repo, "push"));
    expect((now.history as { action: string }[]).some((h) => h.action === "restarted_on_app_access")).toBe(true);
    // What the old attempt made is gone; looked for once more past nest's idempotency lease (a create still in
    // flight may land late), then forgotten.
    expect(live(first)).toEqual([]);
    const [old] = [...fake.sandboxes.values()].filter((x) => x.labels.task === t.id && x.labels.start === "1");
    fake.sandboxes.set("sbx_late1", { ...old!, sandbox: "sbx_late1", ended: false });
    await sql(p, (x) => x.exec("UPDATE abandoned SET next_ms = 0"));
    await drain(p);
    expect(live(first)).toEqual([]);
    expect(await sql(p, (x) => x.exec("SELECT COUNT(*) AS n FROM abandoned").one().n)).toBe(0);
  });

  it("the manager's is begun again as a new start with the app's access; what the old one made goes", async () => {
    const p = await newProject();
    // Restarted, its start's agent create failing for now: frozen, its sandbox made.
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    await api(token, "POST", `/api/projects/${p.id}/manager/restart`);
    await drain(p);
    const before = await settingsOf(p);
    expect(before.manager).toBeNull();
    const first = { project: p.id, role: "manager", start: String((before.manager_starts as number) + 1) };
    expect(live(first)).toHaveLength(1);
    await frozenBefore(p);
    fake.failures = [];
    await sql(p, (x) => x.exec("UPDATE settings SET manager_next_ms = 0"));
    await drain(p);
    const after = await settingsOf(p);
    expect(after.manager).toMatch(/^agt_/);
    expect(fake.agents.get(after.manager as string)!.labels.start).not.toBe(first.start);
    expect(await sql(p, (x) => x.exec("SELECT github FROM layers WHERE agent = ?", after.manager).one().github)).toBe(1);
    await sweptTwice(p, first);
  });

  it("a reviewer's is begun again as a new attempt, none of the job's attempts spent; what the old one made goes", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    const head = sha();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 7, sha: head, action: "opened" }));
    const review = env.REVIEW.get(env.REVIEW.idFromName(p.id));
    await review.drain();
    const first = { project: p.id, role: "reviewer", pr: "7", sha: head, start: "1" };
    expect(live(first)).toHaveLength(1);
    await frozenBefore(p);
    fake.failures = [];
    await runInDurableObject(review, (_o, st) => { st.storage.sql.exec("UPDATE jobs SET next_ms = 0 WHERE state = 'running'"); });
    await review.drain();
    await review.drain();
    const job = await runInDurableObject(review, (_o, st) => st.storage.sql.exec("SELECT agent, attempts, runs FROM jobs WHERE pr = 7").one());
    expect(job.agent).toMatch(/^agt_/);
    expect(job.attempts).toBe(0);
    const a = fake.agents.get(job.agent as string)!;
    expect(a.labels.start).toBe("2");
    expect(a.overrides).toEqual({ repos: [], read_repos: [] });
    expect(fake.sandboxes.get(a.sandbox!)!.layer.guards).toEqual(githubGuards(p.repo, "read"));
    await sweptTwice(p, first);
  });
});
