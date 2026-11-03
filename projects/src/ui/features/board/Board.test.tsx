// The board, rendered from the API: every state in its column and its semantic color (the owner's
// direction: blue in progress, yellow stalled, green done, red cancelled, neutral before work starts),
// cancelled hidden until asked for, and the markers that need the owner's eye.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TaskState } from "../../api/types";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

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

describe("the board", () => {
  it("a card's title is the label weight, 500: a weight by name renders, not dropped", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Weighed", state: "ready" })];
    renderApp("/projects/prj_one/board", api);
    const card = await screen.findByRole("article", { name: "Weighed" });
    const title = within(card).getByRole("link", { name: "Weighed" });
    expect(getComputedStyle(title).fontWeight).toBe("500");
  });

  it("puts every state in its column, its badge in its semantic color, cancelled behind the switch", async () => {
    const api = new FakeApi();
    api.tasks = (Object.keys(EXPECTED) as TaskState[]).map((state) => task({ title: `a ${state} task`, state }));
    const { user } = renderApp("/projects/prj_one/board", api);

    await screen.findByRole("article", { name: "a draft task" });
    expect(screen.queryByRole("article", { name: "a cancelled task" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cancelled" })).toBeNull();
    await user.click(screen.getByRole("switch", { name: "Show cancelled" }));

    for (const [state, want] of Object.entries(EXPECTED)) {
      const card = within(column(want.column)).getByRole("article", { name: `a ${state} task` });
      const badge = card.querySelector(`[data-state="${state}"]`) as HTMLElement;
      expect(badge, state).not.toBeNull();
      // Mantine draws a badge from its color's CSS variables: the role's, and no other.
      const style = badge.getAttribute("style") ?? "";
      expect(style, state).toContain(`--mantine-color-${want.role}-`);
      for (const other of ["gray", "primary", "warning", "success", "danger"].filter((r) => r !== want.role)) {
        expect(style, `${state} isn't ${other}`).not.toContain(`--mantine-color-${other}-`);
      }
    }
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
