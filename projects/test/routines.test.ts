// Routines (README.md#routines) and the project's memory (README.md#memory). A routine fires on its timer
// or on the board's counters since its last run, starts one ephemeral, read-only agent per run (one at a
// time per routine, a cap across the project, a cooldown between starts), and its proposed tasks wait in
// triage, never on the board unless the routine says so. Memory is written by the manager and routines
// only. The pure rules first.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { DREAM_MAX_ENTRIES, FIRST_DREAM_WINDOW_MS, firedTrigger, MAX_DREAM_WINDOW_MS, MAX_PROPOSALS_PER_RUN, nextTimerFire, PRESETS, routineSpawnExtras, startVerdict, type Triggers, wallToUtc } from "../src/routines";
import { AccessTeam, agentClaims, api, callTool, deliver, deliverGithub, FakeNest, installFetch, prEvent, shaOf, Signer } from "./fake-nest";

const MIN = 60_000;
const at = (iso: string) => Date.parse(iso);

describe("timers (pure)", () => {
  it("an interval fires its length after the reference", () => {
    expect(nextTimerFire({ kind: "interval", minutes: 15 }, 1_000_000)).toBe(1_000_000 + 15 * MIN);
  });

  it("a daily time fires today if still ahead, else tomorrow, in its time zone", () => {
    const t = { kind: "daily", time: "03:00", tz: "UTC" } as const;
    expect(nextTimerFire(t, at("2026-11-06T02:59:00Z"))).toBe(at("2026-11-06T03:00:00Z"));
    expect(nextTimerFire(t, at("2026-11-06T03:00:00Z"))).toBe(at("2026-11-07T03:00:00Z"));
    // 09:00 in New York is 14:00 UTC in winter (EST), 13:00 in summer (EDT).
    const ny = { kind: "daily", time: "09:00", tz: "America/New_York" } as const;
    expect(nextTimerFire(ny, at("2026-12-01T00:00:00Z"))).toBe(at("2026-12-01T14:00:00Z"));
    expect(nextTimerFire(ny, at("2026-07-01T00:00:00Z"))).toBe(at("2026-07-01T13:00:00Z"));
    // Across the fall-back night (2026-11-01): the 9:00 after it is in EST.
    expect(nextTimerFire(ny, at("2026-10-31T14:00:00Z"))).toBe(at("2026-11-01T14:00:00Z"));
  });

  it("a time skipped by a DST change lands after the skip", () => {
    // 2026-03-08, New York: 02:00 EST jumps to 03:00 EDT; 02:30 doesn't exist and becomes 03:30 EDT (07:30 UTC).
    expect(wallToUtc("America/New_York", 2026, 2, 8, 2, 30)).toBe(at("2026-03-08T07:30:00Z"));
  });

  it("a weekly time fires on its weekday only", () => {
    // 2026-11-06 is a Friday (5). Monday 09:00 UTC is 2026-11-09.
    const t = { kind: "weekly", day: 1, time: "09:00", tz: "UTC" } as const;
    expect(nextTimerFire(t, at("2026-11-06T12:00:00Z"))).toBe(at("2026-11-09T09:00:00Z"));
    expect(nextTimerFire(t, at("2026-11-09T09:00:00Z"))).toBe(at("2026-11-16T09:00:00Z"));
    expect(nextTimerFire({ ...t, day: 5 }, at("2026-11-06T08:00:00Z"))).toBe(at("2026-11-06T09:00:00Z"));
  });
});

