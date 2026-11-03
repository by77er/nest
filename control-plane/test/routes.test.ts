// The Worker's route table (src/index.ts): authentication is a required field of every route, so a
// route added anywhere is checked by what it says, never by where it sits.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { ROUTES } from "../src/index";
import clientsDoc from "../../docs/control-plane/api/clients/README.md?raw";
import { ADMIN, BASE, uniqueCell } from "./helpers";

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
    "POST /v1/agents", "GET /v1/agents", "GET /v1/agents/:agent", "GET /v1/agents/:agent/turns", "GET /v1/agents/:agent/transcript", "GET /v1/agents/:agent/trace", "GET /v1/agents/:agent/trace/history",
    "POST /v1/agents/:agent/turns", "POST /v1/agents/:agent/inbox", "POST /v1/agents/:agent/interrupt", "POST /v1/agents/:agent/start",
    "POST /v1/agents/:agent/stop", "GET /v1/agents/:agent/children", "GET /v1/agents/:agent/brokered", "GET /v1/agents/:agent/asks",
    "POST /v1/agents/:agent/asks/:ask/answer", "GET /v1/agents/:agent/timers", "DELETE /v1/agents/:agent/timers/:name",
    "POST /v1/sandboxes", "GET /v1/sandboxes", "GET /v1/sandboxes/:sandbox", "DELETE /v1/sandboxes/:sandbox", "PUT /v1/sandboxes/:sandbox/lifetime",
    "GET /v1/sandboxes/:sandbox/policy", "GET /v1/sandboxes/:sandbox/client-policy", "PUT /v1/sandboxes/:sandbox/client-policy",
    "GET /v1/catalog",
    ...["GET", "PUT", "DELETE"].flatMap((m) => ["templates", "capabilities"].map((k) => `${m} /v1/catalog/${k}/:ns/:entry`)),
    // A client's own (test/client-events.test.ts): the operator has no `self`.
    "GET /v1/clients/self", "PUT /v1/clients/self/webhook",
    // Its own secrets (test/client-secrets.test.ts): write-only values, a listing of names.
    "GET /v1/clients/self/secrets", "PUT /v1/clients/self/secrets/:name", "DELETE /v1/clients/self/secrets/:name",
  ].map((r) => [r, "owner"])),
  // A client's own: only a client token has a self, the operator's is refused (test/client-github-token.test.ts).
  "POST /v1/clients/self/github-token": "owner",
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

  it("the clients doc's route table lists exactly the routes a client's token reaches", () => {
    // Its rows are `| \`METHOD\` | \`/path/<param>\` | check |`, under "## Routes".
    const section = clientsDoc.split(/^## Routes$/m)[1]!.split(/^## /m)[0]!;
    const documented = [...section.matchAll(/^\| `([A-Z]+)` \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
    const owner = ROUTES.filter((r) => r.auth === "owner").map((r) => `${r.method} ${r.path.replace(/:([a-z]+)/g, "<$1>")}`);
    expect(documented.length, "a row twice").toBe(new Set(documented).size);
    expect(new Set(documented)).toEqual(new Set(owner));
  });

  it("no two routes share a method and path", () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

// --- ?cell= only where a route is about one cell ------------------------------------------------------------

describe("?cell= (a multi-cell config: CELLS names two cells, neither of them the default `local`)", () => {
  const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

  it("routes that reach an agent, a sandbox, the catalog, a client or a secret need no ?cell= (and still accept one); a cell's own routes do", async () => {
    const cellA = uniqueCell();
    const cellB = uniqueCell();
    const multi = { ...env, CELLS: `${cellA},${cellB}` } as typeof env;
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const res = await worker.fetch(new Request(`${BASE}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), multi);
      const text = await res.text();
      return { status: res.status, text };
    };
    const ok = async (token: string, method: string, path: string, body?: unknown) => {
      const r = await call(token, method, path, body);
      expect(r.status, `${method} ${path}: ${r.text}`).toBeLessThan(300);
      return JSON.parse(r.text);
    };
    const name = `cells-${rand()}`;
    const c = await ok(ADMIN, "POST", "/v1/admin/clients", { name, grant: { cells: [cellA], credentials: ["claude_oauth_token"], max_agents: 2 } });
    // The client's own: its catalog, an agent and everything reached by the agent's id, its listing, its self.
    await ok(c.token, "PUT", `/v1/catalog/templates/${name}/t`, {
      capabilities: ["nest"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "forbidden", credential: "claude_oauth_token",
    });
    await ok(c.token, "GET", `/v1/catalog/templates/${name}/t`);
    const a = await ok(c.token, "POST", "/v1/agents", { template: `${name}/t`, cell: cellA, start: false });
    expect(a.cell).toBe(cellA);
    await ok(c.token, "GET", `/v1/agents/${a.agent}`);
    await ok(c.token, "POST", `/v1/agents/${a.agent}/inbox`, { text: "hello" });
    await ok(c.token, "GET", `/v1/agents/${a.agent}/asks`);
    await ok(c.token, "GET", "/v1/agents");
    await ok(c.token, "GET", "/v1/clients/self");
    // Refused by its grant, not by a cell: the route reached its own check.
    const gh = await call(c.token, "POST", "/v1/clients/self/github-token", { repo: "o/r", permissions: { contents: "read" } });
    expect(gh.status).toBe(403);
    expect(gh.text).toContain("outside");
    // The operator's routes that aren't about a cell.
    await ok(ADMIN, "PUT", `/v1/admin/secrets/x-${rand()}`, { value: "v" });
    await ok(ADMIN, "GET", "/v1/admin/catalog");
    await ok(ADMIN, "GET", `/v1/admin/clients/${c.client}`);
    // ?cell= is still accepted where it was sent before.
    await ok(c.token, "POST", `/v1/agents/${a.agent}/inbox?cell=${cellA}`, { text: "again" });
    await ok(c.token, "POST", `/v1/agents/${a.agent}/stop?cell=${cellA}`, { end: true });
    // A cell's own routes still take ?cell= (default `local`, outside CELLS here).
    expect((await call(ADMIN, "GET", "/v1/admin/fleet")).text).toContain("unknown cell local");
    await ok(ADMIN, "GET", `/v1/admin/fleet?cell=${cellB}`);
    expect((await call(ADMIN, "GET", "/v1/agents")).status).toBe(403);
    await ok(ADMIN, "GET", `/v1/agents?cell=${cellA}`);
    expect((await call(ADMIN, "GET", `/v1/admin/gc?cell=nowhere`)).status).toBe(403);
  });
});
