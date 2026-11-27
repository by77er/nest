// Each route starts its page's first reads when it matches (or a link to it is hovered), in parallel with
// the page's chunk and the project (router.tsx): the reads, before either answers; each asked for once,
// the page's hook taking the prefetch's answer; a preload that polls nothing; an unknown project's reads
// failing quietly; and the conditional GETs (client.ts) carrying on after a prefetch.
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { keys, POLL, useReviews, useTasks } from "./api/queries";
import { createQueryClient } from "./api/queryClient";
import { createAppRouter } from "./router";
import { FakeApi, task } from "./test/fakeApi";
import { renderApp } from "./test/render";
import { RecordingSocket } from "./test/sockets";

const { chunks, deferred } = vi.hoisted(() => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };
  /** Each page's chunk as the router loads it, by its component's name, held until the test lets it load. */
  const chunks = new Map<string, ReturnType<typeof deferred>>();
  return { chunks, deferred };
});
const chunk = (page: string) => chunks.get(page) ?? chunks.set(page, deferred()).get(page)!;

vi.mock("@tanstack/react-router", async (original) => {
  const router = await original<typeof import("@tanstack/react-router")>();
  return {
    ...router,
    lazyRouteComponent: ((load: () => Promise<Record<string, unknown>>, name: string) =>
      router.lazyRouteComponent(async () => {
        await (chunks.get(name) ?? chunks.set(name, deferred()).get(name)!).promise;
        return load();
      }, name)) as typeof router.lazyRouteComponent,
  };
});
const loadChunks = () => ["ProjectsPage", "BoardPage", "ManagerPage", "ReviewsPage", "RoutinesPage", "SettingsPage", "NetworkPage", "TriagePage", "SecretsPage", "AdminPage"].forEach((p) => chunk(p).resolve());

// The pages' modules, transformed once up front: what the gate holds is the router's load, and a cold
// transform's seconds don't count against the reads' staleTime.
beforeAll(async () => {
  await Promise.all([
    import("./features/projects/ProjectsPage"), import("./features/project/BoardPage"), import("./features/manager/ManagerPage"), import("./features/reviews/ReviewsPage"),
    import("./features/routines/RoutinesPage"), import("./features/settings/SettingsPage"), import("./features/network/NetworkPage"), import("./features/triage/TriagePage"),
    import("./features/secrets/SecretsPage"), import("./features/admin/AdminPage"),
  ]);
}, 60_000);

afterEach(() => {
  vi.useRealTimers();
});

const P = "/api/projects/prj_one";

/** Each route, and the reads its page shows first (beside the shell's projects list, the project, and the chat its sidebar's unread dot reads). */
const ROUTES: [string, string, string[]][] = [
  ["board?task=tsk_t1", "BoardPage", [`${P}/chat`, `${P}/tasks`, `${P}/attention`, `${P}/tasks/tsk_t1`, `${P}/reviews`]],
  ["board", "BoardPage", [`${P}/chat`, `${P}/tasks`, `${P}/attention`]],
  ["manager", "ManagerPage", [`${P}/chat`, `${P}/manager`, `${P}/waits`, `${P}/tasks`, `${P}/attention`, `${P}/reviews`]],
  ["reviews", "ReviewsPage", [`${P}/chat`, `${P}/reviews`, `${P}/reviewers`]],
  ["routines", "RoutinesPage", [`${P}/chat`, `${P}/routines`, `${P}/routine-runs`, `${P}/proposals`, `${P}/memory`]],
  ["triage", "TriagePage", [`${P}/chat`, `${P}/issues`, `${P}/proposals`]],
  ["secrets", "SecretsPage", [`${P}/chat`, `${P}/secrets`]],
  ["network", "NetworkPage", [`${P}/chat`, `${P}/network`]],
  ["settings", "SettingsPage", [`${P}/chat`, `${P}/secrets`]],
];