describe("deciding a run (pure)", () => {
  const triggers: Triggers = { timer: { kind: "interval", minutes: 15 }, tasks_done: 3, prs_merged: 2 };
  it("fires on its timer, or a counter at its threshold, and not below it", () => {
    expect(firedTrigger({ triggers, timer_next_ms: 100 }, { tasks_done: 0, prs_merged: 0 }, 100)).toBe("timer");
    expect(firedTrigger({ triggers, timer_next_ms: 101 }, { tasks_done: 0, prs_merged: 0 }, 100)).toBeNull();
    expect(firedTrigger({ triggers, timer_next_ms: 101 }, { tasks_done: 2, prs_merged: 1 }, 100)).toBeNull();
    expect(firedTrigger({ triggers, timer_next_ms: 101 }, { tasks_done: 3, prs_merged: 0 }, 100)).toBe("tasks_done");
    expect(firedTrigger({ triggers, timer_next_ms: 101 }, { tasks_done: 0, prs_merged: 2 }, 100)).toBe("prs_merged");
    expect(firedTrigger({ triggers: { ...triggers, timer: null }, timer_next_ms: 0 }, { tasks_done: 0, prs_merged: 0 }, 100)).toBeNull();
  });

  it("one run at a time, its cooldown (a manual run skips it), and the project's cap", () => {
    const base = { live_for_routine: 0, live_total: 0, cap: 1, last_start_ms: 1_000, cooldown_min: 10, manual: false, now: 1_000 + 10 * MIN };
    expect(startVerdict(base)).toEqual({ start: true });
    expect(startVerdict({ ...base, live_for_routine: 1, live_total: 1, cap: 5 })).toEqual({ start: false, why: "running", until: null });
    expect(startVerdict({ ...base, now: 1_000 + 10 * MIN - 1 })).toEqual({ start: false, why: "cooldown", until: 1_000 + 10 * MIN });
    expect(startVerdict({ ...base, now: 1_000 + 10 * MIN - 1, manual: true })).toEqual({ start: true });
    expect(startVerdict({ ...base, live_total: 1 })).toEqual({ start: false, why: "cap", until: null });
    expect(startVerdict({ ...base, live_total: 1, cap: 2 })).toEqual({ start: true });
  });
});

describe("the transcript grant (pure)", () => {
  const o = { kind: "dreaming" as const, project: "prj_x", deadline_ms: 5_000_000_000, last_start_ms: 4_000_000_000, now: 4_100_000_000, enabled: true };
  it("a dreaming run reads its project's agents since its last run, until its deadline", () => {
    expect(routineSpawnExtras(o)).toEqual({
      grants: [{ action: "read_transcript", resource: "agent{project=prj_x}", limits: { max_age_ms: 100_000_000, max_entries: DREAM_MAX_ENTRIES }, expires_ms: 5_000_000_000 }],
    });
    // The first run reads a week; a long gap at most 30 days.
    expect((routineSpawnExtras({ ...o, last_start_ms: null }).grants as any)[0].limits.max_age_ms).toBe(FIRST_DREAM_WINDOW_MS);
    expect((routineSpawnExtras({ ...o, last_start_ms: 0 }).grants as any)[0].limits.max_age_ms).toBe(MAX_DREAM_WINDOW_MS);
  });

  it("nothing for another kind, or while the grant is off", () => {
    expect(routineSpawnExtras({ ...o, kind: "review" })).toEqual({});
    expect(routineSpawnExtras({ ...o, enabled: false })).toEqual({});
  });
});

// --- Through the app ------------------------------------------------------------------------------------

const fake = new FakeNest();
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
const eid = () => `evt-${rand()}`;

async function setup() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, manager: p.settings.manager as string, repo };
}
type S = Awaited<ReturnType<typeof setup>>;

