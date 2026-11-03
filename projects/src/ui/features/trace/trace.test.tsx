// An agent's live trace on the page: the model's folding and grouping, then the view through the app
// (each mount: the manager's, a task's worker's in its drawer, a review's reviewer's) over a fake socket playing
// nest: turns and tool calls, a drop and the resume from the last seq, the gap notice, following the
// newest event only at the bottom, and the end.
import { MantineProvider } from "@mantine/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeApi, task } from "../../test/fakeApi";
import { FakeSocket } from "../../test/fakeSocket";
import { renderApp } from "../../test/render";
import { cssVariablesResolver, theme } from "../../theme";
import { ManagerTrace, ReviewTrace } from "./AgentTraces";
import { TraceLog } from "./TraceView";
import { GLYPH } from "../../layout";
import { groupTurns, initialTrace, MAX_EVENTS, reconnectDelay, type TraceEvent, traceReducer, traceUrl } from "./model";

/** A terminal line's glyph. */
const glyphOf = (line: Element) => line.querySelector('[data-slot="glyph"]')!.textContent;

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): TraceEvent => ({ seq, ts_ms: 1_000 + seq, type, ...more });
const fold = (msgs: unknown[], s = initialTrace()) => msgs.reduce<ReturnType<typeof initialTrace>>((st, m) => traceReducer(st, { kind: "message", data: m }), s);

describe("the model", () => {
  it("keeps events once each, in seq order, and counts the last seq", () => {
    const s = fold([ev(1, "turn_started", { turn: "t" }), ev(2, "assistant_text", { turn: "t", text: "a" }), ev(2, "assistant_text", { turn: "t", text: "a" }), ev(1, "turn_started")]);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(s.last).toBe(2);
  });

  it("animates only what came after `live`, and nothing replayed after a drop", () => {
    let s = fold([ev(1, "assistant_text"), { type: "live" }, ev(2, "assistant_text")]);
    expect(s.status).toBe("live");
    expect(s.animateAfter).toBe(1);
    s = traceReducer(s, { kind: "closed" });
    expect(s.status).toBe("reconnecting");
    expect(s.animateAfter).toBe(Number.POSITIVE_INFINITY);
    s = fold([ev(3, "assistant_text"), { type: "live" }], s);
    expect(s.animateAfter).toBe(3);
  });

  it("records a gap (merging repeats) unless it's below what it has, and stops at `ended`", () => {
    let s = fold([{ type: "gap", from: 1, to: 4 }, ev(5, "state", { state: "idle" })]);
    expect(s.gap).toEqual({ from: 1, to: 4 });
    s = fold([{ type: "gap", from: 3, to: 4 }], s);
    expect(s.gap).toEqual({ from: 1, to: 4 });
    s = fold([ev(6, "ended", { reason: "stopped" })], s);
    expect(s.status).toBe("ended");
    expect(traceReducer(s, { kind: "closed" }).status).toBe("ended");
    // A replayed `ended` (no seq) ends it too.
    expect(fold([{ type: "ended", reason: "stopped" }]).status).toBe("ended");
  });

  it("bounds what it keeps", () => {
    const s = fold(Array.from({ length: MAX_EVENTS + 5 }, (_, i) => ev(i + 1, "assistant_text")));
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.events[0]!.seq).toBe(6);
    expect(s.trimmed).toBe(true);
  });

  it("groups consecutive events by turn and pairs each result with its call", () => {
    const g = groupTurns([
      ev(1, "state", { state: "working" }),
      ev(2, "turn_started", { turn: "a", input_kind: "user" }),
      ev(3, "tool_call", { turn: "a", call_id: "c1", name: "Bash" }),
      ev(4, "assistant_text", { turn: "a", text: "x" }),
      ev(5, "tool_result", { turn: "a", call_id: "c1", is_error: false }),
      ev(6, "turn_completed", { turn: "a", stop_reason: "end_turn" }),
      ev(7, "tool_result", { turn: "b", call_id: "c0", is_error: true }),
    ]);
    expect(g.map((x) => x.turn)).toEqual([null, "a", "b"]);
    expect(g[1]!.started?.seq).toBe(2);
    expect(g[1]!.completed?.seq).toBe(6);
    expect(g[1]!.items.map((i) => (i.kind === "tool" ? `tool:${i.result?.seq}` : i.event.type))).toEqual(["tool:5", "assistant_text"]);
    // A result whose call is gone from the ring shows on its own.
    expect(g[2]!.items.map((i) => i.kind)).toEqual(["event"]);
  });

  it("addresses the app's route over wss, with `after` once there's a seq, and backs off to 30 s", () => {
    expect(traceUrl("agt_x", 0, "https://projects.test/projects/prj")).toBe("wss://projects.test/api/agents/agt_x/trace");
    expect(traceUrl("agt_x", 12, "http://localhost:5173/")).toBe("ws://localhost:5173/api/agents/agt_x/trace?after=12");
    expect([1, 2, 3, 6, 9].map(reconnectDelay)).toEqual([1000, 2000, 4000, 30000, 30000]);
  });
});

