// ChannelDO: the authority for one channel (docs/control-plane/durable-objects/channel/): its log,
// keyed view, grant list and subscriptions with their cursors. A thin shell over lib/channels.ts,
// which makes every decision (names, validation, permissions, the post guards, filters, batching):
// this file loads state, calls it, and writes what it decided in one synchronous step.
//
// Concurrency: the input gate opens across awaits on R2 and other Durable Objects, so every guard is
// re-checked in the synchronous step that writes (a post's permission and compare-and-set after its
// R2 put; a delivery's outcome against the batch still pinned). Every state change that leaves work
// for later arms its alarm in that same step (the deadline row is written before any await).
//
// One instance, `~directory` (not a channel name), lists every channel for the operator.
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import { z } from "zod";
import type { Env } from "../env";
import {
  type AclEntry, type Batch, BATCH_SCAN, beginDelivery, type Caller, type ChannelAction, type ChannelFacts, type ChannelKind, checkPost,
  type CheckedPost, DEFAULT_BATCH_MS, DEFAULT_RETENTION_DAYS, decidePost, Delivery, DELIVERY_TIMEOUT_MS, type DeliveryOutcome,
  chunks, IDEM_RETENTION_MS, isAgentCaller, R2_DELETE_MAX, KEYS_MAX_LIMIT, type LogView, type Message, type MessageMeta, onAppend, parseChannel,
  permits, type PostState, RATE_WINDOW_MS, READ_DEFAULT_LIMIT, READ_MAX_BYTES, READ_MAX_LIMIT, settleDelivery, type SubscribeInput, type Subscription,
  TIER_AFTER_MS,
} from "../lib/channels";
import { Deadlines } from "../lib/reliable";
import { storedEnum } from "../lib/stored";
import { asNestError, NestError, newId } from "../lib/util";
import { ErrorCodes } from "../protocol/model";

/** The instance that lists every channel (an invalid channel name, so no channel can collide with it). */
export const DIRECTORY = "~directory";
const DAY_MS = 86_400_000;
/** Retention and tiering run this often. */
const MAINTENANCE_EVERY_MS = DAY_MS;
/** Pages of expired rows deleted per maintenance run (the rest a minute later). */
const EXPIRE_PAGES = 10;
/** Rows tiered to R2 per maintenance run (the rest wait for the next). */
const TIER_BATCH = 200;
/** Deliveries run in parallel per alarm, at most this many at once. */
const FANOUT_PARALLEL = 8;
/** The spawner's default subscription to its child's events. */
export const SPAWNER_EVENT_KINDS = ["turn_completed", "exited"];
/** Built-in subscriptions' ids: the agent's own inbox, and its spawner on its events. */
export const INBOX_SUB = "sub_inbox";
export const SPAWNER_SUB = "sub_spawner";

interface Meta {
  name: string;
  kind: ChannelKind;
  owner: string | null;
  created_ms: number;
  retention_days: number;
  /** Listed in the directory (retried from the alarm until it is). */
  registered: boolean;
  /** For `agt_…/events`: the spawner's default subscription was made (once). */
  spawner_subscribed?: boolean;
}

export interface ChannelInfo {
  name: string;
  kind: ChannelKind["kind"];
  owner: string | null;
  created_ms: number;
  retention_days: number;
  head: number;
  acl: AclEntry[];
  subscriptions: number;
}

export type PostResult =
  | { status: "posted" | "existing" | "repeat"; seq: number }
  | { status: "conflict"; key: string; current_seq: number };

export interface ReadQuery {
  since?: number;
  limit?: number;
  latest_by_key?: boolean;
  prefix?: string;
  keys_only?: boolean;
  /** Keyed view paging: keys after this one. */
  after_key?: string;
  /** For a cursor read (no `since`, a `none` subscription): a re-run with the same key reads the same page. */
  idem_key?: string;
}

export interface ReadResult {
  channel: string;
  head: number;
  messages?: Message[];
  keys?: { key: string; seq: number; taint: boolean }[];
  /** The seq to pass as `since` next time (log reads). */
  next_seq?: number;
  /** The key to pass as `after_key` next time (keyed reads). */
  next_key?: string;
  more: boolean;
  /** Whether anything returned was tainted (the reader's session is, from now on). */
  tainted: boolean;
  /** A `none` subscription's cursor was read from and moved. */
  cursor?: string;
}

export interface DirectoryEntry {
  name: string;
  kind: ChannelKind["kind"];
  owner: string | null;
  created_ms: number;
}

