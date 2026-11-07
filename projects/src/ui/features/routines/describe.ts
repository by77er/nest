// Routines in words (README.md#routines): their triggers, where each stands, and how each run went. Pure.

import type { Created, Routine, RoutineRun, Timer, Triggers } from "../../api/types";
import type { Role } from "../../theme";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Every 15 minutes", "Every 2 hours", "Daily at 03:00 (UTC)", "Mondays at 09:00 (Europe/London)". */
export function timerText(t: Timer): string {
  if (t.kind === "interval") {
    if (t.minutes % 1440 === 0) return t.minutes === 1440 ? "Every day" : `Every ${plural(t.minutes / 1440, "day")}`;
    if (t.minutes % 60 === 0) return t.minutes === 60 ? "Every hour" : `Every ${plural(t.minutes / 60, "hour")}`;
    return `Every ${plural(t.minutes, "minute")}`;
  }
  const zone = `(${t.tz.replace(/_/g, " ")})`;
  return t.kind === "daily" ? `Daily at ${t.time} ${zone}` : `${WEEKDAYS[t.day]}s at ${t.time} ${zone}`;
}

/** Each trigger as a phrase, the timer first; a routine with none runs only by hand. */
export function triggerPhrases(t: Triggers): string[] {
  const out: string[] = [];
  if (t.timer) out.push(timerText(t.timer));
  if (t.prs_merged !== null) out.push(`Every ${plural(t.prs_merged, "task PR")} merged`);
  if (t.tasks_done !== null) out.push(`Every ${plural(t.tasks_done, "task")} done`);
  return out.length ? out : ["Only when run by hand"];
}

/** The counters' progress since the last run: "3 of 5 PRs merged". */
export function counterProgress(r: Pick<Routine, "triggers" | "counts">): string[] {
  const out: string[] = [];
  if (r.triggers.prs_merged !== null) out.push(`${r.counts.prs_merged} of ${r.triggers.prs_merged} PRs merged`);
  if (r.triggers.tasks_done !== null) out.push(`${r.counts.tasks_done} of ${r.triggers.tasks_done} tasks done`);
  return out;
}

export interface Status {
  label: string;
  color: Role;
}

/** Where a routine stands: running, queued (for its run, its cooldown or the project's cap), off; null when it's simply waiting for a trigger. */
export function routineStatus(r: Pick<Routine, "enabled" | "live_run" | "due" | "waiting">): Status | null {
  if (r.live_run) return r.live_run.state === "starting" ? { label: "Starting", color: "primary" } : { label: "Running", color: "primary" };
  if (r.due && r.waiting === "cooldown") return { label: "Cooling down", color: "gray" };
  if (r.due) return { label: "Queued", color: "gray" };
  if (!r.enabled) return { label: "Off", color: "gray" };
  return null;
}

/** Why a queued routine hasn't started, in a sentence. */
export function waitingText(r: Pick<Routine, "waiting" | "cooldown_until_ms">, cap: number, at: (ms: number) => string): string | null {
  if (r.waiting === "cap") return `Waiting for a free place: ${plural(cap, "routine run")} at a time across the project.`;
  if (r.waiting === "cooldown" && r.cooldown_until_ms !== null) return `Its cooldown ends ${at(r.cooldown_until_ms)}.`;
  if (r.waiting === "running") return "Its next run starts when this one ends.";
  return null;
}

/** A run's state, or how it ended. */
export function runStatus(run: Pick<RoutineRun, "state" | "outcome">): Status {
  if (run.state === "starting") return { label: "Starting", color: "primary" };
  if (run.state === "running") return { label: "Running", color: "primary" };
  switch (run.outcome) {
    case "done":
      return { label: "Done", color: "success" };
    case "failed":
      return { label: "Failed", color: "danger" };
    case "timed_out":
      return { label: "Timed out", color: "warning" };
    default:
      return { label: "Stopped", color: "gray" };
  }
}

/** Why a run started: "Timer", "5 PRs merged", "10 tasks done", "Run now". */
export function runTrigger(run: Pick<RoutineRun, "trigger" | "count">): string {
  switch (run.trigger) {
    case "timer":
      return "Timer";
    case "prs_merged":
      return `${plural(run.count ?? 0, "PR")} merged`;
    case "tasks_done":
      return `${plural(run.count ?? 0, "task")} done`;
    default:
      return "Run now";
  }
}

/** What a run made: "2 proposed tasks, 1 note written". */
export function createdText(created: readonly Created[]): string {
  const n = (k: Created["kind"]) => created.filter((c) => c.kind === k).length;
  const parts = [
    n("proposal") && plural(n("proposal"), "proposed task"),
    n("task") && plural(n("task"), "draft task"),
    n("memory_write") && plural(n("memory_write"), "note written", "notes written"),
    n("memory_delete") && plural(n("memory_delete"), "note deleted", "notes deleted"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Nothing";
}

/** How long a run took (or has taken): "4 min", "1 h 5 min", "under a minute". */
export function duration(run: Pick<RoutineRun, "started_ms" | "ended_ms" | "queued_ms">, now = Date.now()): string {
  const from = run.started_ms ?? run.queued_ms;
  const m = Math.floor(((run.ended_ms ?? now) - from) / 60_000);
  if (m < 1) return "under a minute";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
