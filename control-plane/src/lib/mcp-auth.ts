// OAuth for remote MCP servers (docs/agents/capabilities/mcp/#oauth), per the MCP authorization spec
// 2025-11-25 (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization):
// discovery (RFC 9728 protected resource metadata, then RFC 8414 / OIDC authorization server
// metadata), the client's identity (pre-registered, a client ID metadata document the Worker serves,
// or RFC 7591 registration), the authorization code flow with PKCE and `resource` (RFC 8707), and
// refresh. `OAuthStore` keeps the tokens; it lives in BrokerDO and nothing else reads its tables, so
// a refresh token never leaves BrokerDO and an access token leaves it only for AgentDO's MCP client.
//
// `mcpBearer` is the one function the MCP proxy asks for a server's bearer.
import { z } from "zod";
import { ErrorCodes } from "../protocol/model";
import { storedEnum } from "./stored";
import { b64url, NestError } from "./util";
import type { McpGrant } from "./mcp";

/** A BrokerDO secret name a capability's credential uses: `cap:<name>`. */
export const CapRef = z.string().regex(/^cap:[A-Za-z0-9_.:-]{1,128}$/, "auth names a BrokerDO secret, cap:<name>");
/** An OAuth scope token (RFC 6749 §3.3: printable ASCII except space, `"` and `\`). */
const Scope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/, "a scope is one token without spaces");
export const Scopes = z.array(Scope).min(1).max(32);

/**
 * The oauth form of an mcp source's `auth`: `oauth` names where BrokerDO keeps this capability's tokens
 * (not a secret the operator writes); `client` a pre-registered client (a BrokerDO secret holding
 * `{"client_id", "client_secret"?, "token_endpoint_auth_method"?}`); `scopes` what to ask for.
 */
export const OAuthAuth = z.strictObject({ oauth: CapRef, client: CapRef.optional(), scopes: Scopes.optional() });
export type OAuthAuth = z.output<typeof OAuthAuth>;

/** What an agent's spec keeps of the oauth form (`McpGrant.oauth`); the token record is `McpGrant.auth`. */
export interface OAuthGrant {
  client: string | null;
  scopes: string[] | null;
}

/** Each OAuth HTTP exchange (metadata, registration, token) gets this long. */
export const OAUTH_HTTP_TIMEOUT_MS = 10_000;
/** An authorization the operator started must come back within this. */
export const OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** An access token this close to its expiry is refreshed before use. */
export const OAUTH_REFRESH_SKEW_MS = 60_000;
/** Metadata and token answers are read up to this many bytes. */
const MAX_OAUTH_BYTES = 64 * 1024;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** An authorization server or metadata URL nest will call: `https` (loopback http only in local dev), no credentials or fragment. */
export function checkOAuthUrl(raw: unknown, allowLoopback: boolean, what: string): URL {
  let u: URL;
  try {
    u = new URL(String(raw));
  } catch {
    throw oauthError(`${what} is not a URL`);
  }
  const loopback = LOOPBACK.has(u.hostname);
  if (u.username || u.password || u.hash) throw oauthError(`${what} carries credentials or a fragment`);
  if (loopback && !allowLoopback) throw oauthError(`${what} is a loopback URL (local development only)`);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw oauthError(`${what} must be https`);
  return u;
}

const oauthError = (m: string, status = 502) => new NestError(ErrorCodes.INVALID_MESSAGE, `OAuth: ${m}`, status);

// --- WWW-Authenticate (RFC 9110 §11.6.1; RFC 6750 §3; RFC 9728 §5.1) -------------------------------------

/**
 * The `Bearer` challenge's parameters (names lowercased), or null when the header has none. Challenges
 * are `scheme [token68 | name=value, …]`, comma-separated; a value is a token or a quoted string.
 */
export function bearerChallenge(header: string | null): Record<string, string> | null {
  if (!header) return null;
  const s = header;
  let i = 0;
  const TOKEN = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  };
  const token = () => {
    const from = i;
    while (i < s.length && TOKEN.test(s[i]!)) i++;
    return s.slice(from, i);
  };
  const out: Record<string, Record<string, string>> = {};
  let scheme: string | null = null;
  while (i < s.length) {
    ws();
    if (s[i] === ",") {
      i++;
      continue;
    }
    const name = token();
    if (!name) {
      i++;
      continue;
    }
    ws();
    if (s[i] === "=" && scheme !== null) {
      i++;
      ws();
      let value = "";
      if (s[i] === '"') {
        for (i++; i < s.length && s[i] !== '"'; i++) value += s[i] === "\\" && i + 1 < s.length ? s[++i] : s[i];
        i++;
      } else {
        value = token();
      }
      out[scheme]![name.toLowerCase()] = value;
    } else {
      // A new challenge's scheme (any token68 after it is skipped as nameless tokens).
      scheme = name.toLowerCase();
      out[scheme] ??= {};
      while (s[i] === "=") i++;
    }
  }
  return out.bearer ?? null;
}

