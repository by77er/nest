// An agent's turn queue and inbox (docs/control-plane/durable-objects/agent/; the model's Q1-Q4,
// docs/verification/agent-brain/). `TurnQueue` is the only code that touches the `turns`, `inbox`
// and `chan_wakes` tables; the decisions that need no storage are pure functions below it.

import { z } from "zod";
import type { InboxMessage, TurnInput } from "../protocol/control";
import { MAX_WAITING_DELIVERIES, WAKE_CAP_PER_HOUR } from "./channels";
import { addColumn, storedEnum } from "./stored";
import { newId } from "./util";

// Closed unions for the status columns (docs/data/#enums), checked on read (`storedEnum`).
const TurnStatusEnum = z.enum(["queued", "active", "done", "interrupted"]);
export type TurnStatus = z.output<typeof TurnStatusEnum>;
/** `inbox.status`: mirrored to the running turn, or consumed (by a turn, or as its own turn). */
const InboxStatusEnum = z.enum(["delivered", "consumed"]);
const TURN = TurnStatusEnum.enum;
const INBOX = InboxStatusEnum.enum;

const DEFER_RETRY_MS = 30_000;
export const MERGED_TURN_BYTES = 64 * 1024;
const HOUR_MS = 3_600_000;
/** Separates a recovery turn's notes from the original turn's text. */
export const RECOVERY_MARK = "\nThe turn was:\n";

/** The request id prefix of a channel delivery's turn or inbox row. */
const CHANNEL_REQUEST = "chan/";
export const channelRequestId = (channel: string, subscription: string, upTo: number) =>
  `${CHANNEL_REQUEST}${channel}/${subscription}/${upTo}`;

export interface QueuedTurn {
  turn: string;
  input: TurnInput;
  /** For a recovery turn, the interrupted turn it continues. */
  recovers: string | null;
}

/** When a turn started, and its sandbox's epoch then (null: not recorded). */
export interface TurnStart {
  started_ms: number;
  hands_epoch: number | null;
}

/** Channel-started turns and merges this hour (and the oldest's time), and channel turns waiting. */
export interface ChannelLoad {
  hour: number;
  oldest: number | null;
  waiting: number;
}

