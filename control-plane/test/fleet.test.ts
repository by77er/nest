import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { CapacityError, type Ec2, type InstanceState, type LaunchSpec, type ImageInfo } from "../src/lib/ec2";
import type { AwsCellConfig } from "../src/lib/cells";
import { adminJson, connectHost, hostHello, manifest, nextCommands, okResult, runDue, sendEvents, uniqueCell, Ws } from "./helpers";

async function workstream(goal = "test") {
  return adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal } }, 201);
}

async function createSandbox(cell: string, status = 201) {
  const ws = await workstream();
  const info = await adminJson<{ sandbox: string; epoch: number; host: string; workstream: string }>(
    `/v1/sandboxes`, { body: { workstream: ws.workstream, cell } }, status);
  return info;
}

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));

/** Make FleetDO's lease check run now with `host` looking silent for longer than the CP expiry. */
async function expireNow(cell: string, host: string) {
  await runInDurableObject(fleetStub(cell), (_inst: FleetDO, state) => {
    state.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, host);
    state.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDue(fleetStub(cell));
}

describe("fleet channel", () => {
  it("creates a sandbox: sandbox_create grants epoch 1, results and states flow back", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    expect(sbx.host).toBe(h.host);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    expect(create).toMatchObject({ type: "sandbox_create", sandbox: sbx.sandbox, epoch: 1 });
    expect(create.policy.allow.some((r: any) => r.host === "github.com" && r.layer === "base")).toBe(true);

    await okResult(h.ws, create.cmd);
    expect(await fleetStub(cell).commandResult(create.cmd)).toEqual({ status: "ok" });
    const seq = sendEvents(h.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "running" }]);
    await h.ws.next("ack", (m) => m.up_to >= seq);
    expect((await sandboxStub(sbx.sandbox).info()).state).toBe("running");

    // A state report with a stale epoch is ignored.
    const seq2 = sendEvents(h.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: sbx.sandbox, epoch: 7, state: "failed" }]);
    await h.ws.next("ack", (m) => m.up_to >= seq2);
    expect((await sandboxStub(sbx.sandbox).info()).state).toBe("running");
  });

  it("deduplicates event batches by seq and keeps exactly one command result", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const err = { ts_ms: Date.now(), type: "command_result", cmd: create.cmd, outcome: { status: "error", error: { code: "internal", message: "boom", retryable: false } } };
    const seq = sendEvents(h.ws, [err]);
    await h.ws.next("ack", (m) => m.up_to === seq);
    sendEvents(h.ws, [err], seq); // redelivery of the same batch
    await h.ws.next("ack", (m) => m.up_to === seq);
    await okResult(h.ws, create.cmd); // a second, different result for the same command is ignored
    expect(await fleetStub(cell).commandResult(create.cmd)).toMatchObject({ status: "error" });
    expect((await sandboxStub(sbx.sandbox).info()).state).toBe("failed");
  });

  it("resends unacked commands after reconnect, starting after last_command_seq", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    const first = await h.ws.next("commands");
    h.ws.close();
    // Issued while the host is offline.
    await fleetStub(cell).issueCommands(h.host, [{ type: "sandbox_checkpoint", sandbox: sbx.sandbox, epoch: 1, reason: "checkpoint" }]);
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { last_command_seq: first.seq }));
    await ws2.next("hello_ack");
    const resent = await ws2.next("commands");
    expect(resent.seq).toBe(first.seq + 1);
    expect(resent.commands[0].type).toBe("sandbox_checkpoint");
    expect(await ws2.none("commands", 100, (m) => m.seq === first.seq)).toBe(true);
  });

  it("a new nestd process (new instance_id) resets both lineages and fails unacked commands", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    const first = await h.ws.next("commands");
    sendEvents(h.ws, [], 41); // the old process's event lineage reached 41
    await h.ws.next("ack", (m) => m.up_to === 41);
    h.ws.close();
    // Issued while the host is offline; the restarted process never sees it.
    const [ckpt] = await fleetStub(cell).issueCommands(h.host, [{ type: "sandbox_checkpoint", sandbox: sbx.sandbox, epoch: 1, reason: "checkpoint" }]);
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    // It reports the sandbox (so it isn't re-placed): this test is about the lineages.
    ws2.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002", sandboxes: [{ sandbox: sbx.sandbox, epoch: 1, state: "running", dirty: false }] }));
    const ack = await ws2.next("hello_ack");
    expect(ack.last_event_seq).toBeUndefined(); // the event lineage restarted
    expect(await ws2.none("commands", 150, (m) => m.seq <= first.seq + 1)).toBe(true);
    expect(await fleetStub(cell).commandResult(ckpt!)).toMatchObject({ status: "error", error: { retryable: true } });
    // The new process's events start at 1 and are not dropped as duplicates.
    sendEvents(ws2, [], 1);
    expect((await ws2.next("ack")).up_to).toBe(1);
  });

  it("relays guest nest CLI commands to the attributed agent and answers with guest_cli_result", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
    const h = await connectHost(cell);
    const brain = await connectHost(cell, "brain");
    const sbx = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const worker = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", workstream: sbx.workstream, sandbox: sbx.sandbox, cell } }, 201);
    await nextCommands(brain.ws, (c) => c.type === "agent_start");
    const base = { ts_ms: Date.now(), sandbox: sbx.sandbox, epoch: 1, agent: worker.agent };
    sendEvents(h.ws, [
      { ...base, type: "guest_cli", request: "req_cli1", command: { command: "emit", event: "progress", payload: { summary: "half done" } } },
      { ...base, type: "guest_cli", request: "req_cli2", command: { command: "notify", to: "nobody", message: "x", urgency: "normal" } },
    ], 7);
    const results = [
      ...(await nextCommands(h.ws, (c) => c.type === "guest_cli_result")),
      ...(await nextCommands(h.ws, (c) => c.type === "guest_cli_result")),
    ];
    const byReq = Object.fromEntries(results.map((c) => [c.request, c.result]));
    expect(byReq["req_cli1"]).toMatchObject({ status: "ok" });
    expect(byReq["req_cli2"]).toMatchObject({ status: "error", error: { code: "invalid_message" } });
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(sbx.workstream)).events();
    expect(events.some((e) => e.type === "progress" && (e as { summary: string }).summary === "half done")).toBe(true);
  });

  it("heartbeats renew leases and revoke claims the control plane doesn't honor", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    h.ws.send({ type: "heartbeat", sent_ms: 123, leases: [{ sandbox: sbx.sandbox, epoch: 1 }, { sandbox: "sbx_unknown", epoch: 3 }, { sandbox: sbx.sandbox, epoch: 9 }] });
    const ack = await h.ws.next("heartbeat_ack");
    expect(ack.sent_ms).toBe(123);
    expect(ack.revoked).toEqual([{ sandbox: "sbx_unknown", epoch: 3 }, { sandbox: sbx.sandbox, epoch: 9 }]);
  });

  it("reconciles a reconnecting host's report: unhonored sandboxes are fenced", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { sandboxes: [{ sandbox: "sbx_ghost", epoch: 2, state: "running", dirty: true }] }));
    await ws2.next("hello_ack");
    const [fence] = await nextCommands(ws2, (c) => c.type === "fence");
    expect(fence).toMatchObject({ sandboxes: ["sbx_ghost"], reason: "reconcile" });
  });
});

