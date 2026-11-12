// An agent's platform tool calls and asks (docs/control-plane/durable-objects/agent/, "Tool relay").
// `CallLedger` is the only code that touches the `tool_calls`, `asks` and `approvals` tables.

import { z } from "zod";
import type { ToolOutcome } from "../protocol/control";
import { INPUT_KEPT_BYTES } from "./sinks";
import { addColumn, storedEnum } from "./stored";

// Closed unions for the status columns (docs/data/#enums), checked on read (`storedEnum`).
/** `tool_calls.status`: running (re-run if redelivered after an eviction), waiting on an ask, or finished. */
const CallStatusEnum = z.enum(["dispatching", "waiting", "done"]);
export type CallStatus = z.output<typeof CallStatusEnum>;
/**
 * `asks.status`: waiting for the operator (answered as a turn), or answered. `sync` (a call waiting inside
 * its window) and `cli` (a guest `nest ask` waiting) were the `ask` tool's, which left the platform: only
 * rows the previous release wrote have them.
 */
const AskStatusEnum = z.enum(["sync", "cli", "async", "answered"]);
export type AskStatus = z.output<typeof AskStatusEnum>;
/** `approvals.status`: a held call waiting for the operator, or the operator's decision. */
const ApprovalStatusEnum = z.enum(["pending", "approved", "denied"]);
/**
 * `approvals.kind`: what held the call. `sink`: the sink gate (docs/agents/tools/#taint-and-sinks); its
 * approval expires. `rule`: a tool rule in `ask` mode, checked by the runner's `PreToolUse` hook
 * (`approval_check`); its approval never expires (the operator may answer whenever). NULL in rows written
 * before the column: a sink's.
 */
const ApprovalKindEnum = z.enum(["sink", "rule"]);
export type ApprovalKind = z.output<typeof ApprovalKindEnum>;
const CALL = CallStatusEnum.enum;
const ASK = AskStatusEnum.enum;
const APPROVAL = ApprovalStatusEnum.enum;
/** `approvals.kind` as read: a row from before the column is a sink's. */
const KIND = "COALESCE(kind, 'sink')";

// --- the ledgers' steps (pure) ------------------------------------------------------------------------

/**
 * What happens to a call: it waits on an ask (`wait`), gets its outcome (`finish`), is given up by the
 * runner (`cancel`). (One that never finished is deleted by age, with the rest: `prune`.)
 */
export const CALL_EVENTS = ["wait", "finish", "cancel"] as const;
export type CallEvent = (typeof CALL_EVENTS)[number];
export const CALL_STATUSES = CallStatusEnum.options;

/**
 * The call ledger's one step: the status after `event`, or `refuse` when it doesn't apply there. `done`
 * is final: a finished call keeps its outcome whatever comes later (a second finish, a cancel). Every
 * change of `tool_calls.status` goes through it (`CallLedger.applyCall`).
 */
export function callStep(status: CallStatus, event: CallEvent): CallStatus | "refuse" {
  if (status === "dispatching") return event === "wait" ? "waiting" : "done";
  if (status === "waiting") return event === "wait" ? "refuse" : "done";
  return "refuse";
}

/** What happens to an ask: nothing waits inside a call for it any more (`detach`), or it is answered. */
export const ASK_EVENTS = ["detach", "answer"] as const;
export type AskEvent = (typeof ASK_EVENTS)[number];
export const ASK_STATUSES = AskStatusEnum.options;

/** The ask ledger's one step. `answered` is final: the first answer stands. */
export function askStep(status: AskStatus, event: AskEvent): AskStatus | "refuse" {
  if (status === "answered") return "refuse";
  if (event === "answer") return "answered";
  return status === "async" ? "refuse" : "async";
}

export const APPROVAL_EVENTS = ["approve", "deny"] as const;
export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];
export type ApprovalStatus = z.output<typeof ApprovalStatusEnum>;
export const APPROVAL_STATUSES = ApprovalStatusEnum.options;

/** The approval ledger's one step: only a pending approval is decided, once. */
export function approvalStep(status: ApprovalStatus, event: ApprovalEvent): ApprovalStatus | "refuse" {
  if (status !== "pending") return "refuse";
  return event === "approve" ? "approved" : "denied";
}