// --- Through the page --------------------------------------------------------------------------------

beforeEach(() => {
  FakeSocket.reset();
});
afterEach(() => {
  vi.useRealTimers();
});

const turn = [
  ev(1, "state", { state: "working", turn: "trn_1" }),
  ev(2, "turn_started", { turn: "trn_1", input_kind: "user" }),
  ev(3, "assistant_text", { turn: "trn_1", text: "Looking at the repo" }),
  ev(4, "tool_call", { turn: "trn_1", call_id: "toolu_1", name: "Bash", input: '{"command":"ls"}' }),
  ev(5, "tool_result", { turn: "trn_1", call_id: "toolu_1", is_error: false, summary: "README.md" }),
  ev(6, "tool_call", { turn: "trn_1", call_id: "toolu_2", name: "Read", input: '{"path":"x"}' }),
  ev(7, "tool_result", { turn: "trn_1", call_id: "toolu_2", is_error: true, summary: "no such file" }),
  ev(8, "tool_call", { turn: "trn_1", call_id: "toolu_3", name: "Grep", input: "{}" }),
];

/** A mount alone, in the app's theme (Mantine's test env: no transitions or portals). */
function renderAlone(node: ReactNode) {
  vi.stubGlobal("WebSocket", FakeSocket);
  const user = userEvent.setup();
  const view = render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      {node}
    </MantineProvider>,
  );
  return { ...view, user };
}

/** The manager's trace, its socket opened and `msgs` played. */
async function managerTrace(msgs: unknown[] = [...turn, { type: "live" }]) {
  const view = renderAlone(<ManagerTrace settings={{ manager: "agt_manager" }} />);
  const sock = await waitFor(() => FakeSocket.latest("/api/agents/agt_manager/trace")!);
  act(() => {
    sock.open();
    for (const m of msgs) sock.message(m);
  });
  const panel = screen.getByRole("heading", { name: "Manager's trace" }).closest('[data-ds="section"]')!;
  return { ...view, sock, panel: panel as HTMLElement };
}

const statusOf = (panel: HTMLElement) => panel.querySelector('[data-slot="trace-status"]')!.textContent;

