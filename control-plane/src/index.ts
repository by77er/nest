// nest control plane Worker: HTTP API, enrollment, WebSocket routing to Durable Objects.
import "reflect-metadata";
import { z } from "zod";
import { num, type Env } from "./env";
import { CmsRsaIdentityVerifier, type InstanceIdentity } from "./lib/aws-identity";
import { bearer, verifyBlobUrl, verifyHostToken } from "./lib/tokens";
import { asNestError, errorResponse, json, NestError, newId, timingSafeEqual } from "./lib/util";
import { checkHealth, healthProbes } from "./lib/health";
import { EnrollRequest, LaunchConfig, ToolRule } from "./protocol/control";
import { AclEntry, type Caller, ChannelName, MAX_RETENTION_DAYS, parseChannel, SubscribeInput } from "./lib/channels";
import { Capability, CatalogName, intersectTools, OperatorOverrides, Template } from "./lib/spec";
import { type Actor, LedgerName, type SpecGrant, type TaskOp, TaskPriority, TaskStatus } from "./lib/tasks";
import { LIST_DEFAULT_LIMIT, ledgerStub } from "./do/tasks";
import { DIRECTORY } from "./do/channel";
import { AgentRole, ErrorCodes, type ErrorBody, HostId, HostRole, InjectionBinding, PROTOCOL_VERSION, Resources } from "./protocol/model";

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