/**
 * Whether an approval may be spent on the call key `key` at `nowMs`: approved, not expired (a rule's
 * never expires; a sink's is usable only before its expiry, and one with none never is), and unspent.
 * A sink's already spent on this same key is usable again (that call's redelivery); a rule's never is
 * (the runner never sends a check twice, so a repeated key is no redelivery). One approval, one call.
 */
export function approvalUsable(
  a: { status: ApprovalStatus; kind: ApprovalKind; expires_ms: number | null; used_by: string | null }, key: string, nowMs: number,
): boolean {
  const unexpired = a.kind === "rule" || (a.expires_ms !== null && a.expires_ms > nowMs);
  return a.status === "approved" && unexpired && (a.used_by === null || (a.kind === "sink" && a.used_by === key));
}

/** When an approval decided at `decidedMs` expires: a sink's after `sinkTtlMs`, a rule's never (null). */
export function approvalExpiry(kind: ApprovalKind, decidedMs: number, sinkTtlMs: number): number | null {
  return kind === "rule" ? null : decidedMs + sinkTtlMs;
}

/** A call as stored: the epoch whose row and idempotency key it keeps. */
export interface StoredCall {
  epoch: number;
  status: CallStatus;
  outcome: ToolOutcome | null;
}

/**
 * A held call's approval, for exactly these arguments (`digest`). A sink's (docs/agents/tools/#taint-and-sinks)
 * is for one sink (`name`: a remote MCP tool `<capability>_<tool>`, a brokered action, `egress_policy`); a
 * rule's for one Claude Code tool (`name` = `tool`, e.g. `WebFetch`). `tool` is the model-facing tool to
 * call again (null in rows written before it was kept: a remote MCP tool's).
 */
export interface Approval {
  ask: string;
  name: string;
  digest: string;
  tool: string | null;
  kind: ApprovalKind;
  status: z.output<typeof ApprovalStatusEnum>;
}

export interface StoredAsk {
  ask: string;
  call: string;
  epoch: number;
  question: string;
  status: AskStatus;
  deadline: number;
}

/** An ask waiting for the operator, as `GET /v1/agents/:agent/asks` lists it. */
export interface OpenAsk {
  ask: string;
  question: string;
  created_ms: number;
  /** For an approval: the sink and the model-facing tool it holds (`tool` null in rows from before it was kept). */
  approval?: { name: string; tool: string | null };
  /**
   * For an approval: the held call's whole input, as approved (canonical JSON, parsed), and its size.
   * `input` is left out past `INPUT_KEPT_BYTES`, and in rows from before it was kept (`input_bytes` too).
   */
  input?: unknown;
  input_bytes?: number;
}

