// An agent's turn queue and inbox (docs/control-plane/durable-objects/agent/; the model's Q1-Q4,
// docs/verification/agent-brain/). `TurnQueue` is the only code that touches the `turns` and `inbox`
// tables; the decisions that need no storage are pure functions below it.

import { z } from "zod";
import type { InboxMessage, TurnInput } from "../protocol/control";
import { addColumn, storedEnum } from "./stored";
import { newId } from "./util";

// Closed unions for the status columns (docs/data/#enums), checked on read (`storedEnum`).
/** `dropped`: never run, or cut off, because the agent ended for good (docs/agents/#lifetimes). */
const TurnStatusEnum = z.enum(["queued", "active", "done", "interrupted", "dropped"]);
export type TurnStatus = z.output<typeof TurnStatusEnum>;
/** `inbox.status`: mirrored to the running turn, or consumed (by a turn, or as its own turn). */
const InboxStatusEnum = z.enum(["delivered", "consumed"]);
const TURN = TurnStatusEnum.enum;
const INBOX = InboxStatusEnum.enum;

// --- the ledgers' steps (pure) ------------------------------------------------------------------------

/**
 * What happens to a turn: `claim` (Q2, the pump takes it), `complete` (Q3), `recover` (Q4, cut short by a
 * restart), `drop` (the agent ended for good), `abandon` (an active row that isn't the agent's turn any
 * more, found by the prune).
 */
export const TURN_EVENTS = ["claim", "complete", "recover", "drop", "abandon"] as const;
export type TurnEvent = (typeof TURN_EVENTS)[number];
export const TURN_STATUSES = TurnStatusEnum.options;

/**
 * The turn ledger's one step: the status after `event`, or `refuse` when the event doesn't apply there.
 * `done`, `interrupted` and `dropped` are final: nothing moves a turn out of them. Every write to
 * `turns.status` goes through it (`TurnQueue.apply`), so no caller can skip a guard.
 */
export function turnStep(status: TurnStatus, event: TurnEvent): TurnStatus | "refuse" {
  if (status === "queued") return event === "claim" ? "active" : event === "drop" ? "dropped" : "refuse";
  if (status === "active") {
    return event === "complete" ? "done" : event === "recover" || event === "abandon" ? "interrupted" : event === "drop" ? "dropped" : "refuse";
  }
  return "refuse";
}

/** What happens to a mirrored message: the runner showed it (`confirm`), its turn ended, or it outlived its turn (`abandon`). */
export const INBOX_EVENTS = ["confirm", "turn_ended", "abandon"] as const;
export type InboxEvent = (typeof INBOX_EVENTS)[number];
export type InboxStatus = z.output<typeof InboxStatusEnum>;
export const INBOX_STATUSES = InboxStatusEnum.options;

/** The inbox mirror's one step: a delivered message is consumed by any of its events; a consumed one is final. */
export function inboxStep(status: InboxStatus, _event: InboxEvent): InboxStatus | "refuse" {
  return status === "delivered" ? "consumed" : "refuse";
}

