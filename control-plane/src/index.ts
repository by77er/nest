// nest control plane Worker: HTTP API, enrollment, WebSocket routing to Durable Objects.
import "reflect-metadata";
import { z } from "zod";
import { num, type Env } from "./env";
import { CmsRsaIdentityVerifier, type InstanceIdentity } from "./lib/aws-identity";
import { bearer, type HostClaims, verifyBlobUrl, verifyHostToken } from "./lib/tokens";
import { asNestError, errorResponse, json, NestError, newId, timingSafeEqual } from "./lib/util";
import { checkHealth, healthProbes } from "./lib/health";
import { CONFIG_DIGEST } from "./lib/build";
import { EnrollRequest, LaunchConfig, ToolRule } from "./protocol/control";
import { AclEntry, type Caller, ChannelName, MAX_RETENTION_DAYS, parseChannel, SubscribeInput } from "./lib/channels";
import { Capability, CatalogName, OperatorOverrides, Template } from "./lib/spec";
import { type Actor, LedgerName, type SpecGrant, type TaskOp, TaskPriority, TaskStatus } from "./lib/tasks";
import { LIST_DEFAULT_LIMIT, ledgerStub } from "./do/tasks";
import { DIRECTORY } from "./do/channel";
import { Port, WorkstreamPolicyLayer } from "./do/sandbox";
import { AgentRole, ErrorCodes, type ErrorBody, HostId, HostRole, PROTOCOL_VERSION, Resources } from "./protocol/model";

export { AgentDO } from "./do/agent";
export { BrokerDO } from "./do/broker";
export { CatalogDO } from "./do/catalog";
export { ChannelDO } from "./do/channel";
export { FleetDO } from "./do/fleet";
export { SandboxDO } from "./do/sandbox";
export { TaskLedgerDO } from "./do/tasks";
export { WorkstreamDO } from "./do/workstream";

const DEFAULT_CELL = "local";

/**
 * The last settled health check in this isolate, reused for `HEALTH_REUSE_MS`. Only a settled result
 * is shared: a request never awaits I/O another request started (and may have been cancelled with).
 */
let lastHealth: { at: number; result: Awaited<ReturnType<typeof checkHealth>> } | null = null;
const HEALTH_REUSE_MS = 3_000;

async function sharedHealth(env: Env): ReturnType<typeof checkHealth> {
  if (lastHealth && Date.now() - lastHealth.at <= HEALTH_REUSE_MS) return lastHealth.result;
  const result = await checkHealth(healthProbes(env));
  lastHealth = { at: Date.now(), result };
  return result;
}
/** A host may reconnect its fleet channel this long after its token expired (and gets a fresh one). */
const FLEET_TOKEN_GRACE_MS = 24 * 3_600_000;


/** Cells are names of FleetDOs: well-formed, and from the configured list when there is one. */
function checkCell(env: Env, cell: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(cell)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "invalid cell name");
  const allowed = env.CELLS?.split(",").map((c) => c.trim()).filter(Boolean);
  if (allowed?.length && !allowed.includes(cell)) throw new NestError(ErrorCodes.FORBIDDEN, `unknown cell ${cell}`, 403);
  return cell;
}

