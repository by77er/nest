// `GET /api/agents/<id>/trace?after=<seq>` (behind Cloudflare Access, src/worker.ts): an agent's live trace
// from nest (docs/control-plane/api/, "Live trace"), for an agent of a project the app knows. The browser
// can't set `Authorization` on a WebSocket, so this Worker opens the upgrade to nest with the client token
// and hands the browser the socket nest answered: Workers proxy a WebSocket by returning the `fetch`
// response's `webSocket` ("This establishes a WebSocket connection proxied through a Worker",
// https://developers.cloudflare.com/workers/runtime-apis/response/). The app holds no state for it, and
// the token never reaches the browser.

import { directory, type Env } from "./env";
import { NestError, nestFrom } from "./nest";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, error: string) => json({ error }, status);

export const AGENT_ID = /^agt_[A-Za-z0-9]+$/;
const AFTER = /^\d{1,15}$/;

/** Whether `agent` is one the app recorded for one of its projects; any other id is unknown here, whatever nest has. */
async function ours(env: Env, agent: string): Promise<boolean> {
  const dir = directory(env);
  const route = AGENT_ID.test(agent) ? await dir.route(agent) : undefined;
  return !!route?.project && (await dir.getProject(route.project)) !== null;
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const LIMIT = /^\d{1,4}$/;

/**
 * `GET /api/agents/<id>/trace/history?before=<cursor>&limit=<n>`: the trace's older events, from nest's
 * trace history (its stored transcript), for the same agents as the trace. nest's answer, as it is.
 */
export async function proxyTraceHistory(req: Request, env: Env, agent: string, url: URL): Promise<Response> {
  if (req.method !== "GET") return err(405, "GET only");
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit");
  if (before !== null && !CURSOR.test(before)) return err(400, "before is not a cursor the trace gave");
  if (limit !== null && !LIMIT.test(limit)) return err(400, "limit must be a positive integer");
  if (!(await ours(env, agent))) return err(404, "unknown agent");
  const nest = nestFrom(env);
  if (!nest) return err(503, "NEST_CLIENT_TOKEN is not set");
  try {
    return json(await nest.traceHistory(agent, { ...(before !== null ? { before } : {}), ...(limit !== null ? { limit } : {}) }));
  } catch (e) {
    if (e instanceof NestError) return err(e.status === 404 ? 404 : e.status === 400 ? 400 : e.status === 503 ? 503 : 502, e.status === 404 ? "unknown agent" : e.message);
    return err(502, "nest can't be reached");
  }
}

export async function proxyTrace(req: Request, env: Env, agent: string, url: URL): Promise<Response> {
  if (req.method !== "GET") return err(405, "GET only");
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return err(426, "expected a WebSocket upgrade");
  const after = url.searchParams.get("after");
  if (after !== null && !AFTER.test(after)) return err(400, "after must be a non-negative integer");
  if (!(await ours(env, agent))) return err(404, "unknown agent");
  if (!env.NEST_CLIENT_TOKEN) return err(503, "NEST_CLIENT_TOKEN is not set");
  const upstream = new URL(`/v1/agents/${encodeURIComponent(agent)}/trace`, env.NEST_CONTROL_PLANE);
  if (after !== null) upstream.searchParams.set("after", after);
  let res: Response;
  try {
    // The global fetch, looked up per call (dev/review-lessons.md 8). Only these headers go: no cookie of the browser's.
    res = await fetch(new Request(upstream.toString(), {
      headers: { upgrade: "websocket", authorization: `Bearer ${env.NEST_CLIENT_TOKEN}`, "user-agent": "nest-projects/1" },
    }));
  } catch {
    return err(502, "nest can't be reached");
  }
  if (res.status === 101 && res.webSocket) return new Response(null, { status: 101, webSocket: res.webSocket });
  // nest's refusal, without its body's detail beyond the message (never the token).
  let message = `nest answered ${res.status}`;
  try {
    const e = (JSON.parse(await res.text()) as { error?: { message?: unknown } }).error;
    if (typeof e?.message === "string") message = e.message;
  } catch {
    // not JSON
  }
  // A retryable 503 (nest's object still on its previous release) stays one, so the page retries.
  const status = res.status === 404 ? 404 : res.status === 503 ? 503 : 502;
  return err(status, status === 404 ? "unknown agent" : message);
}