/** Separates a recovery turn's notes from the original turn's text. */
export const RECOVERY_MARK = "\nThe turn was:\n";

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
  }

  /**
   * Apply `event` to the turns matching `where`, as `turnStep` decides for each one's status: a row whose
   * status refuses the event is left as it is. How many rows moved.
   */
  private apply(event: TurnEvent, where: string, ...args: SqlStorageValue[]): number {
    let n = 0;
    for (const from of TURN_STATUSES) {
      const to = turnStep(from, event);
      if (to !== "refuse") n += this.sql.exec(`UPDATE turns SET status = ? WHERE status = ? AND (${where})`, to, from, ...args).rowsWritten;
    }
    return n;
  }

  /** As `apply`, for mirrored messages (`inboxStep`). */
  private applyInbox(event: InboxEvent, where = "1", ...args: SqlStorageValue[]): number {
    let n = 0;
    for (const from of INBOX_STATUSES) {
      const to = inboxStep(from, event);
      if (to !== "refuse") n += this.sql.exec(`UPDATE inbox SET status = ? WHERE status = ? AND (${where})`, to, from, ...args).rowsWritten;
    }
    return n;
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

  queuedCount(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM turns WHERE status = '${TURN.queued}'`).one().n;
  }

  /** Q2: the oldest queued turn becomes active (synchronously, so it is claimed once). */
  claimNext(now = Date.now()): QueuedTurn | undefined {
    const next = this.sql.exec<{ turn: string; input: string; recovers: string | null }>(
      `SELECT turn, input, recovers FROM turns WHERE status = '${TURN.queued}' ORDER BY ord LIMIT 1`).toArray()[0];
    if (!next) return undefined;
    this.apply("claim", "turn = ?", next.turn);
    this.sql.exec("UPDATE turns SET started_ms = ? WHERE turn = ?", now, next.turn);
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
   * arrived: behind the queued turns created by then, ahead of those created later. Whether the turn was
   * active (one already done, cut short or dropped stays so; its unseen messages are requeued all the same).
   */
  complete(turn: string, now = Date.now()): boolean {
    const completed = this.apply("complete", "turn = ?", turn) > 0;
    const unseen = this.sql.exec<{ message: string; request_id: string | null; created_ms: number }>(
      `SELECT message, request_id, created_ms FROM inbox WHERE status = '${INBOX.delivered}' ORDER BY rowid`).toArray()
      .map((r) => ({ message: JSON.parse(r.message) as InboxMessage, request_id: r.request_id, created_ms: r.created_ms }));
    if (unseen.length) {
      const { input, requestId } = requeuedTurn(unseen);
      const ord = unseen.some((r) => r.message.interrupt) ? this.ord("MIN") - 1 : this.ordArrivedAt(Math.min(...unseen.map((r) => r.created_ms)));
      this.insert(input, ord, requestId, null, now, true);
    }
    this.applyInbox("turn_ended");
    return completed;
  }

  /**
   * Q4: `turn` was cut short by a restart; a recovery turn continuing it goes first, in the same step.
   * Only an active turn is recovered, once: one already done, interrupted or dropped gets no recovery
   * turn (asked twice, the second is nothing). Whether it was.
   */
  recover(turn: string, notes: string[], now = Date.now()): boolean {
    const row = this.sql.exec<{ input: string }>("SELECT input FROM turns WHERE turn = ?", turn).toArray()[0];
    if (!row || this.apply("recover", "turn = ?", turn) === 0) return false;
    this.insert(recoveryInput(JSON.parse(row.input) as TurnInput, notes), this.ord("MIN") - 1, null, turn, now);
    return true;
  }

  /**
   * The agent ended for good: every queued turn, and `active` (the turn it was in, once its brain is
   * gone), is dropped, and mirrored messages with them. How many turns went.
   */
  dropAll(active: string | null = null): number {
    const n = this.apply("drop", `status = '${TURN.queued}' OR turn = ?`, active ?? "");
    this.applyInbox("turn_ended");
    return n;
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
    return this.applyInbox("confirm", "id = ?", id) > 0;
  }

  mirrored(): InboxMessage[] {
    return this.sql.exec<{ message: string }>(`SELECT message FROM inbox WHERE status = '${INBOX.delivered}' ORDER BY rowid`)
      .toArray().map((r) => JSON.parse(r.message) as InboxMessage);
  }

  /**
   * Rows older than `cutoff` go once final. Rows that can't become final on their own are settled first,
   * by age, so none stays for ever: an `active` turn that isn't `current` (the agent's turn now) and
   * started before `cutoff` is abandoned (interrupted), and a message still mirrored to a turn that is no
   * longer active is consumed. Queued turns are work still to run: they stay until run or dropped.
   */
  prune(cutoff: number, current: string | null = null): void {
    this.apply("abandon", "turn <> ? AND COALESCE(started_ms, created_ms) < ?", current ?? "", cutoff);
    this.applyInbox("abandon", `created_ms < ? AND (turn IS NULL OR turn NOT IN (SELECT turn FROM turns WHERE status = '${TURN.active}'))`, cutoff);
    const final = TURN_STATUSES.filter((st) => TURN_EVENTS.every((e) => turnStep(st, e) === "refuse"));
    this.sql.exec(`DELETE FROM turns WHERE status IN (${final.map((st) => `'${st}'`).join(", ")}) AND created_ms < ?`, cutoff);
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

/** Unconfirmed messages as one turn, keyed by the first so it is queued once. */
export function requeuedTurn(unseen: { message: InboxMessage; request_id: string | null }[]): { input: TurnInput; requestId: string } {
  const text = unseen.map((r) => inboxTurnText(r.message)).join("\n\n");
  const first = unseen[0]!;
  return { input: { kind: "inbox", text }, requestId: `${first.request_id ?? first.message.id}/requeued` };
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
