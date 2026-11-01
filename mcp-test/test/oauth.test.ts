// OAuth mode (src/oauth.ts) against the MCP authorization spec 2025-11-25 and RFCs 9728, 8414, 7636, 7591:
// off by default (the bearer mode the cloud check uses is unchanged), and when on, a headless
// authorization server whose tokens /mcp accepts. On-mode requests call the Worker with the flag set.
import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";

const BASE = "https://mcp-test.example";
const TOKEN = "test-token";
const CLIENT = "https://client.test/oauth/client.json";
const REDIRECT = "https://client.test/callback";
const RESOURCE = `${BASE}/mcp`;
const on = { ...env, MCP_TEST_OAUTH: "1" } as Env;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${BASE}${path}`, init) as Request<unknown, IncomingRequestCfProperties>, on);
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))) };
}
const initialize = (token: string) => call("/mcp", {
  method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
});
const form = (p: Record<string, string>) => call("/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(p).toString() });

// The client's metadata document, served to the authorization server's fetch.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(new Request(input as RequestInfo, init).url);
    if (u.href === CLIENT) return Response.json({ client_id: CLIENT, client_name: "test", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

/** Authorize as the logged-in user and return the code the redirect carries. */
async function code(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE, state: "st", ...extra });
  const res = await call(`/oauth/authorize?${q}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status, await res.clone().text()).toBe(302);
  const back = new URL(res.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("st");
  return back.searchParams.get("code")!;
}

describe("OAuth mode", () => {
  it("is off by default: no metadata, and /mcp's 401 names none", async () => {
    const res = await SELF.fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(401);
    const mcp = await SELF.fetch(`${BASE}/mcp`, { method: "POST", body: "{}" });
    expect(mcp.headers.get("www-authenticate")).toBe('Bearer realm="nest-mcp-test"');
  });

  it("serves the discovery chain the spec describes: a 401 naming the metadata, the metadata, the AS metadata with S256", async () => {
    const r = await initialize("not-a-token");
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp", scope="mcp", error="invalid_token"`);
    const prm: any = await (await call("/.well-known/oauth-protected-resource/mcp")).json();
    expect(prm).toMatchObject({ resource: RESOURCE, authorization_servers: [`${BASE}/oauth`] });
    const as: any = await (await call("/.well-known/oauth-authorization-server/oauth")).json();
    expect(as).toMatchObject({ issuer: `${BASE}/oauth`, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true });
  });

  it("authorizes only the logged-in user, checks the metadata document, PKCE and resource, and its tokens open /mcp but not the test routes", async () => {
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: CLIENT, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", resource: RESOURCE });
    expect((await call(`/oauth/authorize?${q}`)).status).toBe(401);
    for (const [k, v] of [["resource", `${BASE}/other`], ["code_challenge_method", "plain"], ["redirect_uri", "https://evil.test/cb"]] as const) {
      const bad = new URLSearchParams(q);
      bad.set(k, v);
      expect((await call(`/oauth/authorize?${bad}`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, k).toBe(400);
    }
    // A wrong verifier spends the code; the right one on a fresh code works once.
    const c1 = await code(CLIENT, challenge);
    expect(await (await form({ grant_type: "authorization_code", code: c1, redirect_uri: REDIRECT, code_verifier: "x".repeat(43), client_id: CLIENT, resource: RESOURCE })).json()).toEqual({ error: "invalid_grant" });
    expect((await form({ grant_type: "authorization_code", code: c1, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT, resource: RESOURCE })).status).toBe(400);
    const c2 = await code(CLIENT, challenge);
    const t: any = await (await form({ grant_type: "authorization_code", code: c2, redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT, resource: RESOURCE })).json();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, access_token: expect.any(String), refresh_token: expect.any(String) });
    expect((await initialize(t.access_token)).status).toBe(200);
    expect((await call("/calls", { headers: { authorization: `Bearer ${t.access_token}` } })).status).toBe(401);

    // Refresh rotates: the spent refresh token is refused from then on; a revocation ends both.
    const r1: any = await (await form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT, resource: RESOURCE })).json();
    expect(r1.refresh_token).not.toBe(t.refresh_token);
    expect((await form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: CLIENT, resource: RESOURCE })).status).toBe(400);
    const admin = { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } };
    expect((await call("/oauth/expire", admin)).status).toBe(200);
    expect((await initialize(r1.access_token)).status).toBe(401);
    expect((await call("/oauth/revoke", admin)).status).toBe(200);
    expect((await form({ grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id: CLIENT, resource: RESOURCE })).status).toBe(400);
    const log: any = await (await call("/oauth/log", { headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(log.metadata_fetches).toBeGreaterThanOrEqual(3);
    expect(log.token_requests.map((e: any) => `${e.grant_type}:${e.outcome}`)).toEqual(expect.arrayContaining(["refresh_token:ok", "refresh_token:invalid_grant", "authorization_code:ok"]));
    expect((await call("/oauth/log")).status).toBe(404);
  });

  it("registers public clients (RFC 7591) and authorizes them for their redirect URIs only", async () => {
    const reg = await call("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) });
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const { verifier, challenge } = await pkce();
    const c = await code(client_id, challenge);
    expect((await form({ grant_type: "authorization_code", code: c, redirect_uri: REDIRECT, code_verifier: verifier, client_id, resource: RESOURCE })).status).toBe(200);
    expect((await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.test/cb"] }) })).status).toBe(400);
  });
});
