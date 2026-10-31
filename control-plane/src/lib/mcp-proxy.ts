// The MCP proxy (docs/agents/capabilities/mcp/): AgentDO's client of each remote MCP server its spec's
// mcp capabilities name. One per AgentDO, so every guarantee is about one agent and checked where its
// epoch and its call ledger live: the epoch is checked in the same synchronous step as the request
// leaves, a forward is recorded before it leaves (write-ahead), and a call key the proxy forwarded
// once is never forwarded again unless the tool is idempotent.
//
// `McpProxy` is the only code that touches the `mcp_servers` and `mcp_forwards` tables.
import { z } from "zod";
import type { ToolOutcome } from "../protocol/control";
import { ErrorCodes } from "../protocol/model";
import { errorBody, NestError } from "./util";
import { storedEnum } from "./stored";
import {
  callResultContent, checkMcpUrl, isIdempotent, type ListedTool, MCP_PROTOCOL_VERSION, MCP_SUPPORTED_VERSIONS, type McpGrant, parseListedTools,
  rpc, type RpcAnswer,
} from "./mcp";

/** A server's tool list is reused this long; an older one is fetched again (and served if that fails). */
export const MCP_LIST_TTL_MS = 5 * 60_000;
/** A call is forwarded at most this many times in all (an idempotent tool's lost answer is retried once). */
export const MCP_MAX_ATTEMPTS = 2;
/** At most this many `tools/list` pages. */
const MAX_LIST_PAGES = 10;
/** How often a call waiting on an older epoch's unsettled forward looks again. */
const FENCE_POLL_MS = 50;

/** `mcp_forwards.status`: sent and not yet settled, or settled (answered, refused, or given up on). */
const ForwardStatus = z.enum(["forwarded", "settled"]);
type ForwardStatus = z.output<typeof ForwardStatus>;

export interface ProxyDeps {
  sql: SqlStorage;
  /** The bearer token a grant's `auth` names (BrokerDO), or null when none is stored. */
  token(ref: string): Promise<string | null>;
  callTimeoutMs: number;
  listTimeoutMs: number;
  allowLoopback: boolean;
}

/** One call's identity and the caller's checks, from AgentDO. */
export interface CallContext {
  agent: string;
  /** The epoch of the call's key. */
  epoch: number;
  /** `<agent>/<epoch>/<call>`: the idempotency key, sent as `_meta["nest/call"]`. */
  key: string;
  /** Awaited before each forward; throws (stale_epoch) when the calling brain is no longer current. */
  live(): Promise<void>;
  /** The session's taint now. */
  tainted(): boolean;
}

/** What a call came to; `from_server`: the outcome holds the server's text (it taints unless trusted). */
export interface McpCallOutcome {
  outcome: ToolOutcome;
  from_server: boolean;
}

interface ServerRow {
  url: string;
  session: string | null;
  version: string | null;
  tools: ListedTool[] | null;
  listed_ms: number;
}

interface ForwardRow {
  key: string;
  epoch: number;
  status: ForwardStatus;
  attempts: number;
  deadline: number;
  outcome: McpCallOutcome | null;
}

const unknown = (why: string): McpCallOutcome => ({
  outcome: { status: "error", error: errorBody(ErrorCodes.OUTCOME_UNKNOWN, `${why}; the call may or may not have taken effect. Check before retrying anything with side effects.`) },
  from_server: false,
});
const platformError = (code: string, message: string, retryable = false): McpCallOutcome =>
  ({ outcome: { status: "error", error: errorBody(code, message, retryable) }, from_server: false });

/** An HTTP refusal (nothing was processed) as a platform error. */
function refusal(cap: string, a: Extract<RpcAnswer, { kind: "refused" }>): McpCallOutcome {
  const what = `the MCP server of ${cap} answered HTTP ${a.status}`;
  if (a.status === 401) return platformError(ErrorCodes.UNAUTHORIZED, `${what}: it refused nest's credential`);
  if (a.status === 403) return platformError(ErrorCodes.FORBIDDEN, `${what}: forbidden`);
  if (a.status === 429) {
    return platformError(ErrorCodes.RATE_LIMITED, `${what}: rate limited${a.retry_after_ms !== undefined ? `; retry after ${Math.ceil(a.retry_after_ms / 1000)} s` : ""}`, true);
  }
  if (a.status >= 300 && a.status < 400) return platformError(ErrorCodes.INVALID_MESSAGE, `${what}: a redirect, which nest doesn't follow`);
  return platformError(ErrorCodes.INVALID_MESSAGE, `${what}: ${a.text}`);
}

export class McpProxy {
  /** Initializations in flight, by capability (one per server at a time). */
  private readonly initializing = new Map<string, Promise<ServerRow>>();

