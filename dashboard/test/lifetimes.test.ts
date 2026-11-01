// The Worker's `GET /api/lifetimes`: the control plane's lifetimes view, followed page by page with
// the admin token and merged, and nothing else reachable; and the page's helpers that read it. The
// oracle is a response recorded from the control plane's test pool (fixtures/admin.ts `lifetimes`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lifetimes } from "../fixtures/admin";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AbandonedView, byAge, destroyIn, idleSince, operatorCall, span } from "../src/Abandoned";
import { type LifetimesResponse, MAX_LIFETIME_PAGES, mergePages } from "../src/lifetimes";
import type { LifetimesView } from "../../protocol/admin/view";
import worker, { type Env } from "../src/worker";

const CONTROL_PLANE = "https://cp.example";
const env: Env = {
  ASSETS: { fetch: async () => new Response("<html>") } as unknown as Fetcher,
  NEST_CONTROL_PLANE: CONTROL_PLANE,
  NEST_CELLS: "use1",
  NEST_ADMIN_TOKEN: "admin-token",
};

const [dormant, held] = lifetimes.sandboxes;
const [quiet, lead] = lifetimes.agents;
/** Page `i` of `n`: the fixture with its sandbox renamed per page and a cursor to the next. */
const page = (i: number, n: number): LifetimesView => ({
  ...lifetimes,
  sandboxes: [{ ...dormant!, sandbox: `sbx_page${i}` }],
  next_cursor: i + 1 < n ? `${1000 + i}.sbx_page${i}` : null,
});

let upstream: { path: string; auth: string | null }[];
let pages: number;
let respond: (path: string) => Response | undefined;

const get = (path: string, init?: RequestInit) => worker.fetch(new Request(`https://dash.example${path}`, init) as never, env);