// --- PKCE (RFC 7636) --------------------------------------------------------------------------------------

/** A verifier of 32 random bytes (43 characters, §4.1) and its S256 challenge (§4.2). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: await pkceChallenge(verifier) };
}
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}
export const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// --- Discovery -----------------------------------------------------------------------------------------------

/** The protected resource metadata URLs to try for a server URL, in the spec's order: path-inserted, then root. */
export function resourceMetadataUrls(server: URL): string[] {
  const path = server.pathname.replace(/\/$/, "");
  const root = `${server.origin}/.well-known/oauth-protected-resource`;
  return path ? [`${root}${path}`, root] : [root];
}

/** Authorization server metadata URLs for an issuer, in the spec's order (RFC 8414 §3.1 and §5, OIDC Discovery). */
export function authServerMetadataUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/$/, "");
  if (!path) return [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`];
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * Whether metadata's `resource` names this server: the server's URL, or a path prefix of it on the same
 * origin (the root metadata names the origin). RFC 9728 §3.3: it MUST be identical to the URL it was
 * derived from; a prefix is what the well-known fallback can legitimately produce.
 */
export function resourceCovers(resource: string, server: URL): boolean {
  let r: URL;
  try {
    r = new URL(resource);
  } catch {
    return false;
  }
  if (r.origin !== server.origin || r.search || r.hash) return false;
  const rp = r.pathname.replace(/\/$/, "");
  const sp = server.pathname.replace(/\/$/, "");
  return rp === "" || rp === sp || sp.startsWith(`${rp}/`);
}

export interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  cimd: boolean;
  /** RFC 9207: the AS sends `iss` with the authorization response, which must then match. */
  iss_parameter: boolean;
  /** `token_endpoint_auth_methods_supported`; absent means `client_secret_basic` (RFC 8414 §2). */
  auth_methods: string[] | null;
}

export interface Discovery {
  /** The `resource` parameter (RFC 8707), the metadata's `resource`. */
  resource: string;
  as: AuthServer;
  /** Scopes the 401 challenge named (authoritative for the request, per the spec), else the metadata's `scopes_supported`. */
  scopes: string[] | null;
}

type Fetched = { ok: true; status: number; json: unknown; headers: Headers } | { ok: false; why: string };

/** One HTTP exchange within `OAUTH_HTTP_TIMEOUT_MS`, redirects not followed, JSON read up to 64 KiB. Never throws. */
async function exchange(url: string, init: RequestInit): Promise<Fetched> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), OAUTH_HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, redirect: "manual" });
    const text = await res.text();
    if (text.length > MAX_OAUTH_BYTES) return { ok: false, why: `HTTP ${res.status} with an answer over 64 KiB` };
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: json stays null
    }
    return { ok: true, status: res.status, json, headers: res.headers };
  } catch (e) {
    return { ok: false, why: ctl.signal.aborted ? `no answer within ${OAUTH_HTTP_TIMEOUT_MS} ms` : `network: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    clearTimeout(timer);
  }
}

const getJson = (url: string) => exchange(url, { method: "GET", headers: { accept: "application/json" } });
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((s) => typeof s === "string") ? v as string[] : null);

/**
 * Discover how to authorize against `server` (the spec's "Authorization Server Discovery"): an
 * unauthenticated `initialize` for the 401's `resource_metadata` and `scope`, else the well-known URLs;
 * the metadata's `resource` must name the server; then the first listed authorization server's
 * metadata, whose `issuer` must match (RFC 8414 §3.3) and which must list S256 PKCE, or nest refuses.
 */
export async function discover(server: URL, allowLoopback: boolean): Promise<Discovery> {
  const probe = await exchange(server.href, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nest", version: "1" } } }),
  });
  const challenge = probe.ok && probe.status === 401 ? bearerChallenge(probe.headers.get("www-authenticate")) : null;
  const candidates = challenge?.resource_metadata
    ? [checkOAuthUrl(challenge.resource_metadata, allowLoopback, "resource_metadata").href]
    : resourceMetadataUrls(server);
  let prm: Record<string, unknown> | null = null;
  const tried: string[] = [];
  for (const url of candidates) {
    const r = await getJson(url);
    if (r.ok && r.status === 200 && isObj(r.json)) {
      prm = r.json;
      break;
    }
    tried.push(`${url} (${r.ok ? `HTTP ${r.status}` : r.why})`);
  }
  if (!prm) throw oauthError(`no protected resource metadata for ${server.href}: tried ${tried.join(", ")}`);
  if (typeof prm.resource !== "string" || !resourceCovers(prm.resource, server)) {
    throw oauthError(`the protected resource metadata names ${String(prm.resource)}, not ${server.href}`);
  }
  const servers = strings(prm.authorization_servers);
  if (!servers?.length) throw oauthError("the protected resource metadata lists no authorization_servers");
  const issuer = checkOAuthUrl(servers[0], allowLoopback, "the authorization server");
  const as = await authServerMetadata(issuer, allowLoopback);
  const challenged = challenge?.scope?.split(" ").filter(Boolean);
  const supported = strings(prm.scopes_supported);
  return { resource: prm.resource, as, scopes: challenged?.length ? challenged : supported?.length ? supported : null };
}

