// The Reviews page: ReviewDO's jobs, newest first, each state in its role (a done job by its verdict),
// and a job's reviewer's live trace, one open at a time.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job, Review, Verdict } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
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
    api.reviews = [job(1, { state: "done", verdict: verdict("fail"), runs: 2, tainted: true }), job(3, { state: "running", agent: "agt_rev3" })];
    const { user } = renderApp("/projects/prj_one/reviews", api);
    const list = await screen.findByRole("list", { name: "Review jobs" });
    expect(screen.queryByRole("table")).toBeNull();
    const cards = within(list).getAllByRole("listitem");
    expect(cards.map((c) => within(c).getAllByRole("link")[0]!.textContent)).toEqual(["#3 PR 3", "#1 PR 1"]);
    const done = cards[1]!;
    // Everything the table's row has, in one column: the sha, the verdicts, the runs and when.
    expect(done).toHaveTextContent("1000000 → main");
    expect(within(done).getByLabelText("Quality: failed")).toBeInTheDocument();
    expect(done).toHaveTextContent("2 runs");
    // Tainted sits on its state row, beside the state, not after the verdicts.
    const stateRow = within(done).getByText("Tainted").parentElement!.parentElement!;
    expect(stateRow).toHaveTextContent(/Changes needed\s*Tainted/);
    expect(within(cards[0]!).getByRole("button", { name: "Show the trace of #3" })).toHaveTextContent("Show trace");
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
    expect(screen.queryByText("Code review")).toBeNull();
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