describe("the trace view", () => {
  it("renders a turn as a terminal transcript: a rule, `●` text, `● Name(arg)` calls with `⎿` results, input on demand", async () => {
    const { panel, user, sock } = await managerTrace();
    expect(sock.url).toBe(`ws://${window.location.host}/api/agents/agt_manager/trace`);
    expect(statusOf(panel)).toBe("Live");
    const group = within(panel).getByRole("group", { name: "Turn" });
    expect(group.querySelector('[data-ds="term-rule"]')).toHaveTextContent(/message · running$/);
    const text = group.querySelector('[data-kind="text"]')!;
    expect(glyphOf(text)).toBe(GLYPH.bullet);
    expect(text).toHaveTextContent("Looking at the repo");
    const call = (id: string) => group.querySelector(`[data-call="${id}"]`)!;
    expect(["toolu_1", "toolu_2", "toolu_3"].map((id) => call(id).getAttribute("data-state"))).toEqual(["done", "error", "running"]);
    expect(["toolu_1", "toolu_2", "toolu_3"].map((id) => glyphOf(call(id).querySelector('[data-ds="term-line"]')!))).toEqual([GLYPH.bullet, GLYPH.bullet, GLYPH.pending]);
    // A running call has no result line yet.
    expect(call("toolu_3").querySelector('[data-kind="tool_result"]')).toBeNull();
    const result = call("toolu_1").querySelector('[data-kind="tool_result"]')!;
    expect(glyphOf(result)).toBe(GLYPH.result);
    expect(result).toHaveTextContent("README.md");
    // A disclosure: its input region is hidden until asked for.
    const bash = within(group).getByRole("button", { name: "Bash(ls)" });
    expect(bash).toHaveAttribute("aria-expanded", "false");
    const region = document.getElementById(bash.getAttribute("aria-controls")!)!;
    expect(region).toHaveAttribute("hidden");
    await user.click(bash);
    expect(bash).toHaveAttribute("aria-expanded", "true");
    expect(region).not.toHaveAttribute("hidden");
    expect(region).toHaveTextContent(/"command": "ls"/);
    expect(within(group).getByRole("button", { name: "Read(x)" })).toBeInTheDocument();
    expect(within(group).getByRole("button", { name: "Grep()" })).toBeInTheDocument();

    act(() => sock.message(ev(9, "turn_completed", { turn: "trn_1", stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 20 } })));
    expect(group).toHaveAttribute("data-status", "completed");
    expect(group.querySelector('[data-ds="term-rule"]')).toHaveTextContent(/message · end_turn · 1\.5k in · 20 out$/);
  });

  it("fades in only what arrives after the backlog", async () => {
    const { panel, sock } = await managerTrace();
    const animated = () => [...panel.querySelectorAll('[data-ds="fade-in"]')].map((n) => n.getAttribute("data-animated"));
    expect(animated().every((a) => a === "false")).toBe(true);
    act(() => sock.message(ev(9, "assistant_text", { turn: "trn_1", text: "new" })));
    expect(animated().at(-1)).toBe("true");
  });

  it("after a drop, reconnects with a backoff from the last seq, shows no repeat, and animates nothing replayed", async () => {
    const { panel, sock } = await managerTrace();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => sock.drop());
    expect(statusOf(panel)).toBe("Reconnecting");
    expect(FakeSocket.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeSocket.opened).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    const next = FakeSocket.opened[1]!;
    expect(next.url).toMatch(/\/api\/agents\/agt_manager\/trace\?after=8$/);
    act(() => {
      next.open();
      next.message(turn[7]); // an overlap: already shown
      next.message(ev(9, "assistant_text", { turn: "trn_1", text: "missed while away" }));
      next.message({ type: "live" });
    });
    expect(statusOf(panel)).toBe("Live");
    expect(within(panel).getAllByRole("button", { name: "Grep()" })).toHaveLength(1);
    const missed = within(panel).getByText("missed while away").closest('[data-ds="fade-in"]')!;
    expect(missed.getAttribute("data-animated")).toBe("false");
    // A second drop right after: the backoff started over at the good connect.
    act(() => next.drop());
    act(() => vi.advanceTimersByTime(1000));
    expect(FakeSocket.opened[2]!.url).toMatch(/after=9$/);
  });

  it("shows the gap nest reported", async () => {
    const { panel } = await managerTrace([{ type: "gap", from: 1, to: 40 }, ev(41, "assistant_text", { turn: "trn_9", text: "later" }), { type: "live" }]);
    const notice = within(panel).getByText("Earlier events aren't in the live trace").closest('[data-ds="notice"]')!;
    expect(notice).toHaveTextContent("Events 1–40");
  });

  it("follows the newest event only while at the bottom, and offers to jump back", async () => {
    const scrolls = vi.spyOn(window.HTMLElement.prototype, "scrollTo");
    const { panel, sock, user } = await managerTrace();
    const viewport = panel.querySelector(".mantine-ScrollArea-viewport") as HTMLElement;
    const place = (top: number) => {
      Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
      Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
      Object.defineProperty(viewport, "scrollTop", { configurable: true, value: top });
      act(() => viewport.dispatchEvent(new Event("scroll")));
    };
    // Scrolled up: a new event doesn't move it, and is counted.
    place(100);
    scrolls.mockClear();
    act(() => sock.message(ev(9, "assistant_text", { turn: "trn_1", text: "one" })));
    act(() => sock.message(ev(10, "assistant_text", { turn: "trn_1", text: "two" })));
    expect(scrolls).not.toHaveBeenCalled();
    const jump = within(panel).getByRole("button", { name: "Jump to live (2 new)" });
    await user.click(jump);
    expect(scrolls).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });
    expect(within(panel).queryByRole("button", { name: /Jump to live/ })).toBeNull();
    // At the bottom: it follows.
    place(800);
    scrolls.mockClear();
    act(() => sock.message(ev(11, "assistant_text", { turn: "trn_1", text: "three" })));
    expect(scrolls).toHaveBeenCalledWith({ top: 1000 });
  });

  it("stops at the agent's end: no reconnect", async () => {
    const { panel, sock } = await managerTrace([ev(1, "ended", { reason: "stopped" })]);
    expect(statusOf(panel)).toBe("Ended");
    expect(panel.querySelector('[data-kind="ended"]')).toHaveTextContent("the agent ended (stopped)");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => sock.drop(1000));
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeSocket.opened).toHaveLength(1);
    expect(statusOf(panel)).toBe("Ended");
  });

  it("closes the socket when it's no longer shown", async () => {
    const { unmount, sock } = await managerTrace();
    unmount();
    expect(sock.closedByPage).toEqual({ code: 1000 });
  });
});

