// `GET /api/agents/<id>/trace` (src/trace.ts): only an agent of one of the app's projects, behind Access;
// proxied to nest's live trace with the client token (which never reaches the browser), the socket nest
// answers handed through as it is. The fake nest's trace endpoint is a WebSocket in the workers pool.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, api, APP, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let team: AccessTeam;
let token: string;

beforeAll(async () => {
  team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

async function newProject() {
  const repo = `owner-${rand()}/repo-${rand()}`;
  const r = await api(token, "POST", "/api/projects", { name: `p ${repo}`, repo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const manager = r.body.settings.manager as string;
  expect(manager).toMatch(/^agt_/);
  return { id: r.body.id as string, manager };
}

const upgrade = (agent: string, o: { access?: string | null; query?: string; upgrade?: boolean } = {}) =>
  SELF.fetch(`${APP}/api/agents/${agent}/trace${o.query ?? ""}`, {
    headers: {
      ...(o.access === null ? {} : { "cf-access-jwt-assertion": o.access ?? token }),
      ...(o.upgrade === false ? {} : { upgrade: "websocket" }),
      cookie: "CF_Authorization=browser-cookie",
    },
  });

/** A connected trace socket and what it has received. */
async function connect(agent: string, query = "") {
  const res = await upgrade(agent, { query });
  if (res.status !== 101) throw new Error(`upgrade answered ${res.status}: ${await res.text()}`);
  const ws = res.webSocket!;
  const got: any[] = [];
  ws.accept();
  ws.addEventListener("message", (e) => {
    got.push(JSON.parse(e.data as string));
  });
  return { ws, got };
}

async function until(f: () => boolean, what: string) {
  const end = Date.now() + 3000;
  while (!f()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the trace route", () => {
  it("proxies an agent of the app's projects to nest with the client token, and hands the socket through", async () => {
    const p = await newProject();
    fake.pushTrace(p.manager, { type: "turn_started", turn: "trn_1", input_kind: "user" });
    fake.pushTrace(p.manager, { type: "assistant_text", turn: "trn_1", text: "hello" });
    const before = fake.calls.length;
    const { ws, got } = await connect(p.manager, "?after=1");
    const call = fake.calls.slice(before).find((c) => c.path === `/v1/agents/${p.manager}/trace`)!;
    expect(call.auth).toBe(`Bearer nest_cli_app_${"0".repeat(64)}`);
    expect(call.query.get("after")).toBe("1");
    // Backlog after 1, then live, then what happens.
    await until(() => got.length >= 2, "the backlog");
    expect(got).toEqual([{ seq: 2, ts_ms: expect.any(Number), type: "assistant_text", turn: "trn_1", text: "hello" }, { type: "live" }]);
    ws.send(JSON.stringify({ fake: "push", event: { type: "turn_completed", turn: "trn_1", stop_reason: "end_turn" } }));
    await until(() => got.length >= 3, "a live event");
    expect(got[2]).toMatchObject({ seq: 3, type: "turn_completed" });
    ws.close();
  });

  it("forwards nothing of the browser's: not its Access token or cookie", async () => {
    const p = await newProject();
    let seen: Headers | null = null;
    const inner = fake.handle.bind(fake);
    fake.handle = async (req: Request) => {
      if (new URL(req.url).pathname.endsWith("/trace")) seen = new Headers(req.headers);
      return inner(req);
    };
    try {
      const { ws } = await connect(p.manager);
      expect(seen).not.toBeNull();
      expect(seen!.get("cookie")).toBeNull();
      expect(seen!.get("cf-access-jwt-assertion")).toBeNull();
      expect(seen!.get("upgrade")).toBe("websocket");
      ws.close();
    } finally {
      fake.handle = inner;
    }
  });

  it("refuses an agent the app didn't record for a project, before asking nest", async () => {
    await newProject();
    // nest has it (the app's own client), but no project of the app's: unknown here.
    const stray = fake.plant({ labels: { project: "prj_nope", role: "worker" } });
    const before = fake.calls.length;
    for (const id of [stray.agent, "agt_unknown1", "not-an-id"]) {
      const res = await upgrade(id);
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown agent" });
    }
    expect(fake.calls.slice(before).filter((c) => c.path.endsWith("/trace"))).toEqual([]);
  });

  it("is behind Access, takes only an upgrade and a well-formed `after`", async () => {
    const p = await newProject();
    expect((await upgrade(p.manager, { access: null })).status).toBe(403);
    expect((await upgrade(p.manager, { upgrade: false })).status).toBe(426);
    for (const q of ["?after=-1", "?after=x", "?after="]) expect((await upgrade(p.manager, { query: q })).status, q).toBe(400);
  });

  it("passes nest's retryable 503 on as a 503, and another refusal as a 502 with its message", async () => {
    const p = await newProject();
    fake.traceRefusals.push({ status: 503, code: "internal", retryable: true });
    const r503 = await upgrade(p.manager);
    expect(r503.status).toBe(503);
    fake.traceRefusals.push({ status: 500, code: "internal", retryable: true });
    const r502 = await upgrade(p.manager);
    expect(r502.status).toBe(502);
    expect(await r502.json()).toEqual({ error: "refused" });
    // nest's 404 (the agent was reaped) is the app's 404.
    fake.traceRefusals.push({ status: 404, code: "unknown_agent", retryable: false });
    expect((await upgrade(p.manager)).status).toBe(404);
  });
});
