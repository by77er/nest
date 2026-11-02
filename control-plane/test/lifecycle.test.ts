// The lease as the one authority for who holds a sandbox (docs/control-plane/durable-objects/fleet/,
// docs/control-plane/durable-objects/sandbox/): fences never strand a sandbox, an unfinished
// placement is reconciled against the lease, a host under STONITH stays so until it is proven safe,
// stale incarnations are destroyed on their old host after salvage, and preview and share names
// follow the hostname rule. Event orders are the ones nestd produces (crates/nestd/src/host.rs:
// `fence_sandbox` emits `sandbox_state{fenced}` before the fence command's result).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FleetDO } from "../src/do/fleet";
import { portHostname, type SandboxDO } from "../src/do/sandbox";
import type { Ec2, InstanceState } from "../src/lib/ec2";
import { adminJson, connectHost, enrollHost, hostHello, nextCommands, okResult, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const GUEST = { protocol_version: 1, capabilities: [] };

async function createSandbox(cell: string, status = 201) {
  const { workstream } = await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "lifecycle" } }, 201);
  return adminJson<{ sandbox: string; host: string | null; workstream: string }>("/v1/sandboxes", { body: { workstream, cell } }, status);
}

async function events(ws: Ws, evs: unknown[], at?: number) {
  const seq = sendEvents(ws, evs.map((e) => ({ ts_ms: Date.now(), ...(e as object) })), at);
  await ws.next("ack", (m) => m.up_to >= seq);
}

/** Run FleetDO's tick now with `host` silent past the CP expiry (and EC2 as given). */
async function expireNow(cell: string, host: string, ec2: Ec2 | null) {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
    inst.ec2Override = ec2;
    st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, host);
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDurableObjectAlarm(fleetStub(cell));
}

async function tick(cell: string, ec2: Ec2 | null) {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
    inst.ec2Override = ec2;
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDurableObjectAlarm(fleetStub(cell));
}

/** A sandbox host whose hello reports this much hugepage room (placement prefers the fullest host). */
async function hostWithRoom(cell: string, hugepagesFree: number) {
  const enrolled = await enrollHost(cell, "sandbox");
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, { capacity: { vcpus_free: 8, memory_mib_free: 16384, hugepages_mib_free: hugepagesFree, hugepages_mib_total: 8192, sandboxes: 0, agents: 0, warm: [] } }));
  await ws.next("hello_ack");
  return { ...enrolled, ws };
}

class Ec2States implements Ec2 {
  terminated: string[] = [];
  constructor(public state_: InstanceState) {}
  async launch(): Promise<string> {
    throw new Error("no launches here");
  }
  async terminate(id: string) {
    this.terminated.push(id);
  }
  async state() {
    return this.state_;
  }
  async images() {
    return [];
  }
}

describe("fences never strand a sandbox", () => {
  it("STONITH by fence in nestd's order (fenced state, then the fence's ok) re-places under the next epoch", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "running", guest: GUEST }]);
    a.ws.close();
    await expireNow(cell, a.host, null);

    // The host comes back before it self-fenced; FleetDO asks it to fence first.
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell, { sandboxes: [{ sandbox: sbx.sandbox, epoch: 1, state: "running", dirty: true }] }));
    // The same nestd process: its event lineage continues where FleetDO's ack left it.
    const ack = await ws.next("hello_ack");
    await events(ws, [], ack.last_event_seq + 1);
    // (The running report it can't honor draws a `reconcile` fence too; the STONITH one is `lease expired`.)
    const fence = (await nextCommands(ws, (c) => c.type === "fence" && c.reason === "lease expired")).find((c) => c.reason === "lease expired");
    // nestd fences at once and reports it, then answers the command.
    await events(ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "fenced", detail: "lease expired" }]);
    // The lease (expired) is not held, so its report is not the sandbox's state: the lease rules.
    expect((await sandboxStub(sbx.sandbox).info()).state).toBe("running");
    await okResult(ws, fence.cmd);

    const [recreate] = await nextCommands(ws, (c) => c.type === "sandbox_create");
    expect(recreate).toMatchObject({ sandbox: sbx.sandbox, epoch: 2 });
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: a.host, state: "creating" });
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: a.host, epoch: 2, expired: false });
  });

  it("a holder that fenced the sandbox itself (its host lease lapsed) gets it placed again", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "fenced", detail: "host lease lapsed" }]);
    const [recreate] = await nextCommands(a.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    expect(recreate.sandbox).toBe(sbx.sandbox);
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: a.host });
  });
});

