// nest control plane Worker: HTTP API, enrollment, WebSocket routing to Durable Objects.
import "reflect-metadata";
import { z } from "zod";
import { num, type Env } from "./env";
import { CmsRsaIdentityVerifier, type InstanceIdentity } from "./lib/aws-identity";
import { bearer, type HostClaims, verifyBlobUrl, verifyHostToken } from "./lib/tokens";
import { clientSender, OPERATOR_SENDER } from "./lib/senders";
import { asNestError, errorResponse, json, NestError, newId, timingSafeEqual } from "./lib/util";
import { checkHealth, healthProbes } from "./lib/health";
import { CONFIG_DIGEST } from "./lib/build";
import { EnrollRequest, LaunchConfig, ToolRule } from "./protocol/control";
import { Capability, CatalogName, EntryName, OperatorOverrides, type SpawnerOverrides, Template } from "./lib/spec";
import { cellIdleTtlMs, MIN_IDLE_TTL_MS } from "./lib/lifetimes";
import {
  CLIENT_ID, ClientName, GithubTokenRequest, githubTokenOutsideGrant, Grant, grantRefusal, isAgentId, Labels, newClientToken, parseClientToken,
  parseLabelFilters, tokenHash,
} from "./lib/clients";
import type { ClientScope } from "./do/catalog";
import { CLIENT_DIRECTORY, CLIENT_OPERATOR } from "./do/client";
import { idempotencyKey, type KeyClaim, requestDigest } from "./lib/idempotency";
import {
  CLIENT_BINDING_PREFIX, CLIENT_SECRET_PREFIX, ClientInjections, ClientSecretName, ClientSecretPut, holdInjections, injectionsOutsideGrant, SECRET_MAX_BYTES_DEFAULT,
} from "./lib/client-secrets";
import { GithubPush } from "./lib/rules/github";
import { ClientEgress, egressOutsideGrant } from "./lib/client-egress";
import { SandboxEnv, unboundPlaceholders } from "./lib/sandbox-env";
import { TimerName } from "./lib/timers";
import { clientMetadataDocument, Scopes } from "./lib/mcp-auth";
import { JWKS_MAX_AGE_S } from "./lib/identity";
import { Port, SandboxPolicyLayer } from "./do/sandbox";
import { type CreateAgent, TRACE_HEADER } from "./do/agent";
import { type GrantParent, inScope, parseGrantRequests } from "./lib/grants";
import { parseAppSecret } from "./lib/github";
import { AgentRole, ErrorCodes, type ErrorBody, HostId, HostRole, hostKind, PROTOCOL_VERSION, Resources } from "./protocol/model";

export { AgentDO } from "./do/agent";
export { BrokerDO } from "./do/broker";
export { CatalogDO } from "./do/catalog";
export { ClientDO } from "./do/client";
export { FleetDO } from "./do/fleet";
export { McpConnectorDO } from "./do/mcp-connector";
export { SandboxDO } from "./do/sandbox";

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
const broker = (env: Env) => env.BROKER.get(env.BROKER.idFromName("broker"));
const catalog = (env: Env) => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const clientDO = (env: Env, id: string) => env.CLIENT.get(env.CLIENT.idFromName(id));
const directory = (env: Env) => env.CLIENT.get(env.CLIENT.idFromName(CLIENT_DIRECTORY));

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

const isAdminToken = (token: string | null, env: Env): boolean => {
  const enc = new TextEncoder();
  return !!token && !!env.ADMIN_TOKEN && timingSafeEqual(enc.encode(token), enc.encode(env.ADMIN_TOKEN));
};

function requireAdmin(req: Request, env: Env): void {
  if (!isAdminToken(bearer(req), env)) throw new NestError(ErrorCodes.UNAUTHORIZED, "admin token required", 401);
}

/**
 * Who called an `owner` route (docs/control-plane/api/clients/): the operator (the admin token), or an
 * API client (its token), which acts only on its own subtree.
 */
export type Caller = { kind: "operator" } | ({ kind: "client" } & ClientScope);

async function ownerCaller(req: Request, env: Env): Promise<Caller> {
  const token = bearer(req);
  if (isAdminToken(token, env)) return { kind: "operator" };
  const parsed = token ? parseClientToken(token) : null;
  if (!parsed) throw new NestError(ErrorCodes.UNAUTHORIZED, "admin or client token required", 401);
  // Only the token's hash leaves the Worker; ClientDO compares it in constant time.
  return { kind: "client", ...(await clientDO(env, parsed.client).authenticate(await tokenHash(token!))) };
}

/** What a missing agent answers: a client gets the same for one outside its subtree, so ids reveal nothing. */
const unknownAgent = () => new NestError(ErrorCodes.UNKNOWN_AGENT, "unknown agent", 404);
const unknownSandbox = () => new NestError(ErrorCodes.UNKNOWN_SANDBOX, "unknown sandbox", 404);

/** The agent, if the caller may act on it: the operator any, a client only its subtree's (404 otherwise). */
async function ownAgent(c: { env: Env; caller: Caller }, id: string) {
  const stub = agent(c.env, id);
  if (c.caller.kind === "client" && (await stub.subtree()).client !== c.caller.client) throw unknownAgent();
  return stub;
}

/** The sandbox, if the caller may act on it (as for agents). */
async function ownSandbox(c: { env: Env; caller: Caller }, id: string) {
  const stub = sandbox(c.env, id);
  if (c.caller.kind === "client" && (await stub.subtree()).client !== c.caller.client) throw unknownSandbox();
  return stub;
}

/** A client refused something only the operator does. */
function operatorOnly(c: { caller: Caller }, what: string): void {
  if (c.caller.kind !== "operator") throw new NestError(ErrorCodes.FORBIDDEN, `${what} is the operator's`, 403);
}

/**
 * The GitHub App a client's tokens come from (docs/control-plane/api/clients/#github-tokens): `app_id`
 * and, when known, `app_slug`. Not secret. Null when BrokerDO can't tell, including for minutes after a
 * deploy while it runs the previous code: the answer goes out without it rather than failing.
 */
async function githubAppOf(env: Env): Promise<{ app_id: number; app_slug?: string } | null> {
  try {
    return await broker(env).githubApp();
  } catch (e) {
    console.warn("the GitHub App's identity is unavailable", e instanceof Error ? e.message : e);
    return null;
  }
}

/** A `/v1/clients/self/…` route's client: only a client token has a self (the operator is refused, 403). */
function selfClient(c: { caller: Caller }): ClientScope {
  if (c.caller.kind !== "client") throw new NestError(ErrorCodes.FORBIDDEN, "only an API client's token has a self", 403);
  return c.caller;
}

/**
 * A call to a Durable Object method this release added. For minutes after a deploy the object may
 * still run the previous code, which lacks it (dev/deploy.md): that answers a retryable 503, not a 500.
 */
async function newMethod<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!asNestError(e) && /RPC receiver does not implement/.test(e instanceof Error ? e.message : String(e))) {
      throw new NestError(ErrorCodes.INTERNAL, `${what} isn't running yet after a deploy: try again in a few minutes`, 503, true);
    }
    throw e;
  }
}

const isUpgrade = (req: Request) => req.headers.get("upgrade")?.toLowerCase() === "websocket";

