// The Routines page (README.md#routines): routines with their triggers and where they stand, presets added
// in one click, Run now, the editor (checked by the Worker's schema), the proposed tasks waiting for the
// owner (their text never rendered as markup), the runs with their report and trace, and the memory.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createdText, routineStatus, runStatus, timerText, triggerPhrases } from "./describe";
import { FakeApi, routine, run } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { RecordingSocket } from "../../test/sockets";

describe("routines in words (pure)", () => {
  it("timers and triggers", () => {
    expect(timerText({ kind: "interval", minutes: 15 })).toBe("Every 15 minutes");
    expect(timerText({ kind: "interval", minutes: 120 })).toBe("Every 2 hours");
    expect(timerText({ kind: "daily", time: "03:00", tz: "America/New_York" })).toBe("Daily at 03:00 (America/New York)");
    expect(timerText({ kind: "weekly", day: 1, time: "09:00", tz: "UTC" })).toBe("Mondays at 09:00 (UTC)");
    expect(triggerPhrases({ timer: null, tasks_done: 1, prs_merged: 5 })).toEqual(["Every 5 task PRs merged", "Every 1 task done"]);
    expect(triggerPhrases({ timer: null, tasks_done: null, prs_merged: null })).toEqual(["Only when run by hand"]);
  });

  it("where a routine stands: its live run first, then why it waits, then off", () => {
    const base = { enabled: true, live_run: null, due: null, waiting: null } as const;
    expect(routineStatus(base)).toBeNull();
    expect(routineStatus({ ...base, enabled: false })).toEqual({ label: "Off", color: "gray" });
    expect(routineStatus({ ...base, due: { trigger: "timer", at_ms: 1 }, waiting: "cap" })?.label).toBe("Queued");
    expect(routineStatus({ ...base, due: { trigger: "timer", at_ms: 1 }, waiting: "cooldown" })?.label).toBe("Cooling down");
    expect(routineStatus({ ...base, enabled: false, live_run: run({ state: "running", outcome: null }) })).toEqual({ label: "Running", color: "primary" });
  });

  it("a run's outcome in its role, and what it made", () => {
    expect(runStatus({ state: "ended", outcome: "done" })).toEqual({ label: "Done", color: "success" });
    expect(runStatus({ state: "ended", outcome: "failed" }).color).toBe("danger");
    expect(runStatus({ state: "ended", outcome: "timed_out" }).color).toBe("warning");
    expect(createdText([{ kind: "proposal", id: "prp_1", title: "a" }, { kind: "proposal", id: "prp_2", title: "b" }, { kind: "memory_write", key: "k" }])).toBe("2 proposed tasks, 1 note written");
    expect(createdText([])).toBe("Nothing");
  });
});