export class CallLedger {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS tool_calls (epoch INTEGER NOT NULL, call TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'dispatching', outcome TEXT, created_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (epoch, call))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS asks (ask TEXT PRIMARY KEY, call TEXT NOT NULL, epoch INTEGER NOT NULL,
      question TEXT NOT NULL, status TEXT NOT NULL, deadline INTEGER NOT NULL, answer TEXT, created_ms INTEGER NOT NULL DEFAULT 0)`);
    // `used_by`: the call key an approval was spent on (its redelivery may use it again, nothing else).
    sql.exec(`CREATE TABLE IF NOT EXISTS approvals (ask TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL,
      status TEXT NOT NULL, expires_ms INTEGER, used_by TEXT, created_ms INTEGER NOT NULL)`);
    // The tool the model calls again once approved (null: a remote MCP tool's, `mcp__nest__<name>`).
    addColumn(sql, "approvals", "tool", "TEXT");
    // What held the call (`ApprovalKindEnum`); NULL: a sink's, from before the column.
    addColumn(sql, "approvals", "kind", "TEXT");
    // The held call's input as approved (canonical JSON, NULL past `INPUT_KEPT_BYTES`) and its size: the operator's to read in full.
    addColumn(sql, "approvals", "input", "TEXT");
    addColumn(sql, "approvals", "input_bytes", "INTEGER");
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

  /**
   * Apply `event` to the calls matching `where`, as `callStep` decides for each one's status: a row whose
   * status refuses the event is left as it is. An event that ends a call stores `outcome` with it. How
   * many rows moved.
   */
  private applyCall(event: CallEvent, outcome: ToolOutcome | null, where: string, ...args: SqlStorageValue[]): number {
    let n = 0;
    for (const from of CALL_STATUSES) {
      const to = callStep(from, event);
      if (to === "refuse") continue;
      n += to === CALL.done
        ? this.sql.exec(`UPDATE tool_calls SET status = ?, outcome = ? WHERE status = ? AND (${where})`, to, JSON.stringify(outcome), from, ...args).rowsWritten
        : this.sql.exec(`UPDATE tool_calls SET status = ? WHERE status = ? AND (${where})`, to, from, ...args).rowsWritten;
    }
    return n;
  }

  /** As `applyCall`, for asks (`askStep`). */
  private applyAsk(event: AskEvent, answer: string | null, where: string, ...args: SqlStorageValue[]): number {
    let n = 0;
    for (const from of ASK_STATUSES) {
      const to = askStep(from, event);
      if (to === "refuse") continue;
      n += to === ASK.answered
        ? this.sql.exec(`UPDATE asks SET status = ?, answer = ? WHERE status = ? AND (${where})`, to, answer, from, ...args).rowsWritten
        : this.sql.exec(`UPDATE asks SET status = ? WHERE status = ? AND (${where})`, to, from, ...args).rowsWritten;
    }
    return n;
  }

  /**
   * A call still dispatching is dispatched again (its message was redelivered after an eviction): its
   * row counts as begun now, so the prune can't take it for an old one and delete it under the dispatch
   * (the outcome would then be stored nowhere and never sent).
   */
  redispatch(epoch: number, call: string): void {
    this.sql.exec(`UPDATE tool_calls SET created_ms = ? WHERE epoch = ? AND call = ? AND status = '${CALL.dispatching}'`, Date.now(), epoch, call);
  }

  /** The call waits for an ask; only from `dispatching` (an answer that came while it was routed finished it). Whether it does. */
  wait(epoch: number, call: string): boolean {
    return this.applyCall("wait", null, "epoch = ? AND call = ?", epoch, call) > 0;
  }

  /** The call's outcome, once: a call already done keeps the outcome it has. Whether this one was stored. */
  finish(epoch: number, call: string, outcome: ToolOutcome): boolean {
    return this.applyCall("finish", outcome, "epoch = ? AND call = ?", epoch, call) > 0;
  }

  /** The runner gave up on the call: it never runs, and its ask's answer comes as a turn. A done call keeps its outcome. */
  cancel(epoch: number, call: string, outcome: ToolOutcome, prior: StoredCall | undefined): void {
    if (!prior) {
      this.sql.exec(`INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (?, ?, '', '${CALL.done}', ?, ?)`,
        epoch, call, JSON.stringify(outcome), Date.now());
    } else if (this.applyCall("cancel", outcome, "epoch = ? AND call = ?", epoch, call) > 0) {
      this.applyAsk("detach", null, `call = ? AND epoch = ? AND status = '${ASK.sync}'`, call, epoch);
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
  toAsync(ask: string, from: "sync" | "cli"): boolean {
    return this.applyAsk("detach", null, "ask = ? AND status = ?", ask, from) > 0;
  }

  /** The ask's answer, once: an answered ask keeps the answer it has. Whether this one was stored. */
  answer(ask: string, text: string): boolean {
    return this.applyAsk("answer", text, "ask = ?", ask) > 0;
  }

  /**
   * Asks not yet answered, oldest first, with the approval each one decides (if any); the first `limit` when
   * given. `input: false` leaves every `input` out (its `input_bytes` stays): `GET /v1/asks` reads inputs apart.
   */
  open(limit?: number, o: { input?: boolean } = {}): OpenAsk[] {
    const cap = limit !== undefined && Number.isSafeInteger(limit) && limit >= 0 ? limit : -1; // SQLite: LIMIT -1 is none
    return this.sql.exec<{ ask: string; question: string; created_ms: number; name: string | null; tool: string | null; input: string | null; input_bytes: number | null }>(
      `SELECT a.ask, a.question, a.created_ms, p.name, p.tool, ${o.input === false ? "NULL AS input" : "p.input"}, p.input_bytes
        FROM asks a LEFT JOIN approvals p ON p.ask = a.ask
        WHERE a.status != '${ASK.answered}' ORDER BY a.created_ms, a.ask LIMIT ?`, cap).toArray()
      .map((r) => ({
        ask: r.ask, question: r.question, created_ms: r.created_ms,
        ...(r.name !== null ? { approval: { name: r.name, tool: r.tool } } : {}),
        ...(r.input !== null ? { input: JSON.parse(r.input) as unknown } : {}),
        ...(r.input_bytes !== null ? { input_bytes: r.input_bytes } : {}),
      }));
  }

  /**
   * The kept inputs (parsed) of those of `asks` still open, by ask: an answered ask, one that isn't an
   * approval, and one whose input wasn't kept (past `INPUT_KEPT_BYTES`, or from before it was) are left out.
   */
  inputs(asks: readonly string[]): Map<string, unknown> {
    return new Map(this.sql.exec<{ ask: string; input: string }>(
      `SELECT a.ask, p.input FROM asks a JOIN approvals p ON p.ask = a.ask
        WHERE a.status != '${ASK.answered}' AND p.input IS NOT NULL AND a.ask IN (SELECT value FROM json_each(?))`, JSON.stringify(asks)).toArray()
      .map((r) => [r.ask, JSON.parse(r.input) as unknown]));
  }

  /** Asks (approvals included) not yet answered: each answer would be a turn. */
  openAsks(): number {
    return this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM asks WHERE status != '${ASK.answered}'`).one().n;
  }

  /** The undecided approval of this exact call, if one was asked for already (asked again, it's not posted again). */
  pendingApproval(name: string, digest: string, kind: ApprovalKind = "sink"): Approval | undefined {
    return this.approvalWhere(`name = ? AND digest = ? AND ${KIND} = ? AND status = '${APPROVAL.pending}'`, name, digest, kind);
  }

  approvalOf(ask: string): Approval | undefined {
    return this.approvalWhere("ask = ?", ask);
  }

  /** `input`: the held call's canonical JSON (`canonicalJson`), kept whole up to `INPUT_KEPT_BYTES`. */
  requestApproval(ask: string, name: string, digest: string, tool: string | null = null, kind: ApprovalKind = "sink", input?: string): void {
    const bytes = input === undefined ? null : new TextEncoder().encode(input).length;
    this.sql.exec(`INSERT INTO approvals (ask, name, digest, status, created_ms, tool, kind, input, input_bytes) VALUES (?, ?, ?, '${APPROVAL.pending}', ?, ?, ?, ?, ?)`,
      ask, name, digest, Date.now(), tool, kind, bytes !== null && bytes <= INPUT_KEPT_BYTES ? input! : null, bytes);
  }

  /**
   * The operator's decision, once (`approvalStep`): a decided approval keeps its decision and its expiry
   * (`expiresMs` null: none, `approvalExpiry`). Whether it was pending.
   */
  decide(ask: string, approved: boolean, expiresMs: number | null): boolean {
    const event: ApprovalEvent = approved ? "approve" : "deny";
    let n = 0;
    for (const from of APPROVAL_STATUSES) {
      const to = approvalStep(from, event);
      if (to !== "refuse") n += this.sql.exec("UPDATE approvals SET status = ?, expires_ms = ? WHERE ask = ? AND status = ?", to, expiresMs, ask, from).rowsWritten;
    }
    return n > 0;
  }

  /**
   * Spend a usable (`approvalUsable`) approval of exactly this call on the call key `key`: the ask it
   * answered, when there is one (or one was already spent on `key`: a redelivery). One approval, one call.
   */
  takeApproval(name: string, digest: string, key: string, nowMs: number, kind: ApprovalKind = "sink"): string | undefined {
    // The one already spent on this key first (a redelivery), else an unspent one.
    const rows = this.sql.exec<{ ask: string; status: string; expires_ms: number | null; used_by: string | null }>(
      `SELECT ask, status, expires_ms, used_by FROM approvals WHERE name = ? AND digest = ? AND ${KIND} = ? ORDER BY used_by IS NULL, created_ms, ask`,
      name, digest, kind).toArray();
    // A rule's check key spends at most one approval, ever (no redelivery: `approvalUsable`).
    if (kind === "rule" && rows.some((a) => a.used_by === key)) return undefined;
    const r = rows.find((a) => approvalUsable({ ...a, kind, status: storedEnum(ApprovalStatusEnum, a.status, "approvals.status") }, key, nowMs));
    if (!r) return undefined;
    this.sql.exec("UPDATE approvals SET used_by = ? WHERE ask = ?", key, r.ask);
    return r.ask;
  }

  /**
   * A call a tool rule in `ask` mode holds, checked once per `key` (`approval_check`): a usable approval
   * of exactly this call is spent on `key` (`approved`), else the open ask for it (`pending`), else
   * nothing (the caller records an ask with its approval). Synchronous: one step.
   */
  checkRule(tool: string, digest: string, key: string, nowMs: number): { status: "approved" | "pending"; ask: string } | undefined {
    const taken = this.takeApproval(tool, digest, key, nowMs, "rule");
    if (taken !== undefined) return { status: "approved", ask: taken };
    const pending = this.pendingApproval(tool, digest, "rule");
    return pending && { status: "pending", ask: pending.ask };
  }

  /**
   * Rows older than `cutoff` go. A call of that age goes whatever its status: one still dispatching or
   * waiting can't finish on its own (its brain is long gone), so it is deleted with the finished ones. An
   * ask a previous release's call or guest CLI was waiting inside is first made an open ask like any
   * other. An open ask, and the pending approval it decides, is the operator's work still to do: it
   * stays until answered. So does a rule's approval not yet spent: it never expires.
   */
  prune(cutoff: number): void {
    this.applyAsk("detach", null, "created_ms < ?", cutoff);
    this.sql.exec("DELETE FROM tool_calls WHERE created_ms < ?", cutoff);
    this.sql.exec(`DELETE FROM asks WHERE status = '${ASK.answered}' AND created_ms < ?`, cutoff);
    this.sql.exec(`DELETE FROM approvals WHERE status != '${APPROVAL.pending}' AND created_ms < ?
      AND NOT (${KIND} = 'rule' AND status = '${APPROVAL.approved}' AND used_by IS NULL)`, cutoff);
  }

  private approvalWhere(where: string, ...args: SqlStorageValue[]): Approval | undefined {
    const r = this.sql.exec<Omit<Approval, "status" | "kind"> & { status: string; kind: string }>(
      `SELECT ask, name, digest, status, tool, ${KIND} AS kind FROM approvals WHERE ${where} LIMIT 1`, ...args).toArray()[0];
    return r && { ...r, status: storedEnum(ApprovalStatusEnum, r.status, "approvals.status"), kind: storedEnum(ApprovalKindEnum, r.kind, "approvals.kind") };
  }

  private askWhere(where: string, ...args: SqlStorageValue[]): StoredAsk | undefined {
    const r = this.sql.exec<Omit<StoredAsk, "status"> & { status: string }>(
      `SELECT ask, call, epoch, question, status, deadline FROM asks WHERE ${where}`, ...args).toArray()[0];
    return r && { ...r, status: storedEnum(AskStatusEnum, r.status, "asks.status") };
  }
}

export type AskRoute = "already_answered" | "result" | "turn";

/**
 * An answer reaches the model whatever happened to the brain that asked: the next turn, or, for a `sync`
 * ask the previous release left, the call's result while it waits on the brain that asked
 * (`callCurrent`: a new lineage drops what the old one was sent).
 */
export function askRoute(status: AskStatus, callCurrent: boolean): AskRoute {
  if (status === "answered") return "already_answered";
  if (status === "sync" && callCurrent) return "result";
  return "turn";
}