/** Extra facts a trusted caller passes along (read from their own source of truth). */
export interface CallFacts {
  /** For an agent's built-in channel: that agent's owner, from its AgentDO. */
  agent_owner?: string | null;
  /** For AgentDO's events posts: whether that owner's spec has the `read` tool (its default subscription is made only then). */
  spawner_reads?: boolean;
}

type HookPoint = "post:enter" | "post:afterPut" | "fanout:beforeDeliver" | "fanout:afterDeliver";

type MsgRow = {
  seq: number; ts_ms: number; from_p: string; taint: number; kind: string | null; text: string | null; data: string | null;
  reply_to: number | null; key: string | null; mentions: string | null; body_ref: string | null;
};

const metaOf = (r: MsgRow): MessageMeta & { text?: string } => ({
  seq: r.seq, ts_ms: r.ts_ms, from: r.from_p, taint: r.taint === 1,
  ...(r.kind !== null ? { kind: r.kind } : {}), ...(r.key !== null ? { key: r.key } : {}),
  ...(r.reply_to !== null ? { reply_to: r.reply_to } : {}), ...(r.mentions !== null ? { mentions: JSON.parse(r.mentions) as string[] } : {}),
  ...(r.text !== null ? { text: r.text } : {}),
});

// Closed sets read back from storage (docs/data/#enums): checked, logged if outside, returned as read.
const ChannelActionEnum = z.enum(["post", "read"]);
const ChannelKindEnum = z.enum(["inbox", "events", "sandbox_events", "user", "free"]);
const readSub = (body: string): Subscription => {
  const s = JSON.parse(body) as Subscription;
  return { ...s, delivery: storedEnum(Delivery, s.delivery, "subs.body.delivery") };
};

const utf8Len = (t: string) => new TextEncoder().encode(t).length;

const forbidden = (m: string) => new NestError(ErrorCodes.FORBIDDEN, m, 403);
const invalid = (m: string, status = 400) => new NestError(ErrorCodes.INVALID_MESSAGE, m, status);