  constructor(private readonly d: ProxyDeps) {
    d.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (capability TEXT PRIMARY KEY, url TEXT NOT NULL, session TEXT, version TEXT,
      tools TEXT, listed_ms INTEGER NOT NULL DEFAULT 0)`);
    d.sql.exec(`CREATE TABLE IF NOT EXISTS mcp_forwards (key TEXT PRIMARY KEY, epoch INTEGER NOT NULL, capability TEXT NOT NULL,
      tool TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, deadline INTEGER NOT NULL, outcome TEXT,
      created_ms INTEGER NOT NULL)`);
  }

  // --- Servers: session and tool list ------------------------------------------------------------------

  /** The stored state for a grant's server; a row for another URL (never expected: specs are fixed) starts over. */
  private server(g: McpGrant): ServerRow {
    const r = this.d.sql.exec<{ url: string; session: string | null; version: string | null; tools: string | null; listed_ms: number }>(
      "SELECT url, session, version, tools, listed_ms FROM mcp_servers WHERE capability = ?", g.capability).toArray()[0];
    if (!r || r.url !== g.url) return { url: g.url, session: null, version: null, tools: null, listed_ms: 0 };
    return { url: r.url, session: r.session, version: r.version, tools: r.tools ? JSON.parse(r.tools) as ListedTool[] : null, listed_ms: r.listed_ms };
  }

  private saveServer(g: McpGrant, s: ServerRow): void {
    this.d.sql.exec(`INSERT INTO mcp_servers (capability, url, session, version, tools, listed_ms) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(capability) DO UPDATE SET url = excluded.url, session = excluded.session, version = excluded.version,
      tools = excluded.tools, listed_ms = excluded.listed_ms`,
    g.capability, s.url, s.session, s.version, s.tools ? JSON.stringify(s.tools) : null, s.listed_ms);
  }

  /** Forget the session (it ended, or the server lost it): the next request initializes again. */
  private dropSession(g: McpGrant, session: string | null): void {
    const s = this.server(g);
    // Only the session that failed: one initialized meanwhile stays.
    if (s.session === session) this.saveServer(g, { ...s, session: null, version: null });
  }

  /** The server's URL, checked again at use (a stored spec predates a tightened rule, or the flag went). */
  private url(g: McpGrant): string {
    const u = checkMcpUrl(g.url, this.d.allowLoopback);
    if (!u.ok) throw new NestError(ErrorCodes.FORBIDDEN, `capability ${g.capability}: ${u.error}`, 403);
    return g.url;
  }

  private async tokenOf(g: McpGrant): Promise<string> {
    const t = await this.d.token(g.auth);
    if (!t) throw new NestError(ErrorCodes.FORBIDDEN, `capability ${g.capability}: no credential stored as ${g.auth}`, 409);
    return t;
  }

  /** An initialized session (`initialize` once, then `notifications/initialized`), reused until it ends. */
  private async session(g: McpGrant, token: string, timeoutMs: number): Promise<ServerRow> {
    const s = this.server(g);
    if (s.version) return s;
    const running = this.initializing.get(g.capability);
    if (running) return running;
    const p = this.initialize(g, token, timeoutMs).finally(() => this.initializing.delete(g.capability));
    this.initializing.set(g.capability, p);
    return p;
  }

  private async initialize(g: McpGrant, token: string, timeoutMs: number): Promise<ServerRow> {
    const url = this.url(g);
    const a = await rpc(url, {
      id: 1, method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "nest", version: "1" } },
    }, { token, session: null, version: null, timeoutMs });
    if (a.kind !== "result") throw this.setupError(g, "initialize", a);
    const version = (a.result as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof version !== "string" || !MCP_SUPPORTED_VERSIONS.includes(version)) {
      throw new NestError(ErrorCodes.UNSUPPORTED_VERSION, `the MCP server of ${g.capability} speaks ${String(version)}; nest speaks ${MCP_SUPPORTED_VERSIONS.join(", ")}`, 502);
    }
    const n = await rpc(url, { method: "notifications/initialized" }, { token, session: a.session, version, timeoutMs });
    if (n.kind !== "result") console.warn(`mcp ${g.capability}: notifications/initialized: ${n.kind}`);
    const s = { ...this.server(g), url: g.url, session: a.session, version };
    this.saveServer(g, s);
    return s;
  }

  /** A failure before any tool was called (initialize, tools/list), as a platform error: nothing ran. */
  private setupError(g: McpGrant, what: string, a: RpcAnswer): NestError {
    const m = `the MCP server of ${g.capability} failed ${what}`;
    switch (a.kind) {
      case "refused": {
        const r = refusal(g.capability, a).outcome as Extract<ToolOutcome, { status: "error" }>;
        return new NestError(r.error.code, r.error.message, 502, r.error.retryable);
      }
      case "rpc_error":
        return new NestError(ErrorCodes.INVALID_MESSAGE, `${m}: ${a.message}`, 502);
      case "lost":
        return new NestError(ErrorCodes.INTERNAL, `${m}: ${a.why}`, 502, true);
      default:
        return new NestError(ErrorCodes.INTERNAL, `${m}: ${a.kind}`, 502, true);
    }
  }

  /**
   * The server's tools, from the cache while it's fresh (`MCP_LIST_TTL_MS`), else fetched again within
   * the list timeout; a failed fetch serves the stale list, or null when there is none.
   */
  async list(g: McpGrant): Promise<ListedTool[] | null> {
    const cached = this.server(g);
    if (cached.tools && Date.now() - cached.listed_ms < MCP_LIST_TTL_MS) return cached.tools;
    try {
      return await this.fetchList(g, Date.now() + this.d.listTimeoutMs);
    } catch (e) {
      console.warn(`mcp ${g.capability}: tools/list failed${cached.tools ? "; serving the cached list" : ""}`, e);
      return cached.tools;
    }
  }

  private async fetchList(g: McpGrant, deadline: number): Promise<ListedTool[]> {
    const token = await this.tokenOf(g);
    const left = () => Math.max(1, deadline - Date.now());
    for (let reinit = 0; ; reinit++) {
      const s = await this.session(g, token, left());
      const tools: ListedTool[] = [];
      let cursor: string | null = null;
      let gone = false;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const a = await rpc(this.url(g), { id: 2 + page, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) },
          { token, session: s.session, version: s.version, timeoutMs: left() });
        if (a.kind === "session_gone") {
          gone = true;
          break;
        }
        if (a.kind !== "result") throw this.setupError(g, "tools/list", a);
        const p = parseListedTools(a.result);
        tools.push(...p.tools);
        cursor = p.next;
        if (!cursor) break;
      }
      if (gone) {
        this.dropSession(g, s.session);
        if (reinit >= 1) throw new NestError(ErrorCodes.INTERNAL, `the MCP server of ${g.capability} ended two sessions in a row`, 502, true);
        continue;
      }
      this.saveServer(g, { ...this.server(g), tools, listed_ms: Date.now() });
      return tools;
    }
  }

  /** A tool's listing (for its annotations): the cache at any age, else a fetch; undefined when unknown. */
  private async listed(g: McpGrant, tool: string): Promise<ListedTool | undefined> {
    const tools = this.server(g).tools ?? (await this.list(g));
    return tools?.find((t) => t.name === tool);
  }

  // --- Forwards -------------------------------------------------------------------------------------------

  private forward(key: string): ForwardRow | undefined {
    const r = this.d.sql.exec<{ key: string; epoch: number; status: string; attempts: number; deadline: number; outcome: string | null }>(
      "SELECT key, epoch, status, attempts, deadline, outcome FROM mcp_forwards WHERE key = ?", key).toArray()[0];
    return r && {
      ...r, status: storedEnum(ForwardStatus, r.status, "mcp_forwards.status"), outcome: r.outcome ? JSON.parse(r.outcome) as McpCallOutcome : null,
    };
  }

  /** Written before the request leaves (write-ahead): an incarnation that dies mid-call leaves this row. */
  private recordForward(ctx: CallContext, g: McpGrant, tool: string, attempts: number): void {
    this.d.sql.exec(`INSERT INTO mcp_forwards (key, epoch, capability, tool, status, attempts, deadline, outcome, created_ms)
      VALUES (?, ?, ?, ?, 'forwarded', ?, ?, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = 'forwarded', attempts = excluded.attempts, deadline = excluded.deadline`,
    ctx.key, ctx.epoch, g.capability, tool, attempts, Date.now() + this.d.callTimeoutMs, Date.now());
  }

  private settle(key: string, o: McpCallOutcome): McpCallOutcome {
    this.d.sql.exec("UPDATE mcp_forwards SET status = 'settled', outcome = ? WHERE key = ?", JSON.stringify(o), key);
    return o;
  }

  /**
   * Fencing: a call waits until every forward of an older epoch of this agent has settled, so the server
   * never sees two brains' calls interleaved. Within one incarnation AgentDO runs calls one at a time,
   * so an unsettled older forward is one an earlier incarnation sent and lost the answer to: it counts
   * as settled once its deadline (the call timeout) passes, and is then settled as unknown.
   */
  private async fenceWait(epoch: number): Promise<void> {
    for (;;) {
      const now = Date.now();
      const open = this.d.sql.exec<{ key: string; deadline: number }>(
        "SELECT key, deadline FROM mcp_forwards WHERE status = 'forwarded' AND epoch < ?", epoch).toArray();
      for (const r of open.filter((r) => r.deadline <= now)) this.settle(r.key, unknown("the answer was lost (nest restarted mid-call)"));
      const waitFor = Math.max(0, ...open.filter((r) => r.deadline > now).map((r) => r.deadline - now));
      if (waitFor === 0) return;
      await new Promise((r) => setTimeout(r, Math.min(FENCE_POLL_MS, waitFor)));
    }
  }

  /**
   * Call `tool` on the grant's server for the call `ctx.key` (docs/agents/capabilities/mcp/):
   * - a key already settled gets its stored outcome, never a second request;
   * - a key forwarded by an earlier incarnation and never answered is `outcome_unknown` unless the tool is idempotent;
   * - each forward waits for older epochs' forwards to settle, then checks the epoch (`ctx.live`) and
   *   is recorded in the same synchronous step as it leaves;
   * - a lost answer (timeout, network, 5xx) is `outcome_unknown`, retried once only when idempotent;
   * - an ended session (404) is initialized again and the call resent: the server processed nothing.
   */
  async call(g: McpGrant, tool: string, args: Record<string, unknown>, ctx: CallContext): Promise<McpCallOutcome> {
    const prior = this.forward(ctx.key);
    if (prior?.status === "settled" && prior.outcome) return prior.outcome;
    const idempotent = isIdempotent(g, tool, await this.listed(g, tool));
    if (prior?.status === "forwarded" && (!idempotent || prior.attempts >= MCP_MAX_ATTEMPTS)) {
      return this.settle(ctx.key, unknown(idempotent
        ? "the answer to every delivery of this call was lost"
        : "the answer to an earlier delivery of this call was lost and the tool isn't idempotent, so it wasn't sent again"));
    }
    await this.fenceWait(ctx.epoch);
    const token = await this.tokenOf(g);
    let attempts = prior?.attempts ?? 0;
    let reinitialized = false;
    for (;;) {
      let s: ServerRow;
      try {
        s = await this.session(g, token, this.d.callTimeoutMs);
        await ctx.live();
      } catch (e) {
        // An earlier attempt (lost answer) is still unsettled: it settles as unknown.
        if (attempts > 0) this.settle(ctx.key, unknown("an earlier attempt's answer was lost, and it couldn't be sent again"));
        throw e;
      }
      // From here to the request leaving there is no await: the epoch was current when it left.
      attempts++;
      this.recordForward(ctx, g, tool, attempts);
      const meta = { "nest/agent": ctx.agent, "nest/epoch": ctx.epoch, "nest/call": ctx.key, "nest/taint": ctx.tainted() };
      const a = await rpc(this.url(g), { id: 100 + attempts, method: "tools/call", params: { name: tool, arguments: args, _meta: meta } },
        { token, session: s.session, version: s.version, timeoutMs: this.d.callTimeoutMs });
      switch (a.kind) {
        case "result": {
          const r = callResultContent(a.result);
          if (!r) return this.settle(ctx.key, unknown(`the MCP server of ${g.capability} answered with something that isn't a tool result`));
          if (r.isError) {
            const text = r.content.map((c) => (c.type === "text" ? c.text : c.type === "json" ? JSON.stringify(c.value) : `[${c.type}]`)).join("\n");
            return this.settle(ctx.key, { outcome: { status: "error", error: errorBody(ErrorCodes.TOOL_ERROR, text || "the tool reported an error") }, from_server: true });
          }
          return this.settle(ctx.key, { outcome: { status: "ok", content: r.content }, from_server: true });
        }
        case "rpc_error":
          return this.settle(ctx.key, { outcome: { status: "error", error: errorBody(ErrorCodes.INVALID_MESSAGE, `MCP error ${a.code}: ${a.message}`) }, from_server: true });
        case "refused":
          return this.settle(ctx.key, refusal(g.capability, a));
        case "too_large":
          return this.settle(ctx.key, platformError(ErrorCodes.INVALID_MESSAGE, `the call ran, but its answer is over 1 MiB, which nest doesn't relay`));
        case "session_gone":
          // The server processed nothing: initialize again and resend, once, whatever the tool.
          this.dropSession(g, s.session);
          attempts--;
          if (reinitialized) return this.settle(ctx.key, platformError(ErrorCodes.INTERNAL, `the MCP server of ${g.capability} ended two sessions in a row`, true));
          reinitialized = true;
          continue;
        case "lost":
          if (idempotent && attempts < MCP_MAX_ATTEMPTS) continue;
          return this.settle(ctx.key, unknown(`the MCP server of ${g.capability} gave no answer (${a.why})`));
      }
    }
  }

  prune(cutoff: number): void {
    this.d.sql.exec("DELETE FROM mcp_forwards WHERE status = 'settled' AND created_ms < ?", cutoff);
  }
}
