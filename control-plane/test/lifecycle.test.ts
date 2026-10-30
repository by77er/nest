// The lease as the one authority for who holds a sandbox (docs/control-plane/durable-objects/fleet/,
// docs/control-plane/durable-objects/sandbox/): fences never strand a sandbox, an unfinished
// placement is reconciled against the lease, a host under STONITH stays so until it is proven safe,
// stale incarnations are destroyed on their old host after salvage, and preview and share names
// follow the hostname rule. Event orders are the ones nestd produces (crates/nestd/src/host.rs:
// `fence_sandbox` emits `sandbox_state{fenced}` before the fence command's result).
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { previewHostname, shareHostname, type SandboxDO } from "../src/do/sandbox";
import type { Ec2, InstanceState } from "../src/lib/ec2";
import { adminJson, connectHost, enrollHost, hostHello, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

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
    expect(previewHostname("nest.bitcru.sh", 3000, "sbx_01jb7m2a4c")).toBe("3000-01jb7m2a4c-preview-nest.bitcru.sh");
    expect(shareHostname("nest.bitcru.sh", 3000, "sbx_01jb7m2a4c")).toBe("3000-01jb7m2a4c-share-nest.bitcru.sh");
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