export class ChannelDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  // `!`: set in the constructor, except on the health instance, which serves only `health()`.
  private readonly deadlines!: Deadlines;
  /** Subscriptions whose delivery call is in flight in this isolate (never sent twice at once). */
  private readonly delivering = new Set<string>();
  /** Test seam: awaited at named points so a test can force an interleaving or a failure there. */
  testHooks: Partial<Record<HookPoint, () => Promise<void>>> = {};

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.CHANNEL)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, from_p TEXT NOT NULL,
      taint INTEGER NOT NULL, kind TEXT, text TEXT, data TEXT, reply_to INTEGER, key TEXT, mentions TEXT, body_ref TEXT,
      bytes INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS messages_from ON messages (from_p, seq)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS keys (key TEXT PRIMARY KEY, seq INTEGER NOT NULL, taint INTEGER NOT NULL)");
    // Idempotency keys are per poster: one poster's key never answers another's post.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS idem (poster TEXT NOT NULL, idem_key TEXT NOT NULL, seq INTEGER NOT NULL, ts_ms INTEGER NOT NULL,
      PRIMARY KEY (poster, idem_key))`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS rate (poster TEXT PRIMARY KEY, start_ms INTEGER NOT NULL, count INTEGER NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL, idem_key TEXT,
      created_ms INTEGER NOT NULL, read_key TEXT, read_from INTEGER)`);
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS subs_idem ON subs (agent, idem_key) WHERE idem_key IS NOT NULL");
    this.sql.exec("CREATE TABLE IF NOT EXISTS acl (principal TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY (principal, action))");
    this.sql.exec("CREATE TABLE IF NOT EXISTS directory (name TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT, created_ms INTEGER NOT NULL)");
    this.deadlines = new Deadlines(this.sql, ctx.storage);
  }

  private async hook(point: HookPoint): Promise<void> {
    const h = this.testHooks[point];
    if (h) await h();
  }

  // --- state ----------------------------------------------------------------------------------------

  private kv<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private putKv(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private head(): number {
    return this.kv<number>("head") ?? 0;
  }

  private meta(): Meta | undefined {
    return this.kv<Meta>("meta");
  }

  /**
   * The channel's metadata without writing anything: stored, or (for a built-in channel not used
   * yet) what it would be. A free channel exists only once created. Permission is decided on this,
   * so a refused call never creates a channel, a directory entry or an alarm.
   */
  private peek(name: string): Meta & { stored: boolean } {
    const kind = parseChannel(name);
    if (!kind.ok) throw invalid(kind.error);
    const cur = this.meta();
    if (cur) {
      if (cur.name !== name) throw new NestError(ErrorCodes.INTERNAL, `channel object for ${cur.name} asked about ${name}`, 500);
      return { ...cur, stored: true };
    }
    if (kind.value.kind === "free") throw invalid(`no channel ${name}`, 404);
    return { name, kind: kind.value, owner: null, created_ms: 0, retention_days: DEFAULT_RETENTION_DAYS, registered: false, stored: false };
  }

  /**
   * The channel's metadata, made on first permitted use for a built-in channel (they exist with
   * their agent, sandbox, or always: `user`). Synchronous: arms the directory registration in the
   * same step. An `agt_…/inbox` gets its agent's subscription (the agent is always subscribed to
   * its inbox), from the start of the log.
   */
  private ensure(name: string): Meta {
    const m = this.peek(name);
    if (m.stored) return this.meta()!;
    return this.init(name, m.kind, null, DEFAULT_RETENTION_DAYS);
  }

  private init(name: string, kind: ChannelKind, owner: string | null, retention_days: number): Meta {
    const meta: Meta = { name, kind, owner, created_ms: Date.now(), retention_days, registered: false };
    this.putKv("meta", meta);
    if (kind.kind === "inbox") {
      this.saveSub({
        id: INBOX_SUB, agent: kind.agent, filter: {}, delivery: "turn", batch_ms: DEFAULT_BATCH_MS, once: false, cursor: 0,
        due_ms: null, inflight: null, attempts: 0,
      });
    }
    this.ctx.waitUntil(this.deadlines.set("register", Date.now(), true));
    return meta;
  }

  private acl(): AclEntry[] {
    return this.sql.exec<{ principal: string; action: string }>("SELECT principal, action FROM acl ORDER BY principal, action").toArray()
      .map((r) => ({ principal: r.principal, action: storedEnum(ChannelActionEnum, r.action, "acl.action") }));
  }

  private facts(meta: Meta, extra: CallFacts): ChannelFacts {
    return { name: meta.name, kind: meta.kind, owner: meta.owner, acl: this.acl(), ...(extra.agent_owner !== undefined ? { agent_owner: extra.agent_owner } : {}) };
  }

  private check(action: ChannelAction, caller: Caller, meta: Meta, extra: CallFacts): void {
    const d = permits(action, caller, this.facts(meta, extra));
    if (!d.ok) throw forbidden(d.error);
  }

  private subs(): Subscription[] {
    return this.sql.exec<{ body: string }>("SELECT body FROM subs ORDER BY created_ms, id").toArray().map((r) => readSub(r.body));
  }

  private sub(id: string): Subscription | undefined {
    const r = this.sql.exec<{ body: string }>("SELECT body FROM subs WHERE id = ?", id).toArray()[0];
    return r ? readSub(r.body) : undefined;
  }

  /**
   * Store a subscription. A due one arms the fan-out in this step (keeping an earlier alarm; the
   * deadline row is written now), so no writer can leave it due with nothing to run it.
   */
  private saveSub(s: Subscription, idemKey?: string): void {
    this.sql.exec(`INSERT INTO subs (id, agent, body, idem_key, created_ms) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body`, s.id, s.agent, JSON.stringify(s), idemKey ?? null, Date.now());
    if (s.delivery === "turn" && s.due_ms !== null) this.ctx.waitUntil(this.deadlines.set("fanout", Math.max(s.due_ms, 1), true));
  }

  // --- channels -------------------------------------------------------------------------------------

  /**
   * Create a free channel; its creator owns it (both actions, and it can be granted to others).
   * Built-in channels exist with what owns them and can't be created. Idempotent for its owner.
   */
  async create(name: string, caller: Caller, retentionDays = DEFAULT_RETENTION_DAYS): Promise<ChannelInfo> {
    const kind = parseChannel(name);
    if (!kind.ok) throw invalid(kind.error);
    if (kind.value.kind !== "free") throw invalid(`${name} is a built-in channel: it exists with its owner`, 409);
    if (caller.principal === "platform") throw forbidden("the platform creates no free channels");
    if (!(retentionDays >= 1 && retentionDays <= 365 && Number.isInteger(retentionDays))) throw invalid("retention_days is 1-365");
    const cur = this.meta();
    if (cur) {
      if (cur.owner === caller.principal) return this.infoOf(cur);
      throw invalid(`channel ${name} exists`, 409);
    }
    const meta = this.init(name, kind.value, caller.principal, retentionDays);
    return this.infoOf(meta);
  }

  private infoOf(meta: Meta): ChannelInfo {
    return {
      name: meta.name, kind: meta.kind.kind, owner: meta.owner, created_ms: meta.created_ms, retention_days: meta.retention_days,
      head: this.head(), acl: this.acl(), subscriptions: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM subs").one().n,
    };
  }

  /** The operator's view. */
  async info(name: string): Promise<ChannelInfo> {
    return this.infoOf(this.peek(name));
  }

  /** Replace the channel's own grant list (the operator; a channel's owner always holds both actions). */
  async setAcl(name: string, entries: AclEntry[]): Promise<AclEntry[]> {
    this.ensure(name);
    this.sql.exec("DELETE FROM acl");
    for (const e of entries) this.sql.exec("INSERT OR IGNORE INTO acl (principal, action) VALUES (?, ?)", e.principal, e.action);
    return this.acl();
  }

  // --- posting --------------------------------------------------------------------------------------

  /**
   * Append a message. `from` is the caller's principal and `taint` its session's, never the body's.
   * The guards (idempotency, compare-and-set, repeats, rate) and the permission are decided in the
   * synchronous step that appends, after any R2 put; matching `turn` subscriptions open their batch
   * window and the fan-out alarm is armed in that step. Fan-out never runs here.
   */
  async post(name: string, caller: Caller, raw: unknown, extra: CallFacts = {}): Promise<PostResult> {
    await this.hook("post:enter");
    const checked = checkPost(raw);
    if (!checked.ok) throw invalid(checked.error);
    const post = checked.value;
    this.check("post", caller, this.peek(name), extra);
    let bodyRef: string | null = null;
    if (!post.inline) {
      bodyRef = `channels/${name}/b/${newId("blb_")}`;
      await this.env.BUCKET.put(bodyRef, JSON.stringify({ text: post.input.text, data: post.data_json }));
      await this.hook("post:afterPut");
    }
    try {
      return this.commitPost(name, caller, post, bodyRef, extra);
    } catch (e) {
      if (bodyRef) this.ctx.waitUntil(this.env.BUCKET.delete(bodyRef));
      throw e;
    }
  }

  private commitPost(name: string, caller: Caller, post: CheckedPost, bodyRef: string | null, extra: CallFacts): PostResult {
    // Re-checked here: the grant list may have changed during the put. Only then is a built-in
    // channel made.
    this.check("post", caller, this.peek(name), extra);
    const meta = this.ensure(name);
    const now = Date.now();
    const from = caller.principal;
    const p = post.input;
    const head = this.head();
    const idem = p.idem_key ? this.sql.exec<{ seq: number }>("SELECT seq FROM idem WHERE poster = ? AND idem_key = ?", from, p.idem_key).toArray()[0] : undefined;
    const key = p.key ? this.sql.exec<{ seq: number }>("SELECT seq FROM keys WHERE key = ?", p.key).toArray()[0] : undefined;
    const last = this.sql.exec<MsgRow>("SELECT * FROM messages WHERE from_p = ? ORDER BY seq DESC LIMIT 1", from).toArray()[0];
    const rate = this.sql.exec<{ start_ms: number; count: number }>("SELECT start_ms, count FROM rate WHERE poster = ?", from).toArray()[0];
    const st: PostState = {
      head,
      ...(idem ? { idem_seq: idem.seq } : {}),
      ...(key ? { key_seq: key.seq } : {}),
      ...(last ? {
        last_by_sender: {
          seq: last.seq, ts_ms: last.ts_ms, text: last.body_ref ? "\u0000offloaded" : last.text ?? "", data_json: last.data,
          ...(last.kind !== null ? { kind: last.kind } : {}), ...(last.key !== null ? { key: last.key } : {}),
        },
      } : {}),
      ...(rate ? { rate } : {}),
    };
    const d = decidePost(post, from, st, now);
    switch (d.kind) {
      case "existing":
      case "repeat":
        if (bodyRef) this.ctx.waitUntil(this.env.BUCKET.delete(bodyRef));
        return { status: d.kind, seq: d.seq };
      case "conflict":
        if (bodyRef) this.ctx.waitUntil(this.env.BUCKET.delete(bodyRef));
        return { status: "conflict", key: p.key!, current_seq: d.current_seq };
      case "rate_limited":
        throw new NestError(ErrorCodes.RATE_LIMITED, `rate limited on ${name}: try again in ${Math.ceil(d.retry_after_ms / 1000)} s`, 429, true);
      case "invalid":
        throw invalid(d.error);
      case "append":
        break;
    }
    const seq = d.seq;
    const taint = caller.tainted ?? false;
    // The spawner's default subscription to its child's events, made once, from before the first
    // event it is told about.
    if (meta.kind.kind === "events" && caller.principal === "platform" && !meta.spawner_subscribed) {
      // Only for a spawner that can `read` what it is woken for: otherwise none is made yet, and a
      // later event (once the spawner can read) makes it then. Marked only when made.
      if (extra.agent_owner && extra.spawner_reads) {
        this.saveSub({
          id: SPAWNER_SUB, agent: extra.agent_owner, filter: { kinds: SPAWNER_EVENT_KINDS }, delivery: "turn", batch_ms: DEFAULT_BATCH_MS,
          once: false, cursor: head, due_ms: null, inflight: null, attempts: 0,
        });
        this.putKv("meta", { ...meta, spawner_subscribed: true });
      }
    }
    this.sql.exec(`INSERT INTO messages (seq, ts_ms, from_p, taint, kind, text, data, reply_to, key, mentions, body_ref, bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, seq, now, from, taint ? 1 : 0, p.kind ?? null, bodyRef ? null : p.text,
      bodyRef ? null : post.data_json, p.reply_to ?? null, p.key ?? null, p.mentions ? JSON.stringify(p.mentions) : null, bodyRef, post.bytes);
    this.putKv("head", seq);
    if (p.idem_key) this.sql.exec("INSERT OR REPLACE INTO idem (poster, idem_key, seq, ts_ms) VALUES (?, ?, ?, ?)", from, p.idem_key, seq, now);
    if (d.rate) this.sql.exec("INSERT OR REPLACE INTO rate (poster, start_ms, count) VALUES (?, ?, ?)", from, d.rate.start_ms, d.rate.count);
    if (p.key) {
      if (post.removes_key) this.sql.exec("DELETE FROM keys WHERE key = ?", p.key);
      else this.sql.exec("INSERT OR REPLACE INTO keys (key, seq, taint) VALUES (?, ?, ?)", p.key, seq, taint ? 1 : 0);
    }
    const msg: MessageMeta = {
      seq, ts_ms: now, from, taint, ...(p.kind ? { kind: p.kind } : {}), ...(p.key ? { key: p.key } : {}),
      ...(p.reply_to ? { reply_to: p.reply_to } : {}), ...(p.mentions ? { mentions: p.mentions } : {}),
    };
    // Each opened window arms the fan-out in this step (`saveSub`), and maintenance is armed here: a
    // reset after the append can't strand a delivery or the channel's maintenance.
    for (const s of this.subs()) {
      const next = onAppend(s, msg, now);
      if (next !== s.due_ms) this.saveSub({ ...s, due_ms: next });
    }
    if (!this.deadlines.has("maintenance")) this.ctx.waitUntil(this.deadlines.set("maintenance", now + MAINTENANCE_EVERY_MS, true));
    return { status: "posted", seq };
  }

  // --- reading --------------------------------------------------------------------------------------

  /**
   * Read the log after `since` (or, for an agent with a `none` subscription and no `since`, after
   * its cursor, which then moves), or the keyed view (`latest_by_key`). Bodies in R2 are fetched
   * transparently. A page holds at most `limit` messages and about 256 KiB.
   */
  async read(name: string, caller: Caller, q: ReadQuery, extra: CallFacts = {}): Promise<ReadResult> {
    const meta = this.peek(name);
    this.check("read", caller, meta, extra);
    const head = this.head();
    // A built-in channel nobody posted to yet: empty, and reading it makes nothing.
    if (!meta.stored) return { channel: name, head: 0, ...(q.latest_by_key ? { keys: [] } : { messages: [], next_seq: q.since ?? 0 }), more: false, tainted: false };
    if (q.latest_by_key) return this.readKeys(meta, q, head);
    const limit = Math.max(1, Math.min(q.limit ?? READ_DEFAULT_LIMIT, READ_MAX_LIMIT));
    let since = q.since;
    let cursorSub: Subscription | undefined;
    if (since === undefined && isAgentCaller(caller)) {
      const row = this.sql.exec<{ body: string; read_key: string | null; read_from: number | null }>(
        "SELECT body, read_key, read_from FROM subs WHERE agent = ? ORDER BY created_ms", caller.principal).toArray()
        .map((r) => ({ ...r, sub: readSub(r.body) })).find((r) => r.sub.delivery === "none");
      if (row) {
        cursorSub = row.sub;
        // A re-run of the same read (its tool call cut short) reads the same page again.
        since = q.idem_key && row.read_key === q.idem_key && row.read_from !== null ? row.read_from : cursorSub.cursor;
      }
    }
    const from = Math.max(0, since ?? 0);
    const rows = this.sql.exec<MsgRow>("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", from, limit + 1).toArray();
    const more = rows.length > limit;
    const out: Message[] = [];
    let bytes = 0;
    for (const r of rows.slice(0, limit)) {
      const m = await this.message(r);
      bytes += utf8Len(m.text) + (m.data !== undefined ? utf8Len(JSON.stringify(m.data)) : 0);
      if (out.length && bytes > READ_MAX_BYTES) break;
      out.push(m);
    }
    const next = out.length ? out[out.length - 1]!.seq : from;
    if (cursorSub && q.since === undefined) {
      // Settled after the body fetches: the cursor only moves forward.
      const cur = this.sub(cursorSub.id);
      if (cur) {
        this.saveSub({ ...cur, cursor: Math.max(cur.cursor, next) });
        this.sql.exec("UPDATE subs SET read_key = ?, read_from = ? WHERE id = ?", q.idem_key ?? null, from, cur.id);
      }
    }
    return {
      channel: meta.name, head, messages: out, next_seq: next, more: more || out.length < Math.min(rows.length, limit),
      tainted: out.some((m) => m.taint), ...(cursorSub ? { cursor: cursorSub.id } : {}),
    };
  }

  private async readKeys(meta: Meta, q: ReadQuery, head: number): Promise<ReadResult> {
    const limit = Math.max(1, Math.min(q.limit ?? KEYS_MAX_LIMIT, KEYS_MAX_LIMIT));
    const prefix = q.prefix ?? "";
    const rows = this.sql.exec<{ key: string; seq: number; taint: number }>(
      "SELECT key, seq, taint FROM keys WHERE key > ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
      q.after_key ?? "", prefix.length, prefix, limit + 1).toArray();
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const next_key = page.length ? page[page.length - 1]!.key : q.after_key;
    if (q.keys_only) {
      // The key index only: short identifiers, with the newest entry's taint marked; reading it doesn't taint.
      return {
        channel: meta.name, head, keys: page.map((r) => ({ key: r.key, seq: r.seq, taint: r.taint === 1 })), more,
        ...(next_key !== undefined ? { next_key } : {}), tainted: false,
      };
    }
    const out: Message[] = [];
    for (const k of page) {
      const r = this.sql.exec<MsgRow>("SELECT * FROM messages WHERE seq = ?", k.seq).toArray()[0];
      if (r) out.push(await this.message(r));
    }
    return { channel: meta.name, head, messages: out, more, ...(next_key !== undefined ? { next_key } : {}), tainted: out.some((m) => m.taint) };
  }

  private async message(r: MsgRow): Promise<Message> {
    let text = r.text ?? "";
    let data: string | null = r.data;
    if (r.body_ref) {
      const obj = await this.env.BUCKET.get(r.body_ref);
      if (obj) {
        const body = JSON.parse(await obj.text()) as { text: string; data: string | null };
        text = body.text;
        data = body.data;
      } else {
        text = "[body no longer stored]";
      }
    }
    const meta = metaOf({ ...r, text: null });
    const { text: _t, ...rest } = meta as MessageMeta & { text?: string };
    return { ...rest, text, ...(data !== null ? { data: JSON.parse(data) as unknown } : {}) };
  }

  // --- subscriptions --------------------------------------------------------------------------------

  /**
   * Subscribe `agent` (the caller itself, or for the operator any agent). It needs `read`. The
   * cursor starts at the current head: only later messages are delivered. Idempotent by `idem_key`.
   */
  async subscribe(name: string, caller: Caller, agent: string, input: SubscribeInput, extra: CallFacts = {}): Promise<Subscription> {
    if (isAgentCaller(caller) && caller.principal !== agent) throw forbidden(`${caller.principal} can subscribe only itself`);
    if (!/^agt_[a-z0-9]+$/.test(agent)) throw invalid("only agents subscribe");
    this.check("read", caller, this.peek(name), extra);
    this.ensure(name);
    if (input.idem_key) {
      const prior = this.sql.exec<{ body: string }>("SELECT body FROM subs WHERE agent = ? AND idem_key = ?", agent, input.idem_key).toArray()[0];
      if (prior) return readSub(prior.body);
    }
    const sub: Subscription = {
      id: newId("sub_"), agent, filter: input.filter, delivery: input.delivery, batch_ms: input.batch_ms, once: input.once,
      cursor: this.head(), due_ms: null, inflight: null, attempts: 0,
    };
    this.saveSub(sub, input.idem_key);
    return sub;
  }

  /** End a subscription: the caller's own (the operator: any). Idempotent. */
  async unsubscribe(name: string, caller: Caller, id: string): Promise<{ removed: boolean }> {
    this.peek(name);
    const s = this.sub(id);
    if (!s) return { removed: false };
    if (isAgentCaller(caller) && s.agent !== caller.principal) throw forbidden(`${id} is not ${caller.principal}'s subscription`);
    if (caller.principal === "platform") throw forbidden("the platform ends no subscriptions");
    // Made once, with the channel: removing it would be for good.
    if (id === INBOX_SUB) throw forbidden("an agent is always subscribed to its inbox");
    this.sql.exec("DELETE FROM subs WHERE id = ?", id);
    return { removed: true };
  }

  async subscriptions(name: string): Promise<Subscription[]> {
    this.peek(name);
    return this.subs();
  }

  // --- fan-out (from the alarm) ---------------------------------------------------------------------

  /**
   * Deliver every due subscription, at most `FANOUT_PARALLEL` at a time, then re-arm for the next
   * due one. Per subscription, in order and at least once: a batch is pinned (stored with a backstop
   * retry) before its call, the cursor moves only after the subscriber's AgentDO acknowledged it,
   * and a retry carries the same range, which AgentDO takes once.
   */
  private async fanout(): Promise<void> {
    const now = Date.now();
    const due = this.subs().filter((s) => s.delivery === "turn" && s.due_ms !== null && s.due_ms <= now && !this.delivering.has(s.id));
    for (let i = 0; i < due.length; i += FANOUT_PARALLEL) {
      await Promise.all(due.slice(i, i + FANOUT_PARALLEL).map((s) => this.deliverOne(s.id)));
    }
    this.rearm();
  }

  private rearm(): void {
    let next: number | null = null;
    for (const s of this.subs()) if (s.delivery === "turn" && s.due_ms !== null && (next === null || s.due_ms < next)) next = s.due_ms;
    this.ctx.waitUntil(next === null ? this.deadlines.clear("fanout") : this.deadlines.set("fanout", Math.max(next, Date.now() + 1)));
  }

  /** The log as deliveries read it. */
  private log(): LogView {
    return {
      head: this.head(),
      scan: (after) => this.sql.exec<MsgRow>("SELECT * FROM messages WHERE seq > ? ORDER BY seq LIMIT ?", after, BATCH_SCAN).toArray()
        .map((r) => metaOf({ ...r, text: r.from_p === "user" && !r.body_ref ? r.text : null })),
    };
  }

  private async deliverOne(id: string): Promise<void> {
    const meta = this.meta();
    const sub = this.sub(id);
    if (!meta || !sub || sub.due_ms === null || sub.due_ms > Date.now()) return;
    const { save, send: batch } = beginDelivery(sub, this.log(), Date.now());
    // A pin is saved with its backstop armed: a reset mid-call sends the same batch again.
    if (save) this.saveSub(save);
    if (!batch) return;
    this.delivering.add(id);
    let outcome: DeliveryOutcome;
    try {
      await this.hook("fanout:beforeDeliver");
      outcome = await this.callAgent(sub.agent, { channel: meta.name, subscription: id, batch });
    } catch (e) {
      if (asNestError(e)?.code === ErrorCodes.UNKNOWN_AGENT) {
        console.warn(`channel ${meta.name}: subscriber ${sub.agent} is not an agent; ${id} dropped`);
        this.sql.exec("DELETE FROM subs WHERE id = ?", id);
        return;
      }
      console.warn(`channel ${meta.name}: delivering ${id} to ${sub.agent} failed; retrying`, e);
      outcome = { status: "error" };
    } finally {
      this.delivering.delete(id);
    }
    await this.hook("fanout:afterDeliver");
    this.settle(id, batch, outcome);
  }

  /** Record a delivery's outcome against the batch still pinned (synchronous), and re-arm. */
  private settle(id: string, batch: Batch, outcome: DeliveryOutcome): void {
    const cur = this.sub(id);
    if (!cur) return;
    const next = settleDelivery(cur, batch, outcome, this.log(), Date.now());
    if (next === null) {
      this.sql.exec("DELETE FROM subs WHERE id = ?", id);
      return;
    }
    this.saveSub(next);
  }

  private async callAgent(agent: string, d: { channel: string; subscription: string; batch: Batch }): Promise<DeliveryOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("delivery timed out")), DELIVERY_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.env.AGENT.get(this.env.AGENT.idFromName(agent)).deliverChannel(d), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // --- maintenance ----------------------------------------------------------------------------------

  /**
   * Retention (docs/data/#retention): messages older than the channel's retention go, except the
   * newest per key; bodies older than 7 days move to R2; idempotency keys go after 7 days; stale rate
   * windows go. Expiry runs in pages of `R2_DELETE_MAX` rows, at most `EXPIRE_PAGES` per run (the
   * rest at the next run, a minute later): a page's R2 bodies are deleted (in calls of at most
   * `R2_DELETE_MAX` keys, R2's limit) before its rows, so a row never loses its body's reference
   * while the body exists. A reset between leaves rows whose body is gone: they read as "no longer
   * stored" and go at the next run.
   */
  private async maintenance(): Promise<void> {
    const meta = this.meta();
    if (!meta) return;
    const now = Date.now();
    const cutoff = now - meta.retention_days * DAY_MS;
    this.sql.exec("DELETE FROM idem WHERE ts_ms < ?", now - IDEM_RETENTION_MS);
    this.sql.exec("DELETE FROM rate WHERE start_ms < ?", now - RATE_WINDOW_MS);
    let backlog = false;
    for (let page = 0; ; page++) {
      const doomed = this.sql.exec<{ seq: number; body_ref: string | null }>(
        "SELECT seq, body_ref FROM messages WHERE ts_ms < ? AND seq NOT IN (SELECT seq FROM keys) ORDER BY seq LIMIT ?", cutoff, R2_DELETE_MAX).toArray();
      if (!doomed.length) break;
      if (page >= EXPIRE_PAGES) {
        backlog = true;
        break;
      }
      const refs = doomed.map((d) => d.body_ref).filter((r): r is string => r !== null);
      for (const c of chunks(refs, R2_DELETE_MAX)) await this.env.BUCKET.delete(c);
      // The page's own rows, not the predicate again: a key superseded during the delete would match
      // it now, and go without its body. A paged row can't have come back into `keys` (a key only ever
      // moves to a newer seq).
      this.sql.exec("DELETE FROM messages WHERE seq IN (SELECT value FROM json_each(?))", JSON.stringify(doomed.map((d) => d.seq)));
    }
    // Tiering: bodies older than 7 days to R2, the row keeps the reference.
    const old = this.sql.exec<{ seq: number; text: string | null; data: string | null }>(
      "SELECT seq, text, data FROM messages WHERE ts_ms < ? AND body_ref IS NULL LIMIT ?", now - TIER_AFTER_MS, TIER_BATCH).toArray();
    for (const r of old) {
      const ref = `channels/${meta.name}/b/${newId("blb_")}`;
      await this.env.BUCKET.put(ref, JSON.stringify({ text: r.text ?? "", data: r.data }));
      const n = this.sql.exec("UPDATE messages SET text = NULL, data = NULL, body_ref = ? WHERE seq = ? AND body_ref IS NULL", ref, r.seq).rowsWritten;
      if (n === 0) await this.env.BUCKET.delete(ref);
    }
    await this.deadlines.set("maintenance", Date.now() + (old.length === TIER_BATCH || backlog ? 60_000 : MAINTENANCE_EVERY_MS));
  }

  /** Run maintenance now (operator and tests). */
  async maintain(name: string): Promise<void> {
    this.peek(name);
    await this.maintenance();
  }

  private async register(): Promise<void> {
    const meta = this.meta();
    if (!meta || meta.registered) return;
    await this.env.CHANNEL.get(this.env.CHANNEL.idFromName(DIRECTORY)).dirRegister({
      name: meta.name, kind: meta.kind.kind, owner: meta.owner, created_ms: meta.created_ms,
    });
    const cur = this.meta();
    if (cur) this.putKv("meta", { ...cur, registered: true });
  }

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "fanout") await this.fanout();
      else if (key === "maintenance") await this.maintenance();
      else if (key === "register") await this.register();
    });
  }

  // --- the directory (the `~directory` instance only) -----------------------------------------------

  async dirRegister(e: DirectoryEntry): Promise<void> {
    this.sql.exec("INSERT OR IGNORE INTO directory (name, kind, owner, created_ms) VALUES (?, ?, ?, ?)", e.name, e.kind, e.owner, e.created_ms);
  }

  async dirList(prefix = "", after = "", limit = 200): Promise<{ channels: DirectoryEntry[]; more: boolean }> {
    const n = Math.max(1, Math.min(limit, 500));
    const rows = this.sql.exec<{ name: string; kind: string; owner: string | null; created_ms: number }>(
      "SELECT name, kind, owner, created_ms FROM directory WHERE name > ? AND substr(name, 1, ?) = ? ORDER BY name LIMIT ?",
      after, prefix.length, prefix, n + 1).toArray();
    return { channels: rows.slice(0, n).map((r) => ({ ...r, kind: storedEnum(ChannelKindEnum, r.kind, "directory.kind") })), more: rows.length > n };
  }
}
