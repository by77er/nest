// The one SQLite-backed Durable Object holding everything: MCP sessions, notes, counters and the
// log of every tools/call. The Worker authenticates and checks the HTTP framing; this object answers
// the JSON-RPC message.

import { DurableObject } from "cloudflare:workers";
import {
  failure,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  isObject,
  LATEST_VERSION,
  METHOD_NOT_FOUND,
  type Message,
  type Params,
  PROTOCOL_VERSIONS,
  type RpcError,
  success,
} from "./jsonrpc";
import { findTool, runTool, type Store, TOOLS, type ToolResult } from "./tools";
import { OAuthTables, publicOAuthRoute, testOAuthRoute } from "./oauth";

/** What the Worker turns into an HTTP response: a status, an optional JSON body, a new session id. */
export interface Reply {
  status: number;
  body?: unknown;
  session?: string;
}

/** One logged tools/call; result_or_error is null while the call is still running. */
export interface CallRecord {
  seq: number;
  ts_ms: number;
  session: string;
  tool: string | null;
  arguments: unknown;
  _meta: unknown;
  result_or_error: { result: ToolResult } | { error: RpcError } | null;
}

export const MAX_CALLS_PAGE = 1000;

const SERVER_INFO = { name: "nest-mcp-test", title: "nest MCP test server", version: "0.1.0" };
const INSTRUCTIONS =
  "A test server for nest: echo, notes, counters and a slow tool. Every tools/call is logged with its _meta.";

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const parse = (s: unknown): unknown => (typeof s === "string" ? JSON.parse(s) : null);

