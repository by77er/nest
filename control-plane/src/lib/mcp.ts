// Remote MCP capabilities (docs/agents/capabilities/mcp/): the catalog's `mcp` source, what an agent's
// spec keeps of it, tool naming and listing, and the client side of MCP's Streamable HTTP transport.
// Pure except `rpc`, which does one HTTP exchange and classifies what came back; the stateful proxy
// (sessions, the tool cache, the forward ledger, fencing and retries) is lib/mcp-proxy.ts.
import { z } from "zod";
import type { ToolContent, ToolDef } from "../protocol/control";

/** The MCP version nest asks for, and the ones it accepts a server answering with. */
export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SUPPORTED_VERSIONS: readonly string[] = ["2025-11-25", "2025-06-18", "2025-03-26"];

/** Claude Code's prefix for nest's tools; a remote tool reaches the model as `mcp__nest__<capability>_<tool>`. */
export const NEST_TOOL_PREFIX = "mcp__nest__";
/** A tool name the Messages API accepts is at most 64 characters (unverified for Claude Code's MCP names; conservative). */
export const MAX_MODEL_TOOL_NAME = 64;
/** At most this many tools per capability are listed. */
export const MAX_TOOLS_PER_CAPABILITY = 128;
/** A listed tool's description is clipped to this many characters. */
export const MAX_DESCRIPTION = 2_000;
/** A server's answer (one HTTP body) is read up to this many bytes. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

/** A remote tool's name as nest admits it: characters a model tool name may hold. */
export const McpToolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "MCP tool names here are letters, digits, '_' and '-'");

/**
 * The `mcp` source of a capability (docs/agents/capabilities/#sources). `auth` names the BrokerDO secret
 * holding the bearer token; `tools` is the allowlist (absent: every tool the server lists); `idempotent`
 * overrides the server's annotations (a list of tools that are, or a map of tool → whether it is);
 * `trusted` (default false) means its results don't taint the session.
 */
export const McpSource = z.object({
  url: z.string().min(1).max(2048),
  auth: z.string().regex(/^cap:[A-Za-z0-9_.:-]{1,128}$/, "auth names a BrokerDO secret, cap:<name>"),
  tools: z.array(McpToolName).max(MAX_TOOLS_PER_CAPABILITY).optional(),
  idempotent: z.union([z.array(McpToolName), z.record(McpToolName, z.boolean())]).optional(),
  trusted: z.boolean().default(false),
});
export type McpSource = z.output<typeof McpSource>;

/** What an agent's spec keeps of one mcp capability, copied at spawn (nothing refers back to the catalog). */
export interface McpGrant {
  capability: string;
  url: string;
  auth: string;
  /** The allowlist; null: whatever the server lists. */
  tools: string[] | null;
  /** The operator's idempotency overrides, by tool. */
  idempotent: Record<string, boolean>;
  trusted: boolean;
}

export function grantOf(capability: string, src: McpSource): McpGrant {
  const idem = src.idempotent;
  return {
    capability,
    url: src.url,
    auth: src.auth,
    tools: src.tools ? [...src.tools] : null,
    idempotent: Array.isArray(idem) ? Object.fromEntries(idem.map((t) => [t, true])) : { ...(idem ?? {}) },
    trusted: src.trusted ?? false,
  };
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A server URL nest will call: `https`, no credentials or fragment. A loopback host (with `http` or
 * `https`) only when `allowLoopback` (the Worker's `ALLOW_LOOPBACK_MCP=1`: tests and local dev).
 */
export function checkMcpUrl(raw: string, allowLoopback: boolean): Result<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: `${raw} is not a URL` };
  }
  if (u.username || u.password) return { ok: false, error: "the URL carries credentials: put the token in BrokerDO and name it in auth" };
  if (u.hash) return { ok: false, error: "the URL has a fragment" };
  const loopback = LOOPBACK.has(u.hostname);
  if (loopback && !allowLoopback) return { ok: false, error: "a loopback URL is accepted only in local development (ALLOW_LOOPBACK_MCP=1)" };
  if (u.protocol === "https:") return { ok: true, value: u };
  if (u.protocol === "http:" && loopback) return { ok: true, value: u };
  return { ok: false, error: "an MCP server URL must be https" };
}

/** `<capability>_<tool>`: capability names hold no `_`, so the first one splits it back. */
export const mcpToolName = (capability: string, tool: string) => `${capability}_${tool}`;

