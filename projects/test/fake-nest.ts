// A fake of nest's client interface, as docs/control-plane/api/clients/ and docs/interfaces/remote-mcp/
// describe it: the routes the app calls (answering as nest does: a create's cell in its body, refused
// outside the grant's; a create's Idempotency-Key replayed, conflicting or in progress), the JWKS behind Nest-Identity, and helpers that sign identity tokens, Access tokens and
// webhooks the way nest and Cloudflare do. It replaces the global fetch, which the Worker and its Durable
// Objects share with the tests in the pool, and records every call.

import { env, SELF } from "cloudflare:test";
import { sign as signWebhook } from "../src/webhook";

export const NEST = "https://nest.test";
export const APP = "https://projects.test";
export const CLIENT = "cli_app";
export const CELL = "use1";
export const TEAM = "https://team.cloudflareaccess.com";
export const AUD = "aud-of-the-projects-application";

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

export interface FakeAgent {
  agent: string;
  owner: string;
  client: string | null;
  labels: Record<string, string>;
  template: string;
  sandbox: string | null;
  overrides: unknown;
  ended: boolean;
}

export interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
  auth: string | null;
  idempotencyKey: string | null;
}

/** JSON with sorted keys: a request's identity for its idempotency key, as nest binds one. */
const canonical = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);