describe("commit compare-and-set", () => {
  it("advances head, rejects stale epochs and parent mismatches, orphans salvage, and is idempotent", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const commit = (request: string, epoch: number, parent: string | undefined, reason = "turn_end") =>
      sendEvents(h.ws, [{
        ts_ms: Date.now(), type: "commit_request", request, sandbox: sbx.sandbox, epoch,
        ...(parent ? { parent } : {}), kind: "disk_only", disk_manifest: manifest("a"), reason,
      }]);
    const result = async (request: string) => (await nextCommands(h.ws, (c) => c.type === "commit_result" && c.request === request))
      .find((c) => c.request === request).outcome;

    commit("req_1", 1, undefined);
    const r1 = await result("req_1");
    expect(r1.status).toBe("committed");
    const g1 = r1.generation.id as string;
    expect((await sandboxStub(sbx.sandbox).info()).head).toBe(g1);

    commit("req_2", 1, undefined); // parent should be g1
    expect(await result("req_2")).toEqual({ status: "rejected", reason: "parent_mismatch", head: g1 });

    commit("req_3", 2, g1); // epoch from the future / not ours
    expect(await result("req_3")).toEqual({ status: "rejected", reason: "stale_epoch", head: g1 });

    commit("req_1", 1, undefined); // retry of req_1 returns the stored outcome
    expect((await result("req_1")).generation.id).toBe(g1);

    commit("req_4", 1, g1, "checkpoint");
    const r4 = await result("req_4");
    expect(r4).toMatchObject({ status: "committed", generation: { parent: g1, epoch: 1 } });

    // Simulate a lease move to epoch 2, then a salvage commit from epoch 1.
    await runInDurableObject(sandboxStub(sbx.sandbox), (_i, state) => {
      const row = state.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one();
      const info = JSON.parse(row.value);
      info.epoch = 2;
      state.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    commit("req_5", 1, r4.generation.id, "salvage");
    const r5 = await result("req_5");
    expect(r5.status).toBe("orphaned");
    expect((await sandboxStub(sbx.sandbox).info()).head).toBe(r4.generation.id);
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(sbx.workstream)).events();
    expect(events.some((e) => e.type === "orphaned_work" && e.generation === r5.generation.id && e.stale_epoch === 1)).toBe(true);
  });
});

describe("commit validation", () => {
  it("rejects a commit whose kind disagrees with its memory manifest, and the chain stays as it was", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const cases = [
      { request: "req_k1", kind: "checkpoint" }, // claims memory, carries none
      { request: "req_k2", kind: "disk_only", mem_manifest: manifest("e") }, // carries memory, claims none
    ];
    for (const c of cases) {
      sendEvents(h.ws, [{ ts_ms: Date.now(), type: "commit_request", sandbox: sbx.sandbox, epoch: 1, disk_manifest: manifest("d"), reason: "checkpoint", ...c }]);
      const [res] = (await nextCommands(h.ws, (x) => x.type === "commit_result" && x.request === c.request)).filter((x) => x.request === c.request);
      expect(res.outcome, c.kind).toEqual({ status: "rejected", reason: "invalid_message" });
    }
    expect(await sandboxStub(sbx.sandbox).generations()).toEqual([]);
    expect((await sandboxStub(sbx.sandbox).info()).head).toBeNull();
    // A consistent checkpoint is accepted.
    sendEvents(h.ws, [{ ts_ms: Date.now(), type: "commit_request", request: "req_k3", sandbox: sbx.sandbox, epoch: 1, kind: "checkpoint",
      disk_manifest: manifest("d"), mem_manifest: manifest("e"), reason: "checkpoint" }]);
    const [ok] = (await nextCommands(h.ws, (x) => x.request === "req_k3")).filter((x) => x.request === "req_k3");
    expect(ok.outcome).toMatchObject({ status: "committed", generation: { kind: "checkpoint", mem_manifest: manifest("e") } });
  });
});

