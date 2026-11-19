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
  | { kind: "group"; key: string; sender: string; messages: ChatMessage[] }
  /** A part of the manager's turn in progress: its steps, and `working` when it's the live end with no call running. */
  | { kind: "stream"; key: string; steps: Step[]; working: boolean };

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
  return grouped(messages, now);
}

/** Messages and stream parts in order, the messages grouped: a stream part ends the group before it. */
function grouped(entries: (ChatMessage | Extract<LogItem, { kind: "stream" }>)[], now: number): LogItem[] {
  const out: LogItem[] = [];
  let day = "";
  let cur: Extract<LogItem, { kind: "group" }> | null = null;
  for (const m of entries) {
    if ("kind" in m) {
      out.push(m);
      cur = null;
      continue;
    }
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
  /** When it was called (the trace's clock, as a message's `at_ms`). */
  ts_ms: number;
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
  ts_ms: number;
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
  items: ({ kind: "text"; key: string; ts_ms: number; text: string } | { kind: "tool"; key: string; call: TraceEvent; result: TraceEvent | null })[];
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
    else if (ev.type === "assistant_text" && str(ev.text).trim()) t.items.push({ kind: "text", key, ts_ms: ev.ts_ms, text: str(ev.text) });
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

/**
 * A turn's steps already worked out, by their event's seq (events never change once sent): a text as it
 * was, a call's input read once (`inputOf`), and its step reused while its result and running are the same.
 */
type StepCache = Map<number, { kind: "text"; step: TextStep } | { kind: "tool"; resultSeq: number | null; running: boolean; step: ToolStep; input: ReturnType<typeof inputOf> }>;

function stepsOfTurn(t: ChatTurn, running: boolean, cache: StepCache = new Map()): Step[] {
  return t.items.map((item): Step => {
    if (item.kind === "text") {
      const seq = Number(item.key.slice(1));
      const had = cache.get(seq);
      if (had?.kind === "text" && had.step.text === item.text) return had.step;
      cache.set(seq, { kind: "text", step: item });
      return item;
    }
    const r = item.result;
    const resultSeq = r ? r.seq : null;
    const had = cache.get(item.call.seq);
    const known = had?.kind === "tool" ? had : undefined;
    if (known && known.resultSeq === resultSeq && known.running === running) return known.step;
    const input = known?.input ?? inputOf(item.call.input);
    const step: ToolStep = {
      kind: "tool",
      key: item.key,
      ts_ms: item.call.ts_ms,
      name: toolName(str(item.call.name)),
      summary: input.summary,
      input: input.fields,
      result: r ? str(r.summary) : null,
      status: r ? (r.is_error ? "error" : "done") : running ? "running" : "stopped",
    };
    cache.set(item.call.seq, { kind: "tool", resultSeq, running, step, input });
    return step;
  });
}

/** The turn running now (started, not completed), if any: the ring's last turn. */
export function liveTurn(events: TraceEvent[]): LiveTurn | null {
  return new TurnReader().read(events).live;
}

/** A finished turn, as it ended: its steps (a call it never answered stopped) and its reply (its last text), if any. */
export interface FinishedTurn {
  turn: string;
  steps: Step[];
  reply: string | null;
}

/** Every finished turn the ring holds, oldest first. */
export function finishedTurns(events: TraceEvent[]): FinishedTurn[] {
  return new TurnReader().read(events).finished;
}

function finishedOf(t: ChatTurn, cache: StepCache): FinishedTurn {
  const steps = stepsOfTurn(t, false, cache);
  const texts = steps.filter((s): s is TextStep => s.kind === "text");
  return { turn: t.turn, steps, reply: texts.length ? texts[texts.length - 1]!.text.trim() : null };
}

/** A turn as it was last read: its events' first and last seq and how many, and what was made of them. */
interface Seen {
  first: number;
  last: number;
  count: number;
  /** As finished, once it is. */
  finished: FinishedTurn | null;
  /** As the turn in progress, while it is. */
  live: LiveTurn | null;
  steps: StepCache;
}

/**
 * `liveTurn` and `finishedTurns` as the trace grows, each turn worked out once: one pass over the events
 * per read sorts them by turn (nothing parsed), then only a turn whose events changed (the one in
 * progress, or one the ring cut at its front) is read again, and in it only the steps that changed. A
 * turn the same as at the last read keeps its objects, and the finished list its identity while no
 * finished turn changed, so what's drawn from them can be skipped. Any number of new events per read
 * (several in one state change, or one), and a trace that starts over, read the same.
 */
export class TurnReader {
  private seen = new Map<string, Seen>();
  private finished: FinishedTurn[] = [];
  private live: LiveTurn | null = null;

  read(events: TraceEvent[]): { live: LiveTurn | null; finished: FinishedTurn[] } {
    // Each turn's events, the turns in the order they first appear (as `chatTurns` gathers them).
    const byTurn = new Map<string, TraceEvent[]>();
    for (const ev of events) {
      if (!ev.turn) continue;
      const evs = byTurn.get(ev.turn);
      if (evs) evs.push(ev);
      else byTurn.set(ev.turn, [ev]);
    }
    let lastId: string | undefined;
    for (const id of byTurn.keys()) lastId = id;
    const finished: FinishedTurn[] = [];
    let live: LiveTurn | null = null;
    for (const [id, evs] of byTurn) {
      const first = evs[0]!.seq;
      const last = evs[evs.length - 1]!.seq;
      let s = this.seen.get(id);
      if (!s || s.first !== first || s.last !== last || s.count !== evs.length) {
        s = { first, last, count: evs.length, finished: null, live: null, steps: s?.steps ?? new Map() };
        this.seen.set(id, s);
      }
      if (evs.some((e) => e.type === "turn_completed")) {
        s.finished ??= finishedOf(chatTurns(evs)[0]!, s.steps);
        finished.push(s.finished);
      } else if (id === lastId && evs.some((e) => e.type === "turn_started")) {
        if (!s.live) {
          const steps = stepsOfTurn(chatTurns(evs)[0]!, true, s.steps);
          const prev = this.live;
          // An event that shows nothing new (a state): the turn as it was.
          s.live = prev && prev.turn === id && prev.steps.length === steps.length && prev.steps.every((x, i) => x === steps[i]) ? prev : { turn: id, steps };
        }
        live = s.live;
      }
    }
    if (this.seen.size > byTurn.size) for (const id of [...this.seen.keys()]) if (!byTurn.has(id)) this.seen.delete(id);
    if (finished.length !== this.finished.length || finished.some((t, i) => t !== this.finished[i])) this.finished = finished;
    this.live = live;
    return { live, finished: this.finished };
  }
}

/**
 * The steps behind each reply the trace still holds, by the message's seq. A finished turn's reply is
 * its last text (nest records it as the manager's message: `agent.turn_completed`'s text), and its steps
 * are everything else it did, kept when it called a tool. Paired by what the reply says, never by time,
 * newest turn with the newest unpaired message saying it: a repeated "Done." gets only its own turn's.
 */
export function stepsBySeq(messages: ChatMessage[], turns: FinishedTurn[]): Map<number, Step[]> {
  const out = new Map<number, Step[]>();
  // The manager's messages by what they say, newest first: each turn takes the next one not paired yet.
  const saying = new Map<string, ChatMessage[]>();
  for (const m of messages.filter((x) => x.sender === "manager").sort((a, b) => b.seq - a.seq)) {
    const t = m.text.trim();
    const ms = saying.get(t);
    if (ms) ms.push(m);
    else saying.set(t, [m]);
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (!t.reply) continue;
    const m = saying.get(t.reply)?.shift();
    if (!m) continue;
    const steps = behindReply(t);
    if (steps) out.set(m.seq, steps);
  }
  return out;
}

/** Each finished turn's steps behind its reply, worked out once per turn (the same array each time it's paired). */
const behind = new WeakMap<FinishedTurn, Step[] | null>();
function behindReply(t: FinishedTurn): Step[] | null {
  let steps = behind.get(t);
  if (steps === undefined) {
    let last = t.steps.length - 1;
    while (last >= 0 && t.steps[last]!.kind !== "text") last--;
    const rest = t.steps.filter((_, i) => i !== last);
    steps = rest.some((s) => s.kind === "tool") ? rest : null;
    behind.set(t, steps);
  }
  return steps;
}

/**
 * The log as one timeline with the manager's turn in progress (running, or held until its reply lands)
 * placed in it by time. Messages keep their order; each of the owner's or the app's comes after the steps
 * the turn had shown by then (`ts_ms` not later than its `at_ms`: one from before the turn, above it all),
 * so the stream is split into parts around those sent during it, and what the turn does afterwards
 * follows them. One in flight here (a negative seq, not yet given a time by nest) follows every step
 * shown. The manager's own messages never split it: each is a turn's reply, timed when nest reported it,
 * which can be after a later turn has begun. Messages the app never took (`failed`, a negative seq) stay
 * last, after the stream. Only the last part is live: it carries the working line (`running` and no call
 * running); a part with nothing to show is left out. A turn whose reply has landed (`landed`: its seq; the
 * turn kept while the reader reads back) shows only its earlier parts: the last one's place is its reply's,
 * whatever comes before or after the reply.
 */
export function timeline(messages: ChatMessage[], turn: (LiveTurn & { running: boolean; landed?: number }) | null, now = Date.now()): LogItem[] {
  if (!turn) return groupLog(messages, now);
  const local = (m: ChatMessage) => m.seq < 0 && (m.status ?? (m.error ? "failed" : "owed")) === "failed";
  const kept = messages.filter((m) => !local(m));
  const { steps } = turn;
  const entries: (ChatMessage | Extract<LogItem, { kind: "stream" }>)[] = [];
  // Keyed by their order, so a part keeps its rows as the turn grows and the live one as messages come.
  let n = 0;
  const part = (from: number, to: number, live: boolean) => {
    const working = live && turn.running && !steps.some((s) => s.kind === "tool" && s.status === "running");
    if (to > from || working) entries.push({ kind: "stream", key: `stream:${turn.turn}:${n++}`, steps: steps.slice(from, to), working });
  };
  let cut = 0;
  for (const m of kept) {
    // Never back before a message already placed: the messages keep their order.
    const after = steps.findIndex((s) => s.ts_ms > m.at_ms);
    const at = m.sender === "manager" ? cut : m.seq < 0 ? steps.length : after < 0 ? steps.length : after;
    if (at > cut && !(turn.landed !== undefined && at === steps.length)) {
      part(cut, at, false);
      cut = at;
    }
    entries.push(m);
  }
  if (turn.landed === undefined) part(cut, steps.length, true);
  return grouped([...entries, ...messages.filter(local)], now);
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