describe("the mounts", () => {
  it("a task's drawer shows its worker's trace (in its Trace tab below `lg`)", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const api = new FakeApi();
    const t = task({ state: "in_progress", assignee: "agt_worker1" });
    api.tasks = [t];
    const { user } = renderApp(`/projects/prj_one?task=${t.id}`, api);
    const drawer = await screen.findByRole("dialog", { name: "Task" });
    await user.click(await within(drawer).findByRole("tab", { name: "Trace" }));
    await within(drawer).findByRole("heading", { name: "Worker's trace" });
    await waitFor(() => expect(FakeSocket.latest("/api/agents/agt_worker1/trace")).toBeDefined());
  });

  it("a task without a worker keeps one column and opens nothing", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const api = new FakeApi();
    const t = task({ state: "ready" });
    api.tasks = [t];
    renderApp(`/projects/prj_one?task=${t.id}`, api);
    const drawer = await screen.findByRole("dialog", { name: "Task" });
    await within(drawer).findByRole("heading", { name: "Description" });
    expect(within(drawer).queryByRole("tab")).toBeNull();
    expect(drawer.querySelector("[data-column]")).toBeNull();
    expect(FakeSocket.opened).toEqual([]);
  });

  it("a review job shows its reviewer's trace, and a new reviewer's replaces it", async () => {
    const { rerender } = renderAlone(<ReviewTrace job={{ pr: 7, agent: "agt_rev1" }} />);
    expect(screen.getByRole("heading", { name: "Reviewer of #7" })).toBeInTheDocument();
    const first = await waitFor(() => FakeSocket.latest("agt_rev1")!);
    rerender(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
        <ReviewTrace job={{ pr: 7, agent: "agt_rev2" }} />
      </MantineProvider>,
    );
    await waitFor(() => expect(FakeSocket.latest("agt_rev2")).toBeDefined());
    expect(first.closedByPage).toEqual({ code: 1000 });
  });

  it("a manager or reviewer not started yet says so and opens nothing", () => {
    renderAlone(
      <>
        <ManagerTrace settings={{ manager: null }} />
        <ReviewTrace job={{ pr: 3, agent: null }} />
      </>,
    );
    expect(screen.getByText("The manager hasn't started yet.")).toBeInTheDocument();
    expect(screen.getByText("No reviewer has started on this review yet.")).toBeInTheDocument();
    expect(FakeSocket.opened).toEqual([]);
  });
});

