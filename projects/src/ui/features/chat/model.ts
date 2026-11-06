// The chat's pure parts: messages grouped by author (proximity) with a separator at each new day, the
// manager's turn in progress read from its live trace as steps (what it said, each tool it called), the
// steps behind each reply the trace still holds, and the read marker and draft kept per browser.

import type { ChatMessage } from "../../api/types";
import type { HistoryEvent, TraceEvent, TurnGroup } from "../trace/model";
import { groupTurns, primaryArg, toolName } from "../trace/model";

/** Messages from one author within this long of each other are one group. */
export const GROUP_GAP_MS = 5 * 60 * 1000;

export type LogItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "group"; key: string; sender: string; messages: ChatMessage[] };

const dayKey = (ms: number) => new Date(ms).toDateString();

/** "Today", "Yesterday", or the date. */
export function dayLabel(ms: number, now = Date.now()): string {
  const d = dayKey(ms);
  if (d === dayKey(now)) return "Today";
  if (d === dayKey(now - 86_400_000)) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: new Date(ms).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" }).format(ms);
}

/** The log as day separators and author groups, in order. App notes are groups of their own. */
export function groupLog(messages: ChatMessage[], now = Date.now()): LogItem[] {
  const out: LogItem[] = [];
  let day = "";
  let cur: Extract<LogItem, { kind: "group" }> | null = null;
  for (const m of messages) {
    const d = dayKey(m.at_ms);
    if (d !== day) {
      day = d;
      out.push({ kind: "day", key: `day:${d}:${m.seq}`, label: dayLabel(m.at_ms, now) });
      cur = null;
    }
    const last = cur?.messages.at(-1);
    if (cur && cur.sender === m.sender && m.sender !== "app" && last && m.at_ms - last.at_ms <= GROUP_GAP_MS) {
      cur.messages.push(m);
    } else {
      cur = { kind: "group", key: `g:${m.seq}`, sender: m.sender, messages: [m] };
      out.push(cur);
    }
  }
  return out;
}

/** A tool call of a turn, as the chat shows it: a compact row, its input and result behind it. */
export interface ToolStep {
  kind: "tool";
  key: string;
  /** The tool's own name (an MCP tool's without its server: `write_spec`). */
  name: string;
  /** Its main argument's first line (`npm test`, `src/a.ts`), or "". */
  summary: string;
  /** Its input's fields, each a line of text (a string as it is, anything else as compact JSON). */
  input: { key: string; value: string }[];
  /** What it returned (nest keeps a result's first 200 characters), or null before it has. */
  result: string | null;
  /** running: no result yet in a running turn; stopped: the turn ended without one. */
  status: "running" | "done" | "error" | "stopped";
}
/** Something the manager said along the way (its last text is the reply itself). */
export interface TextStep {
  kind: "text";
  key: string;
  text: string;
}
export type Step = ToolStep | TextStep;

/** The manager's turn in progress, from its trace: what it has said and done so far, in order. */
export interface LiveTurn {
  turn: string;
  steps: Step[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const parse = (input: unknown): Record<string, unknown> => {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  try {
    const v = JSON.parse(str(input));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
/** The most of one input field the chat holds (a file's whole content is the trace's to show). */
const FIELD_MAX = 2000;

const field = (v: unknown): string => {
  // A list of strings (a spec's criteria) a line each; anything else not a string as compact JSON.
  const s = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("\n") : JSON.stringify(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s;
};

/** A turn's steps, in order: its texts and its tool calls (each with its result when it came). */
export function stepsOf(g: TurnGroup, running: boolean): Step[] {
  const out: Step[] = [];
  for (const item of g.items) {
    if (item.kind === "event" && item.event.type === "assistant_text" && str(item.event.text).trim()) {
      out.push({ kind: "text", key: item.key, text: str(item.event.text) });
    } else if (item.kind === "tool") {
      const r = item.result as (TraceEvent | HistoryEvent | null);
      out.push({
        kind: "tool",
        key: item.key,
        name: toolName(str(item.call.name)),
        summary: primaryArg(item.call.input),
        input: Object.entries(parse(item.call.input)).map(([key, value]) => ({ key, value: field(value) })),
        result: r ? str(r.summary) : null,
        status: r ? (r.is_error ? "error" : "done") : running ? "running" : "stopped",
      });
    }
  }
  return out;
}

/** The turn running now (started, not completed), if any. */
export function liveTurn(events: TraceEvent[]): LiveTurn | null {
  const groups = groupTurns(events);
  const g = groups.at(-1);
  if (!g || !g.turn || !g.started || g.completed) return null;
  return { turn: g.turn, steps: stepsOf(g, true) };
}

/**
 * The steps behind each reply the trace still holds: a completed turn's reply is its last text (what nest
 * records as the manager's message), and its steps are everything before it, kept only when it called a
 * tool. Keyed by that text, trimmed, so a message finds its own turn by what it says (never by time).
 */
export function stepsByReply(events: TraceEvent[]): Map<string, Step[]> {
  const out = new Map<string, Step[]>();
  for (const g of groupTurns(events)) {
    if (!g.turn || !g.completed) continue;
    const steps = stepsOf(g, false);
    let last = steps.length - 1;
    while (last >= 0 && steps[last]!.kind !== "text") last--;
    if (last < 0) continue;
    const before = steps.slice(0, last);
    if (before.some((s) => s.kind === "tool")) out.set((steps[last] as TextStep).text.trim(), before);
  }
  return out;
}

// --- read state, per browser ----------------------------------------------------------------------

const READ_KEY = (projectId: string) => `nest-projects:chat-read:${projectId}`;

export function readMark(projectId: string): number {
  try {
    return Number(window.localStorage.getItem(READ_KEY(projectId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function markRead(projectId: string, seq: number): void {
  try {
    if (seq > readMark(projectId)) window.localStorage.setItem(READ_KEY(projectId), String(seq));
    window.dispatchEvent(new Event("nest-projects:chat-read"));
  } catch {
    // Storage refused (private mode): unread just isn't remembered.
  }
}

const DRAFT_KEY = (projectId: string) => `nest-projects:chat-draft:${projectId}`;

export function loadDraft(projectId: string): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY(projectId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(projectId: string, text: string): void {
  try {
    if (text) window.localStorage.setItem(DRAFT_KEY(projectId), text);
    else window.localStorage.removeItem(DRAFT_KEY(projectId));
  } catch {
    // Storage refused: the draft lives only in the page.
  }
}

/** A quote-reply's text: the message's lines, each behind "> ", and a blank line to write under. */
export function quote(text: string): string {
  return `${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`;
}
