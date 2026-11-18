// The Reviews page: ReviewDO's jobs, newest first, each state in its role (a done job by its verdict),
// and a job's reviewer's live trace, one open at a time; under them, the project's reviewers, managed there.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job, Review, Verdict } from "../../api/types";
import { FakeApi, reviewer } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { RecordingSocket } from "../../test/sockets";

const codeReview = (quality: "pass" | "fail", tainted = false): Review => ({
  reviewer: { id: "code-review", name: "Code review" }, agent: "agt_r", tainted, summary: "s",
  dimensions: [{ name: "Correctness", verdict: "pass", notes: "ok" }, { name: "Quality", verdict: quality, notes: "q" }, { name: "Architectural cohesiveness", verdict: "pass", notes: "a" }],
});
const security = (secrets: "pass" | "fail", tainted = false): Review => ({
  reviewer: { id: "rv_sec", name: "Security" }, agent: "agt_s", tainted, summary: "sec",
  dimensions: [{ name: "Secrets", verdict: secrets, notes: "keys" }, { name: "Quality", verdict: "pass", notes: "fine" }],
});
const verdict = (quality: "pass" | "fail", tainted = false): Verdict => ({ reviews: [codeReview(quality, tainted)] });
const job = (pr: number, o: Partial<Job> = {}): Job => ({
  pr, sha: `${pr}`.padEnd(40, "0"), state: "queued", title: `PR ${pr}`, base: "main", agent: null, check_run: null, verdict: null, tainted: null, deadline_ms: null,
  attempts: 0, runs: 1, error: null, author: null, fork: false, approved_ms: null, created_ms: pr, updated_ms: pr, ...o,
});