// --- The terminal ------------------------------------------------------------------------------------------

/** A trace state with these ring events (and history), as the view is given it. */
function stateOf(events: TraceEvent[], more: Partial<ReturnType<typeof initialTrace>> = {}) {
  return { ...initialTrace(), events, last: events.at(-1)?.seq ?? 0, status: "live" as const, animateAfter: events.at(-1)?.seq ?? 0, ...more };
}

describe("the terminal", () => {
  it("pins each glyph's codepoint: none with an emoji presentation (no U+23FA)", () => {
    const cps = Object.fromEntries(Object.entries(GLYPH).map(([k, v]) => [k, [...v].map((c) => c.codePointAt(0)!.toString(16))]));
    expect(cps).toEqual({ bullet: ["25cf"], pending: ["25cb"], result: ["23bf"], error: ["2717"], note: ["b7"], ask: ["3f"] });
    const sources = import.meta.glob<string>(["./*.tsx", "../../layout/Terminal.tsx"], { query: "?raw", import: "default", eager: true });
    for (const [f, text] of Object.entries(sources)) expect(text.includes("⏺"), f).toBe(false);
  });

  it("gives each event type its line: glyph, tone and text", () => {
    renderAlone(
      <TraceLog
        title="T"
        state={stateOf([
          ev(1, "state", { state: "waiting_input" }),
          ev(2, "turn_started", { turn: "t", input_kind: "inbox" }),
          ev(3, "assistant_text", { turn: "t", text: "Hi" }),
          ev(4, "tool_call", { turn: "t", call_id: "c1", name: "mcp__nest__Bash", input: '{"command":"npm run build\\nnpm test","description":"Build"}' }),
          ev(5, "tool_result", { turn: "t", call_id: "c1", is_error: true, summary: "exit 1" }),
          ev(6, "ask", { turn: "t", ask: "ask_1", question: "Allow push?" }),
          ev(7, "error", { turn: "t", code: "error_max_turns", message: "too many" }),
          ev(8, "rate_limited", { turn: "t", detail: "429" }),
          ev(9, "task_exited", { turn: "t", task_id: "job1", status: "exited", exit_code: 0 }),
          ev(10, "ended", { reason: "done" }),
        ])}
      />,
    );
    const line = (kind: string) => document.querySelector(`[data-kind="${kind}"]`) as HTMLElement;
    expect(glyphOf(line("state"))).toBe(GLYPH.note);
    expect(line("state")).toHaveTextContent("now waiting input");
    expect(glyphOf(line("text"))).toBe(GLYPH.bullet);
    // An MCP tool by its own name, its main argument's first line.
    expect(screen.getByRole("button", { name: "Bash(npm run build)" })).toHaveAttribute("title", "mcp__nest__Bash");
    expect(glyphOf(line("ask"))).toBe(GLYPH.ask);
    expect(line("ask")).toHaveTextContent("waiting for an answer: Allow push?");
    expect(glyphOf(line("error"))).toBe(GLYPH.error);
    expect(line("error")).toHaveTextContent("error_max_turns: too many");
    expect(line("rate_limited")).toHaveTextContent("rate limited: 429");
    expect(line("task_exited")).toHaveTextContent("background task job1 exited (code 0)");
    expect(line("ended")).toHaveTextContent("the agent ended (done)");
    // Muted one-liners, by the dimmed color.
    for (const k of ["state", "ask", "rate_limited", "task_exited", "ended"]) expect(line(k).getAttribute("style"), k).toContain("var(--mantine-color-dimmed)");
  });

  it("shows an error by the danger role's text shade and the ✗ glyph, on the call and its result", () => {
    renderAlone(<TraceLog title="T" state={stateOf([ev(1, "tool_call", { call_id: "c", name: "Read", input: '{"file_path":"src/a.ts"}' }), ev(2, "tool_result", { call_id: "c", is_error: true, summary: "File does not exist." })])} />);
    const result = document.querySelector('[data-kind="tool_result"]') as HTMLElement;
    expect(result).toHaveAttribute("data-error", "true");
    expect(result.getAttribute("style")).toContain("var(--mantine-color-danger-text)");
    expect(result).toHaveTextContent(`${GLYPH.error} File does not exist.`);
    const callGlyph = document.querySelector('[data-call="c"] [data-slot="glyph"]') as HTMLElement;
    expect(callGlyph.getAttribute("style")).toContain("var(--mantine-color-danger-text)");
    expect(screen.getByRole("button", { name: "Read(src/a.ts)" })).toBeInTheDocument();
  });

  it("shows a result's first lines, then `… +N lines (expand)`, all of them on a click", async () => {
    const { user } = renderAlone(<TraceLog title="T" state={stateOf([ev(1, "tool_call", { call_id: "c", name: "Bash", input: "{}" }), ev(2, "tool_result", { call_id: "c", is_error: false, summary: "1\n2\n3\n4\n5\n6" })])} />);
    const result = document.querySelector('[data-kind="tool_result"] [data-slot="text"]') as HTMLElement;
    expect(result.textContent).toBe("1\n2\n3\n… +3 lines (expand)");
    await user.click(screen.getByText("… +3 lines (expand)"));
    expect(result.textContent).toBe("1\n2\n3\n4\n5\n6");
  });

  it("is text in the mono family on the terminal surface, wrapping long lines (no sideways scroll)", () => {
    const long = `x${"y".repeat(500)}`;
    renderAlone(<TraceLog title="T" state={stateOf([ev(1, "assistant_text", { text: long })])} />);
    const term = document.querySelector('[data-ds="terminal"]') as HTMLElement;
    const style = term.getAttribute("style")!;
    expect(style).toContain("var(--nest-terminal)");
    expect(style).toContain("var(--nest-terminal-border)");
    expect(style).toMatch(/white-space: pre-wrap/);
    expect(style).toMatch(/overflow-wrap: anywhere/);
    expect(style).toContain("var(--mantine-font-family-monospace)");
    // Each line wraps under its own text (a 2ch glyph column, then a shrinkable one); the text is selectable text.
    const line = document.querySelector('[data-kind="text"]') as HTMLElement;
    expect(line.getAttribute("style")).toContain("grid-template-columns: 2ch minmax(0, 1fr)");
    expect(line.querySelector('[data-slot="text"]')!.textContent).toBe(long);
  });
});

