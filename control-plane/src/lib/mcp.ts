// Remote MCP capabilities (docs/agents/capabilities/mcp/): the catalog's `mcp` source, what an agent's
// spec keeps of it, tool naming and listing, and the client side of MCP's Streamable HTTP transport.
// Pure except `rpc`, which does one HTTP exchange and classifies what came back; the stateful proxy
// (sessions, the tool cache, the forward ledger, fencing and retries) is lib/mcp-proxy.ts.
import { z } from "zod";
import type { ToolContent, ToolDef } from "../protocol/control";
import { CapRef, OAuthAuth, type OAuthGrant } from "./mcp-auth";
import { argsDigest, gated } from "./sinks";
import { IDENTITY_HEADER } from "./identity";

export { approves, argsDigest } from "./sinks";

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
/** Admission per server (the connector's, docs/agents/capabilities/mcp/#the-connector): calls in flight at once, and calls per minute. */
export const MCP_DEFAULT_MAX_CONCURRENT = 8;
export const MCP_DEFAULT_PER_MINUTE = 120;
/** The notification a server sends when its tool list changed. */
export const LIST_CHANGED = "notifications/tools/list_changed";

/** A remote tool's name as nest admits it: characters a model tool name may hold. */
export const McpToolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "MCP tool names here are letters, digits, '_' and '-'");

/** Per-tool flags: a list of the tools that have it, or a map of tool → whether it has it. */
const ToolFlags = z.union([z.array(McpToolName), z.record(McpToolName, z.boolean())]);
const flags = (f: z.output<typeof ToolFlags> | undefined): Record<string, boolean> =>
  Array.isArray(f) ? Object.fromEntries(f.map((t) => [t, true])) : { ...(f ?? {}) };

/**
 * The `mcp` source of a capability (docs/agents/capabilities/#sources). `auth` names the BrokerDO secret
 * holding the bearer token (`cap:<name>`), or is the oauth form (`{oauth, client?, scopes?}`, lib/mcp-auth.ts),
 * or is absent: no bearer, and `Nest-Identity` is the only credential; `tools` is the allowlist (absent: every tool the server lists); `idempotent`
 * overrides the server's annotations (a list of tools that are, or a map of tool → whether it is);
 * `read_only` likewise marks the tools that aren't sinks; `trusted` (default false) means its list and
 * results don't taint the session (and its annotations count); `when_tainted` is what a sink call from a
 * tainted session needs; `max_concurrent` and `per_minute` cap this server's calls across every agent
 * (the connector's admission; defaults `MCP_DEFAULT_MAX_CONCURRENT`, `MCP_DEFAULT_PER_MINUTE`).
 */
export const McpSource = z.object({
  url: z.string().min(1).max(2048),
  auth: z.union([CapRef, OAuthAuth]).optional(),
  tools: z.array(McpToolName).max(MAX_TOOLS_PER_CAPABILITY).optional(),
  idempotent: ToolFlags.optional(),
  read_only: ToolFlags.optional(),
  trusted: z.boolean().default(false),
  when_tainted: z.enum(["approve", "allow"]).default("approve"),
  max_concurrent: z.number().int().min(1).max(64).optional(),
  per_minute: z.number().int().min(1).max(6000).optional(),
});
export type McpSource = z.output<typeof McpSource>;

/** What an agent's spec keeps of one mcp capability, copied at spawn (nothing refers back to the catalog). */
export interface McpGrant {
  capability: string;
  url: string;
  /**
   * The BrokerDO record of its credential: the bearer secret, or (with `oauth`) where its OAuth tokens are
   * kept. Absent: the server takes no bearer (nest sends no `Authorization`; `Nest-Identity` is the credential).
   */
  auth?: string;
  /** Present when the credential is OAuth (absent in specs written before it, and for a static bearer). */
  oauth?: OAuthGrant;
  /** The allowlist; null: whatever the server lists. */
  tools: string[] | null;
  /** The operator's idempotency overrides, by tool. */
  idempotent: Record<string, boolean>;
  /** The operator's read-only marks, by tool (absent in specs written before sinks were enforced). */
  read_only?: Record<string, boolean>;
  trusted: boolean;
  /** Absent in older specs: `approve`. */
  when_tainted?: "approve" | "allow";
  /** The connector's admission caps; absent: the defaults. */
  max_concurrent?: number;
  per_minute?: number;
  /**
   * The client whose catalog namespace the capability is in (`cli_…`), set at expansion; absent for the
   * operator's capabilities (and in specs written before it). Its connector is that namespace's own, and
   * names the client in its caller identity.
   */
  client?: string;
}