describe("the Routines page", () => {
  it("shows each routine's triggers and state; a preset is added in one click, and only once", async () => {
    const api = new FakeApi();
    api.routines = [routine({ name: "Spontaneous review", preset: "review", triggers: { timer: null, tasks_done: null, prs_merged: 5 }, counts: { tasks_done: 0, prs_merged: 3 }, due: { trigger: "prs_merged", at_ms: 1 }, waiting: "cap" })];
    const { user } = renderApp("/projects/prj_one/routines", api);
    const card = await screen.findByText("Spontaneous review").then((h) => h.closest("[data-routine]") as HTMLElement);
    expect(card).toHaveTextContent("Every 5 task PRs merged");
    expect(card).toHaveTextContent("3 of 5 PRs merged");
    expect(within(card).getByText("Queued")).toBeInTheDocument();
    expect(card).toHaveTextContent("Waiting for a free place");
    await user.click(screen.getByRole("button", { name: "Add routine" }));
    expect(await screen.findByRole("menuitem", { name: /Spontaneous review \(added\)/ })).toBeDisabled();
    await user.click(screen.getByRole("menuitem", { name: "Dreaming" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/routines", body: { preset: "dreaming" } }));
    expect(await screen.findByText("Dreaming")).toBeInTheDocument();
  });

  it("Run now starts a run, and can't while one is going", async () => {
    const api = new FakeApi();
    api.routines = [routine({ id: "rtn_a", name: "A" })];
    const { user } = renderApp("/projects/prj_one/routines", api);
    await user.click(await screen.findByRole("button", { name: "Run A now" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/routines/rtn_a/run", body: undefined }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Run A now" })).toBeDisabled());
  });

  it("edits a routine's triggers; an interval under 15 minutes is refused before it's sent", async () => {
    const api = new FakeApi();
    api.routines = [routine({ id: "rtn_a", name: "A" })];
    const { user } = renderApp("/projects/prj_one/routines", api);
    await user.click(await screen.findByRole("button", { name: "Edit A" }));
    const sheet = await screen.findByRole("dialog", { name: "Edit A" });
    await user.click(within(sheet).getAllByLabelText("Timer").find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!);
    await user.click(await screen.findByRole("option", { name: "Every few minutes or hours" }));
    const every = within(sheet).getByRole("textbox", { name: "Every (minutes)" });
    await user.clear(every);
    await user.type(every, "10");
    await user.type(within(sheet).getByRole("textbox", { name: "After tasks done" }), "4");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    expect(await within(sheet).findByText("At least 15 minutes")).toBeInTheDocument();
    expect(api.writes.filter((w) => w.method === "PATCH")).toEqual([]);
    await user.clear(every);
    await user.type(every, "90");
    await user.click(within(sheet).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.writes.find((w) => w.method === "PATCH")?.body).toMatchObject({ triggers: { timer: { kind: "interval", minutes: 90 }, tasks_done: 4, prs_merged: null } }));
  });

  it("a proposed task's text is plain text; Accept makes it a draft, Decline drops it", async () => {
    const api = new FakeApi();
    api.proposals = [
      { id: "prp_a", routine: "rtn_a", routine_name: "Spontaneous review", run: "run_a", title: "Fix the race", body: "<b>bold</b> and [a link](javascript:alert(1))", state: "untriaged", task: null, reason: null, created_ms: 1 },
      { id: "prp_b", routine: "rtn_a", routine_name: "Spontaneous review", run: "run_a", title: "Meh", body: "", state: "untriaged", task: null, reason: null, created_ms: 2 },
    ];
    const { user } = renderApp("/projects/prj_one/routines", api);
    const card = await screen.findByText("Fix the race").then((h) => h.closest("[data-proposal]") as HTMLElement);
    expect(card).toHaveTextContent("<b>bold</b> and [a link](javascript:alert(1))");
    expect(card.querySelector("b, a")).toBeNull();
    // Marked as from an untrusted source, with its routine and run.
    expect(within(card).getByLabelText(/is from an untrusted source/)).toHaveTextContent("Untrusted source");
    expect(card).toHaveTextContent("From the routine Spontaneous review (run run_a)");
    await user.click(within(card).getByRole("button", { name: "Accept as draft" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/proposals/prp_a/accept", body: undefined }));
    const other = (await screen.findByText("Meh")).closest("[data-proposal]") as HTMLElement;
    await user.click(within(other).getByRole("button", { name: "Decline" }));
    const confirm = await screen.findByRole("dialog", { name: "Decline “Meh”?" });
    await user.type(within(confirm).getByRole("textbox", { name: "Reason" }), "not now");
    await user.click(within(confirm).getByRole("button", { name: "Decline" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "POST", path: "/api/projects/prj_one/proposals/prp_b/decline", body: { reason: "not now" } }));
    await waitFor(() => expect(screen.queryByText("Fix the race")).toBeNull());
  });

  it("a run opens to its report, what it made, and its agent's trace", async () => {
    RecordingSocket.opened = [];
    vi.stubGlobal("WebSocket", RecordingSocket);
    const api = new FakeApi();
    api.routines = [routine({ id: "rtn_a", name: "Dreaming" })];
    api.runs = [run({ routine: "rtn_a", n: 2, agent: "agt_dream", summary: "Merged 3 notes.", created: [{ kind: "memory_write", key: "conventions-testing" }] })];
    const { user } = renderApp("/projects/prj_one/routines", api);
    const table = await screen.findByRole("table", { name: "Routine runs" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("Done");
    await user.click(within(table).getByRole("button", { name: "Show run 2 of Dreaming" }));
    expect(await screen.findByText("Merged 3 notes.")).toBeInTheDocument();
    expect(screen.getByText("Wrote conventions-testing")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Dreaming, run 2" })).toBeInTheDocument();
    await waitFor(() => expect(RecordingSocket.opened.map((u) => new URL(u).pathname)).toEqual(["/api/agents/agt_dream/trace"]));
  });

  it("a memory note shows who wrote it, an untrusted one marked; it's deleted only after confirming", async () => {
    const api = new FakeApi();
    api.notes = [
      { key: "owner-prefers-small-prs", text: "Keep PRs small.", source: "manager", tainted: false, created_ms: 1, updated_ms: 1 },
      { key: "pr-size", text: "Under 300 lines.", source: "routine:Dreaming (run_d1)", tainted: true, created_ms: 1, updated_ms: 1 },
    ];
    const { user } = renderApp("/projects/prj_one/routines", api);
    const clean = (await screen.findByText("Keep PRs small.")).closest("[data-note]") as HTMLElement;
    const tainted = screen.getByText("Under 300 lines.").closest("[data-note]") as HTMLElement;
    expect(clean).toHaveTextContent("By the manager");
    expect(clean.querySelector("[data-marker=untrusted]")).toBeNull();
    expect(tainted).toHaveTextContent("By the routine Dreaming (run run_d1)");
    expect(within(tainted).getByLabelText(/The note pr-size is from an untrusted source/)).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Delete the note owner-prefers-small-prs" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete the note owner-prefers-small-prs?" });
    expect(api.writes).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.writes).toContainEqual({ method: "DELETE", path: "/api/projects/prj_one/memory/owner-prefers-small-prs", body: undefined }));
  });
});
