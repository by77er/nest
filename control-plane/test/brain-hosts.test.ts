// Brain hosts (docs/compute/brain-hosts/): the pure placement and scaling decisions (lib/placement.ts),
// unit- and property-tested, then FleetDO and AgentDO applying them: brains only on brain hosts,
// sandboxes never there, the warm-host preference, capacity in brains, scale-up and idle retirement.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { AwsCellConfig } from "../src/lib/cells";
import { awsCell } from "../src/lib/cells";
import { CapacityError, type Ec2, type ImageInfo, type InstanceState, type LaunchSpec } from "../src/lib/ec2";
import { BRAINS_PER_VCPU, idleStep, maxBrains, pickBrainHost, scaleUpPlan, type BrainHostFacts } from "../src/lib/placement";
import { adminJson, connectHost, csrPem, enrollHost, hostHello, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;

/** A small seeded PRNG (mulberry32): property tests that fail reproduce from their seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pickBrainHost (pure)", () => {
  const h = (host: string, brains: number, max = 4, healthy = true): BrainHostFacts => ({ host, brains, max_brains: max, healthy });

  it("prefers the previous host when it has room, else the fullest with room; never avoid, unhealthy or full", () => {
    const hosts = [h("hst_a", 1), h("hst_b", 3), h("hst_c", 4), h("hst_d", 0, 4, false)];
    expect(pickBrainHost(hosts, "hst_a")).toEqual({ host: "hst_a", why: "previous" });
    expect(pickBrainHost(hosts, null)).toEqual({ host: "hst_b", why: "packed" });
    // The previous host full, unhealthy or avoided: packed elsewhere.
    expect(pickBrainHost(hosts, "hst_c")).toEqual({ host: "hst_b", why: "packed" });
    expect(pickBrainHost(hosts, "hst_d")).toEqual({ host: "hst_b", why: "packed" });
    expect(pickBrainHost(hosts, "hst_b", "hst_b")).toEqual({ host: "hst_a", why: "packed" });
    // Ties go to the smallest id, so the choice doesn't depend on row order.
    expect(pickBrainHost([h("hst_z", 2), h("hst_y", 2)])).toEqual({ host: "hst_y", why: "packed" });
    expect(pickBrainHost([h("hst_y", 2), h("hst_z", 2)])).toEqual({ host: "hst_y", why: "packed" });
    expect(pickBrainHost([h("hst_c", 4)])).toEqual({ host: null, why: "full" });
    expect(pickBrainHost([h("hst_d", 0, 4, false)])).toEqual({ host: null, why: "none" });
    expect(pickBrainHost([h("hst_a", 0)], null, "hst_a")).toEqual({ host: null, why: "none" });
    expect(pickBrainHost([])).toEqual({ host: null, why: "none" });
  });

  it("property: the pick is always usable, is prev whenever prev can take it, packs otherwise, and is null only when nothing can", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const r = rng(seed);
      const n = Math.floor(r() * 6);
      const hosts = Array.from({ length: n }, (_, i) =>
        h(`hst_${String.fromCharCode(97 + Math.floor(r() * 8))}${i}`, Math.floor(r() * 5), Math.floor(r() * 5), r() < 0.7));
      const pickFrom = (xs: BrainHostFacts[]) => xs[Math.floor(r() * xs.length)]?.host ?? null;
      const prev = r() < 0.6 ? pickFrom(hosts) : r() < 0.5 ? "hst_gone" : null;
      const avoid = r() < 0.3 ? pickFrom(hosts) : null;
      const usable = hosts.filter((x) => x.healthy && x.host !== avoid && x.brains < x.max_brains);
      const p = pickBrainHost(hosts, prev, avoid);
      const ctx = `seed ${seed}: ${JSON.stringify({ hosts, prev, avoid, p })}`;
      if (!usable.length) {
        expect(p.host, ctx).toBeNull();
        expect(p.why, ctx).toBe(hosts.some((x) => x.healthy && x.host !== avoid) ? "full" : "none");
        continue;
      }
      const chosen = hosts.find((x) => x.host === p.host);
      expect(chosen && usable.includes(chosen), ctx).toBe(true);
      if (prev && usable.some((x) => x.host === prev)) expect(p, ctx).toEqual({ host: prev, why: "previous" });
      else expect(chosen!.brains, ctx).toBe(Math.max(...usable.map((x) => x.brains)));
      // Order-independent: the same hosts reversed give the same pick.
      expect(pickBrainHost([...hosts].reverse(), prev, avoid), ctx).toEqual(p);
    }
  });
});

describe("maxBrains, scaleUpPlan and idleStep (pure)", () => {
  it("maxBrains: the cell's setting wins; else per vCPU; never below 1", () => {
    expect(maxBrains(7, 2)).toBe(7);
    expect(maxBrains(0, 2)).toBe(2 * BRAINS_PER_VCPU);
    expect(maxBrains(undefined, 4)).toBe(4 * BRAINS_PER_VCPU);
    expect(maxBrains(undefined, null)).toBe(1);
    expect(maxBrains(undefined, 0)).toBe(1);
    expect(maxBrains(undefined, -3)).toBe(1);
  });

  it("scaleUpPlan: nothing while launching, pending or at the cap; else each type on spot, then the first on demand", () => {
    const s = { instance_types: ["t3a.medium", "t3.medium"], subnet_ids: ["subnet-0a", "subnet-0b"], spot: true, max_hosts: 2 };
    expect(scaleUpPlan(s, 0, 0, true, 0)).toEqual({ launch: null, why: "launching" });
    expect(scaleUpPlan(s, 0, 1, false, 0)).toEqual({ launch: null, why: "pending" });
    expect(scaleUpPlan(s, 2, 0, false, 0)).toEqual({ launch: null, why: "at_max" });
    expect(scaleUpPlan(s, 1, 0, false, 1000)).toEqual({ launch: [
      { type: "t3a.medium", subnet: "subnet-0b", spot: true },
      { type: "t3.medium", subnet: "subnet-0a", spot: true },
      { type: "t3a.medium", subnet: "subnet-0b", spot: false },
    ] });
    expect(scaleUpPlan({ ...s, spot: false }, 0, 0, false, 0)).toEqual({ launch: [{ type: "t3a.medium", subnet: "subnet-0a", spot: false }] });
  });

  it("property: scaleUpPlan launches only below the cap with nothing in flight, always ending on demand, in the cell's subnets", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const types = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => `t${i}.medium`);
      const subnets = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => `subnet-0${i}`);
      const s = { instance_types: types, subnet_ids: subnets, spot: r() < 0.5, max_hosts: 1 + Math.floor(r() * 3) };
      const live = Math.floor(r() * 4);
      const pending = r() < 0.3 ? 1 : 0;
      const launching = r() < 0.2;
      const p = scaleUpPlan(s, live, pending, launching, Math.floor(r() * 1e9));
      const ok = !launching && !pending && live < s.max_hosts;
      expect(p.launch !== null, `seed ${seed}`).toBe(ok);
      if (!p.launch) continue;
      expect(p.launch.at(-1), `seed ${seed}`).toMatchObject({ type: types[0], spot: false });
      expect(p.launch.length, `seed ${seed}`).toBe(s.spot ? types.length + 1 : 1);
      for (const a of p.launch) expect(subnets, `seed ${seed}`).toContain(a.subnet);
    }
  });

  it("idleStep: busy clears, idle starts the clock, the grace retires", () => {
    expect(idleStep(true, 5, 1_000_000, 10)).toBe("busy");
    expect(idleStep(false, null, 100, 10)).toBe("start");
    expect(idleStep(false, 100, 109, 10)).toBe("wait");
    expect(idleStep(false, 100, 110, 10)).toBe("retire");
    expect(idleStep(false, 100, 100, 0)).toBe("retire");
  });
});

describe("the cell's brain section", () => {
  it("parses with its defaults, and an entry without one has none", () => {
    const base = { region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"] };
    expect(awsCell(JSON.stringify({ c: base }), "c")!.brain).toBeUndefined();
    const cfg = awsCell(JSON.stringify({ c: { ...base, brain: { launch_template_id: "lt-0b", instance_types: ["t3a.medium"] } } }), "c")!;
    expect(cfg.brain).toEqual({
      launch_template_id: "lt-0b", instance_types: ["t3a.medium"], spot: true, max_hosts: 1, idle_grace_ms: 1_800_000, max_brains_per_host: 0,
    });
    expect(() => awsCell(JSON.stringify({ c: { ...base, brain: { launch_template_id: "x", instance_types: ["t3a.medium"] } } }), "c")).toThrow();
  });
});

class MockEc2 implements Ec2 {
  terminated: string[] = [];
  launched: LaunchSpec[] = [];
  constructor(private readonly st: InstanceState = "running") {}
  async launch(spec: LaunchSpec) {
    if (spec.instanceType === "none") throw new CapacityError("InsufficientInstanceCapacity");
    this.launched.push(spec);
    return `i-0b${this.launched.length.toString(16).padStart(7, "0")}`;
  }
  async images(): Promise<ImageInfo[]> {
    return [];
  }
  async terminate(id: string) {
    this.terminated.push(id);
  }
  async state() {
    return this.st;
  }
}

const CONFIG: AwsCellConfig = {
  region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"], spot: true,
  max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  brain: { launch_template_id: "lt-0b", instance_types: ["t3a.medium"], spot: true, max_hosts: 1, idle_grace_ms: 1_800_000, max_brains_per_host: 1 },
};

async function configure(cell: string, ec2: MockEc2 | null, cfg: AwsCellConfig | null = CONFIG) {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
    inst.ec2Override = ec2;
    inst.cellConfigOverride = cfg;
  });
}

/** FleetDO's tick, `shiftMs` later as far as the idle clocks go. */
async function tickAt(cell: string, ec2: MockEc2 | null, shiftMs = 0) {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
    inst.ec2Override = ec2;
    inst.cellConfigOverride = CONFIG;
    st.storage.sql.exec("UPDATE hosts SET idle_since = idle_since - ? WHERE idle_since IS NOT NULL", shiftMs);
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDurableObjectAlarm(fleetStub(cell));
}

async function captain(cell: string, start = true) {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-brains" } });
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "brains" } }, 201);
  const res = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "captain", workstream, cell, start: false } }, 201);
  if (start) await agentStub(res.agent).start().catch(() => undefined);
  return res.agent;
}

