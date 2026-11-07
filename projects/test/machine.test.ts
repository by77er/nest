// The task machine (src/tasks.ts `step`, README.md#the-task-machine): a task's state, its worker, its
// PRs and the comments queued for its worker, moved together. The table below is README.md's flow, one
// sentence a row; every other move is refused. A seeded random walk then takes the machine through
// every event in every reachable situation and checks its invariants after each step.
import { describe, expect, it } from "vitest";
import { step, TASK_EVENTS, TASK_STATES, type TaskEvent, type TaskFacts, type TaskState, TERMINAL, WORKER_STATES } from "../src/tasks";

/** A task in `state` as it would be: a worker of its own in the worker states, one starting in `assigned`. */
const at = (state: TaskState, o: Partial<TaskFacts> = {}): TaskFacts => ({
  state, openPrs: 0, mergedPrs: 0, workerLive: WORKER_STATES.has(state), startOwed: state === "assigned", queuedInputs: 0, ...o,
});
const pr = { openPrs: 1 };

/** README.md's flow: (facts, event) → state, and the worker's and the inputs' effects. */
const FLOW: [string, TaskFacts, TaskEvent, TaskState, { worker?: string | null; inputs?: string | null }][] = [
  ["the manager specs a draft", at("draft"), "spec", "ready", {}],
  ["a ready task is re-specced", at("ready"), "spec", "ready", {}],
  ["a task with a live worker is re-specced in place", at("in_progress"), "spec", "in_progress", {}],
  ["a starting one too", at("assigned"), "spec", "assigned", {}],
  ["one in review too", at("in_review", pr), "spec", "in_review", {}],
  ["it's assigned: a worker is owed", at("ready"), "assign", "assigned", { worker: "start" }],
  ["a stalled one is reassigned", at("stalled"), "assign", "assigned", { worker: "start" }],
  ["a stalled one holding an open PR too", at("stalled", pr), "assign", "assigned", { worker: "start" }],
  ["its worker started: queued comments follow its brief", at("assigned"), "started", "in_progress", { worker: "started", inputs: "flush" }],
  ["started holding an open PR: in review", at("assigned", pr), "started", "in_review", { worker: "started", inputs: "flush" }],
  ["nest refused the worker for good", at("assigned"), "start_failed", "stalled", { worker: "failed" }],
  ["its queued comments go with it", at("assigned", { queuedInputs: 2 }), "start_failed", "stalled", { worker: "failed", inputs: "drop" }],
  ["a start begun again", at("assigned", { queuedInputs: 1 }), "start_abandoned", "assigned", { worker: "start" }],
  ["the worker opens a PR", at("in_progress"), "pr_attached", "in_review", {}],
  ["another PR in review", at("in_review", pr), "pr_attached", "in_review", {}],
  ["a PR attached to a draft", at("draft"), "pr_attached", "draft", {}],
  ["a PR attached to a ready task", at("ready"), "pr_attached", "ready", {}],
  ["a PR attached to a starting task", at("assigned"), "pr_attached", "assigned", {}],
  ["a PR attached to a stalled task", at("stalled"), "pr_attached", "stalled", {}],
  ["a worker exits before opening a PR", at("in_progress"), "worker_exited", "stalled", { worker: "exited" }],
  ["or before its brief: its queued comments go", at("assigned", { queuedInputs: 1 }), "worker_exited", "stalled", { worker: "exited", inputs: "drop" }],
  ["a worker exits with its PR open: in review it stays", at("in_review", pr), "worker_exited", "in_review", { worker: "exited" }],
  ["a stopped worker of a task that's over: its place frees", at("done", { workerLive: false, mergedPrs: 1 }), "worker_exited", "done", { worker: "exited" }],
  ["the PR merged: done, the worker ended", at("in_review", pr), "pr_merged", "done", { worker: "stop" }],
  ["one of two merged: still in review", at("in_review", { openPrs: 2 }), "pr_merged", "in_review", {}],
  ["the last open one merged with no worker", at("stalled", pr), "pr_merged", "done", { worker: "stop" }],
  ["merged while a worker starts: its comments go", at("assigned", { openPrs: 1, queuedInputs: 1 }), "pr_merged", "done", { worker: "stop", inputs: "drop" }],
  ["a cancelled task's PR merges: nothing moves", at("cancelled", { openPrs: 1, workerLive: false }), "pr_merged", "cancelled", {}],
  ["its only PR closed unmerged, its worker gone: stalled", at("in_review", { openPrs: 1, workerLive: false }), "pr_detached", "stalled", {}],
  ["its only PR detached, its worker running: back in progress", at("in_review", pr), "pr_detached", "in_progress", {}],
  ["the last open one detached, another merged: done", at("in_review", { openPrs: 1, mergedPrs: 1 }), "pr_detached", "done", { worker: "stop" }],
  ["one of two detached: still in review", at("in_review", { openPrs: 2 }), "pr_detached", "in_review", {}],
  ["the owner marks a draft done", at("draft"), "done", "done", { worker: "stop" }],
  ["a ready one", at("ready"), "done", "done", { worker: "stop" }],
  ["a stalled one", at("stalled"), "done", "done", { worker: "stop" }],
  ...(["draft", "ready", "assigned", "in_progress", "in_review", "stalled"] as const).map((s): [string, TaskFacts, TaskEvent, TaskState, { worker?: string }] => [`cancelling a ${s} task`, at(s), "cancel", "cancelled", { worker: "stop" }]),
  ["the owner's comment with no worker: one starts again", at("in_review", { openPrs: 1, workerLive: false }), "revise", "assigned", { worker: "start", inputs: "queue" }],
  ["on a stalled task", at("stalled", pr), "revise", "assigned", { worker: "start", inputs: "queue" }],
  ["on a ready task", at("ready", pr), "revise", "assigned", { worker: "start", inputs: "queue" }],
  ["the owner's comment while its worker starts: queued", at("assigned"), "input_queued", "assigned", { inputs: "queue" }],
];

