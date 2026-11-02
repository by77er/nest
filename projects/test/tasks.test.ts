// The task state machine (src/tasks.ts) against README.md#flows, which is the oracle: each row below is
// a sentence of that flow, and every (state, event) pair not listed must be refused.
import { describe, expect, it } from "vitest";
import { pickForAssignment, TASK_EVENTS, TASK_STATES, type TaskEvent, type TaskState, transition } from "../src/tasks";

/** README.md#flows, as (from, event) → to. */
const FLOW: [TaskState, TaskEvent, TaskState][] = [
  ["draft", "spec", "ready"], // 2. the manager specs it
  ["ready", "spec", "ready"], // a ready task is re-specced
  ["ready", "assign", "assigned"], // 3. it's assigned
  ["stalled", "assign", "assigned"], // a stalled task is reassigned
  ["assigned", "started", "in_progress"], // 4. the app starts a worker
  ["assigned", "start_failed", "stalled"], // nest refused the worker for good
  ["in_progress", "pr_opened", "in_review"], // 5. the worker opens a PR
  ["in_review", "pr_opened", "in_review"], // the same PR reported again
  ["assigned", "worker_exited", "stalled"], // a worker that exits before opening a PR
  ["in_progress", "worker_exited", "stalled"],
  ["in_review", "merged", "done"], // 6. the PR is merged
  // The owner marks it done: only a task with no PR and no live worker.
  ...(["draft", "ready", "stalled"] as const).map((s): [TaskState, TaskEvent, TaskState] => [s, "done", "done"]),
  // Cancelling: anything not over.
  ...(["draft", "ready", "assigned", "in_progress", "in_review", "stalled"] as const).map((s): [TaskState, TaskEvent, TaskState] => [s, "cancel", "cancelled"]),
];

describe("the task state machine", () => {
  it.each(FLOW)("%s --%s--> %s", (from, event, to) => {
    expect(transition(from, event)).toEqual({ ok: true, to });
  });

  it("refuses every other move, so a skipped step (an unspecced task assigned, a done task reopened) can't happen", () => {
    const allowed = new Set(FLOW.map(([f, e]) => `${f} ${e}`));
    const refused = TASK_STATES.flatMap((s) => TASK_EVENTS.map((e) => [s, e] as const)).filter(([s, e]) => !allowed.has(`${s} ${e}`));
    expect(refused.length).toBeGreaterThan(40);
    for (const [s, e] of refused) expect(transition(s, e).ok, `${s} ${e}`).toBe(false);
    // The cases the flow most needs refused, named.
    expect(transition("draft", "assign").ok).toBe(false);
    expect(transition("in_review", "worker_exited").ok).toBe(false);
    expect(transition("done", "cancel").ok).toBe(false);
    expect(transition("cancelled", "assign").ok).toBe(false);
  });

  it("refuses marking done by hand past the merge gate: an open PR waits for its merge, a running worker is cancelled", () => {
    expect(transition("in_review", "done")).toEqual({ ok: false, error: expect.stringMatching(/PR is open.*merges/) });
    for (const s of ["assigned", "in_progress"] as const) expect(transition(s, "done")).toEqual({ ok: false, error: expect.stringMatching(/worker is running.*cancel/) });
  });
});

describe("auto-assign's pick", () => {
  const tasks = [
    { id: "c", state: "ready" as const, ord: 3 },
    { id: "a", state: "ready" as const, ord: 1 },
    { id: "x", state: "draft" as const, ord: 0 },
    { id: "b", state: "ready" as const, ord: 2 },
    { id: "s", state: "stalled" as const, ord: 0.5 },
  ];

  it("takes ready tasks in board order, only while live workers are under the cap", () => {
    expect(pickForAssignment(tasks, 0, 2)).toEqual(["a", "b"]);
    expect(pickForAssignment(tasks, 1, 2)).toEqual(["a"]);
    expect(pickForAssignment(tasks, 2, 2)).toEqual([]);
    expect(pickForAssignment(tasks, 5, 2)).toEqual([]);
    expect(pickForAssignment(tasks, 0, 10)).toEqual(["a", "b", "c"]);
  });
});
