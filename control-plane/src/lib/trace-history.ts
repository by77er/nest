// An agent's trace history (docs/control-plane/api/#trace-history): its older turns, read from the stored
// transcript (Claude Code's session JSONL, the committed base in R2) and normalized into the live trace's
// shape, with the same redaction and bounds (`traceOf`). Paged backwards by an opaque cursor, and meeting
// the live ring at its seam: history holds what the transcript wrote before the ring's oldest event.
import type { AgentEvent } from "../protocol/model";
import { type TraceBody, traceOf } from "./trace";
import { b64url, b64urlToBytes } from "./util";

/** Events per page by default, and at most. */
export const HISTORY_DEFAULT_LIMIT = 200;
export const HISTORY_MAX_LIMIT = 500;
/** Transcript bytes read from R2 per page, at most (a page past it ends early, with a cursor to go on). */
export const HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/** Near the seam, a history text equal to a ring text is the same text (the two sources stamp it ms apart). */
export const SEAM_WINDOW_MS = 5_000;
/** A tool result's summary: its first this many characters, as the runner's live events carry. */
const SUMMARY_CHARS = 200;

/** A history event: the live shape without `seq` (it isn't in the ring), and its entry's byte offset in the base. */
export type HistoryEvent = { ts_ms: number; entry: number } & TraceBody;

/**
 * Where a page ends (exclusive): entries of base `b` that start before byte `o` (null: the end) and were
 * written before `t` (ms, the seam). `c`: the entry at `o` (or, at the end, the seam) starts a turn, so
 * a turn open at the page's end is complete there.
 */
export interface HistoryCursor {
  b: number;
  o: number | null;
  t: number;
  c: boolean;
}

export function encodeCursor(c: HistoryCursor): string {
  return b64url(new TextEncoder().encode(JSON.stringify(c)));
}

export function decodeCursor(s: string): HistoryCursor | null {
  try {
    const v = JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as Partial<HistoryCursor>;
    const int = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
    if (!int(v.b) || !(v.o === null || int(v.o)) || !int(v.t) || typeof v.c !== "boolean") return null;
    return { b: v.b!, o: v.o!, t: v.t!, c: v.c };
  } catch {
    return null;
  }
}

// --- One transcript entry -------------------------------------------------------------------------------

/** What an entry says, as the trace shows it. */
export interface Entry {
  offset: number;
  ts: number | null;
  /** A prompt: a turn starts here. */
  prompt: boolean;
  /** An assistant message's stop reason, if it gave one. */
  stop: string | null;
  bodies: TraceBody[];
}

type Block = { type?: unknown; text?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; is_error?: unknown; content?: unknown };

/** A tool result's text content, its first `SUMMARY_CHARS` characters (the runner's `summarize`). */
function summarize(content: unknown): string | undefined {
  const text = typeof content === "string" ? content
    : Array.isArray(content) ? content.filter((b: Block) => typeof b?.text === "string").map((b: Block) => b.text as string).join("\n")
    : "";
  return text ? [...text].slice(0, SUMMARY_CHARS).join("") : undefined;
}

/** A stand-in runner event for `traceOf`, so history gets the live path's redaction and bounds exactly. */
const as = (e: Record<string, unknown>) => ({ agent: "agt_x", epoch: 0, seq: 0, ts_ms: 0, ...e }) as unknown as AgentEvent;

/**
 * One JSONL line of Claude Code's session: a prompt starts a turn; an assistant message gives text and
 * tool calls; a user message of tool results gives results. Subagent sidechains, meta and compaction
 * entries, thinking and everything else give nothing.
 */
export function normalizeEntry(line: string, offset: number): Entry | null {
  let e: { type?: unknown; timestamp?: unknown; isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; message?: { content?: unknown; stop_reason?: unknown } };
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== "object") return null;
  const parsed = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  const out: Entry = { offset, ts: Number.isFinite(parsed) ? parsed : null, prompt: false, stop: null, bodies: [] };
  if (e.isSidechain === true || e.isMeta === true || e.isCompactSummary === true) return out;
  const content = e.message?.content;
  const blocks: Block[] = Array.isArray(content) ? content : [];
  if (e.type === "user") {
    const results = blocks.filter((b) => b?.type === "tool_result");
    if (results.length) {
      for (const b of results) {
        const body = traceOf(as({ type: "tool_result", call_id: String(b.tool_use_id ?? ""), is_error: b.is_error === true, ...(summarize(b.content) !== undefined ? { summary: summarize(b.content) } : {}) }));
        if (body) out.bodies.push(body);
      }
    } else if (typeof content === "string" ? content.length > 0 : blocks.some((b) => b?.type === "text")) {
      out.prompt = true;
      // Which of nest's inputs it was isn't in the transcript.
      out.bodies.push({ type: "turn_started", input_kind: "unknown" });
    }
  } else if (e.type === "assistant") {
    for (const b of blocks) {
      let body: TraceBody | null = null;
      if (b?.type === "text" && typeof b.text === "string" && b.text) body = traceOf(as({ type: "assistant_text", text: b.text }));
      else if (b?.type === "tool_use") body = traceOf(as({ type: "tool_call", call_id: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input ?? null }));
      if (body) out.bodies.push(body);
    }
    const stop = e.message?.stop_reason;
    if (typeof stop === "string") out.stop = stop;
  }
  return out;
}

// --- Reading backwards ---------------------------------------------------------------------------------

export interface Segment {
  offset: number;
  len: number;
  key: string;
}

const NL = 0x0a;

/**
 * The base's lines that start before `end`, newest first, with their byte offsets, read segment by
 * segment from the newest (a line may span segments). Stops after `maxBytes` of segments, saying where.
 */
