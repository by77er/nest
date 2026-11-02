// The MCP servers admit only a valid Nest-Identity (docs/interfaces/remote-mcp/#nest-identity, the
// oracle): an EdDSA JWT signed by a key in nest's JWKS, for this server's exact URL, issued by nest, not
// expired, naming the app as both client and owner, with the server's role in its labels. Anything else
// gets 401/403 and no data. A key pair made here plays nest's signing key.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { REFETCH_MIN_MS, resetIdentityKeys } from "../src/identity";
import { agentClaims, APP, b64urlJson, connectorClaims, FakeNest, installFetch, mcp, Signer } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let nest: Signer;
let stranger: Signer;

beforeAll(async () => {
  restore = installFetch(fake);
  nest = await Signer.create("k1");
  stranger = await Signer.create("k1");
  fake.jwks = { keys: [await nest.jwk()] };
});
afterAll(() => restore());
beforeEach(() => resetIdentityKeys());

const managerLabels = { project: "prj_none", role: "manager" };
const good = () => agentClaims("board", "agt_manager1", managerLabels);

/** The request's status and whether it leaked anything (a body). */
async function list(server: string, token: string | null) {
  const res = await mcp(server, token, "tools/list");
  const text = await res.text();
  return { status: res.status, body: text };
}

describe("Nest-Identity on the MCP servers", () => {
  it("admits the app's own manager on /mcp/board and lists the board's tools", async () => {
    const r = await list("board", await nest.sign(good()));
    expect(r.status).toBe(200);
    const names = (JSON.parse(r.body).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("create_task");
  });

  const refused: [string, number, () => Promise<string | null>, string?][] = [
    ["no header", 401, async () => null],
    ["not a JWT", 401, async () => "not-a-jwt"],
    ["a signature by another key under nest's kid", 401, () => stranger.sign(good())],
    ["an unknown kid", 401, () => nest.sign(good(), { kid: "k-unknown" })],
    ["alg none", 401, async () => `${b64urlJson({ alg: "none", kid: "k1" })}.${b64urlJson(good())}.`],
    ["a payload changed after signing", 401, async () => {
      const [h, , s] = (await nest.sign(good())).split(".");
      return `${h}.${b64urlJson({ ...good(), labels: { project: "prj_other", role: "manager" } })}.${s}`;
    }],
    ["another server's aud", 401, () => nest.sign({ ...good(), aud: `${APP}/mcp/task` })],
    ["the aud with a trailing slash", 401, () => nest.sign({ ...good(), aud: `${APP}/mcp/board/` })],
    ["another issuer", 401, () => nest.sign({ ...good(), iss: "https://evil.test" })],
    ["an expired token", 401, () => nest.sign({ ...good(), exp: Math.floor(Date.now() / 1000) - 1 })],
    ["no exp", 401, () => nest.sign({ ...good(), exp: undefined })],
    ["another client's agent", 403, () => nest.sign({ ...good(), client: "cli_other", owner: "cli_other" })],
    ["a token naming another client, with the app as owner", 403, () => nest.sign({ ...good(), client: "cli_other" })],
    ["an agent with no client", 403, () => nest.sign({ ...good(), client: undefined, owner: "user" })],
    // A spawned agent's labels are its spawner's choice: refused however right they look.
    ["an agent spawned by an agent (owner agt_…), with the right labels", 403, () => nest.sign({ ...good(), owner: "agt_spawner" })],
    ["the operator's agent naming the app as client", 403, () => nest.sign({ ...good(), owner: "user" })],
    ["a worker on the manager's server", 403, () => nest.sign({ ...good(), labels: { project: "prj_none", role: "worker", task: "tsk_a" } })],
    ["no role label", 403, () => nest.sign({ ...good(), labels: { project: "prj_none" } })],
    ["no labels", 403, () => nest.sign({ ...good(), labels: undefined })],
    ["no project label", 403, () => nest.sign({ ...good(), labels: { role: "manager" } })],
    ["a sub that isn't an agent", 403, () => nest.sign({ ...good(), sub: "user" })],
  ];

  it.each(refused)("refuses %s with %i and no data", async (_name, status, token) => {
    const t = await token();
    for (const method of ["initialize", "tools/list", "tools/call"]) {
      const res = await mcp("board", t, method, method === "tools/call" ? { name: "list_tasks", arguments: {} } : {});
      expect(res.status, method).toBe(status);
      expect(await res.text(), method).toBe("");
    }
  });

  it("refuses a manager on the worker's and the reviewer's servers, and a worker without a task", async () => {
    expect((await list("task", await nest.sign({ ...good(), aud: `${APP}/mcp/task` }))).status).toBe(403);
    expect((await list("review", await nest.sign({ ...good(), aud: `${APP}/mcp/review` }))).status).toBe(403);
    expect((await list("task", await nest.sign(agentClaims("task", "agt_w", { project: "prj_none", role: "worker" })))).status).toBe(403);
    expect((await list("task", await nest.sign(agentClaims("task", "agt_w", { project: "prj_none", role: "worker", task: "tsk_a" })))).status).toBe(200);
    expect((await list("review", await nest.sign(agentClaims("review", "agt_r", { project: "prj_none", role: "reviewer" })))).status).toBe(200);
  });

  it("lets nest's connector initialize and list, never call", async () => {
    const t = await nest.sign(connectorClaims("board"));
    expect((await mcp("board", t, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nest-connector" } })).status).toBe(200);
    expect((await mcp("board", t, "notifications/initialized")).status).toBe(202);
    expect((await list("board", t)).status).toBe(200);
    const call = await mcp("board", t, "tools/call", { name: "list_tasks", arguments: {} });
    expect(call.status).toBe(403);
    expect(await call.text()).toBe("");
    // A connector token is still bound to its server.
    expect((await list("task", t)).status).toBe(401);
  });

  it("refuses everything when nest's keys can't be fetched", async () => {
    const keep = fake.jwks;
    fake.jwks = undefined as never;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    try {
      expect((await list("board", await nest.sign(good()))).status).toBe(503);
    } finally {
      globalThis.fetch = real;
      fake.jwks = keep;
    }
  });

  it("caches nest's keys, and refetches for an unknown kid at most once per interval", async () => {
    const before = fake.jwksFetches;
    await list("board", await nest.sign(good()));
    await list("board", await nest.sign(good()));
    expect(fake.jwksFetches - before).toBe(1);
    // Junk kids can't drive fetches.
    for (let i = 0; i < 3; i++) expect((await list("board", await nest.sign(good(), { kid: `junk-${i}` }))).status).toBe(401);
    expect(fake.jwksFetches - before).toBe(1);
  });

  it("takes a rotated key once the interval has passed", async () => {
    const now = vi.spyOn(Date, "now");
    const t0 = Date.now();
    now.mockReturnValue(t0);
    try {
      expect((await list("board", await nest.sign(good()))).status).toBe(200);
      const next = await Signer.create("k2");
      fake.jwks = { keys: [await nest.jwk(), await next.jwk()] };
      const rotated = await next.sign({ ...good(), iat: Math.floor(t0 / 1000), exp: Math.floor(t0 / 1000) + 3600 });
      expect((await list("board", rotated)).status).toBe(401); // too soon to refetch
      now.mockReturnValue(t0 + REFETCH_MIN_MS + 1);
      expect((await list("board", rotated)).status).toBe(200);
    } finally {
      now.mockRestore();
      fake.jwks = { keys: [await nest.jwk()] };
    }
  });
});
