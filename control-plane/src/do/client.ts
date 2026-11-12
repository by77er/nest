// ClientDO (docs/control-plane/api/clients/): one per API client, named by its id (`cli_…`), holding
// its record (name, grant, token hash), and the registry of its subtree: every agent and sandbox it
// owns, directly or through the agents it created, with their labels. The registry is what the grant's
// `max_agents` and `max_sandboxes` count and what the client lists. And its webhook, with the backlog
// of events its subtree's agents and sandboxes handed it, delivered one at a time from its alarm.
//
// One more instance, named `directory`, holds the names: unique, each mapped to its client's id with
// the client's phase (lib/client-names.ts: reserved, live, deleted; purged is no row), and the list of
// clients. Its alarm sweeps stale reservations and finishes deletes once their tombstone has aged.
//
// Each principal's idempotency keys for creates (lib/idempotency.ts) live here too: a client's in its
// own instance, the operator's in one more, named `operator`, which holds nothing else.
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
import {
  BACKLOG_MAX, checkWebhookUrl, type Delivery, type DeliveryEvent, deliveryStep, EVENT_MAX_AGE_MS, signature, type StampedEvent, WEBHOOK_TIMEOUT_MS,
} from "../lib/client-events";
import { num } from "../env";
import { healthRead, isHealthInstance } from "../lib/health";
import { type MemberEvent, MemberState, memberStep } from "../lib/members";
import { Deadlines } from "../lib/reliable";
import { IdempotencyKeys, type KeyClaim } from "../lib/idempotency";
import { addColumn, storedEnum } from "../lib/stored";
import {
  confirmDecision, type NameRow, nameRow, phaseOf, type ClientPhase, reserveDecision, RESERVE_TTL_MS, sweepDecision, sweepDueMs, tombstoneDecision,
  TOMBSTONE_MS,
} from "../lib/client-names";
import { asNestError, clip, hex, NestError, timingSafeEqual } from "../lib/util";
import { ErrorCodes } from "../protocol/model";
import type { ClientScope } from "./catalog";

/** The directory instance's name (client ids start `cli_`, the health instance `~`). */
export const CLIENT_DIRECTORY = "directory";
/** The instance holding the operator's idempotency keys, and nothing else. */
export const CLIENT_OPERATOR = "operator";
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