async function authServerMetadata(issuer: URL, allowLoopback: boolean): Promise<AuthServer> {
  const tried: string[] = [];
  for (const url of authServerMetadataUrls(issuer)) {
    const r = await getJson(url);
    if (!(r.ok && r.status === 200 && isObj(r.json))) {
      tried.push(`${url} (${r.ok ? `HTTP ${r.status}` : r.why})`);
      continue;
    }
    const m = r.json;
    // The issuer as listed in the resource metadata, compared as the AS states it (RFC 8414 §3.3).
    const want = issuer.href.replace(/\/$/, "");
    if (typeof m.issuer !== "string" || m.issuer.replace(/\/$/, "") !== want) throw oauthError(`the metadata at ${url} names issuer ${String(m.issuer)}, not ${want}`);
    if (!strings(m.code_challenge_methods_supported)?.includes("S256")) {
      throw oauthError(`${want} doesn't list S256 in code_challenge_methods_supported, so nest refuses to proceed (the spec requires PKCE)`);
    }
    return {
      issuer: m.issuer,
      authorization_endpoint: checkOAuthUrl(m.authorization_endpoint, allowLoopback, "authorization_endpoint").href,
      token_endpoint: checkOAuthUrl(m.token_endpoint, allowLoopback, "token_endpoint").href,
      registration_endpoint: m.registration_endpoint === undefined ? null : checkOAuthUrl(m.registration_endpoint, allowLoopback, "registration_endpoint").href,
      cimd: m.client_id_metadata_document_supported === true,
      iss_parameter: m.authorization_response_iss_parameter_supported === true,
      auth_methods: strings(m.token_endpoint_auth_methods_supported),
    };
  }
  throw oauthError(`no authorization server metadata for ${issuer.href}: tried ${tried.join(", ")}`);
}

// --- Client identity -------------------------------------------------------------------------------------------

/** The Worker's OAuth URLs: the redirect URI, and the client ID metadata document (which is the client id). */
export function oauthUrls(publicBaseUrl: string): { redirect_uri: string; client_id: string } {
  const base = publicBaseUrl.replace(/\/$/, "");
  return { redirect_uri: `${base}/v1/oauth/callback`, client_id: `${base}/v1/oauth/client.json` };
}

/**
 * The client ID metadata document (draft-ietf-oauth-client-id-metadata-document-00; the spec requires
 * `client_id` equal to its URL, `client_name` and `redirect_uris`): a public client, authorization code and refresh.
 */