beforeEach(() => {
  vi.stubEnv("DEV", true);
  upstream = [];
  pages = 3;
  respond = () => undefined;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== CONTROL_PLANE) throw new Error(`unexpected fetch ${url}`);
    upstream.push({ path: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization") });
    const custom = respond(url.pathname + url.search);
    if (custom) return custom;
    if (url.pathname !== "/v1/admin/lifetimes") throw new Error(`unexpected route ${url}`);
    const cursor = url.searchParams.get("cursor");
    const i = cursor ? Number(cursor.split(".")[0]) - 1000 + 1 : 0;
    return Response.json(page(i, pages));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/lifetimes", () => {
  it("follows the control plane's pages with the admin token and merges them", async () => {
    const res = await get("/api/lifetimes?cell=use1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as LifetimesResponse;
    expect(upstream).toEqual([
      { path: "/v1/admin/lifetimes?cell=use1", auth: "Bearer admin-token" },
      { path: `/v1/admin/lifetimes?cell=use1&cursor=${encodeURIComponent("1000.sbx_page0")}`, auth: "Bearer admin-token" },
      { path: `/v1/admin/lifetimes?cell=use1&cursor=${encodeURIComponent("1001.sbx_page1")}`, auth: "Bearer admin-token" },
    ]);
    expect(body.sandboxes.map((s) => s.sandbox)).toEqual(["sbx_page0", "sbx_page1", "sbx_page2"]);
    // The same agents on every page: listed once; counts summed.
    expect(body.agents.map((a) => a.agent)).toEqual(lifetimes.agents.map((a) => a.agent));
    expect(body.counts.sandboxes.dormant).toBe(3 * lifetimes.counts.sandboxes.dormant);
    expect(body.counts.agents.quiet).toBe(3 * lifetimes.counts.agents.quiet);
    expect(body).toMatchObject({ pages: 3, truncated: false, cell: "use1" });
    expect(body).not.toHaveProperty("next_cursor");
  });

  it("reads at most MAX_LIFETIME_PAGES and says more were left", async () => {
    pages = MAX_LIFETIME_PAGES + 5;
    const body = (await (await get("/api/lifetimes?cell=use1")).json()) as LifetimesResponse;
    expect(upstream).toHaveLength(MAX_LIFETIME_PAGES);
    expect(body).toMatchObject({ pages: MAX_LIFETIME_PAGES, truncated: true });
  });

  it("never sends on a cursor that isn't the control plane's shape", async () => {
    respond = (p) => (p === "/v1/admin/lifetimes?cell=use1" ? Response.json({ ...page(0, 1), next_cursor: "../secrets/x" }) : undefined);
    const body = (await (await get("/api/lifetimes?cell=use1")).json()) as LifetimesResponse;
    expect(upstream).toHaveLength(1);
    expect(body).toMatchObject({ pages: 1, truncated: true });
  });

  it("passes on a failed page's answer, e.g. a control plane from before the route", async () => {
    const notFound = { error: { code: "not_found", message: "no route GET /v1/admin/lifetimes", retryable: false } };
    respond = () => Response.json(notFound, { status: 404 });
    const res = await get("/api/lifetimes?cell=use1");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual(notFound);
  });

  it("is read-only, for a known cell, and the only new route", async () => {
    expect((await get("/api/lifetimes?cell=use1", { method: "POST" })).status).toBe(405);
    expect((await get("/api/lifetimes?cell=other")).status).toBe(400);
    for (const p of ["/api/lifetimes/x?cell=use1", "/api/lifetime?cell=use1", "/api/gc?cell=use1", "/api/admin/lifetimes?cell=use1"]) {
      expect((await get(p)).status, p).toBe(404);
    }
    expect(upstream).toEqual([]);
  });
});

describe("the merge", () => {
  it("keeps one page as it is, without its cursor", () => {
    const { next_cursor: _, ...rest } = lifetimes;
    expect(mergePages([lifetimes], false)).toEqual({ ...rest, pages: 1, truncated: false });
  });
});

describe("the page's reading of it", () => {
  const now = lifetimes.now_ms;
  const agents = new Map(lifetimes.agents.map((a) => [a.agent, a]));

  it("says when the idle TTL destroys a dormant sandbox, and never for a held one", () => {
    expect(destroyIn(dormant!, now)).toBe(`in ${span(dormant!.destroy_at_ms! - now)}`);
    expect(destroyIn({ kind: "dormant", destroy_at_ms: now - 1 }, now)).toBe("due now");
    expect(destroyIn({ kind: "dormant", destroy_at_ms: null }, now)).toBe("clock not started");
    expect(destroyIn(held!, now)).toBe("never (not dormant)");
  });

  it("dates a held sandbox by its agents' latest turn, a dormant one by its dormancy", () => {
    expect(idleSince(dormant!, agents)).toBe(dormant!.dormant_since_ms);
    expect(idleSince(held!, agents)).toBe(quiet!.last_turn_ms);
    expect(idleSince({ ...held!, attached: [lead!.agent] }, agents)).toBe(held!.registered_ms);
  });

  it("sorts oldest first, never-used first of all", () => {
    expect(byAge(lifetimes.agents, (a) => a.last_turn_ms).map((a) => a.agent)).toEqual([lead!.agent, quiet!.agent]);
    expect(byAge(lifetimes.sandboxes, (s) => idleSince(s, agents)).map((s) => s.sandbox)).toEqual([held!.sandbox, dormant!.sandbox]);
  });

  it("shows the operator's call as text", () => {
    expect(operatorCall(dormant!)).toContain(`PUT /v1/sandboxes/${dormant!.sandbox}/lifetime`);
    expect(operatorCall(held!)).toContain(`"end": true`);
  });

  it("the recorded view is the case the page is for: one dormant, one held by a quiet agent the operator stopped", () => {
    expect(dormant).toMatchObject({ kind: "dormant", attached: [] });
    expect(held).toMatchObject({ kind: "held", attached: [quiet!.agent] });
    expect(quiet).toMatchObject({ kind: "quiet", stopped_by_operator: true, sandbox: held!.sandbox, owner: lead!.agent });
    expect(lead).toMatchObject({ kind: "quiet", found_via: "owner", live_children: [quiet!.agent] });
  });
});

describe("the section", () => {
  const render = (view: LifetimesResponse | null, error: string | null = null) =>
    renderToStaticMarkup(createElement(AbandonedView, { view, error, now: lifetimes.now_ms }));

  it("lists the recorded view's sandboxes and agents, with when the TTL takes the dormant one, and no control that acts", () => {
    const html = render(mergePages([lifetimes], false));
    for (const id of [dormant!.sandbox, held!.sandbox, quiet!.agent, lead!.agent]) expect(html).toContain(id);
    expect(html).toContain(`in ${span(dormant!.destroy_at_ms! - lifetimes.now_ms)}`);
    expect(html).toContain("never (not dormant)");
    expect(html).not.toMatch(/<(button|form|input)\b/);
  });

  it("says why it has nothing to show", () => {
    expect(render(null, "this control plane does not serve GET /v1/admin/lifetimes yet")).toContain("does not serve");
    expect(render(null)).toContain("loading");
  });
});
