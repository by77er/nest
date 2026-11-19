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
  /** Messages in the order they came, applied as one change (what the socket queued for a frame). */
  | { kind: "messages"; data: readonly unknown[] }
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
    case "message":
      return applyMessages(s, [a.data]);
    case "messages":
      return applyMessages(s, a.data);
  }
}

/**
 * Fold messages into the state in order, each by the same rules as if it came alone. The events they add
 * are collected and the array is copied once at the end, not once per event; nothing changed, the state
 * is returned as it was.
 */
function applyMessages(s: TraceState, msgs: readonly unknown[]): TraceState {
  // While folding, what's held is `held` then `added` (`s.events` is stale: no rule reads it).
  let held = s.events;
  let added: TraceEvent[] = [];
  for (const data of msgs) {
    const m = data as { type?: unknown; seq?: unknown; from?: unknown; to?: unknown; before?: unknown } | null;
    if (!m || typeof m.type !== "string") continue;
    // nest offers its history before the ring: taken once (a later connect's offer is the same seam).
    if (m.type === "history" && typeof m.before === "string") {
      if (s.olderCursor === undefined) s = { ...s, olderCursor: m.before };
      continue;
    }
    if (m.type === "gap" && typeof m.before === "string") {
      // Events gone from the ring, with the history that covers them: what's held is dropped and backfilled
      // from that cursor, so nothing is shown twice or missed (nest's rule for stitching after a gap).
      held = [];
      added = [];
      s = { ...s, events: held, older: [], olderCursor: m.before, olderState: "idle", gap: null, trimmed: false };
      continue;
    }
    if (m.type === "gap" && typeof m.from === "number" && typeof m.to === "number") {
      // Below what we already have: it says nothing new.
      if (m.to > s.last) s = { ...s, gap: s.gap ? { from: Math.min(s.gap.from, m.from), to: Math.max(s.gap.to, m.to) } : { from: m.from, to: m.to } };
      continue;
    }
    if (m.type === "live") {
      s = { ...s, status: "live", animateAfter: s.last };
      continue;
    }
    if (typeof m.seq === "number") {
      // A repeat (an overlap after a reconnect) changes nothing.
      if (m.seq <= s.last) {
        if (m.type === "ended") s = { ...s, status: "ended" };
        continue;
      }
      added.push(m as TraceEvent);
      // What's held only grows between resets: it went over MAX_EVENTS at some point iff it is over now.
      s = { ...s, last: m.seq, trimmed: s.trimmed || held.length + added.length > MAX_EVENTS };
    }
    if (m.type === "ended") s = { ...s, status: "ended" };
  }
  if (added.length === 0) return held === s.events ? s : { ...s, events: held };
  // One copy: the newest MAX_EVENTS of what was held and what came.
  const drop = Math.max(0, held.length + added.length - MAX_EVENTS);
  const events = drop >= held.length ? added.slice(drop - held.length) : (drop > 0 ? held.slice(drop) : held).concat(added);
  return { ...s, events };
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
 * The turns of some events and history, kept so the next state's can be made from it: never changed once
 * returned, so a turn (or item) that didn't change between two states is the same object in both (and its
 * view can skip rendering it).
 */
export interface Grouping {
  readonly events: readonly TraceEvent[];
  readonly older: readonly HistoryEvent[];
  readonly groups: readonly TurnGroup[];
  /** The last group's tool calls by call id: their place in its items. */
  readonly calls: ReadonlyMap<string, number>;
}

/** Builds groups by appending events; the last group is copied before its first change, unless it's new. */
class Builder {
  groups: TurnGroup[];
  calls: Map<string, number>;
  /** The last group is this build's own object, so it may be changed in place. */
  private owned = false;

  constructor(from?: Grouping) {
    this.groups = from ? from.groups.slice() : [];
    this.calls = from ? (from.calls as Map<string, number>) : new Map();
  }

