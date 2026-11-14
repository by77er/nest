// The manager's status (src/manager.ts) against what nest's agent record says (control-plane AgentDO
// `info()`: `state`, `host`, `capacity_waits`, `ended`), and the route that reads it.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MANAGER_RESTART_WINDOW_MS, MANAGER_RESTARTS, type ManagerLife, managerStatus, managerStep } from "../src/manager";
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
    ["it ended and no start is owed: the owner's Restart", { ...attached, manager: null, manager_error: "ended 4 times", manager_start_owed: false }, null, "ended", "ended 4 times"],
    ["it ended and a new one is owed", { ...attached, manager: null, manager_error: "a new one is starting", manager_start_owed: true }, null, "starting", "a new one is starting"],
  ] as const)("%s", (_what, settings, lookup, phase, error) => {
    const s = managerStatus(settings, lookup as never);
    expect([s.phase, s.error]).toEqual([phase, error]);
  });
});

describe("the manager's lifecycle (managerStep)", () => {
  const bo = (n: number) => n * 1000;
  const live: ManagerLife = { manager: "agt_m", next_ms: null, restarts: [], error: null };
  const NOW = 10_000_000;

  it("an ended manager is replaced with backoff, up to the cap in the window, then waits for the owner", () => {
    let l = live;
    for (let i = 0; i < MANAGER_RESTARTS; i++) {
      const s = managerStep({ ...l, manager: `agt_${i}` }, { kind: "ended", agent: `agt_${i}`, reason: "exited" }, NOW + i, bo);
      expect(s).toMatchObject({ changed: true, stop: `agt_${i}`, life: { manager: null, next_ms: NOW + i + bo(i + 1) } });
      l = s.life;
    }
    const last = managerStep({ ...l, manager: "agt_x" }, { kind: "ended", agent: "agt_x", reason: "exited" }, NOW + 10, bo);
    expect(last.life).toMatchObject({ manager: null, next_ms: null });
    expect(last.life.error).toContain(`${MANAGER_RESTARTS + 1} times within an hour`);
    // Past the window, restarts count afresh.
    const later = managerStep({ ...last.life, manager: "agt_y" }, { kind: "ended", agent: "agt_y", reason: "exited" }, NOW + MANAGER_RESTART_WINDOW_MS + 100, bo);
    expect(later.life.next_ms).not.toBeNull();
  });

  it("an exit of a manager that isn't the current one changes nothing", () => {
    expect(managerStep(live, { kind: "ended", agent: "agt_old", reason: "exited" }, NOW, bo)).toEqual({ life: live, stop: null, changed: false });
  });

  it("the owner's Restart stops the current one and starts now; asked while one is starting, nothing changes", () => {
    const r = managerStep({ ...live, restarts: [NOW - 1, NOW - 2] }, { kind: "restart" }, NOW, bo);
    expect(r).toEqual({ life: { manager: null, next_ms: NOW, restarts: [], error: null }, stop: "agt_m", changed: true });
    expect(managerStep(r.life, { kind: "restart" }, NOW + 1, bo).changed).toBe(false);
    // After it ended for good (an error, nothing owed): a Restart starts one.
    expect(managerStep({ manager: null, next_ms: null, restarts: [], error: "ended" }, { kind: "restart" }, NOW, bo)).toMatchObject({ changed: true, stop: null, life: { next_ms: NOW } });
  });

  it("moving onto the app's access stops the current one and starts now, its automatic restarts kept as they were; another agent's changes nothing", () => {
    const l = { ...live, restarts: [NOW - 1, NOW - 2] };
    expect(managerStep(l, { kind: "converge", agent: "agt_m" }, NOW, bo)).toEqual({ life: { manager: null, next_ms: NOW, restarts: [NOW - 1, NOW - 2], error: null }, stop: "agt_m", changed: true });
    expect(managerStep(l, { kind: "converge", agent: "agt_old" }, NOW, bo)).toEqual({ life: l, stop: null, changed: false });
    expect(managerStep({ manager: null, next_ms: NOW, restarts: [], error: null }, { kind: "converge", agent: "agt_m" }, NOW, bo).changed).toBe(false);
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

  it("reads nest's record of the manager: running, then waiting for a host; ended, it's replaced (README.md#the-manager-lifecycle)", async () => {
    const p = await newProject();
    const m = fake.agents.get(p.settings.manager)!;
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "running", agent: m.agent, state: "idle", host: "bh_1" });
    m.state = "starting";
    m.capacityWaits = 1;
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "waiting_for_host", host: null });
    m.ended = true;
    // Its exit never reached the app: the page's read finds it ended, and a new one is owed.
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "starting", agent: null, error: expect.stringContaining("The manager ended (stopped)") });
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0 WHERE manager_next_ms IS NOT NULL"); });
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    const next = (await api(token, "GET", `/api/projects/${p.id}/manager`)).body;
    expect(next).toMatchObject({ phase: "running" });
    expect(next.agent).not.toBe(m.agent);
    // Gone from nest altogether: the same.
    fake.agents.delete(next.agent);
    expect((await api(token, "GET", `/api/projects/${p.id}/manager`)).body).toMatchObject({ phase: "starting", error: expect.stringContaining("nest no longer has it") });
  });

  it("says when nest can't be asked, instead of failing the page", async () => {
    const p = await newProject();
    fake.fail(new RegExp(`^GET /v1/agents/${p.settings.manager}$`), 500, { times: 3 });
    const r = await api(token, "GET", `/api/projects/${p.id}/manager`);
    expect(r.status).toBe(200);
    expect(r.body.phase).toBe("unknown");
  });
});