/**
 * The connector a grant's server is shared through (docs/agents/capabilities/mcp/#the-connector): one per
 * server and credential (`null`: none), and per client namespace for a client's capability. A grant with a
 * credential and no client (every grant stored before either could be absent) keeps the name it had.
 */
export const connectorName = (g: Pick<McpGrant, "url" | "auth" | "client">): string =>
  JSON.stringify(["mcp", g.url, g.auth ?? null, ...(g.client ? [g.client] : [])]);

/** Whether two grants share a connector. */
export const sameConnector = (a: Pick<McpGrant, "url" | "auth" | "client">, b: Pick<McpGrant, "url" | "auth" | "client">): boolean =>
  connectorName(a) === connectorName(b);

/** What a spec keeps of capability `capability`'s source; `client`: whose namespace it is in (absent: the operator's). */
export function grantOf(capability: string, src: McpSource, client?: string): McpGrant {
  const auth = src.auth;
  return {
    capability,
    url: src.url,
    ...(auth === undefined ? {} : { auth: typeof auth === "string" ? auth : auth.oauth }),
    ...(auth === undefined || typeof auth === "string" ? {} : { oauth: { client: auth.client ?? null, scopes: auth.scopes ? [...auth.scopes] : null } }),
    tools: src.tools ? [...src.tools] : null,
    idempotent: flags(src.idempotent),
    read_only: flags(src.read_only),
    trusted: src.trusted ?? false,
    when_tainted: src.when_tainted ?? "approve",
    ...(src.max_concurrent !== undefined ? { max_concurrent: src.max_concurrent } : {}),
    ...(src.per_minute !== undefined ? { per_minute: src.per_minute } : {}),
    ...(client ? { client } : {}),
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

/**
 * Whether a call needs the operator's approval first (the sink gate, lib/sinks.ts): a sink (a tool not
 * read-only) called from a tainted session, unless the capability allows it. Read-only is the
 * operator's mark, else a trusted server's `readOnlyHint`: an untrusted server's annotations don't count
 * ("clients MUST consider tool annotations to be untrusted unless they come from trusted servers").
 */
export function needsApproval(grant: McpGrant, tool: string, listed: ListedTool | undefined, tainted: boolean): boolean {
  const marked = grant.read_only?.[tool];
  const readOnly = marked ?? (grant.trusted && listed?.annotations.readOnlyHint === true);
  return gated({ sink: !readOnly, when_tainted: grant.when_tainted ?? "approve", tainted });
}

/** A tool list's identity (SHA-256 of its canonical JSON): two lists with the same digest are the same list. */
export const toolsDigest = (tools: readonly ListedTool[]): Promise<string> => argsDigest(tools);

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
  /**
   * A response with a result (`session`: the `Mcp-Session-Id` header it carried, if any;
   * `list_changed`: the SSE stream also carried `notifications/tools/list_changed`).
   */
  | { kind: "result"; result: unknown; session: string | null; list_changed?: true }
  /** A JSON-RPC error response: the server refused or failed the request. */
  | { kind: "rpc_error"; code: number; message: string; list_changed?: true }
  /** An HTTP refusal (4xx; a redirect, which nest doesn't follow): the request wasn't processed. */
  | { kind: "refused"; status: number; text: string; retry_after_ms?: number; challenge?: string }
  /** 404 to a request that named a session: the session ended, nothing was processed; initialize again. */
  | { kind: "session_gone" }
  /** The server answered, but more than `MAX_ANSWER_BYTES`. */
  | { kind: "too_large" }
  /** No usable answer (timeout, network, a 5xx, an unparseable body): it may or may not have been processed. */
  | { kind: "lost"; why: string };

export interface RpcOptions {
  /** The bearer; null: no `Authorization` header (a server that takes `Nest-Identity` alone). */
  token: string | null;
  session: string | null;
  /** The negotiated version (sent as `MCP-Protocol-Version` after initialize). */
  version: string | null;
  timeoutMs: number;
  /** The caller identity (`Nest-Identity`, lib/identity.ts), derived by the caller as the request leaves. */
  identity: string;
  /** The fetch to send with (the platform's by default; a metered one records the request, lib/outbound.ts). */
  fetchFn?: typeof fetch;
}

/** The caller identity for the next request, made ready as it leaves (each request asks again: the state it names may change between them). */
export type IdentityFor = () => Promise<string>;

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
    ...(o.token === null ? {} : { authorization: `Bearer ${o.token}` }),
    [IDENTITY_HEADER]: o.identity,
  };
  if (o.session) headers["mcp-session-id"] = o.session;
  if (o.version) headers["mcp-protocol-version"] = o.version;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
  try {
    // Called as a plain function (the global fetch as a method of another object throws in workerd).
    const fetchFn = o.fetchFn ?? fetch;
    const res = await fetchFn(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...message }), signal: ctl.signal, redirect: "manual" });
    if (res.status === 404 && o.session) {
      await res.body?.cancel().catch(() => undefined);
      return { kind: "session_gone" };
    }
    if (res.status >= 300 && res.status < 500) {
      const text = ((await readCapped(res)) ?? "").slice(0, 300);
      const ra = retryAfterMs(res.headers.get("retry-after"));
      const challenge = res.headers.get("www-authenticate")?.slice(0, 1000);
      return { kind: "refused", status: res.status, text, ...(ra !== undefined ? { retry_after_ms: ra } : {}), ...(challenge ? { challenge } : {}) };
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
    // A server may send notifications on a request's SSE stream before its response (transports).
    const changed = candidates.some((m) => !!m && typeof m === "object" && (m as { method?: unknown }).method === LIST_CHANGED)
      ? { list_changed: true as const } : {};
    if (reply.error) {
      return { kind: "rpc_error", code: typeof reply.error.code === "number" ? reply.error.code : 0, message: String(reply.error.message ?? "error").slice(0, 2000), ...changed };
    }
    if (!("result" in reply)) return { kind: "lost", why: "a response with neither result nor error" };
    return { kind: "result", result: reply.result, session, ...changed };
  } catch (e) {
    return { kind: "lost", why: ctl.signal.aborted ? `no answer within ${o.timeoutMs} ms` : `network: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

// --- Sessions and listing (AgentDO's proxy and the connector both open sessions) ------------------------

/** What opening a session came to. */
export type Opened =
  | { kind: "open"; session: string | null; version: string }
  | { kind: "failed"; answer: RpcAnswer }
  | { kind: "unsupported"; version: unknown };

/** `initialize`, then `notifications/initialized` (lifecycle); the session id, if the server gave one. */
export async function openSession(url: string, token: string | null, timeoutMs: number, client: string, identity: IdentityFor): Promise<Opened> {
  const id = await identity();
  const a = await rpc(url, {
    id: 1, method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: client, version: "1" } },
  }, { token, session: null, version: null, timeoutMs, identity: id });
  if (a.kind !== "result") return { kind: "failed", answer: a };
  const version = (a.result as { protocolVersion?: unknown } | null)?.protocolVersion;
  if (typeof version !== "string" || !MCP_SUPPORTED_VERSIONS.includes(version)) return { kind: "unsupported", version };
  const id2 = await identity();
  const n = await rpc(url, { method: "notifications/initialized" }, { token, session: a.session, version, timeoutMs, identity: id2 });
  if (n.kind !== "result") console.warn(`mcp ${new URL(url).host}: notifications/initialized: ${n.kind}`);
  return { kind: "open", session: a.session, version };
}

/** At most this many `tools/list` pages. */
const MAX_LIST_PAGES = 10;

/** Every `tools/list` page over one session, within `deadline` (epoch ms). */
export async function listAll(url: string, token: string | null, s: { session: string | null; version: string }, deadline: number, identity: IdentityFor):
  Promise<{ kind: "listed"; tools: ListedTool[]; list_changed: boolean } | { kind: "session_gone" } | { kind: "failed"; answer: RpcAnswer }> {
  const tools: ListedTool[] = [];
  let cursor: string | null = null;
  let changed = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const id = await identity();
    const a = await rpc(url, { id: 2 + page, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) },
      { token, session: s.session, version: s.version, timeoutMs: Math.max(1, deadline - Date.now()), identity: id });
    if (a.kind === "session_gone") return a;
    if (a.kind !== "result") return { kind: "failed", answer: a };
    changed ||= a.list_changed === true;
    const p = parseListedTools(a.result);
    tools.push(...p.tools);
    cursor = p.next;
    if (!cursor) break;
  }
  return { kind: "listed", tools, list_changed: changed };
}
