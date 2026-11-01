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
};
/** A concrete path for a pattern: each parameter as an id of its kind. */
const concrete = (path: string) => path.replace(/[:*]([a-z]+)/g, (_m, k: string) =>
  ({ agent: "agt_x", sandbox: "sbx_x", host: "hst_x", ws: "ws_x", ask: "ask_x", sub: "sub_x", port: "80", secret: "s" } as Record<string, string>)[k] ?? "x");

describe("route authentication", () => {
  it("every route that isn't on the allowlist needs the admin token, and the allowlist is exact", async () => {
    const open = Object.fromEntries(ROUTES.filter((r) => r.auth !== "admin").map((r) => [`${r.method} ${r.path}`, r.auth]));
    expect(open).toEqual(NOT_ADMIN);
    for (const r of ROUTES.filter((x) => x.auth === "admin")) {
      const res = await SELF.fetch(`${BASE}${concrete(r.path)}`, { method: r.method, headers: { "content-type": "application/json" }, ...(r.method === "GET" ? {} : { body: "{}" }) });
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
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
