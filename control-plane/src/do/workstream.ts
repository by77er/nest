// WorkstreamDO: event fan-in for one workstream; decision events are batched into captain wakes
// (docs/control-plane/durable-objects/workstream/).
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { num, type Env } from "../env";
import { storedEnum } from "../lib/stored";
import { asNestError, NestError } from "../lib/util";
import { ErrorCodes, isDecisionEvent, type WorkstreamEvent } from "../protocol/model";

export interface WorkstreamInfo {
  workstream: string;
  goal: string;
  captain: string | null;
  created_ms: number;
}

const DIGEST_PROGRESS = 5;
// Retention (docs/data/#retention): `events` and `user_notifications` keep their most recent rows.
const EVENT_RETENTION = 5_000;
const NOTIFICATION_RETENTION = 1_000;

/** `user_notifications.urgency`. */
const NotificationUrgency = z.enum(["normal", "high"]);
type NotificationUrgency = z.output<typeof NotificationUrgency>;

/** Idempotency keys are kept a week, as long as a call's outcome. */
const APPLIED_RETENTION_MS = 7 * 86_400_000;

export class WorkstreamDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL,
      type TEXT NOT NULL, decision INTEGER NOT NULL, body TEXT NOT NULL, woke INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS user_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_ms INTEGER NOT NULL, urgency TEXT NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0)`);
    // Idempotency keys of writes already applied (a platform tool re-run after an eviction).
    this.sql.exec("CREATE TABLE IF NOT EXISTS applied (key TEXT PRIMARY KEY, ts_ms INTEGER NOT NULL)");
  }

  /** True the first time `key` is seen; a write with a key it has seen is skipped. */
  private firstTime(key: string | undefined): boolean {
    if (!key) return true;
    if (this.sql.exec("INSERT OR IGNORE INTO applied (key, ts_ms) VALUES (?, ?)", key, Date.now()).rowsWritten === 0) return false;
    this.sql.exec("DELETE FROM applied WHERE ts_ms < ?", Date.now() - APPLIED_RETENTION_MS);
    return true;
  }

  private info_(): WorkstreamInfo | undefined {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0];
    return row ? (JSON.parse(row.value) as WorkstreamInfo) : undefined;
  }

  private save(info: WorkstreamInfo): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('info', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(info));
  }

  async init(workstream: string, goal: string, captain: string | null): Promise<WorkstreamInfo> {
    const existing = this.info_();
    if (existing) return existing;
    const info = { workstream, goal, captain, created_ms: Date.now() };
    this.save(info);
    await this.ingest({ workstream, ts_ms: info.created_ms, type: "started", goal });
    return info;
  }

  async info(): Promise<WorkstreamInfo> {
    const info = this.info_();
    if (!info) throw new NestError(ErrorCodes.INVALID_MESSAGE, "unknown workstream", 404);
    return info;
  }

  async setCaptain(captain: string | null): Promise<void> {
    const info = await this.info();
    info.captain = captain;
    this.save(info);
  }

  /** Record an event; decision events schedule a (batched) captain wake. At most once per `key`. */
  async ingest(event: WorkstreamEvent, key?: string): Promise<void> {
    if (!this.firstTime(key)) return;
    const decision = isDecisionEvent(event);
    this.sql.exec("INSERT INTO events (ts_ms, type, decision, body) VALUES (?, ?, ?, ?)",
      event.ts_ms, event.type, decision ? 1 : 0, JSON.stringify(event));
    // Bounded history: keep the most recent events only.
    this.sql.exec("DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", EVENT_RETENTION);
    if (decision && this.info_()?.captain && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + num(this.env.WAKE_BATCH_MS, 2_000));
    }
  }

  async events(limit = 100): Promise<WorkstreamEvent[]> {
    return this.sql
      .exec<{ body: string }>("SELECT body FROM events ORDER BY id DESC LIMIT ?", limit)
      .toArray()
      .map((r) => JSON.parse(r.body) as WorkstreamEvent)
      .reverse();
  }

  async notifyUser(text: string, urgency: NotificationUrgency = "normal", key?: string): Promise<void> {
    if (!this.firstTime(key)) return;
    // Delivered by the Discord integration (out of scope here); kept as a durable queue.
    this.sql.exec("INSERT INTO user_notifications (ts_ms, urgency, text) VALUES (?, ?, ?)", Date.now(), urgency, text);
    this.sql.exec("DELETE FROM user_notifications WHERE id <= (SELECT MAX(id) FROM user_notifications) - ?", NOTIFICATION_RETENTION);
  }

  async userNotifications(): Promise<{ ts_ms: number; urgency: NotificationUrgency; text: string }[]> {
    return this.sql.exec<{ ts_ms: number; urgency: string; text: string }>(
      "SELECT ts_ms, urgency, text FROM user_notifications ORDER BY id").toArray()
      .map((n) => ({ ...n, urgency: storedEnum(NotificationUrgency, n.urgency, "user_notifications.urgency") }));
  }

  /** Batch window elapsed: wake the captain with one `event_batch` turn (decisions + recent progress). */
  override async alarm(): Promise<void> {
    const info = this.info_();
    if (!info?.captain) return;
    const pending = this.sql
      .exec<{ id: number; body: string; decision: number }>("SELECT id, body, decision FROM events WHERE woke = 0 ORDER BY id")
      .toArray();
    const decisions = pending.filter((e) => e.decision === 1);
    if (!decisions.length) return;
    const progress = pending.filter((e) => e.decision === 0).slice(-DIGEST_PROGRESS);
    const line = (b: string) => `- ${b}`;
    const text = [
      `Workstream ${info.workstream} (${info.goal}): ${decisions.length} event(s) need your attention.`,
      ...decisions.map((e) => line(e.body)),
      ...(progress.length ? ["Recent progress:", ...progress.map((e) => line(e.body))] : []),
    ].join("\n");
    try {
      await this.env.AGENT.get(this.env.AGENT.idFromName(info.captain)).enqueueTurn({ kind: "event_batch", text });
    } catch (e) {
      // A captain id that names no agent: keep the events for a real captain instead of retrying.
      if (asNestError(e)?.code === ErrorCodes.UNKNOWN_AGENT) {
        console.error(`workstream ${info.workstream}: captain ${info.captain} is not an agent; events wait`);
        return;
      }
      throw e;
    }
    const last = pending[pending.length - 1]!.id;
    this.sql.exec("UPDATE events SET woke = 1 WHERE id <= ?", last);
  }
}