export function splitMcpToolName(name: string): { capability: string; tool: string } | null {
  const i = name.indexOf("_");
  if (i <= 0 || i === name.length - 1) return null;
  return { capability: name.slice(0, i), tool: name.slice(i + 1) };
}

/** Why an mcp capability's name can't be used: it would make tool names a platform tool already has. */
export function capabilityNameClash(capability: string, platform: readonly string[]): string | null {
  const clash = platform.find((t) => t.startsWith(`${capability}_`));
  return clash ? `an mcp capability named ${capability} would shadow the platform tool ${clash}` : null;
}

/** The grant and remote tool a model-facing name means, `forbidden` when the allowlist leaves it out, null when no grant has it. */
export function mcpTarget(grants: readonly McpGrant[], name: string): { grant: McpGrant; tool: string } | "forbidden" | null {
  const parts = splitMcpToolName(name);
  if (!parts || !McpToolName.safeParse(parts.tool).success) return null;
  const grant = grants.find((g) => g.capability === parts.capability);
  if (!grant) return null;
  if (grant.tools && !grant.tools.includes(parts.tool)) return "forbidden";
  return { grant, tool: parts.tool };
}

/** A tool as the server lists it (the fields nest reads). */
export interface ListedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations: { readOnlyHint?: boolean; idempotentHint?: boolean; destructiveHint?: boolean };
}

/** One `tools/list` page's tools, keeping only well-formed entries. */
export function parseListedTools(result: unknown): { tools: ListedTool[]; next: string | null } {
  const r = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
  const tools: ListedTool[] = [];
  for (const t of Array.isArray(r.tools) ? r.tools : []) {
    if (!t || typeof t !== "object" || typeof (t as { name?: unknown }).name !== "string") continue;
    const o = t as { name: string; description?: unknown; inputSchema?: unknown; annotations?: unknown };
    const a = (o.annotations && typeof o.annotations === "object" ? o.annotations : {}) as Record<string, unknown>;
    const flag = (k: string) => (typeof a[k] === "boolean" ? { [k]: a[k] as boolean } : {});
    tools.push({
      name: o.name,
      description: typeof o.description === "string" ? o.description : "",
      inputSchema: o.inputSchema && typeof o.inputSchema === "object" ? o.inputSchema : { type: "object" },
      annotations: { ...flag("readOnlyHint"), ...flag("idempotentHint"), ...flag("destructiveHint") },
    });
  }
  return { tools, next: typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null };
}

/**
 * The model-facing definitions of a grant's tools: the allowlist's (or all), named `<capability>_<tool>`,
 * with the server's input schema. A name a platform tool has, or one too long for a model tool name, is left out.
 */
export function mcpToolDefs(grant: McpGrant, listed: readonly ListedTool[], platform: readonly string[]): ToolDef[] {
  const out: ToolDef[] = [];
  for (const t of listed) {
    if (out.length >= MAX_TOOLS_PER_CAPABILITY) break;
    if (!McpToolName.safeParse(t.name).success) continue;
    if (grant.tools && !grant.tools.includes(t.name)) continue;
    const name = mcpToolName(grant.capability, t.name);
    if (platform.includes(name) || NEST_TOOL_PREFIX.length + name.length > MAX_MODEL_TOOL_NAME) continue;
    out.push({ name, description: t.description.slice(0, MAX_DESCRIPTION), input_schema: t.inputSchema, roles: [], requires_approval: false });
  }
  return out;
}

/**
 * Whether a lost answer may be retried: the operator's override, else the server's annotations
 * (`readOnlyHint` or `idempotentHint`), else not.
 */
export function isIdempotent(grant: McpGrant, tool: string, listed: ListedTool | undefined): boolean {
  const o = grant.idempotent[tool];
  if (o !== undefined) return o;
  return listed?.annotations.readOnlyHint === true || listed?.annotations.idempotentHint === true;
}

/** A `tools/call` result as nest's tool content, or null when it isn't a CallToolResult. */
export function callResultContent(result: unknown): { content: ToolContent[]; isError: boolean } | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: unknown };
  if (!Array.isArray(r.content)) return null;
  const content: ToolContent[] = [];
  for (const c of r.content as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    switch (c.type) {
      case "text":
        content.push({ type: "text", text: String(c.text ?? "") });
        break;
      case "image":
        if (typeof c.data === "string" && typeof c.mimeType === "string") content.push({ type: "image", media_type: c.mimeType, data_b64: c.data });
        break;
      case "resource_link":
        content.push({ type: "text", text: `[resource ${String(c.uri ?? "")}${c.name ? ` (${String(c.name)})` : ""}]` });
        break;
      case "resource": {
        const res = (c.resource ?? {}) as { uri?: unknown; text?: unknown };
        content.push({ type: "text", text: typeof res.text === "string" ? res.text : `[binary resource ${String(res.uri ?? "")}]` });
        break;
      }
      default:
        content.push({ type: "text", text: `[${String(c.type)} content omitted]` });
    }
  }
  if (content.length === 0 && r.structuredContent !== undefined) content.push({ type: "json", value: r.structuredContent });
  return { content, isError: r.isError === true };
}

