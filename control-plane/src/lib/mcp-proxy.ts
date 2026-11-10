// The MCP proxy (docs/agents/capabilities/mcp/): AgentDO's client of each remote MCP server its spec's
// mcp capabilities name. One per AgentDO, so every guarantee is about one agent and checked where its
// epoch and its call ledger live: the epoch is checked in the same synchronous step as the request
// leaves, a forward is recorded before it leaves (write-ahead), and a call key the proxy forwarded
// once is never forwarded again unless the tool is idempotent.
//
// What is shared per server is the connector's (do/mcp-connector.ts): the tool list, and admission (a
// lease on one of the server's call slots, taken before the epoch check). The connector never forwards
// a call and never decides the fence.
//
// `McpProxy` is the only code that touches the `mcp_servers` and `mcp_forwards` tables.
import { z } from "zod";
import type { Env } from "../env";
import type { ToolOutcome } from "../protocol/control";
import { ErrorCodes } from "../protocol/model";
import { asNestError, errorBody, NestError } from "./util";
import { storedEnum } from "./stored";
import { bearerChallenge, mcpBearer } from "./mcp-auth";
import {
  callResultContent, checkMcpUrl, isIdempotent, type ListedTool, MCP_DEFAULT_MAX_CONCURRENT, MCP_DEFAULT_PER_MINUTE, MCP_SUPPORTED_VERSIONS,
  type McpGrant, openSession, rpc, type RpcAnswer,
} from "./mcp";

/** A server's tool list is reused this long (by the connector); an older one is fetched again (and served if that fails). */
export const MCP_LIST_TTL_MS = 5 * 60_000;
/** A call is forwarded at most this many times in all (an idempotent tool's lost answer is retried once). */
export const MCP_MAX_ATTEMPTS = 2;
/** How often a call waiting on an older epoch's unsettled forward looks again. */
const FENCE_POLL_MS = 50;
/** How often a call refused admission (no slot free) asks again, at most. */
const ADMIT_POLL_MS = 250;
/** How many times a request's identity is signed again because the session's taint changed meanwhile, before the call is refused. */
const IDENTITY_TRIES = 3;

/**
 * The bearer to send to a grant's server (`mcpBearer`: its static secret or its OAuth access token);
 * with `refused`, a replacement for the bearer the server just answered 401 to, or null. The one place
 * nest obtains an MCP credential: AgentDO's proxy (calls) and the connector (listing) both come here.
 */
export function mcpToken(env: Env, g: McpGrant, refused?: string): Promise<string | null> {
  return mcpBearer(env.BROKER.get(env.BROKER.idFromName("broker")), g, refused);
}

/** What the connector hands out (do/mcp-connector.ts). */
export interface ConnectorList {
  /** The server's tools, or null when it has never been listed. */
  tools: ListedTool[] | null;
  listed_ms: number;
}
/** A lease on one of the server's call slots, or when to ask again. */
export type Admission = { lease: string } | { retry_after_ms: number };

/** The connector of a grant's server, as the proxy uses it. */
export interface McpConnector {
  /** The shared list; `subscriber`: the agent whose brain is handed it (told when it changes). */
  list(g: McpGrant, subscriber: string | null): Promise<ConnectorList>;
  /** The server said its list changed (`notifications/tools/list_changed` on a call's stream). */
  changed(g: McpGrant): Promise<void>;
  acquire(g: McpGrant, agent: string, holdMs: number): Promise<Admission>;
  release(lease: string): Promise<void>;
}

/** `mcp_forwards.status`: sent and not yet settled, or settled (answered, refused, or given up on). */
const ForwardStatus = z.enum(["forwarded", "settled"]);
export type ForwardStatus = z.output<typeof ForwardStatus>;
export const FORWARD_STATUSES = ForwardStatus.options;

/** What happens to a forward: an attempt leaves (`forward`), or it gets its outcome (`settle`). (One never settled is deleted by age: `prune`.) */
export const FORWARD_EVENTS = ["forward", "settle"] as const;
export type ForwardEvent = (typeof FORWARD_EVENTS)[number];

/**
 * The forward ledger's one step (`none`: no row yet): the status after `event`, or `refuse`. `settled` is
 * final: a settled call is never sent again. Nothing settles before it was forwarded. Every change of
 * `mcp_forwards.status` goes through it. (Which outcome a settled row keeps is `settle`'s rule.)
 */
