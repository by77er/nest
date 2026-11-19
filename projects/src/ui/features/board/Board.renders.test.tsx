// How much of the board a change re-renders, with a board of 300 tasks (most of them done, as a real
// project's is). A row renders when it's mounted and when its own task, its asks or its group's shape
// change; never because another task changed, a poll brought nothing new, another group was collapsed,
// cancelled tasks were shown, or a row of another group was picked up. Each row's renders are counted
// at the row's layout primitive (`TaskRow`), which renders exactly when the board's row does.
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "../../api/queries";
import type { Task, TaskState } from "../../api/types";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("../../layout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../layout")>();
  const Row = mod.TaskRow;
  return {
    ...mod,
    TaskRow: (p: Parameters<typeof Row>[0]) => {
      renders.set(p.id, (renders.get(p.id) ?? 0) + 1);
      return <Row {...p} />;
    },
  };
});

const total = () => [...renders.values()].reduce((a, b) => a + b, 0);
/** The rows rendered since the last reset, by task id. */
const rendered = () => Object.fromEntries([...renders.entries()].filter(([, n]) => n > 0));
const reset = () => renders.clear();
/** Rows of the board rendered outside these tasks. */
const others = (except: Set<string>) => [...renders.entries()].filter(([id, n]) => n > 0 && !except.has(id)).length;

/** A project's board: 300 tasks across the stages, most of them done, 10 cancelled. */
function board(): Task[] {
  const mix: [TaskState, number][] = [["draft", 15], ["ready", 15], ["assigned", 5], ["in_progress", 20], ["in_review", 15], ["stalled", 5], ["done", 215], ["cancelled", 10]];
  const tasks: Task[] = [];
  for (const [state, n] of mix) for (let i = 0; i < n; i++) tasks.push(task({ title: `${state} ${i}`, state, ord: tasks.length + 1, updated_ms: Date.now() - (tasks.length + 1) * 60_000 }));
  return tasks;
}

const ids = (tasks: Task[], states: TaskState[]) => new Set(tasks.filter((t) => states.includes(t.state)).map((t) => t.id));

/** Measured numbers, printed for the PR (rows rendered and the step's wall time). */
function report(step: string, started: number) {
  console.info(`RENDERS ${step}: ${total()} rows in ${Math.round(performance.now() - started)} ms`);
}

async function mount(api: FakeApi) {
  const started = performance.now();
  const view = renderApp("/projects/prj_one/board", api);
  await screen.findByRole("article", { name: "done 214" }, { timeout: 10_000 });
  // The asks' first read lands too, so later counts start from a settled board.
  await waitFor(() => expect(api.reads).toContain("/api/projects/prj_one/attention"));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  report("mount", started);
  return view;
}

/** One poll of the tasks, as the 5 s interval makes it. */
async function poll(view: Awaited<ReturnType<typeof mount>>, key: readonly unknown[]) {
  await act(() => view.queryClient.refetchQueries({ queryKey: key, exact: true }));
  // TanStack Query tells its observers on the next tick: let them render.
  await act(() => new Promise((r) => setTimeout(r, 10)));
}

beforeEach(() => {
  window.localStorage.clear();
  reset();
});
afterEach(() => vi.restoreAllMocks());

