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
 * - `merged`: the last of its attached PRs merged (GitHub's event; README.md#prs), from any state not
 *   over: a PR may be attached to a task with no worker;
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
  merged: { draft: "done", ready: "done", assigned: "done", in_progress: "done", in_review: "done", stalled: "done" },
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
 * live workers stay under `maxWorkers`. A blocked task waits for its block to clear, and one waiting on
 * other tasks (its dependencies, README.md#dependencies) until they're done.
 */
export function pickForAssignment(tasks: readonly { id: string; state: TaskState; ord: number; blocked?: boolean; waiting?: boolean }[], liveWorkers: number, maxWorkers: number): string[] {
  const room = Math.max(0, maxWorkers - liveWorkers);
  return tasks.filter((t) => t.state === "ready" && !t.blocked && !t.waiting).sort((a, b) => a.ord - b.ord).slice(0, room).map((t) => t.id);
}

// --- dependencies (README.md#dependencies) -------------------------------------------------------------

/** A dependency: `task` is blocked by (waits on) `blocker`. */
export type Dependency = readonly [task: string, blocker: string];

/**
 * Why `task` can't be made to wait on `blocker`, or null when it can. `tasks` is the project's own tasks
 * and their states, so another project's task (or a made-up id) is unknown here. A task that's over
 * waits on nothing. A dependency that would close a cycle is refused with the cycle's path, e.g.
 * `tsk_a → tsk_b → tsk_c → tsk_a`.
 */
export function dependencyError(task: string, blocker: string, edges: readonly Dependency[], tasks: ReadonlyMap<string, TaskState>): string | null {
  if (task === blocker) return "a task can't wait on itself";
  if (!tasks.has(task)) return `unknown task ${task}`;
  if (!tasks.has(blocker)) return `unknown task ${blocker}: a dependency is within the project`;
  if (TERMINAL.has(tasks.get(task)!)) return `a ${tasks.get(task)} task waits on nothing`;
  if (edges.some(([t, b]) => t === task && b === blocker)) return `${task} already waits on ${blocker}`;
  // A path blocker → … → task over "waits on" would make task wait on itself.
  const waitsOn = new Map<string, string[]>();
  for (const [t, b] of edges) waitsOn.set(t, [...(waitsOn.get(t) ?? []), b]);
  const path = findPath(blocker, task, waitsOn);
  return path ? `it would make a cycle: ${[task, ...path].join(" → ")}` : null;
}

/** A path from `from` to `to` over `next`, depth first, or null. */
function findPath(from: string, to: string, next: ReadonlyMap<string, readonly string[]>): string[] | null {
  const seen = new Set<string>();
  const walk = (at: string): string[] | null => {
    if (at === to) return [at];
    if (seen.has(at)) return null;
    seen.add(at);
    for (const n of next.get(at) ?? []) {
      const rest = walk(n);
      if (rest) return [at, ...rest];
    }
    return null;
  };
  return walk(from);
}

/**
 * The blockers a task still waits on: every one not `done`. A cancelled blocker still holds it, since
 * the work it waited for won't happen; the owner or the manager decides, by removing the dependency.
 */
export function waitingOn(blockers: readonly { id: string; state: TaskState }[]): string[] {
  return blockers.filter((b) => b.state !== "done").map((b) => b.id);
}

// --- PRs (README.md#prs) ---------------------------------------------------------------------------

export type PrState = "open" | "merged" | "detached";

/**
 * Whether a task's PRs make it done: at least one attached, and every attached one merged. A PR closed
 * without merging is detached, so it neither holds the task nor counts.
 */
export function prsDone(prs: readonly { state: PrState }[]): boolean {
  const attached = prs.filter((p) => p.state !== "detached");
  return attached.length > 0 && attached.every((p) => p.state === "merged");
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