const stub = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.id));
const settle = (s: S) => stub(s).drain();
const fields = (over: Record<string, unknown> = {}) => ({
  name: "R", kind: "custom", prompt: "Look around.", enabled: true, triggers: { timer: null, tasks_done: null, prs_merged: null },
  cooldown_min: 0, max_minutes: 30, max_turns: 3, proposals: "triage", ...over,
});
const create = async (s: S, over: Record<string, unknown> = {}) => {
  const r = await api(token, "POST", `/api/projects/${s.id}/routines`, fields(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.id as string;
};
const routine = async (s: S, id: string) => (await api(token, "GET", `/api/projects/${s.id}/routines/${id}`)).body;
const runs = async (s: S, id: string) => (await api(token, "GET", `/api/projects/${s.id}/routines/${id}/runs`)).body as any[];
const liveRun = async (s: S, id: string) => (await routine(s, id)).live_run;
/** Every routine's timer due now: as if its time came. */
const timersDue = (s: S) => runInDurableObject(stub(s), (_i: unknown, st: DurableObjectState) => {
  st.storage.sql.exec("UPDATE routines SET timer_next_ms = 0 WHERE timer_next_ms IS NOT NULL");
});
const doneTask = async (s: S) => {
  const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: `t-${rand()}` })).body;
  expect((await api(token, "POST", `/api/projects/${s.id}/tasks/${t.id}/done`)).status).toBe(200);
};
const runCaller = async (s: S, run: { id: string; routine: string; agent: string }) =>
  nest.sign(agentClaims("routine", run.agent, { project: s.id, role: "routine", routine: run.routine, run: run.id }, { tainted: true }));
const routineTool = async (s: S, run: any, tool: string, args: Record<string, unknown> = {}) => callTool("routine", await runCaller(s, run), tool, args);
const ok = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBe(true);
  return r.result.content[0].text as string;
};
const exited = (agent: string) => deliver({ id: eid(), type: "agent.exited", agent, reason: "done", text: "" });
/** A run's agent completes its turn and ends itself, as an ephemeral agent does. */
const finish = async (agent: string) => {
  await deliver({ id: eid(), type: "agent.turn_completed", agent, turn: 1, text: "Done." });
  await exited(agent);
};
const stopsOf = (agent: string) => fake.calls.filter((c) => c.method === "POST" && c.path === `/v1/agents/${agent}/stop`);

describe("firing", () => {
  it("a timer starts one run: a read-only, ephemeral routine agent labelled with its run, briefed with the owner's prompt", async () => {
    const s = await setup();
    const id = await create(s, { prompt: "Check the docs.", triggers: { timer: { kind: "interval", minutes: 15 }, tasks_done: null, prs_merged: null } });
    const before = await routine(s, id);
    expect(before.next_timer_ms).toBeGreaterThan(Date.now() + 14 * MIN);
    expect(before.live_run).toBeNull();
    await timersDue(s);
    await settle(s);
    const run = await liveRun(s, id);
    expect(run).toMatchObject({ state: "running", trigger: "timer", n: 1 });
    const a = fake.agents.get(run.agent)!;
    expect(a.template).toBe("projects/routine");
    expect(a.labels).toEqual({ project: s.id, role: "routine", routine: id, run: run.id });
    expect(a.overrides).toEqual({ read_repos: [s.repo] });
    // No grants while ROUTINE_TRANSCRIPT_GRANT is off (wrangler.jsonc), whatever the kind.
    expect(fake.calls.find((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels?.run === run.id)!.body.grants).toBeUndefined();
    const brief = fake.inbox.filter((m) => m.agent === run.agent);
    expect(brief).toHaveLength(1);
    expect(brief[0]!.text).toContain("Check the docs.");
    expect(brief[0]!.from).toBeUndefined();
    // The timer moved on: the next fire is an interval away, not now.
    expect((await routine(s, id)).next_timer_ms).toBeGreaterThan(Date.now() + 14 * MIN);
    // Ticking again starts nothing more.
    await settle(s);
    expect(await runs(s, id)).toHaveLength(1);
  });

  it("N tasks done since the last run fires it, not N-1; its counter starts again at the run", async () => {
    const s = await setup();
    const id = await create(s, { triggers: { timer: null, tasks_done: 2, prs_merged: null } });
    await doneTask(s);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(0);
    expect((await routine(s, id)).counts.tasks_done).toBe(1);
    await doneTask(s);
    await settle(s);
    const run = await liveRun(s, id);
    expect(run).toMatchObject({ trigger: "tasks_done", count: 2 });
    expect((await routine(s, id)).counts.tasks_done).toBe(0);
    await exited(run.agent);
    await doneTask(s);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(1);
  });

  it("N task PRs merged fires it; a PR that isn't a task's doesn't count", async () => {
    const s = await setup();
    const id = await create(s, { triggers: { timer: null, tasks_done: null, prs_merged: 1 } });
    // Another PR, merged: not a task's.
    await deliverGithub("pull_request", prEvent({ repo: s.repo, number: 900, sha: shaOf("x"), action: "opened" }));
    await deliverGithub("pull_request", prEvent({ repo: s.repo, number: 900, sha: shaOf("x"), action: "closed", merged: true }));
    await settle(s);
    expect(await runs(s, id)).toHaveLength(0);
    // A task's PR, merged.
    const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "with a PR" })).body;
    await deliverGithub("pull_request", prEvent({ repo: s.repo, number: 7, sha: shaOf("a"), action: "opened", ref: `task/${t.id}` }));
    await deliverGithub("pull_request", prEvent({ repo: s.repo, number: 7, sha: shaOf("a"), action: "closed", merged: true, ref: `task/${t.id}` }));
    await settle(s);
    expect(await liveRun(s, id)).toMatchObject({ trigger: "prs_merged", count: 1 });
  });

  it("a disabled routine doesn't fire; enabling it counts from then, not from before", async () => {
    const s = await setup();
    const id = await create(s, { enabled: false, triggers: { timer: { kind: "interval", minutes: 15 }, tasks_done: 1, prs_merged: null } });
    expect((await routine(s, id)).next_timer_ms).toBeNull();
    await doneTask(s);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(0);
    expect((await api(token, "PATCH", `/api/projects/${s.id}/routines/${id}`, { enabled: true })).status).toBe(200);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(0);
    await doneTask(s);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(1);
  });
});