const fleet = (env: Env, cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandbox = (env: Env, id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const agent = (env: Env, id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const workstream = (env: Env, id: string) => env.WORKSTREAM.get(env.WORKSTREAM.idFromName(id));
const broker = (env: Env) => env.BROKER.get(env.BROKER.idFromName("broker"));
const catalog = (env: Env) => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const channel = (env: Env, name: string) => env.CHANNEL.get(env.CHANNEL.idFromName(name));
/** The operator, as a channel caller: `user`, the root. */
const USER: Caller = { principal: "user" };

/** An agent id that names an agent (404 otherwise): the subscriber or owner a route records. */
async function existingAgent(env: Env, id: string): Promise<{ workstream: string }> {
  return await agent(env, id).info();
}

/** Parse the JSON body against `schema`; an `optional` body may be empty (parsed as `{}`). */
async function body<T extends z.ZodType>(req: Request, schema: T, optional = false): Promise<z.output<T>> {
  const text = await req.text();
  let raw: unknown;
  try {
    raw = optional && !text.trim() ? {} : JSON.parse(text);
  } catch {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "body must be JSON");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, r.error.message);
  return r.data;
}

function requireAdmin(req: Request, env: Env): void {
  const token = bearer(req);
  const enc = new TextEncoder();
  if (!token || !env.ADMIN_TOKEN || !timingSafeEqual(enc.encode(token), enc.encode(env.ADMIN_TOKEN))) {
    throw new NestError(ErrorCodes.UNAUTHORIZED, "admin token required", 401);
  }
}

const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

async function enroll(req: Request, env: Env): Promise<Response> {
  const r = await body(req, EnrollRequest);
  if (r.protocol_version !== PROTOCOL_VERSION) {
    throw new NestError(ErrorCodes.UNSUPPORTED_VERSION, `server speaks ${PROTOCOL_VERSION}`);
  }
  let identity: InstanceIdentity | null = null;
  try {
    return await enrollWith(r, env, identity);
  } catch (e) {
    // The refusal reaches only the host; log it so an operator can see why a host doesn't join.
    const err = asNestError(e);
    console.warn(`enroll refused (${r.proof.type}, cell ${r.cell}): ${err ? `${err.code}: ${err.message}` : String(e)}`);
    throw e;
  }
}

async function enrollWith(r: z.infer<typeof EnrollRequest>, env: Env, identity: InstanceIdentity | null): Promise<Response> {
  if (r.proof.type === "aws_identity_document") {
    if (!env.AWS_IDENTITY_CERT_PEM) throw new NestError(ErrorCodes.UNAUTHORIZED, "AWS identity enrollment is not configured", 401);
    identity = await new CmsRsaIdentityVerifier(env.AWS_IDENTITY_CERT_PEM).verify(r.proof.document_b64, r.proof.pkcs7_b64);
  }
  return json(await fleet(env, checkCell(env, r.cell)).enroll(r, r.cell, identity));
}

/** A client's id for a submission (body `request_id` or `Idempotency-Key`): a retry with it is applied once. */
const RequestIdField = z.string().min(1).max(128).optional();

/** Task fields the operator may set (the core checks their bounds); `parent: null` clears it. */
const TaskEditsBody = z.strictObject({
  title: z.string().optional(),
  description: z.string().optional(),
  status: TaskStatus.optional(),
  priority: TaskPriority.optional(),
  labels: z.array(z.string()).optional(),
  parent: z.string().nullable().optional(),
});
function requestId(req: Request, fromBody: string | undefined): string | undefined {
  const header = req.headers.get("idempotency-key") ?? undefined;
  const id = fromBody ?? header;
  if (id !== undefined && (id.length === 0 || id.length > 128)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "request id must be 1-128 characters");
  return id === undefined ? undefined : `api/${id}`;
}

// --- routing ---------------------------------------------------------------------------------------

/**
 * Who may call a route, a required field of each: `none` (health, enrollment, signed blob URLs),
 * `host` (a host token; `graceMs` admits a recently expired one), or `admin` (the operator's token).
 */
type Auth = "none" | "host" | "admin";
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** `:name` segments of a route's path, as an object type. */
type Params<P extends string> = P extends `${string}:${infer K}/${infer Rest}` ? { [k in K]: string } & Params<`/${Rest}`>
  : P extends `${string}${":" | "*"}${infer K}` ? { [k in K]: string } : unknown;
interface Ctx<P extends string, B> {
  req: Request;
  env: Env;
  url: URL;
  p: Params<P>;
  body: B;
  /** The admin API's `?cell=` (default `local`), checked. */
  cell: string;
  /** A `host` route's verified token. */
  claims: HostClaims;
}
interface Route {
  method: Method;
  path: string;
  auth: Auth;
  graceMs?: number;
  body?: z.ZodType;
  /** The body may be empty (parsed as `{}`). */
  optionalBody?: boolean;
  status?: number;
  /** A Response passes through; `undefined` answers `{ok: true}`; anything else is JSON with `status`. */
  run(c: Ctx<string, unknown>): Promise<unknown>;
}
function route<P extends string, S extends z.ZodType | undefined = undefined>(r: {
  method: Method; path: P; auth: Auth; graceMs?: number; body?: S; optionalBody?: boolean; status?: number;
  run(c: Ctx<P, S extends z.ZodType ? z.output<S> : undefined>): Promise<unknown>;
}): Route {
  return r as unknown as Route;
}

/** What a path parameter must look like, by name (ids as `newId` makes them); any other is one segment. */
const PARAM: Record<string, RegExp> = {
  agent: /^agt_[A-Za-z0-9]+$/,
  sandbox: /^sbx_[A-Za-z0-9]+$/,
  host: /^hst_[A-Za-z0-9]+$/,
  ws: /^ws_[A-Za-z0-9]+$/,
  ask: /^ask_[A-Za-z0-9]+$/,
  sub: /^sub_[a-z0-9_]+$/,
  port: /^\d+$/,
  secret: /^[A-Za-z0-9_:.-]+$/,
};

/** Match `path` against a route pattern: `:name` is one segment, `*name` the rest (at least one). */
function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/");
  const got = path.split("/");
  const p: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    if (w.startsWith("*")) {
      const rest = got.slice(i).join("/");
      if (!rest) return null;
      p[w.slice(1)] = rest;
      return p;
    }
    const g = got[i];
    if (!w.startsWith(":")) {
      if (w !== g) return null;
    } else {
      const name = w.slice(1);
      if (!g || (PARAM[name] && !PARAM[name]!.test(g))) return null;
      p[name] = g;
    }
  }
  return got.length === want.length ? p : null;
}

