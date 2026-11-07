// The pure parts of src/tasks.ts besides the machine (test/machine.test.ts): auto-assign's pick,
// blocking, dependencies and PRs.
import { describe, expect, it } from "vitest";
import { canBlock, canUnblock, dependencyError, pickForAssignment, prsDone, TASK_STATES, type TaskState, waitingOn } from "../src/tasks";

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

// README.md#blocked: a flag, not a state. The manager may block any task that isn't over; a worker only
// its own task while its worker is live; a blocked task isn't blocked twice, and only a blocked one clears.
describe("blocking", () => {
  const LIVE: Record<TaskState, boolean> = { draft: false, ready: false, assigned: true, in_progress: true, in_review: true, stalled: false, done: false, cancelled: false };
  const OVER: Record<TaskState, boolean> = { draft: false, ready: false, assigned: false, in_progress: false, in_review: false, stalled: false, done: true, cancelled: true };

  it.each(TASK_STATES)("%s: who may block it", (state) => {
    expect(canBlock(state, false, "manager").ok, "manager").toBe(!OVER[state]);
    expect(canBlock(state, false, "worker").ok, "worker").toBe(LIVE[state]);
    expect(canBlock(state, true, "manager").ok, "already blocked").toBe(false);
  });

  it("clears only a blocked task", () => {
    expect(canUnblock(true).ok).toBe(true);
    expect(canUnblock(false)).toEqual({ ok: false, error: "the task isn't blocked" });
  });

  it("auto-assign skips a blocked ready task, and takes the next", () => {
    const tasks = [
      { id: "a", state: "ready" as const, ord: 1, blocked: true },
      { id: "b", state: "ready" as const, ord: 2 },
      { id: "c", state: "ready" as const, ord: 3 },
    ];
    expect(pickForAssignment(tasks, 0, 1)).toEqual(["b"]);
  });
});

// README.md#dependencies: a dependency is within the project, never on itself, and never closes a cycle
// (refused with the cycle's path); only a done blocker releases the task waiting on it.
describe("dependencies", () => {
  const states = (o: Record<string, TaskState>) => new Map(Object.entries(o));
  const all = states({ a: "ready", b: "ready", c: "ready", d: "ready", over: "done" });

  it("refuses a self-reference, an unknown (another project's) task, and a task that's over", () => {
    expect(dependencyError("a", "a", [], all)).toBe("a task can't wait on itself");
    expect(dependencyError("a", "tsk_elsewhere", [], all)).toMatch(/unknown task tsk_elsewhere: a dependency is within the project/);
    expect(dependencyError("over", "a", [], all)).toBe("a done task waits on nothing");
    expect(dependencyError("a", "over", [], all)).toBeNull();
  });

  it("refuses a cycle with its path, however long, and allows a diamond", () => {
    // a waits on b, b on c: c waiting on a closes a → b → c → a.
    const chain = [["a", "b"], ["b", "c"]] as const;
    expect(dependencyError("c", "a", chain, all)).toBe("it would make a cycle: c → a → b → c");
    expect(dependencyError("b", "a", [["a", "b"]], all)).toBe("it would make a cycle: b → a → b");
    // a on b and c, both on d: no cycle.
    expect(dependencyError("c", "d", [["a", "b"], ["a", "c"], ["b", "d"]], all)).toBeNull();
    expect(dependencyError("a", "b", [["a", "b"]], all)).toBe("a already waits on b");
  });

  it("waits until every blocker is done; a cancelled one still holds it", () => {
    expect(waitingOn([{ id: "x", state: "done" }, { id: "y", state: "in_review" }, { id: "z", state: "cancelled" }])).toEqual(["y", "z"]);
    expect(waitingOn([{ id: "x", state: "done" }])).toEqual([]);
  });

  it("auto-assign skips a waiting task", () => {
    expect(pickForAssignment([{ id: "a", state: "ready", ord: 1, waiting: true }, { id: "b", state: "ready", ord: 2 }], 0, 1)).toEqual(["b"]);
  });
});

// README.md#prs: done once at least one PR is attached and every attached one has merged.
describe("a task's PRs", () => {
  it("are done only when all attached ones merged, a detached one not counting", () => {
    expect(prsDone([])).toBe(false);
    expect(prsDone([{ state: "merged" }, { state: "open" }])).toBe(false);
    expect(prsDone([{ state: "merged" }, { state: "merged" }])).toBe(true);
    expect(prsDone([{ state: "merged" }, { state: "detached" }])).toBe(true);
    expect(prsDone([{ state: "detached" }])).toBe(false);
  });
});