export class TurnQueue {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS turns (turn TEXT PRIMARY KEY, ord INTEGER NOT NULL, input TEXT NOT NULL,
      status TEXT NOT NULL, created_ms INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL, turn TEXT,
      status TEXT NOT NULL, created_ms INTEGER NOT NULL DEFAULT 0)`);
    addColumn(sql, "turns", "request_id", "TEXT");
    addColumn(sql, "turns", "started_ms", "INTEGER");
    // The sandbox's epoch at the turn's start (`moveNoteDue`), and the turn a recovery turn continues.
    addColumn(sql, "turns", "hands_epoch", "INTEGER");
    addColumn(sql, "turns", "recovers", "TEXT");
    addColumn(sql, "inbox", "request_id", "TEXT");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS turns_request ON turns (request_id) WHERE request_id IS NOT NULL");
    sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS inbox_request ON inbox (request_id) WHERE request_id IS NOT NULL");
    // Merged notices' wakes, counted toward the hourly cap like channel-started turns.
    sql.exec("CREATE TABLE IF NOT EXISTS chan_wakes (ts_ms INTEGER NOT NULL)");
  }

  // --- turns (Q1-Q4) ------------------------------------------------------------------------------

  turnFor(requestId: string): string | undefined {
    return this.sql.exec<{ turn: string }>("SELECT turn FROM turns WHERE request_id = ?", requestId).toArray()[0]?.turn;
  }

  /** Q1. */
  enqueue(input: TurnInput, requestId: string | null = null, now = Date.now()): string {
    return this.insert(input, this.ord("MAX") + 1, requestId, null, now);
  }

  hasQueued(): boolean {
    return this.sql.exec(`SELECT 1 FROM turns WHERE status = '${TURN.queued}' LIMIT 1`).toArray().length > 0;
  }

  /** Q2: the oldest queued turn becomes active (synchronously, so it is claimed once). */
  claimNext(now = Date.now()): QueuedTurn | undefined {
    const next = this.sql.exec<{ turn: string; input: string; recovers: string | null }>(
      `SELECT turn, input, recovers FROM turns WHERE status = '${TURN.queued}' ORDER BY ord LIMIT 1`).toArray()[0];
    if (!next) return undefined;
    this.sql.exec(`UPDATE turns SET status = '${TURN.active}', started_ms = ? WHERE turn = ?`, now, next.turn);
    return { turn: next.turn, input: JSON.parse(next.input) as TurnInput, recovers: next.recovers };
  }

  recordHandsEpoch(turn: string, epoch: number): void {
    this.sql.exec("UPDATE turns SET hands_epoch = ? WHERE turn = ?", epoch, turn);
  }

  startOf(turn: string): TurnStart | undefined {
    const r = this.sql.exec<{ started_ms: number | null; created_ms: number; hands_epoch: number | null }>(
      "SELECT started_ms, created_ms, hands_epoch FROM turns WHERE turn = ?", turn).toArray()[0];
    return r && { started_ms: r.started_ms ?? r.created_ms, hands_epoch: r.hands_epoch };
  }

  /**
   * Q3. Mirrored messages the runner never confirmed (`inbox_delivered`) come back as one queued turn:
   * first if one of them interrupted the turn (it was meant for now), else where the first of them
   * arrived: behind the queued turns created by then, ahead of those created later.
   */
  complete(turn: string, now = Date.now()): void {
    this.sql.exec(`UPDATE turns SET status = '${TURN.done}' WHERE turn = ?`, turn);
    const unseen = this.sql.exec<{ message: string; request_id: string | null; created_ms: number }>(
      `SELECT message, request_id, created_ms FROM inbox WHERE status = '${INBOX.delivered}' ORDER BY rowid`).toArray()
      .map((r) => ({ message: JSON.parse(r.message) as InboxMessage, request_id: r.request_id, created_ms: r.created_ms }));
    if (unseen.length) {
      const { input, requestId } = requeuedTurn(unseen);
      const ord = unseen.some((r) => r.message.interrupt) ? this.ord("MIN") - 1 : this.ordArrivedAt(Math.min(...unseen.map((r) => r.created_ms)));
      this.insert(input, ord, requestId, null, now, true);
    }
    this.sql.exec(`UPDATE inbox SET status = '${INBOX.consumed}' WHERE status = '${INBOX.delivered}'`);
  }

  /** Q4: `turn` was cut short by a restart; a recovery turn continuing it goes first, in the same step. */
  recover(turn: string, notes: string[], now = Date.now()): void {
    const row = this.sql.exec<{ input: string }>("SELECT input FROM turns WHERE turn = ?", turn).toArray()[0];
    this.sql.exec(`UPDATE turns SET status = '${TURN.interrupted}' WHERE turn = ?`, turn);
    if (!row) return;
    this.insert(recoveryInput(JSON.parse(row.input) as TurnInput, notes), this.ord("MIN") - 1, null, turn, now);
  }

  list(): { turn: string; status: TurnStatus; input: TurnInput }[] {
    return this.sql.exec<{ turn: string; status: string; input: string }>("SELECT turn, status, input FROM turns ORDER BY ord")
      .toArray()
      .map((r) => ({ turn: r.turn, status: storedEnum(TurnStatusEnum, r.status, "turns.status"), input: JSON.parse(r.input) as TurnInput }));
  }

  /** When the last turn started (or was queued, if none has started). */
  lastTurnMs(): number | null {
    return this.sql.exec<{ t: number | null }>("SELECT MAX(COALESCE(started_ms, created_ms)) AS t FROM turns").one().t;
  }

  // --- channel deliveries ---------------------------------------------------------------------------

  load(now = Date.now()): ChannelLoad {
    this.sql.exec("DELETE FROM chan_wakes WHERE ts_ms <= ?", now - HOUR_MS);
    const hour = this.sql.exec<{ n: number; oldest: number | null }>(
      `SELECT COUNT(*) AS n, MIN(t) AS oldest FROM (SELECT created_ms AS t FROM turns WHERE request_id LIKE '${CHANNEL_REQUEST}%' AND created_ms > ?
        UNION ALL SELECT ts_ms AS t FROM chan_wakes)`, now - HOUR_MS).one();
    const waiting = this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM turns WHERE request_id LIKE '${CHANNEL_REQUEST}%' AND status = '${TURN.queued}'`).one().n;
    return { hour: hour.n, oldest: hour.oldest, waiting };
  }

  /** The newest channel turn still waiting to start, which another notice may join. */
  waitingChannelTurn(): { turn: string; input: TurnInput } | undefined {
    const r = this.sql.exec<{ turn: string; input: string }>(
      `SELECT turn, input FROM turns WHERE status = '${TURN.queued}' AND request_id LIKE '${CHANNEL_REQUEST}%' ORDER BY ord DESC LIMIT 1`).toArray()[0];
    return r && { turn: r.turn, input: JSON.parse(r.input) as TurnInput };
  }

  merge(turn: string, input: TurnInput, now = Date.now()): void {
    this.sql.exec("UPDATE turns SET input = ? WHERE turn = ?", JSON.stringify(input), turn);
    this.sql.exec("INSERT INTO chan_wakes (ts_ms) VALUES (?)", now);
  }

  // --- inbox ----------------------------------------------------------------------------------------

  messageFor(requestId: string): string | undefined {
    return this.sql.exec<{ id: string }>("SELECT id FROM inbox WHERE request_id = ?", requestId).toArray()[0]?.id;
  }

  /** Mirrored to running turn `turn` until the runner confirms it or the turn ends. */
  mirror(message: InboxMessage, turn: string, requestId: string | null = null, now = Date.now()): void {
    this.sql.exec(`INSERT INTO inbox (id, message, turn, status, created_ms, request_id) VALUES (?, ?, ?, '${INBOX.delivered}', ?, ?)`,
      message.id, JSON.stringify(message), turn, now, requestId);
  }

  /** A message that becomes a turn of its own: kept as consumed, for its request id. */
  recordAsTurn(message: InboxMessage, requestId: string | null = null, now = Date.now()): void {
    this.sql.exec(`INSERT INTO inbox (id, message, turn, status, created_ms, request_id) VALUES (?, ?, NULL, '${INBOX.consumed}', ?, ?)`,
      message.id, JSON.stringify(message), now, requestId);
  }

  /** The runner showed mirrored message `id` to the model; whether it was still mirrored. */
  confirm(id: string): boolean {
    return this.sql.exec(`UPDATE inbox SET status = '${INBOX.consumed}' WHERE id = ? AND status = '${INBOX.delivered}'`, id).rowsWritten > 0;
  }

  mirrored(): InboxMessage[] {
    return this.sql.exec<{ message: string }>(`SELECT message FROM inbox WHERE status = '${INBOX.delivered}' ORDER BY rowid`)
      .toArray().map((r) => JSON.parse(r.message) as InboxMessage);
  }

  prune(cutoff: number): void {
    this.sql.exec(`DELETE FROM turns WHERE status IN ('${TURN.done}', '${TURN.interrupted}') AND created_ms < ?`, cutoff);
    this.sql.exec(`DELETE FROM inbox WHERE status = '${INBOX.consumed}' AND created_ms < ?`, cutoff);
  }

  private ord(edge: "MIN" | "MAX"): number {
    return this.sql.exec<{ m: number | null }>(`SELECT ${edge}(ord) AS m FROM turns`).toArray()[0]?.m ?? 0;
  }

  /**
   * The ord for a turn that arrived at `ms`: just behind the last queued turn created by then (or
   * ahead of every queued turn, none being that old). The turns from there on move back one.
   */
  private ordArrivedAt(ms: number): number {
    const q = this.sql.exec<{ before: number | null; first: number | null }>(
      `SELECT MAX(CASE WHEN created_ms <= ? THEN ord END) AS before, MIN(ord) AS first FROM turns WHERE status = '${TURN.queued}'`, ms).one();
    if (q.first === null) return this.ord("MAX") + 1;
    const ord = q.before === null ? q.first : q.before + 1;
    this.sql.exec("UPDATE turns SET ord = ord + 1 WHERE ord >= ?", ord);
    return ord;
  }

  private insert(input: TurnInput, ord: number, requestId: string | null, recovers: string | null, now: number, orIgnore = false): string {
    const turn = newId("trn_");
    const n = this.sql.exec(`INSERT ${orIgnore ? "OR IGNORE " : ""}INTO turns (turn, ord, input, status, created_ms, request_id, recovers)
      VALUES (?, ?, ?, '${TURN.queued}', ?, ?, ?)`, turn, ord, JSON.stringify(input), now, requestId, recovers).rowsWritten;
    return n > 0 || !requestId ? turn : this.turnFor(requestId)!;
  }
}