class MockEc2 implements Ec2 {
  terminated: string[] = [];
  launched: LaunchSpec[] = [];
  /** Instance types that fail with no capacity. */
  noCapacity = new Set<string>();
  states: (InstanceState | null)[];
  constructor(...states: (InstanceState | null)[]) {
    this.states = states;
  }
  async launch(spec: LaunchSpec) {
    if (this.noCapacity.has(`${spec.instanceType}/${spec.spot ? "spot" : "od"}`)) throw new CapacityError("InsufficientInstanceCapacity");
    this.launched.push(spec);
    return `i-0${this.launched.length.toString(16).padStart(8, "0")}`;
  }
  imagesList: ImageInfo[] = [];
  async images() {
    return this.imagesList;
  }
  async terminate(id: string) {
    this.terminated.push(id);
  }
  async state() {
    return this.states.length > 1 ? this.states.shift()! : this.states[0]!;
  }
}

describe("lease expiry and STONITH", () => {

  it("terminates the silent host, confirms, then reassigns with epoch + 1 from head", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    expect(sbx.host).toBe(a.host);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "commit_request", request: "req_c1", sandbox: sbx.sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("b"), reason: "timer" }]);
    const head = (await nextCommands(a.ws, (c) => c.type === "commit_result")).find((c) => c.type === "commit_result").outcome.generation;
    void create;

    // Pretend host A is an EC2 instance we can terminate, then let host B join.
    const ec2 = new MockEc2("running", "running", "terminated");
    await runInDurableObject(fleet, (inst: FleetDO, state) => {
      inst.ec2Override = ec2;
      state.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0hostA' WHERE host = ?", a.host);
    });
    a.ws.close();
    const b = await connectHost(cell);

    await expireNow(cell, a.host);
    expect(ec2.terminated).toContain("i-0hostA");
    // First poll saw "running" → terminate again; nothing reassigned yet (never double-run).
    expect((await sandboxStub(sbx.sandbox).info()).epoch).toBe(1);
    expect((await fleet.hostStatus(a.host))!.status).toBe("stonith_pending");

    await runInDurableObject(fleet, (inst: FleetDO, state) => {
      inst.ec2Override = ec2;
      state.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDue(fleet);
    expect((await fleet.hostStatus(a.host))!.status).toBe("dead");
    const info = await sandboxStub(sbx.sandbox).info();
    expect(info).toMatchObject({ epoch: 2, host: b.host, state: "restoring" });
    const [recreate] = await nextCommands(b.ws, (c) => c.type === "sandbox_create");
    expect(recreate).toMatchObject({ sandbox: sbx.sandbox, epoch: 2, from: { id: head.id } });
  });

  it("without EC2, waits for the host to come back and fence before reassigning", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await runInDurableObject(fleet, (inst: FleetDO) => {
      inst.ec2Override = null;
    });
    a.ws.close();
    await expireNow(cell, a.host);
    expect((await fleet.hostStatus(a.host))!.status).toBe("stonith_pending");
    expect((await sandboxStub(sbx.sandbox).info()).epoch).toBe(1);

    // The host comes back (it self-fenced at 20 s); its claim is revoked and it must fence first.
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell, { sandboxes: [{ sandbox: sbx.sandbox, epoch: 1, state: "fenced", dirty: true }] }));
    await ws.next("hello_ack");
    ws.send({ type: "heartbeat", sent_ms: 1, leases: [{ sandbox: sbx.sandbox, epoch: 1 }] });
    expect((await ws.next("heartbeat_ack")).revoked).toEqual([{ sandbox: sbx.sandbox, epoch: 1 }]);
    const [fence] = await nextCommands(ws, (c) => c.type === "fence");
    expect(fence.sandboxes).toEqual([sbx.sandbox]);
    await okResult(ws, fence.cmd);
    // Fence confirmed: new lease (epoch 2), placed on the only connected host (the same one).
    const [recreate] = await nextCommands(ws, (c) => c.type === "sandbox_create");
    expect(recreate).toMatchObject({ sandbox: sbx.sandbox, epoch: 2 });
    expect((await sandboxStub(sbx.sandbox).info()).epoch).toBe(2);
  });

  it("an operator can confirm a host dead", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const b = await connectHost(cell);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    expect((await sandboxStub(sbx.sandbox).info())).toMatchObject({ epoch: 2, host: b.host });
  });

  it("never renews the lease of a host it holds expired, though its socket is open (B-5)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell, "brain");
    // A FleetDO reset between a hello's ack and its expired-to-active write left it so.
    await runInDurableObject(fleetStub(cell), (_i, state) => {
      state.storage.sql.exec("UPDATE hosts SET status = 'expired', lost = 1 WHERE host = ?", h.host);
    });
    h.ws.send({ type: "heartbeat", sent_ms: 1, leases: [] });
    expect(await h.ws.none("heartbeat_ack", 300)).toBe(true);
  });

  it("a returning host is active again by the time its hello is acknowledged (B-5)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell, "brain");
    await runInDurableObject(fleetStub(cell), (inst: FleetDO, state) => {
      state.storage.sql.exec("UPDATE hosts SET status = 'expired', lost = 1 WHERE host = ?", h.host);
      // Whatever the hello awaits after its ack never finishes (a FleetDO reset there).
      (inst as any).sendBindingKeys = () => new Promise(() => {});
    });
    const ws = await Ws.connect("/v1/fleet", h.host_token);
    ws.send(hostHello(h.host, cell, { role: "brain" }));
    await ws.next("hello_ack");
    expect(await fleetStub(cell).hostStatus(h.host)).toMatchObject({ status: "active", lost: false });
  });

  it("sends a new host token on every hello, whenever the old one expires (B-9)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const ws = await Ws.connect("/v1/fleet", h.host_token);
    ws.send(hostHello(h.host, cell));
    await ws.next("hello_ack");
    expect((await ws.next("host_token")).token).toMatch(/^nht_/);
  });

  it("rotates host tokens before they expire", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await runInDurableObject(fleetStub(cell), (_i, state) => {
      state.storage.sql.exec("UPDATE hosts SET token_exp = ? WHERE host = ?", Date.now() + 60_000, h.host);
      state.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDue(fleetStub(cell));
    const rotated = await h.ws.next("host_token");
    expect(rotated.token).toMatch(/^nht_/);
    expect(rotated.expires_ms).toBeGreaterThan(Date.now() + 30 * 60_000);
  });
});

