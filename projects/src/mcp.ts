// The MCP servers at /mcp/board, /mcp/task and /mcp/review (README.md#the-mcp-server-agents-see-only-their-own-work):
// MCP Streamable HTTP, one JSON-RPC message per POST, answered with JSON (no SSE, no sessions). The
// methods nest uses (docs/interfaces/remote-mcp/): `initialize`, `notifications/initialized`,
// `tools/list`, `tools/call`. Every request must carry a valid Nest-Identity (src/identity.ts), or it
// gets 401/403 and no data.

import { directory, type Env, project, review } from "./env";
import { type Caller, verifyIdentity } from "./identity";
import { clientIdOf } from "./nest";
import { SERVERS, type Server, TOOLS } from "./tools";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const answer = (id: Rpc["id"], result: unknown) => json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: Rpc["id"], code: number, message: string) => json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** A tool's own failure: the model sees it; it isn't a protocol error. */
const toolError = (id: Rpc["id"], message: string) => answer(id, { content: [{ type: "text", text: message }], isError: true });

export const isServer = (s: string): s is Server => (SERVERS as readonly string[]).includes(s);

export async function handleMcp(request: Request, env: Env, server: Server): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  const client = clientIdOf(env.NEST_CLIENT_TOKEN);
  if (!client) return new Response(null, { status: 503 });
  let verdict;
  try {
    verdict = await verifyIdentity(request.headers.get("nest-identity"), {
      issuer: env.NEST_CONTROL_PLANE, audience: `${env.PUBLIC_BASE_URL}/mcp/${server}`, server, client,
    });
  } catch {
    // nest's keys couldn't be fetched: nothing is proven, so nothing is answered.
    return new Response(null, { status: 503 });
  }
  if (!verdict.ok) return new Response(null, { status: verdict.status });
  const caller = verdict.caller;

  let msg: Rpc;
  try {
    msg = (await request.json()) as Rpc;
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(null, -32600, "invalid request");

  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      const protocolVersion = typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return answer(msg.id, { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: `nest-projects-${server}`, version: "1" } });
    }
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return answer(msg.id, {});
    case "tools/list":
      return answer(msg.id, {
        tools: TOOLS[server].map((t) => ({
          name: t.name, description: t.description, inputSchema: t.inputSchema,
          annotations: { readOnlyHint: !!t.readOnly, idempotentHint: !!t.idempotent, destructiveHint: false },
        })),
      });
    case "tools/call":
      return call(env, server, caller, msg);
    default:
      if (msg.id === undefined) return new Response(null, { status: 202 }); // another notification
      return rpcError(msg.id, -32601, `method ${msg.method} not found`);
  }
}

async function call(env: Env, server: Server, caller: Caller, msg: Rpc): Promise<Response> {
  // The connector lists tools for every agent on the server; it names no agent, so it calls nothing.
  if (caller.kind !== "agent") return new Response(null, { status: 403 });
  const name = msg.params?.name;
  const args = msg.params?.arguments ?? {};
  if (typeof name !== "string") return rpcError(msg.id, -32602, "tools/call needs a name");
  if (typeof args !== "object" || args === null || Array.isArray(args)) return rpcError(msg.id, -32602, "arguments must be an object");
  const meta = msg.params?._meta as Record<string, unknown> | undefined;
  const callKey = typeof meta?.["nest/call"] === "string" ? (meta["nest/call"] as string) : null;

  const id = caller.labels.project!;
  if (!(await directory(env).getProject(id))) return toolError(msg.id, "unknown project");
  const r = server === "review"
    ? await review(env, id).mcpCall(caller, name, args as Record<string, unknown>, callKey)
    : await project(env, id).mcpCall(server, caller, name, args as Record<string, unknown>, callKey);
  // Not this server's agent any more (a replaced manager): refused outright, not a tool's failure.
  if ("forbidden" in r && r.forbidden) return new Response(null, { status: 403 });
  if (r.error !== null || r.result === null) return toolError(msg.id, r.error ?? "no result");
  return answer(msg.id, { content: [{ type: "text", text: r.result }], structuredContent: JSON.parse(r.result) });
}
