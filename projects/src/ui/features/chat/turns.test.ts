// The trace's turns read as the trace grows (TurnReader): the same steps as reading all of it afresh,
// however the events come (one at a time, several per read, the ring cutting its front, a reset), each
// finished turn's tool inputs parsed once, and what didn't change kept as it was, so what's drawn from it
// can be skipped.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TraceEvent } from "../trace/model";
import { finishedTurns, liveTurn, TurnReader } from "./model";

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
let seq = 0;
const ev = (turn: string | undefined, type: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: NOW + seq, type, turn, ...more }) as unknown as TraceEvent;

/** Turns as the manager runs them: text, calls with string inputs (one cut mid-JSON), results, a call never answered, events without a turn, and a last turn still running. */
function trace(): TraceEvent[] {
  const out: TraceEvent[] = [];
  for (let k = 0; k < 6; k++) {
    const t = `trn_${k}`;
    out.push(ev(t, "turn_started"), ev(t, "assistant_text", { text: `Looking ${k}.` }));
    out.push(ev(t, "tool_call", { call_id: "a", name: "Bash", input: JSON.stringify({ command: `ls ${k}`, description: "list" }) }));
    out.push(ev(undefined, "state", { state: "running" }));
    out.push(ev(t, "tool_result", { call_id: "a", is_error: k % 2 === 1, summary: `out ${k}` }));
    out.push(ev(t, "tool_call", { call_id: "b", name: "Write", input: `{"file_path":"f${k}.ts","content":"cut sh` }));
    if (k % 3 !== 2) out.push(ev(t, "tool_result", { call_id: "b", is_error: false, summary: "ok" }));
    out.push(ev(t, "assistant_text", { text: `Done ${k}.` }));
    out.push(ev(t, "turn_completed", { stop_reason: "end_turn" }));
  }
  const t = "trn_live";
  out.push(ev(t, "turn_started"), ev(t, "assistant_text", { text: "On it." }), ev(t, "tool_call", { call_id: "a", name: "Read", input: { file_path: "a.ts" } }), ev(t, "tool_result", { call_id: "a", is_error: false, summary: "x" }));
  out.push(ev(t, "state", { state: "thinking" }), ev(t, "tool_call", { call_id: "b", name: "Bash", input: JSON.stringify({ command: "npm test" }) }));
  return out;
}

afterEach(() => vi.restoreAllMocks());

describe("TurnReader", () => {
  it("reads as the trace grows what a fresh read gives: one event at a time, several at once, the ring cutting its front, after a reset", () => {
    const all = trace();
    for (const step of [1, 3, 7]) {
      for (const ring of [Infinity, 12]) {
        const reader = new TurnReader();
        for (let k = 0; k <= all.length; k += step) {
          const events = all.slice(Math.max(0, k - ring), k);
          const got = reader.read(events);
          expect(got.live).toEqual(liveTurn(events));
          expect(got.finished).toEqual(finishedTurns(events));
        }
        // The trace starts over (a gap): what it held is gone.
        expect(reader.read([])).toEqual({ live: null, finished: [] });
        const again = all.slice(0, 20);
        expect(reader.read(again)).toEqual({ live: liveTurn(again), finished: finishedTurns(again) });
      }
    }
  });

  it("with 30 finished turns held, 50 more events of the turn in progress parse no finished turn's input, and keep the finished turns as they were", () => {
    const events: TraceEvent[] = [];
    for (let k = 0; k < 30; k++) {
      const t = `trn_${k}`;
      events.push(
        ev(t, "turn_started"),
        ev(t, "tool_call", { call_id: "c", name: "Bash", input: JSON.stringify({ command: `finished-input ${k}`, description: "x".repeat(2000) }) }),
        ev(t, "tool_result", { call_id: "c", is_error: false, summary: "ok" }),
        ev(t, "assistant_text", { text: `Reply ${k}` }),
        ev(t, "turn_completed", {}),
      );
    }
    events.push(ev("trn_live", "turn_started"));
    const reader = new TurnReader();
    let read = reader.read(events);
    const finished = read.finished;
    expect(finished).toHaveLength(30);
    const parse = vi.spyOn(JSON, "parse");
    for (let i = 0; i < 50; i++) {
      events.push(i % 2 === 0 ? ev("trn_live", "tool_call", { call_id: `l${i}`, name: "Read", input: JSON.stringify({ file_path: `live-${i}.ts` }) }) : ev("trn_live", "tool_result", { call_id: `l${i - 1}`, is_error: false, summary: "ok" }));
      read = reader.read([...events]);
      expect(read.finished).toBe(finished);
    }
    const parsed = parse.mock.calls.map(([s]) => String(s));
    expect(parsed.filter((s) => s.includes("finished-input"))).toEqual([]);
    // Each of the turn's own calls was read once, not again with every event after it.
    expect(parsed.filter((s) => s.includes("live-"))).toHaveLength(25);
    expect(read.live?.steps).toHaveLength(25);
    expect(read.live?.steps.every((s) => s.kind === "tool" && s.status === "done")).toBe(true);
  });

  it("keeps the turn in progress as it was for an event that shows nothing, and its unchanged steps as they were for one that does", () => {
    const t = "trn_1";
    const events = [ev(t, "turn_started"), ev(t, "assistant_text", { text: "Looking." }), ev(t, "tool_call", { call_id: "a", name: "Read", input: { file_path: "a.ts" } })];
    const reader = new TurnReader();
    const before = reader.read(events).live!;
    // A state within the turn, and one without a turn: nothing new to show.
    expect(reader.read([...events, ev(t, "state", { state: "thinking" }), ev(undefined, "state", { state: "x" })]).live).toBe(before);
    const after = reader.read([...events, ev(t, "tool_result", { call_id: "a", is_error: false, summary: "ok" }), ev(t, "assistant_text", { text: "Next." })]).live!;
    expect(after).not.toBe(before);
    expect(after.steps[0]).toBe(before.steps[0]);
    expect(after.steps[1]).not.toBe(before.steps[1]);
    expect(after.steps[1]).toMatchObject({ kind: "tool", status: "done", result: "ok" });
    expect(after.steps).toHaveLength(3);
  });
});