  add(ev: TraceEvent | HistoryEvent, turn: string | null, key: string, seq: number | null): void {
    let cur = this.groups.at(-1);
    if (!cur || cur.turn !== turn) {
      cur = { key: `${turn ?? "between"}:${key}`, turn, items: [], started: null, completed: null };
      this.groups.push(cur);
      this.calls = new Map();
      this.owned = true;
    } else if (!this.owned) {
      cur = { ...cur, items: cur.items.slice() };
      this.groups[this.groups.length - 1] = cur;
      this.calls = new Map(this.calls);
      this.owned = true;
    }
    if (ev.type === "turn_started") cur.started = ev;
    else if (ev.type === "turn_completed") cur.completed = ev;
    else if (ev.type === "tool_call") {
      this.calls.set(String(ev.call_id), cur.items.length);
      cur.items.push({ kind: "tool", key, seq, call: ev, result: null });
    } else if (ev.type === "tool_result" && this.calls.has(String(ev.call_id))) {
      const at = this.calls.get(String(ev.call_id))!;
      cur.items[at] = { ...(cur.items[at] as ToolItem), result: ev };
    } else {
      cur.items.push({ kind: "event", key, seq, event: ev });
    }
  }

  ring(ev: TraceEvent): void {
    this.add(ev, ev.turn ?? null, `s${ev.seq}`, ev.seq);
  }
}

/**
 * `next` starts with all of `prev`, judged by its ends: the reducer only appends between resets and trims,
 * reusing the event objects, so a reset or trim changes the first. (A caller building its own arrays must
 * keep to that.)
 */
const startsWith = (next: readonly TraceEvent[], prev: readonly TraceEvent[]) =>
  next.length >= prev.length && (prev.length === 0 || (next[0] === prev[0] && next[prev.length - 1] === prev[prev.length - 1]));

/**
 * Group the history (oldest first; its turns are its `turn_started`s, having no ids) and then the ring's
 * events into consecutive runs by turn, pairing each tool result with its call. From `prev` (the grouping
 * of an earlier state), events appended since are added to it: work for what came, not for all that's held,
 * and every earlier turn is the same object. Anything else (history paged in, a reset, a trim) is grouped
 * afresh, keeping the earlier objects of turns and items that came out the same.
 */
const NO_HISTORY: readonly HistoryEvent[] = [];

export function groupTurnsFrom(prev: Grouping | null, events: readonly TraceEvent[], older: readonly HistoryEvent[] = NO_HISTORY): Grouping {
  if (prev && prev.events === events && prev.older === older) return prev;
  if (prev && prev.older === older && startsWith(events, prev.events)) {
    const b = new Builder(prev);
    for (let i = prev.events.length; i < events.length; i++) b.ring(events[i]!);
    return { events, older, groups: b.groups, calls: b.calls };
  }
  const b = new Builder();
  // Keys from the entry (and the event's place in it), so a page prepended later keeps every key.
  let hturn: string | null = null;
  let entry = -1;
  let k = 0;
  for (const ev of older) {
    k = ev.entry === entry ? k + 1 : 0;
    entry = ev.entry;
    if (ev.type === "turn_started") hturn = `h${ev.entry}`;
    b.add(ev, hturn, `h${ev.entry}.${k}`, null);
  }
  for (const ev of events) b.ring(ev);
  return { events, older, groups: prev ? keepSame(prev.groups, b.groups) : b.groups, calls: b.calls };
}

/** The groups of `prev`, and their items, wherever `next` has an equal one (by key and the events in it). */
function keepSame(prev: readonly TurnGroup[], next: TurnGroup[]): TurnGroup[] {
  const groups = new Map(prev.map((g) => [g.key, g]));
  const items = new Map<string, TraceItem>();
  for (const g of prev) for (const i of g.items) items.set(i.key, i);
  const sameItem = (a: TraceItem, b: TraceItem) =>
    a.kind === "tool" ? b.kind === "tool" && a.seq === b.seq && a.call === b.call && a.result === b.result : b.kind === "event" && a.seq === b.seq && a.event === b.event;
  return next.map((g) => {
    g.items = g.items.map((i) => {
      const was = items.get(i.key);
      return was && sameItem(was, i) ? was : i;
    });
    const was = groups.get(g.key);
    return was && was.turn === g.turn && was.started === g.started && was.completed === g.completed && was.items.length === g.items.length && was.items.every((x, n) => x === g.items[n])
      ? was
      : g;
  });
}

/** The turns of these events (and history), grouped afresh. */
export function groupTurns(events: TraceEvent[], older: HistoryEvent[] = []): TurnGroup[] {
  return groupTurnsFrom(null, events, older).groups as TurnGroup[];
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