describe("autoscaling", () => {
  const config: AwsCellConfig = {
    region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a", "subnet-0b"],
    instance_types: ["c8i-flex.large", "c8i.large"], spot: true, max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  };

  /** Run FleetDO's tick now, `ms` in the future as far as the idle and enroll clocks are concerned. */
  async function tickAt(cell: string, ec2: MockEc2, shiftMs = 0) {
    await runInDurableObject(fleetStub(cell), (inst: FleetDO, state) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = config;
      state.storage.sql.exec("UPDATE hosts SET idle_since = idle_since - ? WHERE idle_since IS NOT NULL", shiftMs);
      state.storage.sql.exec("UPDATE launched SET launched_ms = launched_ms - ?", shiftMs);
      state.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDue(fleetStub(cell));
  }

  async function autoscaled(cell: string, ec2: MockEc2) {
    await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = config;
    });
  }

  /** Enroll as the launched instance (what the Worker does after verifying its identity document). */
  async function enrollLaunched(cell: string, instanceId: string) {
    return runInDurableObject(fleetStub(cell), async (inst: FleetDO) => {
      const { csrPem } = await import("./helpers");
      return inst.enroll({ role: "sandbox", proof: { type: "aws_identity_document", document_b64: "", pkcs7_b64: "" }, proxy_ca_csr_pem: await csrPem() } as never,
        cell, { instanceId, accountId: "123456789012", region: "us-east-1" } as never);
    });
  }

  it("launches one host when a sandbox can't be placed, places on it, and scales back to zero", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("running", "terminated");
    ec2.noCapacity.add("c8i-flex.large/spot");
    await autoscaled(cell, ec2);

    const sbx = await createSandbox(cell, 202);
    expect(sbx.host).toBeNull();
    // c8i-flex had no spot capacity; the next type launched, on spot, from the launch template.
    expect(ec2.launched).toHaveLength(1);
    expect(ec2.launched[0]).toMatchObject({ launchTemplateId: "lt-0abc", instanceType: "c8i.large", spot: true });
    // Not burstable: EC2 refuses a credit mode for it.
    expect(ec2.launched[0]!.cpuCredits).toBeUndefined();
    // A second unplaceable sandbox waits for the pending launch instead of launching another.
    await createSandbox(cell, 202);
    expect(ec2.launched).toHaveLength(1);

    // The instance enrolls (only as a sandbox host of this cell, from the launch record) and connects.
    const enrolled = await enrollLaunched(cell, "i-000000001");
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell));
    await ws.next("hello_ack");
    expect(await sandboxStub(sbx.sandbox).retryPlacement()).toBe(enrolled.host);

    // Busy: never retired, however long.
    await tickAt(cell, ec2, 3_600_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");

    // Destroying its sandboxes makes it idle; it's retired only after the grace.
    await adminJson(`/v1/sandboxes/${sbx.sandbox}`, { method: "DELETE" });
    const view = (await fleetStub(cell).fleetView()) as { hosts: { leases: number }[] };
    for (const l of view.hosts) expect(l.leases).toBe(0);
    await tickAt(cell, ec2);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");
    await tickAt(cell, ec2, 30_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");
    await tickAt(cell, ec2, 31_000);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("dead");
    expect(ec2.terminated).toEqual(["i-000000001"]);
    // The next tick sees it terminated and stops (the alarm isn't re-armed for it).
    await tickAt(cell, ec2);
    const after = (await fleetStub(cell).fleetView()) as { launches: unknown[] };
    expect(after.launches).toEqual([expect.objectContaining({ instance_id: "i-000000001", reason: "idle", ended_ms: expect.any(Number) })]);
    ws.close();
  });

  it("repeats a launch whose answer was lost with the same client token, so it's recorded and never launched twice (B-6)", async () => {
    const cell = uniqueCell();
    // EC2 launches the instance, but its answer never arrives (a timeout, a reset).
    const byToken = new Map<string, string>();
    let lose = true;
    const ec2 = new MockEc2("running");
    ec2.launch = async (spec: LaunchSpec) => {
      if (!byToken.has(spec.clientToken)) byToken.set(spec.clientToken, `i-0${(byToken.size + 1).toString(16).padStart(8, "0")}`);
      ec2.launched.push(spec);
      if (lose) { lose = false; throw new Error("EC2 RunInstances: network connection lost"); }
      return byToken.get(spec.clientToken)!;
    };
    await autoscaled(cell, ec2);
    await createSandbox(cell, 202);
    expect(ec2.launched).toHaveLength(1);
    expect(((await fleetStub(cell).fleetView()) as { launches: unknown[] }).launches).toEqual([]);
    // The next run repeats that attempt, not a new one: EC2 answers with the instance it launched.
    await tickAt(cell, ec2);
    expect(ec2.launched.map((l) => l.clientToken)).toEqual([ec2.launched[0]!.clientToken, ec2.launched[0]!.clientToken]);
    expect(byToken.size).toBe(1);
    expect(((await fleetStub(cell).fleetView()) as { launches: unknown[] }).launches).toEqual([expect.objectContaining({ instance_id: "i-000000001" })]);
    // It can enroll, and nothing else is launched for the waiting sandbox meanwhile.
    expect((await enrollLaunched(cell, "i-000000001")).host).toMatch(/^hst_/);
    await tickAt(cell, ec2);
    expect(byToken.size).toBe(1);
  });

  it("stops repeating a launch after the enroll timeout, and the tick launches nothing in its place", async () => {
    const cell = uniqueCell();
    // EC2 never answers (a timeout every time): whether an instance exists is unknown.
    const ec2 = new MockEc2("running");
    ec2.launch = async (spec: LaunchSpec) => {
      ec2.launched.push(spec);
      throw new Error("EC2 RunInstances: network connection lost");
    };
    await autoscaled(cell, ec2);
    await createSandbox(cell, 202);
    await tickAt(cell, ec2);
    expect(new Set(ec2.launched.map((l) => l.clientToken)).size).toBe(1);
    // The attempt is older than enroll_timeout_ms: its token may no longer be honoured.
    await runInDurableObject(fleetStub(cell), (_i, state) => {
      state.storage.sql.exec("UPDATE kv SET value = json_set(value, '$.at', 0) WHERE key LIKE 'launch:%'");
    });
    const before = ec2.launched.length;
    await tickAt(cell, ec2);
    // Dropped, and no new launch without demand: the waiting sandbox's next placement asks for one.
    expect(ec2.launched).toHaveLength(before);
    expect(await runInDurableObject(fleetStub(cell), (_i, state) => state.storage.sql.exec("SELECT 1 FROM kv WHERE key LIKE 'launch:%'").toArray().length)).toBe(0);
  });

  it("terminates a launch that never enrolls, then launches again on demand", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("terminated");
    await autoscaled(cell, ec2);
    const sbx = await createSandbox(cell, 202);
    expect(ec2.launched).toHaveLength(1);
    await tickAt(cell, ec2, 601_000);
    expect(ec2.terminated).toEqual([]); // state was already terminated; just recorded
    expect(((await fleetStub(cell).fleetView()) as { launches: unknown[] }).launches[0]).toMatchObject({ reason: "enroll_timeout", ended_ms: expect.any(Number) });
    await autoscaled(cell, ec2);
    await sandboxStub(sbx.sandbox).retryPlacement();
    expect(ec2.launched).toHaveLength(2);
  });

  it("retires a launched host that enrolled but never said hello once the enroll timeout passes (B-8)", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("running");
    await autoscaled(cell, ec2);
    await createSandbox(cell, 202);
    const enrolled = await enrollLaunched(cell, "i-000000001");
    await tickAt(cell, ec2);
    expect((await fleetStub(cell).hostStatus(enrolled.host))!.status).toBe("active");
    await runInDurableObject(fleetStub(cell), (_i, state) => {
      state.storage.sql.exec("UPDATE hosts SET enrolled_ms = enrolled_ms - 601000");
    });
    await tickAt(cell, ec2);
    // Dead with its brains proven gone (nothing was ever delivered to it), and its instance terminated.
    expect(await fleetStub(cell).hostStatus(enrolled.host)).toMatchObject({ status: "dead", lost: true });
    expect(ec2.terminated).toEqual(["i-000000001"]);
    expect(((await fleetStub(cell).fleetView()) as { launches: unknown[] }).launches[0]).toMatchObject({ instance_id: "i-000000001", reason: "enroll_timeout" });
  });

  it("does nothing in a cell without AWS settings, and never retires hosts it didn't launch", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("running");
    await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = null;
    });
    const sbx = await createSandbox(cell, 202);
    expect(sbx.host).toBeNull();
    expect(ec2.launched).toHaveLength(0);
    const h = await connectHost(cell); // enrolled with a token: no instance id
    await tickAt(cell, ec2, 3_600_000);
    await tickAt(cell, ec2, 3_600_000);
    expect((await fleetStub(cell).hostStatus(h.host))!.status).toBe("active");
  });
});

