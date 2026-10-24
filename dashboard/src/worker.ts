// The dashboard's Worker: serves the built page and proxies two read-only admin routes of the
// control plane with the admin token it holds. Nothing else is reachable through it, and the token
// never reaches the browser. Access on the hostname (docs/setup/) decides who may open it.

export interface Env {
  ASSETS: Fetcher;
  NEST_CONTROL_PLANE: string;
  NEST_CELLS: string;
  NEST_ADMIN_TOKEN?: string;
}

/** The only control-plane routes the page may read, by the path it asks for. */
const ROUTES: Record<string, string> = {
  "/api/fleet": "/v1/admin/fleet",
  "/api/images": "/v1/admin/images",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
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