export function clientMetadataDocument(publicBaseUrl: string) {
  const u = oauthUrls(publicBaseUrl);
  return {
    client_id: u.client_id,
    client_name: "nest",
    redirect_uris: [u.redirect_uri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Whether nest can offer its metadata document: the spec requires an https client id (loopback http in local dev). */
export function canUseMetadataDocument(publicBaseUrl: string, allowLoopback: boolean): boolean {
  try {
    checkOAuthUrl(oauthUrls(publicBaseUrl).client_id, allowLoopback, "the client id");
    return true;
  } catch {
    return false;
  }
}

/** How a flow identifies the client, stored with the flow and the tokens (a secret is read at use, never copied). */
export type ClientRef =
  /** The operator's pre-registered client: a BrokerDO secret holding its JSON. */
  | { kind: "pre-registered"; secret: string; auth_methods: string[] | null }
  /** nest's metadata document; the id is its URL. */
  | { kind: "metadata"; client_id: string }
  /** Registered with the AS (RFC 7591), kept in `oauth_clients`. */
  | { kind: "registered"; issuer: string; redirect_uri: string };

/** A client as a token request needs it. */
export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  /** `none`, `client_secret_basic` or `client_secret_post`. */
  auth_method: string;
}

/** A pre-registered client's stored JSON; the method defaults to what the AS supports. */
export function parseClient(json: string, as: Pick<AuthServer, "auth_methods"> | null): OAuthClient {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new NestError(ErrorCodes.FORBIDDEN, "the client secret is not JSON {\"client_id\", \"client_secret\"?}", 409);
  }
  if (!isObj(v) || typeof v.client_id !== "string" || !v.client_id) throw new NestError(ErrorCodes.FORBIDDEN, "the client secret has no client_id", 409);
  const secret = typeof v.client_secret === "string" && v.client_secret ? v.client_secret : undefined;
  const stated = typeof v.token_endpoint_auth_method === "string" ? v.token_endpoint_auth_method : undefined;
  return { client_id: v.client_id, ...(secret ? { client_secret: secret } : {}), auth_method: stated ?? defaultMethod(!!secret, as?.auth_methods ?? null) };
}

/** A confidential client uses `client_secret_basic` unless the AS lists only `client_secret_post` (RFC 8414 §2's default is basic). */
function defaultMethod(hasSecret: boolean, supported: string[] | null): string {
  if (!hasSecret) return "none";
  if (supported && !supported.includes("client_secret_basic") && supported.includes("client_secret_post")) return "client_secret_post";
  return "client_secret_basic";
}

/** RFC 7591 §3: register nest's redirect URI as a public client (or whatever the AS hands back). */
export async function registerClient(as: AuthServer, redirectUri: string): Promise<OAuthClient> {
  const r = await exchange(as.registration_endpoint!, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "nest", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!r.ok) throw new NestError(ErrorCodes.INTERNAL, `OAuth: registration at ${as.registration_endpoint}: ${r.why}`, 502, true);
  if ((r.status !== 201 && r.status !== 200) || !isObj(r.json) || typeof r.json.client_id !== "string") {
    throw oauthError(`registration at ${as.registration_endpoint} answered HTTP ${r.status}${isObj(r.json) && typeof r.json.error === "string" ? ` (${r.json.error})` : ""}`);
  }
  const secret = typeof r.json.client_secret === "string" ? r.json.client_secret : undefined;
  const method = typeof r.json.token_endpoint_auth_method === "string" ? r.json.token_endpoint_auth_method : defaultMethod(!!secret, as.auth_methods);
  return { client_id: r.json.client_id, ...(secret ? { client_secret: secret } : {}), auth_method: method };
}

// --- Authorization and token requests -------------------------------------------------------------------

export function authorizeUrl(as: Pick<AuthServer, "authorization_endpoint">, p: {
  client_id: string; redirect_uri: string; challenge: string; state: string; resource: string; scopes: string[] | null;
}): string {
  const u = new URL(as.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.client_id);
  u.searchParams.set("redirect_uri", p.redirect_uri);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", p.state);
  u.searchParams.set("resource", p.resource);
  if (p.scopes?.length) u.searchParams.set("scope", p.scopes.join(" "));
  return u.href;
}

/** RFC 6749 §2.3.1: id and secret form-encoded, then Basic. */
const basic = (id: string, secret: string) => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;

export type TokenAnswer =
  | { kind: "tokens"; access_token: string; refresh_token: string | null; expires_in_s: number | null; scope: string | null }
  /** The AS refused (RFC 6749 §5.2): the grant or the client is no good; retrying won't help. */
  | { kind: "refused"; error: string; status: number }
  /** No usable answer (timeout, network, 5xx, 429, a body that isn't a token response): try again later. */
  | { kind: "lost"; why: string };

/** A token request (§3.2) with the client's authentication; `resource` always (the spec: in every token request). */
export async function tokenRequest(endpoint: string, client: OAuthClient, params: Record<string, string>): Promise<TokenAnswer> {
  const form = new URLSearchParams(params);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.auth_method === "client_secret_basic" && client.client_secret) headers.authorization = basic(client.client_id, client.client_secret);
  else {
    form.set("client_id", client.client_id);
    if (client.auth_method === "client_secret_post" && client.client_secret) form.set("client_secret", client.client_secret);
  }
  const r = await exchange(endpoint, { method: "POST", headers, body: form.toString() });
  if (!r.ok) return { kind: "lost", why: r.why };
  const j = isObj(r.json) ? r.json : {};
  if (r.status === 400 || r.status === 401) return { kind: "refused", error: typeof j.error === "string" ? j.error.slice(0, 64) : `HTTP ${r.status}`, status: r.status };
  if (r.status !== 200) return { kind: "lost", why: `HTTP ${r.status}` };
  if (typeof j.access_token !== "string" || !j.access_token) return { kind: "lost", why: "a token response without access_token" };
  // OAuth 2.1 bearer tokens only: a DPoP or other token type can't be sent as `Authorization: Bearer`.
  if (typeof j.token_type !== "string" || j.token_type.toLowerCase() !== "bearer") return { kind: "refused", error: `token_type ${String(j.token_type)}`, status: 200 };
  const exp = typeof j.expires_in === "number" && Number.isFinite(j.expires_in) && j.expires_in > 0 ? j.expires_in : null;
  return {
    kind: "tokens", access_token: j.access_token, refresh_token: typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : null,
    expires_in_s: exp, scope: typeof j.scope === "string" ? j.scope : null,
  };
}

// --- The store (BrokerDO) ------------------------------------------------------------------------------------