describe("sandbox lifecycle: idle suspend, eviction, lazy wake, spot drain", () => {
  const state = (ws: Ws, sandbox: string, epoch: number, s: string) =>
    sendEvents(ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox, epoch, state: s }]);

  /** A committed head, so a move has something to restore from. */
  async function commitHead(ws: Ws, sandbox: string, epoch: number, request: string) {
    sendEvents(ws, [{ ts_ms: Date.now(), type: "commit_request", request, sandbox, epoch, kind: "disk_only", disk_manifest: manifest("c"), reason: "suspend" }]);
    return (await nextCommands(ws, (c) => c.type === "commit_result")).find((c) => c.type === "commit_result").outcome.generation;
  }

  async function runAlarm(stub: DurableObjectStub, key: string) {
    await runInDurableObject(stub, (_i, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = ?", key);
    });
    await runDue(stub);
  }

  it("suspends a running sandbox once nobody has worked on it for the idle period", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    state(a.ws, sbx.sandbox, 1, "running");
    await a.ws.next("ack");
    // An agent at work holds it awake; when it goes idle, the countdown starts.
    await sandboxStub(sbx.sandbox).attach("agt_lifecycle00000000000000000");
    await sandboxStub(sbx.sandbox).agentActivity("agt_lifecycle00000000000000000", true);
    await runAlarm(sandboxStub(sbx.sandbox), "idle");
    await sandboxStub(sbx.sandbox).agentActivity("agt_lifecycle00000000000000000", false);
    await runAlarm(sandboxStub(sbx.sandbox), "idle");
    const [suspend] = await nextCommands(a.ws, (c) => c.type === "sandbox_suspend");
    expect(suspend).toMatchObject({ sandbox: sbx.sandbox, epoch: 1, mode: "disk_only" });
  });

  it("commits the disk when a turn ends, and a turn ending within 10 s gets its commit when the interval is up", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    state(a.ws, sbx.sandbox, 1, "running");
    await a.ws.next("ack");
    const stub = sandboxStub(sbx.sandbox);
    const agent = "agt_turnend000000000000000000";
    await stub.attach(agent);
    await nextCommands(a.ws, (c) => c.type === "agent_attach"); // the slot, not a commit
    await stub.agentActivity(agent, true);
    await stub.agentActivity(agent, false);
    const [first] = await nextCommands(a.ws, (c) => c.type === "sandbox_checkpoint");
    expect(first).toMatchObject({ sandbox: sbx.sandbox, epoch: 1, reason: "turn_end" });
    // A second turn right away: no commit yet (rate limit), but one is due, not dropped.
    await stub.agentActivity(agent, true);
    await stub.agentActivity(agent, false);
    expect(await a.ws.none("commands", 300)).toBe(true);
    await runInDurableObject(stub, (_i, st) => {
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'turn_checkpoint_ms'", JSON.stringify(Date.now() - 11_000));
    });
    await runAlarm(stub, "turn_checkpoint");
    const [second] = await nextCommands(a.ws, (c) => c.type === "sandbox_checkpoint");
    expect(second).toMatchObject({ reason: "turn_end", epoch: 1 });
  });

  it("a host retired with only suspended sandboxes evicts them; waking places them from head elsewhere", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("running", "terminated");
    const config: AwsCellConfig = {
      region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"],
      spot: true, max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
    };
    const fleet = fleetStub(cell);
    const a = await connectHost(cell);
    await runInDurableObject(fleet, (inst: FleetDO, st) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = config;
      st.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0hostA' WHERE host = ?", a.host);
    });
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    state(a.ws, sbx.sandbox, 1, "running");
    const head = await commitHead(a.ws, sbx.sandbox, 1, "req_life1");
    const suspendedSeq = state(a.ws, sbx.sandbox, 1, "suspended");
    await a.ws.next("ack", (m) => m.up_to >= suspendedSeq);

    // Suspended sandboxes don't keep the host up: idle → retired after the grace, sandbox evicted.
    const tick = async (shift: number) => {
      await runInDurableObject(fleet, (inst: FleetDO, st) => {
        inst.ec2Override = ec2;
        inst.cellConfigOverride = config;
        st.storage.sql.exec("UPDATE hosts SET idle_since = idle_since - ? WHERE idle_since IS NOT NULL", shift);
        st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
      });
      await runDue(fleet);
    };
    await tick(0);
    await tick(61_000);
    expect((await fleet.hostStatus(a.host))!.status).toBe("dead");
    expect(ec2.terminated).toContain("i-0hostA");
    expect(await sandboxStub(sbx.sandbox).info()).toMatchObject({ host: null, state: "suspended", epoch: 1, head: head.id });
    expect(await fleet.leaseOf(sbx.sandbox)).toBeNull();

    // Nothing places it until something needs it: its own retry alarm leaves it alone.
    const b = await connectHost(cell);
    await runInDurableObject(sandboxStub(sbx.sandbox), (_i, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('place', 0)");
    });
    await runDue(sandboxStub(sbx.sandbox));
    expect((await sandboxStub(sbx.sandbox).info()).host).toBeNull();

    // Lazy start: waking places it from head on the connected host, under the next epoch.
    expect((await sandboxStub(sbx.sandbox).wake()).host).toBe(b.host);
    const [create] = await nextCommands(b.ws, (c) => c.type === "sandbox_create");
    expect(create).toMatchObject({ sandbox: sbx.sandbox, epoch: 2, from: { id: head.id } });
  });

  it("waking a sandbox suspended on a live host resumes it there", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    state(a.ws, sbx.sandbox, 1, "suspended");
    await a.ws.next("ack");
    expect((await sandboxStub(sbx.sandbox).wake()).host).toBe(a.host);
    const [resume] = await nextCommands(a.ws, (c) => c.type === "sandbox_resume");
    expect(resume).toMatchObject({ sandbox: sbx.sandbox, epoch: 1 });
  });

  it("a spot notice drains: running sandboxes suspend; a busy one moves at once, an idle one waits", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    const a = await connectHost(cell);
    const busy = await createSandbox(cell);
    const idle = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create" && c.sandbox === idle.sandbox);
    state(a.ws, busy.sandbox, 1, "running");
    state(a.ws, idle.sandbox, 1, "running");
    await a.ws.next("ack", (m) => m.up_to >= 1002);
    await sandboxStub(busy.sandbox).attach("agt_spotbusy0000000000000000000");
    await sandboxStub(busy.sandbox).agentActivity("agt_spotbusy0000000000000000000", true);
    const b = await connectHost(cell);

    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    const cmds = await nextCommands(a.ws, (c) => c.type === "sandbox_suspend");
    expect(cmds.filter((c) => c.type === "sandbox_suspend").map((c) => c.sandbox).sort()).toEqual([busy.sandbox, idle.sandbox].sort());
    expect((await fleet.hostStatus(a.host))!.status).toBe("draining");

    // Each leaves as it reports suspended; only the busy one is placed again right away.
    const head = await commitHead(a.ws, busy.sandbox, 1, "req_spot1");
    state(a.ws, busy.sandbox, 1, "suspended");
    const idleSeq = state(a.ws, idle.sandbox, 1, "suspended");
    const [recreate] = await nextCommands(b.ws, (c) => c.type === "sandbox_create");
    await a.ws.next("ack", (m) => m.up_to >= idleSeq);
    expect(recreate).toMatchObject({ sandbox: busy.sandbox, epoch: 2, from: { id: head.id } });
    expect(await sandboxStub(busy.sandbox).info()).toMatchObject({ host: b.host, state: "restoring" });
    expect(await sandboxStub(idle.sandbox).info()).toMatchObject({ host: null, state: "suspended" });
  });

  it("a spot drain survives a blip: a host back from STONITH by fence, or from expiry, is still draining (B-3)", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    await runInDurableObject(fleet, (inst: FleetDO) => {
      inst.ec2Override = null;
    });
    // Through STONITH by fence: the drained host holds a lease when it goes silent.
    const a = await connectHost(cell);
    const sbx = await createSandbox(cell);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    state(a.ws, sbx.sandbox, 1, "running");
    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    await nextCommands(a.ws, (c) => c.type === "sandbox_suspend");
    a.ws.close();
    await expireNow(cell, a.host);
    expect((await fleet.hostStatus(a.host))!.status).toBe("stonith_pending");
    const ws = await Ws.connect("/v1/fleet", a.host_token);
    ws.send(hostHello(a.host, cell, { sandboxes: [{ sandbox: sbx.sandbox, epoch: 1, state: "fenced", dirty: false }] }));
    // The same nestd process: its event lineage continues where FleetDO's ack left it.
    sendEvents(ws, [], (await ws.next("hello_ack")).last_event_seq + 1);
    const [fence] = await nextCommands(ws, (c) => c.type === "fence" && c.reason === "lease expired");
    await okResult(ws, fence!.cmd);
    expect((await fleet.hostStatus(a.host))!.status).toBe("draining");

    // Through expiry: a drained host holding nothing goes silent, then says hello.
    const c = await connectHost(cell);
    sendEvents(c.ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    await c.ws.next("ack");
    c.ws.close();
    await expireNow(cell, c.host);
    expect((await fleet.hostStatus(c.host))!.status).toBe("expired");
    const again = await Ws.connect("/v1/fleet", c.host_token);
    again.send(hostHello(c.host, cell));
    await again.next("hello_ack");
    await again.next("binding_key");
    expect((await fleet.hostStatus(c.host))!.status).toBe("draining");
    // Neither takes a placement: with no other host, the sandbox waits.
    expect((await createSandbox(cell, 202)).host).toBeNull();
  });

  it("a draining host doesn't count toward the cell's host cap", async () => {
    const cell = uniqueCell();
    const ec2 = new MockEc2("running");
    const config: AwsCellConfig = {
      region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"],
      spot: true, max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
    };
    const a = await connectHost(cell);
    await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      inst.ec2Override = ec2;
      inst.cellConfigOverride = config;
    });
    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    await a.ws.next("ack");
    await createSandbox(cell, 202);
    expect(ec2.launched).toHaveLength(1);
  });
});

