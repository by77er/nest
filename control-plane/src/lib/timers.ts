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
/** Repeating timers per agent, of its `TIMERS_MAX`: each is a turn at every interval, on the subscription. */
export const TIMERS_REPEATING_MAX = 8;
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
    // Added with repeating timers, a table of its own that the previous release never touches: a timer repeats
    // while its row here has the timer's id. So the previous release's re-set of the name (a new id) reads as the
    // one-shot timer it set, and what it does to a repeating timer during a rollback leaves this row behind for
    // `orphanedRepeats` to judge: fired (restored on its cadence), cancelled or set again (dropped).
    sql.exec("CREATE TABLE IF NOT EXISTS timer_repeats (name TEXT PRIMARY KEY, id TEXT NOT NULL, every_ms INTEGER NOT NULL, note TEXT NOT NULL, at_ms INTEGER NOT NULL)");
  }

  private static readonly SELECT = `SELECT t.name AS name, t.id AS id, t.at_ms AS at_ms, t.note AS note, t.set_ms AS set_ms, r.every_ms AS every_ms
    FROM timers t LEFT JOIN timer_repeats r ON r.name = t.name AND r.id = t.id`;

  private static view(r: { name: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }): Timer {
    return { name: r.name, at_ms: r.at_ms, note: r.note, set_ms: r.set_ms, ...(r.every_ms !== null ? { every_ms: r.every_ms } : {}) };
  }

  get(name: string): TimerRow | undefined {
    const r = this.sql.exec<{ name: string; id: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }>(
      `${TimerStore.SELECT} WHERE t.name = ?`, name).toArray()[0];
    return r && { ...TimerStore.view(r), id: r.id };
  }

  list(): Timer[] {
    return this.sql.exec<{ name: string; at_ms: number; note: string; set_ms: number; every_ms: number | null }>(
      `${TimerStore.SELECT} ORDER BY t.at_ms, t.name`).toArray().map(TimerStore.view);
  }

  /**
   * Set (or replace) `name`; refused when it is new and the agent has `TIMERS_MAX` already (`full`), or it
   * repeats and the agent's other repeating timers number `TIMERS_REPEATING_MAX` (`repeating`).
   */
  set(t: Timer, id: string): TimerRow | "full" | "repeating" {
    const have = this.get(t.name);
    if (!have && this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM timers").one().n >= TIMERS_MAX) return "full";
    if (t.every_ms !== undefined) {
      const others = this.sql.exec<{ n: number }>(
        "SELECT COUNT(*) AS n FROM timers t JOIN timer_repeats r ON r.name = t.name AND r.id = t.id WHERE t.name != ?", t.name).one().n;
      if (others >= TIMERS_REPEATING_MAX) return "repeating";
    }
    this.sql.exec(`INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET id = excluded.id, at_ms = excluded.at_ms, note = excluded.note, set_ms = excluded.set_ms`,
    t.name, id, t.at_ms, t.note, t.set_ms);
    if (t.every_ms === undefined) this.sql.exec("DELETE FROM timer_repeats WHERE name = ?", t.name);
    else {
      this.sql.exec(`INSERT INTO timer_repeats (name, id, every_ms, note, at_ms) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET id = excluded.id, every_ms = excluded.every_ms, note = excluded.note, at_ms = excluded.at_ms`,
      t.name, id, t.every_ms, t.note, t.at_ms);
    }
    return { ...t, id };
  }

  /**
   * Move a repeating timer `id` from the firing due `from` to its next, `at`: not one set again meanwhile, nor one
   * another run of the same firing (two alarms at once) already moved. Whether it moved.
   */
  advance(name: string, id: string, from: number, at: number): boolean {
    if (this.sql.exec("UPDATE timers SET at_ms = ? WHERE name = ? AND id = ? AND at_ms = ?", at, name, id, from).rowsWritten === 0) return false;
    this.sql.exec("UPDATE timer_repeats SET at_ms = ? WHERE name = ? AND id = ?", at, name, id);
    return true;
  }

  /** Delete `name` (only the timer `id` when given: a fired one, not one set again meanwhile). Whether a row went. */
  delete(name: string, id?: string): boolean {
    const gone = (id === undefined
      ? this.sql.exec("DELETE FROM timers WHERE name = ?", name)
      : this.sql.exec("DELETE FROM timers WHERE name = ? AND id = ?", name, id)).rowsWritten > 0;
    if (id === undefined) this.sql.exec("DELETE FROM timer_repeats WHERE name = ?", name);
    else this.sql.exec("DELETE FROM timer_repeats WHERE name = ? AND id = ?", name, id);
    return gone;
  }

  /** Every timer's name, repeats left behind included (to clear them all at an end). */
  names(): string[] {
    return this.sql.exec<{ name: string }>("SELECT name FROM timers UNION SELECT name FROM timer_repeats").toArray().map((r) => r.name);
  }

  /**
   * Repeats whose timer is gone or was set again: only a release that doesn't know them (a rollback) leaves one,
   * since this one deletes a timer's repeat in the step that deletes or replaces the timer. `replaced`: the name
   * holds another timer now.
   */
  orphanedRepeats(): { name: string; id: string; every_ms: number; note: string; at_ms: number; replaced: boolean }[] {
    return this.sql.exec<{ name: string; id: string; every_ms: number; note: string; at_ms: number; replaced: number }>(
      `SELECT r.name AS name, r.id AS id, r.every_ms AS every_ms, r.note AS note, r.at_ms AS at_ms, t.name IS NOT NULL AS replaced
       FROM timer_repeats r LEFT JOIN timers t ON t.name = r.name WHERE t.id IS NULL OR t.id != r.id`).toArray()
      .map((r) => ({ ...r, replaced: !!r.replaced }));
  }

  /** Put a repeating timer back as it was (`orphanedRepeats`: the previous release fired it once and deleted it). */
  restore(r: { name: string; id: string; every_ms: number; note: string }, at: number, now: number): void {
    this.sql.exec("INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES (?, ?, ?, ?, ?)", r.name, r.id, at, r.note, now);
    this.sql.exec("UPDATE timer_repeats SET at_ms = ? WHERE name = ? AND id = ?", at, r.name, r.id);
  }

  /** Forget a repeat left behind (its timer was cancelled or set again under a release that doesn't know it). */
  forgetRepeat(name: string, id: string): void {
    this.sql.exec("DELETE FROM timer_repeats WHERE name = ? AND id = ?", name, id);
  }
}
