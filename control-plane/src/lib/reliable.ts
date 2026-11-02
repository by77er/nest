// At-least-once, in-order delivery over WebSockets (docs/interfaces/control-host/README.md):
// outbound messages get a per-channel seq, are stored until cumulatively acked, and are resent after
// the seq the peer reports in its hello. Inbound reliable messages are processed strictly in order:
// a seq is either the next one, a duplicate, or a gap; a later batch's ack never covers an earlier one
// that failed.

export type InboundVerdict = "process" | "duplicate" | "gap";

export class ReliableChannels {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS rel_out (chan TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL,
              PRIMARY KEY (chan, seq))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rel_state (chan TEXT PRIMARY KEY, next_out INTEGER NOT NULL DEFAULT 1,
              last_in INTEGER)`);
  }

  private state(chan: string): { next_out: number; last_in: number | null } {
    const rows = this.sql.exec<{ next_out: number; last_in: number | null }>(
      "SELECT next_out, last_in FROM rel_state WHERE chan = ?", chan).toArray();
    if (rows[0]) return rows[0];
    this.sql.exec("INSERT INTO rel_state (chan, next_out, last_in) VALUES (?, 1, NULL)", chan);
    return { next_out: 1, last_in: null };
  }

  /** Assign the next seq, persist the message, and return it for sending. */
  push<T extends { seq: number }>(chan: string, make: (seq: number) => T): T {
    const { next_out } = this.state(chan);
    const msg = make(next_out);
    this.sql.exec("INSERT INTO rel_out (chan, seq, body) VALUES (?, ?, ?)", chan, next_out, JSON.stringify(msg));
    this.sql.exec("UPDATE rel_state SET next_out = ? WHERE chan = ?", next_out + 1, chan);
    return msg;
  }

  /** Cumulative ack: forget everything up to and including `upTo`. */
  ack(chan: string, upTo: number): void {
    this.sql.exec("DELETE FROM rel_out WHERE chan = ? AND seq <= ?", chan, upTo);
  }

  /** Unacked messages with seq > `after`, in order (resend after reconnect). */
  pendingAfter(chan: string, after: number | undefined): unknown[] {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM rel_out WHERE chan = ? AND seq > ? ORDER BY seq", chan, after ?? 0)
      .toArray()
      .map((r) => JSON.parse(r.body) as unknown);
  }

  /** Whether any unacked message has seq > `after`. */
  hasPendingAfter(chan: string, after: number | undefined): boolean {
    return this.sql.exec("SELECT 1 FROM rel_out WHERE chan = ? AND seq > ? LIMIT 1", chan, after ?? 0).toArray().length > 0;
  }

  /**
   * The lowest seq a resend after `after` or any later push can carry: the first unacked message
   * above `after`, else the next seq to assign. The peer's in-order baseline for a new connection.
   */
  firstToSend(chan: string, after: number | undefined): number {
    const row = this.sql
      .exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM rel_out WHERE chan = ? AND seq > ?", chan, after ?? 0)
      .toArray()[0];
    return row?.seq ?? this.state(chan).next_out;
  }

  /** Highest inbound seq fully processed, if any. */
  lastIn(chan: string): number | undefined {
    return this.state(chan).last_in ?? undefined;
  }

  /**
   * Where an inbound `seq` stands. The first message of a lineage establishes the baseline; after
   * that only `last_in + 1` may be processed. Anything later is a gap (an earlier message failed or
   * was lost): the caller must not process or ack it, and should make the peer resend.
   */
  classify(chan: string, seq: number): InboundVerdict {
    const last = this.lastIn(chan);
    if (last === undefined) return "process";
    if (seq <= last) return "duplicate";
    return seq === last + 1 ? "process" : "gap";
  }

  /**
   * Start a new lineage (the peer is a new process): drop unacked outbound messages and forget the
   * inbound high-water mark. Outbound seqs keep growing.
   */
  reset(chan: string): void {
    this.state(chan);
    this.sql.exec("DELETE FROM rel_out WHERE chan = ?", chan);
    this.sql.exec("UPDATE rel_state SET last_in = NULL WHERE chan = ?", chan);
  }

  /** Drop the channel entirely (its peer is gone for good and will never reconnect under this name). */
  forget(chan: string): void {
    this.sql.exec("DELETE FROM rel_out WHERE chan = ?", chan);
    this.sql.exec("DELETE FROM rel_state WHERE chan = ?", chan);
  }

  /** Record that inbound `seq` (the next one in order) has been fully processed. */
  markProcessed(chan: string, seq: number): void {
    this.state(chan);
    this.sql.exec("UPDATE rel_state SET last_in = ? WHERE chan = ?", seq, chan);
  }
}

/**
 * Runs async work one item at a time, in submission order, within one Durable Object instance.
 * Reliable messages go through it, inbound and outbound, so one never overtakes an earlier one that
 * is still awaiting other Durable Objects (the input gate opens across those awaits).
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  /** Items submitted and not yet finished (the running one included). */
  get pending(): number {
    return this.count;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    this.count++;
    const next = this.tail.then(fn, fn).finally(() => {
      this.count--;
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** `p`, or a rejection after `ms`, so a call that never answers can't hold up an alarm loop (it runs on, unheard). */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Multiplexes several named deadlines onto a Durable Object's single alarm. `K` narrows the keys an
 * owner may arm; `runDue` hands back any stored key, so its handler must expect one it doesn't know.
 */
export class Deadlines<K extends string = string> {
  /** Keys `runDue` is running, with the `at` run: that row is about to go, so `has` and `keepEarlier` ignore it. */
  private readonly running = new Map<string, number>();
  /** Running keys `set` since their handler started: their row is a new deadline, kept whatever its `at`. */
  private readonly rearmed = new Set<string>();

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
  ) {
    sql.exec("CREATE TABLE IF NOT EXISTS deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
  }

  /** The key's stored `at`, if it has a row. */
  private at(key: string): number | undefined {
    return this.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = ?", key).toArray()[0]?.at;
  }

  async set(key: K, at: number, keepEarlier = false): Promise<void> {
    if (keepEarlier && this.has(key) && this.at(key)! <= at) return;
    this.sql.exec("INSERT INTO deadlines (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at", key, at);
    if (this.running.has(key)) this.rearmed.add(key);
    await this.reschedule();
  }

  async clear(key: K): Promise<void> {
    this.sql.exec("DELETE FROM deadlines WHERE key = ?", key);
    await this.reschedule();
  }

  /** Whether `key` is armed. A key whose handler is running isn't (its row is about to be deleted). */
  has(key: K): boolean {
    const at = this.at(key);
    return at !== undefined && (this.running.get(key) !== at || this.rearmed.has(key));
  }

  /**
   * Run the handler for every key due at `now`. A key is removed only after its handler succeeds
   * (and only if nobody re-armed it meanwhile, even for the same time); a failing handler is retried
   * after `retryMs`.
   */
  async runDue(now: number, handler: (key: string) => Promise<void>, retryMs = 5_000): Promise<void> {
    // In time order.
    const due = this.sql.exec<{ key: string }>("SELECT key FROM deadlines WHERE at <= ? ORDER BY at", now).toArray();
    for (const { key } of due) {
      // Read again: an earlier key's handler (or a call while it awaited) may have cleared or moved it.
      const at = this.at(key);
      if (at === undefined || at > now) continue;
      this.running.set(key, at);
      try {
        await handler(key);
        if (!this.rearmed.has(key)) this.sql.exec("DELETE FROM deadlines WHERE key = ? AND at = ?", key, at);
      } catch (e) {
        console.error(`deadline ${key} failed; retrying`, e);
        this.sql.exec("UPDATE deadlines SET at = ? WHERE key = ? AND at = ?", Date.now() + retryMs, key, at);
      } finally {
        this.running.delete(key);
        this.rearmed.delete(key);
      }
    }
    await this.reschedule();
  }

  async reschedule(): Promise<void> {
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM deadlines").toArray()[0]?.at;
    if (next === null || next === undefined) await this.storage.deleteAlarm();
    // A past time fires at once; the runtime refuses times <= 0 (a test may write `at = 0`).
    else await this.storage.setAlarm(Math.max(next, 1));
  }
}
