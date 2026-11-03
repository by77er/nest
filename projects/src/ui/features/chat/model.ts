// The chat's pure parts: messages grouped by author (proximity) with a separator at each new day, the
// manager's turn in progress read from its live trace, and the read marker kept per browser.

import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { groupTurns } from "../trace/model";

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
      out.push({ kind: "day", key: `day:${d}`, label: dayLabel(m.at_ms, now) });
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

/** The manager's turn in progress, from its trace: the text so far and what it's doing now. */
export interface LiveTurn {
  turn: string;
  text: string;
  /** The latest tool still running, as a person reads it ("Reading src/worker.ts"), if any. */
  activity: string | null;
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
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A tool call, as an activity line. */
export function describeTool(name: string, input: unknown): string {
  const i = parse(input);
  const path = str(i.file_path) || str(i.path) || str(i.notebook_path);
  const short = name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "").replace(/_/g, " ");
  switch (name) {
    case "Read":
      return path ? `Reading ${clip(path)}` : "Reading";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return path ? `Editing ${clip(path)}` : "Editing";
    case "Bash":
      return str(i.command) ? `Running ${clip(str(i.command))}` : "Running a command";
    case "Grep":
    case "Glob":
      return str(i.pattern) ? `Searching for ${clip(str(i.pattern), 40)}` : "Searching";
    case "WebFetch":
    case "WebSearch":
      return "Looking it up";
    default:
      return clip(short.charAt(0).toUpperCase() + short.slice(1));
  }
}

/** The turn running now (started, not completed), if any. */
export function liveTurn(events: TraceEvent[]): LiveTurn | null {
  const groups = groupTurns(events);
  const g = groups.at(-1);
  if (!g || !g.turn || !g.started || g.completed) return null;
  let text = "";
  let activity: string | null = null;
  for (const item of g.items) {
    if (item.kind === "event" && item.event.type === "assistant_text") text += (text ? "\n\n" : "") + str(item.event.text);
    if (item.kind === "tool") activity = item.result ? null : describeTool(str(item.call.name), item.call.input);
  }
  return { turn: g.turn, text, activity };
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