async function hostClaims(req: Request, env: Env, graceMs = 0): Promise<HostClaims> {
  const token = bearer(req);
  if (!token) throw new NestError(ErrorCodes.UNAUTHORIZED, "host token required", 401);
  return verifyHostToken(env.HOST_TOKEN_SECRET, token, Date.now(), graceMs);
}

/** A host-authenticated WebSocket, forwarded to its DO with the token's host and cell. */
function forwardSocket(c: Ctx<string, unknown>): Request {
  if (!isUpgrade(c.req)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "expected a WebSocket upgrade", 426);
  const headers = new Headers(c.req.headers);
  headers.set("x-nest-host", c.claims.host);
  headers.set("x-nest-cell", c.claims.cell);
  return new Request(c.req.url, { headers, method: "GET" });
}

/** A channel route's name (one URL-encoded segment, `agt_…%2Finbox`); an agent's built-in channel needs its agent. */
async function channelOf(env: Env, encoded: string): Promise<string> {
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "bad channel name encoding");
  }
  const kind = parseChannel(name);
  if (!kind.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, kind.error);
  if (kind.value.kind === "inbox" || kind.value.kind === "events") await existingAgent(env, kind.value.agent);
  return name;
}

function catalogName(raw: string): string {
  const name = CatalogName.safeParse(raw);
  if (!name.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, name.error.message);
  return name.data;
}

function ledgerOf(env: Env, raw: string) {
  const parsed = LedgerName.safeParse(raw);
  if (!parsed.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, parsed.error.issues[0]!.message);
  return { name: parsed.data, l: ledgerStub(env, parsed.data) };
}
const OPERATOR: Actor = { kind: "operator" };
const AgentOrNull = z.string().startsWith("agt_").nullable();
/** An agent's grant as its spec states it (null: unassign / no watcher). */
async function grantOf(env: Env, id: string | null): Promise<SpecGrant | null> {
  if (id === null) return null;
  const a = await agent(env, id).info();
  return { agent: id, ledger: a.params?.ledger ?? null, tools: a.tools };
}

