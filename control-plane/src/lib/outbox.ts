// A Durable Object's posts to channels it doesn't own the delivery of (AgentDO's `<agt>/events`,
// SandboxDO's `<sbx>/events`): queued in the object's own SQLite in the same synchronous step as the
// state change they report, posted in order from its alarm, and deleted only once the ChannelDO
// acknowledged them (LESSONS: delete after ack, retry from the alarm). Each row posts under an
// idempotency key, so a retry after a lost acknowledgement lands once.
//
// Bounded so it can't hold up the object's own deadlines: the owning object runs it after every
// other due deadline (`Deadlines.runDue`'s `last`), and one flush posts at most `FLUSH_BATCH` rows
// within `FLUSH_BUDGET_MS`, each call cut off at `POST_TIMEOUT_MS`; the rest follow from the alarm.
// A row ChannelDO refuses for good (a non-retryable error) is dead-lettered after `MAX_REFUSALS`
// tries (logged and removed), so it never blocks the rows behind it.
import type { Env } from "../env";
import { asNestError } from "./util";
import type { PostInput } from "./channels";
import { type Deadlines, withTimeout } from "./reliable";

/** The deadline key the owning object's alarm dispatches to `flush`. */
export const OUTBOX_DEADLINE = "chan_out";
/** Rows posted per flush (the rest follow at once, from the next alarm). */
export const FLUSH_BATCH = 20;
/** A flush starts no new post after this long. */
export const FLUSH_BUDGET_MS = 5_000;
/** One post's call is abandoned (and retried later, under the same idempotency key) after this long. */
export const POST_TIMEOUT_MS = 5_000;
/** A row refused this many times with a non-retryable error is dead-lettered. */
export const MAX_REFUSALS = 3;

type Row = {
  id: number;
  channel: string;
  body: string;
  tainted: number;
  agent_owner: string | null;
  has_owner: number;
  refusals: number;
};

/** Extra facts for a row naming an agent's owner (AgentDO: whether that owner can `read`). */
export type OwnerFacts = (owner: string) => Promise<{ spawner_reads: boolean }>;

export class ChannelOutbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly deadlines: Deadlines,
    private readonly env: Env,
    private readonly waitUntil: (p: Promise<unknown>) => void,
    /** Prefix of the default idempotency key (`<prefix>/out/<row id>`): the owning object's id. */
    private readonly keyPrefix: () => string,
    private readonly ownerFacts?: OwnerFacts,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS chan_out (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, body TEXT NOT NULL,
      tainted INTEGER NOT NULL, agent_owner TEXT, has_owner INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL,
      refusals INTEGER NOT NULL DEFAULT 0)`);
  }

  /**
   * Queue a platform post (synchronous: the row and its deadline row are written now; the alarm is
   * set in the background). `agent_owner` is passed for an agent's own events channel: its spawner.
   */
  push(channel: string, post: PostInput, opts: { tainted: boolean; agent_owner?: string | null }): void {
    this.sql.exec("INSERT INTO chan_out (channel, body, tainted, agent_owner, has_owner, created_ms) VALUES (?, ?, ?, ?, ?, ?)",
      channel, JSON.stringify(post), opts.tainted ? 1 : 0, opts.agent_owner ?? null, opts.agent_owner !== undefined ? 1 : 0, Date.now());
    this.waitUntil(this.deadlines.set(OUTBOX_DEADLINE, Date.now(), true));
  }

  /**
   * Post queued rows in order, within the batch and time bounds. A retryable failure stops the flush
   * (the deadline retries it, keeping the order); a row refused for good is retried `MAX_REFUSALS`
   * times, then dead-lettered.
   */
  async flush(): Promise<void> {
    const started = Date.now();
    const rows = this.sql.exec<Row>("SELECT id, channel, body, tainted, agent_owner, has_owner, refusals FROM chan_out ORDER BY id LIMIT ?", FLUSH_BATCH).toArray();
    let done = 0;
    for (const r of rows) {
      if (Date.now() - started >= FLUSH_BUDGET_MS) break;
      const body = JSON.parse(r.body) as PostInput;
      const post: PostInput = { ...body, idem_key: body.idem_key ?? `${this.keyPrefix()}/out/${r.id}` };
      try {
        // The owner lookup and the post share one timeout.
        await withTimeout((async () => {
          const extra = r.has_owner
            ? { agent_owner: r.agent_owner, ...(r.agent_owner && this.ownerFacts ? await this.ownerFacts(r.agent_owner) : {}) }
            : {};
          await this.env.CHANNEL.get(this.env.CHANNEL.idFromName(r.channel)).post(r.channel, { principal: "platform", tainted: r.tainted === 1 }, post, extra);
        })(), POST_TIMEOUT_MS, "channel post");
      } catch (e) {
        const ne = asNestError(e);
        if (!ne || ne.retryable) throw e;
        if (r.refusals + 1 >= MAX_REFUSALS) {
          console.error(`channel outbox: dead-lettering ${r.channel} post ${r.id} after ${MAX_REFUSALS} refusals: ${ne.code} ${ne.detail}`, r.body);
          this.sql.exec("DELETE FROM chan_out WHERE id = ?", r.id);
          done++;
          continue;
        }
        this.sql.exec("UPDATE chan_out SET refusals = refusals + 1 WHERE id = ?", r.id);
        throw e;
      }
      this.sql.exec("DELETE FROM chan_out WHERE id = ?", r.id);
      done++;
    }
    if (done < rows.length || rows.length === FLUSH_BATCH) await this.deadlines.set(OUTBOX_DEADLINE, Date.now() + 1, true);
  }
}
