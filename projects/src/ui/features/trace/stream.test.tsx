// The trace kept cheap while it streams: messages applied in batches (one state change per frame at most,
// a backlog in a handful, applied at once on `live`, `ended` and a close), a batch folded like the same
// messages one by one, turns grouped from the last state's so unchanged turns keep their objects, and an
// appended event re-rendering its own turn only.
import { MantineProvider } from "@mantine/core";
import { act, render } from "@testing-library/react";
import { type ComponentProps, memo, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as layout from "../../layout";
import { FakeSocket } from "../../test/fakeSocket";
import { cssVariablesResolver, theme } from "../../theme";
import { groupTurns, groupTurnsFrom, type HistoryEvent, initialTrace, MAX_EVENTS, type TraceEvent, type TraceState, traceReducer } from "./model";
import { TraceLog } from "./TraceView";
import { useTrace } from "./useTrace";

// Counters on the turn's rule (one per turn with an id) and on the assistant's Markdown, by its text.
const counts = vi.hoisted(() => ({ rules: 0, markdown: new Map<string, number>() }));
vi.mock("../../layout", async (importOriginal) => {
  const real = await importOriginal<typeof layout>();
  return {
    ...real,
    TermRule: (p: ComponentProps<typeof real.TermRule>) => {
      counts.rules++;
      return real.TermRule(p);
    },
  };
});
vi.mock("./TraceMarkdown", () => ({
  TraceMarkdown: memo(function TraceMarkdown({ text }: { text: string }) {
    counts.markdown.set(text, (counts.markdown.get(text) ?? 0) + 1);
    return <span>{text}</span>;
  }),
}));

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): TraceEvent => ({ seq, ts_ms: 1_000 + seq, type, ...more });
const single = (msgs: unknown[], s = initialTrace()) => msgs.reduce<TraceState>((st, m) => traceReducer(st, { kind: "message", data: m }), s);
const batched = (msgs: unknown[], s = initialTrace()) => traceReducer(s, { kind: "messages", data: msgs });

/** `n` turns of ten events each from seq `from`: started, text, three tool calls with results, text, completed. */
function turns(n: number, from = 1): TraceEvent[] {
  const out: TraceEvent[] = [];
  let seq = from;
  for (let t = 0; t < n; t++) {
    const turn = `trn_${from}_${t}`;
    out.push(ev(seq++, "turn_started", { turn, input_kind: "user" }));
    out.push(ev(seq++, "assistant_text", { turn, text: `text ${turn}` }));
    for (let c = 0; c < 3; c++) {
      out.push(ev(seq++, "tool_call", { turn, call_id: `c_${turn}_${c}`, name: "Bash", input: '{"command":"ls"}' }));
      out.push(ev(seq++, "tool_result", { turn, call_id: `c_${turn}_${c}`, is_error: false, summary: "ok" }));
    }
    out.push(ev(seq++, "assistant_text", { turn, text: `done ${turn}` }));
    out.push(ev(seq++, "turn_completed", { turn, stop_reason: "end_turn" }));
  }
  return out.slice(0, n * 10 - 1); // the last turn still running
}

