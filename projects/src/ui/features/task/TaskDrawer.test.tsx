// Creating a task, and what the owner does to one from its drawer: assign, cancel (confirmed, with a
// reason), mark done. Each is offered only where the Worker's state machine allows it, and each sends
// exactly the API call the Worker expects (src/api.ts).
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const drawer = () => screen.getByRole("dialog", { name: "Task" });

describe("creating a task", () => {
  it("checks the title, sends it as a draft, and shows the card in Draft", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/board", api);

    await user.click(await screen.findByRole("button", { name: "Create a task" }));
    const dialog = screen.getByRole("dialog", { name: "New task" });
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));
    // The Worker's own schema refuses an empty title: nothing is sent.
    expect(within(dialog).getByLabelText(/Title/)).toHaveAttribute("aria-invalid", "true");
    expect(api.writes).toEqual([]);

    await user.type(within(dialog).getByLabelText(/Title/), "  Add a widget  ");
    await user.type(within(dialog).getByLabelText(/Details/), "Make it blue");
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull());
    expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/tasks", body: { title: "Add a widget", body: "Make it blue" } }]);
    expect(within(await screen.findByRole("region", { name: "Draft" })).getByRole("article", { name: "Add a widget" })).toBeInTheDocument();
  });
});

describe("the task drawer", () => {
  it("opens from its card, and assigning a ready task sends assign and shows it assigned", async () => {
    const api = new FakeApi();
    const t = task({ title: "Specced", state: "ready", spec: { goal: "Ship it", acceptance_criteria: ["works", "tested"], files: ["src/a.ts"], test_plan: "npm test" } });
    api.tasks = [t];
    const { user } = renderApp("/projects/prj_one/board", api);

    await user.click(await screen.findByRole("link", { name: "Specced" }));
    const d = await waitFor(drawer);
    expect(await within(d).findByText("Ship it")).toBeInTheDocument();
    expect(within(d).getByText("tested")).toBeInTheDocument();
    expect(within(d).getByText("src/a.ts")).toBeInTheDocument();
    // A ready task can't be deleted (only a draft is).
    expect(within(d).queryByRole("button", { name: "Delete" })).toBeNull();

    await user.click(within(d).getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(within(d).getByText("Assigned")).toBeInTheDocument());
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/assign`, body: undefined }]);
    // Once assigned, it can't be assigned again.
    expect(within(d).queryByRole("button", { name: "Assign" })).toBeNull();
  });

  it("offers no assign for a draft: the manager specs it first", async () => {
    const api = new FakeApi();
    const t = task({ title: "Unspecced", state: "draft" });
    api.tasks = [t];
    renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByText(/Not specced yet/)).toBeInTheDocument();
    expect(within(d).queryByRole("button", { name: "Assign" })).toBeNull();
    expect(within(d).getByRole("button", { name: "Cancel task" })).toBeInTheDocument();
  });

  it("cancels only once confirmed, sending the reason", async () => {
    const api = new FakeApi();
    const t = task({ title: "Running", state: "in_progress", assignee: "agt_w1" });
    api.tasks = [t];
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);

    await user.click(await within(d).findByRole("button", { name: "Cancel task" }));
    let confirm = screen.getByRole("dialog", { name: "Cancel this task?" });
    expect(confirm).toHaveTextContent("Its worker is stopped");
    await user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Cancel this task?" })).toBeNull());
    expect(api.writes).toEqual([]);

    await user.click(within(d).getByRole("button", { name: "Cancel task" }));
    confirm = screen.getByRole("dialog", { name: "Cancel this task?" });
    await user.type(within(confirm).getByLabelText(/Reason/), "Not needed");
    const go = within(confirm).getByRole("button", { name: "Cancel task" });
    expect(go.getAttribute("style")).toContain("--mantine-color-danger-");
    await user.click(go);

    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/cancel`, body: { reason: "Not needed" } }]));
    await waitFor(() => expect(within(d).getByText("Cancelled")).toBeInTheDocument());
    // A cancelled task is finished: no more actions, and its text is read-only.
    expect(within(d).queryByRole("button", { name: "Cancel task" })).toBeNull();
    expect(within(d).getByLabelText(/Title/)).toHaveAttribute("readonly");
  });

  it("offers no Mark done for a task with an open PR or a running worker: those wait for the merge, or are cancelled", async () => {
    const api = new FakeApi();
    const review = task({ title: "Reviewed", state: "in_review", pr: 7 });
    const running = task({ title: "Running", state: "in_progress", assignee: "agt_w1" });
    api.tasks = [review, running];
    const { user } = renderApp(`/projects/prj_one/board?task=${review.id}`, api);
    const d = await waitFor(drawer);
    expect(await within(d).findByRole("button", { name: "Cancel task" })).toBeInTheDocument();
    expect(within(d).queryByRole("button", { name: "Mark done" })).toBeNull();

    await user.click(screen.getByRole("link", { name: "Running" }));
    await waitFor(() => expect(within(drawer()).getByText("agt_w1")).toBeInTheDocument());
    expect(within(drawer()).queryByRole("button", { name: "Mark done" })).toBeNull();
  });

  it("marks a task with no PR done, in green, once confirmed", async () => {
    const api = new FakeApi();
    const t = task({ title: "Research", state: "ready" });
    api.tasks = [t];
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);

    const done = await within(d).findByRole("button", { name: "Mark done" });
    expect(done.getAttribute("style")).toContain("--mantine-color-success-");
    await user.click(done);
    const confirm = await screen.findByRole("dialog", { name: "Mark this task done?" });
    await user.click(within(confirm).getByRole("button", { name: "Mark done" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/done`, body: undefined }]));
    await waitFor(() => expect(within(d).getByText("Done")).toBeInTheDocument());
  });

  it("shows a refusal from the Worker and leaves the task as it was", async () => {
    const api = new FakeApi();
    const t = task({ title: "Stalled one", state: "stalled", start_error: "nest refused the worker: max_agents" });
    api.tasks = [t];
    api.fail(/\/assign$/, 409, "the project already has 2 live workers (max_workers)");
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const d = await waitFor(drawer);

    expect(await within(d).findByText("nest refused the worker: max_agents")).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Reassign" }));
    expect(await screen.findByText("the project already has 2 live workers (max_workers)")).toBeInTheDocument();
    expect(within(d).getByText("Stalled")).toBeInTheDocument();
  });
});

describe("the task drawer's auto-merge", () => {
  it("shows it on with its method, or why GitHub refused it", async () => {
    const api = new FakeApi();
    const on = task({ title: "On", state: "in_review", pr: 4, auto_merge: { state: "enabled", method: "squash", error: null, at_ms: Date.now() } });
    const failed = task({ title: "Failed", state: "in_review", pr: 5, auto_merge: { state: "failed", method: "squash", error: "GitHub 422: Pull request is in clean status", at_ms: Date.now() } });
    api.tasks = [on, failed];
    const { user } = renderApp("/projects/prj_one/board", api);
    await user.click(await screen.findByRole("link", { name: "On" }));
    expect(await within(await waitFor(drawer)).findByText("Auto-merge on (squash)")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Failed" }));
    expect(await within(drawer()).findByText("GitHub 422: Pull request is in clean status")).toBeInTheDocument();
    expect(within(drawer()).getByText("Auto-merge wasn't changed on its PR")).toBeInTheDocument();
  });
});