const GrantStatus = z.enum(["authorized", "reauthorize"]);
type GrantStatus = z.output<typeof GrantStatus>;

interface GrantRow {
  ref: string;
  capability: string;
  server_url: string;
  resource: string;
  issuer: string;
  token_endpoint: string;
  client: ClientRef;
  scope: string | null;
  access_token: string | null;
  access_expires_ms: number | null;
  access_issued_ms: number | null;
  refresh_token: string | null;
  status: GrantStatus;
  reason: string | null;
  generation: number;
}

/** A flow the operator started, by its `state`. */
interface Flow {
  capability: string;
  ref: string;
  server_url: string;
  resource: string;
  issuer: string;
  token_endpoint: string;
  iss_parameter: boolean;
  client: ClientRef;
  verifier: string;
  redirect_uri: string;
  scopes: string[] | null;
}

/** An audit record (docs/control-plane/durable-objects/broker/#issuance-audit): never a token, code, verifier or state. */
export interface OAuthAudit {
  event: "oauth_start" | "oauth_authorized" | "oauth_callback_refused" | "oauth_refreshed" | "oauth_refresh_failed" | "oauth_registered" | "oauth_token_refused";
  capability?: string;
  ref?: string;
  resource?: string;
  issuer?: string;
  client?: string;
  scope?: string | null;
  expires_ms?: number | null;
  caller: string;
  reason?: string;
}

export interface StoreDeps {
  sql: SqlStorage;
  /** A BrokerDO secret's value (a pre-registered client's JSON). */
  secret(name: string): string | null;
  audit(r: OAuthAudit): void;
  publicBaseUrl: string;
  allowLoopback: boolean;
}

export interface StartInput {
  capability: string;
  url: string;
  auth: OAuthAuth;
  /** The operator's scopes for this authorization (a step-up), over the catalog's. */
  scopes?: string[];
}

export interface StartAnswer {
  authorize_url: string;
  expires_ms: number;
  capability: string;
  resource: string;
  issuer: string;
  client: ClientRef["kind"];
  scopes: string[] | null;
}

/** What the operator sees of a capability's authorization: never a token. */
export interface OAuthStatus {
  ref: string;
  status: GrantStatus | "unauthorized";
  capability?: string;
  server_url?: string;
  resource?: string;
  issuer?: string;
  client?: ClientRef["kind"];
  scope?: string | null;
  access_expires_ms?: number | null;
  refreshable?: boolean;
  reason?: string | null;
}

const startRoute = (capability: string) => `POST /v1/admin/capabilities/${capability}/oauth`;

export class OAuthStore {
  /** Refreshes in flight, by token record: concurrent callers share one, so a rotated refresh token is spent once. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly d: StoreDeps) {
    d.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_grants (ref TEXT PRIMARY KEY, capability TEXT NOT NULL, server_url TEXT NOT NULL,
      resource TEXT NOT NULL, issuer TEXT NOT NULL, token_endpoint TEXT NOT NULL, client TEXT NOT NULL, scope TEXT,
      access_token TEXT, access_expires_ms INTEGER, access_issued_ms INTEGER, refresh_token TEXT, status TEXT NOT NULL,
      reason TEXT, generation INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`);
    d.sql.exec("CREATE TABLE IF NOT EXISTS oauth_flows (state TEXT PRIMARY KEY, body TEXT NOT NULL, expires_ms INTEGER NOT NULL)");
    d.sql.exec(`CREATE TABLE IF NOT EXISTS oauth_clients (issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, client TEXT NOT NULL,
      created_ms INTEGER NOT NULL, PRIMARY KEY (issuer, redirect_uri))`);
  }

  private grant(ref: string): GrantRow | undefined {
    const r = this.d.sql.exec<Record<string, string | number | null>>("SELECT * FROM oauth_grants WHERE ref = ?", ref).toArray()[0];
    if (!r) return undefined;
    return {
      ...(r as unknown as GrantRow),
      client: JSON.parse(r.client as string) as ClientRef,
      status: storedEnum(GrantStatus, r.status, "oauth_grants.status"),
    };
  }

  /** The client a token request authenticates as, read now (a rotated pre-registered secret takes effect). */
  private client(c: ClientRef, as: Pick<AuthServer, "auth_methods"> | null): OAuthClient {
    switch (c.kind) {
      case "pre-registered": {
        const v = this.d.secret(c.secret);
        if (v === null) throw new NestError(ErrorCodes.FORBIDDEN, `OAuth: no pre-registered client stored as ${c.secret} (PUT /v1/admin/secrets/${c.secret})`, 409);
        return parseClient(v, as ?? { auth_methods: c.auth_methods });
      }
      case "metadata":
        return { client_id: c.client_id, auth_method: "none" };
      case "registered": {
        const r = this.d.sql.exec<{ client: string }>("SELECT client FROM oauth_clients WHERE issuer = ? AND redirect_uri = ?", c.issuer, c.redirect_uri).toArray()[0];
        if (!r) throw new NestError(ErrorCodes.FORBIDDEN, `OAuth: the client registered with ${c.issuer} is gone; authorize again`, 409);
        return JSON.parse(r.client) as OAuthClient;
      }
    }
  }