/** Workstream egress policy layer (docs/sandbox/networking/egress/policy/). */
const PolicyLayer = z.object({
  allow: z.array(z.object({ host: z.string().min(1), ports: z.array(z.number().int().min(1).max(65535)).optional() })).default([]),
  passthrough: z.array(z.string().min(1)).default([]),
  inject: z.array(InjectionBinding).default([]),
  tcp: z.array(z.object({ host: z.string().min(1), port: z.number().int().min(1).max(65535) })).default([]),
});

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

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  let raw: unknown;
  try {
    raw = await req.json();
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

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = (re: RegExp) => re.exec(path);
  let p: RegExpExecArray | null = null;

  if (req.method === "GET" && path === "/v1/health") {
    // Unauthenticated: one read-only round trip to each DO class's own health instance, nothing else,
    // shared by this isolate's requests for a few seconds so a flood can't multiply it.
    const h = await sharedHealth(env);
    return json({ ok: h.ok, protocol_version: PROTOCOL_VERSION, durable_objects: h.durable_objects }, h.ok ? 200 : 503);
  }
  if (req.method === "POST" && path === "/v1/hosts/enroll") return enroll(req, env);

  // Host-authenticated HTTP: object-store GC (a sandbox host runs it; FleetDO says when and from what).
  if (req.method === "POST" && (path === "/v1/hosts/gc/claim" || path === "/v1/hosts/gc/report")) {
    const token = bearer(req);
    if (!token) throw new NestError(ErrorCodes.UNAUTHORIZED, "host token required", 401);
    const claims = await verifyHostToken(env.HOST_TOKEN_SECRET, token);
    const f = fleet(env, checkCell(env, claims.cell));
    if (path === "/v1/hosts/gc/claim") {
      const c = await f.gcClaim(claims.host);
      return c ? json(c) : new Response(null, { status: 204 });
    }
    const r = await body(req, z.object({ run: z.string().startsWith("gc_"), report: z.record(z.string(), z.unknown()) }));
    await f.gcReport(claims.host, r.run, r.report);
    return json({ ok: true });
  }

  // Host-authenticated WebSockets.
  if (path === "/v1/fleet" || (p = m(/^\/v1\/agents\/(agt_[A-Za-z0-9-]+)\/session$/))) {
    if (!isUpgrade(req)) throw new NestError(ErrorCodes.INVALID_MESSAGE, "expected a WebSocket upgrade", 426);
    const token = bearer(req);
    if (!token) throw new NestError(ErrorCodes.UNAUTHORIZED, "host token required", 401);
    // Only the fleet channel accepts a recently expired token: FleetDO rotates it right after hello.
    const claims = await verifyHostToken(env.HOST_TOKEN_SECRET, token, Date.now(), path === "/v1/fleet" ? FLEET_TOKEN_GRACE_MS : 0);
    const headers = new Headers(req.headers);
    headers.set("x-nest-host", claims.host);
    headers.set("x-nest-cell", claims.cell);
    const forwarded = new Request(req.url, { headers, method: "GET" });
    if (path === "/v1/fleet") return fleet(env, claims.cell).fetch(forwarded);
    return agent(env, (p as RegExpExecArray)[1]!).fetch(forwarded);
  }

  // Worker-signed blob URLs (no R2 S3 credentials anywhere): session segments for `claude --resume`.
  if (req.method === "GET" && (p = m(/^\/v1\/blobs\/(.+)$/))) {
    const key = p[1]!.split("/").map(decodeURIComponent).join("/");
    if (!(await verifyBlobUrl(env.HOST_TOKEN_SECRET, key, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
      throw new NestError(ErrorCodes.UNAUTHORIZED, "bad or expired signature", 403);
    }
    const obj = await env.BUCKET.get(key);
    if (!obj) throw new NestError(ErrorCodes.INVALID_MESSAGE, "no such blob", 404);
    return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
  }

  // Everything below is the admin API.
  requireAdmin(req, env);
  const cell = checkCell(env, url.searchParams.get("cell") ?? DEFAULT_CELL);

  if (req.method === "POST" && path === "/v1/admin/enrollment-tokens") {
    const r = await body(req, z.object({ role: HostRole, cell: z.string().default(DEFAULT_CELL) }));
    return json({ token: await fleet(env, checkCell(env, r.cell)).mintEnrollmentToken(r.role), cell: r.cell });
  }
  if (req.method === "POST" && path === "/v1/admin/launched") {
    const r = await body(req, z.object({
      instance_id: z.string(), role: HostRole.default("burst"), account_id: z.string().optional(), region: z.string().optional(),
      cell: z.string().default(DEFAULT_CELL),
    }));
    await fleet(env, checkCell(env, r.cell)).registerLaunched({
      instance_id: r.instance_id, role: r.role, ...(r.account_id ? { account_id: r.account_id } : {}), ...(r.region ? { region: r.region } : {}),
    });
    return json({ ok: true });
  }
  if (req.method === "POST" && (p = m(/^\/v1\/admin\/hosts\/(hst_[A-Za-z0-9]+)\/confirm-dead$/))) {
    await fleet(env, cell).confirmHostDead(p[1]!);
    return json({ ok: true });
  }
  if (req.method === "GET" && (p = m(/^\/v1\/admin\/hosts\/(hst_[A-Za-z0-9]+)$/))) {
    return json(await fleet(env, cell).hostStatus(p[1]!));
  }
  if (req.method === "GET" && path === "/v1/admin/fleet") return json(await fleet(env, cell).fleetView());
  if (req.method === "GET" && path === "/v1/admin/images") return json(await fleet(env, cell).images());
  // The daily tunnel sweep, now (after a Cloudflare outage, or to see what the account holds).
  if (req.method === "POST" && path === "/v1/admin/tunnels/sweep") return json(await fleet(env, cell).tunnelSweep());
  if (req.method === "GET" && path === "/v1/admin/gc") return json(await fleet(env, cell).gcStatus());
  if (req.method === "POST" && path === "/v1/admin/gc/run") {
    await fleet(env, cell).gcRequest();
    return json({ ok: true, note: "the next sandbox host to check in runs it (dry run until one completes)" });
  }
  if (req.method === "POST" && path === "/v1/admin/gc/register") {
    const r = await body(req, z.object({ sandboxes: z.array(z.string().startsWith("sbx_")) }));
    return json({ live: await fleet(env, cell).registerSandboxes(r.sandboxes) });
  }
  if (req.method === "GET" && path === "/v1/admin/root-ca") {
    return new Response(await fleet(env, cell).rootCertificatePem(), { headers: { "content-type": "application/x-pem-file" } });
  }
  if (req.method === "PUT" && (p = m(/^\/v1\/admin\/secrets\/([A-Za-z0-9_:.-]+)$/))) {
    // BrokerDO's own keys (the per-cell binding signing keys) are generated, never provided.
    if (p[1]!.startsWith("binding_key:")) throw new NestError(ErrorCodes.FORBIDDEN, "binding keys are generated by the broker, not provided", 403);
    const r = await body(req, z.object({ value: z.string(), expires_ms: z.number().int().optional() }));
    await broker(env).putSecret(p[1]!, r.value, r.expires_ms);
    return json({ ok: true });
  }

  // Templates and capabilities (docs/agents/capabilities/): data the operator edits.
  if (req.method === "GET" && path === "/v1/admin/catalog") return json(await catalog(env).catalog());
  if ((p = m(/^\/v1\/admin\/(capabilities|templates)\/([^/]+)$/))) {
    const name = CatalogName.safeParse(p[2]);
    if (!name.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, name.error.message);
    const c = catalog(env);
    if (req.method === "PUT" && p[1] === "capabilities") return json(await c.putCapability(name.data, await body(req, Capability)));
    if (req.method === "PUT" && p[1] === "templates") return json(await c.putTemplate(name.data, await body(req, Template)));
    if (req.method === "DELETE") {
      await (p[1] === "capabilities" ? c.deleteCapability(name.data) : c.deleteTemplate(name.data));
      return json({ ok: true });
    }
  }

  // Channels (docs/channels/): the operator is `user`, the root. A channel's name is one path segment,
  // URL-encoded (`agt_…%2Finbox`).
  if (req.method === "POST" && path === "/v1/admin/channels") {
    const r = await body(req, z.object({ name: ChannelName, retention_days: z.number().int().min(1).max(MAX_RETENTION_DAYS).optional() }));
    return json(await channel(env, r.name).create(r.name, USER, r.retention_days), 201);
  }
  if (req.method === "GET" && path === "/v1/admin/channels") {
    return json(await channel(env, DIRECTORY).dirList(url.searchParams.get("prefix") ?? "", url.searchParams.get("after") ?? "",
      num(url.searchParams.get("limit") ?? undefined, 200)));
  }
  if ((p = m(/^\/v1\/admin\/channels\/([^/]+)(\/messages|\/subscriptions|\/acl)?(?:\/(sub_[a-z0-9_]+))?$/))) {
    let name: string;
    try {
      name = decodeURIComponent(p[1]!);
    } catch {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, "bad channel name encoding");
    }
    const kind = parseChannel(name);
    if (!kind.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, kind.error);
    // An agent's built-in channel exists with its agent: 404 for one that never existed.
    if (kind.value.kind === "inbox" || kind.value.kind === "events") await existingAgent(env, kind.value.agent);
    const c = channel(env, name);
    if (req.method === "GET" && !p[2]) return json(await c.info(name));
    if (req.method === "GET" && p[2] === "/messages") {
      const q = url.searchParams;
      const flag = (k: string) => q.get(k) === "true" || q.get(k) === "1";
      const int = (k: string) => (q.has(k) ? num(q.get(k) ?? undefined, 0) : undefined);
      const since = int("since");
      const limit = int("limit");
      return json(await c.read(name, USER, {
        ...(since !== undefined ? { since } : {}), ...(limit !== undefined ? { limit } : {}),
        ...(flag("latest_by_key") ? { latest_by_key: true } : {}), ...(q.has("prefix") ? { prefix: q.get("prefix")! } : {}),
        ...(flag("keys_only") ? { keys_only: true } : {}), ...(q.has("after_key") ? { after_key: q.get("after_key")! } : {}),
      }));
    }
    if (req.method === "POST" && p[2] === "/messages") {
      const r = await c.post(name, USER, await body(req, z.unknown()));
      return json(r, r.status === "conflict" ? 409 : r.status === "posted" ? 201 : 200);
    }
    if (req.method === "GET" && p[2] === "/subscriptions" && !p[3]) return json(await c.subscriptions(name));
    if (req.method === "POST" && p[2] === "/subscriptions" && !p[3]) {
      // On an agent's behalf (a spawner subscribing its child is the operator here until agent_spawn exists).
      const r = await body(req, z.object({ agent: z.string().regex(/^agt_[a-z0-9]+$/) }).passthrough());
      await existingAgent(env, r.agent);
      const { agent: who, ...rest } = r;
      const input = SubscribeInput.safeParse(rest);
      if (!input.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, input.error.message);
      return json(await c.subscribe(name, USER, who, input.data), 201);
    }
    if (req.method === "DELETE" && p[2] === "/subscriptions" && p[3]) return json(await c.unsubscribe(name, USER, p[3]));
    if (req.method === "PUT" && p[2] === "/acl") return json(await c.setAcl(name, await body(req, z.array(AclEntry))));
  }

  // Workstreams: the interim workstream channel (docs/orchestration/workstreams/). `captain` is the
  // previous release's name for `subscriber`, accepted for one release.
  if (req.method === "POST" && path === "/v1/workstreams") {
    const r = await body(req, z.object({
      goal: z.string(), subscriber: z.string().startsWith("agt_").nullable().optional(), captain: z.string().startsWith("agt_").nullable().optional(),
    }));
    // A subscriber must be an agent of the workstream, and a new one has none yet.
    if (r.subscriber || r.captain) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, "a new workstream has no agents yet: set its subscriber once one is spawned in it");
    }
    const id = newId("ws_");
    return json(await workstream(env, id).init(id, r.goal, null), 201);
  }
  if ((p = m(/^\/v1\/workstreams\/(ws_[A-Za-z0-9]+)(\/events|\/subscriber|\/captain|\/notifications)?$/))) {
    const ws = workstream(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await ws.info());
    if (req.method === "GET" && p[2] === "/events") return json(await ws.events(num(url.searchParams.get("limit") ?? undefined, 100)));
    if (req.method === "GET" && p[2] === "/notifications") return json(await ws.userNotifications());
    if (req.method === "PUT" && (p[2] === "/subscriber" || p[2] === "/captain")) {
      const r = await body(req, z.object({
        subscriber: z.string().startsWith("agt_").nullable().optional(), captain: z.string().startsWith("agt_").nullable().optional(),
      }));
      const subscriber = r.subscriber !== undefined ? r.subscriber : r.captain;
      if (subscriber === undefined) throw new NestError(ErrorCodes.INVALID_MESSAGE, "subscriber is required (an agent id, or null)");
      if (subscriber) {
        // Only an agent of this workstream reads its channel (its events come from that workstream's agents).
        const other = (await existingAgent(env, subscriber)).workstream;
        if (other !== p[1]) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${subscriber} is in workstream ${other}, not ${p[1]}`, 409);
      }
      await ws.setSubscriber(subscriber);
      return json({ ok: true });
    }
  }

  // Task ledgers (docs/control-plane/durable-objects/tasks/): named, with the operator as the root.
  if ((p = m(/^\/v1\/ledgers\/([^/]+)(\/watcher|\/tasks(?:\/([^/]+)(\/assign|\/comments)?)?)?$/))) {
    const parsed = LedgerName.safeParse(p[1]);
    if (!parsed.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, parsed.error.issues[0]!.message);
    const name = parsed.data;
    const l = ledgerStub(env, name);
    const operator: Actor = { kind: "operator" };
    const [, , sub, ref, action] = p;
    /** An agent's grant as its spec states it (null: unassign / no watcher). */
    const grantOf = async (id: string | null): Promise<SpecGrant | null> => {
      if (id === null) return null;
      const a = await agent(env, id).info();
      return { agent: id, ledger: a.params?.ledger ?? null, tools: a.tools };
    };
    const AgentOrNull = z.string().startsWith("agt_").nullable();
    if (req.method === "GET" && !sub) return json(await l.info(name, operator));
    if (req.method === "PUT" && sub === "/watcher") {
      const r = await body(req, z.object({ watcher: AgentOrNull, request_id: RequestIdField }));
      return json(await l.apply(name, operator, { kind: "set_watcher", watcher: await grantOf(r.watcher) }, requestId(req, r.request_id)));
    }
    if (sub?.startsWith("/tasks") && !ref) {
      if (req.method === "GET") {
        const q = (k: string) => url.searchParams.get(k) ?? undefined;
        const status = q("status");
        // A query string has no null: `assignee=none` is the unassigned filter here.
        const assignee = q("assignee");
        if (status !== undefined && !TaskStatus.safeParse(status).success) throw new NestError(ErrorCodes.INVALID_MESSAGE, `unknown status ${status}`);
        return json(await l.list(name, operator, {
          status: status as TaskStatus | undefined, assignee: assignee === "none" ? null : assignee, label: q("label"), text: q("text"), parent: q("parent"),
        }, num(q("cursor"), 0), num(q("limit"), LIST_DEFAULT_LIMIT)));
      }
      if (req.method === "POST") {
        const r = await body(req, TaskEditsBody.extend({ title: z.string(), assignee: AgentOrNull.optional(), request_id: RequestIdField }));
        const { assignee, request_id, ...edits } = r;
        const grant = await grantOf(assignee ?? null);
        const op: TaskOp = { kind: "create", ...edits, parent: edits.parent ?? undefined, ...(grant ? { assignee: grant } : {}) };
        return json((await l.apply(name, operator, op, requestId(req, request_id))).task, 201);
      }
    }
    if (ref && !action) {
      if (req.method === "GET") return json(await l.get(name, operator, ref));
      if (req.method === "PATCH") {
        const r = await body(req, TaskEditsBody.extend({ expected_version: z.number().int().optional(), request_id: RequestIdField }));
        const { request_id, ...edits } = r;
        return json((await l.apply(name, operator, { kind: "update_any", task: ref, ...edits }, requestId(req, request_id))).task);
      }
    }
    if (req.method === "POST" && ref && action === "/assign") {
      const r = await body(req, z.object({ assignee: AgentOrNull, expected_version: z.number().int().optional(), request_id: RequestIdField }));
      const op: TaskOp = { kind: "assign", task: ref, expected_version: r.expected_version, assignee: await grantOf(r.assignee) };
      return json((await l.apply(name, operator, op, requestId(req, r.request_id))).task);
    }
    if (req.method === "POST" && ref && action === "/comments") {
      const r = await body(req, z.object({ body: z.string(), request_id: RequestIdField }));
      return json((await l.apply(name, operator, { kind: "comment", task: ref, body: r.body }, requestId(req, r.request_id))).comment, 201);
    }
  }

  if (req.method === "POST" && path === "/v1/sandboxes") {
    const r = await body(req, z.object({
      workstream: z.string().startsWith("ws_"),
      image: z.string().optional(),
      resources: Resources.optional(),
      policy: PolicyLayer.optional(),
      cell: z.string().default(DEFAULT_CELL),
    }));
    const id = newId("sbx_");
    const info = await sandbox(env, id).create({
      sandbox: id, workstream: r.workstream, cell: checkCell(env, r.cell),
      ...(r.image ? { image: r.image } : {}), ...(r.resources ? { resources: r.resources } : {}),
      ...(r.policy ? { workstreamPolicy: r.policy } : {}),
    });
    // 202: accepted and waiting for a host (SandboxDO retries; an autoscaled cell launches one).
    return json(info, info.host ? 201 : 202);
  }
  if ((p = m(/^\/v1\/sandboxes\/(sbx_[A-Za-z0-9]+)\/ports(?:\/(\d+))?$/))) {
    const s = sandbox(env, p[1]!);
    if (req.method === "POST" && !p[2]) {
      // Operator path: the only place public share links are minted.
      const r = await body(req, z.object({ port: z.number().int().min(1).max(65535), share: z.boolean().default(false), host_header: z.enum(["localhost", "preserve"]).default("localhost") }));
      return json(await s.exposePort(r.port, r.share, r.host_header));
    }
    if (req.method === "DELETE" && p[2]) {
      await s.unexposePort(Number(p[2]));
      return json({ ok: true });
    }
  }
  if ((p = m(/^\/v1\/sandboxes\/(sbx_[A-Za-z0-9]+)(\/grants|\/policy|\/generations|\/place|\/resolve)?$/))) {
    const s = sandbox(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await s.info());
    // A person's (or a test harness's) way to a sandbox's hands: the same target an agent gets.
    if (req.method === "POST" && p[2] === "/resolve") {
      const r = await body(req, z.object({ client: z.string().min(1) }));
      return json(await s.resolve(r.client));
    }
    if (req.method === "DELETE" && !p[2]) {
      await s.destroy();
      return json({ ok: true });
    }
    if (req.method === "GET" && p[2] === "/policy") return json(await s.policy());
    if (req.method === "PUT" && p[2] === "/policy") return json(await s.setWorkstreamPolicy(await body(req, PolicyLayer)));
    if (req.method === "GET" && p[2] === "/generations") return json(await s.generations());
    if (req.method === "POST" && p[2] === "/place") return json({ host: await s.retryPlacement() });
    if (req.method === "POST" && p[2] === "/grants") {
      const r = await body(req, z.object({ host: z.string(), ttl_ms: z.number().int().positive(), ports: z.array(z.number().int()).optional() }));
      return json(await s.grant(r.host, r.ttl_ms, r.ports));
    }
  }

  if (req.method === "POST" && path === "/v1/agents") {
    // A spawn spec from the operator (the root: `OperatorOverrides`; an agent's spawn may only narrow,
    // `SpawnerOverrides`): a template, a sandbox (hands) or none, and overrides. For one release the
    // previous release's fields are accepted: `role` (the same-named template), `captain` (`owner`),
    // top-level `launch` and `rules` (overrides), and `grants` (intersects the tools silently, as it did).
    const r = await body(req, z.object({
      template: CatalogName.optional(),
      role: AgentRole.optional(),
      // An agent's workstream and cell are its sandbox's: optional, and refused when they differ.
      workstream: z.string().startsWith("ws_").optional(),
      sandbox: z.string().startsWith("sbx_").optional(),
      owner: z.string().startsWith("agt_").optional(),
      captain: z.string().startsWith("agt_").optional(),
      overrides: OperatorOverrides.optional(),
      launch: LaunchConfig.optional(),
      grants: z.array(z.string()).optional(),
      rules: z.array(ToolRule).optional(),
      cell: z.string().optional(),
      start: z.boolean().default(true),
    }));
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
    const expanded = await catalog(env).expand({ template, hands: !!r.sandbox, by: "operator", overrides });
    const spec = r.grants ? intersectTools(expanded, r.grants) : expanded;
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
  }
  if ((p = m(/^\/v1\/agents\/(agt_[A-Za-z0-9]+)(\/turns|\/inbox|\/interrupt|\/start|\/stop|\/transcript|\/rules|\/subscriptions|\/asks\/(ask_[A-Za-z0-9]+)\/answer)?$/))) {
    const a = agent(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await a.info());
    if (req.method === "GET" && p[2] === "/turns") return json(await a.turns());
    if (req.method === "GET" && p[2] === "/subscriptions") return json(await a.channelSubscriptions());
    if (req.method === "GET" && p[2] === "/transcript" && url.searchParams.has("since")) {
      const base = url.searchParams.get("base");
      return json(await a.readTranscript(num(url.searchParams.get("since") ?? undefined, 0), num(url.searchParams.get("limit") ?? undefined, 200),
        base === null ? undefined : num(base, 0)));
    }
    if (req.method === "GET" && p[2] === "/transcript") return new Response(await a.transcript(), { headers: { "content-type": "application/x-ndjson" } });
    if (req.method === "POST" && p[2] === "/turns") {
      const r = await body(req, z.object({ text: z.string(), kind: z.enum(["user", "recovery"]).default("user"), request_id: RequestIdField }));
      return json({ turn: await a.enqueueTurn({ kind: r.kind, text: r.text }, requestId(req, r.request_id)) }, 201);
    }
    if (req.method === "POST" && p[2] === "/inbox") {
      const r = await body(req, z.object({
        text: z.string(), from: z.string().default("user"), interrupt: z.boolean().default(false), request_id: RequestIdField,
      }));
      // The operator speaking as `user` is trusted; text it relays under another name may not be (it taints).
      return json({ message: await a.postInbox(r.from, r.text, r.interrupt, requestId(req, r.request_id), r.from !== "user") }, 201);
    }
    if (req.method === "POST" && p[2] === "/interrupt") {
      await a.interrupt();
      return json({ ok: true });
    }
    if (req.method === "POST" && p[2] === "/start") {
      // An optional host: a brain on a chosen enrolled host (hands still reach the sandbox's gateway).
      const text = await req.text();
      let r: { host?: string; restart?: boolean } = {};
      if (text.trim()) {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new NestError(ErrorCodes.INVALID_MESSAGE, "body must be JSON");
        }
        const parsed = z.object({ host: HostId.optional(), restart: z.boolean().optional() }).safeParse(raw);
        if (!parsed.success) throw new NestError(ErrorCodes.INVALID_MESSAGE, parsed.error.message);
        r = parsed.data;
      }
      return json(await a.start(r.host, undefined, r.restart ?? false));
    }

    if (req.method === "POST" && p[2] === "/stop") {
      await a.stop("requested");
      return json({ ok: true });
    }
    if (req.method === "PUT" && p[2] === "/rules") {
      await a.setRules(await body(req, z.array(ToolRule)));
      return json({ ok: true });
    }
    if (req.method === "POST" && p[3]) {
      const r = await body(req, z.object({ answer: z.string() }));
      return json({ delivered: await a.answerAsk(p[3], r.answer) });
    }
  }

  throw new NestError(ErrorCodes.INVALID_MESSAGE, `no route for ${req.method} ${path}`, 404);
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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
} satisfies ExportedHandler<Env>;