describe("FleetDO: host kinds", () => {
  it("a sandbox is never placed on a brain host, and an agent_start never goes to a sandbox host", async () => {
    const cell = uniqueCell();
    const brain = await connectHost(cell, "brain");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "kinds" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 202);
    expect(sbx.host ?? null).toBeNull();
    expect(await brain.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "sandbox_create"))).toBe(true);
    const sandboxHost = await connectHost(cell);
    const refused = await fleetStub(cell).issueCommands(sandboxHost.host, [{
      type: "agent_start", agent: "agt_x", role: "captain", workstream, epoch: 1, launch: { builtin_tools: [], system_prompt: { mode: "append" } },
      oauth_token: "ref", session_ws_url: "ws://x",
    } as never]).then(() => "sent", (e: Error) => e.message);
    expect(refused).toMatch(/brains run only on brain hosts/);
  });

  it("brain placement prefers the agent's last brain host while it has room, else the fullest; a full host takes none", async () => {
    const cell = uniqueCell();
    await configure(cell, null, { ...CONFIG, brain: { ...CONFIG.brain!, max_brains_per_host: 2 } });
    const a = await connectHost(cell, "brain");
    const b = await connectHost(cell, "brain");
    const fleet = fleetStub(cell);
    const index = (host: string, agent: string) => runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("INSERT INTO host_agents (agent, host, cmd, epoch, gone, drain_told) VALUES (?, ?, ?, 1, 0, 0)", agent, host, `cmd_${agent}`);
    });
    await index(a.host, "agt_1");
    // The previous host has room: a warm session there.
    expect(await fleet.placeBrain({ prev: b.host })).toBe(b.host);
    // No previous host: the fullest with room.
    expect(await fleet.placeBrain({})).toBe(a.host);
    expect(await fleet.placeBrain({ avoid: a.host })).toBe(b.host);
    // a is full (2 of 2): the previous host's preference yields to room.
    await index(a.host, "agt_2");
    expect(await fleet.placeBrain({ prev: a.host })).toBe(b.host);
    await index(b.host, "agt_3");
    await index(b.host, "agt_4");
    expect(await fleet.placeBrain({})).toBeNull();
    const view = await fleet.fleetView();
    expect(view.hosts.find((h) => h.host === a.host)?.max_brains).toBe(2);
  });

  it("without the cell's setting a brain host holds brains by its vCPUs", async () => {
    const cell = uniqueCell();
    const enrolled = await enrollHost(cell, "brain");
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell, { role: "brain", capacity: { vcpus_free: 1, memory_mib_free: 3000, hugepages_mib_free: 0, sandboxes: 0, agents: 0, warm: [] } }));
    await ws.next("hello_ack");
    const view = await fleetStub(cell).fleetView();
    expect(view.hosts.find((h) => h.host === enrolled.host)?.max_brains).toBe(BRAINS_PER_VCPU);
  });

  it("previous-release role names in stored rows are migrated once", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const b = await connectHost(cell, "brain");
    const roles = await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE hosts SET role = 'burst' WHERE host = ?", a.host);
      st.storage.sql.exec("UPDATE hosts SET role = 'controller' WHERE host = ?", b.host);
      st.storage.sql.exec("INSERT INTO launched (instance_id, launched_ms, role) VALUES ('i-0old', 1, 'controller')");
      st.storage.sql.exec("INSERT INTO enroll_tokens (hash, role, created_ms) VALUES ('h-old', 'burst', 1)");
      return null;
    });
    expect(roles).toBeNull();
    // A new instance of the object (an upgrade's first start) runs the constructor's migration.
    const after = await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
      new (inst.constructor as new (s: unknown, e: unknown) => FleetDO)(st, env);
      return {
        hosts: st.storage.sql.exec<{ host: string; role: string }>("SELECT host, role FROM hosts").toArray(),
        launched: st.storage.sql.exec<{ role: string }>("SELECT role FROM launched WHERE instance_id = 'i-0old'").one().role,
        token: st.storage.sql.exec<{ role: string }>("SELECT role FROM enroll_tokens WHERE hash = 'h-old'").one().role,
      };
    });
    expect(Object.fromEntries(after.hosts.map((h) => [h.host, h.role]))).toEqual({ [a.host]: "sandbox", [b.host]: "brain" });
    expect(after.launched).toBe("brain");
    expect(after.token).toBe("sandbox");
  });
});