describe("a batch of messages", () => {
  const sequences: Record<string, unknown[][]> = {
    // Each: the messages before, then the batch.
    "a gap with history in the middle": [[...turns(2)], [ev(20, "assistant_text"), { type: "gap", from: 21, to: 40, before: "cur" }, ev(41, "assistant_text", { turn: "x" }), ev(42, "tool_call", { turn: "x", call_id: "a" })]],
    "a gap without history, and one below what's held": [[...turns(1)], [{ type: "gap", from: 1, to: 3 }, { type: "gap", from: 12, to: 30 }, ev(31, "state", { state: "idle" }), { type: "gap", from: 5, to: 40 }]],
    "a reconnect's overlap, then live": [[...turns(3), { type: "live" }], [ev(25, "assistant_text"), ev(28, "assistant_text"), ev(29, "tool_call", { call_id: "z" }), ev(30, "tool_result", { call_id: "z" }), { type: "live" }, ev(31, "assistant_text")]],
    "overflow past MAX_EVENTS": [[...turns(MAX_EVENTS / 10 - 1)], [...turns(30, MAX_EVENTS)]],
    "a batch on its own bigger than MAX_EVENTS": [[...turns(5)], [...turns(MAX_EVENTS / 10 + 20, 100)]],
    "the history offer, taken once, and the end": [[], [{ type: "history", before: "h1" }, ev(1, "assistant_text"), { type: "history", before: "h2" }, ev(2, "ended", { reason: "done" }), { type: "ended" }]],
    "junk and unknown types": [[ev(1, "state")], [null, "x", { seq: 4 }, ev(2, "something_new"), { type: "pong" }, ev(3, "assistant_text")]],
  };
  for (const [name, [before, batch]] of Object.entries(sequences)) {
    it(`gives the state the same messages give one by one: ${name}`, () => {
      const base = single(before!);
      expect(batched(batch!, base)).toEqual(single(batch!, base));
    });
  }

  it("changes nothing, and returns the same state, when nothing in it is new", () => {
    const s = single([...turns(2), { type: "live" }]);
    expect(batched([turns(2)[3], { type: "pong" }, { type: "gap", from: 1, to: 2 }], s)).toBe(s);
  });

  it("keeps the held events' objects and copies the array once", () => {
    const s = single(turns(50));
    const next = batched(turns(5, 1000), s);
    expect(next.events).toHaveLength(s.events.length + 49);
    expect(next.events.slice(0, s.events.length).every((e, i) => e === s.events[i])).toBe(true);
  });
});

