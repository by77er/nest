// History reads as sentences. The details below are recorded the way ProjectDO records them
// (src/do/project.ts: `record(task, actor, action, detail)` stores a string as is, anything else as JSON).
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryRow } from "../../api/types";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { summarize } from "./history";

const row = (action: string, detail?: unknown, actor = "agt_mgr"): HistoryRow => ({
  at_ms: 1, actor, action, tainted: false, detail: detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail),
});

describe("a history entry's summary", () => {
  it.each([
    [row("created", { title: "Add search" }), 'Created "Add search"'],
    [row("updated", { body: "new" }), "Details edited"],
    [row("updated", { title: "Search by tag", body: "x" }), 'Renamed to "Search by tag", details edited'],
    [row("updated", { ord: 2.5 }, "owner"), "Moved on the board"],
    [row("spec", { goal: "g", acceptance_criteria: ["a", "b"], files: [], test_plan: "t" }), "Spec written, 2 acceptance criteria"],
    [row("assign", undefined, "owner"), "Assigned"],
    [row("assign", undefined, "app:auto-assign"), "Assigned automatically"],
    [row("worker", { agent: "agt_w1" }, "app:assign"), "Assigned to agt_w1"],
    [row("started", { agent: "agt_w1" }, "app:assign"), "agt_w1 started on it"],
    [row("start_failed", "nest refused: max_agents", "app:assign"), "The worker couldn't start: nest refused: max_agents"],
    [row("pr_opened", { pr: 118 }, "agt_w1"), "PR #118 opened"],
    [row("worker_exited", { agent: "agt_w1", reason: "exited", text: null }, "app:nest"), "Worker agt_w1 exited (exited) before opening a PR"],
    [row("done", undefined, "owner"), "Marked done"],
    [row("cancel", "Not needed", "owner"), "Cancelled: Not needed"],
    [row("cancel", undefined, "owner"), "Cancelled"],
    [row("progress", "Index built", "agt_w1"), "Progress: Index built"],
    [row("blocker", "Need a token", "agt_w1"), "Blocked: Need a token"],
  ])("%#: %s", (h, want) => {
    expect(summarize(h)).toBe(want);
  });

  it("never shows raw JSON, even for an action it doesn't know", () => {
    expect(summarize(row("reviewed", { verdict: "pass" }))).toBe("Reviewed");
  });
});

describe("the drawer's history", () => {
  it("shows each entry's sentence, who and when, with the raw details only on request", async () => {
    const api = new FakeApi();
    const t = task({ title: "Search", state: "in_review", pr: 118 });
    api.tasks = [t];
    api.history.set(t.id, [row("created", { title: "Search" }), row("pr_opened", { pr: 118 }, "agt_w1")]);
    const { user } = renderApp(`/projects/prj_one?task=${t.id}`, api);

    const entry = (await screen.findByText("PR #118 opened")).closest(".mantine-Timeline-item") as HTMLElement;
    expect(entry).toHaveTextContent("agt_w1");
    const details = within(entry).getByRole("button", { name: "Details" });
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(within(entry).queryByText(/"pr": 118/)).toBeNull();
    await user.click(details);
    expect(within(entry).getByText(/"pr": 118/)).toBeInTheDocument();
    expect(within(entry).getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
  });
});