describe("an unfinished placement is reconciled against the lease", () => {
  /** Leave SandboxDO as a placement cut off after FleetDO granted (or not) the lease: `placing` set, no host. */
  async function cutOff(sandbox: string, epoch: number, staleMs = 61_000) {
    await runInDurableObject(sandboxStub(sandbox), (_i, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one();
      const info = JSON.parse(row.value);
      Object.assign(info, { epoch, placing: epoch, placing_ms: Date.now() - staleMs, host: null });
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('place', 0)");
    });
  }

  it("the place alarm adopts the lease FleetDO granted, with the state and guest its holder reported", async () => {
    const cell = uniqueCell();
    const unplaced = await createSandbox(cell, 202); // no host yet: epoch 0, nothing leased
    const a = await connectHost(cell);
    const req = {
      sandbox: unplaced.sandbox, workstream: unplaced.workstream, epoch: 1, image: "nest-base:latest",
      resources: { vcpus: 2, memory_mib: 4096, disk_gib: 32 }, policy: await sandboxStub(unplaced.sandbox).policy(),
    };
    expect(await fleetStub(cell).place(req)).toBe(a.host);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create" && c.epoch === 1);
    // A retry of the same placement (its answer was lost) gets the lease back; nothing is sent again.
    expect(await fleetStub(cell).place(req)).toBe(a.host);
    expect(await a.ws.none("commands", 200)).toBe(true);
    await cutOff(unplaced.sandbox, 1);
    // The VM boots; SandboxDO, not knowing its host, can't take the report itself.
    await events(a.ws, [{ type: "sandbox_state", sandbox: unplaced.sandbox, epoch: 1, state: "running", guest: GUEST }]);
    expect((await sandboxStub(unplaced.sandbox).info()).host).toBeNull();

    await runDurableObjectAlarm(sandboxStub(unplaced.sandbox));
    const info = await sandboxStub(unplaced.sandbox).info();
    expect(info).toMatchObject({ host: a.host, epoch: 1, state: "running", placing: null, guest: GUEST });
    // Running and placed: the idle countdown is armed, so it suspends (and stops billing) when idle.
    const idle = await runInDurableObject(sandboxStub(unplaced.sandbox), (_i, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'idle'").toArray().length);
    expect(idle).toBe(1);
  });

  it("wake clears a marker with no lease behind it and places the sandbox", async () => {
    const cell = uniqueCell();
    const unplaced = await createSandbox(cell, 202);
    const a = await connectHost(cell);
    await cutOff(unplaced.sandbox, 1);
    expect((await sandboxStub(unplaced.sandbox).wake()).host).toBe(a.host);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    expect(create).toMatchObject({ sandbox: unplaced.sandbox, epoch: 2 });
  });

  it("a placement whose answer is lost keeps its marker and deadline; the alarm reconciles it later", async () => {
    const cell = uniqueCell();
    const unplaced = await createSandbox(cell, 202);
    const a = await connectHost(cell);
    const stub = sandboxStub(unplaced.sandbox);
    const failed = await runInDurableObject(stub, async (inst: SandboxDO, st) => {
      const real = (inst as unknown as { fleet: (cell: string) => unknown }).fleet;
      (inst as unknown as { fleet: unknown }).fleet = () => ({ place: async () => { throw new Error("Network connection lost."); } });
      const err = await inst.placeCurrentEpoch().then(() => null, (e: Error) => e.message);
      (inst as unknown as { fleet: unknown }).fleet = real;
      return { err, deadline: st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'place'").toArray().length };
    });
    expect(failed).toEqual({ err: "Network connection lost.", deadline: 1 });
    expect(await stub.info()).toMatchObject({ placing: 1, host: null });
    // Not stale yet: the alarm only re-arms itself.
    await runInDurableObject(stub, (_i, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'"));
    await runDurableObjectAlarm(stub);
    expect(await stub.info()).toMatchObject({ placing: 1, host: null });
    // Stale, and FleetDO never leased it: cleared, then placed.
    await cutOff(unplaced.sandbox, 1);
    await runDurableObjectAlarm(stub);
    expect(await stub.info()).toMatchObject({ placing: null, host: a.host, epoch: 2 });
  });
});

describe("STONITH is not undone by a hello", () => {
  it("a host that reconnects while being terminated stays stonith_pending; EC2's confirmation reassigns its sandboxes", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const ec2 = new Ec2States("running");
    await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0hostA' WHERE host = ?", a.host);
    });
    a.ws.close();
    const b = await connectHost(cell);
    await expireNow(cell, a.host, ec2);
    expect(ec2.terminated).toContain("i-0hostA");

    // The host reconnects before EC2 reports it shutting down.
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell));
    await ws.next("hello_ack");
    expect((await fleetStub(cell).hostStatus(a.host))!.status).toBe("stonith_pending");

    // The instance dies before the fence's result arrives: the next tick still polls it.
    ec2.state_ = "terminated";
    await tick(cell, ec2);
    expect((await fleetStub(cell).hostStatus(a.host))!.status).toBe("dead");
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
  });
});

