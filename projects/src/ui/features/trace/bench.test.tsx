// The trace's cost while it streams, measured through the manager's trace over a fake socket: state
// changes, React commits (the fade-ins' too), turn renders, line renders and Markdown renders, and the time in jsdom, for
// (a) opening on a 1,000-event backlog, each message its own task as a browser delivers them, and
// (b) live events arriving one by one with 1,500 held. It prints its numbers (the PR's before/after table)
// and holds the bounds the batching and memoization give.
import { MantineProvider } from "@mantine/core";
import { act, render } from "@testing-library/react";
import { type ComponentProps, memo, Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as layout from "../../layout";
import { FakeSocket } from "../../test/fakeSocket";
import { cssVariablesResolver, theme } from "../../theme";
import { ManagerTrace } from "./AgentTraces";
import type { TraceEvent } from "./model";

const n = vi.hoisted(() => ({ states: 0, commits: 0, rules: 0, lines: 0, markdown: 0 }));
// State changes: each new state the hook hands the view.
vi.mock("./useTrace", async (importOriginal) => {
  const real = await importOriginal<typeof import("./useTrace")>();
  let last: unknown = null;
  return {
    useTrace: (agent: string | null) => {
      const r = real.useTrace(agent);
      if (r.state !== last) {
        last = r.state;
        n.states++;
      }
      return r;
    },
  };
});
vi.mock("../../layout", async (importOriginal) => {
  const real = await importOriginal<typeof layout>();
  return {
    ...real,
    TermRule: (p: ComponentProps<typeof real.TermRule>) => {
      n.rules++;
      return real.TermRule(p);
    },
    TermLine: (p: ComponentProps<typeof real.TermLine>) => {
      n.lines++;
      return real.TermLine(p);
    },
  };
});
vi.mock("./TraceMarkdown", () => ({
  TraceMarkdown: memo(function TraceMarkdown({ text }: { text: string }) {
    n.markdown++;
    return <span>{text}</span>;
  }),
}));

/** The real clock (fake timers replace `performance.now`). */
const clock = performance.now.bind(performance);

afterEach(() => {
  vi.useRealTimers();
});

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): TraceEvent => ({ seq, ts_ms: 1_000 + seq, type, ...more });

/** `count` turns of ten events from seq `from`, the last one still running. */
function turns(count: number, from = 1): TraceEvent[] {
  const out: TraceEvent[] = [];
  let seq = from;
  for (let t = 0; t < count; t++) {
    const turn = `trn_${from}_${t}`;
    out.push(ev(seq++, "turn_started", { turn, input_kind: "user" }));
    out.push(ev(seq++, "assistant_text", { turn, text: `looking at ${turn}` }));
    for (let c = 0; c < 3; c++) {
      out.push(ev(seq++, "tool_call", { turn, call_id: `c_${turn}_${c}`, name: "Bash", input: '{"command":"npm test"}' }));
      out.push(ev(seq++, "tool_result", { turn, call_id: `c_${turn}_${c}`, is_error: false, summary: "line 1\nline 2\nline 3\nline 4" }));
    }
    out.push(ev(seq++, "assistant_text", { turn, text: `done with ${turn}` }));
    out.push(ev(seq++, "turn_completed", { turn, stop_reason: "end_turn" }));
  }
  return out.slice(0, count * 10 - 1);
}

function open() {
  vi.stubGlobal("WebSocket", FakeSocket);
  FakeSocket.reset();
  vi.useFakeTimers();
  render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      <Profiler id="trace" onRender={() => void n.commits++}>
        <ManagerTrace settings={{ manager: "agt_bench" }} />
      </Profiler>
    </MantineProvider>,
  );
  const sock = FakeSocket.latest("agt_bench")!;
  act(() => sock.open());
  return sock;
}
const zero = () => Object.assign(n, { states: 0, commits: 0, rules: 0, lines: 0, markdown: 0 });
/** Each waiting frame run (the trace applies its batch on one). */
const frames = () => act(() => void vi.advanceTimersToNextFrame());

describe("the trace's cost", () => {
  it("opening on a 1,000-event backlog: a handful of state changes, each turn rendered about once", () => {
    const sock = open();
    const backlog = turns(100);
    zero();
    const t0 = clock();
    for (const m of backlog) act(() => sock.message(m));
    frames();
    act(() => sock.message({ type: "live" }));
    const ms = clock() - t0;
    const r = { ...n };
    console.log(`BENCH backlog-1000: state_changes=${r.states} commits=${r.commits} turn_renders=${r.rules} line_renders=${r.lines} markdown_renders=${r.markdown} ms=${ms.toFixed(0)}`);
    expect(r.states).toBeLessThanOrEqual(5);
    expect(r.rules).toBeLessThanOrEqual(2 * 100);
  });

  it("live events with 1,500 held: each re-renders its own turn only", () => {
    const sock = open();
    act(() => {
      for (const m of turns(150)) sock.message(m);
      sock.message({ type: "live" });
    });
    frames();
    const turn = turns(150).at(-1)!.turn!;
    const live = 20;
    zero();
    const t0 = clock();
    for (let i = 0; i < live; i++) {
      act(() => sock.message(ev(2000 + i, "assistant_text", { turn, text: `live ${i}` })));
      frames();
    }
    const ms = clock() - t0;
    const per = (x: number) => (x / live).toFixed(1);
    console.log(`BENCH live-1500: per_event state_changes=${per(n.states)} commits=${per(n.commits)} turn_renders=${per(n.rules)} line_renders=${per(n.lines)} markdown_renders=${per(n.markdown)} ms=${(ms / live).toFixed(1)}`);
    expect(n.rules).toBeLessThanOrEqual(2 * live);
    expect(n.lines).toBeLessThanOrEqual(2 * live);
  });
});