describe("a route's loader", () => {
  it("asks for its page's reads before the page's chunk or the project answers, and never twice", async () => {
    vi.stubGlobal("WebSocket", RecordingSocket);
    for (const [route, page, expected] of ROUTES) {
      const api = new FakeApi();
      api.tasks = [task({ id: "tsk_t1" })];
      const project = deferred();
      api.holds.push({ match: /^GET \/api\/projects\/prj_one$/, until: project.promise });
      const r = renderApp(`/projects/prj_one/${route}`, api);
      // With neither the page's chunk (the board's is in for its second visit) nor the project in.
      await waitFor(() => expect(api.reads, route).toEqual(expect.arrayContaining(["/api/projects", P, ...expected])));
      expect(screen.queryByRole("heading", { level: 1 }), route).toBeNull();
      chunk(page).resolve();
      project.resolve();
      await screen.findByRole("heading", { level: 1, name: "Widgets" });
      // Each read once: the page's hooks found the prefetch's (the polls are seconds away).
      await new Promise((ok) => setTimeout(ok, 200));
      for (const path of [P, ...expected]) expect(api.reads.filter((x) => x === path), `${route}: ${path}`).toHaveLength(1);
      r.unmount();
    }
  });

  it("opening a task's drawer warms the task and the reviews (its PRs' verdicts), and nothing the board already polls", async () => {
    loadChunks();
    const api = new FakeApi();
    api.tasks = [task({ id: "tsk_t1", title: "Open me" })];
    const { router, queryClient } = renderApp("/projects/prj_one/board", api);
    await screen.findByText("Open me");
    const prefetch = vi.spyOn(queryClient, "prefetchQuery");
    await router.navigate({ to: "/projects/$projectId/board", params: { projectId: "prj_one" }, search: { task: "tsk_t1" } });
    await waitFor(() => expect(api.reads).toContain(`${P}/tasks/tsk_t1`));
    // The board's loader ran again for the drawer alone: its tasks and "Needs you" are polled already.
    expect(prefetch.mock.calls.map(([o]) => o.queryKey)).toEqual([keys.task("prj_one", "tsk_t1"), keys.reviews("prj_one")]);
  });

  it("a page shown a while after its reads were prefetched (a click after a hover, a slow chunk) asks for each once", async () => {
    loadChunks();
    const { api, user } = renderApp("/projects/prj_one/board", new FakeApi());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    await user.hover(screen.getByRole("link", { name: "Reviews" }));
    await waitFor(() => expect(api.reads).toEqual(expect.arrayContaining([`${P}/reviews`, `${P}/reviewers`])));
    // Past the reads' staleTime (2 s), within PREFETCH_FIRST_READ_MS.
    await new Promise((ok) => setTimeout(ok, 2_300));
    await user.click(screen.getByRole("link", { name: "Reviews" }));
    await screen.findByRole("heading", { name: /^Reviewers/ });
    await new Promise((ok) => setTimeout(ok, 200));
    for (const path of [`${P}/reviews`, `${P}/reviewers`]) expect(api.reads.filter((x) => x === path), path).toHaveLength(1);
  });

  it("a hook mounting on a failure that wasn't a prefetch's asks again, as before", async () => {
    const api = new FakeApi();
    vi.stubGlobal("fetch", api.fetch);
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
    api.fail(/^GET \/api\/projects\/prj_one\/reviews$/, 502, "the Worker is unavailable");
    await queryClient.fetchQuery({ queryKey: keys.reviews("prj_one"), queryFn: () => Promise.reject(new Error("an earlier view's failure")) }).catch(() => {});
    const hook = renderHook(() => useReviews("prj_one"), { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
    await waitFor(() => expect(hook.result.current.isError || hook.result.current.isSuccess).toBe(true));
    expect(api.reads.filter((x) => x === `${P}/reviews`)).toHaveLength(1);
    hook.unmount();
  });

  it("an unknown project shows its error as before, and its reads fail once each, quietly", async () => {
    loadChunks();
    const api = new FakeApi();
    vi.stubGlobal("fetch", api.fetch);
    // The app's own client, its retry rule included (renderApp turns retries off).
    const queryClient = createQueryClient();
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/projects/prj_nope/board"] }) });
    const { App } = await import("./App");
    const { render } = await import("@testing-library/react");
    render(<App router={router} queryClient={queryClient} env="test" />);
    expect(await screen.findByRole("alert", { name: "The project couldn't be loaded" })).toBeInTheDocument();
    expect(api.reads).toEqual(expect.arrayContaining(["/api/projects/prj_nope/tasks", "/api/projects/prj_nope/attention"]));
    // Past the first retry's delay (1 s): a 404 isn't asked again.
    await new Promise((ok) => setTimeout(ok, 1_300));
    for (const path of ["/api/projects/prj_nope", "/api/projects/prj_nope/tasks", "/api/projects/prj_nope/attention"]) expect(api.reads.filter((x) => x === path), path).toHaveLength(1);
    // No notification: those are for writes that failed.
    expect(document.querySelector(".mantine-Notification-root")).toBeNull();
    expect(screen.queryByRole("alert", { name: /tasks|board/i })).toBeNull();
  });
});

describe("a preload (a link hovered or focused)", () => {
  it("hovering a view's link warms its reads as well as its chunk", async () => {
    loadChunks();
    const { api, user } = renderApp("/projects/prj_one/board", new FakeApi());
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    expect(api.reads).not.toContain(`${P}/reviews`);
    await user.hover(screen.getByRole("link", { name: "Reviews" }));
    await waitFor(() => expect(api.reads).toEqual(expect.arrayContaining([`${P}/reviews`, `${P}/reviewers`])));
  });

  it("fetches its reads once, starts no poll, and skips a read fresher than its staleTime", async () => {
    loadChunks();
    vi.useFakeTimers();
    const api = new FakeApi();
    vi.stubGlobal("fetch", api.fetch);
    const queryClient = createQueryClient();
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/projects"] }) });
    await router.load();
    // Read a moment ago: fresher than the default 2 s staleTime.
    queryClient.setQueryData(keys.reviewers("prj_one"), []);
    await router.preloadRoute({ to: "/projects/$projectId/reviews", params: { projectId: "prj_one" } });
    // Well past every interval the page's hooks would poll at.
    await vi.advanceTimersByTimeAsync(4 * POLL.reviews);
    expect(api.reads.filter((x) => x.startsWith(P))).toEqual([P, `${P}/chat`, `${P}/reviews`]);
    expect(queryClient.getQueryCache().find({ queryKey: keys.reviews("prj_one"), exact: true })!.getObserversCount()).toBe(0);
  });
});

describe("a prefetch and the conditional GET", () => {
  it("the hook's next poll names the prefetch's ETag, and a 304 keeps its value", async () => {
    loadChunks();
    const id = "prj_etag";
    const sent: { url: string; inm: string | null }[] = [];
    const tasks = [{ id: "tsk_e1" }];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const inm = new Headers(init?.headers).get("if-none-match");
      sent.push({ url, inm });
      if (url === `/api/projects/${id}/tasks`) return inm === '"v1"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify(tasks), { headers: { etag: '"v1"' } });
      return new Response(JSON.stringify(url === "/api/projects" ? { projects: [] } : []), { headers: { "content-type": "application/json" } });
    });
    const queryClient = createQueryClient();
    const router = createAppRouter({ queryClient, history: createMemoryHistory({ initialEntries: ["/projects"] }) });
    await router.load();
    await router.preloadRoute({ to: "/projects/$projectId/board", params: { projectId: id } });
    await waitFor(() => expect(queryClient.getQueryData(keys.tasks(id))).toEqual(tasks));
    const hook = renderHook(() => useTasks(id), { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
    expect(hook.result.current.data).toEqual(tasks);
    await queryClient.refetchQueries({ queryKey: keys.tasks(id), exact: true });
    const asked = sent.filter((s) => s.url === `/api/projects/${id}/tasks`);
    expect(asked.map((s) => s.inm)).toEqual([null, '"v1"']);
    expect(hook.result.current.data).toEqual(tasks);
    hook.unmount();
  });
});