/** SandboxDO runs FleetDO's next `count` leaseLost calls, but FleetDO never hears the answers. */
async function loseLeaseLostAnswers(cell: string, count: number) {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
    const real = (inst as any).sandbox.bind(inst);
    (inst as any).sandbox = (id: string) => new Proxy(real(id), {
      get: (stub, prop) => prop !== "leaseLost" ? Reflect.get(stub, prop) : async (...args: unknown[]) => {
        const r = await stub.leaseLost(...args);
        if (count-- > 0) throw new Error("answer lost");
        return r;
      },
    });
  });
}

describe("every lost lease is reassigned, however its losses overlap", () => {
  it("reassignments an earlier release queued are moved over and worked", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const b = await connectHost(cell);
    a.ws.close();
    const moved = await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE hosts SET status = 'dead', dead_ms = 1 WHERE host = ?", a.host);
      st.storage.sql.exec("INSERT INTO reassign_queue (sandbox, host, epoch, host_dead) VALUES (?, ?, 1, 1)", sbx.sandbox, a.host);
      new FleetDO(st, env); // the migrations run in the constructor
      return {
        old: st.storage.sql.exec("SELECT 1 FROM reassign_queue").toArray().length,
        now: st.storage.sql.exec("SELECT sandbox, host, epoch FROM reassignments").toArray(),
      };
    });
    expect(moved).toEqual({ old: 0, now: [{ sandbox: sbx.sandbox, host: a.host, epoch: 1 }] });
    await tick(cell, null);
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
  });

  it("an older loss still retrying never stands in for the fence of a newer lease (B-4, O1)", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const b = await connectHost(cell);
    await loseLeaseLostAnswers(cell, 100);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
    await nextCommands(b.ws, (c) => c.type === "sandbox_create");
    // The new holder goes silent and comes back: it must fence its expired lease first.
    await expireNow(cell, b.host, null);
    const ws = await Ws.connect("/v1/fleet", b.host_token);
    ws.send(hostHello(b.host, cell, { sandboxes: [{ sandbox: sbx.sandbox, epoch: 2, state: "fenced", dirty: false }] }));
    await ws.next("hello_ack");
    const fence = await nextCommands(ws, (c) => c.type === "fence" && c.reason === "lease expired");
    expect(fence.find((c) => c.type === "fence")!.sandboxes).toEqual([sbx.sandbox]);
  });


  it("a loss at a newer epoch is queued while an older loss of the same sandbox is still retrying (B-4, L2)", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const others = [await connectHost(cell), await connectHost(cell)];
    // SandboxDO takes the first reassignment, but its answer is lost: FleetDO keeps the row and retries.
    await loseLeaseLostAnswers(cell, 1);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    const second = await sandboxStub(sbx.sandbox).info();
    expect(second.epoch).toBe(2);
    // Its new holder dies before the tick retries the first row.
    const holder = others.find((h) => h.host === second.host)!;
    holder.ws.close();
    await adminJson(`/v1/admin/hosts/${holder.host}/confirm-dead?cell=${cell}`, { body: {} });
    const last = others.find((h) => h !== holder)!;
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 3, host: last.host });
  });
});

