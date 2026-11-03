// A task's PRs and dependencies in its drawer (README.md#prs, README.md#dependencies), and "Waiting on"
// on its card and in the drawer's header: each PR's state, review and auto-merge; detaching and removing
// confirmed with Cancel focused; one picker per section, top right, offering only what the Worker would
// take (a PR on another task shown but not pickable; no task that would make a cycle), its search taking a
// PR's number; the waiting status, and Assign held while it lasts.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Job, TaskPr } from "../../api/types";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
/** The task drawer (titled with its task's title). */
const SHEET = { name: (_: string, el: Element) => el.classList.contains("mantine-Drawer-content") };

const drawer = () => screen.getByRole("dialog", SHEET);
const now = Date.now();
const job = (pr: number, o: Partial<Job> = {}): Job => ({
  pr, sha: "a".repeat(40), state: "done", title: null, base: "main", agent: "agt_r", check_run: 1, tainted: false, attempts: 0, runs: 1, error: null,
  created_ms: now - 1000, updated_ms: now,
  verdict: { correctness: { verdict: "pass", notes: "" }, quality: { verdict: "fail", notes: "" }, architecture: { verdict: "pass", notes: "" }, summary: "s" },
  ...o,
});
const pr = (number: number, o: Partial<TaskPr> = {}): TaskPr => ({ number, state: "open", title: `PR ${number}`, fork: false, attached_by: "owner", attached_ms: now, auto_merge: null, ...o });

