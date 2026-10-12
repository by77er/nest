import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { Ec2, InstanceState } from "../src/lib/ec2";
import { adminJson, connectHost, hostHello, manifest, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

async function workstream(goal = "test") {
  return adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal } }, 201);
}

async function createSandbox(cell: string) {
  const ws = await workstream();
  const info = await adminJson<{ sandbox: string; epoch: number; host: string; workstream: string }>(
    `/v1/sandboxes`, { body: { workstream: ws.workstream, cell } }, 201);
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
  await runDurableObjectAlarm(fleetStub(cell));
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
    ws2.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
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
    const sbx = await createSandbox(cell);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const worker = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", workstream: sbx.workstream, sandbox: sbx.sandbox, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "agent_start");
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

describe("lease expiry and STONITH", () => {
  class MockEc2 implements Ec2 {
    terminated: string[] = [];
    states: (InstanceState | null)[];
    constructor(...states: (InstanceState | null)[]) {
      this.states = states;
    }
    async terminate(id: string) {
      this.terminated.push(id);
    }
    async state() {
      return this.states.length > 1 ? this.states.shift()! : this.states[0]!;
    }
  }

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
    await runDurableObjectAlarm(fleet);
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

  it("rotates host tokens before they expire", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await runInDurableObject(fleetStub(cell), (_i, state) => {
      state.storage.sql.exec("UPDATE hosts SET token_exp = ? WHERE host = ?", Date.now() + 60_000, h.host);
      state.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleetStub(cell));
    const rotated = await h.ws.next("host_token");
    expect(rotated.token).toMatch(/^nht_/);
    expect(rotated.expires_ms).toBeGreaterThan(Date.now() + 30 * 60_000);
  });
});
