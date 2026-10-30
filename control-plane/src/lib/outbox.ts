// A Durable Object's posts to channels it doesn't own the delivery of (AgentDO's `<agt>/events`,
// SandboxDO's `<sbx>/events`): queued in the object's own SQLite in the same synchronous step as the
// state change they report, posted in order from its alarm, and deleted only once the ChannelDO
// acknowledged them (LESSONS: delete after ack, retry from the alarm). Each row posts under an
// idempotency key, so a retry after a lost acknowledgement lands once.
import type { Env } from "../env";
import type { PostInput } from "./channels";
import type { Deadlines } from "./reliable";

/** The deadline key the owning object's alarm dispatches to `flush`. */
export const OUTBOX_DEADLINE = "chan_out";
/** Rows posted per flush (the rest follow at once). */
const FLUSH_BATCH = 50;

type Row = {
  id: number;
  channel: string;
  body: string;
  tainted: number;
  agent_owner: string | null;
  has_owner: number;
};

export class ChannelOutbox {
  constructor(
    private readonly sql: SqlStorage,
    private readonly deadlines: Deadlines,
    private readonly env: Env,
    private readonly waitUntil: (p: Promise<unknown>) => void,
    /** Prefix of the default idempotency key (`<prefix>/out/<row id>`): the owning object's id. */
    private readonly keyPrefix: () => string,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS chan_out (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, body TEXT NOT NULL,
      tainted INTEGER NOT NULL, agent_owner TEXT, has_owner INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL)`);
  }

  /**
   * Queue a platform post (synchronous: the row and its deadline row are written now; the alarm is
   * set in the background). `agent_owner` is passed for an agent's own events channel: its spawner,
   * subscribed by default.
   */
  push(channel: string, post: PostInput, opts: { tainted: boolean; agent_owner?: string | null }): void {
    this.sql.exec("INSERT INTO chan_out (channel, body, tainted, agent_owner, has_owner, created_ms) VALUES (?, ?, ?, ?, ?, ?)",
      channel, JSON.stringify(post), opts.tainted ? 1 : 0, opts.agent_owner ?? null, opts.agent_owner !== undefined ? 1 : 0, Date.now());
    this.waitUntil(this.deadlines.set(OUTBOX_DEADLINE, Date.now(), true));
  }

  pending(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chan_out").one().n;
  }

  /** Post queued rows in order; a failure stops the flush (the deadline retries it). */
  async flush(): Promise<void> {
    const rows = this.sql.exec<Row>("SELECT id, channel, body, tainted, agent_owner, has_owner FROM chan_out ORDER BY id LIMIT ?", FLUSH_BATCH).toArray();
    for (const r of rows) {
      const body = JSON.parse(r.body) as PostInput;
      const post: PostInput = { ...body, idem_key: body.idem_key ?? `${this.keyPrefix()}/out/${r.id}` };
      await this.env.CHANNEL.get(this.env.CHANNEL.idFromName(r.channel)).post(r.channel, { principal: "platform", tainted: r.tainted === 1 }, post,
        r.has_owner ? { agent_owner: r.agent_owner } : {});
      this.sql.exec("DELETE FROM chan_out WHERE id = ?", r.id);
    }
    if (rows.length === FLUSH_BATCH) await this.deadlines.set(OUTBOX_DEADLINE, Date.now() + 1, true);
  }
}
