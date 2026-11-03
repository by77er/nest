// The manager's status (src/manager.ts) against what nest's agent record says (control-plane AgentDO
// `info()`: `state`, `host`, `capacity_waits`, `ended`), and the route that reads it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { managerStatus } from "../src/manager";
import { AccessTeam, api, FakeNest, installFetch } from "./fake-nest";

const attached = { attached: true, attach_error: null, manager: "agt_m", manager_error: null };

describe("the manager's phase", () => {
  it.each([
    ["the repo is still attaching", { ...attached, attached: false, manager: null }, null, "attaching", null],
    ["the attach failed", { ...attached, attached: false, manager: null, attach_error: "403 from GitHub" }, null, "attach_failed", "403 from GitHub"],
    ["the start is owed and failing", { ...attached, manager: null, manager_error: "nest is unavailable" }, null, "starting", "nest is unavailable"],
    ["nest is starting it on a host", attached, { record: { state: "starting", host: "bh_1" } }, "starting", null],
    ["no host had room yet", attached, { record: { state: "starting", host: null, capacity_waits: 2 } }, "waiting_for_host", null],
    ["it's working", attached, { record: { state: "working", host: "bh_1" } }, "running", null],
    ["it's waiting for input", attached, { record: { state: "waiting_input", host: "bh_1" } }, "running", null],
    ["it errored", attached, { record: { state: "errored", host: null } }, "errored", null],
    ["it ended", attached, { record: { state: "idle", ended: { reason: "stopped" } } }, "ended", "stopped"],
    ["nest no longer has it", attached, { gone: true }, "ended", "nest no longer has this agent"],
    ["nest couldn't be asked", attached, { failed: "502" }, "unknown", "502"],
  ] as const)("%s", (_what, settings, lookup, phase, error) => {
    const s = managerStatus(settings, lookup as never);
    expect([s.phase, s.error]).toEqual([phase, error]);
  });
});

describe("GET /api/projects/:id/manager", () => {
  const fake = new FakeNest();
  let restore: () => void;
  let token: string;
  beforeAll(async () => {
    const team = await AccessTeam.create();
    const certs = await team.certs();
    restore = installFetch(fake, () => certs);
    resetAccessKeys();
    token = await team.token();
  });
  afterAll(() => restore());

  async function newProject() {
    const repo = `o-${crypto.randomUUID().slice(0, 8)}/r`;
    const p = await api(token, "POST", "/api/projects", { name: repo, repo });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    return p.body as { id: string; settings: { manager: string } };
  }

  it("reads nest's record of the manager: running, then waiting for a host, then ended", async () => {
    const p = await newProject();
    const m = fake.agents.get(p.settings.manager)!;
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "running", agent: m.agent, state: "idle", host: "bh_1" });
    m.state = "starting";
    m.capacityWaits = 1;
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "waiting_for_host", host: null });
    m.ended = true;
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "ended", error: "stopped" });
    fake.agents.delete(m.agent);
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "ended", error: "nest no longer has this agent" });
  });

  it("says when nest can't be asked, instead of failing the page", async () => {
    const p = await newProject();
    fake.fail(new RegExp(`^GET /v1/agents/${p.settings.manager}$`), 500, { times: 3 });
    const r = await api(token, "GET", `/api/projects/${p.id}/manager`);
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("unknown");
  });
});