describe("the Reviews page", () => {
  it("lists the jobs newest first, a done job by its verdict", async () => {
    const api = new FakeApi();
    api.reviews = [
      job(1, { state: "done", verdict: verdict("pass") }),
      job(3, { state: "running", agent: "agt_rev3" }),
      job(2, { state: "done", verdict: verdict("fail") }),
      job(0, { state: "failed", error: "The reviewer exited without a verdict." }),
    ];
    renderApp("/projects/prj_one/reviews", api);
    const table = await screen.findByRole("table", { name: "Review jobs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0]!.textContent)).toEqual(["#3 PR 3", "#2 PR 2", "#1 PR 1", "#0 PR 0"]);
    const badge = (r: HTMLElement) => r.querySelector("[data-state]")!;
    expect(badge(rows[0]!)).toHaveTextContent("Reviewing");
    expect(badge(rows[1]!)).toHaveTextContent("Changes needed");
    expect(badge(rows[1]!).getAttribute("style")).toContain("--mantine-color-danger-");
    expect(badge(rows[2]!)).toHaveTextContent("Reviewed");
    expect(badge(rows[2]!).getAttribute("style")).toContain("--mantine-color-success-");
    expect(rows[3]).toHaveTextContent("The reviewer exited without a verdict.");
  });

  it("a held review says who it's from and is approved or dismissed there; a dismissed one can still be reviewed", async () => {
    const api = new FakeApi();
    api.reviews = [
      job(4, { state: "held", runs: 0, author: "mallory", fork: true, title: "<img src=x onerror=alert(1)>" }),
      job(5, { state: "dismissed", runs: 0, author: null, fork: false }),
    ];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const table = await screen.findByRole("table", { name: "Review jobs" });
    const held = table.querySelector(`[data-job="${api.reviews[0]!.pr}/${api.reviews[0]!.sha}"]`) as HTMLElement;
    const badge = held.querySelector("[data-state]")!;
    expect(badge).toHaveTextContent("Needs approval");
    expect(badge.getAttribute("style")).toContain("--mantine-color-warning-");
    expect(held).toHaveTextContent("A fork's PR by mallory. Its review waits for your approval.");
    // The title is anyone's text: text, not markup.
    expect(held.querySelector("img")).toBeNull();
    expect(held).toHaveTextContent("<img src=x onerror=alert(1)>");
    const dismissed = table.querySelector(`[data-job="${api.reviews[1]!.pr}/${api.reviews[1]!.sha}"]`) as HTMLElement;
    expect(dismissed.querySelector("[data-state]")).toHaveTextContent("Dismissed");
    expect(dismissed).toHaveTextContent("A PR whose author the project doesn't know. You dismissed its review.");
    // Review is the filled action only where it waits on the owner now.
    expect(within(held).getByRole("button", { name: "Review PR #4" })).toHaveAttribute("data-variant", "filled");
    expect(within(dismissed).getByRole("button", { name: "Review PR #5" })).toHaveAttribute("data-variant", "default");
    expect(within(dismissed).queryByRole("button", { name: /Dismiss/ })).toBeNull();
    await user.click(within(held).getByRole("button", { name: "Dismiss the review of PR #4" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/reviews/4/${api.reviews[0]!.sha}/dismiss`, body: undefined }]));
    await user.click(within(dismissed).getByRole("button", { name: "Review PR #5" }));
    await waitFor(() => expect(api.writes[1]).toMatchObject({ method: "POST", path: `/api/projects/prj_one/reviews/5/${api.reviews[1]!.sha}/approve` }));
  });

  it("pins the reviews waiting for approval first, the longest waiting on top; says why a non-fork PR waits", async () => {
    const api = new FakeApi();
    api.reviews = [
      job(9, { state: "done", verdict: verdict("pass"), updated_ms: 900 }),
      job(7, { state: "held", runs: 0, author: "mallory", created_ms: 70, updated_ms: 70 }),
      job(6, { state: "held", runs: 0, author: "eve", fork: true, created_ms: 60, updated_ms: 800 }),
      job(8, { state: "overflow", runs: 0, author: "trent", updated_ms: 850 }),
    ];
    renderApp("/projects/prj_one/reviews", api);
    const table = await screen.findByRole("table", { name: "Review jobs" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => within(r).getAllByRole("link")[0]!.textContent)).toEqual(["#6 PR 6", "#7 PR 7", "#8 PR 8", "#9 PR 9"]);
    expect(rows[1]).toHaveTextContent("A PR by mallory, who isn't someone the project trusts. Its review waits for your approval.");
    expect(rows[2]!.querySelector("[data-state]")).toHaveTextContent("Waiting");
    expect(rows[2]).toHaveTextContent("It waits its turn: too many reviews wait for your approval.");
    expect(within(rows[2]!).getByRole("button", { name: "Review PR #8" })).toHaveAttribute("data-variant", "default");
    // A time on one line, however narrow its column.
    expect(rows[3]!.querySelector("td:nth-child(5) span")!.getAttribute("style")).toContain("white-space: nowrap");
    expect(within(rows[2]!).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });

  it("opens one reviewer's trace at a time, for that job's agent", async () => {
    RecordingSocket.opened = [];
    vi.stubGlobal("WebSocket", RecordingSocket);
    const api = new FakeApi();
    api.reviews = [job(3, { state: "running", agent: "agt_rev3" }), job(2, { state: "done", agent: "agt_rev2", verdict: verdict("pass") })];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    await user.click(await screen.findByRole("button", { name: "Show the trace of #3" }));
    expect(await screen.findByRole("heading", { name: "Reviewer of #3" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show the trace of #2" }));
    expect(await screen.findByRole("heading", { name: "Reviewer of #2" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Reviewer of #3" })).toBeNull();
    await waitFor(() => expect(RecordingSocket.opened.map((u) => new URL(u).pathname)).toEqual(["/api/agents/agt_rev3/trace", "/api/agents/agt_rev2/trace"]));
  });

  it("on a phone, a card per review, newest first, top to bottom: its PR, state, verdicts, when and its trace", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(max-width: 48em)", media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    RecordingSocket.opened = [];
    vi.stubGlobal("WebSocket", RecordingSocket);
    const api = new FakeApi();
    api.reviews = [
      job(1, { state: "done", verdict: verdict("fail", true), runs: 2, tainted: true }), job(3, { state: "running", agent: "agt_rev3" }),
      job(0, { state: "done", verdict: { reviews: [codeReview("pass"), security("fail", true)] }, tainted: true }),
    ];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const list = await screen.findByRole("list", { name: "Review jobs" });
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards.map((c) => within(c).getAllByRole("link")[0]!.textContent)).toEqual(["#3 PR 3", "#1 PR 1", "#0 PR 0"]);
    const done = cards[1]!;
    // Everything the table's row has, in one column: the sha, the verdicts, the runs and when.
    expect(done).toHaveTextContent("1000000 → main");
    expect(within(done).getByLabelText("Quality: failed")).toBeInTheDocument();
    expect(done).toHaveTextContent("2 runs");
    // Tainted sits on its state row, beside the state, not after the verdicts.
    const stateRow = within(done).getByText("Tainted").parentElement!.parentElement!;
    expect(stateRow).toHaveTextContent(/Changes needed\s*Tainted/);
    expect(within(cards[0]!).getByRole("button", { name: "Show the trace of #3" })).toHaveTextContent("Show trace");
    // Several reviewers: Tainted follows the tainted one's badges, so the card says whose; not on its state row.
    const several = cards.find((c) => c.querySelector("[data-reviewer]"))!;
    expect(within(several.querySelector('[data-reviewer="rv_sec"]') as HTMLElement).getByText("Tainted")).toBeInTheDocument();
    expect(within(several).getAllByText("Tainted")).toHaveLength(1);
    // Its trace opens under it.
    await user.click(within(cards[0]!).getByRole("button", { name: "Show the trace of #3" }));
    await waitFor(() => expect(cards[0]!.querySelector("[data-trace]")).not.toBeNull());
    await waitFor(() => expect(RecordingSocket.opened.map((u) => new URL(u).pathname)).toEqual(["/api/agents/agt_rev3/trace"]));
  });

  it("says when there are none yet", async () => {
    renderApp("/projects/prj_one/reviews");
    expect(await screen.findByText("No reviews yet")).toBeInTheDocument();
  });

  it("marks each dimension's verdict by its role and an icon: a failed one danger with a cross", async () => {
    const api = new FakeApi();
    api.reviews = [job(2, { state: "done", verdict: verdict("fail", true), tainted: true })];
    renderApp("/projects/prj_one/reviews", api);
    // The label is the trigger's (it opens the notes); the badge inside it carries the role.
    const failed = await screen.findByLabelText("Quality: failed");
    expect(failed.querySelector(".mantine-Badge-root")!.getAttribute("style")).toContain("--mantine-color-danger-");
    expect(failed.querySelector(".tabler-icon-x")).not.toBeNull();
    for (const name of ["Correctness: passed", "Architectural cohesiveness: passed"]) {
      const passed = screen.getByLabelText(name);
      expect(passed.querySelector(".mantine-Badge-root")!.getAttribute("style")).toContain("--mantine-color-success-");
      expect(passed.querySelector(".tabler-icon-check")).not.toBeNull();
    }
    // Tainted isn't a verdict: the neutral outline.
    const tainted = screen.getByText("Tainted").closest(".mantine-Badge-root")!;
    expect(tainted.getAttribute("style")).toContain("--badge-color: var(--nest-muted)");
    // One reviewer: its badges alone, no reviewer's name over them.
    expect(within(screen.getByRole("table", { name: "Review jobs" })).queryByText("Code review")).toBeNull();
  });

  it("several reviewers: each one's name over its own badges, passed or failed, Tainted after the tainted one's", async () => {
    const api = new FakeApi();
    api.reviews = [
      job(5, { state: "done", verdict: { reviews: [codeReview("pass"), security("fail", true)] }, tainted: true }),
      job(4, { state: "done", verdict: { reviews: [codeReview("pass"), security("pass")] } }),
    ];
    renderApp("/projects/prj_one/reviews", api);
    const table = await screen.findByRole("table", { name: "Review jobs" });
    const [failedRow, passedRow] = within(table).getAllByRole("row").slice(1);
    expect(failedRow!.querySelector("[data-state]")).toHaveTextContent("Changes needed");
    expect(passedRow!.querySelector("[data-state]")).toHaveTextContent("Reviewed");
    const group = (row: HTMLElement, id: string) => row.querySelector(`[data-reviewer="${id}"]`) as HTMLElement;
    const code = group(failedRow!, "code-review");
    const sec = group(failedRow!, "rv_sec");
    // In the reviewers' order, each named once, over its own dimensions only (both have a Quality).
    expect([...failedRow!.querySelectorAll("[data-reviewer]")].map((g) => g.getAttribute("data-reviewer"))).toEqual(["code-review", "rv_sec"]);
    expect(within(code).getByText("Code review")).toBeInTheDocument();
    expect([...code.querySelectorAll("[aria-label][data-verdict]")].map((b) => b.getAttribute("aria-label"))).toEqual(["Code review, Correctness: passed", "Code review, Quality: passed", "Code review, Architectural cohesiveness: passed"]);
    expect(within(sec).getByText("Security")).toBeInTheDocument();
    const secrets = within(sec).getByLabelText("Security, Secrets: failed");
    expect(secrets.querySelector(".mantine-Badge-root")!.getAttribute("style")).toContain("--mantine-color-danger-");
    expect(within(sec).getByLabelText("Security, Quality: passed")).toBeInTheDocument();
    // Tainted after the review whose session was, not the other's.
    expect(within(sec).getByText("Tainted")).toBeInTheDocument();
    expect(within(code).queryByText("Tainted")).toBeNull();
    expect(within(passedRow!).getByLabelText("Security, Secrets: passed")).toBeInTheDocument();
  });
});

describe("the Reviewers section", () => {
  const card = async (name: string) => (await screen.findByRole("heading", { name, level: 4 })).closest("[data-reviewer]") as HTMLElement;

  it("a new project's built-in alone: its dimensions, no Off, no author, no Tainted; how reviewers run, said once; no warning", async () => {
    const api = new FakeApi();
    renderApp("/projects/prj_one/reviews", api);
    const section = await screen.findByRole("region", { name: /^Reviewers/ });
    const code = await card("Code review");
    expect(within(code).getByText("Correctness · Quality · Architectural cohesiveness")).toBeInTheDocument();
    expect(code).not.toHaveTextContent(/Off|By |manager|Tainted/);
    expect(within(code).getByRole("button", { name: "Edit Code review" })).toBeInTheDocument();
    expect(within(section).getAllByText(/one after another/)).toHaveLength(1);
    expect(section).toHaveTextContent("Every reviewer that's on reviews each PR head, one after another; the review check passes only if all of them pass.");
    expect(screen.queryByText("No reviewer is on")).toBeNull();
  });

  it("a manager-written tainted reviewer (its mark explains itself) and one that's off", async () => {
    const api = new FakeApi();
    api.reviewers = [
      reviewer(),
      reviewer({ id: "rvw_sec", name: "Security", dimensions: ["Secrets", "Injection"], source: "manager", tainted: true }),
      reviewer({ id: "rvw_docs", name: "Docs", dimensions: ["Accuracy"], enabled: false }),
    ];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const sec = await card("Security");
    expect(sec).toHaveTextContent("By the manager");
    expect(sec).not.toHaveTextContent(/\bOff\b/);
    const mark = within(sec).getByLabelText(/^Tainted: the reviewer Security — Written by an agent that read untrusted text/);
    await user.hover(mark);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Written by an agent that read untrusted text (an issue, a PR, the web).");
    const docs = await card("Docs");
    expect(within(docs).getByText("Off")).toBeInTheDocument();
    expect(docs).not.toHaveTextContent(/By |Tainted/);
    expect((await card("Code review")).querySelector("[data-slot=status]")).toBeNull();
    // The editor says the tainted one's text is the manager's, and that saving makes it the owner's.
    await user.click(within(sec).getByRole("button", { name: "Edit Security" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit Security" });
    expect(sheet).toHaveTextContent("Its name, instructions or dimensions were last written by the manager, in a session that read untrusted text (an issue, a PR, the web). Check them: saving makes them yours.");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes.find((w) => w.method === "PATCH")).toEqual({ method: "PATCH", path: "/api/projects/prj_one/reviewers/rvw_sec", body: { name: "Security", instructions: expect.any(String), dimensions: ["Secrets", "Injection"], enabled: true } }));
    await waitFor(() => expect(screen.queryByLabelText(/^Tainted: the reviewer Security/)).toBeNull());
  });

  it("none on: a warning in the section, and at the top of the page while reviews are listed above it", async () => {
    const api = new FakeApi();
    api.reviewers = [reviewer({ enabled: false })];
    api.reviews = [job(1, { state: "done", verdict: null })];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const section = await screen.findByRole("region", { name: /^Reviewers/ });
    await within(section).findByText("No reviewer is on");
    expect(section).toHaveTextContent("PRs aren't reviewed, and the required check passes without a review.");
    expect(screen.getAllByText("No reviewer is on")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Go to reviewers" }));
    expect(screen.getByRole("heading", { name: "Reviewers" })).toHaveFocus();
  });

  it("empty: no reviewers says so, with the warning; Add offers the built-in", async () => {
    const api = new FakeApi();
    api.reviewers = [];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    expect(await screen.findByText("No reviewers")).toBeInTheDocument();
    expect(screen.getByText("No reviewer is on")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add reviewer" }));
    await user.click(await screen.findByRole("menuitem", { name: "Code review" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/reviewers", body: { preset: "code" } }));
    expect(await card("Code review")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("No reviewer is on")).toBeNull());
    // With the built-in there, Add opens the editor for a custom one: no menu of one.
    await user.click(screen.getByRole("button", { name: "Add reviewer" }));
    expect(await screen.findByRole("dialog", { name: "New reviewer" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Code review" })).toBeNull();
  });

  it("a custom reviewer: checked with the Worker's schema before it's sent (empty name, duplicate dimension, at most 6), then added", async () => {
    const api = new FakeApi();
    api.reviewers = [];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    await user.click(await screen.findByRole("button", { name: "Add reviewer" }));
    await user.click(await screen.findByRole("menuitem", { name: /Custom reviewer/ }));
    const sheet = await screen.findByRole("dialog", { name: "New reviewer" });
    await user.type(within(sheet).getByRole("textbox", { name: "Instructions" }), "Look for leaked secrets.");
    await user.type(within(sheet).getByRole("textbox", { name: "Dimension 1" }), "Secrets");
    await user.click(within(sheet).getByRole("button", { name: "Add dimension" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Dimension 2" }), " secrets ");
    await user.click(within(sheet).getByRole("button", { name: "Add reviewer" }));
    await waitFor(() => expect(within(sheet).getByRole("textbox", { name: "Name" })).toHaveAttribute("aria-invalid", "true"));
    expect(within(sheet).getByRole("textbox", { name: "Dimension 1" })).not.toHaveAttribute("aria-invalid", "true");
    expect(within(sheet).getByRole("textbox", { name: "Dimension 2" })).toHaveAccessibleDescription(/is there twice/);
    expect(api.writes).toEqual([]);
    await user.type(within(sheet).getByRole("textbox", { name: "Name" }), "Security");
    await user.clear(within(sheet).getByRole("textbox", { name: "Dimension 2" }));
    await user.type(within(sheet).getByRole("textbox", { name: "Dimension 2" }), "Injection");
    // Up to six: then Add dimension is off and says why; a removed one makes room again.
    // A new dimension takes focus, so it's typed into straight away.
    for (let i = 3; i <= 6; i++) {
      await user.click(within(sheet).getByRole("button", { name: "Add dimension" }));
      expect(within(sheet).getByRole("textbox", { name: `Dimension ${i}` })).toHaveFocus();
      await user.keyboard(`D${i}`);
    }
    expect(within(sheet).getByRole("button", { name: "Add dimension" })).toBeDisabled();
    expect(sheet).toHaveTextContent("At most 6: remove one to add another.");
    await user.click(within(sheet).getByRole("button", { name: "Remove dimension 6 (D6)" }));
    expect(within(sheet).getByRole("button", { name: "Add dimension" })).toBeEnabled();
    await user.click(within(sheet).getByRole("button", { name: "Remove dimension 5 (D5)" }));
    await user.click(within(sheet).getByRole("button", { name: "Remove dimension 3 (D3)" }));
    // Focus goes to the one that took its place, not the page.
    expect(within(sheet).getByRole("textbox", { name: "Dimension 3" })).toHaveFocus();
    expect(within(sheet).getByRole("textbox", { name: "Dimension 3" })).toHaveValue("D4");
    await user.click(within(sheet).getByRole("button", { name: "Add reviewer" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/reviewers", body: { name: "Security", instructions: "Look for leaked secrets.", dimensions: ["Secrets", "Injection", "D4"], enabled: true } }]));
    expect(await card("Security")).toHaveTextContent("Secrets · Injection · D4");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New reviewer" })).toBeNull());
  });

  it("the Worker's refusal is shown in the form; the list follows the manager's changes without a reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = new FakeApi();
      const { user } = renderApp("/projects/prj_one/reviews", api);
      await user.click(await screen.findByRole("button", { name: "Edit Code review" }));
      const sheet = await screen.findByRole("dialog", { name: "Edit Code review" });
      api.fail(/PATCH .*\/reviewers\/code-review/, 400, "dimensions: dimension names must differ");
      await user.click(within(sheet).getByRole("button", { name: "Save" }));
      expect(await within(sheet).findByRole("alert")).toHaveTextContent("dimension names must differ");
      // The manager adds a reviewer of its own; the next poll shows it.
      api.reviewers = [...api.reviewers, reviewer({ id: "rvw_m", name: "Licences", dimensions: ["Licences"], source: "manager" })];
      await vi.advanceTimersByTimeAsync(16_000);
      expect(await card("Licences")).toHaveTextContent("By the manager");
    } finally {
      vi.useRealTimers();
    }
  });

  it("Delete is last in the editor, confirmed, Keep it the default; the only one on says what deleting it means", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/reviews", api);
    await user.click(await screen.findByRole("button", { name: "Edit Code review" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit Code review" });
    const buttons = within(sheet).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.at(-1)).toBe("Delete reviewer");
    await user.click(within(sheet).getByRole("button", { name: "Delete reviewer" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete Code review?" });
    expect(confirm).toHaveTextContent("It's the only reviewer on: without it, PRs aren't reviewed, and the required check passes without a review.");
    expect(within(confirm).getByRole("button", { name: "Keep it" })).toHaveFocus();
    await user.click(within(confirm).getByRole("button", { name: "Keep it" }));
    expect(api.writes).toEqual([]);
    await user.click(within(sheet).getByRole("button", { name: "Delete reviewer" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Delete Code review?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "DELETE", path: "/api/projects/prj_one/reviewers/code-review", body: undefined }]));
    expect(await screen.findByText("No reviewers")).toBeInTheDocument();
    // Its card and Edit are gone: focus is on the section's heading.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Reviewers" })).toHaveFocus());
  });

  it("at the limit, Add reviewer is off and says why", async () => {
    const api = new FakeApi();
    api.reviewers = Array.from({ length: 8 }, (_, i) => reviewer({ id: `rvw_${i}`, name: `Reviewer ${i}`, dimensions: ["Quality"] }));
    renderApp("/projects/prj_one/reviews", api);
    await card("Reviewer 7");
    const add = screen.getByRole("button", { name: "Add reviewer" });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription("A project holds at most 8 reviewers: delete one to add another.");
  });

  it("loading and error, as the Routines page has them", async () => {
    const api = new FakeApi();
    let answer = () => {};
    api.holds.push({ match: /GET .*\/reviewers$/, until: new Promise<void>((r) => (answer = r)) });
    api.fail(/GET .*\/reviewers$/, 500, "ReviewDO is down");
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const section = await screen.findByRole("region", { name: /^Reviewers/ });
    expect(await within(section).findByText("Loading the reviewers")).toBeInTheDocument();
    api.holds.length = 0;
    answer();
    expect(await within(section).findByText("The reviewers couldn't be loaded")).toBeInTheDocument();
    expect(within(section).queryByText("No reviewer is on")).toBeNull();
    await user.click(within(section).getByRole("button", { name: /Retry|Try again/ }));
    expect(await card("Code review")).toBeInTheDocument();
  });
});