describe("nestd restarts", () => {
  it("leases a restarted nestd doesn't report are dropped: running ones re-placed from head, suspended ones evicted", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const running = await createSandbox(cell);
    const parked = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create" && c.sandbox === parked.sandbox);
    sendEvents(h.ws, [{ ts_ms: Date.now(), type: "commit_request", request: "req_rs1", sandbox: running.sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("d"), reason: "timer" }]);
    const head = (await nextCommands(h.ws, (c) => c.type === "commit_result")).find((c) => c.type === "commit_result").outcome.generation;
    sendEvents(h.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: running.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: parked.sandbox, epoch: 1, state: "suspended" },
    ]);
    await h.ws.next("ack", (m) => m.up_to >= 1002);
    h.ws.close();

    // The new process (saved credentials, new instance_id) comes back with nothing.
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { instance_id: "nestdrestart0001", sandboxes: [] }));
    await ws2.next("hello_ack");
    const [recreate] = await nextCommands(ws2, (c) => c.type === "sandbox_create");
    expect(recreate).toMatchObject({ sandbox: running.sandbox, epoch: 2, from: { id: head.id } });
    expect(await sandboxStub(parked.sandbox).info()).toMatchObject({ host: null, state: "suspended", epoch: 1 });
    expect(await fleetStub(cell).leaseOf(parked.sandbox)).toBeNull();
  });
});

