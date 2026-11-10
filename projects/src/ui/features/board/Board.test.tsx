// The board, rendered from the API as a list grouped by stage (the owner, 2026-11-10): every state in its
// group and its semantic color (blue in progress, yellow stalled, green done, red cancelled, neutral
// before work starts), cancelled hidden until asked for, empty stages left out, groups that collapse,
// rows in board order with their metadata, and a row moved by keyboard within its group only.
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskState } from "../../api/types";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { changedWhen } from "./TaskListRow";

/** The owner's direction, written out here rather than read from the code under test. */
const EXPECTED: Record<TaskState, { column: string; role: "gray" | "primary" | "warning" | "success" | "danger" }> = {
  draft: { column: "Draft", role: "gray" },
  ready: { column: "Ready", role: "gray" },
  assigned: { column: "In progress", role: "primary" },
  in_progress: { column: "In progress", role: "primary" },
  in_review: { column: "In review", role: "primary" },
  stalled: { column: "Stalled", role: "warning" },
  done: { column: "Done", role: "success" },
  cancelled: { column: "Cancelled", role: "danger" },
};

const column = (name: string) => screen.getByRole("region", { name });
const rowNames = (group: HTMLElement) => [...group.querySelectorAll("[data-ds=task-row]")].map((r) => r.getAttribute("aria-label"));

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("the board", () => {
  it("a badge with details is its tooltip's target, focusable, and its tooltip opens on hover, focus or a tap", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Held up", state: "in_progress", blocked: { at_ms: 1, by: "agt_w", role: "worker", reason: "needs a key", question: null, tainted: false } })];
    const { user } = renderApp("/projects/prj_one/board", api);
    const card = await screen.findByRole("article", { name: "Held up" });
    // The trigger wraps the badge and keeps the Tooltip's props: it's what's focused and what opens it.
    const trigger = card.querySelector("[data-marker=blocked]") as HTMLElement;
    expect(trigger).toHaveAttribute("data-ds", "trigger-badge");
    expect(trigger).toHaveAttribute("tabindex", "0");
    expect(trigger.querySelector(".mantine-Badge-root")).toHaveTextContent("Blocked");
    await user.hover(trigger);
    expect(await screen.findByText("Blocked: needs a key")).toBeInTheDocument();
    await user.unhover(trigger);
    await waitFor(() => expect(screen.queryByText("Blocked: needs a key")).toBeNull());
    // Focus opens it (the keyboard, and a tap, which focuses the trigger); touch is on in the theme.
    act(() => trigger.focus());
    expect(await screen.findByText("Blocked: needs a key")).toBeInTheDocument();
  });

  it("a row's title is the link that opens the task's drawer", async () => {
    const api = new FakeApi();
    const t = task({ title: "Opened", state: "ready" });
    api.tasks = [t];
    const { user, router } = renderApp("/projects/prj_one/board", api);
    const row = await screen.findByRole("article", { name: "Opened" });
    await user.click(within(row).getByRole("link", { name: "Opened" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ task: t.id }));
  });

  it("puts every state in its group, its glyph in its semantic color, cancelled behind the switch", async () => {
    const api = new FakeApi();
    api.tasks = (Object.keys(EXPECTED) as TaskState[]).map((state) => task({ title: `a ${state} task`, state }));
    const { user } = renderApp("/projects/prj_one/board", api);

    await screen.findByRole("article", { name: "a draft task" });
    expect(screen.queryByRole("article", { name: "a cancelled task" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cancelled" })).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Show cancelled" }));

    for (const [state, want] of Object.entries(EXPECTED)) {
      const row = within(column(want.column)).getByRole("article", { name: `a ${state} task` });
      // The state's glyph: named for screen readers, in its role's text color (a neutral one muted).
      const glyph = row.querySelector(`[data-state="${state}"]`) as HTMLElement;
      expect(glyph, state).not.toBeNull();
      expect(glyph).toHaveAttribute("role", "img");
      const style = glyph.getAttribute("style") ?? "";
      expect(style, state).toContain(want.role === "gray" ? "var(--nest-muted)" : `--mantine-color-${want.role}-text`);
      for (const other of ["primary", "warning", "success", "danger"].filter((r) => r !== want.role)) {
        expect(style, `${state} isn't ${other}`).not.toContain(`--mantine-color-${other}-`);
      }
    }
  });

  it("groups in the board's order of stages, rows in board order, an empty stage left out", async () => {
    const api = new FakeApi();
    api.tasks = [
      task({ title: "Second ready", state: "ready", ord: 5 }),
      task({ title: "Shipped", state: "done", ord: 1 }),
      task({ title: "First ready", state: "ready", ord: 2 }),
      task({ title: "Being done", state: "in_progress", ord: 3 }),
      task({ title: "Just assigned", state: "assigned", ord: 4 }),
    ].sort((a, b) => a.ord - b.ord);
    renderApp("/projects/prj_one/board", api);
    await screen.findByRole("article", { name: "Shipped" });
    const groups = [...document.querySelectorAll("[data-ds=task-group]")].map((g) => g.getAttribute("aria-labelledby") && within(g as HTMLElement).getByRole("heading").textContent);
    // No Draft, In review or Stalled group: none of their tasks.
    expect(groups).toEqual(["Ready2", "In progress2", "Done1"]);
    expect(rowNames(column("Ready"))).toEqual(["First ready", "Second ready"]);
    // Assigned and in progress share a group, in board order.
    expect(rowNames(column("In progress"))).toEqual(["Being done", "Just assigned"]);
  });

  it("in a group of more than one state, a row whose state isn't the group's name says it, muted; the others don't repeat it", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Under way", state: "in_progress" }), task({ title: "Just picked up", state: "assigned" }), task({ title: "Fresh", state: "draft" })];
    renderApp("/projects/prj_one/board", api);
    const assigned = await screen.findByRole("article", { name: "Just picked up" });
    const word = assigned.querySelector("[data-slot=row-state]") as HTMLElement;
    expect(word).toHaveTextContent("Assigned");
    expect(word.getAttribute("style") ?? "").toContain("--mantine-color-dimmed");
    expect(screen.getByRole("article", { name: "Under way" }).querySelector("[data-slot=row-state]")).toBeNull();
    expect(screen.getByRole("article", { name: "Fresh" }).querySelector("[data-slot=row-state]")).toBeNull();
  });

  it("an empty board has one focal action: New task filled, the empty state's own button quieter", async () => {
    renderApp("/projects/prj_one/board", new FakeApi());
    await screen.findByText("No tasks yet");
    // Mantine's filled button (its default) carries no variant attribute.
    expect(screen.getByRole("button", { name: "New task" }).getAttribute("data-variant") ?? "filled").toBe("filled");
    expect(screen.getByRole("button", { name: "Create a task" })).toHaveAttribute("data-variant", "default");
  });

  it("a group's header collapses and opens it, remembered in this browser", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "A draft", state: "draft" }), task({ title: "A ready one", state: "ready" })];
    const { user, unmount } = renderApp("/projects/prj_one/board", api);
    await screen.findByRole("article", { name: "A draft" });
    const toggle = within(column("Draft")).getByRole("button", { name: /Draft/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("article", { name: "A draft" })).toBeNull();
    // The other group is untouched, and the collapsed one still says how many it holds.
    expect(screen.getByRole("article", { name: "A ready one" })).toBeInTheDocument();
    expect(within(column("Draft")).getByLabelText("1 task")).toBeInTheDocument();
    unmount();
    renderApp("/projects/prj_one/board", api);
    await screen.findByRole("article", { name: "A ready one" });
    expect(screen.queryByRole("article", { name: "A draft" })).toBeNull();
    await user.click(within(column("Draft")).getByRole("button", { name: /Draft/ }));
    expect(await screen.findByRole("article", { name: "A draft" })).toBeInTheDocument();
  });

  it("a row's metadata: its short id, its worker, its first PR with its state and how many more, when it changed", async () => {
    const api = new FakeApi();
    const pr = (number: number, state: "open" | "merged") => ({ number, state, title: null, fork: false, attached_by: "owner", attached_ms: 1, auto_merge: null });
    const t = task({ id: "tsk_01abcdef9xyz", title: "Has it all", state: "in_review", assignee: "agt_w1", pr: 42, prs: [pr(42, "open"), pr(43, "merged")], updated_ms: Date.now() - 3 * 3_600_000 });
    api.tasks = [t, task({ title: "Bare", state: "draft" })];
    renderApp("/projects/prj_one/board", api);
    const row = await screen.findByRole("article", { name: "Has it all" });
    // Its short id: the last six characters, without the prefix; the whole id on hover.
    expect(within(row).getByText("ef9xyz")).toHaveAttribute("title", t.id);
    expect(within(row).getByText("agt_w1")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "PR #42, open" })).toHaveAttribute("href", "https://github.com/owner/widgets/pull/42");
    expect(row.querySelector("[data-slot=pr]")).toHaveTextContent("#42 open +1");
    expect(within(row).getByText("3 hours ago")).toBeInTheDocument();
    // Past a week, the day alone (with its year when not this one), never a date and a time that wraps.
    expect(changedWhen(new Date(2026, 0, 5, 12).getTime(), new Date(2026, 2, 1, 12).getTime())).toMatch(/^Jan 5$/);
    expect(changedWhen(new Date(2025, 0, 5, 12).getTime(), new Date(2026, 2, 1, 12).getTime())).toMatch(/^Jan 5, 2025$/);
    expect(changedWhen(new Date(2026, 2, 1, 9).getTime(), new Date(2026, 2, 1, 12).getTime())).toBe("3 hours ago");
    // Once `ago` would give the full date and time (a week on), the day alone.
    expect(changedWhen(new Date(2026, 1, 21, 0).getTime(), new Date(2026, 1, 28, 12).getTime())).toMatch(/^Feb 21$/);
    const bare = screen.getByRole("article", { name: "Bare" });
    expect(bare.querySelector("[data-slot=pr]")).toBeNull();
    expect(within(bare).queryByText(/^agt_/)).toBeNull();
  });

  // Moving by keyboard all the way (space, arrow, space) needs layout, which jsdom hasn't: ui-review's
  // `board-keyboard-move` state does it in a browser and checks the new order. Here: the wiring.
  it("a row's grip picks it up by keyboard and puts it back on Escape, writing nothing; a lone row has no grip", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Alpha", state: "ready", ord: 1 }), task({ title: "Beta", state: "ready", ord: 2 }), task({ title: "Delta", state: "draft", ord: 3 })];
    const { user } = renderApp("/projects/prj_one/board", api);
    const grip = await screen.findByRole("button", { name: "Move Alpha" });
    expect(grip).toHaveAttribute("aria-roledescription", "sortable");
    expect(document.getElementById(grip.getAttribute("aria-describedby")!)).toHaveTextContent("within its group");
    // A lone row in its group has nothing to move past.
    expect(screen.queryByRole("button", { name: "Move Delta" })).toBeNull();
    act(() => grip.focus());
    await user.keyboard("[Space]");
    await waitFor(() => expect(grip).toHaveAttribute("data-dragging"));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    await user.keyboard("[Escape]");
    await waitFor(() => expect(grip).not.toHaveAttribute("data-dragging"));
    expect(api.writes).toEqual([]);
    expect(rowNames(column("Ready"))).toEqual(["Alpha", "Beta"]);
  });

  it("marks a tainted task, one waiting on an answer, and links its PR", async () => {
    const api = new FakeApi();
    const t = task({ title: "with markers", state: "in_review", tainted: true, pr: 42, assignee: "agt_w1" });
    const plain = task({ title: "plain", state: "in_review" });
    api.tasks = [t, plain];
    api.asks = [ask({ task: t.id, question: "May I?" }), ask({ task: plain.id, answered_ms: 1 })];
    renderApp("/projects/prj_one/board", api);

    const card = await screen.findByRole("article", { name: "with markers" });
    expect(within(card).getByText("Tainted")).toBeInTheDocument();
    const needs = await within(card).findByText("Needs input");
    expect(needs.closest(".mantine-Badge-root")?.getAttribute("style")).toContain("--mantine-color-warning-");
    expect(within(card).getByRole("link", { name: /#42/ })).toHaveAttribute("href", "https://github.com/owner/widgets/pull/42");
    expect(within(card).getByText("agt_w1")).toBeInTheDocument();

    // An answered ask and an untainted task carry no marker.
    const other = screen.getByRole("article", { name: "plain" });
    expect(within(other).queryByText("Tainted")).toBeNull();
    expect(within(other).queryByText("Needs input")).toBeNull();
  });

  it("shows an empty board's next step, and a failed load with a way to retry", async () => {
    const api = new FakeApi();
    api.fail(/^GET \/api\/projects\/prj_one\/tasks$/, 500, "ProjectDO is unavailable");
    const { user } = renderApp("/projects/prj_one/board", api);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The board couldn't be loaded");
    expect(alert).toHaveTextContent("ProjectDO is unavailable");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No tasks yet")).toBeInTheDocument();
  });
});
