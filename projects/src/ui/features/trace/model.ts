// An agent's live trace as the page holds it: nest's messages (docs/control-plane/api/, "Live trace")
// folded into one state, and the turns they group into. Pure, so the socket's handling and the view are
// tested apart.

/** One event of the trace: nest's shape, `seq` per agent. Unknown types are kept (for `seq`) but not shown. */
export interface TraceEvent {
  seq: number;
  ts_ms: number;
  turn?: string;
  type: string;
  [k: string]: unknown;
}

export type TraceStatus = "connecting" | "live" | "reconnecting" | "ended";

export interface TraceState {
  /** Events by seq, oldest first, at most `MAX_EVENTS`. */
  events: TraceEvent[];
  /** The last seq received: the next connect's `after`. */
  last: number;
  status: TraceStatus;
  /** Events nest no longer holds, from the first connect that reported them. */
  gap: { from: number; to: number } | null;
  /** Events with a seq above this arrived while watching: only they fade in (never a backlog, never on a reconnect). */
  animateAfter: number;
  /** Older events were dropped from view to bound the page's memory. */
  trimmed: boolean;
  /** The trace history before the ring (nest's `history` route), oldest first. */
  older: HistoryEvent[];
  /** Where the next older page starts: undefined until nest offers history, null once its start is reached. */
  olderCursor: string | null | undefined;
  olderState: "idle" | "loading" | "error";
}

/** A history event: the live shape without `seq` or `turn`, with its transcript entry's offset. */
export interface HistoryEvent {
  ts_ms: number;
  entry: number;
  type: string;
  [k: string]: unknown;
}

/** A page of nest's trace history. */
export interface HistoryPage {
  events: HistoryEvent[];
  next_before: string | null;
  reset?: true;
}

/** The most events the page keeps for one agent (nest's ring holds 1,000). */
export const MAX_EVENTS = 2000;

export const initialTrace = (): TraceState => ({
  events: [], last: 0, status: "connecting", gap: null, animateAfter: Number.POSITIVE_INFINITY, trimmed: false, older: [], olderCursor: undefined, olderState: "idle",
});

export type TraceAction =
  | { kind: "message"; data: unknown }
  | { kind: "open" }
  | { kind: "closed" }
  | { kind: "reset" }
  | { kind: "older_loading" }
  | { kind: "older_failed" }
  | { kind: "older_loaded"; page: HistoryPage };

/** Fold one socket happening into the state. */
export function traceReducer(s: TraceState, a: TraceAction): TraceState {
  switch (a.kind) {
    case "reset":
      return initialTrace();
    case "open":
      return s.status === "ended" ? s : { ...s, status: s.last > 0 || s.events.length ? "reconnecting" : "connecting" };
    case "older_loading":
      return { ...s, olderState: "loading" };
    case "older_failed":
      return { ...s, olderState: "error" };
    case "older_loaded":
      // A rewritten transcript: what was paged is from another base, so it starts over from nest's cursor.
      if (a.page.reset) return { ...s, older: [], olderCursor: a.page.next_before, olderState: "idle" };
      return { ...s, older: [...a.page.events, ...s.older], olderCursor: a.page.next_before, olderState: "idle" };
    case "closed":
      // Not live until the next connect's backlog is done.
      return s.status === "ended" ? s : { ...s, status: "reconnecting", animateAfter: Number.POSITIVE_INFINITY };
    case "message": {
      const m = a.data as { type?: unknown; seq?: unknown; from?: unknown; to?: unknown; before?: unknown } | null;
      if (!m || typeof m.type !== "string") return s;
      // nest offers its history before the ring: taken once (a later connect's offer is the same seam).
      if (m.type === "history" && typeof m.before === "string") return s.olderCursor === undefined ? { ...s, olderCursor: m.before } : s;
      if (m.type === "gap" && typeof m.before === "string") {
        // Events gone from the ring, with the history that covers them: what's held is dropped and backfilled
        // from that cursor, so nothing is shown twice or missed (nest's rule for stitching after a gap).
        return { ...s, events: [], older: [], olderCursor: m.before, olderState: "idle", gap: null, trimmed: false };
      }
      if (m.type === "gap" && typeof m.from === "number" && typeof m.to === "number") {
        // Below what we already have: it says nothing new.
        return m.to <= s.last ? s : { ...s, gap: s.gap ? { from: Math.min(s.gap.from, m.from), to: Math.max(s.gap.to, m.to) } : { from: m.from, to: m.to } };
      }
      if (m.type === "live") return { ...s, status: "live", animateAfter: s.last };
      let next = s;
      if (typeof m.seq === "number") {
        // A repeat (an overlap after a reconnect) changes nothing.
        if (m.seq <= s.last) return m.type === "ended" ? { ...s, status: "ended" } : s;
        const events = [...s.events, m as TraceEvent];
        const trimmed = events.length > MAX_EVENTS;
        next = { ...s, events: trimmed ? events.slice(events.length - MAX_EVENTS) : events, last: m.seq, trimmed: s.trimmed || trimmed };
      }
      return m.type === "ended" ? { ...next, status: "ended" } : next;
    }
  }
}