async function enroll(req: Request, env: Env): Promise<Response> {
  const r = await body(req, EnrollRequest);
  if (r.protocol_version !== PROTOCOL_VERSION) {
    throw new NestError(ErrorCodes.UNSUPPORTED_VERSION, `server speaks ${PROTOCOL_VERSION}`);
  }
  try {
    let identity: InstanceIdentity | null = null;
    if (r.proof.type === "aws_identity_document") {
      if (!env.AWS_IDENTITY_CERT_PEM) throw new NestError(ErrorCodes.UNAUTHORIZED, "AWS identity enrollment is not configured", 401);
      identity = await new CmsRsaIdentityVerifier(env.AWS_IDENTITY_CERT_PEM).verify(r.proof.document_b64, r.proof.pkcs7_b64);
    }
    return json(await fleet(env, checkCell(env, r.cell)).enroll(r, r.cell, identity));
  } catch (e) {
    // The refusal reaches only the host; log it so an operator can see why a host doesn't join.
    const err = asNestError(e);
    console.warn(`enroll refused (${r.proof.type}, cell ${r.cell}): ${err ? `${err.code}: ${err.message}` : String(e)}`);
    throw e;
  }
}

/** A client's id for a submission (body `request_id` or `Idempotency-Key`): a retry with it is applied once. */
const RequestIdField = z.string().min(1).max(128).optional();

function requestId(req: Request, fromBody: string | undefined): string | undefined {
  const header = req.headers.get("idempotency-key") ?? undefined;
  const id = fromBody ?? header;
  if (id !== undefined && (id.length === 0 || id.length > 128)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "request id must be 1-128 characters");
  return id === undefined ? undefined : `api/${id}`;
}

// --- routing ---------------------------------------------------------------------------------------

/**
 * Who may call a route, a required field of each: `none` (health, enrollment, signed blob URLs),
 * `host` (a host token; `graceMs` admits a recently expired one), `admin` (the operator's token), or
 * `owner` (the operator's token, or an API client's, which acts only on its own subtree: `Ctx.caller`).
 */
type Auth = "none" | "host" | "admin" | "owner";
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
  /**
   * `?cell=` (default `local`), checked when a route reads it, and only then: a route about one cell's
   * FleetDO (hosts, the fleet view, GC, the operator's listing) reads it; a route reaching an agent or
   * sandbox by id, the catalog, clients or secrets never does, so it needs no cell and ignores one given.
   */
  readonly cell: string;
  /** A `host` route's verified token. */
  claims: HostClaims;
  /** An `owner` route's caller (the operator on an `admin` route). */
  caller: Caller;
}
interface RouteOf<P extends string, S, B> {
  method: Method;
  path: P;
  auth: Auth;
  graceMs?: number;
  body?: S;
  /** The body may be empty (parsed as `{}`). */
  optionalBody?: boolean;
  status?: number;
  /** A Response passes through; `undefined` answers `{ok: true}`; anything else is JSON with `status`. */
  run(c: Ctx<P, B>): Promise<unknown>;
}
type Route = RouteOf<string, z.ZodType, unknown>;
function route<P extends string, S extends z.ZodType | undefined = undefined>(r: RouteOf<P, S, S extends z.ZodType ? z.output<S> : undefined>): Route {
  return r as unknown as Route;
}