export const ROUTES: Route[] = [
  // Unauthenticated: one read-only round trip to each DO class's own health instance, nothing else,
  // shared by this isolate's requests for a few seconds so a flood can't multiply it.
  route({ method: "GET", path: "/v1/health", auth: "none", run: async ({ env }) => {
    const h = await sharedHealth(env);
    return json({ ok: h.ok, protocol_version: PROTOCOL_VERSION, config: CONFIG_DIGEST, durable_objects: h.durable_objects }, h.ok ? 200 : 503);
  } }),
  route({ method: "POST", path: "/v1/hosts/enroll", auth: "none", run: ({ req, env }) => enroll(req, env) }),
  // Worker-signed blob URLs (no R2 S3 credentials anywhere): session segments for `claude --resume`.
  route({ method: "GET", path: "/v1/blobs/*key", auth: "none", run: async ({ env, url, p }) => {
    const key = p.key.split("/").map(decodeURIComponent).join("/");
    if (!(await verifyBlobUrl(env.HOST_TOKEN_SECRET, key, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
      throw new NestError(ErrorCodes.UNAUTHORIZED, "bad or expired signature", 403);
    }
    const obj = await env.BUCKET.get(key);
    if (!obj) throw new NestError(ErrorCodes.INVALID_MESSAGE, "no such blob", 404);
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
  } }),

  // Host-authenticated: object-store GC (a sandbox host runs it; FleetDO says when and from what), and
  // the WebSockets. Only the fleet channel accepts a recently expired token: FleetDO rotates it right after hello.
  route({ method: "POST", path: "/v1/hosts/gc/claim", auth: "host", run: async ({ env, claims }) => {
    const c = await fleet(env, checkCell(env, claims.cell)).gcClaim(claims.host);
    return c ? json(c) : new Response(null, { status: 204 });
  } }),
  route({
    method: "POST", path: "/v1/hosts/gc/report", auth: "host", body: z.object({ run: z.string().startsWith("gc_"), report: z.record(z.string(), z.unknown()) }),
    run: ({ env, claims, body: r }) => fleet(env, checkCell(env, claims.cell)).gcReport(claims.host, r.run, r.report),
  }),
  route({ method: "GET", path: "/v1/fleet", auth: "host", graceMs: FLEET_TOKEN_GRACE_MS, run: async (c) => fleet(c.env, c.claims.cell).fetch(forwardSocket(c)) }),
  route({ method: "GET", path: "/v1/agents/:agent/session", auth: "host", run: async (c) => agent(c.env, c.p.agent).fetch(forwardSocket(c)) }),

  // The admin API: hosts and the fleet.
  route({
    method: "POST", path: "/v1/admin/enrollment-tokens", auth: "admin", body: z.object({ role: HostRole, cell: z.string().default(DEFAULT_CELL) }),
    run: async ({ env, body: r }) => ({ token: await fleet(env, checkCell(env, r.cell)).mintEnrollmentToken(r.role), cell: r.cell }),
  }),
  route({
    method: "POST", path: "/v1/admin/launched", auth: "admin",
    body: z.object({
      instance_id: z.string(), role: HostRole.default("burst"), account_id: z.string().optional(), region: z.string().optional(),
      cell: z.string().default(DEFAULT_CELL),
    }),
    run: ({ env, body: r }) => fleet(env, checkCell(env, r.cell)).registerLaunched({
      instance_id: r.instance_id, role: r.role, ...(r.account_id ? { account_id: r.account_id } : {}), ...(r.region ? { region: r.region } : {}),
    }),
  }),
  route({ method: "POST", path: "/v1/admin/hosts/:host/confirm-dead", auth: "admin", run: ({ env, cell, p }) => fleet(env, cell).confirmHostDead(p.host) }),
  route({ method: "GET", path: "/v1/admin/hosts/:host", auth: "admin", run: ({ env, cell, p }) => fleet(env, cell).hostStatus(p.host) }),
  route({ method: "GET", path: "/v1/admin/fleet", auth: "admin", run: ({ env, cell }) => fleet(env, cell).fleetView() }),
  route({ method: "GET", path: "/v1/admin/images", auth: "admin", run: ({ env, cell }) => fleet(env, cell).images() }),
  // The daily tunnel sweep, now (after a Cloudflare outage, or to see what the account holds).
  route({ method: "POST", path: "/v1/admin/tunnels/sweep", auth: "admin", run: ({ env, cell }) => fleet(env, cell).tunnelSweep() }),
  route({ method: "GET", path: "/v1/admin/gc", auth: "admin", run: ({ env, cell }) => fleet(env, cell).gcStatus() }),
  route({ method: "POST", path: "/v1/admin/gc/run", auth: "admin", run: async ({ env, cell }) => {
    await fleet(env, cell).gcRequest();
    return { ok: true, note: "the next sandbox host to check in runs it (dry run until one completes)" };
  } }),
  route({
    method: "POST", path: "/v1/admin/gc/register", auth: "admin", body: z.object({ sandboxes: z.array(z.string().startsWith("sbx_")) }),
    run: async ({ env, cell, body: r }) => ({ live: await fleet(env, cell).registerSandboxes(r.sandboxes) }),
  }),
  route({ method: "GET", path: "/v1/admin/root-ca", auth: "admin", run: async ({ env, cell }) =>
    new Response(await fleet(env, cell).rootCertificatePem(), { headers: { "content-type": "application/x-pem-file" } }) }),
  route({
    method: "PUT", path: "/v1/admin/secrets/:secret", auth: "admin", body: z.object({ value: z.string(), expires_ms: z.number().int().optional() }),
    run: ({ env, p, body: r }) => {
      // BrokerDO's own keys (the per-cell binding signing keys) are generated, never provided.
      if (p.secret.startsWith("binding_key:")) throw new NestError(ErrorCodes.FORBIDDEN, "binding keys are generated by the broker, not provided", 403);
      return broker(env).putSecret(p.secret, r.value, r.expires_ms);
    },
  }),

  // Templates and capabilities (docs/agents/capabilities/): data the operator edits.
  route({ method: "GET", path: "/v1/admin/catalog", auth: "admin", run: ({ env }) => catalog(env).catalog() }),
  route({ method: "PUT", path: "/v1/admin/capabilities/:name", auth: "admin", body: Capability, run: ({ env, p, body }) => catalog(env).putCapability(catalogName(p.name), body) }),
  route({ method: "PUT", path: "/v1/admin/templates/:name", auth: "admin", body: Template, run: ({ env, p, body }) => catalog(env).putTemplate(catalogName(p.name), body) }),
  route({ method: "DELETE", path: "/v1/admin/capabilities/:name", auth: "admin", run: ({ env, p }) => catalog(env).deleteCapability(catalogName(p.name)) }),
  route({ method: "DELETE", path: "/v1/admin/templates/:name", auth: "admin", run: ({ env, p }) => catalog(env).deleteTemplate(catalogName(p.name)) }),

  // Channels (docs/channels/): the operator is `user`, the root.
  route({
    method: "POST", path: "/v1/admin/channels", auth: "admin", status: 201,
    body: z.object({ name: ChannelName, retention_days: z.number().int().min(1).max(MAX_RETENTION_DAYS).optional() }),
    run: ({ env, body: r }) => channel(env, r.name).create(r.name, USER, r.retention_days),
  }),
  route({ method: "GET", path: "/v1/admin/channels", auth: "admin", run: ({ env, url }) =>
    channel(env, DIRECTORY).dirList(url.searchParams.get("prefix") ?? "", url.searchParams.get("after") ?? "", num(url.searchParams.get("limit") ?? undefined, 200)) }),
  route({ method: "GET", path: "/v1/admin/channels/:channel", auth: "admin", run: async ({ env, p }) => {
    const name = await channelOf(env, p.channel);
    return channel(env, name).info(name);
  } }),
  route({ method: "GET", path: "/v1/admin/channels/:channel/messages", auth: "admin", run: async ({ env, url, p }) => {
    const name = await channelOf(env, p.channel);
    const q = url.searchParams;
    const flag = (k: string) => q.get(k) === "true" || q.get(k) === "1";
    const int = (k: string) => (q.has(k) ? num(q.get(k) ?? undefined, 0) : undefined);
    const since = int("since");
    const limit = int("limit");
    return channel(env, name).read(name, USER, {
      ...(since !== undefined ? { since } : {}), ...(limit !== undefined ? { limit } : {}),
      ...(flag("latest_by_key") ? { latest_by_key: true } : {}), ...(q.has("prefix") ? { prefix: q.get("prefix")! } : {}),
      ...(flag("keys_only") ? { keys_only: true } : {}), ...(q.has("after_key") ? { after_key: q.get("after_key")! } : {}),
    });
  } }),
  route({ method: "POST", path: "/v1/admin/channels/:channel/messages", auth: "admin", body: z.unknown(), run: async ({ env, p, body }) => {
    const name = await channelOf(env, p.channel);
    const r = await channel(env, name).post(name, USER, body);
    return json(r, r.status === "conflict" ? 409 : r.status === "posted" ? 201 : 200);
  } }),
  route({ method: "GET", path: "/v1/admin/channels/:channel/subscriptions", auth: "admin", run: async ({ env, p }) => {
    const name = await channelOf(env, p.channel);
    return channel(env, name).subscriptions(name);
  } }),
  route({
    // On an agent's behalf (a spawner subscribing its child is the operator here until agent_spawn exists).
    method: "POST", path: "/v1/admin/channels/:channel/subscriptions", auth: "admin", status: 201,
    body: z.object({ agent: z.string().regex(PARAM.agent!) }).passthrough(),
    run: async ({ env, p, body: r }) => {
      const name = await channelOf(env, p.channel);
      await existingAgent(env, r.agent);
      const { agent: who, ...rest } = r;
      const input = SubscribeInput.safeParse(rest);
      if (!input.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, input.error.message);
      return channel(env, name).subscribe(name, USER, who, input.data);
    },
  }),
  route({ method: "DELETE", path: "/v1/admin/channels/:channel/subscriptions/:sub", auth: "admin", run: async ({ env, p }) => {
    const name = await channelOf(env, p.channel);
    return channel(env, name).unsubscribe(name, USER, p.sub);
  } }),
  route({ method: "PUT", path: "/v1/admin/channels/:channel/acl", auth: "admin", body: z.array(AclEntry), run: async ({ env, p, body }) => {
    const name = await channelOf(env, p.channel);
    return channel(env, name).setAcl(name, body);
  } }),

  // Workstreams: the interim workstream channel (docs/orchestration/workstreams/).
  route({
    method: "POST", path: "/v1/workstreams", auth: "admin", status: 201,
    body: z.object({ goal: z.string(), subscriber: z.string().startsWith("agt_").nullable().optional() }),
    run: ({ env, body: r }) => {
      // A subscriber must be an agent of the workstream, and a new one has none yet.
      if (r.subscriber) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, "a new workstream has no agents yet: set its subscriber once one is spawned in it");
      }
      const id = newId("ws_");
      return workstream(env, id).init(id, r.goal, null);
    },
  }),
  route({ method: "GET", path: "/v1/workstreams/:ws", auth: "admin", run: ({ env, p }) => workstream(env, p.ws).info() }),
  route({ method: "GET", path: "/v1/workstreams/:ws/events", auth: "admin", run: ({ env, url, p }) =>
    workstream(env, p.ws).events(num(url.searchParams.get("limit") ?? undefined, 100)) }),
  route({ method: "GET", path: "/v1/workstreams/:ws/notifications", auth: "admin", run: ({ env, p }) => workstream(env, p.ws).userNotifications() }),
  route({
    method: "PUT", path: "/v1/workstreams/:ws/subscriber", auth: "admin", body: z.object({ subscriber: z.string().startsWith("agt_").nullable().optional() }),
    run: async ({ env, p, body: { subscriber } }) => {
      if (subscriber === undefined) throw new NestError(ErrorCodes.INVALID_MESSAGE, "subscriber is required (an agent id, or null)");
      if (subscriber) {
        // Only an agent of this workstream reads its channel (its events come from that workstream's agents).
        const other = (await existingAgent(env, subscriber)).workstream;
        if (other !== p.ws) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${subscriber} is in workstream ${other}, not ${p.ws}`, 409);
      }
      await workstream(env, p.ws).setSubscriber(subscriber);
    },
  }),

  // Task ledgers (docs/control-plane/durable-objects/tasks/): named, with the operator as the root.
  route({ method: "GET", path: "/v1/ledgers/:ledger", auth: "admin", run: ({ env, p }) => {
    const { name, l } = ledgerOf(env, p.ledger);
    return l.info(name, OPERATOR);
  } }),
  route({
    method: "PUT", path: "/v1/ledgers/:ledger/watcher", auth: "admin", body: z.object({ watcher: AgentOrNull, request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => {
      const { name, l } = ledgerOf(env, p.ledger);
      return l.apply(name, OPERATOR, { kind: "set_watcher", watcher: await grantOf(env, r.watcher) }, requestId(req, r.request_id));
    },
  }),
  route({ method: "GET", path: "/v1/ledgers/:ledger/tasks", auth: "admin", run: ({ env, url, p }) => {
    const { name, l } = ledgerOf(env, p.ledger);
    const q = (k: string) => url.searchParams.get(k) ?? undefined;
    const status = q("status");
    // A query string has no null: `assignee=none` is the unassigned filter here.
    const assignee = q("assignee");
    if (status !== undefined && !TaskStatus.safeParse(status).success) throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown status ${status}`);
    return l.list(name, OPERATOR, {
      status: status as TaskStatus | undefined, assignee: assignee === "none" ? null : assignee, label: q("label"), text: q("text"), parent: q("parent"),
    }, num(q("cursor"), 0), num(q("limit"), LIST_DEFAULT_LIMIT));
  } }),
  route({
    method: "POST", path: "/v1/ledgers/:ledger/tasks", auth: "admin", status: 201,
    body: TaskEditsBody.extend({ title: z.string(), assignee: AgentOrNull.optional(), request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => {
      const { name, l } = ledgerOf(env, p.ledger);
      const { assignee, request_id, ...edits } = r;
      const grant = await grantOf(env, assignee ?? null);
      const op: TaskOp = { kind: "create", ...edits, parent: edits.parent ?? undefined, ...(grant ? { assignee: grant } : {}) };
      return (await l.apply(name, OPERATOR, op, requestId(req, request_id))).task;
    },
  }),
  route({ method: "GET", path: "/v1/ledgers/:ledger/tasks/:task", auth: "admin", run: ({ env, p }) => {
    const { name, l } = ledgerOf(env, p.ledger);
    return l.get(name, OPERATOR, p.task);
  } }),
  route({
    method: "PATCH", path: "/v1/ledgers/:ledger/tasks/:task", auth: "admin",
    body: TaskEditsBody.extend({ expected_version: z.number().int().optional(), request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => {
      const { name, l } = ledgerOf(env, p.ledger);
      const { request_id, ...edits } = r;
      return (await l.apply(name, OPERATOR, { kind: "update_any", task: p.task, ...edits }, requestId(req, request_id))).task;
    },
  }),
  route({
    method: "POST", path: "/v1/ledgers/:ledger/tasks/:task/assign", auth: "admin",
    body: z.object({ assignee: AgentOrNull, expected_version: z.number().int().optional(), request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => {
      const { name, l } = ledgerOf(env, p.ledger);
      const op: TaskOp = { kind: "assign", task: p.task, expected_version: r.expected_version, assignee: await grantOf(env, r.assignee) };
      return (await l.apply(name, OPERATOR, op, requestId(req, r.request_id))).task;
    },
  }),
  route({
    method: "POST", path: "/v1/ledgers/:ledger/tasks/:task/comments", auth: "admin", status: 201, body: z.object({ body: z.string(), request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => {
      const { name, l } = ledgerOf(env, p.ledger);
      return (await l.apply(name, OPERATOR, { kind: "comment", task: p.task, body: r.body }, requestId(req, r.request_id))).comment;
    },
  }),

  // Sandboxes.
  route({
    method: "POST", path: "/v1/sandboxes", auth: "admin",
    body: z.object({
      workstream: z.string().startsWith("ws_"), image: z.string().optional(), resources: Resources.optional(), policy: WorkstreamPolicyLayer.optional(),
      cell: z.string().default(DEFAULT_CELL),
    }),
    run: async ({ env, body: r }) => {
      const id = newId("sbx_");
      const info = await sandbox(env, id).create({
        sandbox: id, workstream: r.workstream, cell: checkCell(env, r.cell),
        ...(r.image ? { image: r.image } : {}), ...(r.resources ? { resources: r.resources } : {}),
        ...(r.policy ? { workstreamPolicy: r.policy } : {}),
      });
      // 202: accepted and waiting for a host (SandboxDO retries; an autoscaled cell launches one).
      return json(info, info.host ? 201 : 202);
    },
  }),
  route({
    // Operator path: the only place public share links are minted.
    method: "POST", path: "/v1/sandboxes/:sandbox/ports", auth: "admin",
    body: z.object({ port: z.number().int().min(1).max(65535), share: z.boolean().default(false), host_header: z.enum(["localhost", "preserve"]).default("localhost") }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).exposePort(r.port, r.share, r.host_header),
  }),
  route({ method: "DELETE", path: "/v1/sandboxes/:sandbox/ports/:port", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).unexposePort(Number(p.port)) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).info() }),
  route({ method: "DELETE", path: "/v1/sandboxes/:sandbox", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).destroy() }),
  // A person's (or a test harness's) way to a sandbox's hands: the same target an agent gets.
  route({ method: "POST", path: "/v1/sandboxes/:sandbox/resolve", auth: "admin", body: z.object({ client: z.string().min(1) }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).resolve(r.client) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox/policy", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).policy() }),
  route({ method: "PUT", path: "/v1/sandboxes/:sandbox/policy", auth: "admin", body: WorkstreamPolicyLayer, run: ({ env, p, body }) => sandbox(env, p.sandbox).setWorkstreamPolicy(body) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox/generations", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).generations() }),
  route({ method: "POST", path: "/v1/sandboxes/:sandbox/place", auth: "admin", run: async ({ env, p }) => ({ host: await sandbox(env, p.sandbox).retryPlacement() }) }),
  route({
    method: "POST", path: "/v1/sandboxes/:sandbox/grants", auth: "admin",
    body: z.object({ host: z.string(), ttl_ms: z.number().int().positive(), ports: z.array(Port).optional() }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).grant(r.host, r.ttl_ms, r.ports),
  }),

  // Agents.
  route({
    // A spawn spec from the operator (the root: `OperatorOverrides`; an agent's spawn may only narrow,
    // `SpawnerOverrides`): a template, a sandbox (hands) or none, and overrides. For one release the
    // previous release's fields are accepted: `role` (the same-named template), `captain` (`owner`), and
    // top-level `launch` and `rules` (overrides).
    method: "POST", path: "/v1/agents", auth: "admin",
    body: z.object({
      template: CatalogName.optional(),
      role: AgentRole.optional(),
      // An agent's workstream and cell are its sandbox's: optional, and refused when they differ.
      workstream: z.string().startsWith("ws_").optional(),
      sandbox: z.string().startsWith("sbx_").optional(),
      owner: z.string().startsWith("agt_").optional(),
      captain: z.string().startsWith("agt_").optional(),
      overrides: OperatorOverrides.optional(),
      launch: LaunchConfig.optional(),
      rules: z.array(ToolRule).optional(),
      // Gone: a client still sending it must not silently get the template's wider tool set.
      grants: z.never({ error: "grants is no longer accepted: narrow the tools with overrides.tools" }).optional(),
      cell: z.string().optional(),
      start: z.boolean().default(true),
    }),
    run: async ({ env, body: r }) => {
      if (r.template && r.role && r.template !== r.role) throw new NestError(ErrorCodes.INVALID_MESSAGE, "template and role differ");
      const template = r.template ?? r.role;
      if (!template) throw new NestError(ErrorCodes.INVALID_MESSAGE, "template is required");
      if (r.owner && r.captain && r.owner !== r.captain) throw new NestError(ErrorCodes.INVALID_MESSAGE, "owner and captain differ");
      const overrides: OperatorOverrides = { ...(r.launch ? { launch: r.launch } : {}), ...(r.rules ? { rules: r.rules } : {}), ...r.overrides };
      let wsId = r.workstream;
      let cellName = r.cell ?? DEFAULT_CELL;
      if (r.sandbox) {
        const sbx = await sandbox(env, r.sandbox).info();
        if ((r.workstream && r.workstream !== sbx.workstream) || (r.cell && r.cell !== sbx.cell)) {
          throw new NestError(ErrorCodes.INVALID_MESSAGE,
            `${r.sandbox} is in cell ${sbx.cell}, workstream ${sbx.workstream}; a worker takes its sandbox's`, 409);
        }
        wsId = sbx.workstream;
        cellName = sbx.cell;
      }
      if (!wsId) throw new NestError(ErrorCodes.INVALID_MESSAGE, "an agent without a sandbox needs a workstream");
      checkCell(env, cellName);
      const spec = await catalog(env).expand({ template, hands: !!r.sandbox, by: "operator", overrides });
      const id = newId("agt_");
      const a = agent(env, id);
      await a.create({ agent: id, workstream: wsId, cell: cellName, spec, owner: r.owner ?? r.captain ?? null, sandbox: r.sandbox ?? null });
      if (spec.subscribe.includes("workstream")) await workstream(env, wsId).setSubscriber(id);
      // The agent exists now: a start that can't run yet (no brain host, a cold cell) keeps its intent and
      // runs when room appears, so the create still answers 201 with the agent and why its start waits.
      let started: Awaited<ReturnType<typeof a.start>> | null = null;
      let start_waiting: ErrorBody | null = null;
      if (r.start) {
        try {
          started = await a.start();
        } catch (e) {
          const ne = asNestError(e);
          if (!ne?.retryable) throw e;
          start_waiting = ne.body();
        }
      }
      return json({ ...(await a.info()), started, ...(start_waiting ? { start_waiting } : {}) }, 201);
    },
  }),
  route({ method: "GET", path: "/v1/agents/:agent", auth: "admin", run: ({ env, p }) => agent(env, p.agent).info() }),
  route({ method: "GET", path: "/v1/agents/:agent/turns", auth: "admin", run: ({ env, p }) => agent(env, p.agent).turns() }),
  route({ method: "GET", path: "/v1/agents/:agent/subscriptions", auth: "admin", run: ({ env, p }) => agent(env, p.agent).channelSubscriptions() }),
  route({ method: "GET", path: "/v1/agents/:agent/transcript", auth: "admin", run: async ({ env, url, p }) => {
    const a = agent(env, p.agent);
    const q = url.searchParams;
    if (!q.has("since")) return new Response(await a.transcript(), { headers: { "content-type": "application/x-ndjson" } });
    const base = q.get("base");
    return a.readTranscript(num(q.get("since") ?? undefined, 0), num(q.get("limit") ?? undefined, 200), base === null ? undefined : num(base, 0));
  } }),
  route({
    method: "POST", path: "/v1/agents/:agent/turns", auth: "admin", status: 201,
    body: z.object({ text: z.string(), kind: z.enum(["user", "recovery"]).default("user"), request_id: RequestIdField }),
    run: async ({ env, req, p, body: r }) => ({ turn: await agent(env, p.agent).enqueueTurn({ kind: r.kind, text: r.text }, requestId(req, r.request_id)) }),
  }),
  route({
    method: "POST", path: "/v1/agents/:agent/inbox", auth: "admin", status: 201,
    body: z.object({ text: z.string(), from: z.string().default("user"), interrupt: z.boolean().default(false), request_id: RequestIdField }),
    // The operator speaking as `user` is trusted; text it relays under another name may not be (it taints).
    run: async ({ env, req, p, body: r }) => ({
      message: await agent(env, p.agent).postInbox(r.from, r.text, r.interrupt, requestId(req, r.request_id), r.from !== "user"),
    }),
  }),
  route({ method: "POST", path: "/v1/agents/:agent/interrupt", auth: "admin", run: ({ env, p }) => agent(env, p.agent).interrupt() }),
  route({
    // An optional host: a brain on a chosen enrolled host (hands still reach the sandbox's gateway).
    method: "POST", path: "/v1/agents/:agent/start", auth: "admin", optionalBody: true,
    body: z.object({ host: HostId.optional(), restart: z.boolean().optional() }),
    run: ({ env, p, body: r }) => agent(env, p.agent).start(r.host, undefined, r.restart ?? false),
  }),
  route({ method: "POST", path: "/v1/agents/:agent/stop", auth: "admin", run: ({ env, p }) => agent(env, p.agent).stop("requested") }),
  route({ method: "PUT", path: "/v1/agents/:agent/rules", auth: "admin", body: z.array(ToolRule), run: ({ env, p, body }) => agent(env, p.agent).setRules(body) }),
  route({ method: "POST", path: "/v1/agents/:agent/asks/:ask/answer", auth: "admin", body: z.object({ answer: z.string() }),
    run: async ({ env, p, body: r }) => ({ delivered: await agent(env, p.agent).answerAsk(p.ask, r.answer) }) }),
];

async function dispatch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const p = match(r.path, url.pathname);
    if (!p) continue;
    const c = { req, env, url, p, body: undefined as unknown, cell: DEFAULT_CELL, claims: undefined as unknown as HostClaims };
    if (r.auth === "admin") {
      requireAdmin(req, env);
      c.cell = checkCell(env, url.searchParams.get("cell") ?? DEFAULT_CELL);
    } else if (r.auth === "host") {
      c.claims = await hostClaims(req, env, r.graceMs);
    }
    if (r.body) c.body = await body(req, r.body, r.optionalBody);
    const out = await r.run(c);
    return out instanceof Response ? out : json(out === undefined ? { ok: true } : out, r.status ?? 200);
  }
  // An unknown route answers 404 only to the operator.
  requireAdmin(req, env);
  throw new NestError(ErrorCodes.INVALID_MESSAGE, `no route for ${req.method} ${url.pathname}`, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await dispatch(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
