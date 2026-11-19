// How many rounds of requests a page waits for before its content can show (README.md#the-ui: routes
// prefetch their page's reads). Every GET is held, and released a round at a time: a round is what the
// page has asked for once it has settled with nothing answered. Before the routes' loaders, a project
// page took a round for the project, and only then one for its own reads.
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type FakeApi, FakeApi as Fake, project, task } from "./test/fakeApi";
import { renderApp } from "./test/render";
import { RecordingSocket } from "./test/sockets";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

type Rendered = ReturnType<typeof renderApp>;

/**
 * The page can show: nothing loading outside what a page keeps hidden until it shows (the board's cold
 * load), and no read a mounted part of it makes still waiting for its first answer.
 */
const settledView = (r: Rendered | null) =>
  [...document.querySelectorAll("[data-ds=loading]")].every((e) => e.closest("[aria-hidden=true]")) &&
  !!r?.queryClient.getQueryCache().getAll().every((q) => !q.isActive() || q.state.status !== "pending");

/**
 * Hold every GET from now on; then, until `shown()`, wait for the page to settle (no new request for
 * 300 ms, the router idle) and release what it asked for: the rounds, each its requests in order.
 */
async function rounds(api: FakeApi, r: () => Rendered | null, start: () => unknown, shown: () => boolean): Promise<string[][]> {
  let gate = deferred();
  const hold = { match: /^GET /, until: gate.promise };
  api.holds.push(hold);
  start();
  const out: string[][] = [];
  let seen = api.reads.length;
  for (let i = 0; i < 6; i++) {
    for (let last = -1; last !== api.reads.length || r()?.router.state.status !== "idle"; ) {
      last = api.reads.length;
      await new Promise((ok) => setTimeout(ok, 300));
    }
    if (shown()) break;
    out.push(api.reads.slice(seen).map((p) => (p === "/api/projects" ? "projects" : p.replace(/^\/api\/projects\/prj_\w+\/?/, "") || "project")));
    seen = api.reads.length;
    const open = gate;
    gate = deferred();
    hold.until = gate.promise;
    open.resolve();
  }
  hold.until = Promise.resolve();
  gate.resolve();
  return out;
}

function fake(): FakeApi {
  const api = new Fake();
  api.projects = [project(), project({ id: "prj_two", name: "Gadgets", repo: "owner/gadgets" })];
  api.tasks = [task({ title: "Alpha" })];
  api.chat = [{ seq: 1, at_ms: Date.UTC(2026, 10, 2, 9), sender: "manager", text: "Hello from the manager", delivered: true, status: "done", error: null }];
  return api;
}

const report: Record<string, string[][]> = {};

describe("request rounds before a page's content shows", () => {
  it("cold load of the Board", async () => {
    const api = fake();
    let r: Rendered | null = null;
    const got = await rounds(api, () => r, () => (r = renderApp("/projects/prj_one/board", api)),
      () => !!screen.queryByRole("heading", { level: 1, name: "Widgets" }) && !!screen.queryByText("Alpha") && settledView(r));
    report["cold Board"] = got;
    expect(got).toHaveLength(1);
  });

  it("cold load of the Manager page", async () => {
    vi.stubGlobal("WebSocket", RecordingSocket);
    const api = fake();
    let r: Rendered | null = null;
    const got = await rounds(api, () => r, () => (r = renderApp("/projects/prj_one/manager", api)),
      () => !!screen.queryByRole("heading", { level: 1, name: "Widgets" }) && !!screen.queryByText("Hello from the manager") && settledView(r));
    report["cold Manager"] = got;
    expect(got).toHaveLength(1);
  });

  it("a view switch (Board to Reviews), and a project switch (its Board)", async () => {
    const api = fake();
    const r = renderApp("/projects/prj_one/board", api);
    await screen.findByText("Alpha");
    const view = await rounds(api, () => r, () => r.router.navigate({ to: "/projects/$projectId/reviews", params: { projectId: "prj_one" } }),
      () => r.router.state.location.pathname.endsWith("/reviews") && !!screen.queryByRole("heading", { name: /^Reviews/ }) && settledView(r));
    report["view switch, Board → Reviews"] = view;
    expect(view).toHaveLength(1);
    const other = await rounds(api, () => r, () => r.router.navigate({ to: "/projects/$projectId/board", params: { projectId: "prj_two" } }),
      () => !!screen.queryByRole("heading", { level: 1, name: "Gadgets" }) && settledView(r) && !!screen.queryByRole("heading", { name: /^Tasks/ }));
    report["project switch, Widgets → Gadgets (Board)"] = other;
    expect(other).toHaveLength(1);
  });

  it("a view switch after hovering its link: its reads were in before the click", async () => {
    const api = fake();
    const r = renderApp("/projects/prj_one/board", api);
    await screen.findByText("Alpha");
    await r.user.hover(screen.getByRole("link", { name: "Routines" }));
    await new Promise((ok) => setTimeout(ok, 500));
    const got = await rounds(api, () => r, () => r.router.navigate({ to: "/projects/$projectId/routines", params: { projectId: "prj_one" } }),
      () => r.router.state.location.pathname.endsWith("/routines") && !!screen.queryByRole("heading", { name: /^Routines/ }) && settledView(r));
    report["view switch after hover, Board → Routines"] = got;
    expect(got).toHaveLength(0);
    console.log(JSON.stringify(report, null, 1));
  });
});