describe("object-store GC", () => {
  const claim = (token: string) => SELF.fetch("http://cp.test/v1/hosts/gc/claim", { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const report = (token: string, run: string, rep: Record<string, unknown>) => SELF.fetch("http://cp.test/v1/hosts/gc/report", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ run, report: rep }) });

  it("hands one sandbox host the live sandboxes' generations as roots, dry run first, then daily", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const keep = await createSandbox(cell);
    const gone = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create" && c.sandbox === gone.sandbox);
    const commit = (sandbox: string, m: string, request: string) => sendEvents(h.ws, [{
      ts_ms: Date.now(), type: "commit_request", request, sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest(m), reason: "turn_end" }]);
    commit(keep.sandbox, "a", "req_k");
    await nextCommands(h.ws, (c) => c.type === "commit_result" && c.request === "req_k");
    commit(gone.sandbox, "b", "req_g");
    await nextCommands(h.ws, (c) => c.type === "commit_result" && c.request === "req_g");
    await adminJson(`/v1/sandboxes/${gone.sandbox}`, { method: "DELETE" }, 200);

    // Without a token: refused. A brain host never runs it.
    expect((await SELF.fetch("http://cp.test/v1/hosts/gc/claim", { method: "POST" })).status).toBe(401);
    const ctl = await connectHost(cell, "brain");
    expect((await claim(ctl.host_token)).status).toBe(204);

    const r1 = await claim(h.host_token);
    expect(r1.status).toBe(200);
    const c1 = await r1.json<any>();
    expect(c1).toMatchObject({ dry_run: true, roots: [manifest("a")], grace_ms: 86_400_000 });
    expect(c1.deadline_ms - c1.marked_ms).toBe(12 * 3_600_000);
    // One run at a time.
    expect((await claim(h.host_token)).status).toBe(204);
    expect((await report(h.host_token, c1.run, { would_delete: 3 })).status).toBe(200);
    // Not due again for a day, unless an operator asks; the next one is for real.
    expect((await claim(h.host_token)).status).toBe(204);
    await adminJson(`/v1/admin/gc/run?cell=${cell}`, { body: {} }, 200);
    const c2 = await (await claim(h.host_token)).json<any>();
    expect(c2.dry_run).toBe(false);
    const status = await adminJson<any>(`/v1/admin/gc?cell=${cell}`, {}, 200);
    expect(status.sandboxes).toBe(1);
    expect(status.runs[1]).toMatchObject({ run: c1.run, dry_run: 1, report: { would_delete: 3 } });
  });

  it("abandons a run that outlives its window and backfills registrations", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const c1 = await (await claim(h.host_token)).json<any>();
    await runInDurableObject(fleetStub(cell), (_i: FleetDO, state) => {
      state.storage.sql.exec("UPDATE gc_runs SET marked_ms = ? WHERE run = ?", Date.now() - 13 * 3_600_000, c1.run);
      state.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('gc_requested', '1')");
    });
    const c2 = await (await claim(h.host_token)).json<any>();
    // The abandoned dry run proves nothing: still dry.
    expect(c2).toMatchObject({ dry_run: true });
    expect(c2.run).not.toBe(c1.run);
    // A late report for the abandoned run is ignored.
    await report(h.host_token, c1.run, { deleted: 1 });
    const runs = (await adminJson<any>(`/v1/admin/gc?cell=${cell}`, {}, 200)).runs;
    expect(runs.find((r: any) => r.run === c1.run).report).toEqual({ abandoned: true });
    expect((await adminJson<any>(`/v1/admin/gc/register?cell=${cell}`, { body: { sandboxes: ["sbx_old1", "sbx_old2"] } }, 200)).live).toBe(2);
  });
});
