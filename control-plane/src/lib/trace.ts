// An agent's live trace (docs/control-plane/api/#live-trace): what AgentDO already learns of
// its turns (the runner's event batches, its own state, asks, its end), normalized into one shape
// and kept in a bounded ring so a client can resume. Nothing here knows any one client, and nothing
// here sends: AgentDO writes a row in the step of the change and hands the row to its trace sockets.
import type { AgentEvent, AgentState, TurnInputKind } from "../protocol/model";
import { clip } from "./util";

/** Each string field (a tool's input, a result's summary, a question, a message) is cut to this many UTF-8 bytes. */
export const TRACE_FIELD_MAX = 4 * 1024;
/** Assistant text gets more: it is what a viewer reads (the client events' bound, `EVENT_TEXT_MAX`). */
export const TRACE_TEXT_MAX = 16 * 1024;
/** The ring keeps the newest this many events... */
export const TRACE_RING_MAX = 1000;
/** ...that are no older than this. */
export const TRACE_RING_MS = 24 * 60 * 60_000;
/** Trace sockets an agent holds at once; a new one past this closes the oldest. */
export const TRACE_SOCKETS_MAX = 8;
/** The text a client sends to keep a socket alive, and the answer, both without waking AgentDO. */
export const TRACE_PING = "ping";
export const TRACE_PONG = "pong";

/** What a trace event says, by `type`; every event also has `seq`, `ts_ms` and, within a turn, `turn`. */
export type TraceBody =
  /** `unknown` only in history: the transcript doesn't say which of nest's inputs started a turn. */
  | { type: "turn_started"; input_kind: TurnInputKind | "unknown" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; call_id: string; name: string; input: string }
  | { type: "tool_result"; call_id: string; is_error: boolean; summary?: string }
  | { type: "turn_completed"; stop_reason: string; usage?: TraceUsage }
  | { type: "rate_limited"; retry_after_ms?: number; detail: string }
  | { type: "error"; code: string; message: string }
  | { type: "task_exited"; task_id: string; status: string; exit_code?: number }
  | { type: "state"; state: AgentState }
  | { type: "ask"; ask: string; question: string }
  | { type: "ask_answered"; ask: string }
  | { type: "ended"; reason: string }
  | { type: "timer_set"; name: string; at_ms: number; note: string }
  | { type: "timer_fired"; name: string; note: string }
  | { type: "timer_cancelled"; name: string; by: string };
export type TraceUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
export type TraceEvent = { seq: number; ts_ms: number; turn?: string } & TraceBody;
/**
 * Messages that aren't events (no `seq`): older events are gone from the ring (`gap`, before the
 * backlog), the backlog is done and what follows is live (`live`), or (on a connect after it) the end.
 */
export type TraceControl =
  | { type: "gap"; from: number; to: number; before?: string }
  | { type: "history"; before: string }
  | { type: "live" }
  | { type: "ended"; reason: string };

/** The types the transcript records too: the ring's seam with the trace history is its oldest of these. */
export const TRANSCRIPT_TYPES = new Set(["turn_started", "assistant_text", "tool_call", "tool_result", "turn_completed"]);

// --- Redaction ---------------------------------------------------------------------------------------

/** An object key whose value is never shown (tool inputs): it names a credential. */
const SECRET_KEY = /secret|token|passw(or)?d|passwd|authori[sz]ation|api[-_]?key|credential|cookie|private[-_]?key|session[-_]?key/i;
/**
 * Credential shapes redacted from every string field: nest's own client tokens and webhook secrets,
 * Anthropic keys and OAuth tokens, GitHub tokens, Slack tokens, AWS access key ids, PEM private keys
 * and bearer headers. A value of another shape passes, bounded: the live path has no list of secrets.
 */
const SECRET_SHAPES: RegExp[] = [
  /nest_(?:cli|obs|apr|adm)_[A-Za-z0-9_]{8,}/g,
  /whsec_[0-9a-f]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
export const REDACTED = "[redacted]";

/** `text` with every credential shape replaced by `[redacted]` (a bearer header keeps its scheme). */
export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_SHAPES) {
    out = out.replace(re, (m, scheme?: string) => (typeof scheme === "string" && /^(bearer|basic)$/i.test(scheme) ? `${scheme} ${REDACTED}` : REDACTED));
  }
  return out;
}

/** A JSON value with credential-named keys' values and credential-shaped strings redacted. */
export function redactValue(v: unknown, depth = 0): unknown {
  if (typeof v === "string") return redactText(v);
  if (v === null || typeof v !== "object") return v;
  // Deeper than any tool input needs: summarized rather than walked.
  if (depth > 32) return REDACTED;
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) && x !== null && x !== "" ? REDACTED : redactValue(x, depth + 1);
  }
  return out;
}

/** A field as it is streamed: redacted first (a cut never leaves half a token unmatched), then bounded. */
export const field = (text: string, max = TRACE_FIELD_MAX): string => clip(redactText(text), max);

/** A tool's input as it is streamed: redacted, as compact JSON, bounded. */
export function inputSummary(input: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(redactValue(input ?? null)) ?? "null";
  } catch {
    s = "null";
  }
  return clip(s, TRACE_FIELD_MAX);
}

// --- What streams ------------------------------------------------------------------------------------

/**
 * The trace body of a runner event, or null for one that isn't streamed: `state_changed` (AgentDO
 * streams its own `state` as it changes, which that event feeds), `escalation` (it streams as the
 * `ask` it becomes), `usage`, `capabilities` and `inbox_delivered`.
 */