describe("a host FleetDO is terminating never serves again", () => {
  it("its fence ok re-places its sandboxes elsewhere but leaves it stonith_pending until EC2 says terminated, not shutting-down (B-2)", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "running", guest: GUEST }]);
    const ec2 = new Ec2States("running");
    await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0hostA' WHERE host = ?", a.host);
    });
    a.ws.close();
    const b = await connectHost(cell);
    await expireNow(cell, a.host, ec2);
    expect(ec2.terminated).toContain("i-0hostA");

    // A partition heals before the instance stops: the host says hello and fences when asked.
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell, { sandboxes: [{ sandbox: sbx.sandbox, epoch: 1, state: "fenced", dirty: false }] }));
    const ack = await ws.next("hello_ack");
    await events(ws, [], ack.last_event_seq + 1);
    const fence = (await nextCommands(ws, (c) => c.type === "fence" && c.reason === "lease expired")).find((c) => c.reason === "lease expired");
    await okResult(ws, fence.cmd);

    // The fence covers the lease, so the sandbox moves; but not back onto the instance being terminated.
    expect((await fleetStub(cell).hostStatus(a.host))!.status).toBe("stonith_pending");
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
    // Shutting down is not proof (its VMs may still run): polled again until EC2 says terminated.
    ec2.state_ = "shutting-down";
    await tick(cell, ec2);
    expect((await fleetStub(cell).hostStatus(a.host))!.status).toBe("stonith_pending");
    ec2.state_ = "terminated";
    await tick(cell, ec2);
    expect((await fleetStub(cell).hostStatus(a.host))!.status).toBe("dead");
  });
});

describe("stale incarnations are destroyed on their old host", () => {
  /** A sandbox on `a` (epoch 1) that moved to the fuller host `b` (epoch 2) after `a` fenced it. */
  async function moved() {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const b = await hostWithRoom(cell, 4096); // less room left than `a`: packing prefers it
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "fenced", detail: "host lease lapsed" }]);
    await nextCommands(b.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: b.host, epoch: 2 });
    return { cell, a, b, sbx };
  }

  async function rehello(cell: string, a: { host: string; host_token: string }, sandbox: string, dirty: boolean) {
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell, { sandboxes: [{ sandbox, epoch: 1, state: "fenced", dirty }] }));
    await ws.next("hello_ack");
    return ws;
  }

  it("a clean one (salvaged, or never dirty) is destroyed at its old epoch, once", async () => {
    const { cell, a, sbx } = await moved();
    const ws = await rehello(cell, a, sbx.sandbox, false);
    const [destroy] = await nextCommands(ws, (c) => c.type === "sandbox_destroy");
    expect(destroy).toMatchObject({ sandbox: sbx.sandbox, epoch: 1 });
    // Reported again: nothing more is sent.
    const ws2 = await rehello(cell, a, sbx.sandbox, false);
    expect(await ws2.none("commands", 200, (m) => m.commands.some((c: { type: string }) => c.type === "sandbox_destroy"))).toBe(true);
  });

  it("a dirty one waits out its salvage window, then is destroyed", async () => {
    const { cell, a, sbx } = await moved();
    const ws = await rehello(cell, a, sbx.sandbox, true);
    expect(await ws.none("commands", 200, (m) => m.commands.some((c: { type: string }) => c.type === "sandbox_destroy"))).toBe(true);
    // nestd gives a salvage 600 s; FleetDO waits 11 min from when it first saw the incarnation.
    await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE stale_incarnations SET first_seen_ms = first_seen_ms - ?", 11 * 60_000 + 1_000);
    });
    await tick(cell, null);
    const [destroy] = await nextCommands(ws, (c) => c.type === "sandbox_destroy");
    expect(destroy).toMatchObject({ sandbox: sbx.sandbox, epoch: 1 });
  });
});

describe("a retired incarnation (incarnation_retired)", () => {
  it("is destroyed at its old epoch without waiting out the salvage window", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const b = await hostWithRoom(cell, 4096);
    // nestd fences it (dirty), the sandbox moves on, then nestd's salvage lands and it says so.
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "fenced", detail: "host lease lapsed" }]);
    await nextCommands(b.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    expect(await a.ws.none("commands", 200, (m) => m.commands.some((c: { type: string }) => c.type === "sandbox_destroy"))).toBe(true);
    await events(a.ws, [{ type: "incarnation_retired", sandbox: sbx.sandbox, epoch: 1 }]);
    const [destroy] = await nextCommands(a.ws, (c) => c.type === "sandbox_destroy");
    expect(destroy).toMatchObject({ sandbox: sbx.sandbox, epoch: 1 });
    // The clean report changed nothing else: the sandbox stays where it moved.
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: b.host, epoch: 2 });
  });
});

