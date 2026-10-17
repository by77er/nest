// nest control plane Worker: HTTP API, enrollment, WebSocket routing to Durable Objects.
import "reflect-metadata";
import { z } from "zod";
import { num, type Env } from "./env";
import { CmsRsaIdentityVerifier, type InstanceIdentity } from "./lib/aws-identity";
import { bearer, verifyBlobUrl, verifyHostToken } from "./lib/tokens";
import { asNestError, errorResponse, json, NestError, newId, timingSafeEqual } from "./lib/util";
import { EnrollRequest, LaunchConfig, ToolRule } from "./protocol/control";
import { AgentRole, ErrorCodes, HostRole, InjectionBinding, PROTOCOL_VERSION, Resources } from "./protocol/model";

export { AgentDO } from "./do/agent";
export { BrokerDO } from "./do/broker";
export { FleetDO } from "./do/fleet";
export { SandboxDO } from "./do/sandbox";
export { WorkstreamDO } from "./do/workstream";

const DEFAULT_CELL = "local";
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
    throw new NestError(ErrorCodes.UNSUPPORTED_PROTOCOL_VERSION, `server speaks ${PROTOCOL_VERSION}`);
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

  if (req.method === "GET" && path === "/v1/health") return json({ ok: true, protocol_version: PROTOCOL_VERSION });
  if (req.method === "POST" && path === "/v1/hosts/enroll") return enroll(req, env);

  // Host-authenticated HTTP: object-store GC (a burst host runs it; FleetDO says when and from what).
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
  if (req.method === "GET" && path === "/v1/admin/gc") return json(await fleet(env, cell).gcStatus());
  if (req.method === "POST" && path === "/v1/admin/gc/run") {
    await fleet(env, cell).gcRequest();
    return json({ ok: true, note: "the next burst host to check in runs it (dry run until one completes)" });
  }
  if (req.method === "POST" && path === "/v1/admin/gc/register") {
    const r = await body(req, z.object({ sandboxes: z.array(z.string().startsWith("sbx_")) }));
    return json({ live: await fleet(env, cell).registerSandboxes(r.sandboxes) });
  }
  if (req.method === "GET" && path === "/v1/admin/root-ca") {
    return new Response(await fleet(env, cell).rootCertificatePem(), { headers: { "content-type": "application/x-pem-file" } });
  }
  if (req.method === "PUT" && (p = m(/^\/v1\/admin\/secrets\/([A-Za-z0-9_:.-]+)$/))) {
    const r = await body(req, z.object({ value: z.string(), expires_ms: z.number().int().optional() }));
    await broker(env).putSecret(p[1]!, r.value, r.expires_ms);
    return json({ ok: true });
  }

  if (req.method === "POST" && path === "/v1/workstreams") {
    const r = await body(req, z.object({ goal: z.string(), captain: z.string().startsWith("agt_").nullable().default(null) }));
    const id = newId("ws_");
    return json(await workstream(env, id).init(id, r.goal, r.captain), 201);
  }
  if ((p = m(/^\/v1\/workstreams\/(ws_[A-Za-z0-9]+)(\/events|\/captain|\/notifications)?$/))) {
    const ws = workstream(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await ws.info());
    if (req.method === "GET" && p[2] === "/events") return json(await ws.events(num(url.searchParams.get("limit") ?? undefined, 100)));
    if (req.method === "GET" && p[2] === "/notifications") return json(await ws.userNotifications());
    if (req.method === "PUT" && p[2] === "/captain") {
      const r = await body(req, z.object({ captain: z.string().startsWith("agt_").nullable() }));
      await ws.setCaptain(r.captain);
      return json({ ok: true });
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
  if ((p = m(/^\/v1\/sandboxes\/(sbx_[A-Za-z0-9]+)(\/grants|\/policy|\/generations|\/place)?$/))) {
    const s = sandbox(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await s.info());
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
    const r = await body(req, z.object({
      role: AgentRole,
      workstream: z.string().startsWith("ws_"),
      sandbox: z.string().startsWith("sbx_").optional(),
      captain: z.string().startsWith("agt_").optional(),
      launch: LaunchConfig.optional(),
      grants: z.array(z.string()).optional(),
      rules: z.array(ToolRule).optional(),
      cell: z.string().default(DEFAULT_CELL),
      start: z.boolean().default(true),
    }));
    checkCell(env, r.cell);
    if (r.role === "worker" && !r.sandbox) throw new NestError(ErrorCodes.INVALID_MESSAGE, "workers need a sandbox");
    if (r.role === "captain" && r.sandbox) throw new NestError(ErrorCodes.INVALID_MESSAGE, "captains have no hands");
    const id = newId("agt_");
    const a = agent(env, id);
    await a.create({
      agent: id, role: r.role, workstream: r.workstream, cell: r.cell, captain: r.captain ?? null,
      sandbox: r.sandbox ?? null, ...(r.launch ? { launch: r.launch } : {}), grants: r.grants ?? null,
      ...(r.rules ? { rules: r.rules } : {}),
    });
    if (r.role === "captain") await workstream(env, r.workstream).setCaptain(id);
    const started = r.start ? await a.start() : null;
    return json({ ...(await a.info()), started }, 201);
  }
  if ((p = m(/^\/v1\/agents\/(agt_[A-Za-z0-9]+)(\/turns|\/inbox|\/interrupt|\/start|\/stop|\/transcript|\/rules|\/asks\/(ask_[A-Za-z0-9]+)\/answer)?$/))) {
    const a = agent(env, p[1]!);
    if (req.method === "GET" && !p[2]) return json(await a.info());
    if (req.method === "GET" && p[2] === "/turns") return json(await a.turns());
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
      return json({ message: await a.postInbox(r.from, r.text, r.interrupt, requestId(req, r.request_id)) }, 201);
    }
    if (req.method === "POST" && p[2] === "/interrupt") {
      await a.interrupt();
      return json({ ok: true });
    }
    if (req.method === "POST" && p[2] === "/start") return json(await a.start());

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