describe("the task machine's flow", () => {
  it.each(FLOW)("%s", (_why, facts, event, to, effects) => {
    const s = step(facts, event);
    if (!s.ok) throw new Error(s.error);
    expect(s.to).toBe(to);
    expect(s.effects.worker).toBe(effects.worker ?? null);
    expect(s.effects.inputs).toBe(effects.inputs ?? null);
  });

  it("refuses marking done with an open PR, whatever the state: done when it merges, or detach it first (B2)", () => {
    for (const s of ["draft", "ready", "stalled", "in_review"] as const) {
      const r = step(at(s, { openPrs: 1, workerLive: false, startOwed: false }), "done");
      expect(r, s).toEqual({ ok: false, error: expect.stringMatching(/PR is open.*merges/) });
    }
  });

  it("refuses marking done with a live worker: cancel instead", () => {
    for (const s of ["assigned", "in_progress"] as const) expect(step(at(s), "done")).toEqual({ ok: false, error: expect.stringMatching(/worker is running.*cancel/) });
  });

  it("refuses what the flow skips: an unspecced task assigned, a task that's over moved, a revise past a live worker", () => {
    expect(step(at("draft"), "assign").ok).toBe(false);
    expect(step(at("in_progress"), "started").ok).toBe(false);
    expect(step(at("done"), "cancel").ok).toBe(false);
    expect(step(at("cancelled"), "assign").ok).toBe(false);
    expect(step(at("done"), "pr_attached")).toEqual({ ok: false, error: expect.stringContaining("takes no PR") });
    expect(step(at("in_review", pr), "revise").ok).toBe(false);
    expect(step(at("in_progress"), "input_queued").ok).toBe(false);
    expect(step(at("in_review"), "pr_merged").ok).toBe(false);
    expect(step(at("stalled"), "pr_detached").ok).toBe(false);
    // Never a second worker beside a live one, whatever the state says.
    expect(step(at("stalled", { workerLive: true }), "assign").ok).toBe(false);
  });

  it("refuses every pair the flow doesn't list, for a task as each state has it", () => {
    const listed = new Set(FLOW.map(([, f, e]) => `${f.state} ${e}`));
    // Events that apply in any state, given the facts: PR events need an open PR, exits a worker.
    const anyState = new Set<TaskEvent>(["pr_attached", "pr_merged", "pr_detached", "worker_exited"]);
    for (const s of TASK_STATES) {
      for (const e of TASK_EVENTS) {
        if (listed.has(`${s} ${e}`) || anyState.has(e)) continue;
        expect(step(at(s), e).ok, `${s} ${e}`).toBe(false);
      }
    }
  });
});

