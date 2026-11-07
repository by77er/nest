// A review job's state machine (README.md#built-the-review-pipeline), as one pure table: every change of a
// job's `state` in ReviewDO goes through `jobTransition`. Pure.
//
//   queued ──start──▶ running ──verdict──▶ done
//     │                │  ├──retry (an exit or a deadline, attempts left)──▶ running (a new reviewer)
//     │                │  ├──give_up (an exit or a deadline, none left)────▶ failed
//     │                │  └──refused (GitHub or nest, for good)────────────▶ failed
//     └──superseded / closed (a newer head, the PR closed)──────────────────▶ superseded / closed
//   done, failed, superseded, closed ──requeue (rerequested, head back, reopened)──▶ queued
//
// While running, a job advances through its check run, its reviewer and the reviewer's brief (columns,
// not states), and always has a deadline: a run that neither submits nor exits by then is an attempt
// spent, like an exit without a verdict. So a running job always has a timed way out.

export type JobState = "queued" | "running" | "done" | "failed" | "superseded" | "closed";
export const JOB_STATES: readonly JobState[] = ["queued", "running", "done", "failed", "superseded", "closed"];

export type JobEvent = "start" | "verdict" | "retry" | "give_up" | "refused" | "superseded" | "closed" | "requeue";
export const JOB_EVENTS: readonly JobEvent[] = ["start", "verdict", "retry", "give_up", "refused", "superseded", "closed", "requeue"];

/** The ends a job can reach: each owes its check's completion (once) and its reviewer's stop. */
export const JOB_ENDS: ReadonlySet<JobState> = new Set(["done", "failed", "superseded", "closed"]);

const TABLE: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
  queued: { start: "running", superseded: "superseded", closed: "closed" },
  running: { verdict: "done", retry: "running", give_up: "failed", refused: "failed", superseded: "superseded", closed: "closed" },
  done: { requeue: "queued" },
  failed: { requeue: "queued" },
  superseded: { requeue: "queued" },
  closed: { requeue: "queued" },
};

export function jobTransition(from: JobState, event: JobEvent): { ok: true; to: JobState } | { ok: false; error: string } {
  const to = TABLE[from][event];
  return to ? { ok: true, to } : { ok: false, error: `a ${from} review can't ${event}` };
}

/** How long one reviewer has to submit its verdict before the run counts as an attempt spent. */
export const REVIEW_DEADLINE_MS = 60 * 60_000;
