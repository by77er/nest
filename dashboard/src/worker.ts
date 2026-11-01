// The dashboard's Worker: serves the built page and proxies two read-only admin routes of the
// control plane with the admin token it holds, plus `GET /v1/agents/:agent` for the agents the fleet
// view lists (src/agents.ts), narrowed, and `GET /v1/admin/lifetimes` page by page (src/lifetimes.ts).
// Nothing else is reachable through it, and the token never
// reaches the browser. Every request, page and API alike, must carry a valid Cloudflare
// Access token for the dashboard's application (src/access.ts); without one the answer is 403, so
// the token stays private even on a path that does not pass through Access.

import { verifyAccessJwt } from "./access";
import { AGENT_CONCURRENCY, type AgentRow, type AgentsResponse, errorMessage, listedAgents, mapBounded, MAX_AGENTS, summarizeAgent } from "./agents";
import { collectLifetimes } from "./lifetimes";

export interface Env {
  ASSETS: Fetcher;
  NEST_CONTROL_PLANE: string;
  NEST_CELLS: string;
  /** The Zero Trust team's domain (`https://<team>.cloudflareaccess.com`): the token's issuer. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The dashboard application's audience tag (the edge stack's `dashboard_aud` output). */
  DASHBOARD_AUD?: string;
  NEST_ADMIN_TOKEN?: string;
}

/** The control-plane routes the page reads as they are, by the path it asks for (and `/api/agents`, `/api/lifetimes`). */
const ROUTES: Record<string, string> = {
  "/api/fleet": "/v1/admin/fleet",
  "/api/images": "/v1/admin/images",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** A GET of the control plane's admin API with the admin token. */
const upstream = (env: Env & { NEST_ADMIN_TOKEN: string }, path: string) =>
  fetch(`${env.NEST_CONTROL_PLANE}${path}`, { headers: { authorization: `Bearer ${env.NEST_ADMIN_TOKEN}`, "user-agent": "nest-dashboard/1" } });

/** Its answer as the page's, the body passed through. */
const passThrough = (res: Response) =>
  new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * `GET /api/agents`: each agent the cell's fleet view lists on a host, read from AgentDO (at most
 * MAX_AGENTS, AGENT_CONCURRENCY at a time) and narrowed. One that cannot be read is a row with its
 * error, not a failed answer; only a fleet view that cannot be read fails it.
 */
async function agents(env: Env & { NEST_ADMIN_TOKEN: string }, cell: string): Promise<Response> {
  const fleet = await upstream(env, `/v1/admin/fleet?cell=${encodeURIComponent(cell)}`);
  if (!fleet.ok) return passThrough(fleet);
  const ids = listedAgents(await fleet.json());
  const read = ids.slice(0, MAX_AGENTS);
  const rows = await mapBounded(read, AGENT_CONCURRENCY, async (agent): Promise<AgentRow> => {
    try {
      const res = await upstream(env, `/v1/agents/${agent}`);
      const text = await res.text();
      if (!res.ok) return { agent, info: null, error: `${res.status}: ${errorMessage(text)}` };
      return { agent, info: summarizeAgent(agent, JSON.parse(text)), error: null };
    } catch (e) {
      return { agent, info: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
  return json({ agents: rows, omitted: ids.length - read.length } satisfies AgentsResponse);
}

/** `GET /api/lifetimes`: the cell's lifetimes view, every page up to the cap, merged; a failed page's answer passed on. */
async function lifetimes(env: Env & { NEST_ADMIN_TOKEN: string }, cell: string): Promise<Response> {
  const r = await collectLifetimes((cursor) =>
    upstream(env, `/v1/admin/lifetimes?cell=${encodeURIComponent(cell)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`));
  return "failed" in r ? passThrough(r.failed) : json(r.ok);
}

/** The routes the Worker answers itself, from control-plane reads of its own. */
const ANSWERED: Record<string, (env: Env & { NEST_ADMIN_TOKEN: string }, cell: string) => Promise<Response>> = {
  "/api/agents": agents,
  "/api/lifetimes": lifetimes,
};

/** Whether the request carries a valid Access token for this application; fails closed. */
async function admitted(request: Request, env: Env): Promise<boolean> {
  // `vite dev` only: there is no Access in front of localhost. `vite build` replaces the flag with
  // `false`, so the deployed Worker has no such branch.
  if (import.meta.env.DEV) return true;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.DASHBOARD_AUD) return false;
  try {
    return (await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.DASHBOARD_AUD })) !== null;
  } catch {
    return false; // the team's keys could not be fetched
  }
}

export default {
  async fetch(request, env) {
    if (!(await admitted(request, env))) return json({ error: "a Cloudflare Access login for this dashboard is required" }, 403);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET") return json({ error: "read-only" }, 405);
    const cells = env.NEST_CELLS.split(",").map((c) => c.trim()).filter(Boolean);
    if (url.pathname === "/api/cells") return json({ cells, control_plane: env.NEST_CONTROL_PLANE });
    const target = ROUTES[url.pathname];
    const answer = ANSWERED[url.pathname];
    if (!target && !answer) return json({ error: "unknown route" }, 404);
    const cell = url.searchParams.get("cell") ?? "";
    if (!cells.includes(cell)) return json({ error: `unknown cell ${cell}` }, 400);
    const token = env.NEST_ADMIN_TOKEN;
    if (!token) return json({ error: "NEST_ADMIN_TOKEN is not set on this Worker" }, 503);
    const authed = { ...env, NEST_ADMIN_TOKEN: token };
    if (answer) return answer(authed, cell);
    return passThrough(await upstream(authed, `${target}?cell=${encodeURIComponent(cell)}`));
  },
} satisfies ExportedHandler<Env>;
