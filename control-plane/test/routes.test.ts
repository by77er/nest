// The Worker's route table (src/index.ts): authentication is a required field of every route, so a
// route added anywhere is checked by what it says, never by where it sits.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/index";
import { BASE } from "./helpers";

/** The only routes reachable without the admin token, and what proves the caller instead. */
const NOT_ADMIN = {
  "GET /v1/health": "none",
  "POST /v1/hosts/enroll": "none",
  "GET /v1/blobs/*key": "none",
  "POST /v1/hosts/gc/claim": "host",
  "POST /v1/hosts/gc/report": "host",
  "GET /v1/fleet": "host",
  "GET /v1/agents/:agent/session": "host",
  // A browser follows an authorization server's redirect here; the single-use state is the proof (test/mcp-oauth.test.ts).
  "GET /v1/oauth/callback": "none",
  // nest's client ID metadata document, fetched by authorization servers: public by design.
  "GET /v1/oauth/client.json": "none",
  // The caller identity's public keys, fetched by MCP servers that verify Nest-Identity: public by design.
  "GET /.well-known/jwks.json": "none",
  // An API client's token is accepted too, on its own subtree (docs/control-plane/api/clients/; test/clients.test.ts).
  ...Object.fromEntries([
    "POST /v1/agents", "GET /v1/agents", "GET /v1/agents/:agent", "GET /v1/agents/:agent/turns", "GET /v1/agents/:agent/transcript",
    "POST /v1/agents/:agent/turns", "POST /v1/agents/:agent/inbox", "POST /v1/agents/:agent/interrupt", "POST /v1/agents/:agent/start",
    "POST /v1/agents/:agent/stop", "GET /v1/agents/:agent/children", "GET /v1/agents/:agent/brokered", "GET /v1/agents/:agent/asks",
    "POST /v1/agents/:agent/asks/:ask/answer",
    "POST /v1/sandboxes", "GET /v1/sandboxes", "GET /v1/sandboxes/:sandbox", "DELETE /v1/sandboxes/:sandbox", "PUT /v1/sandboxes/:sandbox/lifetime",
    "GET /v1/sandboxes/:sandbox/policy",
    "GET /v1/catalog",
    ...["GET", "PUT", "DELETE"].flatMap((m) => ["templates", "capabilities"].map((k) => `${m} /v1/catalog/${k}/:ns/:entry`)),
  ].map((r) => [r, "owner"])),
};
/** A concrete path for a pattern: each parameter as an id of its kind. */
const concrete = (path: string) => path.replace(/[:*]([a-z]+)/g, (_m, k: string) =>
  ({ agent: "agt_x", sandbox: "sbx_x", host: "hst_x", ws: "ws_x", ask: "ask_x", sub: "sub_x", port: "80", secret: "s", client: "cli_x", ns: "ns", entry: "e" } as Record<string, string>)[k] ?? "x");

describe("route authentication", () => {
  it("every route that isn't on the allowlist needs the admin token, and the allowlist is exact", async () => {
    const open = Object.fromEntries(ROUTES.filter((r) => r.auth !== "admin").map((r) => [`${r.method} ${r.path}`, r.auth]));
    expect(open).toEqual(NOT_ADMIN);
    // Neither an admin route nor an owner route answers without a token, or with a client token that isn't one.
    const forged = `nest_cli_x_${"0".repeat(64)}`;
    for (const r of ROUTES.filter((x) => x.auth === "admin" || x.auth === "owner")) {
      for (const auth of [{}, { authorization: `Bearer ${forged}` }] as Record<string, string>[]) {
        const res = await SELF.fetch(`${BASE}${concrete(r.path)}`, { method: r.method, headers: { "content-type": "application/json", ...auth }, ...(r.method === "GET" ? {} : { body: "{}" }) });
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
      }
    }
  });

  it("a host route refuses a missing token, and an unknown path is 404 only to the operator", async () => {
    expect((await SELF.fetch(`${BASE}/v1/hosts/gc/claim`, { method: "POST" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/v1/nothing-here`)).status).toBe(401);
  });

  it("no two routes share a method and path", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
