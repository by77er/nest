// OAuth for remote MCP servers (docs/agents/capabilities/mcp/#oauth), against the MCP authorization spec
// 2025-11-25 as the oracle: a fake authorization server (https://as.test/<id>, an issuer with a path) and a
// protected MCP server (https://rs.test/<id>/mcp), both fetch handlers installed over the global fetch the
// control plane calls. The fake AS checks what the spec makes the client's job (PKCE S256 against the
// challenge, the resource, the redirect URI, the client ID metadata document) and refuses otherwise, so
// a client that skips one fails here. The test plays the operator's browser: it follows the authorize URL.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrokerDO } from "../src/do/broker";
import type { McpConnectorDO } from "../src/do/mcp-connector";
import { connectorName } from "../src/lib/mcp";
import { authServerMetadataUrls, bearerChallenge, pkceChallenge, resourceCovers, resourceMetadataUrls } from "../src/lib/mcp-auth";
import { adminJson, connectHost, nextCommands, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
/** vitest.config.ts: PUBLIC_BASE_URL. */
const NEST = "https://nest.test";
const CALLBACK = `${NEST}/v1/oauth/callback`;
const CIMD = `${NEST}/v1/oauth/client.json`;
const broker = () => env.BROKER.get(env.BROKER.idFromName("broker"));
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const random = () => b64url(crypto.getRandomValues(new Uint8Array(16)));

// --- The fake authorization server and protected MCP server ----------------------------------------------

interface AsOpts {
  cimd?: boolean;
  registration?: boolean;
  /** Advertise S256 (else only `plain`): nest must refuse to proceed. */
  s256?: boolean;
  /** Name `resource_metadata` in the 401 (else nest must fall back to the well-known URLs). */
  challengeNamesMetadata?: boolean;
  /** Seconds an access token lasts. */
  accessTtlS?: number;
  /** Refresh tokens rotate (OAuth 2.1 §4.3.1: required for public clients); a spent one is invalid_grant. */
  rotate?: boolean;
  /** Send and advertise `iss` in the authorization response (RFC 9207). */
  iss?: boolean;
  /** A pre-registered confidential client. */
  preRegistered?: { client_id: string; client_secret: string };
  /** Milliseconds each refresh takes (to hold refreshes in flight). */
  refreshDelayMs?: number;
  /** The protected resource metadata names this resource instead of the server (RFC 9728 §3.3: nest must refuse). */
  prmResource?: string;
}

interface Code { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string | null }

class FakeAuth {
  readonly issuer: string;
  readonly server: string;
  readonly prm: string;
  readonly clients = new Map<string, { redirect_uris: string[]; secret?: string }>();
  readonly codes = new Map<string, Code>();
  readonly access = new Map<string, { resource: string; exp: number }>();
  readonly refresh = new Map<string, { client_id: string; resource: string; valid: boolean }>();
  /** Every token endpoint request's form, in order. */
  readonly tokenRequests: Record<string, string>[] = [];
  readonly tokenAuth: (string | null)[] = [];
  readonly registrations: unknown[] = [];
  readonly cimdFetches: unknown[] = [];
  /** The MCP server's view: every request's bearer, method and status. */
  readonly rsLog: { token: string | null; method: string; status: number }[] = [];
  counter = 0;
  /** The MCP server refuses every token (it rejects them for its own reasons). */
  refuseAll = false;
  /** The next tools/call answers 403 insufficient_scope. */
  needScope: string | null = null;

  constructor(readonly id: string, readonly o: AsOpts) {
    this.issuer = `https://as.test/${id}`;
    this.server = `https://rs.test/${id}/mcp`;
    this.prm = `https://rs.test/.well-known/oauth-protected-resource/${id}/mcp`;
    if (o.preRegistered) this.clients.set(o.preRegistered.client_id, { redirect_uris: [CALLBACK], secret: o.preRegistered.client_secret });
  }

  revokeAccess(): void {
    this.access.clear();
  }

  revokeRefresh(): void {
    for (const r of this.refresh.values()) r.valid = false;
  }

  get refreshes(): number {
    return this.tokenRequests.filter((r) => r.grant_type === "refresh_token").length;
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  private issue(client_id: string, resource: string, refresh = true) {
    const access_token = `at-${random()}`;
    this.access.set(access_token, { resource, exp: Date.now() + (this.o.accessTtlS ?? 3600) * 1000 });
    const out: Record<string, unknown> = { access_token, token_type: "Bearer", expires_in: this.o.accessTtlS ?? 3600, scope: "notes" };
    if (refresh) {
      const rt = `rt-${random()}`;
      this.refresh.set(rt, { client_id, resource, valid: true });
      out.refresh_token = rt;
    }
    return out;
  }

  /** The client the request authenticates as: Basic for a confidential client, else `client_id` in the form. */
  private clientOf(req: Request, form: URLSearchParams): string | null {
    const h = req.headers.get("authorization");
    this.tokenAuth.push(h ? h.split(" ")[0]! : null);
    if (h?.startsWith("Basic ")) {
      const [id, secret] = atob(h.slice(6)).split(":").map(decodeURIComponent);
      return this.clients.get(id!)?.secret === secret ? id! : null;
    }
    const id = form.get("client_id");
    if (!id) return null;
    const c = this.clients.get(id);
    if (c?.secret) return null; // a confidential client must authenticate
    return c || id === CIMD ? id : null;
  }

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.hostname === "rs.test") return this.rs(req, u);
    // Authorization server metadata, path-inserted (RFC 8414 §3.1): the issuer has a path.
    if (u.pathname === `/.well-known/oauth-authorization-server/${this.id}`) {
      return this.json(200, {
        issuer: this.issuer, authorization_endpoint: `${this.issuer}/authorize`, token_endpoint: `${this.issuer}/token`,
        ...(this.o.registration ? { registration_endpoint: `${this.issuer}/register` } : {}),
        code_challenge_methods_supported: this.o.s256 === false ? ["plain"] : ["S256"],
        ...(this.o.cimd ? { client_id_metadata_document_supported: true } : {}),
        ...(this.o.iss ? { authorization_response_iss_parameter_supported: true } : {}),
        token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], response_types_supported: ["code"],
      });
    }
    if (u.pathname === `/${this.id}/register` && req.method === "POST") {
      const body = (await req.json()) as { redirect_uris: string[] };
      this.registrations.push(body);
      const client_id = `dcr-${random()}`;
      this.clients.set(client_id, { redirect_uris: body.redirect_uris });
      return this.json(201, { client_id, token_endpoint_auth_method: "none", redirect_uris: body.redirect_uris });
    }
    if (u.pathname === `/${this.id}/authorize`) return this.authorize(u);
    if (u.pathname === `/${this.id}/token` && req.method === "POST") return this.token(req);
    return this.json(404, { error: "not found" });
  }

  private async authorize(u: URL): Promise<Response> {
    const q = u.searchParams;
    const fail = (why: string) => this.json(400, { error: "invalid_request", why });
    const client_id = q.get("client_id")!;
    let redirects: string[] | undefined = this.clients.get(client_id)?.redirect_uris;
    if (client_id === CIMD && this.o.cimd) {
      // The AS fetches the document; client_id must equal its URL, and the redirect URI must be listed.
      const doc = (await (await SELF.fetch(client_id)).json()) as { client_id: string; redirect_uris: string[]; client_name: string };
      this.cimdFetches.push(doc);
      if (doc.client_id !== client_id || !doc.client_name) return fail("metadata document's client_id isn't its URL");
      redirects = doc.redirect_uris;
    }
    if (!redirects) return fail("unknown client");
    if (q.get("response_type") !== "code") return fail("response_type");
    if (!redirects.includes(q.get("redirect_uri")!)) return fail("redirect_uri not registered");
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return fail("PKCE S256 required");
    if (q.get("resource") !== this.server) return fail(`resource ${q.get("resource")}`);
    if (!q.get("state")) return fail("no state");
    const code = `code-${random()}`;
    this.codes.set(code, { client_id, redirect_uri: q.get("redirect_uri")!, challenge: q.get("code_challenge")!, resource: q.get("resource")!, scope: q.get("scope") });
    const back = new URL(q.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", q.get("state")!);
    if (this.o.iss) back.searchParams.set("iss", this.issuer);
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    this.tokenRequests.push(Object.fromEntries(form));
    const client = this.clientOf(req, form);
    if (!client) return this.json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const c = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!c || c.client_id !== client || c.redirect_uri !== form.get("redirect_uri")) return this.json(400, { error: "invalid_grant" });
      if ((await pkceChallenge(form.get("code_verifier") ?? "")) !== c.challenge) return this.json(400, { error: "invalid_grant", why: "PKCE" });
      if (form.get("resource") !== c.resource) return this.json(400, { error: "invalid_target" });
      return this.json(200, this.issue(client, c.resource));
    }
    if (form.get("grant_type") === "refresh_token") {
      if (this.o.refreshDelayMs) await sleep(this.o.refreshDelayMs);
      const rt = form.get("refresh_token") ?? "";
      const r = this.refresh.get(rt);
      if (!r?.valid || r.client_id !== client) return this.json(400, { error: "invalid_grant" });
      if (form.get("resource") !== r.resource) return this.json(400, { error: "invalid_target" });
      if (this.o.rotate) r.valid = false;
      const out = this.issue(client, r.resource, this.o.rotate === true);
      return this.json(200, out);
    }
    return this.json(400, { error: "unsupported_grant_type" });
  }

  private async rs(req: Request, u: URL): Promise<Response> {
    if (u.href === this.prm && req.method === "GET") {
      return this.json(200, { resource: this.o.prmResource ?? this.server, authorization_servers: [this.issuer], scopes_supported: ["notes", "extra"] });
    }
    if (u.href !== this.server) return this.json(404, {});
    const msg = (await req.json()) as { id?: number; method: string; params?: any };
    const h = req.headers.get("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
    const a = token ? this.access.get(token) : undefined;
    const ok = !this.refuseAll && !!a && a.exp > Date.now() && a.resource === this.server;
    const log = (status: number) => this.rsLog.push({ token, method: msg.method, status });
    if (!ok) {
      log(401);
      const meta = this.o.challengeNamesMetadata === false ? "" : `resource_metadata="${this.prm}", `;
      return this.json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer ${meta}scope="notes"${token ? ', error="invalid_token"' : ""}` });
    }
    if (msg.method === "tools/call" && this.needScope) {
      log(403);
      const s = this.needScope;
      this.needScope = null;
      return this.json(403, {}, { "www-authenticate": `Bearer error="insufficient_scope", scope="${s}", resource_metadata="${this.prm}"` });
    }
    log(200);
    const result = (r: unknown, extra: Record<string, string> = {}) => this.json(200, { jsonrpc: "2.0", id: msg.id, result: r }, extra);
    switch (msg.method) {
      case "initialize":
        return result({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } }, { "mcp-session-id": `s-${this.id}` });
      case "notifications/initialized":
        return new Response(null, { status: 202 });
      case "tools/list":
        return result({ tools: [
          { name: "echo", description: "echo", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
          { name: "counter_add", description: "add", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, idempotentHint: false } },
        ] });
      case "tools/call": {
        const { name, arguments: args } = msg.params;
        if (name === "counter_add") this.counter += Number(args.n);
        return result({ content: [{ type: "text", text: name === "echo" ? String(args.text) : String(this.counter) }] });
      }
    }
    return this.json(200, { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
  }
}

const fakes = new Map<string, FakeAuth>();
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.hostname !== "as.test" && u.hostname !== "rs.test") return realFetch(input as RequestInfo, init);
    // The id is the first path segment, or the one after the well-known prefix.
    const seg = u.pathname.split("/").filter(Boolean);
    const id = seg[0] === ".well-known" ? seg[2] : seg[0];
    const f = fakes.get(id ?? "");
    return f ? f.handle(req) : new Response("no such fake", { status: 503 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// --- Setup ----------------------------------------------------------------------------------------------

/** A capability on a fresh fake, with auth in the oauth form. */
async function capability(o: AsOpts = {}, auth: Record<string, unknown> = {}) {
  const id = rand();
  const f = new FakeAuth(id, { cimd: true, ...o });
  fakes.set(id, f);
  const cap = `o${id}`;
  const ref = `cap:${cap}`;
  await adminJson(`/v1/admin/capabilities/${cap}`, {
    method: "PUT", body: { mcp: { url: f.server, auth: { oauth: ref, ...auth }, tools: ["echo", "counter_add"], read_only: ["echo"], when_tainted: "allow" } },
  });
  return { id, f, cap, ref };
}

/** The operator's authorization: start, follow the authorize URL as a browser would, land on the callback. */
async function authorize(cap: string, body?: unknown) {
  const start = await adminJson(`/v1/admin/capabilities/${cap}/oauth`, { method: "POST", ...(body ? { body } : {}) });
  const res = await fetch(start.authorize_url, { redirect: "manual" });
  expect(res.status, await res.clone().text()).toBe(302);
  const back = res.headers.get("location")!;
  const cb = await SELF.fetch(back);
  return { start, back, callback: cb, page: await cb.text() };
}

/** An agent whose spec has the capability, with its runner session open. */
async function agentWith(cap: string) {
  const tpl = `t-${cap}`;
  await adminJson(`/v1/admin/templates/${tpl}`, {
    method: "PUT",
    body: { capabilities: ["nest", cap], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "forbidden", credential: "claude_oauth_token", escalate_to: "user" },
  });
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const host = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "oauth" } }, 201);
  const ag = await adminJson("/v1/agents", { body: { template: tpl, workstream, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === ag.agent);
  const ws = await Ws.connect(`/v1/agents/${ag.agent}/session`, host.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: ag.agent, host: host.host, instance_id: "rin_one", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  let seq = 0;
  const call = async (callId: string, tool: string, args: unknown) => {
    ws.send({ type: "tool_call", seq: ++seq, call: callId, turn: "trn_x", name: `${cap}_${tool}`, arguments: args });
    return (await ws.next("tool_result", (m) => m.call === callId, 8000)).outcome;
  };
  return { agent: ag.agent as string, ws, call };
}

/** The stored record, read inside BrokerDO. */
const grantRow = (ref: string) => runInDurableObject(broker(), (_: BrokerDO, st) =>
  st.storage.sql.exec<Record<string, any>>("SELECT * FROM oauth_grants WHERE ref = ?", ref).toArray()[0] as Record<string, any>);
const setExpiry = (ref: string, ms: number) => runInDurableObject(broker(), (_: BrokerDO, st) => {
  st.storage.sql.exec("UPDATE oauth_grants SET access_expires_ms = ?, access_issued_ms = 0 WHERE ref = ?", ms, ref);
});

// --- Pure parts, against the spec's examples ----------------------------------------------------------------

describe("discovery URLs and challenges", () => {
  it("builds the well-known URLs in the spec's order and parses Bearer challenges", () => {
    // The spec: https://example.com/public/mcp → path-inserted, then root.
    expect(resourceMetadataUrls(new URL("https://example.com/public/mcp"))).toEqual([
      "https://example.com/.well-known/oauth-protected-resource/public/mcp", "https://example.com/.well-known/oauth-protected-resource"]);
    expect(resourceMetadataUrls(new URL("https://example.com/"))).toEqual(["https://example.com/.well-known/oauth-protected-resource"]);
    expect(authServerMetadataUrls(new URL("https://auth.example.com/tenant1"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
      "https://auth.example.com/.well-known/openid-configuration/tenant1",
      "https://auth.example.com/tenant1/.well-known/openid-configuration"]);
    expect(authServerMetadataUrls(new URL("https://auth.example.com"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server", "https://auth.example.com/.well-known/openid-configuration"]);
    // The spec's 401 and 403 examples, and a second challenge before Bearer.
    expect(bearerChallenge('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource",\n                         scope="files:read"'))
      .toEqual({ resource_metadata: "https://mcp.example.com/.well-known/oauth-protected-resource", scope: "files:read" });
    expect(bearerChallenge('Basic realm="x", Bearer error="insufficient_scope", scope="files:read files:write", error_description="a \\"quoted\\" word"'))
      .toEqual({ error: "insufficient_scope", scope: "files:read files:write", error_description: 'a "quoted" word' });
    expect(bearerChallenge("Negotiate abc==, Bearer realm=nest")).toEqual({ realm: "nest" });
    expect(bearerChallenge('Basic realm="x"')).toBeNull();
    // Metadata's resource names the server: itself or a path prefix on its origin (the root document names the origin).
    const s = new URL("https://mcp.example.com/server/mcp");
    expect(["https://mcp.example.com/server/mcp", "https://mcp.example.com", "https://mcp.example.com/server"].map((r) => resourceCovers(r, s))).toEqual([true, true, true]);
    expect(["https://other.example.com/server/mcp", "https://mcp.example.com/serv", "https://mcp.example.com/server/mcp2"].map((r) => resourceCovers(r, s))).toEqual([false, false, false]);
  });
});

// --- The catalog ---------------------------------------------------------------------------------------------

describe("the oauth form of auth", () => {
  it("is accepted beside cap:<name>, refuses a client secret named like the token record, and only an oauth capability starts a flow", async () => {
    const put = (name: string, auth: unknown, status?: number) => adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { mcp: { url: "https://mcp.example.com/mcp", auth } } }, status);
    expect((await put(`a${rand()}`, { oauth: "cap:x", client: "cap:x-client", scopes: ["notes"] })).mcp.auth).toEqual({ oauth: "cap:x", client: "cap:x-client", scopes: ["notes"] });
    expect((await put(`b${rand()}`, "cap:x")).mcp.auth).toBe("cap:x");
    expect((await put(`c${rand()}`, { oauth: "cap:x", client: "cap:x" }, 400)).error.message).toContain("different names");
    expect((await put(`d${rand()}`, { oauth: "x" }, 400)).error.code).toBe("invalid_message");
    expect((await put(`e${rand()}`, { oauth: "cap:x", scopes: ["two words"] }, 400)).error.code).toBe("invalid_message");
    const bearer = `f${rand()}`;
    await put(bearer, "cap:y");
    expect((await adminJson(`/v1/admin/capabilities/${bearer}/oauth`, { method: "POST" }, 409)).error.message).toContain("oauth");
    await adminJson(`/v1/admin/capabilities/nope${rand()}/oauth`, { method: "POST" }, 404);
  });

  it("serves the client ID metadata document at its own URL, with nest's callback as the only redirect URI", async () => {
    const res = await SELF.fetch(CIMD);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      client_id: CIMD, client_name: "nest", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });
});

// --- Authorization by the operator --------------------------------------------------------------------------

describe("authorization", () => {
  it("discovers from the 401, sends PKCE S256 and the resource, exchanges the code once, and the agent's calls carry the access token", async () => {
    const { f, cap, ref } = await capability();
    const { start, back, callback, page } = await authorize(cap);
    const u = new URL(start.authorize_url);
    expect(u.origin + u.pathname).toBe(`${f.issuer}/authorize`);
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: CIMD, redirect_uri: CALLBACK, code_challenge_method: "S256", resource: f.server, scope: "notes" });
    expect(start).toMatchObject({ client: "metadata", resource: f.server, issuer: f.issuer });
    // The verifier never leaves BrokerDO: not in the URL the operator holds.
    expect(start.authorize_url).not.toContain("code_verifier");
    expect(callback.status, page).toBe(200);
    expect(page).toContain(`${cap} is authorized`);
    expect(callback.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.cimdFetches).toHaveLength(1);
    const exchange = f.tokenRequests.find((r) => r.grant_type === "authorization_code")!;
    expect(exchange).toMatchObject({ client_id: CIMD, redirect_uri: CALLBACK, resource: f.server });
    // The state is spent: the same redirect again is refused and changes nothing.
    const row = await grantRow(ref);
    const again = await SELF.fetch(back);
    expect(again.status).toBe(400);
    expect(await again.text()).toContain("unknown or expired state");
    expect((await grantRow(ref)).access_token).toBe(row.access_token);
    // The operator's view names no token.
    const status = await adminJson(`/v1/admin/capabilities/${cap}/oauth`);
    expect(status).toMatchObject({ status: "authorized", resource: f.server, issuer: f.issuer, client: "metadata", refreshable: true });
    expect(JSON.stringify(status)).not.toContain(row.access_token);
    expect(JSON.stringify(status)).not.toContain(row.refresh_token);
    // A previous release reads `auth` as a static secret: none exists under that name, so no token goes out.
    expect(await broker().capabilityToken(ref)).toBeNull();

    const a = await agentWith(cap);
    expect(await a.call("cal_1", "echo", { text: "hi" })).toEqual({ status: "ok", content: [{ type: "text", text: "hi" }] });
    expect(f.rsLog.filter((r) => r.status === 200).every((r) => r.token === row.access_token)).toBe(true);
    expect(f.rsLog.some((r) => r.method === "tools/call" && r.status === 200)).toBe(true);
  });

  it("refuses a forged or expired state, an iss that doesn't match, and an authorization server's error, storing nothing", async () => {
    const { f, cap, ref } = await capability({ iss: true });
    expect((await SELF.fetch(`${CALLBACK}?state=${random()}&code=x`)).status).toBe(400);
    expect((await SELF.fetch(`${CALLBACK}?code=x`)).status).toBe(400);
    // An iss from another server (a mix-up) is refused, and spends the state.
    const start = await adminJson(`/v1/admin/capabilities/${cap}/oauth`, { method: "POST" });
    const res = await fetch(start.authorize_url, { redirect: "manual" });
    const back = new URL(res.headers.get("location")!);
    back.searchParams.set("iss", "https://evil.test");
    expect(await (await SELF.fetch(back.href)).text()).toContain("iss");
    back.searchParams.set("iss", f.issuer);
    expect((await SELF.fetch(back.href)).status).toBe(400);
    // An expired flow.
    const s2 = await adminJson(`/v1/admin/capabilities/${cap}/oauth`, { method: "POST" });
    await runInDurableObject(broker(), (_: BrokerDO, st) => st.storage.sql.exec("UPDATE oauth_flows SET expires_ms = 1"));
    const r2 = await fetch(s2.authorize_url, { redirect: "manual" });
    expect(await (await SELF.fetch(r2.headers.get("location")!)).text()).toContain("expired");
    // The AS's own refusal.
    const s3 = await adminJson(`/v1/admin/capabilities/${cap}/oauth`, { method: "POST" });
    const state = new URL(s3.authorize_url).searchParams.get("state")!;
    expect(await (await SELF.fetch(`${CALLBACK}?state=${state}&error=access_denied&iss=${encodeURIComponent(f.issuer)}`)).text()).toContain("access_denied");
    expect(await grantRow(ref)).toBeUndefined();
    expect(f.tokenRequests).toEqual([]);
  });

  it("falls back to the well-known URLs when the 401 names no metadata, and refuses a server without S256 or whose metadata names another resource", async () => {
    const plain = await capability({ challengeNamesMetadata: false });
    expect((await authorize(plain.cap)).callback.status).toBe(200);
    const none = await capability({ s256: false });
    expect((await adminJson(`/v1/admin/capabilities/${none.cap}/oauth`, { method: "POST" }, 502)).error.message).toContain("S256");
    const other = await capability({ prmResource: "https://elsewhere.test/mcp" });
    expect((await adminJson(`/v1/admin/capabilities/${other.cap}/oauth`, { method: "POST" }, 502)).error.message).toContain("names https://elsewhere.test/mcp");
  });

  it("uses a pre-registered client first (Basic auth with its secret), else registers once (RFC 7591) where there's no metadata document", async () => {
    const pre = await capability({ cimd: true, preRegistered: { client_id: "nest-pre", client_secret: "s3cret" } }, { client: `cap:pre-${rand()}` });
    const preRef = (await adminJson("/v1/admin/catalog")).capabilities[pre.cap].mcp.auth.client;
    expect((await adminJson(`/v1/admin/capabilities/${pre.cap}/oauth`, { method: "POST" }, 409)).error.message).toContain(preRef);
    await adminJson(`/v1/admin/secrets/${preRef}`, { method: "PUT", body: { value: JSON.stringify({ client_id: "nest-pre", client_secret: "s3cret" }) } });
    const p = await authorize(pre.cap);
    expect(p.start.client).toBe("pre-registered");
    expect(new URL(p.start.authorize_url).searchParams.get("client_id")).toBe("nest-pre");
    expect(p.callback.status, p.page).toBe(200);
    expect(pre.f.tokenAuth).toEqual(["Basic"]);
    expect(pre.f.tokenRequests[0]).not.toHaveProperty("client_secret");

    const dcr = await capability({ cimd: false, registration: true });
    const d1 = await authorize(dcr.cap);
    expect(d1.start.client).toBe("registered");
    expect(d1.callback.status, d1.page).toBe(200);
    await authorize(dcr.cap);
    expect(dcr.f.registrations).toEqual([expect.objectContaining({ redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" })]);

    const neither = await capability({ cimd: false, registration: false });
    expect((await adminJson(`/v1/admin/capabilities/${neither.cap}/oauth`, { method: "POST" }, 409)).error.message).toContain("register a client");
  });
});

// --- Use: refresh -----------------------------------------------------------------------------------------------

describe("refresh", () => {
  it("refreshes before expiry, so the server never sees a stale token, and a rotated refresh token replaces the spent one", async () => {
    const { f, cap, ref } = await capability({ rotate: true });
    await authorize(cap);
    const a = await agentWith(cap);
    expect((await a.call("cal_r1", "echo", { text: "1" })).status).toBe("ok");
    const first = await grantRow(ref);
    for (const [i, call] of ["cal_r2", "cal_r3"].entries()) {
      await setExpiry(ref, Date.now() + 10_000); // inside the 60 s skew
      expect((await a.call(call, "echo", { text: String(i) })).status).toBe("ok");
    }
    expect(f.refreshes).toBe(2);
    const sent = f.tokenRequests.filter((r) => r.grant_type === "refresh_token").map((r) => r.refresh_token);
    // The second refresh spent the token the first one rotated in (the AS refuses a spent one).
    expect(sent[0]).toBe(first.refresh_token);
    expect(sent[1]).not.toBe(sent[0]);
    expect(f.refresh.get(sent[1]!)?.valid).toBe(false);
    expect(f.tokenRequests.filter((r) => r.grant_type === "refresh_token").every((r) => r.resource === f.server)).toBe(true);
    // Only discovery's unauthenticated probe was refused.
    expect(f.rsLog.filter((r) => r.status === 401 && r.token !== null)).toEqual([]);
  });

  it("on a 401 refreshes once and sends the call again, and the server runs it once", async () => {
    const { f, cap } = await capability({ rotate: true });
    await authorize(cap);
    const a = await agentWith(cap);
    expect((await a.call("cal_u1", "counter_add", { n: 1 })).status).toBe("ok");
    f.revokeAccess();
    expect(await a.call("cal_u2", "counter_add", { n: 2 })).toMatchObject({ status: "ok", content: [{ text: "3" }] });
    expect(f.refreshes).toBe(1);
    expect(f.counter).toBe(3);
    // A 401 at initialize (the session is renewed with the token) is renewed the same way.
    expect(f.rsLog.filter((r) => r.status === 401 && r.token !== null).map((r) => r.method)).toEqual(["tools/call"]);
  });

  it("the connector's listing, refused a revoked token, refreshes once and lists again", async () => {
    const { f, cap, ref } = await capability({ rotate: true });
    await authorize(cap);
    const a = await agentWith(cap);
    const list = async () => {
      a.ws.send({ type: "tools_list_request", request: `req_${rand()}` });
      return ((await a.ws.next("tools_list", () => true, 8000)).tools as { name: string }[]).map((t) => t.name);
    };
    expect(await list()).toContain(`${cap}_echo`);
    f.revokeAccess();
    // Stale, so the next list goes to the server over the connector's session (the access token now refused).
    const connector = env.MCP_CONNECTOR.get(env.MCP_CONNECTOR.idFromName(connectorName({ url: f.server, auth: ref })));
    await runInDurableObject(connector, (_: McpConnectorDO, st) => st.storage.sql.exec("UPDATE kv SET value = '0' WHERE key = 'listed_ms'"));
    const before = f.rsLog.filter((r) => r.method === "tools/list" && r.status === 200).length;
    expect(await list()).toContain(`${cap}_echo`);
    expect(f.refreshes).toBe(1);
    expect(f.rsLog.filter((r) => r.method === "tools/list" && r.status === 200).length).toBe(before + 1);
  });

  it("coalesces concurrent refreshes into one request, so a rotating refresh token is spent once", async () => {
    const { f, cap, ref } = await capability({ rotate: true, refreshDelayMs: 200 });
    await authorize(cap);
    await setExpiry(ref, Date.now() - 1);
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => broker().mcpOAuthToken(ref, f.server)));
    expect(f.refreshes).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect((await grantRow(ref)).status).toBe("authorized");
    // The same for callers that all saw the server refuse the old token.
    const old = tokens[0]!;
    await runInDurableObject(broker(), (_: BrokerDO, st) => st.storage.sql.exec("UPDATE oauth_grants SET access_issued_ms = 0 WHERE ref = ?", ref));
    const again = await Promise.all([1, 2, 3].map(() => broker().mcpOAuthToken(ref, f.server, old)));
    expect(f.refreshes).toBe(2);
    expect(new Set(again).size).toBe(1);
    expect(again[0]).not.toBe(old);
    // A caller whose refused token was already replaced gets the replacement, no refresh.
    expect(await broker().mcpOAuthToken(ref, f.server, old)).toBe(again[0]);
    expect(f.refreshes).toBe(2);
  });

  it("a revoked refresh token is a platform error naming re-authorization, never retried, until the operator authorizes again", async () => {
    const { f, cap, ref } = await capability({ rotate: true });
    await authorize(cap);
    const a = await agentWith(cap);
    f.revokeAccess();
    f.revokeRefresh();
    const out = await a.call("cal_v1", "echo", { text: "x" });
    expect(out.error).toMatchObject({ code: "unauthorized", retryable: false, message: expect.stringContaining(`POST /v1/admin/capabilities/${cap}/oauth`) });
    expect(out.error.message).toContain("invalid_grant");
    expect((await adminJson(`/v1/admin/capabilities/${cap}/oauth`)).status).toBe("reauthorize");
    const row = await grantRow(ref);
    expect([row.access_token, row.refresh_token]).toEqual([null, null]);
    // No loop: later calls fail at once, without asking the AS or the server.
    const asked = f.tokenRequests.length;
    const hits = f.rsLog.length;
    expect((await a.call("cal_v2", "echo", { text: "x" })).error.code).toBe("unauthorized");
    expect([f.tokenRequests.length, f.rsLog.length]).toEqual([asked, hits]);
    // The operator authorizes again; calls work.
    expect((await authorize(cap)).callback.status).toBe(200);
    expect((await a.call("cal_v3", "echo", { text: "back" })).content[0].text).toBe("back");
  });

  it("a server that refuses the refreshed token too costs one refresh per call, never a loop, and insufficient_scope names the scope", async () => {
    const { f, cap } = await capability();
    await authorize(cap);
    const a = await agentWith(cap);
    expect((await a.call("cal_f0", "echo", { text: "x" })).status).toBe("ok");
    f.refuseAll = true;
    for (const [i, id] of ["cal_f1", "cal_f3"].entries()) {
      const out = await a.call(id, "echo", { text: "x" });
      expect(out.error).toMatchObject({ code: "unauthorized", message: expect.stringContaining("authorize it again") });
      expect(f.refreshes).toBe(i + 1);
    }
    f.refuseAll = false;
    f.needScope = "notes extra";
    expect((await a.call("cal_f2", "echo", { text: "x" })).error).toMatchObject({ code: "forbidden", message: expect.stringContaining("needs notes extra") });
  });

  it("tokens are bound to their server: a capability naming another URL with the same record gets none", async () => {
    const { f, cap, ref } = await capability();
    await authorize(cap);
    await expect(Promise.resolve().then(() => broker().mcpOAuthToken(ref, `${f.server}x`))).rejects.toThrow(/are for/);
    await expect(Promise.resolve().then(() => broker().mcpOAuthToken(`cap:none${rand()}`, f.server))).rejects.toThrow(/no OAuth authorization/);
  });
});

// --- Audit -------------------------------------------------------------------------------------------------------

describe("audit", () => {
  it("writes each start, authorization, refresh and refusal to R2, never a token, code, verifier or state", async () => {
    const { f, cap, ref } = await capability({ rotate: true });
    const { start, back } = await authorize(cap);
    await setExpiry(ref, Date.now() - 1);
    await broker().mcpOAuthToken(ref, f.server);
    f.revokeRefresh();
    await setExpiry(ref, Date.now() - 1);
    await Promise.resolve().then(() => broker().mcpOAuthToken(ref, f.server)).catch(() => undefined);
    const row = await grantRow(ref);
    let records: any[] = [];
    // Audit records are written in the background: poll for the last one.
    for (const end = Date.now() + 10_000; !records.some((r) => r.event === "oauth_refresh_failed") && Date.now() < end;) {
      await sleep(20);
      const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
      records = (await Promise.all(listed.objects.map(async (o) => JSON.parse(await (await env.BUCKET.get(o.key))!.text())))).filter((r) => r.ref === ref || r.capability === cap);
    }
    expect(records.map((r) => r.event).sort()).toEqual(["oauth_authorized", "oauth_refresh_failed", "oauth_refreshed", "oauth_start"]);
    const all = JSON.stringify(records);
    const secrets = [
      ...f.tokenRequests.flatMap((r) => [r.code, r.code_verifier, r.refresh_token]), ...f.access.keys(), ...f.refresh.keys(),
      new URL(start.authorize_url).searchParams.get("state"), new URL(back).searchParams.get("code"), row.access_token, row.refresh_token,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);
    expect(secrets.length).toBeGreaterThan(4);
    for (const s of secrets) expect(all).not.toContain(s);
  });
});
