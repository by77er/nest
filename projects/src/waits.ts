// The manager's waits (README.md#waiting): `await_task`, `await_pr` and `await_reply` on /mcp/board. A
// wait is the app's, whole: ProjectDO holds it with its deadline, watches for its condition in the steps
// that change what it watches (a task's state, a PR's events, a review's end, the owner's replies), and
// in that same step resolves it once (met, ended or timed out) and owes the manager one inbox message.
// Pure: the shapes, the checks, and the messages.

import type { TaskState } from "./tasks";

export type WaitKind = "task" | "pr" | "reply";
export type PrUntil = "merged" | "review_done" | "closed";
/** How a wait ended: its condition held, what it watched ended first, its timeout passed, or the manager dropped it. */
export type WaitOutcome = "met" | "ended" | "timed_out" | "cancelled";

/** A timeout: 10 s to 30 days, as nest's timers take. */
export const MIN_TIMEOUT_S = 10;
export const MAX_TIMEOUT_S = 30 * 24 * 3600;
/** Pending waits a project holds at once. */
export const MAX_WAITS = 32;

export interface Wait {
  id: string;
  kind: WaitKind;
  /** The task's id, or the PR's number; null for a reply. */
  target: string | null;
  /** A task's states to wait for, or a PR's condition. */
  want: TaskState[] | PrUntil | null;
  created_ms: number;
  deadline_ms: number;
  resolved_ms: number | null;
  outcome: WaitOutcome | null;
  /** What resolved it, in a few words (the message's gist). */
  detail: string | null;
}

/** The dedup key of a pending wait: the same kind, target and condition is the same wait. */
export function waitKey(kind: WaitKind, target: string | null, want: Wait["want"]): string {
  const w = Array.isArray(want) ? [...new Set(want)].sort().join(",") : want ?? "";
  return `${kind}:${target ?? ""}:${w}`;
}

/** A timeout's problem, or null. */
export function timeoutProblem(s: unknown): string | null {
  if (typeof s !== "number" || !Number.isInteger(s)) return "timeout_s must be a whole number of seconds";
  if (s < MIN_TIMEOUT_S || s > MAX_TIMEOUT_S) return `timeout_s must be ${MIN_TIMEOUT_S} s to 30 days (${MAX_TIMEOUT_S} s)`;
  return null;
}

/** A duration, roughly, for a person: "45 s", "12 min", "3 h", "2 d". */
export function human(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** What a wait waits for, as the Manager page shows it: "#12 to merge", "tsk_… to be in_review". */
export function describe(w: Pick<Wait, "kind" | "target" | "want">): string {
  if (w.kind === "task") return `${w.target} to be ${(w.want as TaskState[]).join(" or ")}`;
  if (w.kind === "pr") {
    const u = w.want as PrUntil;
    return `#${w.target} ${u === "merged" ? "to merge" : u === "closed" ? "to close" : "to finish its review"}`;
  }
  return "the owner's reply";
}

/** The manager's message for a wait's end. App-authored, with ids and states only (no agent's text). */
export function waitMessage(w: Pick<Wait, "id" | "kind" | "target" | "want" | "created_ms">, outcome: WaitOutcome, detail: string, now: number): string {
  const what = w.kind === "task" ? `task ${w.target}` : w.kind === "pr" ? `PR #${w.target}` : "the owner";
  switch (outcome) {
    case "met":
      return `await ${w.id}: ${what}: ${detail}.`;
    case "ended":
      return `await ${w.id} ended without its condition: ${what}: ${detail}. It was waiting for ${describe(w)}.`;
    case "timed_out":
      return `await ${w.id} timed out after ${human(now - w.created_ms)}, still waiting for ${describe(w)}.`;
    case "cancelled":
      return `await ${w.id}: cancelled.`;
  }
}

/** A task wait's verdict on a task now in `state`: met, ended (terminal, not wanted), or still pending. */
export function taskVerdict(want: readonly TaskState[], state: TaskState, terminal: ReadonlySet<TaskState>): { outcome: "met" | "ended"; detail: string } | null {
  if (want.includes(state)) return { outcome: "met", detail: `now ${state}` };
  if (terminal.has(state)) return { outcome: "ended", detail: `ended ${state}` };
  return null;
}

/** A PR wait's verdict on one of its PR's events. */
export function prVerdict(until: PrUntil, e: { kind: "merged" } | { kind: "closed" } | { kind: "review"; conclusion: string }): { outcome: "met" | "ended"; detail: string } | null {
  switch (e.kind) {
    case "merged":
      if (until === "merged") return { outcome: "met", detail: "merged" };
      if (until === "closed") return { outcome: "met", detail: "closed (merged)" };
      return { outcome: "ended", detail: "merged before its review finished" };
    case "closed":
      if (until === "closed") return { outcome: "met", detail: "closed without merging" };
      return { outcome: "ended", detail: "closed without merging" };
    case "review":
      return until === "review_done" ? { outcome: "met", detail: `its review is done (${e.conclusion})` } : null;
  }
}