export function forwardStep(status: ForwardStatus | "none", event: ForwardEvent): ForwardStatus | "refuse" {
  if (status === "none") return event === "forward" ? "forwarded" : "refuse";
  if (status === "forwarded") return event === "forward" ? "forwarded" : "settled";
  return "refuse";
}

export interface ProxyDeps {
  sql: SqlStorage;
  /** This agent's id. */
  agent(): string;
  /**
   * The bearer to send to a grant's server (`mcpToken` → `mcpBearer`, lib/mcp-auth.ts: a static secret
   * or an OAuth access token): null when none is stored. With `refused`, the bearer the server just
   * answered 401 to: a replacement, or null when there is none.
   */
  bearer(g: McpGrant, refused?: string): Promise<string | null>;
  /** The connector of a grant's server. */
  connector(g: McpGrant): McpConnector;
  /**
   * The caller identity (`Nest-Identity`, lib/identity.ts) for a request to `aud` from the brain of
   * `epoch` with the session's taint `tainted`: `ensure` signs one if none is cached (a BrokerDO round
   * trip), `current` is the cached one or null, read synchronously as the request leaves.
   */
  identity: {
    ensure(aud: string, epoch: number, tainted: boolean): Promise<void>;
    current(aud: string, epoch: number, tainted: boolean): string | null;
  };
  /** Work that outlives the call (a release, a change report). */
  background(p: Promise<unknown>): void;
  callTimeoutMs: number;
  /** How long a call waits for admission before it is refused (`rate_limited`, nothing sent). */
  admitWaitMs: number;
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

/**
 * The bearer for one request sequence. A 401 means the request wasn't processed, so it may be sent
 * again with a replacement, once (`renewed`): a server that refuses the fresh one too is refused.
 */
interface Bearer {
  /** Null: the grant names no credential, so no `Authorization` is sent and there is nothing to renew. */
  value: string | null;
  renewed: boolean;
}

/** `initialize` was answered 401 (nothing was processed): the caller may renew the bearer and try again. */
class BearerRefused extends Error {
  constructor(readonly error: NestError) {
    super(error.message);
  }
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
function refusal(cap: string, a: Extract<RpcAnswer, { kind: "refused" }>, oauth = false, bearerless = false): McpCallOutcome {
  const what = `the MCP server of ${cap} answered HTTP ${a.status}`;
  const again = `POST /v1/admin/capabilities/${cap}/oauth`;
  if (a.status === 401) {
    if (bearerless) return platformError(ErrorCodes.UNAUTHORIZED, `${what}: it refused nest's caller identity (the capability names no bearer, so Nest-Identity is the only credential sent)`);
    return platformError(ErrorCodes.UNAUTHORIZED, `${what}: it refused nest's credential${oauth ? ` (a fresh OAuth token too); the operator may need to authorize it again (${again})` : ""}`);
  }
  if (a.status === 403) {
    // RFC 6750 §3.1 / the spec's step-up: the challenge names the scopes this request needs.
    const c = bearerChallenge(a.challenge ?? null);
    if (oauth && c?.error === "insufficient_scope") {
      return platformError(ErrorCodes.FORBIDDEN, `${what}: insufficient_scope${c.scope ? `; it needs ${c.scope}` : ""}. The operator authorizes it again with those scopes (${again} {"scopes": [...]})`);
    }
    return platformError(ErrorCodes.FORBIDDEN, `${what}: forbidden`);
  }
  if (a.status === 429) {
    return platformError(ErrorCodes.RATE_LIMITED, `${what}: rate limited${a.retry_after_ms !== undefined ? `; retry after ${Math.ceil(a.retry_after_ms / 1000)} s` : ""}`, true);
  }
  if (a.status >= 300 && a.status < 400) return platformError(ErrorCodes.INVALID_MESSAGE, `${what}: a redirect, which nest doesn't follow`);
  return platformError(ErrorCodes.INVALID_MESSAGE, `${what}: ${a.text}`);
}

/** A failure before any tool was called (initialize, tools/list), as a platform error: nothing ran. */
export function setupError(g: McpGrant, what: string, a: RpcAnswer): NestError {
  const m = `the MCP server of ${g.capability} failed ${what}`;
  switch (a.kind) {
    case "refused": {
      const r = refusal(g.capability, a, !!g.oauth, g.auth === undefined).outcome as Extract<ToolOutcome, { status: "error" }>;
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

const identityUnsettled = (g: McpGrant) => new NestError(ErrorCodes.INTERNAL,
  `the call to the MCP server of ${g.capability} wasn't sent: the session's taint kept changing while its identity was signed`, 503, true);

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

  /** The one place the proxy gets a server's bearer (lib/mcp-auth.ts decides what it is); none for a grant naming no credential. */
  private async bearerOf(g: McpGrant): Promise<Bearer> {
    if (g.auth === undefined) return { value: null, renewed: true };
    const t = await this.d.bearer(g);
    if (!t) throw new NestError(ErrorCodes.FORBIDDEN, `capability ${g.capability}: no credential stored as ${g.auth}`, 409);
    return { value: t, renewed: false };
  }

  /** After a 401: a replacement bearer, once per request sequence; false when there is none (the 401 stands). */
  private async renew(g: McpGrant, b: Bearer): Promise<boolean> {
    if (b.renewed || b.value === null) return false;
    b.renewed = true;
    const t = await this.d.bearer(g, b.value);
    if (!t) return false;
    b.value = t;
    return true;
  }

  /** An initialized session (`initialize` once, then `notifications/initialized`), reused until it ends. */
  private async session(g: McpGrant, token: string | null, timeoutMs: number, ctx: CallContext): Promise<ServerRow> {
    const s = this.server(g);
    if (s.version) return s;
    const running = this.initializing.get(g.capability);
    if (running) return running;
    const p = this.initialize(g, token, timeoutMs, ctx).finally(() => this.initializing.delete(g.capability));
    this.initializing.set(g.capability, p);
    return p;
  }

  private async initialize(g: McpGrant, token: string | null, timeoutMs: number, ctx: CallContext): Promise<ServerRow> {
    const o = await openSession(this.url(g), token, timeoutMs, "nest", () => this.identityFor(g, ctx));
    if (o.kind === "failed" && o.answer.kind === "refused" && o.answer.status === 401) throw new BearerRefused(setupError(g, "initialize", o.answer));
    if (o.kind === "failed") throw setupError(g, "initialize", o.answer);
    if (o.kind === "unsupported") {
      throw new NestError(ErrorCodes.UNSUPPORTED_VERSION, `the MCP server of ${g.capability} speaks ${String(o.version)}; nest speaks ${MCP_SUPPORTED_VERSIONS.join(", ")}`, 502);
    }
    const s = { ...this.server(g), url: g.url, session: o.session, version: o.version };
    this.saveServer(g, s);
    return s;
  }

  /**
   * The server's tools, from its connector (which keeps one list per server and credential); `brain`:
   * the list is handed to this agent's brain, which the connector then tells when the list changes.
   * The list is also kept here, so a call can read its tool's annotations without a round trip; when
   * the connector can't answer, that copy is served (at any age), or null when there is none.
   */
  async list(g: McpGrant, brain = false): Promise<ListedTool[] | null> {
    try {
      const r = await this.d.connector(g).list(g, brain ? this.d.agent() : null);
      if (!r.tools) return this.server(g).tools;
      this.saveServer(g, { ...this.server(g), url: g.url, tools: r.tools, listed_ms: r.listed_ms });
      return r.tools;
    } catch (e) {
      const cached = this.server(g).tools;
      console.warn(`mcp ${g.capability}: the connector couldn't list${cached ? "; serving the copy kept here" : ""}`, e);
      return cached;
    }
  }

  /** A tool's listing (for its annotations): the copy kept here at any age, else the connector's; undefined when unknown. */
  async listed(g: McpGrant, tool: string): Promise<ListedTool | undefined> {
    const tools = this.server(g).tools ?? (await this.list(g));
    return tools?.find((t) => t.name === tool);
  }

  // --- Caller identity ------------------------------------------------------------------------------------

  /**
   * A caller identity for a request to the grant's server from `ctx`'s brain, for the session's taint
   * as this returns (the caller sends it without another await). Signed again when the taint changed
   * while it was being signed; refused (nothing sent) if it keeps changing.
   */
  private async identityFor(g: McpGrant, ctx: CallContext): Promise<string> {
    for (let i = 0; i < IDENTITY_TRIES; i++) {
      await this.d.identity.ensure(g.url, ctx.epoch, ctx.tainted());
      const t = this.d.identity.current(g.url, ctx.epoch, ctx.tainted());
      if (t) return t;
    }
    throw identityUnsettled(g);
  }

  // --- Forwards -------------------------------------------------------------------------------------------

  /** Whether this call key was forwarded already (its redelivery isn't gated again). */
  forwarded(key: string): boolean {
    return this.forward(key) !== undefined;
  }

  private forward(key: string): ForwardRow | undefined {
    const r = this.d.sql.exec<{ key: string; epoch: number; status: string; attempts: number; deadline: number; outcome: string | null }>(
      "SELECT key, epoch, status, attempts, deadline, outcome FROM mcp_forwards WHERE key = ?", key).toArray()[0];
    return r && {
      ...r, status: storedEnum(ForwardStatus, r.status, "mcp_forwards.status"), outcome: r.outcome ? JSON.parse(r.outcome) as McpCallOutcome : null,
    };
  }

  /**
   * Written before the request leaves (write-ahead): an incarnation that dies mid-call leaves this row.
   * False when the call settled already (another delivery of it finished meanwhile): nothing is recorded
   * and the caller sends nothing.
   */
  private recordForward(ctx: CallContext, g: McpGrant, tool: string, attempts: number): boolean {
    const to = forwardStep(this.forward(ctx.key)?.status ?? "none", "forward");
    if (to === "refuse") return false;
    this.d.sql.exec(`INSERT INTO mcp_forwards (key, epoch, capability, tool, status, attempts, deadline, outcome, created_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(key) DO UPDATE SET status = excluded.status, attempts = excluded.attempts, deadline = excluded.deadline`,
    ctx.key, ctx.epoch, g.capability, tool, to, attempts, Date.now() + this.d.callTimeoutMs, Date.now());
    return true;
  }

  /**
   * The call's outcome (`forwardStep`). The outcome that stands: `o`, or the one the row already had.
   * A settled row keeps its outcome, with one exception: the server's own answer replaces an outcome
   * nest made itself (an "unknown", a refusal or error of the platform's: another delivery of the call
   * settled it so while this one's request was still out), so the row says what the server said once
   * anyone knows. The server's own answer is never replaced.
   */
  private settle(key: string, o: McpCallOutcome): McpCallOutcome {
    const row = this.forward(key);
    const to = forwardStep(row?.status ?? "none", "settle");
    if (to === "refuse") {
      if (!(row?.status === "settled" && row.outcome && !row.outcome.from_server && o.from_server)) return row?.outcome ?? o;
      this.d.sql.exec("UPDATE mcp_forwards SET outcome = ? WHERE key = ?", JSON.stringify(o), key);
      return o;
    }
    this.d.sql.exec("UPDATE mcp_forwards SET status = ?, outcome = ? WHERE key = ?", to, JSON.stringify(o), key);
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
   * - each forward waits for older epochs' forwards to settle, then for a call slot on the server (the
   *   connector's admission), then checks the epoch (`ctx.live`) and is recorded in the same synchronous
   *   step as it leaves;
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
    const attempts = prior?.attempts ?? 0;
    let lease: string;
    let bearer: Bearer;
    try {
      bearer = await this.bearerOf(g);
      lease = await this.admit(g);
    } catch (e) {
      // An earlier attempt (lost answer) is still unsettled: it settles as unknown.
      if (attempts > 0) this.settle(ctx.key, unknown("an earlier attempt's answer was lost, and it couldn't be sent again"));
      throw e;
    }
    try {
      return await this.forwardAdmitted(g, tool, args, ctx, bearer, attempts, idempotent);
    } finally {
      this.d.background(this.d.connector(g).release(lease).catch((e) => console.warn(`mcp ${g.capability}: releasing a call slot failed (it expires)`, e)));
    }
  }

  /**
   * A call slot on the grant's server (its connector's admission: `max_concurrent` at once, `per_minute`
   * a minute, across every agent), waited for up to `admitWaitMs`. Taken before the epoch check, which
   * still comes after every await. Refused: `rate_limited`, and nothing was sent.
   */
  private async admit(g: McpGrant): Promise<string> {
    const until = Date.now() + this.d.admitWaitMs;
    const hold = this.d.callTimeoutMs * (MCP_MAX_ATTEMPTS + 2);
    let failure: unknown = null;
    for (;;) {
      let wait = ADMIT_POLL_MS;
      try {
        const a = await this.d.connector(g).acquire(g, this.d.agent(), hold);
        if ("lease" in a) return a.lease;
        wait = Math.max(10, Math.min(a.retry_after_ms, ADMIT_POLL_MS));
        failure = null;
      } catch (e) {
        failure = e;
      }
      if (Date.now() + wait > until) {
        if (failure) {
          console.warn(`mcp ${g.capability}: the connector couldn't admit the call`, failure);
          throw new NestError(ErrorCodes.INTERNAL, `the call to the MCP server of ${g.capability} couldn't be admitted (nest's connector didn't answer); nothing was sent`, 503, true);
        }
        throw new NestError(ErrorCodes.RATE_LIMITED, `the MCP server of ${g.capability} is at nest's cap (${g.max_concurrent ?? MCP_DEFAULT_MAX_CONCURRENT} calls at once, ${g.per_minute ?? MCP_DEFAULT_PER_MINUTE} a minute, across agents); nothing was sent`, 429, true);
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  private async forwardAdmitted(g: McpGrant, tool: string, args: Record<string, unknown>, ctx: CallContext, bearer: Bearer, attempts: number,
    idempotent: boolean): Promise<McpCallOutcome> {
    let reinitialized = false;
    let identityTries = 0;
    for (;;) {
      let s: ServerRow;
      let identity: string | null;
      let tainted: boolean;
      try {
        try {
          s = await this.session(g, bearer.value, this.d.callTimeoutMs, ctx);
        } catch (e) {
          if (!(e instanceof BearerRefused)) throw e;
          if (await this.renew(g, bearer)) continue;
          throw e.error;
        }
        await this.identityFor(g, ctx);
        await ctx.live();
        // The identity names the taint as the request leaves: one that changed across `live` signs again.
        tainted = ctx.tainted();
        identity = this.d.identity.current(g.url, ctx.epoch, tainted);
        if (!identity && ++identityTries >= IDENTITY_TRIES) throw identityUnsettled(g);
      } catch (e) {
        // An earlier attempt (lost answer) is still unsettled: it settles as unknown.
        if (attempts > 0) this.settle(ctx.key, unknown("an earlier attempt's answer was lost, and it couldn't be sent again"));
        throw e;
      }
      if (!identity) continue;
      // From here to the request leaving there is no await: the epoch was current when it left, and the
      // identity and `_meta` name the same epoch and taint.
      attempts++;
      // Settled while this delivery waited (another delivery of the call finished): its outcome, nothing sent.
      if (!this.recordForward(ctx, g, tool, attempts)) return this.forward(ctx.key)!.outcome!;
      const meta = { "nest/agent": ctx.agent, "nest/epoch": ctx.epoch, "nest/call": ctx.key, "nest/taint": tainted };
      const a = await rpc(this.url(g), { id: 100 + attempts, method: "tools/call", params: { name: tool, arguments: args, _meta: meta } },
        { token: bearer.value, session: s.session, version: s.version, timeoutMs: this.d.callTimeoutMs, identity });
      if ((a.kind === "result" || a.kind === "rpc_error") && a.list_changed) {
        this.d.background(this.d.connector(g).changed(g).catch((e) => console.warn(`mcp ${g.capability}: reporting a changed tool list failed`, e)));
      }
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
        case "refused": {
          if (a.status === 401 && !bearer.renewed) {
            // The server processed nothing: with a replacement bearer it is sent again (fenced again first).
            let renewed: boolean;
            try {
              renewed = await this.renew(g, bearer);
            } catch (e) {
              const ne = asNestError(e);
              if (!ne) throw e;
              return this.settle(ctx.key, platformError(ne.code, ne.detail, ne.retryable));
            }
            if (renewed) {
              attempts--;
              continue;
            }
          }
          return this.settle(ctx.key, refusal(g.capability, a, !!g.oauth, g.auth === undefined));
        }
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

  /**
   * Rows older than `cutoff` go, whatever their status: a forward still unsettled that long after it left
   * can't settle on its own (its deadline passed long ago), so it is deleted with the settled ones.
   */
  prune(cutoff: number): void {
    this.d.sql.exec("DELETE FROM mcp_forwards WHERE created_ms < ?", cutoff);
  }
}
