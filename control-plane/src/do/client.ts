// ClientDO (docs/control-plane/api/clients/): one per API client, named by its id (`cli_…`), holding
// its record (name, grant, token hash), and the registry of its subtree: every agent and sandbox it
// owns, directly or through the agents it created, with their labels. The registry is what the grant's
// `max_agents` and `max_sandboxes` count and what the client lists. And its webhook, with the backlog
// of events its subtree's agents and sandboxes handed it, delivered one at a time from its alarm.
//
// One more instance, named `directory`, holds the names: unique, each mapped to its client's id, and
// the list of clients. Nothing else addresses it.
//
// Counting (docs/control-plane/durable-objects/client/): a create first `admit`s the new id, which
// checks the count and records it as `reserved` in one synchronous step, so two creates can't both
// take the last place. The agent or sandbox then reports itself from its own alarm (`report`), live
// and later ended (AgentDO once its end is done, SandboxDO once destroyed), so the row follows its
// record. A reservation whose create never happened (the request died between the two) is found by
// this object's alarm after `RESERVE_CHECK_MS` and dropped when the object doesn't exist.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { type Grant, labelWhere, type Labels } from "../lib/clients";
import { BACKLOG_MAX, checkWebhookUrl, retryDelayMs, signature, type StampedEvent, WEBHOOK_TIMEOUT_MS } from "../lib/client-events";
import { num } from "../env";
import { healthRead, isHealthInstance } from "../lib/health";
import { Deadlines } from "../lib/reliable";
import { storedEnum } from "../lib/stored";
import { asNestError, clip, hex, NestError, timingSafeEqual } from "../lib/util";
import { z } from "zod";
import { ErrorCodes } from "../protocol/model";
import type { ClientScope } from "./catalog";

/** The directory instance's name (client ids start `cli_`, the health instance `~`). */
export const CLIENT_DIRECTORY = "directory";
/** A reservation not reported by its object this long after `admit` is checked against the object. */
export const RESERVE_CHECK_MS = 10 * 60_000;
/** An ended agent or destroyed sandbox stays listed this long (an agent's records are kept as long). */
export const ENDED_RETENTION_MS = 7 * 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
/** Live rows read against their objects per hourly prune. */
const RECHECK_PER_RUN = 100;
/** Deliveries per alarm run (each is awaited, one at a time); more go on in the next run, at once. */
const DELIVER_PER_RUN = 100;

export type MemberKind = "agent" | "sandbox";
const MemberState = z.enum(["reserved", "live", "ended"]);
type MemberState = z.output<typeof MemberState>;

/** What the record holds (never shown whole: the token hash stays here). */
interface ClientRecord {
  client: string;
  name: string;
  grant: Grant;
  token_hash: string;
  created_ms: number;
  rotated_ms?: number;
  /** Deleted: no token works, nothing new is admitted; the operator's delete finishes the cleanup and purges it. */
  deleted_ms?: number;
}

/** A client as the admin API shows it. */
export interface ClientView {
  client: string;
  name: string;
  grant: Grant;
  created_ms: number;
  rotated_ms: number | null;
  /** Live (or reserved) agents and sandboxes across its subtree: what `max_agents` and `max_sandboxes` count. */
  live: { agents: number; sandboxes: number };
  /** Its webhook (never its secret) and the delivery of its events. */
  events: EventsView;
}

/** Where a client's events stand. */
export interface EventsView {
  webhook: string | null;
  /** Events waiting to be delivered. */
  backlog: number;
  /** Events dropped because the backlog was full (oldest first), ever. */
  dropped: number;
  /** Consecutive failed attempts (0 once one succeeds), and the last failure's reason. */
  failures: number;
  last_error: string | null;
}

/** The webhook, as stored. The secret is shown once, when it is set. */
interface Webhook {
  url: string;
  secret: string;
  set_ms: number;
}

/** Delivery's state: its retry schedule survives a restart. */
interface Delivery {
  failures: number;
  dropped: number;
  last_error?: string;
  /** When the last attempt failed (the next one is `retryDelayMs(failures)` later). */
  failed_ms?: number;
}

