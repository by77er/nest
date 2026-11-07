// A task's states and the moves between them (README.md#flows): pure, so the board, the MCP tools and
// nest's events all go through one function, and its table is tested on its own (test/tasks.test.ts).

export const TASK_STATES = ["draft", "ready", "assigned", "in_progress", "in_review", "stalled", "done", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * What can happen to a task (README.md#the-task-machine). Each moves its state, its worker and its queued
 * inputs together, through `step`:
 * - `spec`: the manager wrote its spec (a draft becomes ready; a ready one, or one with a live worker,
 *   is re-specced, and that worker is told);
 * - `assign`: by the owner, the manager or auto-assign; a worker is owed (started from the alarm);
 * - `started`: its worker exists and has its brief; the comments queued for it follow;
 * - `start_failed`: nest refused the worker for good (a stalled task is reassigned by hand);
 * - `start_abandoned`: a start in flight is begun again (a setting it was frozen with changed);
 * - `worker_exited`: its worker ended (nest's `agent.exited`, or a stop the app owed went through);
 * - `pr_attached`: a PR was attached (its worker's report, its branch, the owner's or the manager's);
 * - `pr_merged`: one of its open attached PRs merged; the last one makes it done;
 * - `pr_detached`: one of its open attached PRs closed without merging, or was detached;
 * - `done`: the owner marked it done: only a task with no open PR and no live worker;
 * - `cancel`: the owner or the manager cancelled it; its worker is stopped;
 * - `revise`: the owner commented on its PR while no worker runs for it (README.md#pr-comments): a
 *   worker is started again, the comment its first input after its brief;
 * - `input_queued`: the owner commented on its PR while its worker is starting: the comment waits for
 *   the brief.
 */
export const TASK_EVENTS = [
  "spec", "assign", "started", "start_failed", "start_abandoned", "worker_exited", "pr_attached", "pr_merged", "pr_detached", "done", "cancel", "revise", "input_queued",
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

export const TERMINAL: ReadonlySet<TaskState> = new Set(["done", "cancelled"]);

/**
 * The facts about a task the machine moves together. `workerLive`: a worker of its own is starting or
 * running (one the app is stopping, for a task that's over, isn't its own any more). `startOwed`: that
 * worker hasn't had its brief yet. `queuedInputs`: the owner's comments waiting for that brief.
 */
export interface TaskFacts {
  state: TaskState;
  openPrs: number;
  mergedPrs: number;
  workerLive: boolean;
  startOwed: boolean;
  queuedInputs: number;
}

/**
 * What a step does besides the state, for ProjectDO to write in the same step:
 * - `worker`: `start` owes a new start (a new generation of its worker); `started` ends the start;
 *   `failed` ends it with no worker; `exited` frees the worker's place; `stop` owes a stop of whatever
 *   worker it had;
 * - `inputs`: `queue` keeps the comment for the brief; `flush` sends the queued ones after it; `drop`
 *   drops them (recorded);
 * - `record`: the history action for the task's move, or null when the step moves nothing worth a line
 *   of its own (the caller records the PR's event).
 */
export interface StepEffects {
  worker: "start" | "started" | "failed" | "exited" | "stop" | null;
  inputs: "queue" | "flush" | "drop" | null;
  record: string | null;
}

export type Step = { ok: true; to: TaskState; facts: TaskFacts; effects: StepEffects } | { ok: false; error: string };

const label = (s: TaskState) => s.replace("_", " ");
const refuse = (f: TaskFacts, event: TaskEvent, why?: string): Step => ({ ok: false, error: `a ${label(f.state)} task can't take ${event.replace("_", " ")}${why ? `: ${why}` : ""}` });
const go = (f: TaskFacts, to: TaskState, change: Partial<TaskFacts>, effects: Partial<StepEffects>): Step => ({
  ok: true, to, facts: { ...f, ...change, state: to }, effects: { worker: null, inputs: null, record: null, ...effects },
});
const among = (s: TaskState, ...states: TaskState[]) => states.includes(s);

/**
 * The one machine (README.md#the-task-machine): where `event` takes a task, and what moves with it, or
 * why it can't. Pure; ProjectDO applies it and nothing else writes a task's state, worker or queued inputs.
 * Its invariants (test/machine.test.ts walks it at random): a task that's `done` has no open PR and no
 * worker of its own; `in_review` has an open PR or a live worker; `stalled` has no live worker; queued
 * inputs exist only while a start is owed; a live worker only in `assigned`, `in_progress`, `in_review`.
 */
export function step(f: TaskFacts, event: TaskEvent): Step {
  const s = f.state;
  const over = TERMINAL.has(s);
  // A worker of its own that's being stopped for good also takes its queued inputs with it.
  const ending = { worker: "stop" as const, inputs: f.queuedInputs > 0 ? ("drop" as const) : null };
  const workerGone = { workerLive: false, startOwed: false, queuedInputs: 0 };
  switch (event) {
    case "spec":
      if (s === "draft") return go(f, "ready", {}, { record: "spec" });
      if (among(s, "ready", "assigned", "in_progress", "in_review")) return go(f, s, {}, { record: "spec" });
      return refuse(f, event);
    case "assign":
      if (!among(s, "ready", "stalled") || f.workerLive) return refuse(f, event);
      return go(f, "assigned", { workerLive: true, startOwed: true, queuedInputs: 0 }, { worker: "start", record: "assign" });
    case "started":
      if (s !== "assigned" || !f.startOwed) return refuse(f, event);
      // A task that holds an open PR (attached while it waited, or the one a comment revised) is in review.
      return go(f, f.openPrs > 0 ? "in_review" : "in_progress", { startOwed: false, queuedInputs: 0 }, { worker: "started", inputs: "flush", record: "started" });
    case "start_failed":
      if (s !== "assigned") return refuse(f, event);
      return go(f, "stalled", workerGone, { worker: "failed", inputs: f.queuedInputs > 0 ? "drop" : null, record: "start_failed" });
    case "start_abandoned":
      if (s !== "assigned" || !f.startOwed) return refuse(f, event);
      return go(f, "assigned", {}, { worker: "start", record: null });
    case "worker_exited": {
      // Not its own any more (being stopped, or already gone): only its place frees.
      if (!f.workerLive) return go(f, s, {}, { worker: "exited" });
      const inputs = f.queuedInputs > 0 ? ("drop" as const) : null;
      // An open PR keeps it in review: it's done when the PR merges, or revised by a comment.
      if (s === "in_review" && f.openPrs > 0) return go(f, s, workerGone, { worker: "exited", inputs });
      return go(f, "stalled", workerGone, { worker: "exited", inputs, record: "worker_exited" });
    }
    case "pr_attached":
      if (over) return refuse(f, event, "a task that's over takes no PR");
      if (s === "in_progress") return go(f, "in_review", { openPrs: f.openPrs + 1 }, { record: "pr_opened" });
      return go(f, s, { openPrs: f.openPrs + 1 }, { record: "pr_attached" });
    case "pr_merged":
    case "pr_detached": {
      if (f.openPrs === 0) return refuse(f, event, "it has no open PR");
      const merged = f.mergedPrs + (event === "pr_merged" ? 1 : 0);
      const change = { openPrs: f.openPrs - 1, mergedPrs: merged };
      if (over || f.openPrs > 1) return go(f, s, change, {});
      // The last open one: done if any merged (README.md#prs), else out of review.
      if (merged > 0) return go(f, "done", { ...change, ...workerGone }, { ...ending, record: "merged" });
      if (s === "in_review") return go(f, f.workerLive ? "in_progress" : "stalled", change, { record: "review_ended" });
      return go(f, s, change, {});
    }
    case "done":
      if (f.openPrs > 0) return refuse(f, event, "its PR is open: the task is done when it merges (or detach it first)");
      if (f.workerLive) return refuse(f, event, "its worker is running: cancel the task instead");
      if (!among(s, "draft", "ready", "stalled")) return refuse(f, event);
      return go(f, "done", workerGone, { ...ending, record: "done" });
    case "cancel":
      if (over) return refuse(f, event);
      return go(f, "cancelled", workerGone, { ...ending, record: "cancel" });
    case "revise":
      if (f.workerLive) return refuse(f, event, "its worker is running: the comment goes to it");
      if (!among(s, "ready", "in_review", "stalled")) return refuse(f, event);
      return go(f, "assigned", { workerLive: true, startOwed: true, queuedInputs: 1 }, { worker: "start", inputs: "queue", record: "revise" });
    case "input_queued":
      if (!f.startOwed) return refuse(f, event, "no worker is starting for it");
      return go(f, s, { queuedInputs: f.queuedInputs + 1 }, { inputs: "queue" });
  }
}

/** The facts of a task as the API shows it (the UI's view): its queued inputs aren't shown, and don't matter to the owner's moves. */
export function factsOf(t: { state: TaskState; prs: readonly { state: "open" | "merged" }[]; worker_live: boolean }): TaskFacts {
  return {
    state: t.state, openPrs: t.prs.filter((p) => p.state === "open").length, mergedPrs: t.prs.filter((p) => p.state === "merged").length,
    workerLive: t.worker_live, startOwed: t.worker_live && t.state === "assigned", queuedInputs: 0,
  };
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