describe("preview and share names follow the hostname rule", () => {
  it("first-level labels of the zone, kind as suffix, no underscore (docs/setup/#hostnames)", () => {
    expect(portHostname("preview", "nest.bitcru.sh", 3000, "sbx_01jb7m2a4c")).toBe("3000-01jb7m2a4c-preview-nest.bitcru.sh");
    expect(portHostname("share", "nest.bitcru.sh", 3000, "sbx_01jb7m2a4c")).toBe("3000-01jb7m2a4c-share-nest.bitcru.sh");
  });

  it("a preview URL stored under the old naming is recomputed on read", async () => {
    const cell = uniqueCell();
    const sbx = await createSandbox(cell, 202);
    await runInDurableObject(sandboxStub(sbx.sandbox), (_i, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one();
      const info = JSON.parse(row.value);
      info.ports = [{ port: 5173, url: `https://5173-${sbx.sandbox}.preview.nest.bitcru.sh` }];
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    expect((await sandboxStub(sbx.sandbox).info()).ports).toEqual([
      { port: 5173, url: `https://5173-${sbx.sandbox.slice("sbx_".length)}-preview-nest.localhost` },
    ]);
  });
});

/**
 * Hold this SandboxDO's next call of FleetDO's `method` open until `open()`: `served` lets FleetDO run
 * it first (a slow answer), otherwise the request itself waits (a slow request). Real SandboxDO and
 * FleetDO code; only the await's timing is controlled (miniflare answers too fast to interleave).
 * Holds stack: each wraps the stub the previous one returns.
 */
/**
 * Hold SandboxDO's next `method` call to FleetDO until `open()`: its request (`served` false) or its answer
 * (`served` true). `reached` resolves once it is held there.
 */
function holdFleet(inst: SandboxDO, method: "place" | "releaseLease", served: boolean): { open: () => void; reached: Promise<void> } {
  const self = inst as unknown as { fleet: (cell: string) => any };
  const real = self.fleet.bind(inst);
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let reach!: () => void;
  const reached = new Promise<void>((r) => (reach = r));
  let held = false;
  self.fleet = (c: string) => {
    const f = real(c);
    return new Proxy(f, {
      get(t, p: string | symbol) {
        if (p === "then") return undefined;
        if (p === method && !held) {
          held = true;
          return async (...args: unknown[]) => {
            if (served) { const r = await t[p](...args); reach(); await gate; return r; }
            reach();
            await gate;
            return t[p](...args);
          };
        }
        return (...args: unknown[]) => t[p](...args);
      },
    });
  };
  return { open, reached };
}

describe("the lease's guards (docs/verification/sandbox-lease)", () => {
  it("a lost lease keeps which agents are working: the re-placed sandbox isn't idle-suspended mid-turn", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "running", guest: GUEST }]);
    const stub = sandboxStub(sbx.sandbox);
    await stub.attach("agt_x");
    await stub.agentActivity("agt_x", true);
    // The brain runs on a brain host, untouched by the sandbox host's loss: AgentDO re-sends activity only on a change.
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "fenced", detail: "host lease lapsed" }]);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    await events(a.ws, [{ type: "sandbox_state", sandbox: sbx.sandbox, epoch: 2, state: "running", guest: GUEST }]);
    expect((await stub.info()).working).toEqual(["agt_x"]);
    expect(await runInDurableObject(stub, (_i, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'idle'").toArray().length)).toBe(0);
  });

  it("a fenced sandbox that found no host is placed by its alarm once one has room", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell); // room for two default sandboxes
    const s1 = await createSandbox(cell);
    const s2 = await createSandbox(cell);
    await events(a.ws, [
      { type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
      { type: "capacity", capacity: { vcpus_free: 4, memory_mib_free: 8192, hugepages_mib_free: 0, hugepages_mib_total: 8192, sandboxes: 2, agents: 0, warm: [] } },
    ]);
    await events(a.ws, [{ type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "fenced" }]);
    const stub = sandboxStub(s1.sandbox);
    expect(await stub.info()).toMatchObject({ state: "fenced", host: null });
    const b = await hostWithRoom(cell, 8192);
    await runInDurableObject(stub, (_i, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'"));
    await runDurableObjectAlarm(stub);
    expect((await stub.info()).host).toBe(b.host);
  });

  for (const served of [true, false]) {
    it(`a destroy during an in-flight placement stays destroyed, with no lease or VM left (${served ? "answer" : "request"} held)`, async () => {
      const cell = uniqueCell();
      const s = await createSandbox(cell, 202);
      const a = await connectHost(cell);
      const stub = sandboxStub(s.sandbox);
      await runInDurableObject(stub, async (inst: SandboxDO) => {
        const { open, reached } = holdFleet(inst, "place", served);
        const woke = inst.wake().catch((e: unknown) => e);
        await reached;
        await inst.destroy();
        open();
        await woke;
      });
      expect(await stub.info()).toMatchObject({ state: "destroyed", host: null, placing: null });
      expect(await fleetStub(cell).leaseOf(s.sandbox)).toBeNull();
      if (served) {
        // FleetDO sent the VM's create with the grant: it is destroyed again at that epoch.
        const [destroy] = await nextCommands(a.ws, (c) => c.type === "sandbox_destroy");
        expect(destroy).toMatchObject({ sandbox: s.sandbox, epoch: 1 });
      } else {
        // FleetDO knew of the destroy first and granted nothing: nothing was left for a continuation
        // to undo (one a reset loses would have leaked the lease and the VM).
        await sleep(100);
        const sent = a.ws.drain().filter((m) => m.type === "commands").flatMap((m) => m.commands as { type: string }[]);
        expect(sent.filter((c) => c.type === "sandbox_create")).toEqual([]);
      }
    });
  }

  it("a placement that reaches FleetDO while destroy releases the lease grants nothing: FleetDO knew of the destroy first", async () => {
    const cell = uniqueCell();
    const s = await createSandbox(cell, 202);
    const a = await connectHost(cell);
    const stub = sandboxStub(s.sandbox);
    await runInDurableObject(stub, async (inst: SandboxDO) => {
      const place = holdFleet(inst, "place", false);
      const release = holdFleet(inst, "releaseLease", true);
      const woke = inst.wake().catch((e: unknown) => e);
      await place.reached;
      // destroy's releaseLease runs at FleetDO; its answer waits while the placement lands.
      const destroying = inst.destroy();
      await release.reached;
      place.open();
      await woke;
      release.open();
      await destroying;
    });
    expect(await stub.info()).toMatchObject({ state: "destroyed", host: null, placing: null });
    expect(await fleetStub(cell).leaseOf(s.sandbox)).toBeNull();
    await sleep(100);
    const sent = a.ws.drain().filter((m) => m.type === "commands").flatMap((m) => m.commands as { type: string }[]);
    expect(sent.filter((c) => c.type === "sandbox_create")).toEqual([]);
  });

  it("a placement answer that arrives after the marker was reconciled changes nothing: confirmed slots stay confirmed", async () => {
    const cell = uniqueCell();
    const s = await createSandbox(cell, 202);
    const a = await connectHost(cell);
    const stub = sandboxStub(s.sandbox);
    const after = await runInDurableObject(stub, async (inst: SandboxDO, st) => {
      const { open, reached } = holdFleet(inst, "place", true);
      const late = inst.wake();
      await reached; // FleetDO granted epoch 1; the answer is held
      // The answer is slower than PLACING_STALE_MS: the next wake reconciles and adopts the lease.
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one();
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...JSON.parse(row.value), placing_ms: Date.now() - 61_000 }));
      const adopted = (await inst.wake()).host;
      await inst.attach("agt_x");
      const cmd = (await inst.info()).attach_inflight["agt_x"]!;
      await inst.attachResult(adopted!, 1, "agt_x", cmd, { status: "ok" });
      open();
      await late;
      return { adopted, info: await inst.info() };
    });
    expect(after.adopted).toBe(a.host);
    expect(after.info).toMatchObject({ host: a.host, epoch: 1, attach_pending: [], attach_inflight: {} });
    // One agent_attach in all: the late answer re-sent none.
    await sleep(200);
    const sent = a.ws.drain().filter((m) => m.type === "commands").flatMap((m) => m.commands as { type: string }[]);
    expect(sent.filter((c) => c.type === "agent_attach")).toHaveLength(1);
  });

  it("a create whose placement answer is unknown returns the sandbox; its place deadline finishes the job", async () => {
    const id = `sbx_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const cell = uniqueCell();
    const created = await runInDurableObject(sandboxStub(id), async (inst: SandboxDO, st) => {
      const self = inst as unknown as { fleet: (cell: string) => any };
      const real = self.fleet.bind(inst);
      self.fleet = (c: string) => ({ ...real(c), registerSandbox: (x: string) => real(c).registerSandbox(x), place: async () => { throw new Error("Network connection lost."); } });
      const info = await inst.create({ sandbox: id, workstream: "ws_lifecycle", cell }).catch((e: Error) => e.message);
      return { info, deadline: st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'place'").toArray().length };
    });
    // A 500 here would make a client retry the POST, and the retry mints a second sandbox.
    expect(created).toMatchObject({ info: { sandbox: id, placing: 1, host: null }, deadline: 1 });
  });
});