// --- The transport -------------------------------------------------------------------------------------

/** What one JSON-RPC exchange came to. */
export type RpcAnswer =
  /** A response with a result (`session`: the `Mcp-Session-Id` header it carried, if any). */
  | { kind: "result"; result: unknown; session: string | null }
  /** A JSON-RPC error response: the server refused or failed the request. */
  | { kind: "rpc_error"; code: number; message: string }
  /** An HTTP refusal (4xx; a redirect, which nest doesn't follow): the request wasn't processed. */
  | { kind: "refused"; status: number; text: string; retry_after_ms?: number }
  /** 404 to a request that named a session: the session ended, nothing was processed; initialize again. */
  | { kind: "session_gone" }
  /** The server answered, but more than `MAX_ANSWER_BYTES`. */
  | { kind: "too_large" }
  /** No usable answer (timeout, network, a 5xx, an unparseable body): it may or may not have been processed. */
  | { kind: "lost"; why: string };

export interface RpcOptions {
  token: string;
  session: string | null;
  /** The negotiated version (sent as `MCP-Protocol-Version` after initialize). */
  version: string | null;
  timeoutMs: number;
}

const decoder = new TextDecoder();

/** The body, at most `MAX_ANSWER_BYTES`, or null when it is longer. */
async function readCapped(res: Response): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return decoder.decode(all);
}

/** JSON-RPC messages in an SSE body: each event's `data` lines joined. */
export function sseMessages(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // not JSON: skipped
    }
  }
  return out;
}

const retryAfterMs = (h: string | null): number | undefined => {
  const s = h === null ? NaN : Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 600_000) : undefined;
};

/**
 * POST one JSON-RPC request (or, with no `id`, a notification) to `url`, within `timeoutMs` for the
 * whole exchange. Never throws. Redirects aren't followed (a refusal): a token is never replayed to
 * another origin.
 */
export async function rpc(url: string, message: { method: string; params?: unknown; id?: number }, o: RpcOptions): Promise<RpcAnswer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${o.token}`,
  };
  if (o.session) headers["mcp-session-id"] = o.session;
  if (o.version) headers["mcp-protocol-version"] = o.version;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    // The global fetch, called as a plain function (as a method of another object it throws in workerd).
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal: ctl.signal, redirect: "manual" });
    if (res.status === 404 && o.session) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "session_gone" };
    }
    if (res.status >= 300 && res.status < 500) {
      const text = ((await readCapped(res)) ?? "").slice(0, 300);
      const ra = retryAfterMs(res.headers.get("retry-after"));
      return { kind: "refused", status: res.status, text, ...(ra !== undefined ? { retry_after_ms: ra } : {}) };
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "lost", why: `HTTP ${res.status}` };
    }
    const session = res.headers.get("mcp-session-id");
    const body = await readCapped(res);
    if (body === null) return { kind: "too_large" };
    if (message.id === undefined) return { kind: "result", result: null, session };
    const type = res.headers.get("content-type") ?? "";
    let candidates: unknown[];
    if (type.includes("text/event-stream")) {
      candidates = sseMessages(body);
    } else {
      try {
        candidates = [JSON.parse(body)];
      } catch {
        return { kind: "lost", why: `HTTP ${res.status} with a body that isn't JSON` };
      }
    }
    const reply = candidates.find((m) => !!m && typeof m === "object" && (m as { id?: unknown }).id === message.id) as
      { result?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
    if (!reply) return { kind: "lost", why: `HTTP ${res.status} without a response to request ${message.id}` };
    if (reply.error) {
      return { kind: "rpc_error", code: typeof reply.error.code === "number" ? reply.error.code : 0, message: String(reply.error.message ?? "error").slice(0, 2000) };
    }
    if (!("result" in reply)) return { kind: "lost", why: "a response with neither result nor error" };
    return { kind: "result", result: reply.result, session };
  } catch (e) {
    return { kind: "lost", why: ctl.signal.aborted ? `no answer within ${o.timeoutMs} ms` : `network: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}
