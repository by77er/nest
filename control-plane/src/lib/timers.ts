// Agent timers (docs/agents/timers/): an agent sets a named timer; when it fires, the agent gets an
// input as an inbox message would, and wakes for it. A repeating timer (`every_s`) fires again at its
// interval until it is cancelled or the agent ends. Stored in AgentDO's SQLite (`timers`) and driven by
// its one alarm (`Deadlines`, one key per timer: `timer:<name>`), so a timer outlives brain restarts,
// host loss and deploys. There is no blocking wait: an agent sets a timer and ends its turn, and
// whichever comes first, an inbox message or the timer, wakes it. Pure apart from `TimerStore`'s SQL.
import { z } from "zod";

/** A timer fires at least this long after it is set... */
export const TIMER_MIN_MS = 10_000;
/** ...and at most this long after. */
export const TIMER_MAX_MS = 30 * 86_400_000;
/** A repeating timer's interval is at least this: each firing is a turn, which a brain runs. */
export const TIMER_EVERY_MIN_MS = 300_000;
/** ...and at most this. */
export const TIMER_EVERY_MAX_MS = TIMER_MAX_MS;
/** Live timers per agent (a re-set name replaces its timer and takes no new place). */
export const TIMERS_MAX = 32;
/** The deadline key prefix: `timer:<name>`. */
export const TIMER_DEADLINE = "timer:";
/** The inbox sender a fired timer's input names. */
export const TIMER_SENDER = "timer";

export const TimerName = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, "a timer name is 1-63 lowercase letters, digits, '_', '.' and '-', starting with a letter or digit");
export const TimerNote = z.string().max(1000, "a timer's note is at most 1,000 characters");

/**
 * `timer_set`'s arguments: exactly one of `after_s` and `at_ms`, or, for a repeating timer (`every_s`), at
 * most one of them (its first firing; without either, one interval from now).
 */
export const TimerSetArgs = z.strictObject({
  name: TimerName,
  after_s: z.number().int().optional(),
  at_ms: z.number().int().optional(),
  every_s: z.number().int().optional(),
  note: TimerNote.optional(),
}).refine((a) => !(a.after_s !== undefined && a.at_ms !== undefined), "give exactly one of after_s and at_ms")
  .refine((a) => a.every_s !== undefined || a.after_s !== undefined || a.at_ms !== undefined, "give exactly one of after_s and at_ms (or every_s, to repeat)");

/** When a timer set at `now` with these arguments first fires, and its interval, or why it can't. */
export function timerDue(a: { after_s?: number; at_ms?: number; every_s?: number }, now: number): { ok: true; at_ms: number; every_ms?: number } | { ok: false; error: string } {
  const every = a.every_s !== undefined ? a.every_s * 1000 : undefined;
  if (every !== undefined && (every < TIMER_EVERY_MIN_MS || every > TIMER_EVERY_MAX_MS)) {
    return { ok: false, error: `a repeating timer's every_s is ${TIMER_EVERY_MIN_MS / 1000} (5 minutes) to ${TIMER_EVERY_MAX_MS / 1000} (30 days)` };
  }
  const at = a.after_s !== undefined ? now + a.after_s * 1000 : a.at_ms ?? now + every!;
  if (at - now < TIMER_MIN_MS) return { ok: false, error: `a timer fires at least ${TIMER_MIN_MS / 1000} s from now` };
  if (at - now > TIMER_MAX_MS) return { ok: false, error: `a timer fires at most ${TIMER_MAX_MS / 86_400_000} days from now` };
  return { ok: true, at_ms: at, ...(every !== undefined ? { every_ms: every } : {}) };
}

/**
 * A repeating timer's next firing after the one due at `at`: one interval on, keeping its cadence, or the
 * first point of that cadence after `now` when it fired late (an outage): missed firings aren't made up.
 */
export function nextFiring(at: number, every: number, now: number): number {
  const next = at + every;
  return next > now ? next : at + (Math.floor((now - at) / every) + 1) * every;
}

