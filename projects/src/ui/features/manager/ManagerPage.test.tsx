// The Manager page: its status beside its heading, as nest's record says (src/manager.ts), with a retry when
// the repo couldn't be attached; and the Trace tab beside Chat, kept in the URL for the trace viewer.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordingSocket } from "../../test/sockets";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

describe("the Manager page", () => {
  it("its context lists the tasks under way, newest change first, and the top things waiting on you", async () => {
    const api = new FakeApi();
    const states = ["assigned", "in_progress", "in_review", "stalled", "in_progress", "in_review", "assigned"] as const;
    const active = states.map((state, i) => task({ title: `Active ${i}`, state, updated_ms: 1_000 + i }));
    // Not under way, however new: a draft just written, a ready task, a done one.
    api.tasks = [...active, task({ title: "Fresh draft", state: "draft", updated_ms: 9_999 }), task({ title: "Queued", state: "ready" }), task({ title: "Shipped", state: "done" })];
    api.asks = [1, 2, 3, 4].map((n) => ask({ question: `Question ${n}?`, at_ms: n }));
    const { user } = renderApp("/projects/prj_one/manager", api);
    await user.click(await screen.findByRole("button", { name: "About the manager" }));
    const context = document.querySelector("[data-slot=manager-context]") as HTMLElement;
    const working = (await within(context).findByRole("heading", { name: "Working on" })).closest("[data-ds=section]") as HTMLElement;
    // The count is every active task, not the five shown; the rest are a link to the Board.
    await waitFor(() => expect(working.querySelectorAll("[data-ds=task-card]")).toHaveLength(5));
    expect(within(working).getByLabelText("7 items")).toBeInTheDocument();
    expect([...working.querySelectorAll("[data-ds=task-card]")].map((c) => c.getAttribute("data-task-ref"))).toEqual(active.slice(2).reverse().map((t) => t.id));
    expect(within(working).getByRole("link", { name: "2 more on the board" })).toHaveAttribute("href", "/projects/prj_one/board");
    expect(working).not.toHaveTextContent("Fresh draft");
    // What waits on you: the oldest three questions, each a link to the Board, no count; the rest a link.
    const needs = within(context).getByRole("heading", { name: "Needs you" }).closest("[data-ds=section]") as HTMLElement;
    await waitFor(() => expect(within(needs).getAllByRole("link", { name: /^Question/ }).map((a) => a.textContent)).toEqual(["Question 1?", "Question 2?", "Question 3?"]));
    expect(needs.querySelector("[data-slot=count]")).toBeNull();
    expect(within(needs).getByRole("link", { name: "1 more on the board" })).toBeInTheDocument();
    // The status is the header's, not repeated here.
    expect(within(context).queryByRole("heading", { name: "Status" })).toBeNull();
  });

  it("with nothing waiting, the context says so in a sentence", async () => {
    const { user } = renderApp("/projects/prj_one/manager", new FakeApi());
    await user.click(await screen.findByRole("button", { name: "About the manager" }));
    expect(await screen.findByText("Nothing waits on you.")).toBeInTheDocument();
    expect(screen.getByText("Nothing under way.")).toBeInTheDocument();
  });

  it("shows the manager running, what it's doing and where, in the header", async () => {
    const api = new FakeApi();
    api.manager = { phase: "running", agent: "agt_manager", state: "waiting_input", host: "bh_7", error: null };
    renderApp("/projects/prj_one/manager", api);
    expect(await screen.findByRole("heading", { level: 1, name: "Widgets" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Manager" })).toBeInTheDocument();
    const badge = await screen.findByText("Running");
    expect(badge.closest("[data-phase]")!.getAttribute("style")).toContain("--mantine-color-success-");
    expect(screen.getByText("waiting for input")).toBeInTheDocument();
    expect(screen.getByText("bh_7")).toBeInTheDocument();
  });

  it("a failed attach shows why, and retrying it posts the attach", async () => {
    const api = new FakeApi();
    api.manager = { phase: "attach_failed", agent: null, state: null, host: null, error: "GitHub answered 403: the App lacks administration" };
    const { user } = renderApp("/projects/prj_one/manager", api);
    const problem = await screen.findByRole("alert", { name: /couldn't be attached/ });
    expect(problem).toHaveTextContent("the App lacks administration");
    await user.click(within(problem).getByRole("button", { name: "Retry attach" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/attach", body: undefined }]));
    expect(await screen.findByText("Starting")).toBeInTheDocument();
  });

  it("waiting for a host is a warning, not an error", async () => {
    const api = new FakeApi();
    api.manager = { phase: "waiting_for_host", agent: "agt_manager", state: "starting", host: null, error: null };
    renderApp("/projects/prj_one/manager", api);
    const badge = await screen.findByText("Waiting for a host");
    expect(badge.closest("[data-phase]")!.getAttribute("style")).toContain("--mantine-color-warning-");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has the manager's live trace in a tab beside Chat, kept in the URL", async () => {
    RecordingSocket.opened = [];
    vi.stubGlobal("WebSocket", RecordingSocket);
    const { user, router } = renderApp("/projects/prj_one/manager");
    await screen.findByRole("tabpanel", { name: "Chat" });
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "trace" }));
    const panel = await screen.findByRole("tabpanel", { name: "Trace" });
    expect(within(panel).getByRole("heading", { name: "Manager's trace" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message to the manager")).toBeNull();
    // The trace viewer connects for the manager the project names (fakeApi: agt_manager), once shown; the
    // chat before it followed the same manager's trace for its live turn. Never another agent's.
    await waitFor(() => expect(RecordingSocket.opened.length).toBeGreaterThanOrEqual(2));
    expect(new Set(RecordingSocket.opened.map((u) => new URL(u).pathname))).toEqual(new Set(["/api/agents/agt_manager/trace"]));
  });
});
