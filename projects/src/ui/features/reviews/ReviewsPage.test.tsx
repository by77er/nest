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

  it("says when there are none yet", async () => {
    renderApp("/projects/prj_one/reviews");
    expect(await screen.findByText("No reviews yet")).toBeInTheDocument();
  });
});