describe("a task's PRs", () => {
  it("each shows its state, its review at the row's size, and its auto-merge (none once merged, a failure as a warning)", async () => {
    const api = new FakeApi();
    const t = task({
      title: "Several PRs", state: "in_review", pr: 4,
      prs: [
        pr(4, { state: "merged", title: "First part", auto_merge: { state: "enabled", method: "squash", error: null, at_ms: now } }),
        pr(5, { title: "Second part", auto_merge: { state: "enabled", method: "squash", error: null, at_ms: now } }),
        pr(6, { title: "Third part", auto_merge: { state: "failed", method: "squash", error: "GitHub 422: Pull request is in clean status", at_ms: now } }),
      ],
    });
    api.tasks = [t];
    api.reviews = [job(5)];
    renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);
    const row = (n: number) => d.querySelector(`[data-pr='${n}']`) as HTMLElement;
    await waitFor(() => expect(row(4)).not.toBeNull());
    expect(row(4)).toHaveTextContent("Merged");
    expect(within(row(4)).queryByText(/Auto-merge/)).toBeNull();
    expect(within(row(4)).queryByRole("button", { name: /Detach/ })).toBeNull();
    const review = await within(row(5)).findByText("Changes needed");
    expect(review.closest("[data-state]")!.getAttribute("data-size")).toBe("sm");
    expect(row(5)).toHaveTextContent("Auto-merge");
    const failed = within(row(6)).getByText("Auto-merge failed").closest(".mantine-Badge-root") as HTMLElement;
    expect(failed.getAttribute("style") ?? "").toContain("--mantine-color-warning");
    // Its details on focus: GitHub's reason, keyboard-reachable (the badge's wrapper is the target).
    (failed.closest("[data-marker=auto-merge]") as HTMLElement).focus();
    expect(await screen.findByText("GitHub 422: Pull request is in clean status")).toBeInTheDocument();
  });

  it("detaching is confirmed, Cancel focused, saying its auto-merge goes", async () => {
    const api = new FakeApi();
    const t = task({ title: "One PR", state: "in_review", pr: 5, prs: [pr(5, { auto_merge: { state: "enabled", method: "squash", error: null, at_ms: now } })] });
    api.tasks = [t];
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    await user.click(await within(await waitFor(drawer)).findByRole("button", { name: "Detach PR #5" }));
    const confirm = await screen.findByRole("dialog", { name: "Detach #5?" });
    expect(confirm).toHaveTextContent("Its auto-merge is turned off.");
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(api.writes).toEqual([]);
    expect(confirm).toHaveTextContent("It stays open on GitHub; this task no longer waits for it to merge.");
    await user.click(within(confirm).getByRole("button", { name: "Detach" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "DELETE", path: `/api/projects/prj_one/tasks/${t.id}/prs/5`, body: undefined }]));
    // Its row is gone: focus is on "Attach PR", not lost.
    await waitFor(() => expect(within(drawer()).getByRole("button", { name: "Attach PR" })).toHaveFocus());
  });

  it("the picker shows a PR on another task by its title but won't pick it, and its search takes a number", async () => {
    const api = new FakeApi();
    const other = task({ title: "Fix the parser", state: "in_review" });
    const t = task({ title: "Mine", state: "in_progress" });
    api.tasks = [t, other];
    api.openPrs = [
      { number: 9, title: "Parser fix", head: "fix", fork: false, task: other.id },
      { number: 10, title: "Docs", head: "docs", fork: false, task: null },
    ];
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);
    await user.click(await within(d).findByRole("button", { name: "Attach PR" }));
    const taken = await screen.findByRole("option", { name: "#9 Parser fix" });
    expect(taken).toHaveAttribute("data-combobox-disabled");
    expect(taken).toHaveTextContent("Attached to Fix the parser");
    // Enter sends the first pickable option, never the refused one.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/prs`, body: { pr: 10 } }]));
    await user.click(within(drawer()).getByRole("button", { name: "Attach PR" }));
    await user.keyboard("#12");
    await user.click(await screen.findByRole("option", { name: "Attach #12" }));
    await waitFor(() => expect(api.writes.at(-1)).toEqual({ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/prs`, body: { pr: 12 } }));
  });

  it("a failed load says so with a retry, not that there are no PRs", async () => {
    const api = new FakeApi();
    const t = task({ title: "Mine", state: "in_progress" });
    api.tasks = [t];
    api.fail(/prs\/open$/, 502, "nest is unavailable");
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    await user.click(await within(await waitFor(drawer)).findByRole("button", { name: "Attach PR" }));
    expect(await screen.findByText("The open PRs couldn't be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/No other open PRs/)).toBeNull();
  });
});

describe("a task's dependencies", () => {
  function board() {
    const api = new FakeApi();
    const schema = task({ title: "Design the schema", state: "in_progress" });
    const web = task({ title: "Write the API", state: "ready" });
    const docs = task({ title: "Write the docs", state: "draft" });
    const shipped = task({ title: "Old release", state: "done" });
    const ui = task({ title: "Build the UI", state: "draft" });
    web.blocked_by = [{ id: schema.id, title: schema.title, state: "in_progress" }];
    web.waiting_on = [schema.id];
    schema.blocks = [{ id: web.id, title: web.title, state: "ready" }];
    // The UI waits on the API: the API waiting on the UI would be a cycle.
    ui.blocked_by = [{ id: web.id, title: web.title, state: "ready" }];
    ui.waiting_on = [web.id];
    web.blocks = [{ id: ui.id, title: ui.title, state: "draft" }];
    api.tasks = [schema, web, docs, shipped, ui];
    return { api, schema, web, docs };
  }

  it("shows what it waits on and what waits on it, with a status line, and holds Assign", async () => {
    const { api, web } = board();
    renderApp(`/projects/prj_one/board?task=${web.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByText("1 of 1 not done: can't be assigned yet")).toBeInTheDocument();
    const waits = within(d).getByRole("group", { name: "Waits on" });
    // Its count in the section's count badge.
    expect(within(waits).getByRole("heading", { name: "Waits on" }).parentElement).toHaveTextContent("Waits on1");
    // Title, then its state, together; Remove apart at the right.
    const row = waits.querySelector("[data-dep]") as HTMLElement;
    const title = within(row).getByRole("link", { name: "Design the schema" });
    expect(title.parentElement).toContainElement(within(row).getByText("In progress"));
    expect(title.parentElement).not.toContainElement(within(row).getByRole("button", { name: /Stop waiting/ }));
    expect(within(d).getByRole("group", { name: "Blocks" })).toHaveTextContent("Build the UI");
    // In the header, and Assign held with the reason.
    expect(within(d).getByText("Waiting on 1")).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Assign" })).toBeDisabled();
    expect(within(d).getByText("Waits on 1 task")).toBeInTheDocument();
  });

  it("the picker offers only tasks it may wait on, each with its state; removing is confirmed", async () => {
    const { api, web, docs, schema } = board();
    const { user } = renderApp(`/projects/prj_one/board?task=${web.id}`, api);
    const d = await waitFor(drawer);
    await user.click(await within(d).findByRole("button", { name: "Add dependency" }));
    // Not itself, not what it waits on already, not one that's over, not one that waits on it.
    const names = (await screen.findAllByRole("option")).map((o) => o.getAttribute("aria-label"));
    expect(names).toEqual(["Write the docs"]);
    expect(screen.getByRole("option", { name: "Write the docs" })).toHaveTextContent("Draft");
    await user.click(screen.getByRole("option", { name: "Write the docs" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: `/api/projects/prj_one/tasks/${web.id}/dependencies`, body: { blocked_by: docs.id } }));
    await user.click(within(drawer()).getByRole("button", { name: "Stop waiting on Design the schema" }));
    const confirm = await screen.findByRole("dialog", { name: "Stop waiting on Design the schema?" });
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Stop waiting" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "DELETE", path: `/api/projects/prj_one/tasks/${web.id}/dependencies/${schema.id}`, body: undefined }));
  });

  it("with none at all, says No dependencies once", async () => {
    const api = new FakeApi();
    const t = task({ title: "Alone", state: "ready" });
    api.tasks = [t];
    renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByText("No dependencies")).toBeInTheDocument();
    expect(within(d).queryByRole("group", { name: "Waits on" })).toBeNull();
  });

  it("with only one side, the other says Nothing", async () => {
    const { api, schema } = board();
    renderApp(`/projects/prj_one/board?task=${schema.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByRole("group", { name: "Waits on" })).toHaveTextContent("Nothing");
    expect(within(d).getByRole("group", { name: "Blocks" })).toHaveTextContent("Write the API");
  });

  it("the card says Waiting on N, neutral and with an hourglass, listing each blocker and its state", async () => {
    const api = new FakeApi();
    const a = task({ title: "First", state: "in_progress" });
    const c = task({ title: "Second blocker", state: "ready" });
    const b = task({ title: "Second", state: "ready", blocked_by: [{ id: a.id, title: "First", state: "in_progress" }, { id: c.id, title: "Second blocker", state: "ready" }], waiting_on: [a.id, c.id] });
    api.tasks = [a, c, b];
    renderApp("/projects/prj_one/board", api);
    const card = await screen.findByRole("article", { name: "Second" });
    const badge = within(card).getByText("Waiting on 2").closest(".mantine-Badge-root") as HTMLElement;
    expect(card.querySelectorAll("[data-marker=waiting]")).toHaveLength(1);
    expect(badge.getAttribute("style") ?? "").toContain("--mantine-color-gray");
    expect(badge.getAttribute("data-variant")).toBe("light");
    expect(badge.querySelector("svg")).not.toBeNull();
    expect(within(card).queryByText("Blocked")).toBeNull();
    (badge.closest("[data-marker=waiting]") as HTMLElement).focus();
    expect(await screen.findByText("First: In progress")).toBeInTheDocument();
    expect(screen.getByText("Second blocker: Ready")).toBeInTheDocument();
  });
});