let seq = 0;
const id = (prefix: string) => `${prefix}${(++seq).toString(36)}${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;

export class FakeNest {
  readonly calls: Call[] = [];
  readonly agents = new Map<string, FakeAgent>();
  readonly sandboxes = new Map<string, { sandbox: string; owner: string; labels: Record<string, string>; ended: boolean }>();
  readonly inbox: { agent: string; text: string; from?: string; request_id?: string }[] = [];
  readonly catalog = new Map<string, unknown>();
  readonly answers: { agent: string; ask: string; answer: string }[] = [];
  jwks: { keys: unknown[] } = { keys: [] };
  jwksFetches = 0;
  /** Failures to answer, in order, for calls whose `METHOD path` matches. */
  failures: { match: RegExp; status: number; retryable?: boolean; times: number }[] = [];
  /** Creates that are made but whose answer is lost (a 500 instead), as after a timeout. */
  lost: { match: RegExp; times: number }[] = [];
  /** Creates answered "still being handled" (409, retryable) before they run. */
  inProgress: { match: RegExp; times: number }[] = [];
  /** Idempotency keys: the request each binds, and its first answer once made. */
  readonly keys = new Map<string, { digest: string; status: number; body: string }>();

  fail(match: RegExp, status: number, o: { retryable?: boolean; times?: number } = {}): void {
    this.failures.push({ match, status, retryable: o.retryable, times: o.times ?? 1 });
  }

  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const nestErr = (status: number, code: string, message: string, retryable = false) => json(status, { error: { code, message, retryable } });
    if (u.pathname === "/.well-known/jwks.json") {
      this.jwksFetches++;
      return json(200, this.jwks);
    }
    const text = await req.text();
    const call: Call = {
      method: req.method, path: u.pathname, query: u.searchParams, body: text ? JSON.parse(text) : undefined,
      auth: req.headers.get("authorization"), idempotencyKey: req.headers.get("idempotency-key"),
    };
    this.calls.push(call);
    if (call.auth !== `Bearer ${env.NEST_CLIENT_TOKEN}`) return nestErr(401, "unauthorized", "admin or client token required");
    const route = `${req.method} ${u.pathname}`;
    const f = this.failures.find((x) => x.times > 0 && x.match.test(route));
    if (f) {
      f.times--;
      return nestErr(f.status, f.status === 503 ? "internal" : "refused", "injected", f.retryable ?? false);
    }
    if (route !== "POST /v1/sandboxes" && route !== "POST /v1/agents") return this.route(req, u, call);
    // A create: its cell in the body (nest's default, `local`, is outside the grant), and its key.
    if (call.body?.cell !== CELL) return nestErr(403, "forbidden", `cell ${call.body?.cell ?? "local"} is outside the grant`);
    const key = call.idempotencyKey;
    if (key === null) return this.route(req, u, call);
    const digest = `${route} ${canonical(call.body)}`;
    const had = this.keys.get(key);
    if (had && had.digest !== digest) return nestErr(409, "conflict", "this Idempotency-Key was used for a different request", false);
    const busy = this.inProgress.find((x) => x.times > 0 && x.match.test(key));
    if (busy) {
      busy.times--;
      return nestErr(409, "conflict", "a request with this Idempotency-Key is still being handled", true);
    }
    if (had) {
      return new Response(had.body, { status: had.status, headers: { "content-type": "application/json", "idempotent-replayed": "true" } });
    }
    const res = await this.route(req, u, call);
    if (res.ok) this.keys.set(key, { digest, status: res.status, body: await res.clone().text() });
    const lose = this.lost.find((x) => x.times > 0 && x.match.test(route));
    if (lose) {
      lose.times--;
      return nestErr(500, "internal", "the answer was lost", true);
    }
    return res;
  }

  private async route(req: Request, u: URL, call: Call): Promise<Response> {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const nestErr = (status: number, code: string, message: string, retryable = false) => json(status, { error: { code, message, retryable } });
    const labelsMatch = (have: Record<string, string>) => u.searchParams.getAll("label").every((l) => {
      const i = l.indexOf("=");
      return have[l.slice(0, i)] === l.slice(i + 1);
    });
    let m: RegExpMatchArray | null;
    const r = `${req.method} ${u.pathname}`;
    if (r === "POST /v1/sandboxes") {
      const s = { sandbox: id("sbx_"), owner: CLIENT, labels: call.body.labels ?? {}, ended: false };
      this.sandboxes.set(s.sandbox, s);
      return json(202, { sandbox: s.sandbox, cell: call.body.cell, labels: s.labels, host: null });
    }
    if (r === "GET /v1/sandboxes") {
      const rows = [...this.sandboxes.values()].filter((s) => !s.ended && labelsMatch(s.labels));
      return json(200, { sandboxes: rows.map((s) => ({ sandbox: s.sandbox, cell: CELL, client: CLIENT, owner: s.owner, labels: s.labels, created_ms: 1, ended_ms: null })), next_cursor: null });
    }
    if (r === "POST /v1/agents") {
      const a: FakeAgent = {
        agent: id("agt_"), owner: CLIENT, client: CLIENT, labels: call.body.labels ?? {}, template: call.body.template,
        sandbox: call.body.sandbox ?? null, overrides: call.body.overrides, ended: false,
      };
      this.agents.set(a.agent, a);
      return json(201, { ...this.view(a), started: null });
    }
    if (r === "GET /v1/agents") {
      const rows = [...this.agents.values()].filter((a) => !a.ended && labelsMatch(a.labels));
      return json(200, { agents: rows.map((a) => ({ agent: a.agent, cell: CELL, client: a.client, owner: a.owner, labels: a.labels, created_ms: 1, ended_ms: null })), next_cursor: null });
    }
    if ((m = u.pathname.match(/^\/v1\/agents\/(agt_[A-Za-z0-9]+)(\/.*)?$/))) {
      const a = this.agents.get(m[1]!);
      if (!a || a.client !== CLIENT) return nestErr(404, "unknown_agent", "unknown agent");
      const sub = m[2] ?? "";
      if (req.method === "GET" && sub === "") return json(200, this.view(a));
      if (req.method === "POST" && sub === "/inbox") {
        const dup = call.body.request_id && this.inbox.some((x) => x.agent === a.agent && x.request_id === call.body.request_id);
        if (!dup) this.inbox.push({ agent: a.agent, text: call.body.text, from: call.body.from, request_id: call.body.request_id });
        return json(201, { message: { seq: this.inbox.length } });
      }
      if (req.method === "POST" && sub === "/stop") {
        a.ended = !!call.body?.end;
        if (a.ended && call.body?.destroy_sandbox && a.sandbox) this.sandboxes.get(a.sandbox)!.ended = true;
        return json(200, { status: "stopped" });
      }
      if (req.method === "POST" && (m = sub.match(/^\/asks\/(ask_[A-Za-z0-9]+)\/answer$/))) {
        this.answers.push({ agent: a.agent, ask: m[1]!, answer: call.body.answer });
        return json(200, { delivered: true });
      }
    }
    if (req.method === "PUT" && (m = u.pathname.match(/^\/v1\/catalog\/(templates|capabilities)\/([a-z][a-z0-9-]+)\/([a-z][a-z0-9-]*)$/))) {
      if (m[2] !== "projects") return nestErr(403, "forbidden", `${m[2]} is not your namespace (projects)`);
      this.catalog.set(`${m[1]}/${m[2]}/${m[3]}`, call.body);
      return json(200, { ok: true });
    }
    if (r === "POST /v1/clients/self/github-token") {
      return json(200, { token: "ghs_fake", expires_at: new Date(Date.now() + 3600_000).toISOString(), repo: call.body.repo.toLowerCase(), permissions: call.body.permissions });
    }
    return nestErr(404, "not_found", `no route for ${r}`);
  }

  view(a: FakeAgent) {
    return { agent: a.agent, owner: a.owner, client: a.client, labels: a.labels, state: a.ended ? "ended" : "idle", template: a.template };
  }

  /** An agent nest has but the app didn't record (another client's, or one an agent spawned). */
  plant(a: Partial<FakeAgent> & { labels: Record<string, string> }): FakeAgent {
    const full: FakeAgent = { agent: id("agt_"), owner: CLIENT, client: CLIENT, template: "x", sandbox: null, overrides: undefined, ended: false, ...a };
    this.agents.set(full.agent, full);
    return full;
  }
}

/** Install `fake` as nest (and Cloudflare Access's certs, when given) for the Worker and its objects. */
export function installFetch(fake: FakeNest, access?: () => unknown): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.origin === NEST) return fake.handle(req);
    if (access && req.url === `${TEAM}/cdn-cgi/access/certs`) return Response.json(access());
    throw new Error(`unexpected fetch ${req.url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

// --- Nest-Identity ---------------------------------------------------------------------------------

export class Signer {
  constructor(readonly key: CryptoKeyPair, readonly kid: string) {}

  static async create(kid = "k1"): Promise<Signer> {
    return new Signer((await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair, kid);
  }

  async jwk(): Promise<unknown> {
    const j = (await crypto.subtle.exportKey("jwk", this.key.publicKey)) as JsonWebKey;
    return { kty: "OKP", crv: "Ed25519", x: j.x, kid: this.kid, alg: "EdDSA", use: "sig" };
  }

  async sign(claims: Record<string, unknown>, o: { kid?: string; alg?: string } = {}): Promise<string> {
    const h = b64urlJson({ alg: o.alg ?? "EdDSA", typ: "JWT", kid: o.kid ?? this.kid });
    const p = b64urlJson(claims);
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, this.key.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }
}

const nowS = () => Math.floor(Date.now() / 1000);

/** The claims nest puts on an agent's session token for one of the app's servers. */
export function agentClaims(server: "board" | "task" | "review", agent: string, labels: Record<string, string>, over: Record<string, unknown> = {}) {
  return {
    iss: NEST, aud: `${APP}/mcp/${server}`, sub: agent, owner: CLIENT, client: CLIENT, labels, epoch: 1, tainted: false,
    iat: nowS(), exp: nowS() + 300, ...over,
  };
}

export const connectorClaims = (server: "board" | "task" | "review") => ({ iss: NEST, aud: `${APP}/mcp/${server}`, sub: "nest:connector", iat: nowS(), exp: nowS() + 300 });

let rpcId = 0;
/** One JSON-RPC message to an MCP server, as nest sends it. */
export function mcp(server: string, token: string | null, method: string, params?: unknown): Promise<Response> {
  const isNotification = method.startsWith("notifications/");
  return SELF.fetch(`${APP}/mcp/${server}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { "nest-identity": token } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", ...(isNotification ? {} : { id: ++rpcId }), method, ...(params === undefined ? {} : { params }) }),
  });
}

/** `tools/call` and its parsed answer. */
export async function callTool(server: string, token: string, name: string, args: unknown = {}, meta?: Record<string, unknown>): Promise<{ status: number; result?: any; error?: any }> {
  const res = await mcp(server, token, "tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  if (res.status !== 200) return { status: res.status };
  const body = (await res.json()) as any;
  return { status: 200, result: body.result, error: body.error };
}

// --- Cloudflare Access -----------------------------------------------------------------------------

export class AccessTeam {
  constructor(readonly key: CryptoKeyPair) {}

  static async create(): Promise<AccessTeam> {
    return new AccessTeam((await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
    )) as CryptoKeyPair);
  }

  async certs(): Promise<unknown> {
    return { keys: [{ ...((await crypto.subtle.exportKey("jwk", this.key.publicKey)) as JsonWebKey), kid: "ak1", alg: "RS256", use: "sig" }] };
  }

  async token(over: Record<string, unknown> = {}): Promise<string> {
    const h = b64urlJson({ alg: "RS256", kid: "ak1", typ: "JWT" });
    const p = b64urlJson({ iss: TEAM, aud: [AUD], exp: nowS() + 600, iat: nowS() - 5, email: "owner@example.com", ...over });
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", this.key.privateKey, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
  }
}

/** A call to the app's JSON API with an Access token. */
export async function api(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await SELF.fetch(`${APP}${path}`, {
    method,
    headers: { "cf-access-jwt-assertion": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// --- nest's webhook --------------------------------------------------------------------------------

/** POST one event to /hooks/nest, signed as nest signs it (or with what `o` changes). */
export async function deliver(event: Record<string, unknown>, o: { secret?: string; t?: number; header?: string } = {}): Promise<Response> {
  const body = JSON.stringify(event);
  const t = o.t ?? Date.now();
  const header = o.header ?? `t=${t},v1=${await signWebhook(o.secret ?? env.NEST_WEBHOOK_SECRET!, t, body)}`;
  return SELF.fetch(`${APP}/hooks/nest`, { method: "POST", headers: { "content-type": "application/json", "nest-signature": header }, body });
}

/** Poll until `f` answers truthy (the alarm's work), for up to 5 s. */
export async function eventually<T>(f: () => T | Promise<T>, what: string): Promise<NonNullable<T>> {
  const until = Date.now() + 5_000;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
