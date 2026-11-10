// Triage (README.md#triage): the repo's issues waiting, each with its title, author, age, link and body
// as plain text (escaped: markup in it is shown, never rendered), its first lines and "Show more"; Accept
// (of the issue as read: one edited since asks again) and Decline (with an optional reason); the one-off
// import; the count in "Needs you"; and the Manager page's link to it.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Issue, Proposal } from "../../api/types";
import { FakeApi, project, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { importText, issuesCaption } from "./TriagePage";
import { triageSource, triageWaits } from "./words";

const now = Date.now();
const issue = (o: Partial<Issue> = {}): Issue => ({
  number: 12, title: "Crash on save", body: "Steps: open, save.", author: "reporter", url: "https://github.com/owner/widgets/issues/12", state: "untriaged",
  task: null, reason: null, opened_ms: now - 3_600_000, updated_ms: now - 3_600_000, ...o,
});

const proposal = (o: Partial<Proposal> = {}): Proposal => ({
  id: "prp_one", routine: "rtn_a", routine_name: "Spontaneous review", run: "run_a", title: "Fix the race", body: "In src/a.ts.", state: "untriaged", task: null, reason: null,
  created_ms: now - 7_200_000, ...o,
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

  it("says whose issues come in, and how many the cap left out, with what to do", async () => {
    const api = new FakeApi();
    api.issues = [issue()];
    const view = renderApp("/projects/prj_one/triage", api);
    expect(await screen.findByText(/^Issues opened by owner, as they're opened/)).toBeInTheDocument();
    expect(screen.queryByText(/left out/)).toBeNull();
    view.unmount();
    const busy = new FakeApi();
    busy.issues = [issue()];
    busy.projects[0]!.settings = { ...busy.projects[0]!.settings!, issues_from: "anyone", issues_dropped: { count: 3, last_ms: Date.now() - 600_000 } };
    renderApp("/projects/prj_one/triage", busy);
    expect(await screen.findByText(/^The repo's issues, anyone's, as they're opened/)).toBeInTheDocument();
    const notice = await screen.findByRole("status", { name: "3 issues left out" });
    expect(notice).toHaveTextContent("Triage holds at most 200 issues waiting, so they weren't brought in (the last 10 minutes ago). Accept or decline some, then Import open issues to bring the rest in.");
  });

  it("names whose issues come in, or says no one's do yet and what to do", () => {
    const base = project().settings!;
    expect(issuesCaption({ ...base, comments_from: { id: 2, login: null } })).toMatch(/^Issues opened by user 2 and owner,/);
    // No one counts: the caption says the rule; the Notice (below) says no one's do yet.
    expect(issuesCaption({ ...base, comments_from: null, repo_owner: null })).toMatch(/^Issues opened by the PR comments user or the repo's owner,/);
    expect(issuesCaption({ ...base, comments_from: null, repo_owner: null, issues_from: "anyone" })).toMatch(/^The repo's issues, anyone's/);
  });

  it("when no one's issues come in, a warning Notice says so, with the way to Settings' Triage panel; not when someone's do", async () => {
    const api = new FakeApi();
    api.projects[0]!.settings = { ...api.projects[0]!.settings!, comments_from: null, repo_owner: null };
    const view = renderApp("/projects/prj_one/triage", api);
    const notice = await screen.findByRole("status", { name: "No one's issues come in yet" });
    expect(notice).toHaveTextContent("no PR comments user is set and the repo's owner isn't known as a person");
    expect(notice).not.toHaveTextContent("organization");
    expect(notice).toHaveTextContent("Set the PR comments user, or choose Anyone under Issues from.");
    expect(within(notice).getByRole("link", { name: "Open Settings" })).toHaveAttribute("href", "/projects/prj_one/settings#triage");
    view.unmount();
    // Someone's do (the default fake's owner), or anyone's: no Notice.
    renderApp("/projects/prj_one/triage", new FakeApi());
    await screen.findByText(/^Issues opened by owner/);
    expect(screen.queryByRole("status", { name: "No one's issues come in yet" })).toBeNull();
    const anyone = new FakeApi();
    anyone.projects[0]!.settings = { ...anyone.projects[0]!.settings!, comments_from: null, repo_owner: null, issues_from: "anyone" };
    renderApp("/projects/prj_one/triage", anyone);
    await screen.findAllByText(/^The repo's issues, anyone's/);
    expect(screen.queryByRole("status", { name: "No one's issues come in yet" })).toBeNull();
  });

  it("an import says what it left out", async () => {
    expect(importText({ imported: 2, ignored: 0, dropped: 0 })).toBe("2 issues brought into triage.");
    expect(importText({ imported: 0, ignored: 1, dropped: 3 })).toBe("No open issues to bring in; 1 issue opened by others left out; 3 issues past the 200 waiting left out.");
    const api = new FakeApi();
    api.importAnswer = { imported: 1, known: 0, ignored: 4, dropped: 0 };
    const { user } = renderApp("/projects/prj_one/triage", api);
    await user.click(await screen.findByRole("button", { name: "Import open issues" }));
    expect(await screen.findByText("1 issue brought into triage; 4 issues opened by others left out.")).toBeInTheDocument();
  });

  it("counts in Needs you, with a way to Triage", async () => {
    const api = new FakeApi();
    api.issues = [issue(), issue({ number: 13 })];
    renderApp("/projects/prj_one/board", api);
    const item = (await screen.findByText(/2 issues wait for triage/)).closest("[data-triage]") as HTMLElement;
    expect(within(item).getByRole("link", { name: "Open Triage" })).toHaveAttribute("href", "/projects/prj_one/triage");
  });

  it("lists the tasks routines proposed under the issues, with accept and decline; nothing of them when there are none", async () => {
    const none = new FakeApi();
    none.issues = [issue()];
    const first = renderApp("/projects/prj_one/triage", none);
    await screen.findByRole("heading", { name: "Issues" });
    await screen.findByText("Crash on save");
    await waitFor(() => expect(first.queryClient.isFetching()).toBe(0));
    expect(screen.queryByRole("heading", { name: "Proposed tasks" })).toBeNull();
    expect(screen.queryByText("Nothing proposed")).toBeNull();
    first.unmount();
    const api = new FakeApi();
    api.issues = [issue()];
    api.proposals = [proposal(), proposal({ id: "prp_two", title: "Drop the old flag" })];
    const { user } = renderApp("/projects/prj_one/triage", api);
    const list = await screen.findByRole("list", { name: "Proposed tasks" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    // After the issues, in the page's order.
    const issues = screen.getByRole("list", { name: "Issues to triage" });
    expect(issues.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const card = list.querySelector("[data-proposal=prp_one]") as HTMLElement;
    expect(card).toHaveTextContent("From the routine Spontaneous review");
    await user.click(within(card).getByRole("button", { name: "Accept “Fix the race” as a draft" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/proposals/prp_one/accept", body: undefined }));
    await user.click(await screen.findByRole("button", { name: "Decline “Drop the old flag”" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Decline “Drop the old flag”?" })).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.writes.at(-1)).toMatchObject({ method: "POST", path: "/api/projects/prj_one/proposals/prp_two/decline" }));
    // The last one gone: the section goes too.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Proposed tasks" })).toBeNull());
  });

  it("with no issues but proposals waiting, the issues' empty is a quiet line; the page's empty state only when both are empty", async () => {
    const api = new FakeApi();
    api.proposals = [proposal()];
    const view = renderApp("/projects/prj_one/triage", api);
    expect(await screen.findByText("No issues to triage.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing to triage")).toBeNull();
    expect(await screen.findByRole("list", { name: "Proposed tasks" })).toBeInTheDocument();
    view.unmount();
    renderApp("/projects/prj_one/triage", new FakeApi());
    expect(await screen.findByText("Nothing to triage")).toBeInTheDocument();
    expect(screen.queryByText("No issues to triage.")).toBeNull();
  });

  it("proposals count in Needs you with the issues, in words; triaging one there moves the count", async () => {
    expect(triageWaits(3, 1)).toBe("3 issues and 1 proposed task wait");
    expect(triageWaits(1, 0)).toBe("1 issue waits");
    expect(triageWaits(0, 1)).toBe("1 proposed task waits");
    expect(triageWaits(0, 2)).toBe("2 proposed tasks wait");
    expect(triageWaits(1, 1)).toBe("1 issue and 1 proposed task wait");
    expect([triageSource(2, 0), triageSource(0, 2), triageSource(1, 1)]).toEqual(["The repo's issues", "Routines' proposals", "Issues and routines' proposals"]);
    const api = new FakeApi();
    api.issues = [issue()];
    api.proposals = [proposal(), proposal({ id: "prp_two", title: "Drop the old flag" })];
    const { user, router } = renderApp("/projects/prj_one/board", api);
    const item = (await screen.findByText(/1 issue and 2 proposed tasks wait for triage: accept each/)).closest("[data-triage]") as HTMLElement;
    expect(item).toHaveTextContent("Issues and routines' proposals");
    await user.click(within(item).getByRole("link", { name: "Open Triage" }));
    await user.click(await screen.findByRole("button", { name: "Accept “Fix the race” as a draft" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept “Fix the race” as a draft" })).toBeNull());
    await router.navigate({ to: "/projects/$projectId/board", params: { projectId: "prj_one" }, search: {} });
    expect(await screen.findByText(/1 issue and 1 proposed task wait for triage/)).toBeInTheDocument();
  });

  it("triaging the last proposal clears the sidebar's count at once, as an issue does", async () => {
    const api = new FakeApi();
    api.proposals = [proposal()];
    const { user } = renderApp("/projects/prj_one/triage", api);
    await waitFor(() => expect(document.querySelector("[data-marker=needs-you]")).toHaveTextContent("1"));
    await user.click(await screen.findByRole("button", { name: "Accept “Fix the race” as a draft" }));
    await waitFor(() => expect(document.querySelector("[data-marker=needs-you]")).toBeNull());
  });

  it("the Manager page's context names proposals too", async () => {
    const api = new FakeApi();
    api.proposals = [proposal()];
    const { user } = renderApp("/projects/prj_one/manager", api);
    await user.click(await screen.findByRole("button", { name: "About the manager" }));
    const context = document.querySelector("[data-slot=manager-context]") as HTMLElement;
    expect(await within(context).findByRole("link", { name: /1 proposed task waits for triage/ })).toHaveAttribute("href", "/projects/prj_one/triage");
    expect(context).toHaveTextContent("Routines' proposals");
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
