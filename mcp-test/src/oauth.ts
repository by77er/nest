// OAuth mode (off unless MCP_TEST_OAUTH=1): this Worker is then also its own tiny authorization server,
// so nest's e2e can run the MCP authorization flow (spec 2025-11-25, basic/authorization) headlessly.
//
//   GET  /.well-known/oauth-protected-resource/mcp     RFC 9728 metadata: resource <origin>/mcp, AS <origin>/oauth
//   GET  /.well-known/oauth-authorization-server/oauth RFC 8414 metadata (path-inserted: the issuer has a path)
//   GET  /oauth/authorize   needs Authorization: Bearer <MCP_TEST_TOKEN> (the "user's login and consent"); 302 with a code
//   POST /oauth/token       authorization_code (PKCE S256, resource, redirect URI) and refresh_token (always rotated)
//   POST /oauth/register    RFC 7591, public clients only
//   POST /oauth/expire      (static bearer) every access token expires now
//   POST /oauth/revoke      (static bearer) every access and refresh token is revoked
//   GET  /oauth/log         (static bearer) the token requests seen, and how often a metadata document was fetched
//
// /mcp then admits a live access token for <origin>/mcp as well as the static bearer, and its 401 names
// the metadata. The authorize route needs the static bearer, so turning the mode on doesn't let anyone
// else get a token.

const ACCESS_TTL_S = 3600;
const CODE_TTL_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const oauthEnabled = (env: Env) => env.MCP_TEST_OAUTH === "1";
export const resourceOf = (origin: string) => `${origin}/mcp`;
export const prmUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;
const issuerOf = (origin: string) => `${origin}/oauth`;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const random = () => {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** https, or http on a loopback host (local development). */
function webUrl(raw: string | null): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u;
  } catch {
    // not a URL
  }
  return null;
}

export type OAuthLogEntry = { ts_ms: number; grant_type: string | null; client_id: string | null; outcome: string };

/** What the AS keeps (in McpState's SQLite): clients, codes, tokens and a log. */
export interface OAuthStore {
  oauthRegister(redirectUris: string[]): string;
  oauthClient(clientId: string): string[] | null;
  oauthIssueCode(c: { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string | null }): string;
  oauthTakeCode(code: string): { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string | null; expires_ms: number } | null;
  oauthIssue(clientId: string, resource: string, ttlS: number): { access_token: string; refresh_token: string };
  oauthRotate(refresh: string, clientId: string, resource: string, ttlS: number): { access_token: string; refresh_token: string } | null;
  oauthAccessValid(token: string, resource: string): boolean;
  oauthExpire(): void;
  oauthRevoke(): void;
  oauthLog(e: Omit<OAuthLogEntry, "ts_ms">): void;
  oauthLogRead(): { token_requests: OAuthLogEntry[]; metadata_fetches: number };
  oauthCountMetadataFetch(): void;
}

/** The OAuth routes that need no static bearer, or null when `url` isn't one. */
export async function publicOAuthRoute(req: Request, env: Env, url: URL, store: OAuthStore, token: () => Promise<boolean>): Promise<Response | null> {
  const origin = url.origin;
  const key = `${req.method} ${url.pathname}`;
  switch (key) {
    case "GET /.well-known/oauth-protected-resource/mcp":
      return json(200, { resource: resourceOf(origin), authorization_servers: [issuerOf(origin)], scopes_supported: ["mcp"], bearer_methods_supported: ["header"] });
    case "GET /.well-known/oauth-authorization-server/oauth":
      return json(200, {
        issuer: issuerOf(origin), authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`,
        registration_endpoint: `${origin}/oauth/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], client_id_metadata_document_supported: true,
        scopes_supported: ["mcp"],
      });
    case "GET /oauth/authorize":
      return authorize(url, store, token);
    case "POST /oauth/token":
      return tokenEndpoint(req, env, origin, store);
    case "POST /oauth/register":
      return register(req, store);
  }
  return null;
}

