// nest-mcp-test: a rudimentary remote MCP server (Streamable HTTP, JSON responses only) for nest's
// end-to-end tests, plus a test surface to read what it was sent.
//
//   POST   /mcp            one JSON-RPC message (initialize, notifications/initialized, ping, tools/list, tools/call)
//   DELETE /mcp            ends the session named by Mcp-Session-Id
//   GET    /calls?since=n  every tools/call received after seq n, in order
//   POST   /reset          clears notes, counters and the call log
//
// Every route needs `Authorization: Bearer <MCP_TEST_TOKEN>`.

import { classify, failure, INVALID_REQUEST, isRpcError, type Message, PARSE_ERROR, PROTOCOL_VERSIONS, type RpcError } from "./jsonrpc";
import { type CallRecord, McpState, type Reply } from "./state";

export { McpState };

declare global {
  interface Env {
    STATE: DurableObjectNamespace<McpState>;
    MCP_TEST_TOKEN?: string;
    /** Comma-separated Origins admitted; a request carrying any other Origin gets 403. */
    ALLOWED_ORIGINS?: string;
  }
}

const MAX_BODY = 1 << 20;
const SESSION_HEADER = "Mcp-Session-Id";

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const rpcError = (status: number, error: RpcError, headers: Record<string, string> = {}): Response =>
  jsonResponse(status, failure(undefined, error), headers);

async function authorized(req: Request, token: string): Promise<boolean> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/i.exec(header);
  if (!m) return false;
  const enc = new TextEncoder();
  // Hash both sides so the comparison is constant-time whatever the lengths.
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(m[1])), crypto.subtle.digest("SHA-256", enc.encode(token))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Servers must validate Origin to stop DNS rebinding (Streamable HTTP, security warning). nest's
// proxy sends none; a browser always does, and is refused unless the origin is listed.
function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin);
}

const state = (env: Env) => env.STATE.get(env.STATE.idFromName("main"));
// RPC's typing can't see that `unknown` fields are plain JSON; they are, so cast the results back.
const send = async (env: Env, msg: Message, session: string | null) => (await state(env).message(msg, session)) as Reply;
const readCalls = async (env: Env, since: number) => (await state(env).calls(since)) as CallRecord[];

async function mcpPost(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) return rpcError(415, { code: INVALID_REQUEST, message: "Content-Type must be application/json" });
  // The client must accept both a JSON body and an SSE stream (this server only ever sends JSON).
  const accept = req.headers.get("accept") ?? "";
  if (!/\bapplication\/json\b/i.test(accept) || !/\btext\/event-stream\b/i.test(accept)) {
    return rpcError(406, { code: INVALID_REQUEST, message: "Accept must list application/json and text/event-stream" });
  }
  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return rpcError(413, { code: INVALID_REQUEST, message: "body too large" });
  const text = await req.text();
  if (text.length > MAX_BODY) return rpcError(413, { code: INVALID_REQUEST, message: "body too large" });

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return rpcError(400, { code: PARSE_ERROR, message: "parse error" });
  }
  const msg = classify(body);
  if (isRpcError(msg)) return rpcError(400, msg);

  // After initialize the client sends the negotiated version; one this server doesn't speak is a 400.
  // Without the header the session's negotiated version applies.
  const version = req.headers.get("mcp-protocol-version");
  const isInitialize = msg.kind === "request" && msg.method === "initialize";
  if (!isInitialize && version !== null && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return rpcError(400, { code: INVALID_REQUEST, message: `unsupported MCP-Protocol-Version: ${version}` });
  }

  const reply = await send(env, msg, req.headers.get(SESSION_HEADER));
  const headers: Record<string, string> = reply.session === undefined ? {} : { [SESSION_HEADER]: reply.session };
  if (reply.body === undefined) return new Response(null, { status: reply.status, headers });
  return jsonResponse(reply.status, reply.body, headers);
}

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  switch (`${req.method} ${url.pathname}`) {
    case "POST /mcp":
      return mcpPost(req, env);
    case "DELETE /mcp": {
      const session = req.headers.get(SESSION_HEADER);
      if (session === null) return rpcError(400, { code: INVALID_REQUEST, message: "missing Mcp-Session-Id" });
      return new Response(null, { status: (await state(env).endSession(session)) ? 204 : 404 });
    }
    case "GET /calls": {
      const raw = url.searchParams.get("since") ?? "0";
      if (!/^\d+$/.test(raw)) return jsonResponse(400, { error: "since must be a non-negative integer" });
      return jsonResponse(200, { calls: await readCalls(env, Number(raw)) });
    }
    case "POST /reset":
      await state(env).reset();
      return jsonResponse(200, { ok: true });
  }
  // No SSE stream is offered, so GET on the MCP endpoint is 405 (Streamable HTTP, listening for messages).
  if (url.pathname === "/mcp") return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
  if (url.pathname === "/calls") return new Response(null, { status: 405, headers: { allow: "GET" } });
  if (url.pathname === "/reset") return new Response(null, { status: 405, headers: { allow: "POST" } });
  return jsonResponse(404, { error: "not found" });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!originAllowed(req, env)) return rpcError(403, { code: INVALID_REQUEST, message: "origin not allowed" });
    if (!env.MCP_TEST_TOKEN) return jsonResponse(500, { error: "MCP_TEST_TOKEN is not set" });
    if (!(await authorized(req, env.MCP_TEST_TOKEN))) {
      return jsonResponse(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="nest-mcp-test"' });
    }
    return route(req, env);
  },
} satisfies ExportedHandler<Env>;
