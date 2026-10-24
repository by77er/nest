// The dashboard's Worker: serves the built page and proxies two read-only admin routes of the
// control plane with the admin token it holds. Nothing else is reachable through it, and the token
// never reaches the browser. Every request, page and API alike, must carry a valid Cloudflare
// Access token for the dashboard's application (src/access.ts); without one the answer is 403, so
// the token stays private even on a path that does not pass through Access.

import { verifyAccessJwt } from "./access";

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

/** The only control-plane routes the page may read, by the path it asks for. */
const ROUTES: Record<string, string> = {
  "/api/fleet": "/v1/admin/fleet",
  "/api/images": "/v1/admin/images",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

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
    if (!target) return json({ error: "unknown route" }, 404);
    const cell = url.searchParams.get("cell") ?? "";
    if (!cells.includes(cell)) return json({ error: `unknown cell ${cell}` }, 400);
    if (!env.NEST_ADMIN_TOKEN) return json({ error: "NEST_ADMIN_TOKEN is not set on this Worker" }, 503);
    const upstream = await fetch(`${env.NEST_CONTROL_PLANE}${target}?cell=${encodeURIComponent(cell)}`, {
      headers: { authorization: `Bearer ${env.NEST_ADMIN_TOKEN}`, "user-agent": "nest-dashboard/1" },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  },
} satisfies ExportedHandler<Env>;