  /**
   * Start an authorization (the operator, once): discover, pick the client (pre-registered, else nest's
   * metadata document where the AS supports it, else registration), and return the URL the operator
   * opens. The PKCE verifier stays in the flow row; the `state` names it, is single use, and lasts 10 minutes.
   */
  async start(input: StartInput, caller: string): Promise<StartAnswer> {
    const server = checkOAuthUrl(input.url, this.d.allowLoopback, "the server URL");
    const found = await discover(server, this.d.allowLoopback);
    const { redirect_uri, client_id } = oauthUrls(this.d.publicBaseUrl);
    let client: ClientRef;
    let id: string;
    if (input.auth.client) {
      client = { kind: "pre-registered", secret: input.auth.client, auth_methods: found.as.auth_methods };
      id = this.client(client, found.as).client_id;
    } else if (found.as.cimd && canUseMetadataDocument(this.d.publicBaseUrl, this.d.allowLoopback)) {
      client = { kind: "metadata", client_id };
      id = client_id;
    } else if (found.as.registration_endpoint) {
      client = { kind: "registered", issuer: found.as.issuer, redirect_uri };
      const known = this.d.sql.exec<{ client: string }>("SELECT client FROM oauth_clients WHERE issuer = ? AND redirect_uri = ?", found.as.issuer, redirect_uri).toArray()[0];
      if (known) {
        id = (JSON.parse(known.client) as OAuthClient).client_id;
      } else {
        const registered = await registerClient(found.as, redirect_uri);
        // Another start may have registered across the await: the first stored registration wins.
        const again = this.d.sql.exec<{ client: string }>("SELECT client FROM oauth_clients WHERE issuer = ? AND redirect_uri = ?", found.as.issuer, redirect_uri).toArray()[0];
        if (again) {
          id = (JSON.parse(again.client) as OAuthClient).client_id;
        } else {
          this.d.sql.exec("INSERT INTO oauth_clients (issuer, redirect_uri, client, created_ms) VALUES (?, ?, ?, ?)",
            found.as.issuer, redirect_uri, JSON.stringify(registered), Date.now());
          id = registered.client_id;
          this.d.audit({ event: "oauth_registered", capability: input.capability, issuer: found.as.issuer, client: id, caller });
        }
      }
    } else {
      throw oauthError(`${found.as.issuer} supports neither client ID metadata documents (for an https PUBLIC_BASE_URL) nor registration: `
        + `register a client there and store it with PUT /v1/admin/secrets/cap:<name> {"value": "{\\"client_id\\": …}"}, named as auth.client`, 409);
    }
    const scopes = input.scopes ?? input.auth.scopes ?? found.scopes;
    const { verifier, challenge } = await pkcePair();
    const state = randomToken();
    const now = Date.now();
    const flow: Flow = {
      capability: input.capability, ref: input.auth.oauth, server_url: input.url, resource: found.resource, issuer: found.as.issuer,
      token_endpoint: found.as.token_endpoint, iss_parameter: found.as.iss_parameter, client, verifier, redirect_uri, scopes,
    };
    this.d.sql.exec("DELETE FROM oauth_flows WHERE expires_ms <= ?", now);
    this.d.sql.exec("INSERT INTO oauth_flows (state, body, expires_ms) VALUES (?, ?, ?)", state, JSON.stringify(flow), now + OAUTH_FLOW_TTL_MS);
    this.d.audit({ event: "oauth_start", capability: input.capability, ref: input.auth.oauth, resource: found.resource, issuer: found.as.issuer, client: id, scope: scopes?.join(" ") ?? null, caller });
    return {
      authorize_url: authorizeUrl(found.as, { client_id: id, redirect_uri, challenge, state, resource: found.resource, scopes }),
      expires_ms: now + OAUTH_FLOW_TTL_MS, capability: input.capability, resource: found.resource, issuer: found.as.issuer, client: client.kind, scopes,
    };
  }