describe("grouping from the last state's", () => {
  it("after one event appended to 1,000, every turn but the last is the same object", () => {
    const events = turns(100);
    expect(events).toHaveLength(999);
    const a = groupTurnsFrom(null, events);
    const b = groupTurnsFrom(a, [...events, ev(1000, "turn_completed", { turn: events.at(-1)!.turn, stop_reason: "end_turn" })]);
    expect(b.groups).toHaveLength(100);
    expect(b.groups.slice(0, -1).every((g, i) => g === a.groups[i])).toBe(true);
    expect(b.groups.at(-1)).not.toBe(a.groups.at(-1));
    // The changed turn's untouched items are kept too; the turn it was is unchanged.
    expect(b.groups.at(-1)!.items.every((x, i) => x === a.groups.at(-1)!.items[i])).toBe(true);
    expect(a.groups.at(-1)!.completed).toBeNull();
  });

  it("an appended event is the only one read: the work is for what came, not for all that's held", () => {
    let reads = 0;
    const counted = turns(100).map((e) => {
      const { type, ...rest } = e;
      return Object.defineProperty(rest, "type", { enumerable: true, get: () => (reads++, type) }) as TraceEvent;
    });
    const a = groupTurnsFrom(null, counted);
    reads = 0;
    groupTurnsFrom(a, [...counted, ev(1000, "assistant_text", { turn: counted.at(-1)!.turn })]);
    expect(reads).toBe(0);
  });

  it("a result changes only its call's item, and a new turn changes no earlier one", () => {
    const base = [...turns(3), ev(30, "turn_started", { turn: "n" }), ev(31, "tool_call", { turn: "n", call_id: "k" }), ev(32, "assistant_text", { turn: "n", text: "t" })];
    const a = groupTurnsFrom(null, base);
    const b = groupTurnsFrom(a, [...base, ev(33, "tool_result", { turn: "n", call_id: "k", summary: "done" })]);
    const [was, now] = [a.groups.at(-1)!, b.groups.at(-1)!];
    expect(now.items[0]).not.toBe(was.items[0]);
    expect(now.items[0]).toMatchObject({ kind: "tool", result: { seq: 33 } });
    expect(was.items[0]).toMatchObject({ kind: "tool", result: null });
    expect(now.items[1]).toBe(was.items[1]);
    const c = groupTurnsFrom(b, [...b.events, ev(34, "turn_started", { turn: "m" })]);
    expect(c.groups.slice(0, -1).every((g, i) => g === b.groups[i])).toBe(true);
  });

  it("groups as grouping afresh does, however the events come", () => {
    const all = [ev(1, "state"), ...turns(12, 2), ev(200, "tool_result", { turn: "orphan", call_id: "none" }), ev(201, "assistant_text"), ev(202, "tool_call", { call_id: "q" }), ev(203, "tool_result", { call_id: "q" })];
    const older: HistoryEvent[] = [{ ts_ms: 1, entry: 1, type: "assistant_text", text: "before any turn" }, { ts_ms: 2, entry: 2, type: "turn_started" }, { ts_ms: 3, entry: 3, type: "tool_call", call_id: "h" }];
    for (const step of [1, 3, 7, 40]) {
      let g = groupTurnsFrom(null, [], older);
      for (let n = step; n < all.length + step; n += step) g = groupTurnsFrom(g, all.slice(0, Math.min(n, all.length)), older);
      expect(g.groups).toEqual(groupTurns(all, older));
    }
  });

  it("history paged in, or the oldest events trimmed, keep every turn that came out the same", () => {
    const events = turns(10, 100);
    const older: HistoryEvent[] = [{ ts_ms: 1, entry: 5, type: "turn_started" }, { ts_ms: 2, entry: 6, type: "assistant_text", text: "old" }];
    const a = groupTurnsFrom(null, events, older);
    const paged = groupTurnsFrom(a, events, [{ ts_ms: 0, entry: 1, type: "turn_started" }, ...older]);
    expect(paged.groups.slice(2).every((g, i) => g === a.groups[i + 1])).toBe(true);
    expect(paged.groups).toEqual(groupTurns(events, [{ ts_ms: 0, entry: 1, type: "turn_started" }, ...older]));
    // The first ring turn loses its first event: it changes, the rest don't.
    const trimmed = groupTurnsFrom(a, [...events.slice(1), ev(500, "assistant_text", { turn: events.at(-1)!.turn })], older);
    expect(trimmed.groups[1]).not.toBe(a.groups[1]);
    expect(trimmed.groups.slice(2, -1).every((g, i) => g === a.groups[i + 2])).toBe(true);
    expect(trimmed.groups).toEqual(groupTurns([...events.slice(1), ev(500, "assistant_text", { turn: events.at(-1)!.turn })], older));
  });
});

// --- The socket's batching ------------------------------------------------------------------------------

