// The projects app's Worker (README.md): the page and its JSON API behind Cloudflare Access, the MCP
// servers agents call (authenticated by Nest-Identity), and the webhooks of nest and of the GitHub App
// (each authenticated by its signature). It reaches nest only through the client interface (src/nest.ts),
// and GitHub with its own App's tokens (src/github.ts, src/github-app.ts); it imports nothing from the control plane
// (scripts/boundaries.toml).

import { verifyAccessJwt } from "./access";
import { handleApi } from "./api";
import { conditional, timed } from "./conditional";
import { withSecurityHeaders } from "./csp";
import { directory, type Env, project, review } from "./env";
import { githubHook } from "./github-hook";
import { handleMcp, isServer } from "./mcp";
import { clientIdOf, NestError, nestFrom } from "./nest";
import { routable, verifySignature } from "./webhook";

export { DirectoryDO } from "./do/directory";
export { ProjectDO } from "./do/project";
export { ReviewDO } from "./do/review";
export type { Env };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * Who Access let through: `owner`, a login (its token carries the login's email); `service`, a service
 * token (Service Auth: no email, its client id as `common_name`, an empty `sub`); `null`, anything else,
 * including no valid token for the app's application. Fails closed.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
 */
async function admitted(request: Request, env: Env): Promise<"owner" | "service" | null> {
  // `vite dev` only: there is no Access in front of localhost. `vite build` replaces the flag with
  // `false`, so the deployed Worker has no such branch.
  if (import.meta.env.DEV) return "owner";
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.PROJECTS_AUD) return null;
  let claims: Record<string, unknown> | null;
  try {
    claims = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.PROJECTS_AUD });
  } catch {
    return null; // the team's keys could not be fetched
  }
  if (!claims) return null;
  if (typeof claims.email === "string" && claims.email !== "") return "owner";
  if (claims.email === undefined && typeof claims.common_name === "string" && claims.common_name !== "" && claims.sub === "") return "service";
  return null;
}

/**
 * What a service token may do (README.md#setup-the-operators): read the projects and their managers, which
 * wakes them, for nest's cloud checks (dev/cloud-checks/). Nothing else: no page, no write, no other read.
 */
export function serviceMayCall(method: string, path: string): boolean {
  return method === "GET" && (path === "/api/projects" || /^\/api\/projects\/prj_[a-z0-9]+\/manager$/.test(path));
}

/**
 * `POST /hooks/nest`: one event, signed by nest. Handled once per event id: routed by its agent to its
 * project; an agent the app doesn't know is looked up by its labels once, and ignored (2xx) if it isn't
 * one the app created. A failure answers 5xx, so nest delivers it again.
 */
async function nestHook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!env.NEST_WEBHOOK_SECRET) return new Response(null, { status: 503 });
  const body = await request.text();
  if (!(await verifySignature(env.NEST_WEBHOOK_SECRET, request.headers.get("nest-signature"), body))) return new Response(null, { status: 401 });
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  const event = routable(raw);
  if (!event) return json({ ignored: true });
  const dir = directory(env);
  if (await dir.seen(event.id)) return json({ duplicate: true });
  let route = await dir.route(event.agent);
  if (route === undefined) {
    // Not recorded (an event that overtook the record, or the record was lost): its labels say whose it is,
    // trusted only for an agent the app created itself.
    const nest = nestFrom(env);
    const me = clientIdOf(env.NEST_CLIENT_TOKEN);
    if (!nest || !me) return new Response(null, { status: 503 });
    try {
      const a = await nest.getAgent(event.agent);
      const l = a.labels ?? {};
      const role = l.role === "manager" || l.role === "worker" || l.role === "reviewer" || l.role === "routine" ? l.role : null;
      const ours = a.owner === me && a.client === me && role !== null && typeof l.project === "string" && (await dir.getProject(l.project)) !== null;
      route = ours
        ? { agent: event.agent, project: l.project!, role, task: l.task ?? null, pr: l.pr ? Number(l.pr) : null }
        : { agent: event.agent, project: null, role: null, task: null, pr: null };
    } catch (e) {
      if (!(e instanceof NestError && e.status === 404)) return new Response(null, { status: 502 });
      route = { agent: event.agent, project: null, role: null, task: null, pr: null };
    }
    await dir.recordAgent(route);
  }
  if (route.project) {
    await project(env, route.project).onEvent(event, { role: route.role, task: route.task });
    // A reviewer's end is its review's: retried, or the check completed without a verdict.
    if (route.role === "reviewer" && event.type === "agent.exited") await review(env, route.project).onAgentExited(event.agent, event.reason);
  }
  await dir.markSeen(event.id);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Authenticated by identity and by signature instead of Access (README.md#setup-the-operators).
    if (path.startsWith("/mcp/")) {
      const server = path.slice("/mcp/".length);
      return isServer(server) ? handleMcp(request, env, server) : new Response(null, { status: 404 });
    }
    if (path === "/hooks/nest") return nestHook(request, env);
    if (path === "/hooks/github") return githubHook(request, env);
    if (path.startsWith("/hooks/")) return new Response(null, { status: 404 });

    const who = await admitted(request, env);
    if (!who) return json({ error: "a Cloudflare Access login for this app is required" }, 403);
    if (who === "service" && !serviceMayCall(request.method, path)) return json({ error: "a service token may only read the projects and their managers" }, 403);
    if (path.startsWith("/api/")) {
      // Conditional and timed (src/conditional.ts); the trace's routes are nest's answers, passed through.
      const start = Date.now();
      return timed(await conditional(request, await handleApi(request, env, url), path.startsWith("/api/agents/")), start);
    }
    const asset = await env.ASSETS.fetch(request);
    // `vite build` replaces the flag with `false`: the deployed Worker always sends them.
    return import.meta.env.DEV ? asset : withSecurityHeaders(asset);
  },
} satisfies ExportedHandler<Env>;