export class McpState extends DurableObject<Env> implements Store {
  private readonly sql: SqlStorage;
  /** The OAuth mode's authorization server state (src/oauth.ts); its tables stay empty unless MCP_TEST_OAUTH=1. */
  private readonly oauth: OAuthTables;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, protocol_version TEXT NOT NULL, created_ms INTEGER NOT NULL, initialized_ms INTEGER);
      CREATE TABLE IF NOT EXISTS notes (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, total INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS calls (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, session TEXT NOT NULL, tool TEXT, arguments TEXT, meta TEXT, outcome TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
    this.oauth = new OAuthTables(this.sql);
  }

  // --- OAuth mode (src/oauth.ts) ---------------------------------------------------------------

  /**
   * The OAuth routes, forwarded by the Worker once it has checked the Origin (and, for the test routes,
   * the static bearer). `x-mcp-test-login` is the Worker's verdict on the static bearer: the authorize
   * route's stand-in for the user's login.
   */
  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const open = await publicOAuthRoute(req, this.env, url, this.oauth, async () => req.headers.get("x-mcp-test-login") === "1");
    if (open) return open;
    if (req.headers.get("x-mcp-test-login") === "1") {
      const test = testOAuthRoute(req, url, this.oauth);
      if (test) return test;
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
  }

  oauthAccessValid(token: string, resource: string): boolean {
    return this.oauth.oauthAccessValid(token, resource);
  }

  // --- Store -------------------------------------------------------------------------------------

  notePut(key: string, value: string): void {
    this.sql.exec("INSERT INTO notes (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  noteGet(key: string): string | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM notes WHERE key = ?", key).toArray()[0];
    return row?.value ?? null;
  }

  counterAdd(name: string, n: number): number {
    return this.sql
      .exec<{ total: number }>(
        "INSERT INTO counters (name, total) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET total = total + excluded.total RETURNING total",
        name,
        n,
      )
      .one().total;
  }

  // --- MCP ---------------------------------------------------------------------------------------

  /** Answers one classified message arriving with the given Mcp-Session-Id header (or none). */
  async message(msg: Message, sessionId: string | null): Promise<Reply> {
    if (msg.kind === "request" && msg.method === "initialize") return this.initialize(msg.id, msg.params);

    // This server requires a session for everything after initialize (Streamable HTTP, session management).
    if (sessionId === null) return { status: 400, body: failure(undefined, { code: INVALID_REQUEST, message: "missing Mcp-Session-Id" }) };
    if (!this.sessionExists(sessionId)) return { status: 404, body: failure(undefined, { code: INVALID_REQUEST, message: "unknown or terminated session" }) };

    if (msg.kind === "notification") {
      if (msg.method === "notifications/initialized") {
        this.sql.exec("UPDATE sessions SET initialized_ms = coalesce(initialized_ms, ?) WHERE id = ?", Date.now(), sessionId);
      }
      return { status: 202 }; // other notifications (cancelled, progress, ...) are accepted and ignored
    }
    if (msg.kind === "response") return { status: 202 }; // this server sends no requests, so nothing awaits one

    const { id, method, params } = msg;
    switch (method) {
      case "ping":
        return { status: 200, body: success(id, {}) };
      case "tools/list":
        // One page: any cursor is one this server never issued.
        if (params?.cursor !== undefined) return { status: 200, body: failure(id, { code: INVALID_PARAMS, message: "invalid cursor" }) };
        return { status: 200, body: success(id, { tools: TOOLS }) };
      case "tools/call":
        return this.callTool(id, params, sessionId);
      default:
        return { status: 200, body: failure(id, { code: METHOD_NOT_FOUND, message: `method not found: ${method}` }) };
    }
  }

  /** Ends a session (HTTP DELETE): later requests carrying it get 404. */
  endSession(sessionId: string): boolean {
    return this.sql.exec("DELETE FROM sessions WHERE id = ?", sessionId).rowsWritten > 0;
  }

  private sessionExists(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM sessions WHERE id = ?", id).toArray().length > 0;
  }

  private initialize(id: string | number, params: Params | undefined): Reply {
    const info = params?.clientInfo;
    if (
      typeof params?.protocolVersion !== "string" ||
      !isObject(params.capabilities) ||
      !isObject(info) ||
      typeof info.name !== "string" ||
      typeof info.version !== "string"
    ) {
      return {
        status: 200,
        body: failure(id, { code: INVALID_PARAMS, message: "initialize needs protocolVersion, capabilities and clientInfo {name, version}" }),
      };
    }
    // Version negotiation: echo the client's version if supported, else offer the latest this server has.
    const requested = params.protocolVersion;
    const version = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_VERSION;
    const session = crypto.randomUUID();
    this.sql.exec("INSERT INTO sessions (id, protocol_version, created_ms) VALUES (?, ?, ?)", session, version, Date.now());
    return {
      status: 200,
      session,
      body: success(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }),
    };
  }

  private async callTool(id: string | number, params: Params | undefined, session: string): Promise<Reply> {
    const name = params?.name;
    const args = params?.arguments;
    const meta = params?._meta;
    // Logged on arrival, so a call still running shows in /calls in the order it came in.
    const seq = this.nextSeq();
    this.sql.exec(
      "INSERT INTO calls (seq, ts_ms, session, tool, arguments, meta) VALUES (?, ?, ?, ?, ?, ?)",
      seq,
      Date.now(),
      session,
      typeof name === "string" ? name : null,
      json(args),
      json(meta),
    );

    let outcome: { result: ToolResult } | { error: RpcError };
    const tool = typeof name === "string" ? findTool(name) : undefined;
    if (typeof name !== "string" || (args !== undefined && !isObject(args)) || (meta !== undefined && !isObject(meta))) {
      outcome = { error: { code: INVALID_PARAMS, message: "tools/call needs name (a string), and arguments and _meta as objects if present" } };
    } else if (tool === undefined) {
      outcome = { error: { code: INVALID_PARAMS, message: `Unknown tool: ${name}` } };
    } else {
      try {
        outcome = { result: await runTool(tool, (args as Record<string, unknown> | undefined) ?? {}, this, (ms) => new Promise((r) => setTimeout(r, ms))) };
      } catch (e) {
        outcome = { error: { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) } };
      }
    }
    this.sql.exec("UPDATE calls SET outcome = ? WHERE seq = ?", JSON.stringify(outcome), seq);
    return { status: 200, body: "result" in outcome ? success(id, outcome.result) : failure(id, outcome.error) };
  }

  // Sequence numbers never repeat, across resets too, so `since` stays a safe cursor.
  private nextSeq(): number {
    return this.sql
      .exec<{ v: number }>("INSERT INTO meta (k, v) VALUES ('seq', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1 RETURNING v")
      .one().v;
  }

  // --- Test surface ------------------------------------------------------------------------------

  calls(since: number): CallRecord[] {
    return this.sql
      .exec<{ seq: number; ts_ms: number; session: string; tool: string | null; arguments: string | null; meta: string | null; outcome: string | null }>(
        "SELECT * FROM calls WHERE seq > ? ORDER BY seq LIMIT ?",
        since,
        MAX_CALLS_PAGE,
      )
      .toArray()
      .map((r) => ({
        seq: r.seq,
        ts_ms: r.ts_ms,
        session: r.session,
        tool: r.tool,
        arguments: parse(r.arguments),
        _meta: parse(r.meta),
        result_or_error: parse(r.outcome) as CallRecord["result_or_error"],
      }));
  }

  /** Clears notes, counters and the call log. Sessions and the sequence survive. */
  reset(): void {
    this.sql.exec("DELETE FROM notes; DELETE FROM counters; DELETE FROM calls;");
  }
}