async function authorize(url: URL, store: OAuthStore, token: () => Promise<boolean>): Promise<Response> {
  const q = url.searchParams;
  const fail = (why: string) => json(400, { error: "invalid_request", error_description: why });
  // The "user" logs in and consents by presenting the static bearer; nobody else gets a code.
  if (!(await token())) return json(401, { error: "login_required" }, { "www-authenticate": 'Bearer realm="nest-mcp-test authorize"' });
  const clientId = q.get("client_id");
  const redirect = q.get("redirect_uri");
  if (!clientId || !redirect || !webUrl(redirect)) return fail("client_id and an https (or loopback) redirect_uri are required");
  let allowed = store.oauthClient(clientId);
  const doc = webUrl(clientId);
  if (!allowed && doc && doc.pathname !== "/") {
    // A client ID metadata document: fetched, its client_id must be its URL, and it lists the redirect URI.
    store.oauthCountMetadataFetch();
    const res = await fetch(doc.href, { headers: { accept: "application/json" }, redirect: "manual" });
    const m = res.status === 200 ? ((await res.json().catch(() => null)) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown } | null) : null;
    if (!m || m.client_id !== clientId || typeof m.client_name !== "string" || !Array.isArray(m.redirect_uris)) return fail("the client ID metadata document is invalid");
    allowed = m.redirect_uris.filter((r): r is string => typeof r === "string");
  }
  if (!allowed) return fail("unknown client");
  if (!allowed.includes(redirect)) return fail("redirect_uri is not registered");
  if (q.get("response_type") !== "code") return fail("response_type must be code");
  if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) return fail("PKCE with S256 is required");
  if (q.get("resource") !== resourceOf(url.origin)) return fail(`resource must be ${resourceOf(url.origin)}`);
  const state = q.get("state");
  const code = store.oauthIssueCode({ client_id: clientId, redirect_uri: redirect, challenge: q.get("code_challenge")!, resource: q.get("resource")!, scope: q.get("scope") });
  const back = new URL(redirect);
  back.searchParams.set("code", code);
  if (state !== null) back.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: back.href, "cache-control": "no-store" } });
}

async function tokenEndpoint(req: Request, env: Env, origin: string, store: OAuthStore): Promise<Response> {
  const form = new URLSearchParams(await req.text());
  const grant = form.get("grant_type");
  const clientId = form.get("client_id");
  const refuse = (error: string, status = 400) => {
    store.oauthLog({ grant_type: grant, client_id: clientId, outcome: error });
    return json(status, { error });
  };
  if (!clientId) return refuse("invalid_client", 401);
  const ttl = Number(env.MCP_TEST_OAUTH_TTL_S ?? ACCESS_TTL_S);
  if (form.get("resource") !== resourceOf(origin)) return refuse("invalid_target");
  if (grant === "authorization_code") {
    const c = store.oauthTakeCode(form.get("code") ?? "");
    if (!c || c.expires_ms <= Date.now() || c.client_id !== clientId || c.redirect_uri !== form.get("redirect_uri")) return refuse("invalid_grant");
    if ((await s256(form.get("code_verifier") ?? "")) !== c.challenge) return refuse("invalid_grant");
    store.oauthLog({ grant_type: grant, client_id: clientId, outcome: "ok" });
    const t = store.oauthIssue(clientId, c.resource, ttl);
    return json(200, { ...t, token_type: "Bearer", expires_in: ttl, scope: c.scope ?? "mcp" });
  }
  if (grant === "refresh_token") {
    const t = store.oauthRotate(form.get("refresh_token") ?? "", clientId, resourceOf(origin), ttl);
    if (!t) return refuse("invalid_grant");
    store.oauthLog({ grant_type: grant, client_id: clientId, outcome: "ok" });
    return json(200, { ...t, token_type: "Bearer", expires_in: ttl });
  }
  return refuse("unsupported_grant_type");
}

