// An agent's platform tool calls and asks (docs/control-plane/durable-objects/agent/, "Tool relay").
// `CallLedger` is the only code that touches the `tool_calls` and `asks` tables.

import { z } from "zod";
import type { ToolOutcome } from "../protocol/control";
import { storedEnum } from "./stored";

// Closed unions for the status columns (docs/data/#enums), checked on read (`storedEnum`).
/** `tool_calls.status`: running (re-run if redelivered after an eviction), waiting on an ask, or finished. */
const CallStatusEnum = z.enum(["dispatching", "waiting", "done"]);
export type CallStatus = z.output<typeof CallStatusEnum>;
/** `asks.status`: inside its sync window, a guest CLI's, answered as a turn later, or answered. */
const AskStatusEnum = z.enum(["sync", "cli", "async", "answered"]);
export type AskStatus = z.output<typeof AskStatusEnum>;
const CALL = CallStatusEnum.enum;
const ASK = AskStatusEnum.enum;

/** A call as stored: the epoch whose row and idempotency key it keeps. */
export interface StoredCall {
  epoch: number;
  status: CallStatus;
  outcome: ToolOutcome | null;
}

export interface StoredAsk {
  ask: string;
  call: string;
  epoch: number;
  question: string;
  status: AskStatus;
  deadline: number;
}

export class CallLedger {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS tool_calls (epoch INTEGER NOT NULL, call TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatching', outcome TEXT, created_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (epoch, call))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS asks (ask TEXT PRIMARY KEY, call TEXT NOT NULL, epoch INTEGER NOT NULL,
      question TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, answer TEXT, created_ms INTEGER NOT NULL DEFAULT 0)`);
  }

  /** By call id: one first seen at an earlier epoch keeps that epoch's row and key, so its writes never run twice. */
  call(call: string): StoredCall | undefined {
    const r = this.sql.exec<{ epoch: number; status: string; outcome: string | null }>(
      "SELECT epoch, status, outcome FROM tool_calls WHERE call = ? ORDER BY epoch LIMIT 1", call).toArray()[0];
    if (!r) return undefined;
    return { epoch: r.epoch, status: storedEnum(CallStatusEnum, r.status, "tool_calls.status"), outcome: r.outcome ? JSON.parse(r.outcome) as ToolOutcome : null };
  }

  begin(epoch: number, call: string, name: string): void {
    this.sql.exec(`INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (?, ?, ?, '${CALL.dispatching}', NULL, ?)`,
      epoch, call, name, Date.now());
  }

  /** The call waits for an ask; only from `dispatching` (an answer that came while it was routed finished it). */
  wait(epoch: number, call: string): void {
    this.sql.exec(`UPDATE tool_calls SET status = '${CALL.waiting}' WHERE epoch = ? AND call = ? AND status = '${CALL.dispatching}'`, epoch, call);
  }

  finish(epoch: number, call: string, outcome: ToolOutcome): void {
    this.sql.exec(`UPDATE tool_calls SET status = '${CALL.done}', outcome = ? WHERE epoch = ? AND call = ?`, JSON.stringify(outcome), epoch, call);
  }

  /** The runner gave up on the call: it never runs, and its ask's answer comes as a turn. A done call keeps its outcome. */
  cancel(epoch: number, call: string, outcome: ToolOutcome, prior: StoredCall | undefined): void {
    if (!prior) {
      this.sql.exec(`INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (?, ?, '', '${CALL.done}', ?, ?)`,
        epoch, call, JSON.stringify(outcome), Date.now());
    } else if (prior.status !== "done") {
      this.finish(epoch, call, outcome);
      this.sql.exec(`UPDATE asks SET status = '${ASK.async}' WHERE call = ? AND epoch = ? AND status = '${ASK.sync}'`, call, epoch);
    }
  }

  askOf(call: string, epoch: number): StoredAsk | undefined {
    return this.askWhere("call = ? AND epoch = ?", call, epoch);
  }

  ask(ask: string): StoredAsk | undefined {
    return this.askWhere("ask = ?", ask);
  }

  recordAsk(a: StoredAsk): void {
    this.sql.exec("INSERT INTO asks (ask, call, epoch, question, status, deadline, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      a.ask, a.call, a.epoch, a.question, a.status, a.deadline, Date.now());
  }

  /** Nothing waits for the ask any more (its sync window lapsed, or the guest CLI gave up): answered as a turn. */
  toAsync(ask: string, from: "sync" | "cli"): void {
    this.sql.exec(`UPDATE asks SET status = '${ASK.async}' WHERE ask = ? AND status = ?`, ask, from);
  }

  answer(ask: string, text: string): void {
    this.sql.exec(`UPDATE asks SET status = '${ASK.answered}', answer = ? WHERE ask = ?`, text, ask);
  }

  prune(cutoff: number): void {
    this.sql.exec(`DELETE FROM tool_calls WHERE status = '${CALL.done}' AND created_ms < ?`, cutoff);
    this.sql.exec(`DELETE FROM asks WHERE status = '${ASK.answered}' AND created_ms < ?`, cutoff);
  }

  private askWhere(where: string, ...args: SqlStorageValue[]): StoredAsk | undefined {
    const r = this.sql.exec<Omit<StoredAsk, "status"> & { status: string }>(
      `SELECT ask, call, epoch, question, status, deadline FROM asks WHERE ${where}`, ...args).toArray()[0];
    return r && { ...r, status: storedEnum(AskStatusEnum, r.status, "asks.status") };
  }
}

export type AskRoute = "already_answered" | "waiter" | "result" | "turn";

/**
 * An answer reaches the model whatever happened to the brain that asked: the guest CLI's waiter (lost
 * with an eviction), the call's result while it waits on the brain that asked (`callCurrent`: a new
 * lineage drops what the old one was sent), else the next turn.
 */
export function askRoute(status: AskStatus, waiter: boolean, callCurrent: boolean): AskRoute {
  if (status === "answered") return "already_answered";
  if (status === "cli" && waiter) return "waiter";
  if (status === "sync" && callCurrent) return "result";
  return "turn";
}