describe("one at a time, the cooldown and the cap", () => {
  it("a trigger while its run is live waits for that run's end, then starts one more run", async () => {
    const s = await setup();
    const id = await create(s, { triggers: { timer: { kind: "interval", minutes: 15 }, tasks_done: null, prs_merged: null } });
    expect((await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`)).status).toBe(200);
    const first = await liveRun(s, id);
    expect(first.trigger).toBe("manual");
    expect((await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`)).status).toBe(409);
    await timersDue(s);
    await settle(s);
    expect(await runs(s, id)).toHaveLength(1);
    expect(await routine(s, id)).toMatchObject({ due: { trigger: "timer" }, waiting: "running" });
    await finish(first.agent);
    await settle(s);
    const all = await runs(s, id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ trigger: "timer", state: "running" });
    expect(all[1]).toMatchObject({ id: first.id, state: "ended", outcome: "done" });
  });

  it("within its cooldown a trigger waits; Run now skips the cooldown", async () => {
    const s = await setup();
    const id = await create(s, { cooldown_min: 60, triggers: { timer: null, tasks_done: 1, prs_merged: null } });
    await doneTask(s);
    await settle(s);
    const first = await liveRun(s, id);
    await exited(first.agent);
    await doneTask(s);
    await settle(s);
    const r = await routine(s, id);
    expect(r).toMatchObject({ due: { trigger: "tasks_done" }, waiting: "cooldown", live_run: null });
    expect(r.cooldown_until_ms).toBeGreaterThan(Date.now() + 59 * MIN);
    expect((await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`)).status).toBe(200);
    expect(await liveRun(s, id)).toMatchObject({ trigger: "manual" });
  });

  it("the project's cap: a second routine waits for a place, and starts when the first run ends", async () => {
    const s = await setup();
    const a = await create(s, { name: "A" });
    const b = await create(s, { name: "B" });
    await api(token, "POST", `/api/projects/${s.id}/routines/${a}/run`);
    await api(token, "POST", `/api/projects/${s.id}/routines/${b}/run`);
    const runA = await liveRun(s, a);
    expect(runA).not.toBeNull();
    expect(await routine(s, b)).toMatchObject({ live_run: null, due: { trigger: "manual" }, waiting: "cap" });
    await exited(runA.agent);
    await settle(s);
    expect(await liveRun(s, b)).toMatchObject({ state: "running", trigger: "manual" });
  });

  it("a cap of 2 runs two routines at once", async () => {
    const s = await setup();
    expect((await api(token, "PATCH", `/api/projects/${s.id}/settings`, { max_routine_runs: 2 })).status).toBe(200);
    const a = await create(s, { name: "A" });
    const b = await create(s, { name: "B" });
    await api(token, "POST", `/api/projects/${s.id}/routines/${a}/run`);
    await api(token, "POST", `/api/projects/${s.id}/routines/${b}/run`);
    expect(await liveRun(s, a)).not.toBeNull();
    expect(await liveRun(s, b)).not.toBeNull();
  });
});

describe("cost guards", () => {
  it("a run past its time budget ends timed out, and its agent is stopped with its sandbox", async () => {
    const s = await setup();
    const id = await create(s);
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    await runInDurableObject(stub(s), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE routine_runs SET deadline_ms = 0 WHERE id = ?", run.id);
    });
    await settle(s);
    expect((await runs(s, id))[0]).toMatchObject({ state: "ended", outcome: "timed_out" });
    expect(stopsOf(run.agent).map((c) => c.body)).toEqual([expect.objectContaining({ end: true, destroy_sandbox: true })]);
    // An ended run's agent can't act.
    expect(toolError(await routineTool(s, run, "propose_task", { title: "x", body: "y" }))).toMatch(/ended/);
  });

  it("a run reaching its turn budget ends, its report kept", async () => {
    const s = await setup();
    const id = await create(s, { max_turns: 2 });
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    await deliver({ id: eid(), type: "agent.turn_completed", agent: run.agent, turn: 1, text: "first" });
    expect(await liveRun(s, id)).toMatchObject({ turns: 1, summary: "first" });
    await deliver({ id: eid(), type: "agent.turn_completed", agent: run.agent, turn: 2, text: "Proposed two fixes." });
    await settle(s);
    expect((await runs(s, id))[0]).toMatchObject({ state: "ended", outcome: "done", turns: 2, summary: "Proposed two fixes.", note: expect.stringMatching(/turn budget/) });
    expect(stopsOf(run.agent)).toHaveLength(1);
  });

  it("a run whose agent ends before a turn has failed", async () => {
    const s = await setup();
    const id = await create(s);
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    await exited(run.agent);
    expect((await runs(s, id))[0]).toMatchObject({ outcome: "failed", error: expect.stringMatching(/before finishing a turn/) });
  });
});

describe("proposals: into triage, never onto the board", () => {
  it("a run's proposal waits in triage, marked as the routine's; accepting it makes a tainted draft", async () => {
    const s = await setup();
    const id = await create(s, { name: "Spontaneous review" });
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    const p = ok(await routineTool(s, run, "propose_task", { title: "Fix the race", body: "In src/a.ts." }));
    expect(p.where).toBe("triage");
    expect((await api(token, "GET", `/api/projects/${s.id}/tasks`)).body).toEqual([]);
    const queue = (await api(token, "GET", `/api/projects/${s.id}/proposals`)).body;
    expect(queue).toEqual([expect.objectContaining({ id: p.proposal, title: "Fix the race", routine: id, routine_name: "Spontaneous review", run: run.id })]);
    expect((await liveRun(s, id)).created).toEqual([{ kind: "proposal", id: p.proposal, title: "Fix the race" }]);
    const t = (await api(token, "POST", `/api/projects/${s.id}/proposals/${p.proposal}/accept`)).body;
    expect(t).toMatchObject({ state: "draft", title: "Fix the race", tainted: true, assignee: null });
    expect(t.body).toContain('Proposed by the routine "Spontaneous review"');
    expect((await api(token, "GET", `/api/projects/${s.id}/proposals`)).body).toEqual([]);
    expect((await api(token, "POST", `/api/projects/${s.id}/proposals/${p.proposal}/accept`)).status).toBe(409);
  });

  it("declined, it leaves the queue with no task", async () => {
    const s = await setup();
    const id = await create(s);
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const p = ok(await routineTool(s, await liveRun(s, id), "propose_task", { title: "Meh", body: "b" }));
    expect((await api(token, "POST", `/api/projects/${s.id}/proposals/${p.proposal}/decline`, { reason: "not now" })).status).toBe(200);
    expect((await api(token, "GET", `/api/projects/${s.id}/proposals`)).body).toEqual([]);
    expect((await api(token, "GET", `/api/projects/${s.id}/tasks`)).body).toEqual([]);
  });

  it("with proposals set to draft, they go onto the board as drafts, unassigned and tainted", async () => {
    const s = await setup();
    await api(token, "PATCH", `/api/projects/${s.id}/settings`, { auto_assign: true });
    const id = await create(s, { proposals: "draft" });
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const p = ok(await routineTool(s, await liveRun(s, id), "propose_task", { title: "Draft it", body: "b" }));
    expect(p.where).toBe("board");
    const tasks = (await api(token, "GET", `/api/projects/${s.id}/tasks`)).body;
    expect(tasks).toEqual([expect.objectContaining({ id: p.task, state: "draft", assignee: null, tainted: true })]);
    expect((await api(token, "GET", `/api/projects/${s.id}/proposals`)).body).toEqual([]);
  });

  it(`a run proposes at most ${MAX_PROPOSALS_PER_RUN}`, async () => {
    const s = await setup();
    const id = await create(s);
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    for (let i = 0; i < MAX_PROPOSALS_PER_RUN; i++) ok(await routineTool(s, run, "propose_task", { title: `p${i}`, body: "b" }));
    expect(toolError(await routineTool(s, run, "propose_task", { title: "one more", body: "b" }))).toMatch(/at most/);
  });

  it("a routine has no tool that assigns, starts or changes a task", async () => {
    const s = await setup();
    const id = await create(s);
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    for (const tool of ["assign_task", "create_task", "write_spec", "update_task", "cancel_task"]) {
      expect(toolError(await routineTool(s, run, tool, {})), tool).toMatch(/unknown tool/);
    }
    // Another routine's (or another run's) labels don't reach this run.
    expect((await callTool("routine", await nest.sign(agentClaims("routine", run.agent, { project: s.id, role: "routine", routine: id, run: "run_other" })), "list_tasks")).result.isError).toBe(true);
    // Nor does another agent carrying this run's labels.
    expect((await callTool("routine", await nest.sign(agentClaims("routine", "agt_impostor", { project: s.id, role: "routine", routine: id, run: run.id })), "list_tasks")).result.isError).toBe(true);
    expect((await routineTool(s, run, "list_tasks")).result.isError).toBeFalsy();
  });
});

describe("memory: the manager and routines write it, workers read it", () => {
  it("the manager writes a note, a worker reads it and can't write, a routine writes with its source and taint", async () => {
    const s = await setup();
    const manager = await nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" }));
    ok(await callTool("board", manager, "memory_write", { key: "owner-prefers-small-prs", text: "Keep PRs small." }));
    const t = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "w" })).body;
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    const worker = (await api(token, "POST", `/api/projects/${s.id}/tasks/${t.id}/assign`)).body.assignee as string;
    const w = await nest.sign(agentClaims("task", worker, { project: s.id, role: "worker", task: t.id, start: "1" }));
    expect(ok(await callTool("task", w, "memory_get", { key: "owner-prefers-small-prs" })).text).toBe("Keep PRs small.");
    expect(ok(await callTool("task", w, "memory_list")).notes.map((n: any) => n.key)).toEqual(["owner-prefers-small-prs"]);
    expect(toolError(await callTool("task", w, "memory_write", { key: "x", text: "y" }))).toMatch(/unknown tool/);
    expect(toolError(await callTool("task", w, "memory_delete", { key: "owner-prefers-small-prs" }))).toMatch(/unknown tool/);

    const id = await create(s, { name: "Dreaming" });
    await api(token, "POST", `/api/projects/${s.id}/routines/${id}/run`);
    const run = await liveRun(s, id);
    ok(await routineTool(s, run, "memory_write", { key: "owner-prefers-small-prs", text: "Keep PRs under 300 lines." }));
    const notes = (await api(token, "GET", `/api/projects/${s.id}/memory`)).body;
    expect(notes).toEqual([expect.objectContaining({ key: "owner-prefers-small-prs", text: "Keep PRs under 300 lines.", tainted: true, source: `routine:Dreaming (${run.id})` })]);
    expect((await liveRun(s, id)).created).toEqual([{ kind: "memory_write", key: "owner-prefers-small-prs" }]);
    // The owner deletes it.
    expect((await api(token, "DELETE", `/api/projects/${s.id}/memory/owner-prefers-small-prs`)).status).toBe(200);
    expect((await api(token, "GET", `/api/projects/${s.id}/memory`)).body).toEqual([]);
  });

  it("a reviewer has no memory tools, and a bad key is refused", async () => {
    const s = await setup();
    const r = await nest.sign(agentClaims("review", "agt_rev", { project: s.id, role: "reviewer", pr: "1", sha: shaOf("a") }));
    expect(toolError(await callTool("review", r, "memory_list"))).toMatch(/unknown tool/);
    const manager = await nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" }));
    expect(toolError(await callTool("board", manager, "memory_write", { key: "Bad Key", text: "y" }))).toMatch(/must match/);
  });
});

describe("presets", () => {
  it("a preset is created with one call, enabled, and editable after", async () => {
    const s = await setup();
    const r = (await api(token, "POST", `/api/projects/${s.id}/routines`, { preset: "dreaming" })).body;
    expect(r).toMatchObject({ name: PRESETS.dreaming.name, kind: "dreaming", preset: "dreaming", enabled: true, triggers: PRESETS.dreaming.triggers });
    expect(r.next_timer_ms).not.toBeNull();
    // A dreaming run gets no transcript grant while ROUTINE_TRANSCRIPT_GRANT is off (wrangler.jsonc).
    await api(token, "POST", `/api/projects/${s.id}/routines/${r.id}/run`);
    const run = await liveRun(s, r.id);
    const create = fake.calls.find((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels?.run === run.id)!;
    expect(create.body.grants).toBeUndefined();
    expect(fake.inbox.find((m) => m.agent === run.agent)!.text).not.toContain("read_transcript");
    const u = (await api(token, "PATCH", `/api/projects/${s.id}/routines/${r.id}`, { triggers: { timer: null, tasks_done: 4, prs_merged: null } })).body;
    expect(u).toMatchObject({ triggers: { timer: null, tasks_done: 4 }, next_timer_ms: null });
  });

  it("refuses an interval under 15 minutes and an unknown time zone", async () => {
    const s = await setup();
    expect((await api(token, "POST", `/api/projects/${s.id}/routines`, fields({ triggers: { timer: { kind: "interval", minutes: 14 }, tasks_done: null, prs_merged: null } }))).status).toBe(400);
    expect((await api(token, "POST", `/api/projects/${s.id}/routines`, fields({ triggers: { timer: { kind: "daily", time: "03:00", tz: "Mars/Olympus" }, tasks_done: null, prs_merged: null } }))).status).toBe(400);
  });
});