async function register(req: Request, store: OAuthStore): Promise<Response> {
  const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown } | null;
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string" && !!webUrl(u)) : [];
  if (!uris.length) return json(400, { error: "invalid_redirect_uri" });
  const client_id = store.oauthRegister(uris);
  return json(201, { client_id, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
}

/** The static-bearer test routes, or null. */
export function testOAuthRoute(req: Request, url: URL, store: OAuthStore): Response | null {
  switch (`${req.method} ${url.pathname}`) {
    case "POST /oauth/expire":
      store.oauthExpire();
      return json(200, { ok: true });
    case "POST /oauth/revoke":
      store.oauthRevoke();
      return json(200, { ok: true });
    case "GET /oauth/log":
      return json(200, store.oauthLogRead());
  }
  return null;
}

/** The SQLite side, mixed into McpState. */
export class OAuthTables implements OAuthStore {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (client_id TEXT PRIMARY KEY, redirect_uris TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (code TEXT PRIMARY KEY, body TEXT NOT NULL, expires_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_tokens (token TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, resource TEXT NOT NULL, expires_ms INTEGER, valid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, grant_type TEXT, client_id TEXT, outcome TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
    `);
  }

  oauthRegister(redirectUris: string[]): string {
    const id = `mcp-test-${random()}`;
    this.sql.exec("INSERT INTO oauth_clients (client_id, redirect_uris) VALUES (?, ?)", id, JSON.stringify(redirectUris));
    return id;
  }

  oauthClient(clientId: string): string[] | null {
    const r = this.sql.exec<{ redirect_uris: string }>("SELECT redirect_uris FROM oauth_clients WHERE client_id = ?", clientId).toArray()[0];
    return r ? (JSON.parse(r.redirect_uris) as string[]) : null;
  }

  oauthIssueCode(c: { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string | null }): string {
    const code = random();
    this.sql.exec("INSERT INTO oauth_codes (code, body, expires_ms) VALUES (?, ?, ?)", code, JSON.stringify(c), Date.now() + CODE_TTL_MS);
    return code;
  }

  /** A code works once: it is deleted as it is read. */
  oauthTakeCode(code: string) {
    const r = this.sql.exec<{ body: string; expires_ms: number }>("SELECT body, expires_ms FROM oauth_codes WHERE code = ?", code).toArray()[0];
    this.sql.exec("DELETE FROM oauth_codes WHERE code = ?", code);
    return r ? { ...(JSON.parse(r.body) as { client_id: string; redirect_uri: string; challenge: string; resource: string; scope: string | null }), expires_ms: r.expires_ms } : null;
  }

  oauthIssue(clientId: string, resource: string, ttlS: number) {
    const access_token = random();
    const refresh_token = random();
    this.sql.exec("INSERT INTO oauth_tokens (token, kind, client_id, resource, expires_ms, valid) VALUES (?, 'access', ?, ?, ?, 1)", access_token, clientId, resource, Date.now() + ttlS * 1000);
    this.sql.exec("INSERT INTO oauth_tokens (token, kind, client_id, resource, expires_ms, valid) VALUES (?, 'refresh', ?, ?, NULL, 1)", refresh_token, clientId, resource);
    return { access_token, refresh_token };
  }

  /** Spends a refresh token (rotation: a spent one is invalid_grant from then on) for a new pair. */
  oauthRotate(refresh: string, clientId: string, resource: string, ttlS: number) {
    const r = this.sql.exec<{ client_id: string; resource: string }>("SELECT client_id, resource FROM oauth_tokens WHERE token = ? AND kind = 'refresh' AND valid = 1", refresh).toArray()[0];
    if (!r || r.client_id !== clientId || r.resource !== resource) return null;
    this.sql.exec("UPDATE oauth_tokens SET valid = 0 WHERE token = ?", refresh);
    return this.oauthIssue(clientId, resource, ttlS);
  }

  oauthAccessValid(token: string, resource: string): boolean {
    return this.sql.exec("SELECT 1 FROM oauth_tokens WHERE token = ? AND kind = 'access' AND valid = 1 AND resource = ? AND expires_ms > ?", token, resource, Date.now()).toArray().length > 0;
  }

  oauthExpire(): void {
    this.sql.exec("UPDATE oauth_tokens SET expires_ms = 0 WHERE kind = 'access'");
  }

  oauthRevoke(): void {
    this.sql.exec("UPDATE oauth_tokens SET valid = 0");
  }

  oauthLog(e: Omit<OAuthLogEntry, "ts_ms">): void {
    this.sql.exec("INSERT INTO oauth_log (ts_ms, grant_type, client_id, outcome) VALUES (?, ?, ?, ?)", Date.now(), e.grant_type, e.client_id, e.outcome);
  }

  oauthCountMetadataFetch(): void {
    this.sql.exec("INSERT INTO oauth_meta (k, v) VALUES ('metadata_fetches', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1");
  }

  oauthLogRead() {
    const token_requests = this.sql.exec<OAuthLogEntry>("SELECT ts_ms, grant_type, client_id, outcome FROM oauth_log ORDER BY seq").toArray();
    const m = this.sql.exec<{ v: number }>("SELECT v FROM oauth_meta WHERE k = 'metadata_fetches'").toArray()[0];
    return { token_requests: token_requests.map((r) => ({ ...r })), metadata_fetches: m?.v ?? 0 };
  }
}
