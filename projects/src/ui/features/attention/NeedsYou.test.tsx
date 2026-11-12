// "Needs you" above the board (README.md#blocked): agents' asks and blocked tasks together, oldest first,
// each answered there. An approval is answered approve (green) or deny (red), words nest reads as such
// (docs/agents/tools/#taint-and-sinks); a question or a block in words.
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const panel = () => screen.findByRole("region", { name: "Needs you" });
const gone = () => expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
/** The last item answered here: the panel goes, focus is on the board's heading, and that's said in a live region. */
const answeredLast = async () => {
  await waitFor(gone);
  expect(screen.getByRole("heading", { name: "Tasks" })).toHaveFocus();
  expect(document.querySelector("[data-announce]")).toHaveTextContent("Answered; nothing else waits on you.");
};

describe("asks", () => {
  it("an approval: approve is green and sends approve; the ask then leaves", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "github.create_pr", tool: "brokered" }, question: "Open the PR?" });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one/board", api);

    const p = await panel();
    // Calm: the surface with a warning rule, not a warning-tinted fill.
    expect(p.getAttribute("style")).toContain("--mantine-color-warning-filled");
    expect(p.getAttribute("style")).not.toContain("--mantine-color-warning-light");
    expect(p).toHaveTextContent("github.create_pr");
    expect(p).toHaveTextContent("Open the PR?");
    const approve = within(p).getByRole("button", { name: "Approve" });
    expect(approve.getAttribute("style")).toContain("--mantine-color-success-");
    expect(within(p).getByRole("button", { name: "Deny" }).getAttribute("style")).toContain("--mantine-color-danger-");

    await user.click(approve);
    await answeredLast();
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "approve" } }]);
  });

  it("one answered elsewhere meanwhile (refused as no longer open) leaves at once: the asks are read again", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "brokered", tool: "WebFetch" } });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    // nest has it answered (the operator) before the owner clicks: the Worker refuses, and lists it no more.
    api.asks = [];
    api.fail(/\/answer$/, 409, "this ask isn't open any more: it was answered, or its agent ended");
    await user.click(within(p).getByRole("button", { name: "Approve" }));
    // Well before the next poll (5 s); said in the panel, calmly, not as a failure.
    await waitFor(() => expect(p.querySelector("[data-ask]")).toBeNull(), { timeout: 1_500 });
    expect(p.querySelector("[data-note]")).toHaveTextContent("Already answered: the call to WebFetch was answered elsewhere, or its agent ended.");
    expect(screen.queryByText("The answer wasn't sent")).toBeNull();
    expect(within(p).getByRole("heading", { name: "Needs you" })).toHaveFocus();
    // Nothing waits now: no warning, no count, only the note; at the next poll the panel goes, focus to the board.
    expect(p.getAttribute("data-tone")).toBe("default");
    expect(p.querySelector("[data-slot=count]")).toBeNull();
  });

  it("the note goes when focus moves on from where the answer left it", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "brokered", tool: "WebFetch" }, at_ms: Date.now() - 2_000 });
    const b = ask({ approval: { name: "brokered", tool: "WebSearch" }, at_ms: Date.now() - 1_000 });
    api.asks = [a, b];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    api.asks = [b];
    api.fail(/\/answer$/, 409, "this ask isn't open any more");
    await user.click(within(p.querySelector(`[data-ask="${a.ask}"]`) as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(p.querySelector("[data-note]")).not.toBeNull());
    const next = within(p.querySelector(`[data-ask="${b.ask}"]`) as HTMLElement);
    expect(next.getByRole("button", { name: "Approve" })).toHaveFocus();
    // Still there while focus is where the answer left it (past the re-read).
    await new Promise((r) => setTimeout(r, 300));
    expect(p.querySelector("[data-note]")).not.toBeNull();
    // On to the next control: the note has been read.
    next.getByRole("button", { name: "Deny" }).focus();
    await new Promise((r) => setTimeout(r, 100));
    expect(p.querySelector("[data-note]")).toBeNull();
  });

  it("the last item's note goes at the next poll, and focus goes on to the board's heading", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "brokered", tool: "WebFetch" } });
    api.asks = [a];
    const { user, queryClient } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    api.asks = [];
    api.fail(/\/answer$/, 409, "this ask isn't open any more");
    await user.click(within(p).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(p.querySelector("[data-note]")).not.toBeNull());
    await queryClient.refetchQueries({ queryKey: ["projects", "prj_one", "attention"], exact: true });
    await waitFor(gone);
    expect(screen.getByRole("heading", { name: "Tasks" })).toHaveFocus();
  });

  it("with none of the app's own items, a read that takes a moment shows the panel when more waits than that", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Later?" })];
    let release!: () => void;
    api.holds.push({ match: /^GET \/api\/projects\/prj_one\/attention$/, until: new Promise((r) => (release = () => r(undefined))) });
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(p).toHaveTextContent("Reading the agents' asks…");
    expect(within(p).getByLabelText("An unknown number of items")).toHaveTextContent("?");
    release();
    await waitFor(() => expect(p).toHaveTextContent("Later?"));
  });

  it("with nothing waiting at all, nothing shows while the asks are read", async () => {
    const api = new FakeApi();
    let release!: () => void;
    api.holds.push({ match: /^GET \/api\/projects\/prj_one\/attention$/, until: new Promise((r) => (release = () => r(undefined))) });
    renderApp("/projects/prj_one/board", api);
    await screen.findByRole("heading", { name: "Tasks" });
    await new Promise((r) => setTimeout(r, 500));
    gone();
    release();
  });

  it("answering one moves focus to the next item, never to the page", async () => {
    const api = new FakeApi();
    const first = ask({ approval: { name: "brokered", tool: "WebFetch" }, at_ms: Date.now() - 2_000 });
    const second = ask({ approval: { name: "brokered", tool: "WebSearch" }, at_ms: Date.now() - 1_000 });
    api.asks = [first, second];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const approve = within(p.querySelector(`[data-ask="${first.ask}"]`) as HTMLElement).getByRole("button", { name: "Approve" });
    approve.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(p.querySelector(`[data-ask="${first.ask}"]`)).toBeNull());
    expect(within(p.querySelector(`[data-ask="${second.ask}"]`) as HTMLElement).getByRole("button", { name: "Approve" })).toHaveFocus();
  });

  it("an answer that fails keeps focus on its button, which stays focusable while the answer is out", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "brokered", tool: "WebFetch" } });
    api.asks = [a];
    let release!: () => void;
    api.holds.push({ match: /\/answer$/, until: new Promise((r) => (release = () => r(undefined))) });
    api.fail(/\/answer$/, 502, "nest is unavailable");
    const { user } = renderApp("/projects/prj_one/board", api);
    const approve = within(await panel()).getByRole("button", { name: "Approve" });
    approve.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(approve).toHaveAttribute("aria-disabled", "true"));
    expect(approve).not.toBeDisabled();
    expect(approve).toHaveFocus();
    // A second press while it's out sends nothing more.
    await user.keyboard("{Enter}");
    release();
    expect(await screen.findByText("nest is unavailable")).toBeInTheDocument();
    await waitFor(() => expect(approve).not.toHaveAttribute("aria-disabled"));
    expect(approve).toHaveFocus();
    expect(api.writes).toHaveLength(1);
    // A failure isn't "answered elsewhere": no such note, and the ask stays.
    expect(document.querySelector("[data-note]")).toBeNull();
    expect(document.querySelector(`[data-ask="${a.ask}"]`)).not.toBeNull();
  });

  it("the app's own items show while nest's asks are still being read", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Later?" })];
    api.tasks = [task({ title: "Pick a region", blocked: { at_ms: Date.now() - 1_000, by: "agt_w1", role: "worker", reason: "which region?", question: null, tainted: false } })];
    let release!: () => void;
    api.holds.push({ match: /^GET \/api\/projects\/prj_one\/attention$/, until: new Promise((r) => (release = () => r(undefined))) });
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(p).toHaveTextContent("Pick a region");
    expect(p).not.toHaveTextContent("Later?");
    // Said to be partial, and not counted as if it were all.
    expect(p).toHaveTextContent("Reading the agents' asks…");
    expect(within(p).getByLabelText("An unknown number of items")).toHaveTextContent("?");
    release();
    await waitFor(() => expect(p).toHaveTextContent("Later?"));
    expect(p).not.toHaveTextContent("Reading the agents' asks…");
    expect(within(p).getByLabelText("2 items")).toBeInTheDocument();
  });

  it("the first full read failing: the app's own items, said to be without the asks, never a whole count", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Hidden?" })];
    api.tasks = [task({ title: "Pick a region", blocked: { at_ms: Date.now() - 1_000, by: "agt_w1", role: "worker", reason: "which region?", question: null, tainted: false } })];
    api.fail(/^GET \/api\/projects\/prj_one\/attention$/, 500, "the Worker is unavailable");
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    await waitFor(() => expect(p).toHaveTextContent("The agents' asks couldn't be read"));
    expect(p).toHaveTextContent("Pick a region");
    expect(p).not.toHaveTextContent("Reading the agents' asks…");
    expect(within(p).getByLabelText("An unknown number of items")).toHaveTextContent("?");
  });

  it("the 'Already answered' note goes once a read after the one that dropped the ask has come", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "brokered", tool: "WebFetch" } });
    const b = ask({ question: "Still open?" });
    api.asks = [a, b];
    const { user, queryClient } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    api.asks = [b];
    api.fail(/\/answer$/, 409, "this ask isn't open any more");
    await user.click(within(p.querySelector(`[data-ask="${a.ask}"]`) as HTMLElement).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(p.querySelector("[data-note]")).not.toBeNull());
    await waitFor(() => expect(p.querySelector(`[data-ask="${a.ask}"]`)).toBeNull());
    // The next poll: the note has done its job.
    await queryClient.refetchQueries({ queryKey: ["projects", "prj_one", "attention"], exact: true });
    await waitFor(() => expect(p.querySelector("[data-note]")).toBeNull());
  });

  it("a poll that fails after a good read says it shows that read", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Still here?" })];
    const { queryClient } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(p).toHaveTextContent("Still here?");
    api.fail(/GET .*\/attention$/, 502, "the Worker is unavailable");
    await queryClient.refetchQueries({ queryKey: ["projects", "prj_one", "attention"], exact: true });
    await waitFor(() => expect(p).toHaveTextContent(/Couldn't refresh; showing what was read at \d/));
    expect(p).toHaveTextContent("Still here?");
  });

  it("nest unreadable: the rest is listed, with a line saying the asks couldn't be read", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "hidden?" })];
    api.asksError = "nest couldn't list the agents' asks: nest 503";
    api.tasks = [task({ title: "Pick a region", blocked: { at_ms: Date.now() - 1_000, by: "agt_w1", role: "worker", reason: "which region?", question: null, tainted: false } })];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(p).toHaveTextContent("The agents' asks couldn't be read");
    expect(p).toHaveTextContent("Pick a region");
    expect(p).not.toHaveTextContent("hidden?");
    // No count: the blocked task alone isn't all that waits.
    expect(within(p).getByLabelText("An unknown number of items")).toHaveTextContent("?");
  });

  it("nest unreadable and nothing else waiting: the panel still says so, never empty", async () => {
    const api = new FakeApi();
    api.asksError = "nest 503";
    renderApp("/projects/prj_one/board", api);
    expect(await panel()).toHaveTextContent("The agents' asks couldn't be read");
  });

  it("an approval denied sends deny", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "email.send", tool: "brokered" } });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one/board", api);
    await user.click(within(await panel()).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "deny" } }]));
  });

  it("a previous manager's ask says so, and its question shows as plain text, not the manager's rich content", async () => {
    const api = new FakeApi();
    api.asks = [
      ask({ question: "Merge **everything**?", role: "manager", agent: "agt_old", previous: true }),
      ask({ question: "Use **main**?", role: "manager", agent: "agt_manager" }),
    ];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const old = await waitFor(() => {
      const el = [...p.querySelectorAll("[data-ask]")].find((e) => e.textContent?.includes("agt_old"));
      if (!el) throw new Error("not yet");
      return el as HTMLElement;
    });
    expect(old).toHaveTextContent("The previous manager");
    expect(old).toHaveTextContent("Merge **everything**?");
    expect(old.querySelector("strong")).toBeNull();
    const current = [...p.querySelectorAll("[data-ask]")].find((e) => e.textContent?.includes("agt_manager")) as HTMLElement;
    expect(current).not.toHaveTextContent("The previous manager");
    expect(current.querySelector("strong")).not.toBeNull();
  });

  it("a question is answered in words; one nest refuses keeps the ask and what was typed", async () => {
    const api = new FakeApi();
    const a = ask({ question: "Which branch should I base on?", role: "manager", agent: "agt_manager" });
    api.asks = [a];
    api.fail(/\/answer$/, 502, "nest is unavailable");
    const { user } = renderApp("/projects/prj_one/board", api);

    const p = await panel();
    expect(p).not.toHaveTextContent("already answered");
    expect(within(p).queryByRole("button", { name: "Approve" })).toBeNull();
    const send = within(p).getByRole("button", { name: "Answer" });
    expect(send).toBeDisabled();
    await user.type(within(p).getByLabelText("Your answer"), "main");
    await user.click(send);

    expect(await screen.findByText("nest is unavailable")).toBeInTheDocument();
    expect(within(await panel()).getByLabelText("Your answer")).toHaveValue("main");
    await user.click(within(await panel()).getByRole("button", { name: "Answer" }));
    await answeredLast();
    expect(api.writes.map((w) => w.body)).toEqual([{ answer: "main" }, { answer: "main" }]);
  });

  it("lists blocked tasks with the asks, oldest first, with who blocked it, why and what they ask", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.asks = [ask({ question: "Newest: which branch?", at_ms: now - 1_000 })];
    api.tasks = [
      task({ title: "Middle", state: "in_progress", blocked: { at_ms: now - 60_000, by: "agt_w1", role: "worker", reason: "No staging credentials", question: "Add STAGING_DB_URL?", tainted: false } }),
      task({ title: "Oldest", state: "ready", blocked: { at_ms: now - 3_600_000, by: "agt_manager", role: "manager", reason: "Needs a product decision", question: null, tainted: false } }),
    ];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(within(p).getByText("3")).toBeInTheDocument();
    const order = [...p.querySelectorAll("[data-ask], [data-blocked]")].map((e) => e.textContent ?? "");
    expect(order.map((t) => (t.includes("Oldest") ? "oldest" : t.includes("Middle") ? "middle" : t.includes("Newest") ? "newest" : "?"))).toEqual(["oldest", "middle", "newest"]);
    const middle = p.querySelector(`[data-blocked="${api.tasks[0]!.id}"]`) as HTMLElement;
    expect(middle).toHaveTextContent("A worker");
    expect(middle).toHaveTextContent("agt_w1");
    expect(middle).toHaveTextContent("No staging credentials");
    expect(middle).toHaveTextContent("Add STAGING_DB_URL?");
    expect(middle).toHaveTextContent("1 minute ago");
    expect(within(middle).getByText("Goes to the worker and the manager")).toBeInTheDocument();
  });

  it("answering a blocked task sends the answer and the block leaves", async () => {
    const api = new FakeApi();
    const t = task({ title: "Stuck", state: "in_progress", blocked: { at_ms: Date.now() - 1000, by: "agt_w1", role: "worker", reason: "r", question: "q?", tainted: false } });
    api.tasks = [t];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    await user.type(within(p).getByLabelText(/Your answer/), "use eu-west-1");
    await user.click(within(p).getByRole("button", { name: "Answer" }));
    await answeredLast();
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/tasks/${t.id}/answer`, body: { answer: "use eu-west-1" } }]);
  });

  it("marks a blocked task's card, and counts what needs you on the projects list", async () => {
    const api = new FakeApi();
    api.tasks = [task({ title: "Stuck", state: "in_progress", blocked: { at_ms: Date.now(), by: "agt_w1", role: "worker", reason: "r", question: null, tainted: false } })];
    api.asks = [ask({ question: "q" })];
    renderApp("/projects/prj_one/board", api);
    const card = await screen.findByRole("article", { name: "Stuck" });
    expect(within(card).getByText("Blocked").closest(".mantine-Badge-root")!.getAttribute("style") ?? "").toContain("--mantine-color-warning-");
    expect(within(card).getByText("Blocked").closest("[data-marker=blocked]")).not.toBeNull();
    cleanup();
    renderApp("/", api);
    const listed = await screen.findByRole("article", { name: "Widgets" });
    expect(within(listed).getByText("2 need you")).toBeInTheDocument();
  });

  it("shows the oldest three, the rest behind \"Show all (n)\", so the board stays in view", async () => {
    const api = new FakeApi();
    const now = Date.now();
    api.asks = [5, 4, 3, 2, 1].map((n) => ask({ question: `Ask ${n}`, at_ms: now - n * 60_000 }));
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const shown = () => [...p.querySelectorAll("[data-ask]")].filter((e) => !e.closest("[aria-hidden=true]") && !e.closest('[style*="display: none"]')).map((e) => /Ask \d/.exec(e.textContent ?? "")![0]);
    expect(shown()).toEqual(["Ask 5", "Ask 4", "Ask 3"]);
    const toggle = within(p).getByRole("button", { name: "Show all (5)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    await waitFor(() => expect(shown()).toEqual(["Ask 5", "Ask 4", "Ask 3", "Ask 2", "Ask 1"]));
    expect(within(p).getByRole("button", { name: "Show fewer" })).toHaveAttribute("aria-expanded", "true");
  });

  it("a review held for approval: the PR, who it's from, and Review this PR, after which it leaves", async () => {
    const api = new FakeApi();
    const sha = "c".repeat(40);
    const heldJob = (pr: number, s: string, age: number, o: Record<string, unknown> = {}) => ({
      pr, sha: s, state: "held" as const, title: "Speed up the parser", base: "main", agent: null, check_run: null, verdict: null, tainted: null, deadline_ms: null,
      attempts: 0, runs: 0, error: null, author: "mallory", fork: true, approved_ms: null, created_ms: Date.now() - age, updated_ms: Date.now(), ...o,
    });
    api.reviews = [heldJob(12, sha, 120_000), heldJob(13, "d".repeat(40), 60_000, { fork: false, author: "eve" })];
    const { user } = renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const item = p.querySelector(`[data-held-review="12/${sha}"]`) as HTMLElement;
    expect(item).toHaveTextContent("A fork's PR by mallory");
    // The explanation in full once, on the first held review; the short form after.
    expect(item).toHaveTextContent("Reviewing starts a reviewer agent on this commit's code; a later push waits again.");
    const second = p.querySelector(`[data-held-review="13/${"d".repeat(40)}"]`) as HTMLElement;
    expect(second).toHaveTextContent("A PR by eve, who isn't someone the project trusts");
    expect(second).toHaveTextContent("Its review waits for your approval.");
    expect(second).not.toHaveTextContent("Reviewing starts a reviewer agent");
    expect(item).toHaveTextContent("ccccccc");
    expect(within(item).getByRole("link", { name: "#12 Speed up the parser" })).toHaveAttribute("href", expect.stringMatching(/\/pull\/12$/));
    expect(within(item).getByRole("button", { name: "Dismiss the review of PR #12" })).toBeInTheDocument();
    await user.click(within(item).getByRole("button", { name: "Review PR #12" }));
    await waitFor(() => expect(p.querySelector(`[data-held-review="12/${sha}"]`)).toBeNull());
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/reviews/12/${sha}/approve`, body: undefined }]);
  });

  it("counts the pull requests past the review queue's limit, in one line", async () => {
    const api = new FakeApi();
    api.reviewBacklog = 7;
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    const item = p.querySelector("[data-review-backlog]") as HTMLElement;
    expect(item).toHaveTextContent("7 more pull requests wait beyond the queue's limit, with no review yet.");
    expect(within(item).queryByRole("button")).toBeNull();
  });

  it("has no toggle with three or fewer", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Only one" })];
    renderApp("/projects/prj_one/board", api);
    const p = await panel();
    expect(within(p).queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});