// --- decisions --------------------------------------------------------------------------------------

/** An inbox message as a turn of its own shows it (a message that arrived between turns). */
export const inboxTurnText = (m: Pick<InboxMessage, "from" | "text">) => `Message from ${m.from}: ${m.text}`;

/** Unconfirmed messages as one turn (all channel notices: an `event_batch`), keyed by the first so it is queued once. */
export function requeuedTurn(unseen: { message: InboxMessage; request_id: string | null }[]): { input: TurnInput; requestId: string } {
  const channel = (r: { request_id: string | null }) => r.request_id?.startsWith(CHANNEL_REQUEST) ?? false;
  const text = unseen.map((r) => (channel(r) ? r.message.text : inboxTurnText(r.message))).join("\n\n");
  const first = unseen[0]!;
  return { input: { kind: unseen.every(channel) ? "event_batch" : "inbox", text }, requestId: `${first.request_id ?? first.message.id}/requeued` };
}

/** `notes`, then the original turn's text (once, however often the recovery is itself interrupted). */
export function recoveryInput(interrupted: TurnInput, notes: string[]): TurnInput {
  const mark = interrupted.kind === "recovery" ? interrupted.text.indexOf(RECOVERY_MARK) : -1;
  const original = mark >= 0 ? interrupted.text.slice(mark + RECOVERY_MARK.length) : interrupted.text;
  return { kind: "recovery", text: `${notes.join(" ")}${RECOVERY_MARK}${original}` };
}

