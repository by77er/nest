// The Reviews page: ReviewDO's jobs, newest first, each state in its role (a done job by its verdict),
// and a job's reviewer's live trace, one open at a time.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Job, Verdict } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { RecordingSocket } from "../../test/sockets";

const verdict = (quality: "pass" | "fail"): Verdict => ({
  correctness: { verdict: "pass", notes: "ok" }, quality: { verdict: quality, notes: "q" }, architecture: { verdict: "pass", notes: "a" }, summary: "s",
});
const job = (pr: number, o: Partial<Job> = {}): Job => ({
  pr, sha: `${pr}`.padEnd(40, "0"), state: "queued", title: `PR ${pr}`, base: "main", agent: null, check_run: null, verdict: null, tainted: null,
  attempts: 0, runs: 1, error: null, created_ms: pr, updated_ms: pr, ...o,
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
    api.reviews = [job(2, { state: "done", verdict: verdict("fail"), tainted: true })];
    renderApp("/projects/prj_one/reviews", api);
    // The label is the trigger's (it opens the notes); the badge inside it carries the role.
    const failed = await screen.findByLabelText("Quality: failed");
    expect(failed.querySelector(".mantine-Badge-root")!.getAttribute("style")).toContain("--mantine-color-danger-");
    expect(failed.querySelector(".tabler-icon-x")).not.toBeNull();
    for (const name of ["Correctness: passed", "Architecture: passed"]) {
      const passed = screen.getByLabelText(name);
      expect(passed.querySelector(".mantine-Badge-root")!.getAttribute("style")).toContain("--mantine-color-success-");
      expect(passed.querySelector(".tabler-icon-check")).not.toBeNull();
    }
    // Tainted isn't a verdict: the neutral outline.
    const tainted = screen.getByText("Tainted").closest(".mantine-Badge-root")!;
    expect(tainted.getAttribute("style")).toContain("--badge-color: var(--nest-muted)");
  });
});
