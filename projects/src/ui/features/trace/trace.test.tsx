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
import { groupTurns, initialTrace, MAX_EVENTS, reconnectDelay, type TraceEvent, traceReducer, traceUrl } from "./model";

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
  it("shows a turn as a group: its text, each tool call with its result's status, input and result on demand", async () => {
    const { panel, user, sock } = await managerTrace();
    expect(sock.url).toBe(`ws://${window.location.host}/api/agents/agt_manager/trace`);
    expect(statusOf(panel)).toBe("Live");
    const group = within(panel).getByRole("group", { name: "Turn" });
    expect(group).toHaveTextContent("Turn · Message");
    expect(within(group).getByText("Looking at the repo")).toBeInTheDocument();
    const status = (call: string) => group.querySelector(`[data-call="${call}"] [data-slot="status"]`)!.textContent;
    expect([status("toolu_1"), status("toolu_2"), status("toolu_3")]).toEqual(["Done", "Error", "Running"]);
    expect(group.querySelector('[data-slot="turn-status"]')).toHaveTextContent("Working");
    // Collapsed until asked for.
    const bash = within(group).getByRole("button", { name: "Bash" });
    expect(bash).toHaveAttribute("aria-expanded", "false");
    await user.click(bash);
    expect(bash).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getByText(/"command": "ls"/)).toBeInTheDocument();
    expect(within(group).getByText("README.md")).toBeInTheDocument();

    act(() => sock.message(ev(9, "turn_completed", { turn: "trn_1", stop_reason: "end_turn", usage: { input_tokens: 1500, output_tokens: 20 } })));
    expect(group.querySelector('[data-slot="turn-status"]')).toHaveTextContent("Completed");
    expect(group).toHaveTextContent("1.5k in · 20 out");
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
    expect(within(panel).getAllByRole("button", { name: "Grep" })).toHaveLength(1);
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
    expect(within(panel).getByText("The agent ended (stopped)")).toBeInTheDocument();
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
  it("a task's drawer shows its worker's trace", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const api = new FakeApi();
    const t = task({ state: "in_progress", assignee: "agt_worker1" });
    api.tasks = [t];
    renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const drawer = await screen.findByRole("dialog", { name: "Task" });
    await within(drawer).findByRole("heading", { name: "Worker's trace" });
    await waitFor(() => expect(FakeSocket.latest("/api/agents/agt_worker1/trace")).toBeDefined());
  });

  it("a task without a worker says so and opens nothing", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const api = new FakeApi();
    const t = task({ state: "ready" });
    api.tasks = [t];
    renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const drawer = await screen.findByRole("dialog", { name: "Task" });
    expect(await within(drawer).findByText("No worker has started on this task yet.")).toBeInTheDocument();
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
