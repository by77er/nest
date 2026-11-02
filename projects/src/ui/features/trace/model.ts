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
}

/** The most events the page keeps for one agent (nest's ring holds 1,000). */
export const MAX_EVENTS = 2000;

export const initialTrace = (): TraceState => ({ events: [], last: 0, status: "connecting", gap: null, animateAfter: Number.POSITIVE_INFINITY, trimmed: false });

export type TraceAction =
  | { kind: "message"; data: unknown }
  | { kind: "open" }
  | { kind: "closed" }
  | { kind: "reset" };

/** Fold one socket happening into the state. */
export function traceReducer(s: TraceState, a: TraceAction): TraceState {
  switch (a.kind) {
    case "reset":
      return initialTrace();
    case "open":
      return s.status === "ended" ? s : { ...s, status: s.last > 0 || s.events.length ? "reconnecting" : "connecting" };
    case "closed":
      // Not live until the next connect's backlog is done.
      return s.status === "ended" ? s : { ...s, status: "reconnecting", animateAfter: Number.POSITIVE_INFINITY };
    case "message": {
      const m = a.data as { type?: unknown; seq?: unknown; from?: unknown; to?: unknown } | null;
      if (!m || typeof m.type !== "string") return s;
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
  seq: number;
  call: TraceEvent;
  result: TraceEvent | null;
}
export type TraceItem = ToolItem | { kind: "event"; seq: number; event: TraceEvent };

/** The events of one turn (or between turns: `turn` null), in order, each tool call with its result. */
export interface TurnGroup {
  key: string;
  turn: string | null;
  items: TraceItem[];
  started: TraceEvent | null;
  completed: TraceEvent | null;
}

/** Group events into consecutive runs by turn, pairing each tool result with its call. */
export function groupTurns(events: TraceEvent[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let cur: TurnGroup | null = null;
  let calls = new Map<string, ToolItem>();
  for (const ev of events) {
    const turn = ev.turn ?? null;
    if (!cur || cur.turn !== turn) {
      cur = { key: `${turn ?? "between"}:${ev.seq}`, turn, items: [], started: null, completed: null };
      groups.push(cur);
      calls = new Map();
    }
    if (ev.type === "turn_started") cur.started = ev;
    else if (ev.type === "turn_completed") cur.completed = ev;
    else if (ev.type === "tool_call") {
      const item: ToolItem = { kind: "tool", seq: ev.seq, call: ev, result: null };
      calls.set(String(ev.call_id), item);
      cur.items.push(item);
    } else if (ev.type === "tool_result" && calls.has(String(ev.call_id))) {
      calls.get(String(ev.call_id))!.result = ev;
    } else {
      cur.items.push({ kind: "event", seq: ev.seq, event: ev });
    }
  }
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