export async function* linesBackward(
  segments: Segment[], end: number, read: (key: string) => Promise<Uint8Array | null>, maxBytes: number,
): AsyncGenerator<{ offset: number; text: string } | { stoppedAt: number }> {
  const decoder = new TextDecoder();
  const older = segments.filter((s) => s.offset < end).sort((a, b) => b.offset - a.offset);
  let carry = new Uint8Array(0); // the start of the newer segment, before its first newline
  let bytes = 0;
  let lastStart: number | null = null;
  for (const s of older) {
    // Over budget once a line was given: the next page starts at that line (one across segments is read whole then).
    if (bytes >= maxBytes && lastStart !== null) {
      yield { stoppedAt: lastStart };
      return;
    }
    const raw = await read(s.key);
    if (!raw) {
      // A segment gone from R2: what it held is skipped, and a line across it is dropped.
      carry = new Uint8Array(0);
      continue;
    }
    bytes += raw.length;
    const cut = raw.subarray(0, Math.max(0, Math.min(raw.length, end - s.offset)));
    const buf = new Uint8Array(cut.length + carry.length);
    buf.set(cut);
    buf.set(carry, cut.length);
    // Line ends in buf, newest first; the first piece is partial unless this segment starts the base.
    let stop = buf.length;
    if (stop > 0 && buf[stop - 1] === NL) stop -= 1;
    for (let i = stop - 1; i >= -1; i--) {
      if (i === -1 || buf[i] === NL) {
        const start = i + 1;
        if (i === -1 && s.offset > 0) {
          carry = buf.slice(0, stop);
          break;
        }
        if (stop > start) {
          lastStart = s.offset + start;
          yield { offset: lastStart, text: decoder.decode(buf.subarray(start, stop)) };
        }
        stop = i;
        if (i === -1) carry = new Uint8Array(0);
      }
    }
  }
}

// --- A page ---------------------------------------------------------------------------------------------

/** Ring events near the seam that history must not repeat: tool calls and results by id, texts by text. */
export interface RingIdentity {
  calls: Set<string>;
  results: Set<string>;
  texts: Set<string>;
}

export interface HistoryPage {
  events: HistoryEvent[];
  next_before: string | null;
}

/**
 * The page of events before `cur`: at most `limit` events, of whole entries, extended back to the
 * prompt that starts its oldest turn when that's within the byte budget (so a page holds whole turns).
 * Oldest first. Each turn closed inside the page, or at its end when `cur.c`, gets a `turn_completed`.
 */
export async function historyPage(
  segments: Segment[], end: number, cur: HistoryCursor, limit: number, ring: RingIdentity,
  read: (key: string) => Promise<Uint8Array | null>, maxBytes = HISTORY_MAX_BYTES,
): Promise<HistoryPage> {
  const max = Math.max(1, Math.min(limit, HISTORY_MAX_LIMIT));
  const taken: Entry[] = []; // newest first
  let count = 0;
  let next: HistoryCursor | null = null;
  let filling = true;
  let broke = false;
  let lastTs: number | null = null;
  for await (const l of linesBackward(segments, cur.o ?? end, read, maxBytes)) {
    if ("stoppedAt" in l) {
      // Out of budget: go on from the oldest line read (exclusive) next time.
      const at = taken[taken.length - 1];
      next = { b: cur.b, o: l.stoppedAt, t: cur.t, c: at?.offset === l.stoppedAt ? at.prompt : false };
      break;
    }
    const en = normalizeEntry(l.text, l.offset);
    if (!en) continue;
    // Written at or after the seam: the ring has it.
    if (en.ts !== null && en.ts >= cur.t) continue;
    if (en.ts === null) en.ts = lastTs;
    lastTs = en.ts ?? lastTs;
    taken.push(en);
    if (!filling) {
      // Past the limit, only to reach the turn's prompt.
      if (en.prompt) {
        broke = true;
        break;
      }
      continue;
    }
    count += en.bodies.length;
    if (count >= max) {
      if (en.prompt) {
        broke = true;
        break;
      }
      filling = false;
    }
  }
  const oldest = taken[taken.length - 1];
  // Stopped short of the base's start (at the limit's prompt): older entries remain.
  if (!next && broke && oldest) next = { b: cur.b, o: oldest.offset, t: cur.t, c: oldest.prompt };

  // Oldest first, with each turn's end where the next prompt (or a turn start just past the page) is.
  const entries = taken.reverse();
  const events: HistoryEvent[] = [];
  let open = false;
  let stop = "end_turn";
  let at = 0;
  const near = (ts: number) => ts >= cur.t - SEAM_WINDOW_MS;
  for (const en of entries) {
    const ts = en.ts ?? at;
    if (en.prompt && open) {
      events.push({ ts_ms: at, entry: en.offset, type: "turn_completed", stop_reason: stop });
      open = false;
    }
    for (const b of en.bodies) {
      // The same event the ring has (the seam fell inside a turn): kept once, the ring's.
      if (b.type === "tool_call" && ring.calls.has(b.call_id)) continue;
      if (b.type === "tool_result" && ring.results.has(b.call_id)) continue;
      if (b.type === "assistant_text" && near(ts) && ring.texts.has(b.text)) continue;
      events.push({ ts_ms: ts, entry: en.offset, ...b });
    }
    if (en.prompt) {
      open = true;
      stop = "end_turn";
    } else if (en.bodies.length || en.stop) open = true;
    if (en.stop && en.stop !== "tool_use") stop = en.stop;
    at = ts;
  }
  if (open && cur.c && events.length) events.push({ ts_ms: at, entry: entries[entries.length - 1]!.offset, type: "turn_completed", stop_reason: stop });
  return { events, next_before: next ? encodeCursor(next) : null };
}
