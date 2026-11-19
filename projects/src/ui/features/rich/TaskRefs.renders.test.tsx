// How much of a message a board poll re-renders: a task's chips and cards follow their own task only. A
// chat log holds many chips; a poll that changed one task must not re-render every chip and card in it.
// Chips are counted at their link (`TaskChipLink`), cards at their frame (`TaskRefCard`), each rendered
// exactly when its chip or card is.
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keys } from "../../api/queries";
import { createQueryClient } from "../../api/queryClient";
import type { Task } from "../../api/types";
import { ask, FakeApi, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { cssVariablesResolver, theme } from "../../theme";
import { RichMessage } from "./RichMessage";

const chips = vi.hoisted(() => new Map<string, number>());
const cards = vi.hoisted(() => new Map<string, number>());
/** A tasks block's renders (its cards' frame, `TaskCards`), by the ids it shows. */
const blocks = vi.hoisted(() => new Map<string, number>());
const count = (m: Map<string, number>, id: string | undefined) => m.set(String(id), (m.get(String(id)) ?? 0) + 1);
vi.mock("../../common/links", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../common/links")>();
  const Link = mod.TaskChipLink;
  return { ...mod, TaskChipLink: ((p: Parameters<typeof Link>[0] & { "data-task-ref"?: string }) => (count(chips, p["data-task-ref"]), <Link {...p} />)) as typeof Link };
});
vi.mock("../../layout", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../layout")>();
  const Card = mod.TaskRefCard;
  const Cards = mod.TaskCards;
  return {
    ...mod,
    TaskRefCard: (p: Parameters<typeof Card>[0]) => (count(cards, p["data-task-ref"]), <Card {...p} />),
    TaskCards: (p: Parameters<typeof Cards>[0]) => (count(blocks, "block"), <Cards {...p} />),
  };
});

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const fence = "```";

/** Ten tasks, each referenced three times in the text, and three of them as cards in a tasks block. */
async function show() {
  const api = new FakeApi();
  api.tasks = Array.from({ length: 10 }, (_, i) => task({ title: `Task number ${i}`, state: "in_progress", pr: 100 + i }));
  vi.stubGlobal("fetch", api.fetch);
  const refs = [0, 1, 2].map(() => api.tasks.map((t) => `task:${t.id}`).join(" and ")).join("\n\n");
  const text = `${refs}\n\n${fence}tasks\n${api.tasks.slice(0, 3).map((t) => `${t.id} — a note`).join("\n")}\n${fence}`;
  const qc = createQueryClient();
  const root = createRootRoute({ component: () => <RichMessage text={text} projectId="prj_one" /> });
  const router = createRouter({ routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/projects/$projectId/board" })]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole("link", { name: "Task Task number 9" })).toHaveLength(3));
  await waitFor(() => expect(document.querySelectorAll("[data-ds=task-card]")).toHaveLength(3));
  // Every read the cards make (asks, reviews, the project) lands first.
  await waitFor(() => expect(api.reads).toEqual(expect.arrayContaining(["/api/projects/prj_one/attention", "/api/projects/prj_one/reviews", "/api/projects/prj_one"])));
  await settle();
  return { api, qc };
}

async function settle() {
  // TanStack Query tells its observers on the next tick: let them render.
  await act(() => new Promise((r) => setTimeout(r, 10)));
}

async function poll(qc: ReturnType<typeof createQueryClient>, key: readonly unknown[]) {
  await act(() => qc.refetchQueries({ queryKey: key, exact: true }));
  await settle();
}

/** Measured numbers for the PR, printed with NEST_RENDERS_REPORT=1. */
function report(step: string, started: number) {
  if (process.env.NEST_RENDERS_REPORT) console.info(`RENDERS ${step}: ${total(chips)} chips, ${total(cards)} cards in ${Math.round(performance.now() - started)} ms`);
}

beforeEach(() => {
  chips.clear();
  cards.clear();
  blocks.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("task chips and cards in a message", () => {
  it("with 30 chips of 10 tasks, a poll that changed one task re-renders that task's chips and card alone; an equal poll nothing", async () => {
    const started = performance.now();
    const { api, qc } = await show();
    report("mount", started);
    expect(total(chips)).toBeGreaterThanOrEqual(30);

    chips.clear();
    cards.clear();
    let at = performance.now();
    await poll(qc, keys.tasks("prj_one"));
    report("equal poll", at);
    expect(total(chips) + total(cards)).toBe(0);

    const changed: Task = { ...api.tasks[1]!, title: "Renamed", updated_ms: Date.now() };
    api.tasks = api.tasks.map((t) => (t.id === changed.id ? changed : t));
    at = performance.now();
    await poll(qc, keys.tasks("prj_one"));
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Task Renamed" })).toHaveLength(3));
    report("one-task-changed poll", at);
    expect(Object.fromEntries(chips)).toEqual({ [changed.id]: 3 });
    expect(Object.fromEntries(cards)).toEqual({ [changed.id]: 1 });
  }, 60_000);

  it("an asks poll re-renders only the card whose task's asks changed, and no chip", async () => {
    const { api, qc } = await show();
    chips.clear();
    cards.clear();
    const asked = api.tasks[2]!;
    api.asks = [ask({ task: asked.id, question: "May I?" })];
    const at = performance.now();
    await poll(qc, keys.attention("prj_one"));
    await waitFor(() => expect(document.querySelector(`[data-task-ref="${asked.id}"] [data-marker=ask]`)).not.toBeNull());
    report("asks poll", at);
    expect(total(chips)).toBe(0);
    expect(Object.fromEntries(cards)).toEqual({ [asked.id]: 1 });
  }, 60_000);

  it("the Manager's side panel re-renders a card only when its own task changes", async () => {
    const api = new FakeApi();
    const states = ["in_progress", "in_review", "assigned", "stalled", "in_progress", "in_progress", "done", "done", "ready", "draft"] as const;
    api.tasks = Array.from({ length: 300 }, (_, i) => task({ title: `Task ${i}`, state: states[i % states.length], updated_ms: Date.now() - i * 60_000 }));
    const view = renderApp("/projects/prj_one/manager", api);
    await view.user.click(await screen.findByRole("button", { name: "About the manager" }));
    const context = document.querySelector("[data-slot=manager-context]") as HTMLElement;
    const panel = (await within(context).findByRole("heading", { name: "Working on" })).closest("[data-ds=section]") as HTMLElement;
    await waitFor(() => expect(panel.querySelectorAll("[data-ds=task-card]")).toHaveLength(5));
    await settle();
    // A task not under way changes: nothing in the panel renders, not even the cards' block.
    const done = api.tasks.find((t) => t.state === "done")!;
    api.tasks = api.tasks.map((t) => (t === done ? { ...t, title: "Done, renamed" } : t));
    cards.clear();
    blocks.clear();
    let at = performance.now();
    await poll(view.queryClient, keys.tasks("prj_one"));
    report("manager panel, another task's poll", at);
    expect(total(cards)).toBe(0);
    expect(total(blocks)).toBe(0);
    // A shown task's title changes (not its place): its card alone.
    const shown = api.tasks[1]!;
    api.tasks = api.tasks.map((t) => (t === shown ? { ...t, title: "Shown, renamed" } : t));
    at = performance.now();
    await poll(view.queryClient, keys.tasks("prj_one"));
    await waitFor(() => expect(panel).toHaveTextContent("Shown, renamed"));
    report("manager panel, its task's poll", at);
    expect(Object.fromEntries(cards)).toEqual({ [shown.id]: 1 });
  }, 60_000);
});