export function traceOf(ev: AgentEvent): TraceBody | null {
  switch (ev.type) {
    case "turn_started":
      return { type: "turn_started", input_kind: ev.input_kind };
    case "assistant_text":
      return { type: "assistant_text", text: field(ev.text, TRACE_TEXT_MAX) };
    case "tool_call":
      return { type: "tool_call", call_id: clip(ev.call_id, 256), name: clip(ev.name, 256), input: inputSummary(ev.input) };
    case "tool_result":
      return { type: "tool_result", call_id: clip(ev.call_id, 256), is_error: ev.is_error, ...(ev.summary !== undefined ? { summary: field(ev.summary) } : {}) };
    case "turn_completed": {
      const u = ev.usage;
      return {
        type: "turn_completed", stop_reason: clip(ev.stop_reason, 256),
        ...(u ? { usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens, cache_creation_input_tokens: u.cache_creation_input_tokens } } : {}),
      };
    }
    case "rate_limited":
      return { type: "rate_limited", ...(ev.retry_after_ms !== undefined ? { retry_after_ms: ev.retry_after_ms } : {}), detail: field(ev.detail) };
    case "error":
      return { type: "error", code: clip(ev.error.code, 256), message: field(ev.error.message) };
    case "task_exited":
      return {
        type: "task_exited", task_id: clip(ev.task.task_id, 256), status: ev.task.status,
        ...(ev.task.exit_code !== undefined ? { exit_code: ev.task.exit_code } : {}),
      };
    default:
      return null;
  }
}

// --- The ring ----------------------------------------------------------------------------------------

/** What a client connecting `after` a seq gets first: a gap (events gone from the ring), then the backlog. */
export interface Backlog {
  gap: { from: number; to: number } | null;
  events: TraceEvent[];
}

/**
 * The newest `TRACE_RING_MAX` events of the last `TRACE_RING_MS` (`trace`), and the last seq given
 * (`trace_head`, so a seq is never reused once its row is pruned). `seq` is per agent, from 1.
 */
export class TraceRing {
  constructor(private readonly sql: SqlStorage, private readonly max = TRACE_RING_MAX, private readonly keepMs = TRACE_RING_MS) {
    sql.exec(`CREATE TABLE IF NOT EXISTS trace (seq INTEGER PRIMARY KEY, at_ms INTEGER NOT NULL, src TEXT UNIQUE, body TEXT NOT NULL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS trace_head (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL)");
  }

  /** The last seq given (0 before any). */
  head(): number {
    return this.sql.exec<{ seq: number }>("SELECT seq FROM trace_head WHERE id = 1").toArray()[0]?.seq ?? 0;
  }

  /**
   * Record `body` as the next event, synchronously, and prune. `src` names a source event that may
   * be applied twice (a resent batch): its second append records nothing and answers null.
   */
  append(body: TraceBody, tsMs: number, turn: string | null | undefined, nowMs: number, src?: string): TraceEvent | null {
    if (src !== undefined && this.sql.exec("SELECT 1 FROM trace WHERE src = ?", src).toArray().length) return null;
    const seq = this.head() + 1;
    const ev: TraceEvent = { seq, ts_ms: tsMs, ...(turn ? { turn } : {}), ...body };
    this.sql.exec("INSERT INTO trace_head (id, seq) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq", seq);
    this.sql.exec("INSERT INTO trace (seq, at_ms, src, body) VALUES (?, ?, ?, ?)", seq, nowMs, src ?? null, JSON.stringify(ev));
    this.prune(nowMs);
    return ev;
  }

  prune(nowMs: number): void {
    this.sql.exec("DELETE FROM trace WHERE seq <= ? OR at_ms < ?", this.head() - this.max, nowMs - this.keepMs);
  }

  /** The ring's oldest event the transcript records too (the seam with the trace history), if any. */
  seam(): { seq: number; ts_ms: number; type: string } | null {
    for (const r of this.sql.exec<{ body: string }>("SELECT body FROM trace ORDER BY seq")) {
      const ev = JSON.parse(r.body) as TraceEvent;
      if (TRANSCRIPT_TYPES.has(ev.type)) return { seq: ev.seq, ts_ms: ev.ts_ms, type: ev.type };
    }
    return null;
  }

  /** What the ring holds that the transcript has too: tool calls and results by id, assistant texts. */
  identity(): { calls: Set<string>; results: Set<string>; texts: Set<string> } {
    const out = { calls: new Set<string>(), results: new Set<string>(), texts: new Set<string>() };
    for (const r of this.sql.exec<{ body: string }>("SELECT body FROM trace")) {
      const ev = JSON.parse(r.body) as TraceEvent;
      if (ev.type === "tool_call") out.calls.add(ev.call_id);
      else if (ev.type === "tool_result") out.results.add(ev.call_id);
      else if (ev.type === "assistant_text") out.texts.add(ev.text);
    }
    return out;
  }

  /** Every event after `after` the ring holds, oldest first, and the gap before them if events after `after` are gone. */
  after(after: number, nowMs: number): Backlog {
    this.prune(nowMs);
    const head = this.head();
    const oldest = this.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM trace").one().seq;
    // Everything up to `head` is in the ring or was pruned: what's missing is (after, oldest), or (after, head] when it's empty.
    const firstKept = oldest ?? head + 1;
    const gap = after < head && after + 1 < firstKept ? { from: after + 1, to: firstKept - 1 } : null;
    const events = this.sql.exec<{ body: string }>("SELECT body FROM trace WHERE seq > ? ORDER BY seq", after).toArray()
      .map((r) => JSON.parse(r.body) as TraceEvent);
    return { gap, events };
  }
}