/** The input a fired timer gives its agent (inside the inbox message's `Message from timer: …`). */
export const timerFiredText = (name: string, note: string, every_ms?: number) =>
  every_ms === undefined ? `timer "${name}" fired: ${note}` : `timer "${name}" fired (repeats every ${everyText(every_ms)}; timer_cancel stops it): ${note}`;

/** An interval as a person says it: `90 minutes`, `2 hours`, `1 day`, or seconds when it isn't whole minutes. */
export function everyText(ms: number): string {
  const s = Math.round(ms / 1000);
  const unit = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  if (s % 86_400 === 0) return unit(s / 86_400, "day");
  if (s % 3600 === 0) return unit(s / 3600, "hour");
  if (s % 60 === 0) return unit(s / 60, "minute");
  return unit(s, "second");
}

/** A timer as an agent, its owner and the trace see it. */
export interface Timer {
  name: string;
  at_ms: number;
  note: string;
  set_ms: number;
  /** A repeating timer's interval; absent for a one-shot one. */
  every_ms?: number;
}

/** A timer's row: `id` is fixed when it is set, so a fired timer's input is posted once (its request id) and a replaced one is never fired. */
interface TimerRow extends Timer {
  id: string;
}

/** The `timers` table. Every method is one synchronous step. */
export class TimerStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS timers (name TEXT PRIMARY KEY, id TEXT NOT NULL, at_ms INTEGER NOT NULL, note TEXT NOT NULL, set_ms INTEGER NOT NULL)");
    // Added with repeating timers (expand only): null is a one-shot timer, as every row before it was. The
    // previous release doesn't read it: after a rollback a repeating timer fires once and is gone.
    const cols = sql.exec<{ name: string }>("PRAGMA table_info(timers)").toArray().map((c) => c.name);
    if (!cols.includes("every_ms")) sql.exec("ALTER TABLE timers ADD COLUMN every_ms INTEGER");
  }

  private static view(r: { name: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }): Timer {
    return { name: r.name, at_ms: r.at_ms, note: r.note, set_ms: r.set_ms, ...(r.every_ms !== null ? { every_ms: r.every_ms } : {}) };
  }

  get(name: string): TimerRow | undefined {
    const r = this.sql.exec<{ name: string; id: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }>(
      "SELECT name, id, at_ms, note, set_ms, every_ms FROM timers WHERE name = ?", name).toArray()[0];
    return r && { ...TimerStore.view(r), id: r.id };
  }

  list(): Timer[] {
    return this.sql.exec<{ name: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }>(
      "SELECT name, at_ms, note, set_ms, every_ms FROM timers ORDER BY at_ms, name").toArray().map(TimerStore.view);
  }

  /** Set (or replace) `name`; refused (null) when it is new and the agent has `TIMERS_MAX` already. */
  set(t: Timer, id: string): TimerRow | null {
    const have = this.get(t.name);
    if (!have && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM timers").one().n >= TIMERS_MAX) return null;
    this.sql.exec(`INSERT INTO timers (name, id, at_ms, note, set_ms, every_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET id = excluded.id, at_ms = excluded.at_ms, note = excluded.note, set_ms = excluded.set_ms, every_ms = excluded.every_ms`,
    t.name, id, t.at_ms, t.note, t.set_ms, t.every_ms ?? null);
    return { ...t, id };
  }

  /** Move a repeating timer `id` to its next firing (not one set again meanwhile). Whether it moved. */
  advance(name: string, id: string, at: number): boolean {
    return this.sql.exec("UPDATE timers SET at_ms = ? WHERE name = ? AND id = ?", at, name, id).rowsWritten > 0;
  }

  /** Delete `name` (only the timer `id` when given: a fired one, not one set again meanwhile). Whether a row went. */
  delete(name: string, id?: string): boolean {
    return (id === undefined
      ? this.sql.exec("DELETE FROM timers WHERE name = ?", name)
      : this.sql.exec("DELETE FROM timers WHERE name = ? AND id = ?", name, id)).rowsWritten > 0;
  }

  /** Every timer's name (to clear them all at an end). */
  names(): string[] {
    return this.sql.exec<{ name: string }>("SELECT name FROM timers").toArray().map((r) => r.name);
  }
}