  /**
   * The authorization server's redirect: the flow its `state` names is taken (deleted) at once, so a
   * state works once; the code is exchanged with the flow's verifier, and the tokens replace any
   * stored for its capability. The answer is for a browser: it never holds a token.
   */
  async callback(q: { state?: string; code?: string; error?: string; iss?: string }, caller: string): Promise<{ ok: boolean; capability: string | null; message: string }> {
    const refuse = (message: string, flow?: Flow) => {
      this.d.audit({ event: "oauth_callback_refused", ...(flow ? { capability: flow.capability, ref: flow.ref, issuer: flow.issuer } : {}), caller, reason: message });
      return { ok: false, capability: flow?.capability ?? null, message };
    };
    if (!q.state) return refuse("no state");
    const row = this.d.sql.exec<{ body: string; expires_ms: number }>("SELECT body, expires_ms FROM oauth_flows WHERE state = ?", q.state).toArray()[0];
    this.d.sql.exec("DELETE FROM oauth_flows WHERE state = ?", q.state);
    if (!row || row.expires_ms <= Date.now()) return refuse("unknown or expired state: start the authorization again");
    const flow = JSON.parse(row.body) as Flow;
    // RFC 9207: an `iss` that doesn't match is a mix-up; one the AS promised must be there.
    if ((q.iss !== undefined || flow.iss_parameter) && q.iss !== flow.issuer) return refuse(`the response's iss is ${q.iss ?? "missing"}, not ${flow.issuer}`, flow);
    if (q.error) return refuse(`the authorization server answered ${q.error.slice(0, 64)}`, flow);
    if (!q.code) return refuse("no code", flow);
    const client = this.client(flow.client, null);
    const a = await tokenRequest(flow.token_endpoint, client, {
      grant_type: "authorization_code", code: q.code, redirect_uri: flow.redirect_uri, code_verifier: flow.verifier, resource: flow.resource,
    });
    if (a.kind !== "tokens") return refuse(`the token endpoint ${a.kind === "refused" ? `refused the code (${a.error})` : `gave no answer (${a.why})`}`, flow);
    const now = Date.now();
    const generation = (this.grant(flow.ref)?.generation ?? 0) + 1;
    const expires = a.expires_in_s === null ? null : now + a.expires_in_s * 1000;
    this.d.sql.exec(`INSERT INTO oauth_grants (ref, capability, server_url, resource, issuer, token_endpoint, client, scope, access_token,
        access_expires_ms, access_issued_ms, refresh_token, status, reason, generation, updated_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'authorized', NULL, ?, ?)
      ON CONFLICT(ref) DO UPDATE SET capability = excluded.capability, server_url = excluded.server_url, resource = excluded.resource,
        issuer = excluded.issuer, token_endpoint = excluded.token_endpoint, client = excluded.client, scope = excluded.scope,
        access_token = excluded.access_token, access_expires_ms = excluded.access_expires_ms, access_issued_ms = excluded.access_issued_ms,
        refresh_token = excluded.refresh_token, status = 'authorized', reason = NULL, generation = excluded.generation, updated_ms = excluded.updated_ms`,
    flow.ref, flow.capability, flow.server_url, flow.resource, flow.issuer, flow.token_endpoint, JSON.stringify(flow.client),
    a.scope ?? flow.scopes?.join(" ") ?? null, a.access_token, expires, now, a.refresh_token, generation, now);
    this.d.audit({
      event: "oauth_authorized", capability: flow.capability, ref: flow.ref, resource: flow.resource, issuer: flow.issuer, client: client.client_id,
      scope: a.scope ?? flow.scopes?.join(" ") ?? null, expires_ms: expires, caller,
    });
    return { ok: true, capability: flow.capability, message: `${flow.capability} is authorized${a.refresh_token ? "" : " (no refresh token: authorize again when the access token expires)"}` };
  }

  /**
   * The access token to send to `serverUrl` for the record `ref`: the stored one while it has more than
   * a minute left, else refreshed (one refresh at a time per record; concurrent callers share it). With
   * `refused` (the token the server just answered 401 to): a replacement, refreshing unless one is already
   * stored. The proxy asks with `refused` once per request, so a server that refuses every token costs one
   * refresh per call, never a loop. Throws a platform error naming what the operator must do when there is no usable authorization.
   */
  async token(ref: string, serverUrl: string, refused: string | undefined, caller: string): Promise<string | null> {
    const row = this.grant(ref);
    const deny = (code: string, status: number, message: string, retryable = false): never => {
      this.d.audit({ event: "oauth_token_refused", ref, ...(row ? { capability: row.capability, issuer: row.issuer } : {}), caller, reason: message });
      throw new NestError(code, message, status, retryable);
    };
    if (!row) return deny(ErrorCodes.FORBIDDEN, 409, `no OAuth authorization stored as ${ref}: the operator authorizes the capability (POST /v1/admin/capabilities/<name>/oauth)`);
    if (row.server_url !== serverUrl) {
      return deny(ErrorCodes.FORBIDDEN, 409, `the OAuth tokens stored as ${ref} are for ${row.server_url}, not ${serverUrl}: authorize again (${startRoute(row.capability)})`);
    }
    if (row.status === "reauthorize") return deny(ErrorCodes.UNAUTHORIZED, 401, `${row.capability} needs the operator to authorize it again (${startRoute(row.capability)}): ${row.reason ?? "its tokens were refused"}`);
    const now = Date.now();
    const fresh = row.access_token !== null && (row.access_expires_ms === null || row.access_expires_ms - now > OAUTH_REFRESH_SKEW_MS);
    if (fresh && row.access_token !== refused) return row.access_token;
    let p = this.refreshing.get(ref);
    if (!p) {
      p = this.refresh(ref, caller).finally(() => this.refreshing.delete(ref));
      this.refreshing.set(ref, p);
    }
    return await p;
  }