describe("brain hosts scale with brains", () => {
  it("a brain no brain host can take launches one from the brain template; the start goes there once it enrolls", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2();
    await configure(cell, ec2);
    // A sandbox host is no help.
    const sandboxHost = await connectHost(cell);
    const agent = await captain(cell);
    expect(ec2.launched).toEqual([expect.objectContaining({ launchTemplateId: "lt-0b", instanceType: "t3a.medium", spot: true, subnetId: "subnet-0a" })]);
    expect(await agentStub(agent).info()).toMatchObject({ brain: null, intent: { reason: "operator" } });
    expect(await sandboxHost.ws.none("commands", 100, (m) => (m.commands as any[]).some(isStartOf(agent)))).toBe(true);
    // Waiting for the launch: no second one.
    await configure(cell, ec2);
    await agentStub(agent).start().catch(() => undefined);
    expect(ec2.launched).toHaveLength(1);
    // The instance may enroll only as a brain host (the launch record), and gets no proxy CA.
    const csr = await csrPem();
    const enroll = (role: "sandbox" | "brain") => runInDurableObject(fleetStub(cell), (inst: FleetDO) =>
      inst.enroll({
        protocol_version: 1, role, cell, proof: { type: "aws_identity_document", document_b64: "", pkcs7_b64: "" },
        ...(role === "sandbox" ? { proxy_ca_csr_pem: csr } : {}),
      } as never,
        cell, { instanceId: "i-0b0000001", accountId: "123456789012", region: "us-east-1" } as never));
    await expect(Promise.resolve().then(() => enroll("sandbox"))).rejects.toThrow(/launched as brain/);
    const enrolled = await enroll("brain");
    expect(enrolled.proxy_ca).toBeUndefined();
    expect(enrolled.tunnel_token).toBeUndefined();
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell, { role: "brain" }));
    await ws.next("hello_ack");
    expect(await agentStub(agent).start()).toMatchObject({ kind: "started", host: enrolled.host });
    const [start] = await nextCommands(ws, isStartOf(agent));
    await okResult(ws, start.cmd);

    // Holding a brain: never retired, however long.
    await tickAt(cell, ec2, 7_200_000);
    await tickAt(cell, ec2, 7_200_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");
    // Its brain exits: idle from then, retired at the brain grace (30 min), not the sandbox one (1 min).
    const seq = sendEvents(ws, [{ ts_ms: Date.now(), type: "agent_exited", agent, reason: "idle", epoch: start.epoch }]);
    await ws.next("ack", (m) => m.up_to >= seq);
    await tickAt(cell, ec2);
    await tickAt(cell, ec2, 120_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");
    await tickAt(cell, ec2, 1_700_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("dead");
    expect(ec2.terminated).toContain("i-0b0000001");
    const view = await fleetStub(cell).fleetView();
    expect(view.launches.find((l) => l.instance_id === "i-0b0000001")).toMatchObject({ reason: "idle" });
  });

  it("a cell without a brain section launches no brain host; the start waits", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2();
    await configure(cell, ec2, { ...CONFIG, brain: undefined });
    const agent = await captain(cell);
    expect(ec2.launched).toEqual([]);
    expect(await agentStub(agent).info()).toMatchObject({ brain: null, intent: { reason: "operator" } });
  });
});

describe("AgentDO: where a brain starts", () => {
  it("a worker's brain starts on a brain host, not its sandbox's, and again on the same brain host when it has room", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-brains" } });
    const sandboxHost = await connectHost(cell);
    const a = await connectHost(cell, "brain");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "where" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(sandboxHost.ws, (c) => c.type === "sandbox_create");
    const worker = (await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell } }, 201)).agent;
    const [start] = await nextCommands(a.ws, isStartOf(worker));
    await okResult(a.ws, start.cmd);
    expect(await sandboxHost.ws.none("commands", 100, (m) => (m.commands as any[]).some(isStartOf(worker)))).toBe(true);
    // A second, fuller brain host appears; the brain exits; its next start goes back to a (warm session).
    const b = await connectHost(cell, "brain");
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO host_agents (agent, host, cmd, epoch, gone, drain_told) VALUES ('agt_other', ?, 'cmd_o', 1, 0, 0)", b.host);
    });
    const seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: worker, reason: "idle", epoch: start.epoch }]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect(await agentStub(worker).start()).toMatchObject({ kind: "started", host: a.host });
  });
});