/**
 * Whether a turn starting now opens with what a sandbox move lost: a move since the brain was last
 * told (`told`), or, for a recovery turn, during the turn it continues (whose restart may have lost a
 * mid-turn notice). `epoch` is SandboxDO's now (null: unread; then only `movedMs` can say).
 */
export function moveNoteDue(f: { epoch: number | null; told: number | undefined; continued: TurnStart | undefined; movedMs: number | undefined }): boolean {
  const sinceTold = f.epoch !== null && f.told !== undefined && f.told !== f.epoch;
  if (sinceTold || !f.continued) return sinceTold;
  return f.epoch !== null && f.continued.hands_epoch !== null
    ? f.continued.hands_epoch !== f.epoch
    : (f.movedMs ?? 0) >= f.continued.started_ms;
}

/** A channel notice joins the running turn's inbox, merges into a waiting channel turn, queues, or defers (the channel retries). */
export type Admission =
  | { kind: "join" }
  | { kind: "merge"; turn: string; input: TurnInput }
  | { kind: "queue" }
  | { kind: "defer"; retry_after_ms: number };

/**
 * Mid-turn, only a notice from the agent's own inbox joins the running turn: anything else injected
 * into a busy turn can be passed over, spending a `once` subscription (3-12% of mention wakes in the
 * 2026-10-31 stress test, dev/cloud-checks/). The loop guards defer.
 */
export function admitDelivery(f: {
  midTurnInbox: boolean;
  load: ChannelLoad;
  waiting: { turn: string; input: TurnInput } | undefined;
  text: string;
  now: number;
}): Admission {
  if (f.midTurnInbox) return { kind: "join" };
  if (f.load.hour >= WAKE_CAP_PER_HOUR) return { kind: "defer", retry_after_ms: Math.max(1_000, (f.load.oldest ?? f.now) + HOUR_MS - f.now) };
  if (f.load.waiting >= MAX_WAITING_DELIVERIES) return { kind: "defer", retry_after_ms: DEFER_RETRY_MS };
  if (!f.waiting) return { kind: "queue" };
  const text = `${f.waiting.input.text}\n\n${f.text}`;
  if (new TextEncoder().encode(text).length > MERGED_TURN_BYTES) return { kind: "defer", retry_after_ms: DEFER_RETRY_MS };
  return { kind: "merge", turn: f.waiting.turn, input: { ...f.waiting.input, text } };
}
