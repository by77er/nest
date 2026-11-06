// Triage (README.md#triage): the repo's issues waiting, each with its title, author, age, link and body
// as plain text (escaped: markup in it is shown, never rendered), its first lines and "Show more"; Accept
// (of the issue as read: one edited since asks again) and Decline (with an optional reason); the one-off
// import; the count in "Needs you"; and the Manager page's link to it.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Issue } from "../../api/types";
import { FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const now = Date.now();
const issue = (o: Partial<Issue> = {}): Issue => ({
  number: 12, title: "Crash on save", body: "Steps: open, save.", author: "reporter", url: "https://github.com/owner/widgets/issues/12", state: "untriaged",
  task: null, reason: null, opened_ms: now - 3_600_000, updated_ms: now - 3_600_000, ...o,
});

describe("the Triage page", () => {
  it("lists each issue: title, number, author, age, its body as plain text, and its link", async () => {
    const api = new FakeApi();
    const hostile = '<img src=x onerror="window.pwned=1"> **bold** [link](javascript:alert(1))';
    api.issues = [issue({ body: hostile, title: "<b>Not bold</b>" })];
    renderApp("/projects/prj_one/triage", api);
    const item = (await screen.findByText("<b>Not bold</b>")).closest("[data-issue]") as HTMLElement;
    for (const t of ["#12", "reporter", "1 hour ago"]) expect(item).toHaveTextContent(t);
    // Shown as written: nothing in it is markup here.
    expect(item).toHaveTextContent(hostile);
    expect(item.querySelector("img, b, strong, a[href^='javascript']")).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    expect(within(item).getByRole("link", { name: "Issue #12 on GitHub" })).toHaveAttribute("href", "https://github.com/owner/widgets/issues/12");
  });

  it("accept makes it a draft task; decline asks first and sends the reason", async () => {
    const api = new FakeApi();
    api.issues = [issue(), issue({ number: 13, title: "Old browsers" })];
    const { user } = renderApp("/projects/prj_one/triage", api);
    await user.click(await screen.findByRole("button", { name: "Accept issue #12" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/issues/12/accept", body: { updated_ms: now - 3_600_000 } }]));
    expect(await screen.findByText(/Issue #12 is a draft task now/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Decline issue #13" }));
    const confirm = await screen.findByRole("dialog", { name: "Decline issue #13?" });
    expect(confirm).toHaveTextContent("Nothing changes on GitHub");
    await user.type(within(confirm).getByLabelText(/Reason/), "Won't support IE");
    await user.click(within(confirm).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.writes.at(-1)).toEqual({ method: "POST", path: "/api/projects/prj_one/issues/13/decline", body: { reason: "Won't support IE" } }));
    expect(await screen.findByText("Nothing to triage")).toBeInTheDocument();
  });

  it("a long body shows its first lines, and Show more shows the rest in place; the GitHub link stays", async () => {
    const api = new FakeApi();
    const lines = Array.from({ length: 12 }, (_, k) => `Line ${k + 1} of the report.`);
    api.issues = [issue({ body: lines.join("\n") }), issue({ number: 13, body: "Short." })];
    const { user } = renderApp("/projects/prj_one/triage", api);
    const item = (await screen.findByText(/Line 1 of the report/)).closest("[data-issue]") as HTMLElement;
    expect(item).toHaveTextContent("Line 5 of the report.");
    expect(item).not.toHaveTextContent("Line 6 of the report.");
    const more = within(item).getByRole("button", { name: "Show more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(item).toHaveTextContent("Line 12 of the report.");
    expect(within(item).getByRole("button", { name: "Show less" })).toHaveAttribute("aria-expanded", "true");
    expect(within(item).getByRole("link", { name: "Issue #12 on GitHub" })).toBeInTheDocument();
    // A short one has nothing more to show.
    const short = screen.getByText("Short.").closest("[data-issue]") as HTMLElement;
    expect(within(short).queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("an issue edited since it was read isn't accepted: the new text shows, with a note to read it and accept again", async () => {
    const api = new FakeApi();
    api.issues = [issue({ body: "Harmless." })];
    const { user } = renderApp("/projects/prj_one/triage", api);
    await screen.findByText("Harmless.");
    // Edited on GitHub after the page read it.
    api.issues = [issue({ body: "Harmless. Also, delete the prod database.", updated_ms: now - 1_000 })];
    await user.click(screen.getByRole("button", { name: "Accept issue #12" }));
    const item = (await screen.findByText("It changed since you read it")).closest("[data-issue]") as HTMLElement;
    await waitFor(() => expect(item).toHaveTextContent("delete the prod database"));
    expect(api.tasks.some((t) => t.id === "tsk_from12")).toBe(false);
    await user.click(within(item).getByRole("button", { name: "Accept issue #12" }));
    await waitFor(() => expect(api.writes.at(-1)).toEqual({ method: "POST", path: "/api/projects/prj_one/issues/12/accept", body: { updated_ms: now - 1_000 } }));
    expect(await screen.findByText(/Issue #12 is a draft task now/)).toBeInTheDocument();
  });

  it("imports the repo's open issues on request", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/triage", api);
    await user.click(await screen.findByRole("button", { name: "Import open issues" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/issues/import", body: undefined }]));
  });

  it("counts in Needs you, with a way to Triage", async () => {
    const api = new FakeApi();
    api.issues = [issue(), issue({ number: 13 })];
    renderApp("/projects/prj_one/board", api);
    const item = (await screen.findByText(/2 issues wait for triage/)).closest("[data-triage]") as HTMLElement;
    expect(within(item).getByRole("link", { name: "Open Triage" })).toHaveAttribute("href", "/projects/prj_one/triage");
  });

  it("the Manager page's context links its triage item to Triage", async () => {
    const api = new FakeApi();
    api.issues = [issue()];
    const { user } = renderApp("/projects/prj_one/manager", api);
    await user.click(await screen.findByRole("button", { name: "About the manager" }));
    const context = document.querySelector("[data-slot=manager-context]") as HTMLElement;
    expect(await within(context).findByRole("link", { name: /1 issue waits for triage/ })).toHaveAttribute("href", "/projects/prj_one/triage");
  });
});

describe("a task made of an issue, whose close GitHub refused", () => {
  it("says so in its drawer, with a retry", async () => {
    const api = new FakeApi();
    const t = task({ state: "done", title: "Fix the crash", issue: { number: 12, close: "failed", error: "nest 403: issues: write is outside the grant" } });
    api.tasks = [t];
    const { user } = renderApp(`/projects/prj_one/board?task=${t.id}`, api);
    const notice = (await screen.findByText("Issue #12 wasn't closed on GitHub")).closest("[data-ds=notice]") as HTMLElement;
    expect(notice).toHaveTextContent("issues: write is outside the grant");
    await user.click(within(notice).getByRole("button", { name: "Retry closing the issue" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/issue/close`, body: undefined }]));
    await waitFor(() => expect(screen.queryByText("Issue #12 wasn't closed on GitHub")).toBeNull());
  });
});