/** One agent or sandbox of a client's subtree, as listed. */
export interface Member {
  id: string;
  kind: MemberKind;
  cell: string;
  owner: string | null;
  labels: Labels;
  created_ms: number;
  state: MemberState;
  ended_ms: number | null;
}

export interface MemberFacts {
  kind: MemberKind;
  id: string;
  cell: string;
  /** Its owner: the client itself for a root it created, else the agent that created it (`null` for a sandbox an operator made). */
  owner: string | null;
  labels: Labels;
}

export interface ListQuery {
  labels?: [string, string][];
  /** `live` (the default: reserved or live), `ended`, or `all`. */
  state?: "live" | "ended" | "all";
  cell?: string;
  limit?: number;
  /** From the previous page's `next_cursor`. */
  cursor?: string;
}

type Key = "reconcile" | "prune" | "deliver";

const notFound = () => new NestError(ErrorCodes.NOT_FOUND, "unknown client", 404);

export class ClientDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly deadlines!: Deadlines<Key>;
  private readonly directory: boolean = false;

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.CLIENT)) return;
    if (ctx.id.equals(env.CLIENT.idFromName(CLIENT_DIRECTORY))) {
      this.directory = true;
      this.sql.exec("CREATE TABLE IF NOT EXISTS names (name TEXT PRIMARY KEY, client TEXT NOT NULL, created_ms INTEGER NOT NULL)");
      return;
    }
    this.schema();
    this.deadlines = new Deadlines(this.sql, ctx.storage);
  }

  private schema(): void {
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, kind TEXT NOT NULL, cell TEXT NOT NULL, owner TEXT,
      labels TEXT NOT NULL, created_ms INTEGER NOT NULL, state TEXT NOT NULL, ended_ms INTEGER, checked_ms INTEGER)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS members_page ON members (kind, created_ms, id)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
    // Events waiting for its webhook, in the order they were handed over; `id` is the event's (dedup).
    this.sql.exec("CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL)");
  }

  // --- the directory -------------------------------------------------------------------------------

  private requireDirectory(): void {
    if (!this.directory) throw new NestError(ErrorCodes.INTERNAL, "not the client directory", 500);
  }

  /** Take `name` for `client` (409 when another client has it). Idempotent for the same client. */
  async claimName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    const cur = this.sql.exec<{ client: string }>("SELECT client FROM names WHERE name = ?", name).toArray()[0];
    if (cur && cur.client !== client) throw new NestError(ErrorCodes.CONFLICT, `a client named ${name} exists`, 409);
    if (!cur) this.sql.exec("INSERT INTO names (name, client, created_ms) VALUES (?, ?, ?)", name, client, Date.now());
  }

  async releaseName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    this.sql.exec("DELETE FROM names WHERE name = ? AND client = ?", name, client);
  }

  /** Every client, by name. */
  async names(): Promise<{ name: string; client: string; created_ms: number }[]> {
    this.requireDirectory();
    return this.sql.exec<{ name: string; client: string; created_ms: number }>("SELECT name, client, created_ms FROM names ORDER BY name").toArray();
  }

  /** The client named `name`, if any. */
  async lookup(name: string): Promise<string | null> {
    this.requireDirectory();
    return this.sql.exec<{ client: string }>("SELECT client FROM names WHERE name = ?", name).toArray()[0]?.client ?? null;
  }

  // --- the record ----------------------------------------------------------------------------------

  private requireClient(): void {
    if (this.directory) throw new NestError(ErrorCodes.INTERNAL, "the directory is not a client", 500);
  }

  private record(): ClientRecord | null {
    this.requireClient();
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'record'").toArray()[0];
    return row ? JSON.parse(row.value) as ClientRecord : null;
  }

  /** The record of a client that exists and isn't deleted (404 otherwise). */
  private live(): ClientRecord {
    const r = this.record();
    if (!r || r.deleted_ms) throw notFound();
    return r;
  }

  private save(r: ClientRecord): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('record', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(r));
  }

  private count(kind: MemberKind): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members WHERE kind = ? AND state != 'ended'", kind).one().n;
  }

  private view(r: ClientRecord): ClientView {
    return {
      client: r.client, name: r.name, grant: r.grant, created_ms: r.created_ms, rotated_ms: r.rotated_ms ?? null,
      live: { agents: this.count("agent"), sandboxes: this.count("sandbox") },
      events: this.eventsView(),
    };
  }

  /** Create the record (the token's hash only). A retry with the same name returns it; another refuses. */
  async create(req: { client: string; name: string; grant: Grant; token_hash: string }): Promise<ClientView> {
    const cur = this.record();
    if (cur) {
      if (cur.name !== req.name || cur.deleted_ms) throw new NestError(ErrorCodes.CONFLICT, `${req.client} exists`, 409);
      return this.view(cur);
    }
    const r: ClientRecord = { client: req.client, name: req.name, grant: req.grant, token_hash: req.token_hash, created_ms: Date.now() };
    this.save(r);
    await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS, true);
    return this.view(r);
  }

  async info(): Promise<ClientView> {
    return this.view(this.live());
  }

  /**
   * Who a bearer token is: the caller has parsed it as this client's (`parseClientToken`). The whole
   * token's hash is compared in constant time; a deleted or unknown client, or any other token, is 401.
   */
  async authenticate(tokenHashHex: string): Promise<ClientScope> {
    const r = this.record();
    const enc = new TextEncoder();
    if (!r || r.deleted_ms || !timingSafeEqual(enc.encode(tokenHashHex), enc.encode(r.token_hash))) {
      throw new NestError(ErrorCodes.UNAUTHORIZED, "admin or client token required", 401);
    }
    return { client: r.client, name: r.name, grant: r.grant };
  }

  /** Its name and grant, for a spawn in its subtree (403 once deleted: nothing more is created for it). */
  async scope(): Promise<ClientScope> {
    const r = this.record();
    if (!r || r.deleted_ms) throw new NestError(ErrorCodes.FORBIDDEN, "the client this agent belongs to was deleted", 403);
    return { client: r.client, name: r.name, grant: r.grant };
  }

  /** Replace the grant. What runs keeps running; every later create, spawn and expansion is held to the new one. */
  async setGrant(grant: Grant): Promise<ClientView> {
    const r = this.live();
    r.grant = grant;
    this.save(r);
    return this.view(r);
  }

  /** A new token's hash replaces the old one, which stops working at once. */
  async rotate(token_hash: string): Promise<ClientView> {
    const r = this.live();
    r.token_hash = token_hash;
    r.rotated_ms = Date.now();
    this.save(r);
    return this.view(r);
  }

  /**
   * Begin deleting: refused (409) while anything of its subtree lives; otherwise no token works and
   * nothing is admitted from here on. Idempotent until `purge`. Answers its name, for the cleanup.
   */
  async markDeleted(): Promise<{ name: string }> {
    const r = this.record();
    if (!r) throw notFound();
    if (!r.deleted_ms) {
      const agents = this.count("agent");
      const sandboxes = this.count("sandbox");
      if (agents || sandboxes) {
        throw new NestError(ErrorCodes.CONFLICT, `${r.client} still has ${agents} live agents and ${sandboxes} live sandboxes: end and destroy them first`, 409);
      }
      r.deleted_ms = Date.now();
      r.token_hash = "";
      this.save(r);
    }
    return { name: r.name };
  }

  /** The last step of a delete: its storage, gone. */
  async purge(): Promise<void> {
    const r = this.record();
    if (r && !r.deleted_ms) throw new NestError(ErrorCodes.CONFLICT, "only a deleted client is purged", 409);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Empty again but readable: every later call answers as for a client that never was.
    this.schema();
  }

  // --- the subtree's registry ----------------------------------------------------------------------

  /**
   * Take a place for a new agent or sandbox, before it is created: its cell must be in the grant and
   * its kind under the grant's maximum, counted with every live or reserved one, in this step. A
   * retry with the same id (an idempotent create, a re-run spawn) finds its place.
   */
  async admit(m: MemberFacts): Promise<void> {
    const r = this.record();
    if (!r || r.deleted_ms) throw new NestError(ErrorCodes.FORBIDDEN, "the client was deleted", 403);
    const cur = this.sql.exec<{ state: string }>("SELECT state FROM members WHERE id = ?", m.id).toArray()[0];
    if (cur) return;
    if (!r.grant.cells.includes(m.cell)) throw new NestError(ErrorCodes.FORBIDDEN, `outside ${r.client}'s grant: cell ${m.cell}`, 403);
    const max = m.kind === "agent" ? r.grant.max_agents : r.grant.max_sandboxes;
    const n = this.count(m.kind);
    if (n >= max) throw new NestError(ErrorCodes.FORBIDDEN, `${r.client} has ${n} live ${m.kind === "agent" ? "agents" : "sandboxes"}, its grant's max_${m.kind === "agent" ? "agents" : "sandboxes"}`, 403);
    this.sql.exec("INSERT INTO members (id, kind, cell, owner, labels, created_ms, state) VALUES (?, ?, ?, ?, ?, ?, 'reserved')",
      m.id, m.kind, m.cell, m.owner, JSON.stringify(m.labels), Date.now());
    await this.deadlines.set("reconcile", Date.now() + RESERVE_CHECK_MS, true);
  }

  /** A create that failed for good: its place, if still only reserved, goes back. */
  async release(id: string): Promise<void> {
    this.sql.exec("DELETE FROM members WHERE id = ? AND state = 'reserved'", id);
  }

  /**
   * An agent or sandbox of the subtree reports itself (from its alarm, retried until this answers):
   * live, or ended. Ended is final. One never admitted (a row the reconcile dropped) is recorded too,
   * so the count never misses one that exists.
   */
  async report(m: MemberFacts & { ended_ms: number | null }): Promise<void> {
    this.requireClient();
    const state: MemberState = m.ended_ms === null ? "live" : "ended";
    this.sql.exec(`INSERT INTO members (id, kind, cell, owner, labels, created_ms, state, ended_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state = CASE WHEN members.state = 'ended' THEN 'ended' ELSE excluded.state END,
        ended_ms = COALESCE(members.ended_ms, excluded.ended_ms)`,
    m.id, m.kind, m.cell, m.owner, JSON.stringify(m.labels), Date.now(), state, m.ended_ms);
  }

  /** A page of its agents or sandboxes, oldest first, filtered by labels (each must hold), state and cell. */
  async list(kind: MemberKind, q: ListQuery = {}): Promise<{ items: Member[]; next_cursor: string | null }> {
    this.requireClient();
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
    const where = ["kind = ?"];
    const args: (string | number)[] = [kind];
    const state = q.state ?? "live";
    if (state === "live") where.push("state != 'ended'");
    else if (state === "ended") where.push("state = 'ended'");
    if (q.cell) {
      where.push("cell = ?");
      args.push(q.cell);
    }
    if (q.cursor) {
      const m = /^(\d+):(.+)$/.exec(q.cursor);
      if (!m) throw new NestError(ErrorCodes.INVALID_MESSAGE, "bad cursor");
      where.push("(created_ms > ? OR (created_ms = ? AND id > ?))");
      args.push(Number(m[1]), Number(m[1]), m[2]!);
    }
    const lw = labelWhere("labels", q.labels ?? []);
    where.push(lw.sql);
    args.push(...lw.args);
    const rows = this.sql.exec<{ id: string; kind: string; cell: string; owner: string | null; labels: string; created_ms: number; state: string; ended_ms: number | null }>(
      `SELECT id, kind, cell, owner, labels, created_ms, state, ended_ms FROM members WHERE ${where.join(" AND ")} ORDER BY created_ms, id LIMIT ?`,
      ...args, limit + 1).toArray();
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({
        id: r.id, kind: r.kind as MemberKind, cell: r.cell, owner: r.owner, labels: JSON.parse(r.labels) as Labels,
        created_ms: r.created_ms, state: storedEnum(MemberState, r.state, "members.state"), ended_ms: r.ended_ms,
      })),
      next_cursor: rows.length > limit && last ? `${last.created_ms}:${last.id}` : null,
    };
  }

  // --- events to the client (docs/control-plane/api/clients/#events-to-the-owner) -------------------

  private kv<T>(key: string): T | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return row ? JSON.parse(row.value) as T : undefined;
  }

  private kvPut(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private delivery(): Delivery {
    return this.kv<Delivery>("delivery") ?? { failures: 0, dropped: 0 };
  }

  private backlog(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM outbox").one().n;
  }

  private eventsView(): EventsView {
    const d = this.delivery();
    return { webhook: this.kv<Webhook>("webhook")?.url ?? null, backlog: this.backlog(), dropped: d.dropped, failures: d.failures, last_error: d.last_error ?? null };
  }

  /**
   * Set (or replace) its webhook: `https` only. A new signing secret every time, answered here only.
   * What waits goes to the new URL at once, its retry schedule started over.
   */
  async setWebhook(url: string): Promise<{ url: string; secret: string }> {
    this.live();
    const bad = checkWebhookUrl(url);
    if (bad) throw new NestError(ErrorCodes.INVALID_MESSAGE, bad);
    const secret = `whsec_${hex(crypto.getRandomValues(new Uint8Array(32)))}`;
    this.kvPut("webhook", { url, secret, set_ms: Date.now() } satisfies Webhook);
    const d = this.delivery();
    this.kvPut("delivery", { failures: 0, dropped: d.dropped } satisfies Delivery);
    if (this.backlog()) await this.deadlines.set("deliver", Date.now());
    return { url, secret };
  }

  /**
   * Events from an agent or sandbox of its subtree (its outbox's hand-off, retried until this answers).
   * Taken in one synchronous step, never waiting on a delivery: an id already here is kept once; with
   * no webhook (or no client any more) they go, as nobody would hear them; past `BACKLOG_MAX` the
   * oldest go and are counted.
   */
  async enqueue(events: StampedEvent[]): Promise<void> {
    this.requireClient();
    const r = this.record();
    if (!r || r.deleted_ms || !this.kv<Webhook>("webhook") || !events.length) return;
    for (const ev of events) this.sql.exec("INSERT OR IGNORE INTO outbox (id, body) VALUES (?, ?)", ev.id, JSON.stringify(ev));
    const over = this.backlog() - BACKLOG_MAX;
    if (over > 0) {
      this.sql.exec("DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY seq LIMIT ?)", over);
      const d = this.delivery();
      this.kvPut("delivery", { ...d, dropped: d.dropped + over } satisfies Delivery);
      console.warn(`client ${r.client}: its event backlog is full; dropped the ${over} oldest`);
    }
    // A delivery waiting out its backoff keeps its time; otherwise the next one goes now.
    if (!this.deadlines.has("deliver")) await this.deadlines.set("deliver", Date.now());
  }

  /**
   * The `deliver` deadline: the oldest events, one request at a time, each deleted once its webhook
   * answered 2xx. The first failure (any other status, a network error, or no answer within the
   * timeout) stops the run, and the next one comes `retryDelayMs(failures)` later.
   */
  private async deliver(): Promise<void> {
    const timeoutMs = num(this.env.CLIENT_WEBHOOK_TIMEOUT_MS, WEBHOOK_TIMEOUT_MS);
    for (let i = 0; i < DELIVER_PER_RUN; i++) {
      const hook = this.kv<Webhook>("webhook");
      const row = this.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM outbox ORDER BY seq LIMIT 1").toArray()[0];
      if (!hook || !row) return;
      const t = Date.now();
      let error: string | null = null;
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "content-type": "application/json", "nest-signature": await signature(hook.secret, t, row.body) },
          body: row.body,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await res.body?.cancel();
        if (res.status < 200 || res.status > 299) error = `HTTP ${res.status}`;
      } catch (e) {
        error = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? `no answer within ${timeoutMs} ms` : clip(String(e), 300);
      }
      // Re-read in this step: a new webhook set during the attempt starts its own schedule.
      const d = this.delivery();
      if (this.kv<Webhook>("webhook")?.set_ms !== hook.set_ms) continue;
      if (error === null) {
        this.sql.exec("DELETE FROM outbox WHERE seq = ?", row.seq);
        if (d.failures) this.kvPut("delivery", { failures: 0, dropped: d.dropped } satisfies Delivery);
        continue;
      }
      // The wait runs from the failure: an attempt cut off at the timeout is retried 1 s after that.
      const failures = d.failures + 1;
      const now = Date.now();
      this.kvPut("delivery", { failures, dropped: d.dropped, last_error: error, failed_ms: now } satisfies Delivery);
      await this.deadlines.set("deliver", now + retryDelayMs(failures));
      return;
    }
    if (this.backlog()) await this.deadlines.set("deliver", Date.now());
  }

  // --- alarms --------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    if (this.directory) return;
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "reconcile") await this.reconcile();
      else if (key === "deliver") await this.deliver();
      else if (key === "prune") {
        this.sql.exec("DELETE FROM members WHERE state = 'ended' AND ended_ms < ?", Date.now() - ENDED_RETENTION_MS);
        // A delivery a rolled-back release dropped (it has no handler for `deliver`) is armed again.
        if (this.backlog() && !this.deadlines.has("deliver")) await this.deadlines.set("deliver", Date.now());
        await this.recheckLive();
        if (this.record()) await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS);
      }
    });
  }

  /** Reservations older than `RESERVE_CHECK_MS`: dropped if the object was never created, else counted as it stands. */
  private async reconcile(): Promise<void> {
    const due = this.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM members WHERE state = 'reserved' AND created_ms <= ?",
      Date.now() - RESERVE_CHECK_MS).toArray();
    for (const r of due) {
      const exists = await this.exists(r.kind as MemberKind, r.id);
      // Re-read in this step: its own report may have landed during the await.
      if (exists === "gone") this.sql.exec("DELETE FROM members WHERE id = ? AND state = 'reserved'", r.id);
      else if (exists === "ended") this.sql.exec("UPDATE members SET state = 'ended', ended_ms = ? WHERE id = ? AND state = 'reserved'", Date.now(), r.id);
      else this.sql.exec("UPDATE members SET state = 'live' WHERE id = ? AND state = 'reserved'", r.id);
    }
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(created_ms) AS at FROM members WHERE state = 'reserved'").one().at;
    if (next !== null) await this.deadlines.set("reconcile", next + RESERVE_CHECK_MS);
  }

  /**
   * Live rows, oldest checked first (`RECHECK_PER_RUN` an hour), read against their objects: an end or
   * destroy whose report never came (a rollback ran meanwhile) frees its place within hours.
   */
  private async recheckLive(): Promise<void> {
    const rows = this.sql.exec<{ id: string; kind: string }>(
      "SELECT id, kind FROM members WHERE state = 'live' ORDER BY COALESCE(checked_ms, 0), created_ms LIMIT ?", RECHECK_PER_RUN).toArray();
    for (const r of rows) {
      const now = await this.exists(r.kind as MemberKind, r.id);
      // Re-read in this step: a report may have landed during the await (ended stays ended).
      if (now === "live") this.sql.exec("UPDATE members SET checked_ms = ? WHERE id = ?", Date.now(), r.id);
      else this.sql.exec("UPDATE members SET state = 'ended', ended_ms = ?, checked_ms = ? WHERE id = ? AND state = 'live'", Date.now(), Date.now(), r.id);
    }
  }

  /** Whether the object exists; a failure to ask counts as live, so nothing is forgotten. */
  private async exists(kind: MemberKind, id: string): Promise<"live" | "ended" | "gone"> {
    try {
      if (kind === "agent") {
        const v = await this.env.AGENT.get(this.env.AGENT.idFromName(id)).subtree();
        return v.ended ? "ended" : "live";
      }
      const s = await this.env.SANDBOX.get(this.env.SANDBOX.idFromName(id)).info();
      return s.state === "destroyed" ? "ended" : "live";
    } catch (e) {
      const code = asNestError(e)?.code;
      return code === ErrorCodes.UNKNOWN_AGENT || code === ErrorCodes.UNKNOWN_SANDBOX ? "gone" : "live";
    }
  }
}