// --- Backfill ----------------------------------------------------------------------------------------------

/** The app's history route, answered from `pages` by `before`; a page may be held back until `release`. */
function historyFetch(pages: Record<string, { events: unknown[]; next_before: string | null }>) {
  const asked: string[] = [];
  const held = new Map<string, () => void>();
  const hold = new Set<string>();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = new URL(String(input), "https://projects.test");
    const before = u.searchParams.get("before") ?? "";
    asked.push(before);
    if (hold.has(before)) await new Promise<void>((r) => held.set(before, r));
    const page = pages[before];
    return page ? new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } }) : new Response('{"error":"no"}', { status: 400 });
  });
  return { asked, hold, release: (b: string) => held.get(b)?.() };
}

const h = (entry: number, type: string, more: Record<string, unknown> = {}) => ({ ts_ms: 500 + entry, entry, type, ...more });
const histTurn = (base: number, n: number) => [
  h(base, "turn_started", { input_kind: "unknown" }),
  h(base + 1, "assistant_text", { text: `older ${n}` }),
  h(base + 2, "tool_call", { call_id: `toolu_h${n}`, name: "Bash", input: `{"command":"ls ${n}"}` }),
  h(base + 3, "tool_result", { call_id: `toolu_h${n}`, is_error: false, summary: `out ${n}` }),
  h(base + 3, "turn_completed", { stop_reason: "end_turn" }),
];

