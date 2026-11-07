// How long the app keeps rows that only record what happened (README.md#retention): terminal rows of
// history-like tables, pruned by age. What the page or an audit reads stays: a task's history, the chat,
// the memory, issues (their rows keep an import from bringing a declined issue back), a PR's current
// head's review job, and anything still live or owed.

const DAY = 24 * 3600_000;

/** Ended review jobs, other than an open PR's head's. */
export const REVIEW_JOBS_KEEP_MS = 30 * DAY;
/** nest's error events about the project's agents (the API's `errors`); never a refused stop (`stop_failed`). */
export const ERRORS_KEEP_MS = 30 * DAY;
/** Proposed tasks the owner accepted or declined. */
export const TRIAGED_PROPOSALS_KEEP_MS = 30 * DAY;
/** Ended routine runs (their history on the Routines page). */
export const ENDED_RUNS_KEEP_MS = 90 * DAY;
/** A run's counted turns (only needed to drop a redelivered turn while it runs). */
export const RUN_TURNS_KEEP_MS = DAY;
/** Exits that came before their start named the agent. */
export const EARLY_EXITS_KEEP_MS = DAY;
/** How often a Durable Object prunes, at most. */
export const PRUNE_EVERY_MS = 3600_000;