describe("the board's renders, with 300 tasks", () => {
  it("mounts each shown row once; a poll that changed one task re-renders that row alone; an equal poll none", async () => {
    const api = new FakeApi();
    api.tasks = board();
    const view = await mount(api);
    // Cancelled tasks aren't shown.
    expect(Object.keys(rendered())).toHaveLength(290);
    expect(total()).toBe(290);

    reset();
    let started = performance.now();
    await poll(view, keys.tasks("prj_one"));
    report("equal poll", started);
    expect(rendered()).toEqual({});

    const i = api.tasks.findIndex((t) => t.title === "done 100");
    const changed = { ...api.tasks[i]!, title: "done 100, renamed", updated_ms: Date.now() };
    api.tasks = api.tasks.map((t, j) => (j === i ? changed : t));
    reset();
    started = performance.now();
    await poll(view, keys.tasks("prj_one"));
    report("one-task-changed poll", started);
    expect(await screen.findByRole("article", { name: "done 100, renamed" })).toBeInTheDocument();
    expect(rendered()).toEqual({ [changed.id]: 1 });
  }, 60_000);

  it("a task that moves to another group renders its own row alone, both groups' counts following", async () => {
    const api = new FakeApi();
    api.tasks = board();
    const view = await mount(api);
    const i = api.tasks.findIndex((t) => t.title === "ready 3");
    const moved = { ...api.tasks[i]!, state: "in_progress" as const, updated_ms: Date.now() };
    api.tasks = api.tasks.map((t, j) => (j === i ? moved : t));
    reset();
    await poll(view, keys.tasks("prj_one"));
    const group = screen.getByRole("region", { name: "In progress" });
    expect(await within(group).findByRole("article", { name: "ready 3" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Ready" })).getByLabelText("14 tasks")).toBeInTheDocument();
    expect(within(group).getByLabelText("26 tasks")).toBeInTheDocument();
    expect(rendered()).toEqual({ [moved.id]: 1 });
  }, 60_000);

  it("collapsing a group, or showing cancelled tasks, renders no row of another group", async () => {
    const api = new FakeApi();
    api.tasks = board();
    const view = await mount(api);
    reset();
    let started = performance.now();
    await view.user.click(within(screen.getByRole("region", { name: "Ready" })).getByRole("button", { name: /Ready/ }));
    report("collapse", started);
    expect(screen.queryByRole("article", { name: "ready 0" })).toBeNull();
    expect(total()).toBe(0);

    // Opening it again mounts its rows, and only those.
    await view.user.click(within(screen.getByRole("region", { name: "Ready" })).getByRole("button", { name: /Ready/ }));
    expect(await screen.findByRole("article", { name: "ready 0" })).toBeInTheDocument();
    expect(others(ids(api.tasks, ["ready"]))).toBe(0);

    reset();
    started = performance.now();
    await view.user.click(screen.getByRole("switch", { name: "Show cancelled" }));
    expect(await screen.findByRole("article", { name: "cancelled 0" })).toBeInTheDocument();
    report("show cancelled", started);
    expect(others(ids(api.tasks, ["cancelled"]))).toBe(0);
    expect(total()).toBe(10);

    reset();
    await view.user.click(screen.getByRole("switch", { name: "Show cancelled" }));
    await waitFor(() => expect(screen.queryByRole("article", { name: "cancelled 0" })).toBeNull());
    expect(total()).toBe(0);
  }, 60_000);

  it("an asks poll re-renders only the row whose asks changed; an unchanged one none", async () => {
    const api = new FakeApi();
    api.tasks = board();
    const view = await mount(api);
    reset();
    let started = performance.now();
    await poll(view, keys.attention("prj_one"));
    report("equal asks poll", started);
    expect(total()).toBe(0);

    const asked = api.tasks.find((t) => t.title === "in_progress 4")!;
    api.asks = [ask({ task: asked.id, question: "May I?" })];
    started = performance.now();
    await poll(view, keys.attention("prj_one"));
    report("asks poll", started);
    expect(await within(screen.getByRole("article", { name: "in_progress 4" })).findByText("Needs input")).toBeInTheDocument();
    expect(rendered()).toEqual({ [asked.id]: 1 });
  }, 60_000);

  it("picking a row up and putting it back renders no row of another group, and the board's poll pauses meanwhile", async () => {
    const api = new FakeApi();
    api.tasks = board();
    const view = await mount(api);
    const grip = screen.getByRole("button", { name: "Move ready 0" });
    reset();
    const started = performance.now();
    act(() => grip.focus());
    await view.user.keyboard("[Space]");
    await waitFor(() => expect(grip).toHaveAttribute("data-dragging"));
    // While dragging, the board's query doesn't poll.
    const observer = view.queryClient.getQueryCache().find({ queryKey: keys.tasks("prj_one"), exact: true })!;
    expect(observer.observers.some((o) => o.options.refetchInterval === false)).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 20)));
    await view.user.keyboard("[Escape]");
    await waitFor(() => expect(grip).not.toHaveAttribute("data-dragging"));
    report("drag start and end", started);
    expect(others(ids(api.tasks, ["ready"]))).toBe(0);
    expect(api.writes).toEqual([]);
  }, 60_000);

  it("a row's \"updated\" stays current while the row itself isn't rendered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const api = new FakeApi();
      api.tasks = [task({ title: "Quiet", state: "ready", updated_ms: Date.now() - 10_000 })];
      renderApp("/projects/prj_one/board", api);
      const row = await screen.findByRole("article", { name: "Quiet" });
      expect(within(row).getByText("just now")).toBeInTheDocument();
      reset();
      // Three minutes on, with the board's poll bringing nothing new: the row isn't rendered, its time is.
      await act(async () => vi.advanceTimersByTime(3 * 60_000));
      expect(await within(row).findByText("3 minutes ago")).toBeInTheDocument();
      expect(total()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 60_000);
});