/** What a path parameter must look like, by name (ids as `newId` makes them); any other is one segment. */
const PARAM: Record<string, RegExp> = {
  agent: /^agt_[A-Za-z0-9]+$/,
  sandbox: /^sbx_[A-Za-z0-9]+$/,
  host: /^hst_[A-Za-z0-9]+$/,
  ask: /^ask_[A-Za-z0-9]+$/,
  client: /^cli_[A-Za-z0-9]+$/,
  ns: /^[a-z][a-z0-9-]{1,30}$/,
  entry: /^[a-z][a-z0-9-]{0,62}$/,
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

/** An mcp capability whose `auth` is the oauth form (404 for an unknown one, 409 for any other). */
async function oauthCapability(env: Env, raw: string) {
  const name = catalogName(raw);
  const cap = (await catalog(env).catalog()).capabilities[name];
  if (!cap) throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown capability ${name}`, 404);
  const mcp = cap.mcp;
  if (!mcp || mcp.auth === undefined || typeof mcp.auth === "string") {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, `${name} is not an mcp capability with auth {oauth: cap:<name>}`, 409);
  }
  return { name, mcp: { ...mcp, auth: mcp.auth } };
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * `PUT /v1/sandboxes/<id>/client-policy`'s body: the whole client layer (an absent part is emptied):
 * egress rules, injection bindings, environment, and the push token's opt-ins (`github_push`).
 */
const ClientLayer = z.strictObject({ egress: ClientEgress.optional(), inject: ClientInjections.optional(), env: SandboxEnv.optional(), github_push: GithubPush.optional() });

/**
 * An environment's values: no placeholder that none of `bound` is, and no value of a secret the caller
 * may see (`refuseSecretValues`): env carries literals and placeholders only.
 */
async function checkEnv(env: Env, caller: Caller, vars: Readonly<Record<string, string>>, bound: readonly string[]): Promise<void> {
  const unbound = unboundPlaceholders(vars, bound);
  if (unbound.length) throw new NestError(ErrorCodes.INVALID_MESSAGE, unbound.join("; "));
  await refuseSecretValues(env, caller, vars);
}

/**
 * No env value holds a stored secret's value (a template's, a spawn's: their placeholders are checked at
 * expansion). A best-effort check against accidents, never a guarantee: a client's values are compared
 * with its own secrets only (anything wider would answer whether another tenant's or the operator's
 * secret has a guessed value), the operator's with every stored secret.
 */
async function refuseSecretValues(env: Env, caller: Caller, vars: Readonly<Record<string, string>> | undefined): Promise<void> {
  const values = Object.values(vars ?? {});
  const client = caller.kind === "client" ? caller.client : null;
  if (values.length && (await newMethod("BrokerDO.scanSecretValues", () => broker(env).scanSecretValues(values, client))).length) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, "an env value holds a stored secret's value: store it as a secret, bind it, and put the binding's placeholder in env");
  }
}

/** Tell every live sandbox of a client that its grant changed; how many didn't answer. */
async function fanOutGrant(env: Env, client: string): Promise<number> {
  let failed = 0;
  let cursor: string | undefined;
  do {
    const page = await clientDO(env, client).list("sandbox", { state: "live", limit: 500, ...(cursor ? { cursor } : {}) });
    const results = await Promise.allSettled(page.items.map((m) => newMethod("SandboxDO.clientGrantChanged", () => sandbox(env, m.id).clientGrantChanged())));
    failed += results.filter((x) => x.status === "rejected").length;
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return failed;
}

/** A client secret's name from a path (400 for one outside `ClientSecretName`). */
function clientSecretName(raw: string): string {
  const n = ClientSecretName.safeParse(raw);
  if (!n.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, n.error.issues[0]!.message);
  return n.data;
}

function catalogName(raw: string): string {
  const name = CatalogName.safeParse(raw);
  if (!name.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, name.error.message);
  return name.data;
}

/**
 * A create in a client's subtree, after its place was admitted: a failure for good gives the place back
 * (the object, if it was made after all, reports itself and takes it again).
 */
async function createOrRelease<T>(env: Env, client: string | null, id: string, create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (e) {
    if (client && !asNestError(e)?.retryable) await clientDO(env, client).release(id).catch(() => undefined);
    throw e;
  }
}

/** A replayed create's answer says so (docs/control-plane/api/#idempotency-keys). */
const REPLAYED = { "idempotent-replayed": "true" } as const;

/**
 * `POST /v1/agents` and `POST /v1/sandboxes` (docs/control-plane/api/#idempotency-keys). Without an
 * `Idempotency-Key`, `create` runs under a new id. With one, the caller's key store (its ClientDO; the
 * operator's `operator` instance) binds the key to this request and an id first: a key already answered
 * replays (`replay`), one still being handled is a retryable 409, one used for another request a 409.
 * `create` calls `begin()` just before it makes anything; a fresh key whose request failed before that is
 * freed, and otherwise stays bound to its id, so a retry makes the same object (every create is
 * idempotent by id) and never a second one.
 */
async function createOnce(c: Ctx<string, unknown>, kind: "agent" | "sandbox", create: (id: string, begin: () => void) => Promise<Response>,
  replay: (id: string, status: number) => Promise<Response>): Promise<Response> {
  const prefix = kind === "agent" ? "agt_" : "sbx_";
  const key = idempotencyKey(c.req);
  if (key === null) return create(newId(prefix), () => undefined);
  const store = clientDO(c.env, c.caller.kind === "client" ? c.caller.client : CLIENT_OPERATOR);
  const digest = await requestDigest(`POST /v1/${kind}s`, c.body);
  // RPC's typing doesn't carry a union through: the answer is ClientDO's `KeyClaim`.
  const claim = await newMethod("ClientDO.claimKey", async () => (await store.claimKey(key, digest, newId(prefix))) as unknown as KeyClaim);
  if (claim.kind === "done") return replay(claim.id, claim.status);
  let begun = false;
  let res: Response;
  try {
    res = await create(claim.id, () => {
      begun = true;
    });
  } catch (e) {
    await store.abandonKey(key, claim.claim, claim.fresh && !begun).catch((x) => console.warn(`idempotency key: abandoning a claim failed (its lease lapses)`, x));
    throw e;
  }
  // If this isn't recorded, the next request with the key waits out the lease, then makes the same object again (found, not duplicated).
  await store.finishKey(key, res.status).catch((x) => console.warn(`idempotency key: recording the answer failed`, x));
  return res;
}

/**
 * The scope writes and reads in catalog namespace `ns` are held to: its client's (a client only its own,
 * 403 elsewhere; the operator any client's, 404 for a name no client has).
 */
async function namespaceScope(c: { env: Env; caller: Caller }, ns: string): Promise<ClientScope> {
  if (c.caller.kind === "client") {
    if (ns !== c.caller.name) throw new NestError(ErrorCodes.FORBIDDEN, `${ns} is not your namespace (${c.caller.name})`, 403);
    return c.caller;
  }
  const id = await directory(c.env).lookup(ns);
  if (!id) throw new NestError(ErrorCodes.NOT_FOUND, `no client is named ${ns}`, 404);
  return clientDO(c.env, id).scope();
}

/**
 * `GET /v1/agents` and `GET /v1/sandboxes`: a client's subtree from its registry (ClientDO), or, for the
 * operator, a client's (`?client=`) or the cell's (`?cell=`, FleetDO's registries). Filters: `label=k=v`
 * (repeated: each must hold), `state=live|ended|all` (default live); paged by `limit` and `cursor`.
 */
async function listing(c: Ctx<string, unknown>, kind: "agent" | "sandbox"): Promise<unknown> {
  const q = c.url.searchParams;
  let labels: [string, string][];
  try {
    labels = parseLabelFilters(q.getAll("label"));
  } catch (e) {
    throw new NestError(ErrorCodes.INVALID_MESSAGE, (e as Error).message);
  }
  const state = q.get("state") ?? "live";
  if (state !== "live" && state !== "ended" && state !== "all") throw new NestError(ErrorCodes.INVALID_MESSAGE, "state is live, ended or all");
  const limit = q.has("limit") ? Number(q.get("limit")) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "limit must be a positive integer");
  const page = { labels, state, ...(limit !== undefined ? { limit } : {}), ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}) } as const;
  const key = kind === "agent" ? "agents" : "sandboxes";
  const client = c.caller.kind === "client" ? c.caller.client : q.get("client");
  if (client !== null) {
    if (!CLIENT_ID.test(client)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "client is a cli_ id");
    const r = await clientDO(c.env, client).list(kind, { ...page, ...(q.has("cell") ? { cell: c.cell } : {}) });
    return {
      [key]: r.items.map((m) => ({ [kind]: m.id, cell: m.cell, client, owner: m.owner, labels: m.labels, created_ms: m.created_ms, ended_ms: m.ended_ms })),
      next_cursor: r.next_cursor,
    };
  }
  const r = await fleet(c.env, c.cell).listRegistry(kind, page);
  return {
    [key]: r.items.map((m) => ({ [kind]: m.id, cell: c.cell, client: m.client, labels: m.labels, created_ms: m.created_ms, ended_ms: m.ended_ms })),
    next_cursor: r.next_cursor,
  };
}

/**
 * A spawn's `grants` from the API (docs/agents/tools/#grants): the operator confers any (it holds the
 * root), a client only over its own subtree (its owner auth reads every agent in it). Either way a grant
 * is confined to the new agent's subtree (`client`), and an id must name an agent in it: outside, it
 * answers 404, as any id outside a client's subtree does.
 */
async function conferGrants(c: Ctx<string, unknown>, raw: unknown, client: string | null): Promise<NonNullable<CreateAgent["grants"]>> {
  const parsed = parseGrantRequests(raw, Date.now());
  if (!parsed.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, parsed.error);
  const parent: GrantParent = c.caller.kind === "client" ? { kind: "client", client: c.caller.client } : { kind: "operator" };
  const out: NonNullable<CreateAgent["grants"]> = [];
  for (const { req, resource } of parsed.value) {
    if ("id" in resource) {
      let target: string | null | undefined;
      try {
        target = (await agent(c.env, resource.id).subtree()).client;
      } catch (e) {
        if (asNestError(e)?.code !== ErrorCodes.UNKNOWN_AGENT) throw e;
      }
      if (target === undefined || !inScope(client, { client: target })) throw new NestError(ErrorCodes.NOT_FOUND, `no agent ${resource.id} in this subtree`, 404);
    }
    out.push({
      action: req.action, resource: req.resource, ...(req.limits ? { limits: req.limits } : {}), ...(req.expires_ms !== undefined ? { expires_ms: req.expires_ms } : {}),
      scope: client, parent,
    });
  }
  return out;
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
  // The cell's enrolment breakers (docs/compute/autoscaling/#enrolment-breaker), closed now: every one, a host
  // kind's (`role`), or one instance type's.
  route({
    method: "POST", path: "/v1/admin/fleet/enroll-breakers/reset", auth: "admin", optionalBody: true,
    body: z.strictObject({ role: HostRole.optional(), type: z.string().min(1).max(64).optional() }).default({}),
    run: ({ env, cell, body }) => fleet(env, cell).resetEnrollBreakers(body.role ? hostKind(body.role) : undefined, body.type),
  }),
  // What is left lying around: dormant sandboxes, sandboxes held by agents nobody uses, quiet agents (docs/control-plane/dashboard/#abandoned).
  route({ method: "GET", path: "/v1/admin/lifetimes", auth: "admin", run: ({ env, cell, url }) => {
    const q = url.searchParams;
    const int = (k: string, min: number) => {
      if (!q.has(k)) return undefined;
      const v = Number(q.get(k));
      if (!Number.isSafeInteger(v) || v < min) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${k} must be an integer of at least ${min}`, 400);
      return v;
    };
    const limit = int("limit", 1);
    const quiet = int("quiet_ms", 0);
    return fleet(env, cell).lifetimes({
      ...(q.has("cursor") ? { cursor: q.get("cursor")! } : {}), ...(limit !== undefined ? { limit } : {}), ...(quiet !== undefined ? { quiet_ms: quiet } : {}),
    });
  } }),
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
      // A client's secrets are its own, written with its token (`PUT /v1/clients/self/secrets/<name>`), never by name here.
      if (p.secret.startsWith(CLIENT_SECRET_PREFIX)) throw new NestError(ErrorCodes.FORBIDDEN, "an API client's secrets are written with its own token", 403);
      // The GitHub App's credentials: refused here when they can't work, not at the first action.
      if (p.secret === "github_app" && !parseAppSecret(r.value)) {
        throw new NestError(ErrorCodes.INVALID_MESSAGE, "github_app is JSON {\"app_id\", \"private_key\"} (the App's id and its PEM private key)");
      }
      return broker(env).putSecret(p.secret, r.value, r.expires_ms);
    },
  }),

  // Templates and capabilities (docs/agents/capabilities/): data the operator edits.
  route({ method: "GET", path: "/v1/admin/catalog", auth: "admin", run: ({ env }) => catalog(env).catalog() }),
  route({ method: "PUT", path: "/v1/admin/capabilities/:name", auth: "admin", body: Capability, run: ({ env, p, body }) => catalog(env).putCapability(catalogName(p.name), body) }),
  route({ method: "PUT", path: "/v1/admin/templates/:name", auth: "admin", body: Template, run: async ({ env, p, body }) => {
    await refuseSecretValues(env, { kind: "operator" }, body.env);
    return catalog(env).putTemplate(catalogName(p.name), body);
  } }),
  route({ method: "DELETE", path: "/v1/admin/capabilities/:name", auth: "admin", run: ({ env, p }) => catalog(env).deleteCapability(catalogName(p.name)) }),

  // OAuth for an mcp capability (docs/agents/capabilities/mcp/#oauth): the operator starts it here and
  // opens the URL it answers; the authorization server redirects the browser to the callback.
  route({
    method: "POST", path: "/v1/admin/capabilities/:name/oauth", auth: "admin", optionalBody: true, body: z.strictObject({ scopes: Scopes.optional() }),
    run: async ({ env, p, body: r }) => {
      const { name, mcp } = await oauthCapability(env, p.name);
      return broker(env).oauthStart({ capability: name, url: mcp.url, auth: mcp.auth, ...(r.scopes ? { scopes: r.scopes } : {}) });
    },
  }),
  route({ method: "GET", path: "/v1/admin/capabilities/:name/oauth", auth: "admin", run: async ({ env, p }) =>
    broker(env).oauthStatus((await oauthCapability(env, p.name)).mcp.auth.oauth) }),
  // No admin token: a browser follows the authorization server's redirect here. The single-use, 10-minute
  // state names the flow the operator started, and the code is useless without that flow's PKCE verifier.
  route({ method: "GET", path: "/v1/oauth/callback", auth: "none", run: async ({ env, url }) => {
    const q = url.searchParams;
    const opt = (k: string) => (q.has(k) ? { [k]: q.get(k)! } : {});
    const r = await broker(env).oauthCallback({ ...opt("state"), ...opt("code"), ...opt("error"), ...opt("iss") });
    const page = `<!doctype html><meta charset="utf-8"><title>nest</title><p>${escapeHtml(r.ok ? `${r.message}. You can close this tab.` : `Not authorized: ${r.message}`)}</p>`;
    // The query held a code: never sent on as a Referer, never cached.
    return new Response(page, {
      status: r.ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  } }),
  // The caller identity's public keys (docs/control-plane/api/clients/#caller-identity-for-mcp-servers):
  // what an MCP server verifies `Nest-Identity` against. A next key is listed a day before it signs.
  route({ method: "GET", path: "/.well-known/jwks.json", auth: "none", run: async ({ env }) =>
    json(await broker(env).identityJwks(), 200, { "cache-control": `public, max-age=${JWKS_MAX_AGE_S}` }) }),
  // nest's client ID metadata document: its URL is the client id an authorization server fetches.
  route({ method: "GET", path: "/v1/oauth/client.json", auth: "none", run: async ({ env }) =>
    json(clientMetadataDocument(env.PUBLIC_BASE_URL), 200, { "cache-control": "public, max-age=300" }) }),
  route({ method: "DELETE", path: "/v1/admin/templates/:name", auth: "admin", run: ({ env, p }) => catalog(env).deleteTemplate(catalogName(p.name)) }),

  // Sandboxes.
  route({
    method: "POST", path: "/v1/sandboxes", auth: "owner",
    body: z.object({
      // Workstreams left the platform: for one release a `workstream` is accepted and ignored (old clients send it).
      workstream: z.string().optional(),
      image: z.string().optional(), resources: Resources.optional(), policy: SandboxPolicyLayer.optional(),
      cell: z.string().default(DEFAULT_CELL),
      // Destroyed after being dormant this long (absent: the cell default; docs/control-plane/durable-objects/sandbox/#lifetime).
      idle_ttl_ms: z.number().int().min(MIN_IDLE_TTL_MS).optional(),
      labels: Labels.optional(),
      // A client's injection bindings, naming its own secrets, within its grant's `inject_hosts` (docs/control-plane/api/clients/#injection).
      inject: ClientInjections.optional(),
      // `workflows: write` on its push token (docs/control-plane/api/clients/#workflow-files).
      github_push: GithubPush.optional(),
      // Allow rules within a client's grant's `egress_hosts` (docs/control-plane/api/clients/#egress).
      egress: ClientEgress.optional(),
      // Its processes' environment: literals, or placeholders of `inject` (docs/control-plane/api/clients/#environment).
      env: SandboxEnv.optional(),
    }),
    run: (c) => createOnce(c, "sandbox", async (id, begin) => {
      const { env, body: r, caller } = c;
      // The policy layer (egress, injected credentials) is the operator's: no grant field covers it.
      if (r.policy) operatorOnly(c, "a sandbox's policy layer");
      const cell = checkCell(env, r.cell);
      const labels = r.labels ?? {};
      const client = caller.kind === "client" ? caller.client : null;
      // Client bindings name a client's own secrets: the operator's bindings go in `policy.inject`.
      if (r.inject?.length && caller.kind !== "client") throw new NestError(ErrorCodes.INVALID_MESSAGE, "inject is an API client's (its own secrets); the operator's bindings go in policy.inject");
      const inject = caller.kind === "client" ? holdInjections(caller.client, r.inject ?? []) : [];
      if (caller.kind === "client") {
        const outside = [...injectionsOutsideGrant(inject, caller.grant.inject_hosts ?? []),
          ...(r.github_push?.workflows && !caller.grant.github_push?.workflows ? ["github_push.workflows"] : []),
          ...egressOutsideGrant(r.egress?.allow ?? [], caller.grant.egress_hosts ?? [])];
        const refusal = grantRefusal(caller.client, outside);
        if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, refusal, 403);
      }
      await checkEnv(env, caller, r.env ?? {}, inject.map((b) => b.placeholder));
      // A client's place first (its grant's cells and max_sandboxes, counted across its subtree).
      if (client) await clientDO(env, client).admit({ kind: "sandbox", id, cell, owner: client, labels });
      begin();
      const info = await createOrRelease(env, client, id, () => sandbox(env, id).create({
        sandbox: id, cell, labels, ...(client ? { client } : {}),
        ...(r.image ? { image: r.image } : {}), ...(r.resources ? { resources: r.resources } : {}),
        ...(r.policy ? { policy: r.policy } : {}), ...(r.idle_ttl_ms !== undefined ? { idle_ttl_ms: r.idle_ttl_ms } : {}),
        ...(inject.length ? { inject } : {}), ...(r.github_push?.workflows ? { github_push: { workflows: true as const } } : {}),
        ...(r.egress?.allow.length ? { egress: r.egress.allow } : {}), ...(r.env && Object.keys(r.env).length ? { env: r.env } : {}),
      }));
      // 202: accepted and waiting for a host (SandboxDO retries; an autoscaled cell launches one).
      return json(info, info.host ? 201 : 202);
    }, async (id, status) => json(await sandbox(c.env, id).info(), status, REPLAYED)),
  }),
  route({ method: "GET", path: "/v1/sandboxes", auth: "owner", run: (c) => listing(c, "sandbox") }),
  // Its client layer (docs/control-plane/api/clients/#the-client-layer): egress rules, injection bindings,
  // environment and the push token's opt-ins, replaced whole on a live sandbox within its client's grant,
  // through the usual policy and secrets push.
  route({ method: "GET", path: "/v1/sandboxes/:sandbox/client-policy", auth: "owner", run: async (c) =>
    newMethod("SandboxDO.clientLayer", async () => (await ownSandbox(c, c.p.sandbox)).clientLayer()) }),
  route({
    method: "PUT", path: "/v1/sandboxes/:sandbox/client-policy", auth: "owner", body: ClientLayer,
    run: async (c) => {
      const stub = await ownSandbox(c, c.p.sandbox);
      const { client } = await stub.subtree();
      const r = c.body;
      if (r.inject?.length && !client) throw new NestError(ErrorCodes.INVALID_MESSAGE, "inject names an API client's secrets: this sandbox is the operator's (its bindings go in policy.inject)");
      const inject = client ? holdInjections(client, r.inject ?? []) : [];
      if (client) {
        // Its client's grant as it is now, whoever writes the layer (the operator too).
        const scope = await clientDO(c.env, client).scope();
        const refusal = grantRefusal(client, [...injectionsOutsideGrant(inject, scope.grant.inject_hosts ?? []),
          ...(r.github_push?.workflows && !scope.grant.github_push?.workflows ? ["github_push.workflows"] : []),
          ...egressOutsideGrant(r.egress?.allow ?? [], scope.grant.egress_hosts ?? [])]);
        if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, refusal, 403);
      }
      // A placeholder of this layer's own bindings, or of a binding that isn't a client's (the operator's):
      // never one of the layer this replaces, nor one only an attached agent's spec brings.
      const bound = [...inject.map((b) => b.placeholder),
        ...(await stub.policy()).inject.filter((b) => !b.name.startsWith(CLIENT_BINDING_PREFIX)).map((b) => b.placeholder)];
      await checkEnv(c.env, c.caller, r.env ?? {}, bound);
      return newMethod("SandboxDO.setClientLayer", () => stub.setClientLayer({ egress: r.egress?.allow ?? [], inject, env: r.env ?? {}, workflows: r.github_push?.workflows === true }));
    },
  }),
  route({
    // Operator path: the only place public share links are minted.
    method: "POST", path: "/v1/sandboxes/:sandbox/ports", auth: "admin",
    body: z.object({ port: z.number().int().min(1).max(65535), share: z.boolean().default(false), host_header: z.enum(["localhost", "preserve"]).default("localhost") }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).exposePort(r.port, r.share, r.host_header),
  }),
  route({ method: "DELETE", path: "/v1/sandboxes/:sandbox/ports/:port", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).unexposePort(Number(p.port)) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox", auth: "owner", run: async (c) => (await ownSandbox(c, c.p.sandbox)).info() }),
  route({ method: "DELETE", path: "/v1/sandboxes/:sandbox", auth: "owner", run: async (c) => (await ownSandbox(c, c.p.sandbox)).destroy() }),
  // Its own idle TTL (null: the cell default); a long one keeps a sandbox nobody attaches to.
  route({ method: "PUT", path: "/v1/sandboxes/:sandbox/lifetime", auth: "owner", body: z.object({ idle_ttl_ms: z.number().int().min(MIN_IDLE_TTL_MS).nullable() }),
    run: async (c) => (await ownSandbox(c, c.p.sandbox)).setLifetime(c.body.idle_ttl_ms) }),
  // A person's (or a test harness's) way to a sandbox's hands: the same target an agent gets.
  route({ method: "POST", path: "/v1/sandboxes/:sandbox/resolve", auth: "admin", body: z.object({ client: z.string().min(1) }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).resolve(r.client) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox/policy", auth: "owner", run: async (c) => (await ownSandbox(c, c.p.sandbox)).policy() }),
  route({ method: "PUT", path: "/v1/sandboxes/:sandbox/policy", auth: "admin", body: SandboxPolicyLayer, run: ({ env, p, body }) => sandbox(env, p.sandbox).setPolicy(body) }),
  route({ method: "GET", path: "/v1/sandboxes/:sandbox/generations", auth: "admin", run: ({ env, p }) => sandbox(env, p.sandbox).generations() }),
  route({ method: "POST", path: "/v1/sandboxes/:sandbox/place", auth: "admin", run: async ({ env, p }) => ({ host: await sandbox(env, p.sandbox).retryPlacement() }) }),
  route({
    method: "POST", path: "/v1/sandboxes/:sandbox/grants", auth: "admin",
    body: z.object({ host: z.string(), ttl_ms: z.number().int().positive(), ports: z.array(Port).optional() }),
    run: ({ env, p, body: r }) => sandbox(env, p.sandbox).grant(r.host, r.ttl_ms, r.ports),
  }),

  // Agents. Under `owner` auth a client acts only on its own subtree (docs/control-plane/api/clients/).
  route({
    // A spawn spec from the operator (the root: `OperatorOverrides`) or a client (which only narrows, like an
    // agent's spawn: `SpawnerOverrides`, and stays within its grant): a template, a sandbox (hands) or none, and
    // overrides. For one release the previous release's fields are accepted from the operator: `role` (the
    // same-named template), `captain` (`owner`), and top-level `launch` and `rules` (overrides).
    method: "POST", path: "/v1/agents", auth: "owner",
    body: z.object({
      template: EntryName.optional(),
      role: AgentRole.optional(),
      // Workstreams left the platform: for one release a `workstream` is accepted and ignored (old clients send it).
      workstream: z.string().optional(),
      sandbox: z.string().startsWith("sbx_").optional(),
      // A principal: an agent (`agt_…`), or `user` (the operator; the default for the operator's).
      owner: z.string().refine((o) => o === "user" || isAgentId(o), "owner is an agent id or user").optional(),
      captain: z.string().startsWith("agt_").optional(),
      // Parsed by who asks: the operator's `OperatorOverrides`, a client's `SpawnerOverrides`.
      overrides: z.unknown().optional(),
      launch: LaunchConfig.optional(),
      rules: z.array(ToolRule).optional(),
      // Grants for the agent (docs/agents/tools/#grants), checked below. The previous meaning, a list of
      // tool names, is refused, so a client still sending one never silently gets the template's wider tool set.
      grants: z.unknown().optional(),
      cell: z.string().optional(),
      start: z.boolean().default(true),
      labels: Labels.optional(),
    }),
    // Under an `Idempotency-Key`, everything runs inside its claim, so a replay never re-validates (`createOnce`).
    run: (c) => createOnce(c, "agent", async (id, begin) => {
      const { env, body: r, caller } = c;
      if (r.template && r.role && r.template !== r.role) throw new NestError(ErrorCodes.INVALID_MESSAGE, "template and role differ");
      // An override's env carries literals and placeholders only (its placeholders are checked at expansion).
      const overEnv = (r.overrides as { env?: unknown } | undefined)?.env;
      if (overEnv && typeof overEnv === "object") await refuseSecretValues(env, caller, overEnv as Record<string, string>);
      const template = r.template ?? r.role;
      if (!template) throw new NestError(ErrorCodes.INVALID_MESSAGE, "template is required");
      if (r.owner && r.captain && r.owner !== r.captain) throw new NestError(ErrorCodes.INVALID_MESSAGE, "owner and captain differ");
      const ownerAgent = [r.owner, r.captain].find(isAgentId) ?? null;
      // An agent owner given by a client must be its own; a sandbox too (404 otherwise, as for any id outside it).
      const ownerSubtree = ownerAgent ? await (await ownAgent(c, ownerAgent)).subtree() : null;
      // An agent's cell is its sandbox's: optional, and refused when it differs.
      let cellName = r.cell ?? DEFAULT_CELL;
      if (r.sandbox) {
        const sbx = await (await ownSandbox(c, r.sandbox)).info();
        if (r.cell && r.cell !== sbx.cell) {
          throw new NestError(ErrorCodes.INVALID_MESSAGE, `${r.sandbox} is in cell ${sbx.cell}; an agent takes its sandbox's`, 409);
        }
        cellName = sbx.cell;
      }
      checkCell(env, cellName);
      // Its client: the caller's, or (the operator naming an owner) its owner's. Everything in a client's
      // subtree is held to its grant, whoever creates it.
      const client = caller.kind === "client" ? caller.client : ownerSubtree?.client ?? null;
      const scope = caller.kind === "client" ? caller : client ? await clientDO(env, client).scope() : undefined;
      let spec;
      if (caller.kind === "client") {
        if (r.launch || r.rules) throw new NestError(ErrorCodes.INVALID_MESSAGE, "launch and rules are the operator's: write a template in your namespace");
        spec = await catalog(env).expand({
          template, hands: !!r.sandbox, by: "spawner", overrides: r.overrides as SpawnerOverrides | undefined, cell_idle_ttl_ms: cellIdleTtlMs(env, cellName),
        }, scope);
      } else {
        const o = OperatorOverrides.extend({
          // `params` is gone (the task ledger's `ledger` was the only one): refused, not silently dropped, for one release.
          params: z.never({ error: "overrides.params is no longer accepted: the task ledger left the platform" }).optional(),
        }).optional().safeParse(r.overrides);
        if (!o.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, o.error.message);
        const overrides: OperatorOverrides = { ...(r.launch ? { launch: r.launch } : {}), ...(r.rules ? { rules: r.rules } : {}), ...o.data };
        spec = await catalog(env).expand({ template, hands: !!r.sandbox, by: "operator", overrides }, scope);
      }
      const grants = await conferGrants(c, r.grants, client);
      const labels = r.labels ?? {};
      const owner = ownerAgent ?? (caller.kind === "client" ? caller.client : null);
      if (client) await clientDO(env, client).admit({ kind: "agent", id, cell: cellName, owner, labels });
      begin();
      const a = agent(env, id);
      await createOrRelease(env, client, id, () => a.create({
        agent: id, cell: cellName, spec, owner, sandbox: r.sandbox ?? null, labels, ...(client ? { client } : {}), ...(grants.length ? { grants } : {}),
      }));
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
      // A replay doesn't start it again: `started` is null, and its state is as it is now.
    }, async (id, status) => json({ ...(await agent(c.env, id).info()), started: null }, status, REPLAYED)),
  }),
  route({ method: "GET", path: "/v1/agents", auth: "owner", run: (c) => listing(c, "agent") }),
  route({ method: "GET", path: "/v1/agents/:agent", auth: "owner", run: async (c) => (await ownAgent(c, c.p.agent)).info() }),
  route({ method: "GET", path: "/v1/agents/:agent/turns", auth: "owner", run: async (c) => (await ownAgent(c, c.p.agent)).turns() }),
  route({ method: "GET", path: "/v1/agents/:agent/transcript", auth: "owner", run: async (c) => {
    const a = await ownAgent(c, c.p.agent);
    const q = c.url.searchParams;
    if (!q.has("since")) return new Response(await a.transcript(), { headers: { "content-type": "application/x-ndjson" } });
    const base = q.get("base");
    return a.readTranscript(num(q.get("since") ?? undefined, 0), num(q.get("limit") ?? undefined, 200), base === null ? undefined : num(base, 0));
  } }),
  // The live trace (docs/control-plane/api/#live-trace): a WebSocket AgentDO holds hibernated.
  route({ method: "GET", path: "/v1/agents/:agent/trace", auth: "owner", run: async (c) => {
    if (!isUpgrade(c.req)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "expected a WebSocket upgrade", 426);
    const after = c.url.searchParams.get("after");
    if (after !== null && !/^\d{1,15}$/.test(after)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "after must be a non-negative integer");
    const stub = await ownAgent(c, c.p.agent);
    // Only the upgrade goes on: no header of the caller's reaches the object (`x-nest-host` is the session route's).
    const u = new URL(`https://agent.internal/v1/agents/${c.p.agent}/trace`);
    if (after !== null) u.searchParams.set("after", after);
    const res = await stub.fetch(new Request(u, { headers: { upgrade: "websocket" } }));
    if (res.status === 101 || res.headers.has(TRACE_HEADER)) return res;
    // An AgentDO still on the previous release (minutes after a deploy) has no trace: it answers its session route's 400.
    throw new NestError(ErrorCodes.INTERNAL, "the live trace isn't running yet after a deploy: try again in a few minutes", 503, true);
  } }),
  // The trace's older events, from the stored transcript (docs/control-plane/api/#trace-history).
  route({ method: "GET", path: "/v1/agents/:agent/trace/history", auth: "owner", run: async (c) => {
    const q = c.url.searchParams;
    const before = q.get("before") ?? undefined;
    if (before !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(before)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "before is not a cursor the trace gave");
    const raw = q.get("limit");
    if (raw !== null && !/^\d{1,4}$/.test(raw)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "limit must be a positive integer");
    const stub = await ownAgent(c, c.p.agent);
    return newMethod("AgentDO.traceHistory", () => stub.traceHistory(before, raw === null ? undefined : Math.max(1, Number(raw))));
  } }),
  route({
    method: "POST", path: "/v1/agents/:agent/turns", auth: "owner", status: 201,
    body: z.object({ text: z.string(), kind: z.enum(["user", "recovery"]).default("user"), request_id: RequestIdField }),
    run: async (c) => ({ turn: await (await ownAgent(c, c.p.agent)).enqueueTurn({ kind: c.body.kind, text: c.body.text }, requestId(c.req, c.body.request_id)) }),
  }),
  route({
    method: "POST", path: "/v1/agents/:agent/inbox", auth: "owner", status: 201,
    body: z.object({ text: z.string(), from: z.string().optional(), interrupt: z.boolean().default(false), request_id: RequestIdField }),
    // The caller speaking as itself (`user` for the operator, its id for a client) is trusted; text it relays
    // under another name may not be (it taints).
    run: async (c) => {
      // A client names a label of its own, shown with its id; never one of nest's senders (docs/control-plane/api/clients/#inbox-senders).
      const self = c.caller.kind === "client" ? c.caller.client : OPERATOR_SENDER;
      const from = c.caller.kind === "client" ? clientSender(c.body.from, c.caller.client) : c.body.from ?? self;
      const a = await ownAgent(c, c.p.agent);
      return { message: await a.postInbox(from, c.body.text, c.body.interrupt, requestId(c.req, c.body.request_id), from !== self) };
    },
  }),
  route({ method: "POST", path: "/v1/agents/:agent/interrupt", auth: "owner", run: async (c) => (await ownAgent(c, c.p.agent)).interrupt() }),
  route({
    // An optional host: a brain on a chosen enrolled host (hands still reach the sandbox's gateway); the operator's only.
    method: "POST", path: "/v1/agents/:agent/start", auth: "owner", optionalBody: true,
    body: z.object({ host: HostId.optional(), restart: z.boolean().optional() }),
    run: async (c) => {
      if (c.body.host) operatorOnly(c, "choosing a brain's host");
      return (await ownAgent(c, c.p.agent)).start(c.body.host, undefined, c.body.restart ?? false);
    },
  }),
  route({
    // A stop the agent's next input lifts; with `end`, for good (docs/agents/#lifetimes): its brain killed, its
    // queued turns dropped, the agents it owns ended too, and with `destroy_sandbox` the sandbox created for it.
    method: "POST", path: "/v1/agents/:agent/stop", auth: "owner", optionalBody: true,
    body: z.strictObject({ end: z.boolean().optional(), destroy_sandbox: z.boolean().optional(), reason: z.string().max(500).optional() }),
    run: async (c) => {
      const r = c.body;
      const a = await ownAgent(c, c.p.agent);
      if (!r.end) {
        if (r.destroy_sandbox) throw new NestError(ErrorCodes.INVALID_MESSAGE, "destroy_sandbox needs end: true");
        return a.stop("requested");
      }
      const by = c.caller.kind === "client" ? c.caller.client : "user";
      return a.end({ by, reason: "stopped", kill: true, destroy_sandbox: r.destroy_sandbox ?? false, ...(r.reason ? { note: r.reason } : {}) });
    },
  }),
  // Its timers (docs/agents/capabilities/timers/): the owner sees and cancels them; only the agent sets them.
  route({ method: "GET", path: "/v1/agents/:agent/timers", auth: "owner", run: async (c) => ({ timers: await newMethod("AgentDO.timers", async () => (await ownAgent(c, c.p.agent)).timers()) }) }),
  route({ method: "DELETE", path: "/v1/agents/:agent/timers/:name", auth: "owner", run: async (c) => {
    const n = TimerName.safeParse(c.p.name);
    if (!n.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, n.error.issues[0]!.message);
    const by = c.caller.kind === "client" ? c.caller.client : "user";
    await newMethod("AgentDO.cancelTimerFor", async () => (await ownAgent(c, c.p.agent)).cancelTimerFor(n.data, by));
  } }),
  route({ method: "GET", path: "/v1/agents/:agent/children", auth: "owner", run: async (c) => (await ownAgent(c, c.p.agent)).children() }),
  route({ method: "PUT", path: "/v1/agents/:agent/rules", auth: "admin", body: z.array(ToolRule), run: ({ env, p, body }) => agent(env, p.agent).setRules(body) }),
  // The agent's brokered-action journal, newest first; `before` pages by an earlier page's last created_ms.
  route({ method: "GET", path: "/v1/agents/:agent/brokered", auth: "owner", run: async (c) => {
    const q = c.url.searchParams;
    return (await ownAgent(c, c.p.agent)).brokeredJournal(num(q.get("limit") ?? undefined, 100), q.has("before") ? num(q.get("before")!, Date.now()) : undefined);
  } }),
  // Its approvals (and questions) waiting for the operator or its client, oldest first; each is answered below
  // and the decision reaches the agent as its next turn (docs/agents/tools/#taint-and-sinks).
  route({ method: "GET", path: "/v1/agents/:agent/asks", auth: "owner", run: async (c) => (await ownAgent(c, c.p.agent)).openAsks() }),
  route({ method: "POST", path: "/v1/agents/:agent/asks/:ask/answer", auth: "owner", body: z.object({ answer: z.string() }),
    run: async (c) => ({ delivered: await (await ownAgent(c, c.p.agent)).answerAsk(c.p.ask, c.body.answer) }) }),

  // API clients (docs/control-plane/api/clients/): the operator's. The token is shown once, at create and rotate.
  route({
    method: "POST", path: "/v1/admin/clients", auth: "admin", status: 201, body: z.strictObject({ name: ClientName, grant: Grant }),
    run: async ({ env, body: r }) => {
      for (const cell of r.grant.cells) checkCell(env, cell);
      const id = newId("cli_");
      const token = newClientToken(id);
      const view = await clientDO(env, id).create({ client: id, name: r.name, grant: r.grant, token_hash: await tokenHash(token) });
      try {
        await directory(env).claimName(r.name, id);
      } catch (e) {
        // The name is taken: this record never had a usable token out; it goes.
        await clientDO(env, id).markDeleted();
        await clientDO(env, id).purge();
        throw e;
      }
      return { ...view, token };
    },
  }),
  route({ method: "GET", path: "/v1/admin/clients", auth: "admin", run: async ({ env }) => ({
    clients: await Promise.all((await directory(env).names()).map(async (n) => {
      try {
        return await clientDO(env, n.client).info();
      } catch {
        // A delete that stopped half-way (its DELETE, run again, finishes it).
        return { client: n.client, name: n.name, deleted: true };
      }
    })),
  }) }),
  route({ method: "GET", path: "/v1/admin/clients/:client", auth: "admin", run: ({ env, p }) => clientDO(env, p.client).info() }),
  route({
    method: "PATCH", path: "/v1/admin/clients/:client", auth: "admin", body: z.strictObject({ grant: Grant }),
    run: async ({ env, p, body: r }) => {
      for (const cell of r.grant.cells) checkCell(env, cell);
      const view = await clientDO(env, p.client).setGrant(r.grant);
      // Its live sandboxes apply the new `egress_hosts` at once (a narrowed one takes rules away).
      const failed = await fanOutGrant(env, p.client);
      if (failed) throw new NestError(ErrorCodes.INTERNAL, `the grant is saved, but ${failed} of its sandboxes didn't take it yet: PATCH again`, 503, true);
      return view;
    },
  }),
  route({ method: "POST", path: "/v1/admin/clients/:client/rotate", auth: "admin", run: async ({ env, p }) => {
    const token = newClientToken(p.client);
    return { ...(await clientDO(env, p.client).rotate(await tokenHash(token))), token };
  } }),
  route({ method: "DELETE", path: "/v1/admin/clients/:client", auth: "admin", run: async ({ env, p }) => {
    // Refused while its subtree lives; then its token stops, its catalog namespace and name go, and its record.
    const { name } = await clientDO(env, p.client).markDeleted();
    const entries = await catalog(env).deleteNamespace(name);
    // Its secrets go with it (a BrokerDO of the previous release keeps them, unreachable, until a retried DELETE).
    const secrets = await newMethod("BrokerDO.deleteClientSecrets", () => broker(env).deleteClientSecrets(p.client));
    await directory(env).releaseName(name, p.client);
    await clientDO(env, p.client).purge();
    return { deleted: p.client, name, catalog_entries: entries, secrets };
  } }),
  // A client's own record (its grant, live counts and events: what it missed shows as `events.dropped`;
  // with a `github` grant, the App its tokens come from, `github_app`) and webhook
  // (docs/control-plane/api/clients/#events-to-the-owner): https only, its signing secret in this answer
  // and nowhere else. The operator has no `self` (403).
  // A client's secrets (docs/control-plane/api/clients/#secrets): write-only values in BrokerDO under its
  // own id, within its grant's `secrets`; a listing shows names and metadata, never a value.
  route({ method: "GET", path: "/v1/clients/self/secrets", auth: "owner", run: async (c) =>
    ({ secrets: await newMethod("BrokerDO.clientSecrets", () => broker(c.env).clientSecrets(selfClient(c).client)) }) }),
  route({
    method: "PUT", path: "/v1/clients/self/secrets/:name", auth: "owner", body: ClientSecretPut,
    run: async (c) => {
      const self = selfClient(c);
      const name = clientSecretName(c.p.name);
      const limit = { max_count: self.grant.secrets?.max_count ?? 0, max_bytes: self.grant.secrets?.max_bytes ?? SECRET_MAX_BYTES_DEFAULT };
      return newMethod("BrokerDO.putClientSecret", () => broker(c.env).putClientSecret(self.client, name, c.body.value, c.body.description ?? null, limit));
    },
  }),
  route({ method: "DELETE", path: "/v1/clients/self/secrets/:name", auth: "owner", run: async (c) => {
    const self = selfClient(c);
    await newMethod("BrokerDO.deleteClientSecret", () => broker(c.env).deleteClientSecret(self.client, clientSecretName(c.p.name)));
  } }),
  // The operator's view of a client's secrets: the same metadata, never a value.
  route({ method: "GET", path: "/v1/admin/clients/:client/secrets", auth: "admin", run: async ({ env, p }) =>
    ({ secrets: await newMethod("BrokerDO.clientSecrets", () => broker(env).clientSecrets(p.client)) }) }),
  route({ method: "GET", path: "/v1/clients/self", auth: "owner", run: async (c) => {
    const self = selfClient(c);
    const view = await clientDO(c.env, self.client).info();
    const app = self.grant.github ? await githubAppOf(c.env) : null;
    return { ...view, ...(app ? { github_app: app } : {}) };
  } }),
  route({
    method: "PUT", path: "/v1/clients/self/webhook", auth: "owner", body: z.strictObject({ url: z.string().min(1).max(2048) }),
    run: (c) => newMethod("ClientDO.setWebhook", () => clientDO(c.env, selfClient(c).client).setWebhook(c.body.url)),
  }),

  // A client's own GitHub App token (docs/control-plane/api/clients/#github-tokens): one repo and the
  // permissions it names, each within its grant's `github` (403 otherwise, and nothing is minted).
  route({
    method: "POST", path: "/v1/clients/self/github-token", auth: "owner", body: GithubTokenRequest,
    run: async (c) => {
      const self = selfClient(c);
      const refusal = grantRefusal(self.client, githubTokenOutsideGrant(c.body, self.grant));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, refusal, 403);
      const t = await newMethod("BrokerDO.clientGithubToken", () => broker(c.env).clientGithubToken(self.client, c.body.repo, c.body.permissions));
      const app = await githubAppOf(c.env);
      return { token: t.token, expires_at: new Date(t.expires_ms).toISOString(), repo: c.body.repo.toLowerCase(), permissions: c.body.permissions, ...(app ?? {}) };
    },
  }),

  // The catalog as an owner sees it: the operator all of it, a client the operator's entries and its own
  // namespace, `<client-name>/<entry>`, which it alone (and the operator) writes.
  route({ method: "GET", path: "/v1/catalog", auth: "owner", run: ({ env, caller }) => catalog(env).catalog(caller.kind === "client" ? caller : undefined) }),
  ...(["templates", "capabilities"] as const).flatMap((kind) => [
    route({ method: "GET", path: `/v1/catalog/${kind}/:ns/:entry`, auth: "owner", run: async (c) => {
      await namespaceScope(c, c.p.ns);
      return catalog(c.env).entry(kind, `${c.p.ns}/${c.p.entry}`);
    } }),
    route({
      method: "PUT", path: `/v1/catalog/${kind}/:ns/:entry`, auth: "owner", body: kind === "templates" ? Template : Capability,
      run: async (c) => {
        const scope = await namespaceScope(c, c.p.ns);
        const name = `${c.p.ns}/${c.p.entry}`;
        if (kind === "templates") await refuseSecretValues(c.env, c.caller, (c.body as Template).env);
        return kind === "templates" ? catalog(c.env).putTemplate(name, c.body as Template, scope) : catalog(c.env).putCapability(name, c.body as Capability, scope);
      },
    }),
    route({ method: "DELETE", path: `/v1/catalog/${kind}/:ns/:entry`, auth: "owner", run: async (c) => {
      await namespaceScope(c, c.p.ns);
      const name = `${c.p.ns}/${c.p.entry}`;
      return kind === "templates" ? catalog(c.env).deleteTemplate(name) : catalog(c.env).deleteCapability(name);
    } }),
  ]),
];

async function dispatch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const p = match(r.path, url.pathname);
    if (!p) continue;
    let cell: string | undefined;
    const c = {
      req, env, url, p, body: undefined as unknown, claims: undefined as unknown as HostClaims, caller: { kind: "operator" } as Caller,
      get cell(): string {
        cell ??= checkCell(env, url.searchParams.get("cell") ?? DEFAULT_CELL);
        return cell;
      },
    };
    if (r.auth === "admin") {
      requireAdmin(req, env);
    } else if (r.auth === "owner") {
      c.caller = await ownerCaller(req, env);
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