describe("backfill", () => {
  it("loads history when nest offers it, shows it before the ring, never animated, and pages back from the top", async () => {
    const f = historyFetch({ c1: { events: histTurn(10, 1), next_before: "c2" }, c2: { events: histTurn(0, 0), next_before: null } });
    f.hold.add("c2");
    const { panel } = await managerTrace([{ type: "history", before: "c1" }, ...turn, { type: "live" }]);
    await waitFor(() => expect(panel).toHaveTextContent("older 1"));
    expect(f.asked).toEqual(["c1"]);
    const texts = [...panel.querySelectorAll('[data-kind="text"] [data-slot="text"]')].map((n) => n.textContent);
    expect(texts).toEqual(["older 1", "Looking at the repo"]);
    // History's lines don't fade in, and its turns have their own rules.
    for (const n of panel.querySelectorAll('[data-ds="fade-in"]')) expect(n.getAttribute("data-animated")).toBe("false");
    expect(within(panel).getAllByRole("group", { name: "Turn" })).toHaveLength(2);
    expect(panel.querySelector('[data-turn^="h"] [data-ds="term-rule"]')).toHaveTextContent("end_turn");
    // At the top: the page before, "loading earlier" meanwhile, then the beginning.
    const viewport = panel.querySelector(".mantine-ScrollArea-viewport") as HTMLElement;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 0 });
    act(() => viewport.dispatchEvent(new Event("scroll")));
    await waitFor(() => expect(panel.querySelector('[data-slot="older"]')).toHaveTextContent("loading earlier…"));
    act(() => f.release("c2"));
    await waitFor(() => expect(panel).toHaveTextContent("older 0"));
    expect([...panel.querySelectorAll('[data-kind="text"] [data-slot="text"]')].map((n) => n.textContent)).toEqual(["older 0", "older 1", "Looking at the repo"]);
    expect(panel.querySelector('[data-slot="older"]')).toHaveTextContent("the beginning of the trace");
    expect(f.asked).toEqual(["c1", "c2"]);
  });

  it("after a gap with a cursor, drops what it held and backfills from there: each event once", async () => {
    const f = historyFetch({ g1: { events: [...histTurn(0, 0), h(20, "turn_started", { input_kind: "unknown" }), h(21, "assistant_text", { text: "Looking at the repo" })], next_before: null } });
    const { panel, sock } = await managerTrace();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => sock.drop());
    act(() => vi.advanceTimersByTime(1000));
    const next = FakeSocket.opened[1]!;
    vi.useRealTimers();
    act(() => {
      next.open();
      next.message({ type: "gap", from: 9, to: 30, before: "g1" });
      next.message(ev(31, "assistant_text", { turn: "trn_2", text: "after the gap" }));
      next.message({ type: "live" });
    });
    await waitFor(() => expect(panel).toHaveTextContent("older 0"));
    expect(f.asked).toEqual(["g1"]);
    expect([...panel.querySelectorAll('[data-kind="text"] [data-slot="text"]')].map((n) => n.textContent)).toEqual(["older 0", "Looking at the repo", "after the gap"]);
    // The notice is for a gap nothing covers.
    expect(within(panel).queryByText("Earlier events aren't in the live trace")).toBeNull();
  });
});

describe("the task drawer's layout", () => {
  it("from `lg` on, a task with a worker is two columns that scroll on their own: details, then the wider trace", async () => {
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...real(q), matches: q.includes("min-width: 75em") })) as typeof window.matchMedia;
    try {
      vi.stubGlobal("WebSocket", FakeSocket);
      const api = new FakeApi();
      const t = task({ state: "in_progress", assignee: "agt_worker1" });
      api.tasks = [t];
      renderApp(`/projects/prj_one?task=${t.id}`, api);
      const drawer = await screen.findByRole("dialog", { name: "Task" });
      await waitFor(() => expect(drawer.querySelector('[data-column="details"]')).not.toBeNull());
      const details = drawer.querySelector('[data-column="details"]') as HTMLElement;
      const beside = drawer.querySelector('[data-column="beside"]') as HTMLElement;
      expect(within(details).getByRole("heading", { name: "Description" })).toBeInTheDocument();
      expect(within(beside).getByRole("heading", { name: "Worker's trace" })).toBeInTheDocument();
      expect(within(drawer).queryByRole("tab")).toBeNull();
      // The trace fills its column and scrolls in itself.
      expect(beside.querySelector('[data-fill="true"]')).not.toBeNull();
    } finally {
      window.matchMedia = real;
    }
  });
});