  private markReauthorize(row: GrantRow, reason: string, caller: string): never {
    this.d.sql.exec(`UPDATE oauth_grants SET status = 'reauthorize', reason = ?, access_token = NULL, refresh_token = NULL, updated_ms = ?
      WHERE ref = ? AND generation = ?`, reason, Date.now(), row.ref, row.generation);
    this.d.audit({ event: "oauth_refresh_failed", capability: row.capability, ref: row.ref, issuer: row.issuer, caller, reason });
    throw new NestError(ErrorCodes.UNAUTHORIZED, `${row.capability} needs the operator to authorize it again (${startRoute(row.capability)}): ${reason}`, 401);
  }

  private async refresh(ref: string, caller: string): Promise<string> {
    const row = this.grant(ref)!;
    if (!row.refresh_token) return this.markReauthorize(row, "the access token expired or was refused, and there is no refresh token", caller);
    const sent = row.refresh_token;
    const a = await tokenRequest(row.token_endpoint, this.client(row.client, null), { grant_type: "refresh_token", refresh_token: sent, resource: row.resource });
    // Across the await: an authorization the operator completed meanwhile wins over this refresh.
    const now = this.grant(ref);
    if (!now || now.generation !== row.generation || now.refresh_token !== sent) {
      if (now?.status === "authorized" && now.access_token) return now.access_token;
      throw new NestError(ErrorCodes.UNAUTHORIZED, `${row.capability}'s authorization changed during a refresh; try again`, 401, true);
    }
    if (a.kind === "refused") return this.markReauthorize(row, `the authorization server refused the refresh token (${a.error})`, caller);
    if (a.kind === "lost") {
      this.d.audit({ event: "oauth_refresh_failed", capability: row.capability, ref, issuer: row.issuer, caller, reason: `no answer: ${a.why}` });
      throw new NestError(ErrorCodes.INTERNAL, `refreshing ${row.capability}'s OAuth token failed (${a.why}); it is tried again on the next call`, 502, true);
    }
    const t = Date.now();
    const expires = a.expires_in_s === null ? null : t + a.expires_in_s * 1000;
    // A rotated refresh token replaces the spent one (OAuth 2.1 §4.3.1); otherwise the old one stays.
    this.d.sql.exec(`UPDATE oauth_grants SET access_token = ?, access_expires_ms = ?, access_issued_ms = ?, refresh_token = ?, scope = COALESCE(?, scope),
      updated_ms = ? WHERE ref = ?`, a.access_token, expires, t, a.refresh_token ?? sent, a.scope, t, ref);
    this.d.audit({ event: "oauth_refreshed", capability: row.capability, ref, issuer: row.issuer, expires_ms: expires, caller, reason: a.refresh_token ? "rotated" : "kept" });
    return a.access_token;
  }

  status(ref: string): OAuthStatus {
    const r = this.grant(ref);
    if (!r) return { ref, status: "unauthorized" };
    return {
      ref, status: r.status, capability: r.capability, server_url: r.server_url, resource: r.resource, issuer: r.issuer, client: r.client.kind,
      scope: r.scope, access_expires_ms: r.access_expires_ms, refreshable: r.refresh_token !== null, reason: r.reason,
    };
  }
}

// --- The proxy's seam -----------------------------------------------------------------------------------

/** What `mcpBearer` needs of BrokerDO. */
export interface BearerSource {
  capabilityToken(ref: string): Promise<string | null>;
  mcpOAuthToken(ref: string, serverUrl: string, refused?: string): Promise<string | null>;
}

/**
 * The bearer to send to `g`'s server: its static `cap:` secret, or its OAuth access token (refreshed as
 * needed). With `refused`, the bearer that server just answered 401 to: a replacement, or null when there
 * is none (a static bearer never has one). Null without `refused`: no static bearer is stored. A missing
 * or spent OAuth authorization throws the platform error the operator acts on. A grant with no `auth`
 * has no bearer (null): callers check `g.auth` first and send none.
 */
export async function mcpBearer(broker: BearerSource, g: McpGrant, refused?: string): Promise<string | null> {
  if (g.auth === undefined) return null;
  if (g.oauth) return await broker.mcpOAuthToken(g.auth, g.url, refused);
  return refused === undefined ? await broker.capabilityToken(g.auth) : null;
}