// --- the random walk ------------------------------------------------------------------------------------

/** A small seeded PRNG (mulberry32), so a failure names its seed and replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What must hold of every task the machine can reach (README.md#the-task-machine). */
function invariantBroken(f: TaskFacts): string | null {
  if (f.state === "done" && f.openPrs > 0) return "done with an open PR";
  if (f.state === "done" && f.workerLive) return "done with a live worker";
  if (f.state === "in_review" && f.openPrs === 0 && !f.workerLive) return "in review with no open PR and no worker";
  if (f.state === "stalled" && f.workerLive) return "stalled with a live worker";
  if (f.queuedInputs > 0 && !f.startOwed) return "comments queued with no start owed";
  if (f.workerLive && !WORKER_STATES.has(f.state)) return `a live worker in ${f.state}`;
  if (f.startOwed !== (f.state === "assigned")) return "a start owed out of assigned, or assigned with none";
  if (f.startOwed && !f.workerLive) return "a start owed with no worker";
  if (f.openPrs < 0 || f.mergedPrs < 0 || f.queuedInputs < 0) return "a negative count";
  return null;
}

describe("a seeded random walk over the machine", () => {
  const SEEDS = 200;
  const STEPS = 200;

  it(`keeps every invariant over ${SEEDS} walks of ${STEPS} events, and reaches every state and takes every event`, () => {
    const states = new Set<TaskState>();
    const taken = new Set<TaskEvent>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const next = rng(seed);
      let f = at("draft");
      const trail: string[] = [];
      for (let i = 0; i < STEPS; i++) {
        const event = TASK_EVENTS[Math.floor(next() * TASK_EVENTS.length)]!;
        const before = { ...f };
        const s = step(f, event);
        // Pure: a refusal changes nothing, and neither does asking.
        expect(f).toEqual(before);
        if (!s.ok) continue;
        trail.push(`${f.state} --${event}--> ${s.to}`);
        // The effects agree with the facts they leave.
        if (s.effects.worker === "start") expect(s.facts.startOwed && s.facts.workerLive, `seed ${seed}: ${trail.join(", ")}`).toBe(true);
        if (s.effects.inputs === "drop" || s.effects.inputs === "flush") expect(s.facts.queuedInputs).toBe(0);
        if (s.effects.inputs === "drop") expect(f.queuedInputs).toBeGreaterThan(0);
        if (TERMINAL.has(f.state)) expect(s.to, `seed ${seed}: nothing leaves ${f.state}`).toBe(f.state);
        f = s.facts;
        expect(f.state).toBe(s.to);
        const broken = invariantBroken(f);
        if (broken) throw new Error(`seed ${seed}: ${broken} after ${trail.join(", ")}`);
        states.add(f.state);
        taken.add(event);
        // Over: start another task, so the walk keeps exploring.
        if (TERMINAL.has(f.state) && next() < 0.5) f = at("draft");
      }
    }
    expect([...states].sort()).toEqual([...TASK_STATES].sort());
    expect([...taken].sort()).toEqual([...TASK_EVENTS].sort());
  });

  it("the invariants' check sees each kind of break (so the walk isn't vacuous)", () => {
    expect(invariantBroken(at("done", { openPrs: 1 }))).toMatch(/open PR/);
    expect(invariantBroken(at("done", { workerLive: true }))).toMatch(/live worker/);
    expect(invariantBroken(at("in_review", { workerLive: false }))).toMatch(/no open PR/);
    expect(invariantBroken(at("stalled", { workerLive: true }))).toMatch(/stalled/);
    expect(invariantBroken(at("in_progress", { queuedInputs: 1 }))).toMatch(/queued/);
    expect(invariantBroken(at("ready", { workerLive: true }))).toMatch(/live worker in ready/);
    for (const s of TASK_STATES) expect(invariantBroken(at(s, s === "in_review" ? pr : {})), s).toBeNull();
  });
});
