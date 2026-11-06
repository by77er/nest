// Triage (README.md#triage): the repo's issues waiting, each with its title, author, age, link and body
// as plain text (escaped: markup in it is shown, never rendered); Accept and Decline (with an optional
// reason); the one-off import; and the count in "Needs you".
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Issue } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
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
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/issues/12/accept", body: undefined }]));
    expect(await screen.findByText(/Issue #12 is a draft task now/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Decline issue #13" }));
    const confirm = await screen.findByRole("dialog", { name: "Decline issue #13?" });
    expect(confirm).toHaveTextContent("Nothing changes on GitHub");
    await user.type(within(confirm).getByLabelText(/Reason/), "Won't support IE");
    await user.click(within(confirm).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.writes.at(-1)).toEqual({ method: "POST", path: "/api/projects/prj_one/issues/13/decline", body: { reason: "Won't support IE" } }));
    expect(await screen.findByText("Nothing to triage")).toBeInTheDocument();
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
});
