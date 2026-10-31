// The Worker's `GET /api/agents`: AgentDO's record of each agent the fleet view lists, narrowed to
// what the page shows. The oracle is the control plane's responses: a recorded `GET /v1/agents/:agent`
// (fixtures/admin.ts) and its error body for an unknown agent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, fleet } from "../fixtures/admin";
import { type AgentsResponse, listedAgents, mapBounded, MAX_AGENTS } from "../src/agents";
import worker, { type Env } from "../src/worker";

const CONTROL_PLANE = "https://cp.example";
const KNOWN = agent.agent;
const UNKNOWN = "agt_01m690zzzzzzzzzzzzzzzzzzzz";

const env: Env = {
  ASSETS: { fetch: async () => new Response("<html>") } as unknown as Fetcher,
  NEST_CONTROL_PLANE: CONTROL_PLANE,
  NEST_CELLS: "use1",
  NEST_ADMIN_TOKEN: "admin-token",
};

let upstream: { path: string; auth: string | null }[];
let fleetBody: unknown;
let fleetStatus: number;

const fleetListing = (...agents: string[][]) => ({ ...fleet, hosts: agents.map((a, i) => ({ ...fleet.hosts[0]!, host: `hst_${i}`, agents: a })) });

async function getAgents(): Promise<Response> {
  return worker.fetch(new Request("https://dash.example/api/agents?cell=use1") as never, env);
}

beforeEach(() => {
  // `vite dev`: no Access check (test/access.test.ts holds that one).
  vi.stubEnv("DEV", true);
  upstream = [];
  fleetBody = fleetListing([KNOWN, UNKNOWN]);
  fleetStatus = 200;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== CONTROL_PLANE) throw new Error(`unexpected fetch ${url}`);
    upstream.push({ path: url.pathname + url.search, auth: new Headers(init?.headers).get("authorization") });
    if (url.pathname === "/v1/admin/fleet") return Response.json(fleetBody, { status: fleetStatus });
    if (url.pathname === `/v1/agents/${KNOWN}`) return Response.json(agent);
    if (url.pathname.startsWith("/v1/agents/")) {
      return Response.json({ error: { code: "unknown_agent", message: "unknown agent", retryable: false } }, { status: 404 });
    }
    throw new Error(`unexpected route ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /api/agents", () => {
  it("reads each listed agent with the admin token and narrows its record to the page's fields", async () => {
    const res = await getAgents();
    expect(res.status).toBe(200);
    const body = await res.json() as AgentsResponse;
    expect(body).toEqual({
      omitted: 0,
      agents: [
        {
          agent: KNOWN, error: null,
          info: {
            agent: KNOWN, template: "worker", lifecycle: "ready", activity: "working", state: "working",
            current_turn: agent.current_turn, sandbox: agent.hands.sandbox,
            brain: { host: agent.brain.host, phase: "live", since_ms: agent.brain.since_ms },
          },
        },
        { agent: UNKNOWN, info: null, error: "404: unknown agent" },
      ],
    });
    // The record's prompt, rules and parameters stay in the Worker.
    expect(JSON.stringify(body)).not.toContain(agent.launch.system_prompt.text.slice(0, 40));
    expect(upstream).toEqual([
      { path: "/v1/admin/fleet?cell=use1", auth: "Bearer admin-token" },
      { path: `/v1/agents/${KNOWN}`, auth: "Bearer admin-token" },
      { path: `/v1/agents/${UNKNOWN}`, auth: "Bearer admin-token" },
    ]);
  });

  it("reads an agent on two hosts once, and nothing that is not an agent id", async () => {
    fleetBody = fleetListing([KNOWN], [KNOWN, "../admin/secrets/x", "AGT_upper"]);
    const body = await (await getAgents()).json() as AgentsResponse;
    expect(body.agents.map((a) => a.agent)).toEqual([KNOWN]);
    expect(upstream.map((u) => u.path)).toEqual(["/v1/admin/fleet?cell=use1", `/v1/agents/${KNOWN}`]);
  });

  it("answers an agent the control plane cannot be reached for as a row, not a failure", async () => {
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(UNKNOWN)) throw new Error("network down");
      return real(input, init);
    });
    const res = await getAgents();
    expect(res.status).toBe(200);
    expect((await res.json() as AgentsResponse).agents.map((a) => [a.agent, a.error])).toEqual([[KNOWN, null], [UNKNOWN, "network down"]]);
  });

  it("passes on the fleet view's error and reads no agent", async () => {
    fleetStatus = 503;
    fleetBody = { error: { code: "unavailable", message: "down" } };
    const res = await getAgents();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(fleetBody);
    expect(upstream.map((u) => u.path)).toEqual(["/v1/admin/fleet?cell=use1"]);
  });

  it("reads at most MAX_AGENTS and counts the rest", async () => {
    const many = Array.from({ length: MAX_AGENTS + 3 }, (_, i) => `agt_${String(i).padStart(4, "0")}`);
    fleetBody = fleetListing(many);
    const body = await (await getAgents()).json() as AgentsResponse;
    expect(body.agents).toHaveLength(MAX_AGENTS);
    expect(body.omitted).toBe(3);
    expect(upstream).toHaveLength(1 + MAX_AGENTS);
  });

  it("refuses an unknown cell before reading anything", async () => {
    const res = await worker.fetch(new Request("https://dash.example/api/agents?cell=other") as never, env);
    expect(res.status).toBe(400);
    expect(upstream).toEqual([]);
  });
});

describe("the agents' helpers", () => {
  it("listedAgents takes the fleet fixture's agent", () => {
    expect(listedAgents(fleet)).toEqual(fleet.hosts[0]!.agents);
  });

  it("mapBounded keeps order and never runs more than its limit at once", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapBounded([5, 1, 4, 2, 3, 0], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });
});