/** What the record holds (never shown whole: the token hash stays here). */
interface ClientRecord {
  client: string;
  name: string;
  grant: Grant;
  token_hash: string;
  created_ms: number;
  rotated_ms?: number;
  /** Bumped by every `setGrant` (absent: 0): what a copy of the grant elsewhere is compared by. */
  grant_rev?: number;
  /** What `grant_rev` counts within (random); given anew to a record without a revision. */
  grant_epoch?: string;
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
  /** Events dropped, ever: the oldest when the backlog was full, and any that waited 7 days undelivered. */
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

type Key = "reconcile" | "prune" | "deliver" | "sweep";

const notFound = () => new NestError(ErrorCodes.NOT_FOUND, "unknown client", 404);

export class ClientDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly deadlines!: Deadlines<Key>;
  private readonly directory: boolean = false;
  /** The operator's instance: idempotency keys only. */
  private readonly operatorKeys: boolean = false;
  private keys!: IdempotencyKeys;

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
      // The client's phase (`reserved`, `live`, `deleted`) and since when; a row from before them is live.
      addColumn(this.sql, "names", "phase", "TEXT");
      addColumn(this.sql, "names", "phase_ms", "INTEGER");
      this.deadlines = new Deadlines(this.sql, ctx.storage);
      return;
    }
    if (ctx.id.equals(env.CLIENT.idFromName(CLIENT_OPERATOR))) {
      // Its expired keys go at its claims (no alarm).
      this.operatorKeys = true;
      this.keys = new IdempotencyKeys(this.sql);
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
    // When the event was queued, for its age limit (`EVENT_MAX_AGE_MS`); null in a row from before the column.
    addColumn(this.sql, "outbox", "queued_ms", "INTEGER");
    this.keys = new IdempotencyKeys(this.sql);
  }

  // --- idempotency keys (lib/idempotency.ts): this principal's, in a client's instance or the operator's ---

  private requireKeys(): IdempotencyKeys {
    if (this.directory || !this.keys) throw new NestError(ErrorCodes.INTERNAL, "this instance holds no idempotency keys", 500);
    return this.keys;
  }

  /** Claim `key` for a create whose request digest is `digest`; `id` is what a new object would be named. */
  async claimKey(key: string, digest: string, id: string): Promise<KeyClaim> {
    return this.requireKeys().claim(key, digest, id);
  }

  /** The create under `key` was answered `status`. */
  /** `id`: the object the finishing request made (absent from a Worker of the previous release: not checked then). */
  async finishKey(key: string, status: number, id?: string): Promise<void> {
    this.requireKeys().finish(key, status, id);
  }

  /** The request holding `claim` failed; `free`: nothing was ever created under the key. */
  async abandonKey(key: string, claim: string, free: boolean): Promise<void> {
    this.requireKeys().abandon(key, claim, free);
  }

  // --- the directory -------------------------------------------------------------------------------

  private requireDirectory(): void {
    if (!this.directory) throw new NestError(ErrorCodes.INTERNAL, "not the client directory", 500);
  }

  private nameRows(where: string, ...args: (string | number)[]): NameRow[] {
    return this.sql.exec<{ name: string; client: string; created_ms: number; phase: string | null; phase_ms: number | null }>(
      `SELECT name, client, created_ms, phase, phase_ms FROM names WHERE ${where}`, ...args).toArray().map(nameRow);
  }

  private setPhase(r: NameRow, phase: NameRow["phase"], now: number): void {
    this.sql.exec("UPDATE names SET phase = ?, phase_ms = ? WHERE name = ? AND client = ?", phase, now, r.name, r.client);
  }

  /** The sweep runs when the earliest reservation or tombstone is due (armed in each writer's step). */
  private async armSweep(): Promise<void> {
    const due = this.nameRows("phase IN ('reserved', 'deleted')").map(sweepDueMs).filter((x): x is number => x !== null);
    if (due.length) await this.deadlines.set("sweep", Math.min(...due));
  }

  /**
   * Reserve `name` for client `client`, which is being created (`reserveDecision`): free, or another
   * client's stale reservation, it is taken; a retry by the same client finds it. Taken: 409, saying
   * when a deleted client's name is free again.
   */
  async reserveName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    const now = Date.now();
    const d = reserveDecision(this.nameRows("name = ?", name)[0], client, now);
    if (d.kind === "taken") {
      const when = d.free_ms !== null ? `; it is free again at ${new Date(d.free_ms).toISOString()}` : "";
      throw new NestError(ErrorCodes.CONFLICT, `a client named ${name} ${d.phase === "deleted" ? "was deleted" : d.phase === "reserved" ? "is being created" : "exists"}${when}`, 409);
    }
    if (d.kind === "insert") {
      this.sql.exec("INSERT INTO names (name, client, created_ms, phase, phase_ms) VALUES (?, ?, ?, 'reserved', ?)", name, client, now, now);
    } else if (d.kind === "takeover") {
      // That create died before answering, so its token was never out; its record purges itself at its next prune.
      this.sql.exec("UPDATE names SET client = ?, created_ms = ?, phase = 'reserved', phase_ms = ? WHERE name = ? AND client = ?", client, now, now, name, d.stale);
    }
    if (d.kind !== "held") await this.armSweep();
  }

  /**
   * The client's record exists: its reservation becomes live. Idempotent, so a create whose answer was
   * lost asks again and learns it is live. `lost` (taken over or deleted meanwhile): 409, and the create
   * must not hand out its token.
   */
  async confirmName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    const row = this.nameRows("name = ?", name)[0];
    const d = confirmDecision(row, client);
    if (d === "lost") throw new NestError(ErrorCodes.CONFLICT, `${client}'s reservation of ${name} was lost`, 409);
    if (d === "confirm") this.setPhase(row!, "live", Date.now());
  }

  /**
   * Compat, for one release (a Worker of the previous release mid-deploy): its create's claim, as a
   * reservation confirmed at once, and its delete's release, as a tombstone.
   */
  async claimName(name: string, client: string): Promise<void> {
    await this.reserveName(name, client);
    await this.confirmName(name, client);
  }
  async releaseName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    if (tombstoneDecision(this.nameRows("name = ?", name)[0], client) !== "none") await this.tombstoneName(name, client);
  }

  /** A create that failed before it confirmed gives its reservation back (only its own, only while reserved). */
  async abandonName(name: string, client: string): Promise<void> {
    this.requireDirectory();
    this.sql.exec("DELETE FROM names WHERE name = ? AND client = ? AND COALESCE(phase, 'live') = 'reserved'", name, client);
  }

  /**
   * A client's delete: its name becomes a tombstone (`deleted`), held `TOMBSTONE_MS`, then the sweep
   * deletes once more what late requests may have written and frees the name. Answers when it is free.
   */
  async tombstoneName(name: string, client: string): Promise<{ free_ms: number }> {
    this.requireDirectory();
    const row = this.nameRows("name = ?", name)[0];
    const d = tombstoneDecision(row, client);
    if (d === "none") throw new NestError(ErrorCodes.NOT_FOUND, `${name} isn't ${client}'s`, 404);
    if (d === "tombstone") {
      this.setPhase(row!, "deleted", Date.now());
      await this.armSweep();
    }
    return { free_ms: this.nameRows("name = ?", name)[0]!.phase_ms + TOMBSTONE_MS };
  }

  /** The row of client `client`, whatever its phase (a delete whose record is already gone finds its name here). */
  async nameOf(client: string): Promise<{ name: string; phase: ClientPhase } | null> {
    this.requireDirectory();
    const r = this.nameRows("client = ?", client)[0];
    return r ? { name: r.name, phase: r.phase } : null;
  }

  /** Client `client`'s phase under `name`: `purged` when the name isn't (or is no longer) its. */
  async phaseOf(name: string, client: string): Promise<ClientPhase> {
    this.requireDirectory();
    return phaseOf(this.nameRows("name = ? AND client = ?", name, client)[0]);
  }

  /** Every client, by name, with its phase. */
  async names(): Promise<{ name: string; client: string; created_ms: number; phase: ClientPhase; phase_ms: number }[]> {
    this.requireDirectory();
    return this.nameRows("1 ORDER BY name");
  }

  /** The live client named `name`, if any (a reserved or deleted one owns no namespace). */
  async lookup(name: string): Promise<string | null> {
    this.requireDirectory();
    const r = this.nameRows("name = ?", name)[0];
    return r && r.phase === "live" ? r.client : null;
  }

  /**
   * The sweep: a stale reservation goes (its create died; its record purges itself); a tombstone past
   * `TOMBSTONE_MS` has its client's namespace, secrets and record deleted once more, then goes, and the
   * name is free. Each row is re-read before it is removed, in that step.
   */
  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const r of this.nameRows("phase IN ('reserved', 'deleted')")) {
      const d = sweepDecision(r, now);
      if (d === "drop_reservation") {
        this.sql.exec("DELETE FROM names WHERE name = ? AND client = ? AND phase = 'reserved' AND phase_ms = ?", r.name, r.client, r.phase_ms);
      } else if (d === "finish_delete") {
        await this.env.CATALOG.get(this.env.CATALOG.idFromName("catalog")).deleteNamespace(r.name);
        await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).deleteClientSecrets(r.client);
        await this.env.CLIENT.get(this.env.CLIENT.idFromName(r.client)).purge();
        this.sql.exec("DELETE FROM names WHERE name = ? AND client = ? AND phase = 'deleted'", r.name, r.client);
      }
    }
    await this.armSweep();
  }

  // --- the record ----------------------------------------------------------------------------------

  private requireClient(): void {
    if (this.directory || this.operatorKeys) throw new NestError(ErrorCodes.INTERNAL, "this instance is not a client", 500);
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
    return { client: r.client, name: r.name, grant: r.grant, ...this.revisioned(r) };
  }

  /** Its name and grant, for a spawn in its subtree (403 once deleted: nothing more is created for it). */
  async scope(): Promise<ClientScope> {
    const r = this.record();
    if (!r || r.deleted_ms) throw new NestError(ErrorCodes.FORBIDDEN, "the client this agent belongs to was deleted", 403);
    return { client: r.client, name: r.name, grant: r.grant, ...this.revisioned(r) };
  }

  /**
   * The record's grant revision and its epoch. A record without either (from before them, or one that lost
   * its revision) gets a new epoch at revision 0, saved: a copy elsewhere then treats it as newer than
   * anything of the old epoch, so a narrowing is never ignored while a lost counter catches up.
   */
  private revisioned(r: ClientRecord): { grant_rev: number; grant_epoch: string } {
    if (r.grant_rev === undefined || r.grant_epoch === undefined) {
      r.grant_rev = 0;
      r.grant_epoch = crypto.randomUUID();
      this.save(r);
    }
    return { grant_rev: r.grant_rev, grant_epoch: r.grant_epoch };
  }

  /** Replace the grant. What runs keeps running; every later create, spawn and expansion is held to the new one. */
  async setGrant(grant: Grant): Promise<ClientView> {
    const r = this.live();
    r.grant = grant;
    this.revisioned(r);
    r.grant_rev = r.grant_rev! + 1;
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
    if (this.memberState(m.id) !== "none") return;
    if (!r.grant.cells.includes(m.cell)) throw new NestError(ErrorCodes.FORBIDDEN, `outside ${r.client}'s grant: cell ${m.cell}`, 403);
    const kinds = m.kind === "agent" ? "agents" : "sandboxes";
    const max = m.kind === "agent" ? r.grant.max_agents : r.grant.max_sandboxes;
    // None at all is the grant's refusal for good; a full count is a wait for one of them to end (`at_capacity`).
    if (max === 0) throw new NestError(ErrorCodes.FORBIDDEN, `outside ${r.client}'s grant: max_${kinds} is 0`, 403);
    const n = this.count(m.kind);
    if (n >= max) throw new NestError(ErrorCodes.AT_CAPACITY, `max_${kinds}: ${r.client} has ${n} live ${kinds}, its grant's max_${kinds} (${max}); there is room once fewer than ${max} are live`, 429, true);
    this.move(m.id, "admit", { facts: m });
    await this.deadlines.set("reconcile", Date.now() + RESERVE_CHECK_MS, true);
  }

  /** A create that failed for good: its place, if still only reserved, goes back. */
  async release(id: string): Promise<void> {
    this.move(id, "release");
  }

  private memberState(id: string): MemberState | "none" {
    const r = this.sql.exec<{ state: string }>("SELECT state FROM members WHERE id = ?", id).toArray()[0];
    return r ? storedEnum(MemberState, r.state, "members.state") : "none";
  }

  /**
   * Apply `event` to member `id` as `memberStep` decides for its state now, read in this step (so a
   * caller that awaited since it last looked can't act on what it saw then). Whether anything changed.
   * `facts`: the row's columns, for an event that may create it; `endedMs`: when it ended, if the event
   * says (else now).
   */
  private move(id: string, event: MemberEvent, o: { facts?: MemberFacts; endedMs?: number | null } = {}): boolean {
    const from = this.memberState(id);
    const to = memberStep(from, event);
    if (to === "refuse") return false;
    const now = Date.now();
    const ended = to === "ended" ? o.endedMs ?? now : null;
    if (to === "none") {
      this.sql.exec("DELETE FROM members WHERE id = ?", id);
    } else if (from === "none") {
      const m = o.facts;
      if (!m) return false;
      this.sql.exec("INSERT INTO members (id, kind, cell, owner, labels, created_ms, state, ended_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        m.id, m.kind, m.cell, m.owner, JSON.stringify(m.labels), now, to, ended);
    } else {
      this.sql.exec("UPDATE members SET state = ?, ended_ms = ? WHERE id = ?", to, ended, id);
    }
    return true;
  }

  /**
   * An agent or sandbox of the subtree reports itself (from its alarm, retried until this answers):
   * live, or ended. Ended is final. One never admitted (a row the reconcile dropped) is recorded too,
   * so the count never misses one that exists.
   */
  async report(m: MemberFacts & { ended_ms: number | null }): Promise<void> {
    // A purged client keeps no registry: a report retried after the purge is answered and recorded nowhere
    // (it used to leave a row in an empty object that no alarm would ever remove).
    if (!this.record()) return;
    this.move(m.id, m.ended_ms === null ? "report_live" : "report_ended", { facts: m, endedMs: m.ended_ms });
  }

  /** A page of its agents or sandboxes, oldest first, filtered by labels (each must hold), state and cell. */
  async list(kind: MemberKind, q: ListQuery = {}): Promise<{ items: Member[]; next_cursor: string | null }> {
    this.requireClient();
    // An integer, whoever calls (it reaches SQL LIMIT): anything else is the default.
    const limit = Number.isSafeInteger(q.limit) ? Math.min(Math.max(q.limit!, 1), 500) : 100;
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

  /** The `outbox.seq` of the event an attempt is out for right now (memory: a reset ends the attempt too). */
  private delivering: number | null = null;

  private delivery(): Delivery {
    return this.kv<Delivery>("delivery") ?? { failures: 0, dropped: 0 };
  }

  /** Apply `event` to the delivery state as it is in this step (`deliveryStep`), and say when the next attempt is due. */
  private deliveryEvent(event: DeliveryEvent): "now" | "keep" | number {
    const { delivery, next } = deliveryStep(this.delivery(), event);
    this.kvPut("delivery", delivery);
    return next;
  }

  /**
   * Events that waited `EVENT_MAX_AGE_MS` for a receiver that never took them are dropped and counted, so
   * none waits for ever. A row from before `queued_ms` starts its wait now.
   */
  private dropOldEvents(now = Date.now()): void {
    // A row with no time was queued before every row after it: it takes the earliest time among those
    // (else now), so the queue's order is its age's order and an older event never outlives a newer one.
    this.stampLegacyEvents(now);
    // No attempt is out now: this runs from the alarm, as `deliver` does, and alarm handlers don't overlap.
    const n = this.sql.exec("DELETE FROM outbox WHERE queued_ms <= ?", now - EVENT_MAX_AGE_MS).rowsWritten;
    if (n) {
      this.deliveryEvent({ kind: "dropped", n });
      console.warn(`client ${this.record()?.client ?? "?"}: dropped ${n} events that waited ${EVENT_MAX_AGE_MS / 86_400_000} days undelivered`);
    }
  }

  /**
   * Give each row with no `queued_ms` the earliest time among the rows after it, else `now`. One pass from
   * the newest row down with a running minimum, and one UPDATE per run of rows that take the same time:
   * a backlog a previous release left (every row without a time, ahead of every row with one) is one
   * UPDATE, where a subquery per row would be quadratic in the backlog.
   */
  private stampLegacyEvents(now: number): void {
    if (!this.sql.exec("SELECT 1 FROM outbox WHERE queued_ms IS NULL LIMIT 1").toArray().length) return;
    let earliest: number | null = null;
    let run: { lo: number; hi: number; at: number } | null = null;
    const flush = () => {
      if (run) this.sql.exec("UPDATE outbox SET queued_ms = ? WHERE queued_ms IS NULL AND seq BETWEEN ? AND ?", run.at, run.lo, run.hi);
      run = null;
    };
    for (const r of this.sql.exec<{ seq: number; queued_ms: number | null }>("SELECT seq, queued_ms FROM outbox ORDER BY seq DESC")) {
      if (r.queued_ms !== null) {
        // Rows before this one take this time if it is the earliest so far (a new run starts at the next such row).
        if (earliest === null || r.queued_ms < earliest) earliest = r.queued_ms;
        continue;
      }
      const at: number = earliest ?? now;
      if (run && run.at === at) run.lo = r.seq;
      else {
        flush();
        run = { lo: r.seq, hi: r.seq, at };
      }
    }
    flush();
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
    this.deliveryEvent({ kind: "webhook_set" });
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
    for (const ev of events) this.sql.exec("INSERT OR IGNORE INTO outbox (id, body, queued_ms) VALUES (?, ?, ?)", ev.id, JSON.stringify(ev), Date.now());
    const over = this.backlog() - BACKLOG_MAX;
    if (over > 0) {
      // The oldest go, but never the event being sent right now: it is about to be delivered, and counting
      // it dropped would be wrong. The cap still holds (the rows deleted are as many).
      const n = this.sql.exec("DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox WHERE seq != ? ORDER BY seq LIMIT ?)", this.delivering ?? -1, over).rowsWritten;
      this.deliveryEvent({ kind: "dropped", n });
      console.warn(`client ${r.client}: its event backlog is full; dropped the ${n} oldest`);
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
      this.delivering = row.seq;
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
      } finally {
        this.delivering = null;
      }
      // Re-read in this step: a new webhook set during the attempt starts its own schedule.
      if (this.kv<Webhook>("webhook")?.set_ms !== hook.set_ms) continue;
      if (error === null) {
        this.sql.exec("DELETE FROM outbox WHERE seq = ?", row.seq);
        this.deliveryEvent({ kind: "delivered" });
        continue;
      }
      // The wait runs from the failure: an attempt cut off at the timeout is retried 1 s after that.
      const now = Date.now();
      const wait = this.deliveryEvent({ kind: "failed", error, now });
      await this.deadlines.set("deliver", now + (typeof wait === "number" ? wait : 0));
      return;
    }
    if (this.backlog()) await this.deadlines.set("deliver", Date.now());
  }

  // --- alarms --------------------------------------------------------------------------------------

  override async alarm(): Promise<void> {
    if (this.operatorKeys) return;
    if (this.directory) {
      await this.deadlines.runDue(Date.now(), async (key) => {
        if (key === "sweep") await this.sweep();
      });
      return;
    }
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "reconcile") await this.reconcile();
      else if (key === "deliver") await this.deliver();
      else if (key === "prune") {
        for (const r of this.sql.exec<{ id: string }>("SELECT id FROM members WHERE ended_ms < ?", Date.now() - ENDED_RETENTION_MS).toArray()) this.move(r.id, "expire");
        this.keys.prune();
        this.dropOldEvents();
        // A delivery a rolled-back release dropped (it has no handler for `deliver`) is armed again.
        if (this.backlog() && !this.deadlines.has("deliver")) await this.deadlines.set("deliver", Date.now());
        await this.recheckLive();
        if (await this.orphaned()) return;
        // A deleted record waits for its purge (the delete's, or the directory's sweep), not the hour.
        const r = this.record();
        if (r && !r.deleted_ms) await this.deadlines.set("prune", Date.now() + PRUNE_EVERY_MS);
      }
    });
  }

  /**
   * A record the directory doesn't hold under its name (`purged` there: its create died before
   * confirming and the reservation went, or a delete from before phases released the name and stopped)
   * purges itself, unless anything of its subtree lives. Its token was never handed out, or it was
   * deleted. True when it did; a directory that can't say (a release without phases) keeps it.
   */
  private async orphaned(): Promise<boolean> {
    const r = this.record();
    if (!r || Date.now() - r.created_ms < RESERVE_TTL_MS) return false;
    let phase: ClientPhase;
    try {
      phase = await this.env.CLIENT.get(this.env.CLIENT.idFromName(CLIENT_DIRECTORY)).phaseOf(r.name, r.client);
    } catch (e) {
      console.warn(`client ${r.client}: asking the directory for its phase failed`, e);
      return false;
    }
    // Re-read in this step: a member admitted meanwhile keeps it.
    if (phase !== "purged" || this.count("agent") || this.count("sandbox")) return false;
    console.log(`client ${r.client}: no directory row for ${r.name}; an orphan record, purged`);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.schema();
    return true;
  }

  /** Reservations older than `RESERVE_CHECK_MS`: dropped if the object was never created, else counted as it stands. */
  private async reconcile(): Promise<void> {
    const due = this.sql.exec<{ id: string; kind: string }>("SELECT id, kind FROM members WHERE state = 'reserved' AND created_ms <= ?",
      Date.now() - RESERVE_CHECK_MS).toArray();
    for (const r of due) {
      const exists = await this.exists(r.kind as MemberKind, r.id);
      // Re-read in this step: its own report may have landed during the await.
      // A reservation is all this looked at: a row that is live by now is the recheck's to judge, not this one's.
      if (this.memberState(r.id) === "reserved") this.move(r.id, `check_${exists}`);
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
      // A live row is all this looked at: one that went and was admitted again meanwhile is the reconcile's.
      if (now !== "live" && this.memberState(r.id) === "live") this.move(r.id, `check_${now}`);
      this.sql.exec("UPDATE members SET checked_ms = ? WHERE id = ?", Date.now(), r.id);
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
