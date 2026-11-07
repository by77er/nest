// The chat's pure parts: messages grouped by author (proximity) with a separator at each new day, the
// manager's turn in progress read from its live trace as steps (what it said, each tool it called), the
// steps behind each reply the trace still holds, and the read marker and draft kept per browser.

import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { primaryArg, toolName } from "../trace/model";

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

/** One turn of the trace, by its id, as the chat reads it. */
interface ChatTurn {
  turn: string;
  started: boolean;
  completed: boolean;
  items: ({ kind: "text"; key: string; text: string } | { kind: "tool"; key: string; call: TraceEvent; result: TraceEvent | null })[];
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * The ring's turns, in order, each gathered by its id: an event without a turn (a timer set mid-turn, a
 * state) never splits one, and a result finds its call anywhere in its turn.
 */
function chatTurns(events: TraceEvent[]): ChatTurn[] {
  const byId = new Map<string, ChatTurn>();
  const calls = new Map<string, Extract<ChatTurn["items"][number], { kind: "tool" }>>();
  for (const ev of events) {
    if (!ev.turn) continue;
    let t = byId.get(ev.turn);
    if (!t) byId.set(ev.turn, (t = { turn: ev.turn, started: false, completed: false, items: [] }));
    const key = `s${ev.seq}`;
    if (ev.type === "turn_started") t.started = true;
    else if (ev.type === "turn_completed") t.completed = true;
    else if (ev.type === "assistant_text" && str(ev.text).trim()) t.items.push({ kind: "text", key, text: str(ev.text) });
    else if (ev.type === "tool_call") {
      const item = { kind: "tool" as const, key, call: ev, result: null };
      calls.set(`${ev.turn}:${String(ev.call_id)}`, item);
      t.items.push(item);
    } else if (ev.type === "tool_result") {
      const call = calls.get(`${ev.turn}:${String(ev.call_id)}`);
      if (call) call.result = ev;
    }
  }
  return [...byId.values()];
}

/** The most of one input field the chat holds (nest cuts a call's whole input at 4 KB anyway). */
const FIELD_MAX = 2000;

const field = (v: unknown): string => {
  // A list of strings (a spec's criteria) a line each; anything else not a string as compact JSON.
  const s = typeof v === "string" ? v : Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join("\n") : JSON.stringify(v);
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s;
};

/** The keys whose value is a call's main argument, in the order they're looked for (as the trace's). */
const PRIMARY = ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description", "name", "text"];

/**
 * A call's input as fields and its main argument. nest cuts an input at 4 KB, often mid-JSON (a Write's
 * content): then the input is shown as it came, marked cut, and its main argument read from its start.
 */
function inputOf(input: unknown): { fields: ToolStep["input"]; summary: string } {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return { fields: Object.entries(input).map(([key, value]) => ({ key, value: field(value) })), summary: primaryArg(input) };
  }
  const raw = str(input);
  if (!raw) return { fields: [], summary: "" };
  try {
    const v: unknown = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return inputOf(v);
  } catch {
    // Cut short: below.
  }
  let summary = "";
  for (const k of PRIMARY) {
    const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (!m) continue;
    try {
      summary = primaryArg({ [k]: JSON.parse(`"${m[1]}"`) as string });
    } catch {
      summary = primaryArg({ [k]: m[1] });
    }
    break;
  }
  return { fields: [{ key: "input (cut short)", value: field(raw) }], summary };
}

function stepsOfTurn(t: ChatTurn, running: boolean): Step[] {
  return t.items.map((item): Step => {
    if (item.kind === "text") return item;
    const r = item.result;
    const { fields, summary } = inputOf(item.call.input);
    return {
      kind: "tool",
      key: item.key,
      name: toolName(str(item.call.name)),
      summary,
      input: fields,
      result: r ? str(r.summary) : null,
      status: r ? (r.is_error ? "error" : "done") : running ? "running" : "stopped",
    };
  });
}

/** The turn running now (started, not completed), if any: the ring's last turn. */
export function liveTurn(events: TraceEvent[]): LiveTurn | null {
  const t = chatTurns(events).at(-1);
  if (!t || !t.started || t.completed) return null;
  return { turn: t.turn, steps: stepsOfTurn(t, true) };
}

/** A finished turn, as it ended: its steps (a call it never answered stopped) and its reply (its last text), if any. */
export interface FinishedTurn {
  turn: string;
  steps: Step[];
  reply: string | null;
}

/** Every finished turn the ring holds, oldest first. */
export function finishedTurns(events: TraceEvent[]): FinishedTurn[] {
  return chatTurns(events)
    .filter((t) => t.completed)
    .map((t) => {
      const steps = stepsOfTurn(t, false);
      const texts = steps.filter((s): s is TextStep => s.kind === "text");
      return { turn: t.turn, steps, reply: texts.length ? texts[texts.length - 1]!.text.trim() : null };
    });
}

/**
 * The steps behind each reply the trace still holds, by the message's seq. A finished turn's reply is
 * its last text (nest records it as the manager's message: `agent.turn_completed`'s text), and its steps
 * are everything else it did, kept when it called a tool. Paired by what the reply says, never by time,
 * newest turn with the newest unpaired message saying it: a repeated "Done." gets only its own turn's.
 */
export function stepsBySeq(messages: ChatMessage[], turns: FinishedTurn[]): Map<number, Step[]> {
  const out = new Map<number, Step[]>();
  const manager = messages.filter((m) => m.sender === "manager").sort((a, b) => b.seq - a.seq);
  const paired = new Set<number>();
  for (const t of [...turns].reverse()) {
    if (!t.reply) continue;
    const m = manager.find((x) => !paired.has(x.seq) && x.text.trim() === t.reply);
    if (!m) continue;
    paired.add(m.seq);
    let last = t.steps.length - 1;
    while (last >= 0 && t.steps[last]!.kind !== "text") last--;
    const steps = t.steps.filter((_, i) => i !== last);
    if (steps.some((s) => s.kind === "tool")) out.set(m.seq, steps);
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
