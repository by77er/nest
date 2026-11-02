// Render the whole page the way main.tsx does (but with Mantine's test env: no transitions or portals,
// and no retries, so an error shows at once), over a stubbed fetch that answers the Worker's routes
// with the recorded responses in fixtures/admin.ts, or with what a test puts in their place.
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { agent, fleet, images, lifetimes } from "../../fixtures/admin";
import type { AgentsResponse, Fleet, Images, LifetimesResponse } from "../../src/api";
import { summarizeAgent } from "../../src/agents";
import { mergePages } from "../../src/lifetimes";
import { App } from "../../src/ui/App";
import { createQueryClient } from "../../src/ui/queries";

type Answer = unknown | Response | (() => unknown | Response | Promise<unknown | Response>);

export interface Routes {
  "/api/cells": Answer;
  "/api/fleet": Answer;
  "/api/images": Answer;
  "/api/agents": Answer;
  "/api/lifetimes": Answer;
}

export const recorded = {
  fleet: (): Fleet => structuredClone(fleet),
  images: (): Images => structuredClone(images),
  agents: (): AgentsResponse => ({ agents: [{ agent: agent.agent, info: summarizeAgent(agent.agent, agent), error: null }], omitted: 0 }),
  lifetimes: (): LifetimesResponse => mergePages([structuredClone(lifetimes)], false),
};

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** A read that never answers. */
export const pending = () => new Promise<never>(() => {});

export function renderPage(over: Partial<Routes> = {}) {
  const routes: Routes = {
    "/api/cells": { cells: ["use1"], control_plane: "https://cp.example" },
    "/api/fleet": recorded.fleet,
    "/api/images": recorded.images,
    "/api/agents": recorded.agents,
    "/api/lifetimes": recorded.lifetimes,
    ...over,
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://dash.test");
    calls.push(url.pathname);
    const r = routes[url.pathname as keyof Routes];
    const v = typeof r === "function" ? await (r as () => unknown)() : r;
    return v instanceof Response ? v : json(v);
  });
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const user = userEvent.setup();
  const view = render(<App queryClient={queryClient} env="test" />);
  return { ...view, routes, calls, user, queryClient };
}