/** A tool call and its result, when it came. */
export interface ToolItem {
  kind: "tool";
  key: string;
  /** From the ring, with its seq; history's have none (and never fade in). */
  seq: number | null;
  call: TraceEvent | HistoryEvent;
  result: TraceEvent | HistoryEvent | null;
}
export type TraceItem = ToolItem | { kind: "event"; key: string; seq: number | null; event: TraceEvent | HistoryEvent };

/** The events of one turn (or between turns: `turn` null), in order, each tool call with its result. */
export interface TurnGroup {
  key: string;
  turn: string | null;
  items: TraceItem[];
  started: TraceEvent | HistoryEvent | null;
  completed: TraceEvent | HistoryEvent | null;
}

/**
 * Group the history (oldest first; its turns are its `turn_started`s, having no ids) and then the ring's
 * events into consecutive runs by turn, pairing each tool result with its call.
 */
export function groupTurns(events: TraceEvent[], older: HistoryEvent[] = []): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let cur: TurnGroup | null = null;
  let calls = new Map<string, ToolItem>();
  const add = (ev: TraceEvent | HistoryEvent, turn: string | null, key: string, seq: number | null) => {
    if (!cur || cur.turn !== turn) {
      cur = { key: `${turn ?? "between"}:${key}`, turn, items: [], started: null, completed: null };
      groups.push(cur);
      calls = new Map();
    }
    if (ev.type === "turn_started") cur.started = ev;
    else if (ev.type === "turn_completed") cur.completed = ev;
    else if (ev.type === "tool_call") {
      const item: ToolItem = { kind: "tool", key, seq, call: ev, result: null };
      calls.set(String(ev.call_id), item);
      cur.items.push(item);
    } else if (ev.type === "tool_result" && calls.has(String(ev.call_id))) {
      calls.get(String(ev.call_id))!.result = ev;
    } else {
      cur.items.push({ kind: "event", key, seq, event: ev });
    }
  };
  // Keys from the entry (and the event's place in it), so a page prepended later keeps every key.
  let hturn: string | null = null;
  let entry = -1;
  let k = 0;
  for (const ev of older) {
    k = ev.entry === entry ? k + 1 : 0;
    entry = ev.entry;
    if (ev.type === "turn_started") hturn = `h${ev.entry}`;
    add(ev, hturn, `h${ev.entry}.${k}`, null);
  }
  for (const ev of events) add(ev, ev.turn ?? null, `s${ev.seq}`, ev.seq);
  return groups;
}

/** The agent's state as the trace last said it, if it did. */
export function lastState(events: TraceEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "state") return String(events[i]!.state);
  return null;
}

/** The trace's address for `agent` on this page's origin, after `after`. */
export function traceUrl(agent: string, after: number, origin: string): string {
  const u = new URL(`/api/agents/${encodeURIComponent(agent)}/trace`, origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  if (after > 0) u.searchParams.set("after", String(after));
  return u.toString();
}

/** The wait before reconnect attempt `n` (1-based): 1 s, doubling, at most 30 s. */
export const reconnectDelay = (n: number) => Math.min(1000 * 2 ** Math.max(0, n - 1), 30_000);
/** How often an open socket sends nest's keepalive (`ping`, answered without waking the agent's object). */
export const PING_EVERY_MS = 25_000;
/** Events per history page the viewer asks for. */
export const HISTORY_PAGE = 100;

/** The app's history route for `agent`, before `before`. */
export const historyUrl = (agent: string, before: string) =>
  `/api/agents/${encodeURIComponent(agent)}/trace/history?limit=${HISTORY_PAGE}&before=${encodeURIComponent(before)}`;

/** A tool's display name: an MCP tool's without its server's prefix (`mcp__nest__Bash` is `Bash`). */
export const toolName = (name: string) => name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");

/** The keys whose value is a tool's main argument, in the order they're looked for. */
const PRIMARY = ["command", "file_path", "path", "pattern", "url", "query", "prompt", "description", "name", "text"];

/** A tool call's short main argument: its first line, at most 60 characters (`Bash(npm run build)`). */
export function primaryArg(input: unknown): string {
  let v: unknown = input;
  if (typeof input === "string") {
    try {
      v = JSON.parse(input);
    } catch {
      return "";
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>;
  const key = PRIMARY.find((k) => typeof o[k] === "string" && o[k]) ?? Object.keys(o).find((k) => typeof o[k] === "string" && o[k]);
  if (!key) return "";
  const first = (o[key] as string).split("\n")[0]!.trim();
  return [...first].length > 60 ? `${[...first].slice(0, 59).join("")}…` : first;
}

/** A tool result's lines, and how many past the first `shown`. */
export function resultLines(summary: unknown, shown = 3): { head: string[]; more: number; all: string[] } {
  const all = typeof summary === "string" && summary ? summary.replace(/\n+$/, "").split("\n") : [];
  return { head: all.slice(0, shown), more: Math.max(0, all.length - shown), all };
}
