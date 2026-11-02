// A task's states and the moves between them (README.md#flows): pure, so the board, the MCP tools and
// nest's events all go through one function, and its table is tested on its own (test/tasks.test.ts).

export const TASK_STATES = ["draft", "ready", "assigned", "in_progress", "in_review", "stalled", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * What can happen to a task:
 * - `spec`: the manager wrote its spec (a draft becomes ready; a ready one, or one with a live worker,
 *   is re-specced, and that worker is told);
 * - `assign`: by the owner, the manager or auto-assign; a worker is to be started for it;
 * - `started`: its worker exists and has its first input;
 * - `start_failed`: nest refused the worker for good (a stalled task is reassigned by hand);
 * - `pr_opened`: its worker reported its PR;
 * - `worker_exited`: its worker ended (nest's `agent.exited`);
 * - `merged`: its PR was merged (GitHub's event; the review PR);
 * - `done`: the owner marked it done: only a task with no PR and no live worker (a draft, a ready task,
 *   a stalled one). A task with an open PR is done when it merges (`merged`); one with a worker is
 *   cancelled instead;
 * - `cancel`: the owner or the manager cancelled it; its worker is stopped.
 */
export const TASK_EVENTS = ["spec", "assign", "started", "start_failed", "pr_opened", "worker_exited", "merged", "done", "cancel"] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

export const TERMINAL: ReadonlySet<TaskState> = new Set(["done", "cancelled"]);

/** The states each event moves from, and where to. Anything not listed is refused. */
const MOVES: Record<TaskEvent, Partial<Record<TaskState, TaskState>>> = {
  // A task with a live worker may be re-specced too: its worker is told (README.md#task-changes).
  spec: { draft: "ready", ready: "ready", assigned: "assigned", in_progress: "in_progress", in_review: "in_review" },
  assign: { ready: "assigned", stalled: "assigned" },
  started: { assigned: "in_progress" },
  start_failed: { assigned: "stalled" },
  pr_opened: { in_progress: "in_review", in_review: "in_review" },
  worker_exited: { assigned: "stalled", in_progress: "stalled" },
  merged: { in_review: "done" },
  done: { draft: "done", ready: "done", stalled: "done" },
  cancel: { draft: "cancelled", ready: "cancelled", assigned: "cancelled", in_progress: "cancelled", in_review: "cancelled", stalled: "cancelled" },
};

export type Transition = { ok: true; to: TaskState } | { ok: false; error: string };

/** Why the owner can't mark a task done where the reason isn't obvious from its state's name. */
const NOT_DONE: Partial<Record<TaskState, string>> = {
  in_review: "its PR is open: the task is done when the PR merges",
  assigned: "its worker is running: cancel the task instead",
  in_progress: "its worker is running: cancel the task instead",
};

/** Where `event` takes a task in `from`, or why it can't. */
export function transition(from: TaskState, event: TaskEvent): Transition {
  const to = MOVES[event][from];
  if (to) return { ok: true, to };
  const why = event === "done" ? NOT_DONE[from] : undefined;
  return { ok: false, error: `a ${from.replace("_", " ")} task can't take ${event.replace("_", " ")}${why ? `: ${why}` : ""}` };
}

/** States in which a task's worker, if it has one, is expected to be running. */
export const WORKER_STATES: ReadonlySet<TaskState> = new Set(["assigned", "in_progress", "in_review"]);

/**
 * Auto-assign (README.md#flows): the `ready` tasks to assign now, in board order, while the project's
 * live workers stay under `maxWorkers`. A blocked task waits for its block to clear.
 */
export function pickForAssignment(tasks: readonly { id: string; state: TaskState; ord: number; blocked?: boolean }[], liveWorkers: number, maxWorkers: number): string[] {
  const room = Math.max(0, maxWorkers - liveWorkers);
  return tasks.filter((t) => t.state === "ready" && !t.blocked).sort((a, b) => a.ord - b.ord).slice(0, room).map((t) => t.id);
}

/**
 * Blocked is a flag on a task, not a state (README.md#blocked): a task keeps its state, worker and PR
 * while it waits on the owner, and goes on from there once unblocked. Who may set it, and on what:
 * - the manager, on any task that isn't over;
 * - a worker, on its own task while its worker is live (`WORKER_STATES`).
 * A blocked task can't be blocked again (clear it first), and a task that ends drops its block.
 */
export function canBlock(state: TaskState, blocked: boolean, by: "manager" | "worker"): { ok: true } | { ok: false; error: string } {
  if (TERMINAL.has(state)) return { ok: false, error: `a ${state} task can't be blocked` };
  if (by === "worker" && !WORKER_STATES.has(state)) return { ok: false, error: `a ${state.replace("_", " ")} task has no live worker to block it` };
  if (blocked) return { ok: false, error: "the task is already blocked" };
  return { ok: true };
}

/** Clearing a block (the owner's answer, the manager, or the worker that holds the task). */
export function canUnblock(blocked: boolean): { ok: true } | { ok: false; error: string } {
  return blocked ? { ok: true } : { ok: false, error: "the task isn't blocked" };
}

/** A task's spec, as the manager writes it. */
export interface Spec {
  goal: string;
  acceptance_criteria: string[];
  files: string[];
  test_plan: string;
}

/** The branch a task's worker pushes, which maps its PR back to the task. */
export const taskBranch = (task: string) => `task/${task}`;