beforeEach(() => {
  FakeSocket.reset();
  counts.rules = 0;
  counts.markdown.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const wrap = (node: ReactNode) => (
  <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
    {node}
  </MantineProvider>
);

/** A page reading the hook, counting the states it's given; its socket opened. */
function probe() {
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  const seen: TraceState[] = [];
  function Probe() {
    const { state } = useTrace("agt_x");
    if (seen.at(-1) !== state) seen.push(state);
    return null;
  }
  const view = render(<Probe />);
  const sock = FakeSocket.latest("agt_x")!;
  act(() => sock.open());
  const at = seen.length;
  return { ...view, sock, seen, changes: () => seen.length - at, now: () => seen.at(-1)! };
}
const frame = () => act(() => void vi.advanceTimersToNextFrame());

describe("the socket's batches", () => {
  it("a backlog of 1,000 events in one burst is one state change, at the next frame", () => {
    const { sock, changes, now } = probe();
    const backlog = turns(100);
    act(() => backlog.forEach((m) => sock.message(m)));
    expect(changes()).toBe(0);
    frame();
    expect(changes()).toBe(1);
    expect(now().events.map((e) => e.seq)).toEqual(backlog.map((e) => e.seq));
    act(() => sock.message({ type: "live" }));
    expect(changes()).toBe(2);
    expect(now().status).toBe("live");
  });

  it("a backlog's messages each in their own task still wait for the frame, and `live` applies them at once", () => {
    const { sock, changes, now } = probe();
    for (const m of turns(100)) act(() => sock.message(m));
    expect(changes()).toBe(0);
    act(() => sock.message({ type: "live" }));
    expect(changes()).toBe(1);
    expect(now()).toMatchObject({ status: "live", last: 999, animateAfter: 999 });
    expect(now().events).toHaveLength(999);
  });

  it("over several frames: at most one state change per frame", () => {
    const { sock, changes } = probe();
    const backlog = turns(30);
    for (let f = 0; f < 3; f++) {
      for (const m of backlog.slice(f * 100, f * 100 + 100)) act(() => sock.message(m));
      frame();
      expect(changes()).toBe(f + 1);
    }
    frame();
    expect(changes()).toBe(3);
  });

  it("once live, a message shows at once when the view is drawn; ones coming before it's drawn wait for the frame, in order", () => {
    const { sock, changes, now } = probe();
    act(() => sock.message({ type: "live" }));
    const at = changes();
    act(() => sock.message(ev(1, "assistant_text")));
    expect(changes()).toBe(at + 1);
    act(() => {
      sock.message(ev(2, "assistant_text"));
      sock.message(ev(3, "assistant_text"));
      sock.message(ev(4, "assistant_text"));
    });
    expect(now().events.map((e) => e.seq)).toEqual([1, 2]);
    expect(changes()).toBe(at + 2);
    frame();
    expect(now().events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(changes()).toBe(at + 3);
  });

  it("`ended` and a close apply what's waiting first, and the next connect resumes after it", () => {
    const { sock, now } = probe();
    act(() => {
      sock.message(ev(1, "assistant_text"));
      sock.message(ev(2, "assistant_text"));
    });
    act(() => sock.drop());
    expect(now()).toMatchObject({ status: "reconnecting", last: 2 });
    expect(now().events).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(1000));
    const next = FakeSocket.opened[1]!;
    expect(next.url).toMatch(/after=2$/);
    act(() => {
      next.open();
      next.message(ev(3, "assistant_text"));
      next.message(ev(4, "ended", { reason: "done" }));
    });
    expect(now()).toMatchObject({ status: "ended", last: 4 });
  });

  it("where frames don't come (a hidden tab), what's waiting is applied a moment later", () => {
    const { sock, now } = probe();
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    act(() => sock.message(ev(1, "assistant_text")));
    expect(now().events).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(100));
    expect(now().events).toHaveLength(1);
  });
});

// --- Renders ---------------------------------------------------------------------------------------------

describe("an appended event re-renders its own turn only", () => {
  it("with 20 turns held: at most 2 turn renders per event, and no earlier turn's Markdown again", () => {
    const events = turns(20);
    const state = (evs: TraceEvent[]): TraceState => ({ ...initialTrace(), events: evs, last: evs.at(-1)!.seq, status: "live", animateAfter: 199 });
    const view = render(wrap(<TraceLog title="T" state={state(events)} />));
    expect(counts.rules).toBe(20);
    const before = new Map(counts.markdown);
    const last = events.at(-1)!.turn!;
    let held = events;
    for (let i = 0; i < 5; i++) {
      counts.rules = 0;
      held = [...held, ev(200 + i, "assistant_text", { turn: last, text: `new ${i}` })];
      view.rerender(wrap(<TraceLog title="T" state={state(held)} />));
      expect(counts.rules).toBeLessThanOrEqual(2);
    }
    for (const [text, n] of before) expect(counts.markdown.get(text), text).toBe(n);
    // A new turn: it renders, the one before doesn't.
    counts.rules = 0;
    view.rerender(wrap(<TraceLog title="T" state={state([...held, ev(300, "turn_started", { turn: "trn_new" })])} />));
    expect(counts.rules).toBe(1);
  });
});
