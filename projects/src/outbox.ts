// The app's retry queues as one machine (README.md#outboxes): the chat to the manager, messages to agents,
// stops, issue closes and client layers each hold rows of work owed to nest or GitHub. A row is `owed`
// (not tried yet), `retrying` (tried, or waiting for something it needs, and due again), `failed` (refused
// for good, or out of attempts: shown, and tried again only when asked) or `done`. Pure, so every queue
// takes the same verdicts, and test/outbox.test.ts tests them on their own.

import { backoff } from "./nest";

export const OUTBOX_STATES = ["owed", "retrying", "failed", "done"] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/** The columns every queue keeps: when it's due (null: not due, done or failed), the attempts made, the last error. */
export interface OutboxRow {
  next_ms: number | null;
  attempts: number;
  error: string | null;
}

/**
 * What happens to a row:
 * - `sent`: the attempt went through;
 * - `failed`: the attempt failed, `permanent` when it would fail the same way again (`verdict`);
 * - `wait`: it can't be tried yet (nothing to send it to): due again, not counted as an attempt, never failed;
 * - `retry`: asked again (the owner's Retry, or its cause fixed): a failed row is owed afresh.
 */
export type OutboxEvent = { kind: "sent" } | { kind: "failed"; error: string; permanent: boolean } | { kind: "wait"; error: string } | { kind: "retry" };

/** A queue's own rules: transient failures past `maxAttempts` fail it (none: retried until it goes); ended rows kept `keepMs`. */
export interface OutboxPolicy {
  maxAttempts?: number;
  keepMs?: number;
}

export type OutboxStep = { ok: true; row: OutboxRow; state: OutboxState } | { ok: false; error: string };

/** A row's state, from its columns. */
export function outboxState(r: OutboxRow): OutboxState {
  if (r.next_ms === null) return r.error === null ? "done" : "failed";
  return r.attempts === 0 && r.error === null ? "owed" : "retrying";
}

const at = (row: OutboxRow): OutboxStep => ({ ok: true, row, state: outboxState(row) });

/** Where `event` takes a row at `now`, or why it can't. */
export function outboxStep(r: OutboxRow, event: OutboxEvent, now: number, policy: OutboxPolicy = {}): OutboxStep {
  const state = outboxState(r);
  const pending = state === "owed" || state === "retrying";
  switch (event.kind) {
    case "sent":
      if (state === "done") return at(r);
      if (!pending) return { ok: false, error: `a ${state} row isn't being sent` };
      return at({ next_ms: null, attempts: r.attempts + 1, error: null });
    case "failed": {
      if (!pending) return { ok: false, error: `a ${state} row isn't being sent` };
      const attempts = r.attempts + 1;
      const out = event.permanent || (policy.maxAttempts !== undefined && attempts >= policy.maxAttempts);
      return at({ next_ms: out ? null : now + backoff(attempts), attempts, error: event.error });
    }
    case "wait":
      if (!pending) return { ok: false, error: `a ${state} row isn't waiting` };
      return at({ next_ms: now + backoff(Math.max(1, r.attempts)), attempts: r.attempts, error: event.error });
    case "retry":
      // Asked again: only a failed row changes, so asking twice sends once.
      if (state !== "failed") return at(r);
      return at({ next_ms: now, attempts: 0, error: null });
  }
}

/** Whether an error will repeat: a refusal (nest's or GitHub's `permanent`), not an outage or a timeout. */
export function verdict(e: unknown): { permanent: boolean; error: string } {
  const permanent = typeof e === "object" && e !== null && "permanent" in e && (e as { permanent: unknown }).permanent === true;
  return { permanent, error: e instanceof Error ? e.message : String(e) };
}

/** The time before which a queue's ended rows (done or failed) are pruned, or null when it keeps them. */
export function pruneBefore(policy: OutboxPolicy, now: number): number | null {
  return policy.keepMs === undefined ? null : now - policy.keepMs;
}

/** Whether a row last touched at `at_ms` is pruned now. */
export function prunable(r: OutboxRow, at_ms: number, policy: OutboxPolicy, now: number): boolean {
  const before = pruneBefore(policy, now);
  const state = outboxState(r);
  return before !== null && (state === "done" || state === "failed") && at_ms < before;
}

const DAY = 86_400_000;

/**
 * Each queue's rules. The chat is the owner's log and an issue's close is its task's record, so neither
 * is pruned; a message to an agent is kept a week once ended; a failed stop until it's resolved.
 * A stop never gives up on transient failures (it must go in the end); the queues with `maxAttempts`
 * do, and say so where their failure shows.
 */
export const OUTBOX: Record<"chat" | "messages" | "stops" | "issue_closes" | "layers" | "templates" | "review_checks" | "review_stops" | "review_ended" | "review_steps" | "review_held", OutboxPolicy> = {
  chat: {},
  messages: { keepMs: 7 * DAY },
  // A failed stop is kept until its agent is stopped, dismissed or exits: its place stays counted meanwhile.
  stops: {},
  issue_closes: {},
  layers: {},
  // A stale model template's delete: given up after this many tries, so a removed project's object can rest.
  templates: { maxAttempts: 30 },
  // ReviewDO's queues (README.md#outboxes). A check run's update and a finished review's word to the
  // project are given up after this many tries, said on the job. A reviewer's stop is a stop: it must go.
  review_checks: { maxAttempts: 30 },
  review_stops: {},
  review_ended: { maxAttempts: 30 },
  // A running job's next step (its check, its reviewer, the brief): its deadline bounds the tries.
  review_steps: {},
  // A held job's check, saying it waits for the owner: the job waits on the Reviews page either way.
  review_held: { maxAttempts: 30 },
};
