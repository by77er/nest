// A task's PRs and dependencies in its drawer (README.md#prs, README.md#dependencies), and "Waiting on"
// on its card: each PR with its state and review, detached and attached (from the open PRs or by number);
// the tasks it waits on, added through the task picker and removed, distinct from "Blocked".
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Job } from "../../api/types";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const drawer = () => screen.getByRole("dialog", { name: "Task" });
const job = (pr: number, o: Partial<Job> = {}): Job => ({
  pr, sha: "a".repeat(40), state: "done", title: null, base: "main", agent: "agt_r", check_run: 1, tainted: false, attempts: 0, runs: 1, error: null,
  created_ms: Date.now() - 1000, updated_ms: Date.now(),
  verdict: { correctness: { verdict: "pass", notes: "" }, quality: { verdict: "fail", notes: "" }, architecture: { verdict: "pass", notes: "" }, summary: "s" },
  ...o,
});

describe("a task's PRs", () => {
  it("lists each with its state and latest review; detaches an open one, and attaches by number and from the open PRs", async () => {
    const api = new FakeApi();
    const t = task({
      title: "Two PRs", state: "in_review", pr: 4,
      prs: [
        { number: 4, state: "merged", title: "First part", fork: false, attached_by: "owner", attached_ms: Date.now(), auto_merge: null },
        { number: 5, state: "open", title: "Second part", fork: false, attached_by: "app:github", attached_ms: Date.now(), auto_merge: { state: "enabled", method: "squash", error: null, at_ms: Date.now() } },
      ],
    });
    api.tasks = [t];
    api.reviews = [job(5)];
    api.openPrs = [{ number: 9, title: "Fix the parser", head: "fix-parser", fork: false, task: null }];
    const { user } = renderApp(`/projects/prj_one?task=${t.id}`, api);
    const d = await waitFor(drawer);
    const four = await within(d).findByText("#4");
    const row4 = four.closest("[data-pr]") as HTMLElement;
    expect(row4).toHaveTextContent("Merged");
    expect(within(row4).queryByRole("button", { name: /Detach/ })).toBeNull();
    const row5 = d.querySelector("[data-pr='5']") as HTMLElement;
    expect(row5).toHaveTextContent("Open");
    expect(await within(row5).findByText("Changes needed")).toBeInTheDocument();
    expect(row5).toHaveTextContent("Auto-merge (squash)");
    await user.click(within(row5).getByRole("button", { name: "Detach PR #5" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "DELETE", path: `/api/projects/prj_one/tasks/${t.id}/prs/5`, body: undefined }));

    await user.type(within(d).getByLabelText("Or a PR's number or URL"), "#12");
    await user.click(within(d).getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/prs`, body: { pr: "#12" } }));

    await user.click(within(d).getByRole("button", { name: "Attach an open PR" }));
    await user.click(await screen.findByRole("option", { name: /#9 Fix the parser/ }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/prs`, body: { pr: 9 } }));
  });
});

describe("a task's dependencies", () => {
  it("adds one through the task picker and removes one; what waits on it is listed", async () => {
    const api = new FakeApi();
    const schema = task({ title: "Design the schema", state: "in_progress" });
    const api2 = task({ title: "Write the API", state: "ready" });
    const docs = task({ title: "Write the docs", state: "draft" });
    api2.blocked_by = [{ id: schema.id, title: schema.title, state: "in_progress" }];
    api2.waiting_on = [schema.id];
    schema.blocks = [{ id: api2.id, title: api2.title, state: "ready" }];
    api.tasks = [schema, api2, docs];
    const { user } = renderApp(`/projects/prj_one?task=${api2.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByText("Waiting on 1 of 1: not assignable until done")).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Wait on another task" }));
    // Not itself, nor what it already waits on.
    expect(screen.queryByRole("option", { name: "Write the API" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Design the schema" })).toBeNull();
    await user.click(await screen.findByRole("option", { name: "Write the docs" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: `/api/projects/prj_one/tasks/${api2.id}/dependencies`, body: { blocked_by: docs.id } }));
    await user.click(within(drawer()).getByRole("button", { name: "Stop waiting on Design the schema" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "DELETE", path: `/api/projects/prj_one/tasks/${api2.id}/dependencies/${schema.id}`, body: undefined }));
  });

  it("the card says Waiting on N, neutral, naming its blockers, apart from Blocked", async () => {
    const api = new FakeApi();
    const a = task({ title: "First", state: "in_progress" });
    const b = task({ title: "Second", state: "ready", blocked_by: [{ id: a.id, title: "First", state: "in_progress" }], waiting_on: [a.id] });
    api.tasks = [a, b];
    const { user } = renderApp("/projects/prj_one", api);
    const card = await screen.findByRole("article", { name: "Second" });
    const badge = within(card).getByText("Waiting on 1").closest("[data-marker=waiting]") as HTMLElement;
    expect(badge.getAttribute("style") ?? "").toContain("--mantine-color-gray");
    expect(within(card).queryByText("Blocked")).toBeNull();
    // Focus (the keyboard's hover) lists them too.
    badge.focus();
    expect(await screen.findByText("Waiting on First (in progress)")).toBeInTheDocument();
  });
});
