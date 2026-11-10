// Regression tests for the control-plane review findings (one block per finding).
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { type AgentDO, streamCommittable } from "../src/do/agent";
import type { FleetDO } from "../src/do/fleet";
import { Deadlines } from "../src/lib/reliable";
import { issueHostToken } from "../src/lib/tokens";
import { bytesToB64 } from "../src/lib/util";
import { admin, adminJson, BASE, connectHost, csrPem, eventually, hostHello, inboundPending, manifest, nextCommands, okResult, received, runDue, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const SESSION2 = "ses_0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));


async function setup(opts: { start?: boolean; captain?: boolean } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-regress" } });
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  let captain: string | undefined;
  if (opts.captain) {
    captain = (await adminJson("/v1/agents", { body: { role: "captain", cell } }, 201)).agent;
  }
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const start = opts.start ?? true;
  const worker = await adminJson("/v1/agents", { body: { role: "worker", sandbox: sbx.sandbox, cell, start, ...(captain ? { captain } : {}) } }, 201);
  if (start) await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { cell, host, sbxHost, sandbox: sbx.sandbox as string, agent: worker.agent as string, captain };
}

async function runner(agent: string, hostId: string, token: string, instance = "rin_one", epoch = 1, extra: Record<string, unknown> = {}) {
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, token);
  ws.send({ type: "hello", protocol_version: 1, agent, host: hostId, instance_id: instance, epoch, session: SESSION, ...extra });
  const ack = await ws.next("hello_ack");
  return { ws, ack };
}

const toolCall = (seq: number, call: string, name: string, args: unknown) => ({ type: "tool_call", seq, call, turn: "trn_x", name, arguments: args });
const seg = (offset: number, text: string, base = false, session = SESSION) => ({
  type: "segment", session, offset, base, data_b64: bytesToB64(new TextEncoder().encode(text)),
});

describe("#1 one lease, one host", () => {
  it("refuses to re-place a placed sandbox, and FleetDO never overwrites a lease", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    expect(create.epoch).toBe(1);
    await connectHost(cell);
    const res = await admin(`/v1/sandboxes/${sbx.sandbox}/place`, { body: {} });
    expect(res.status).toBe(409);
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: a.host, epoch: 1 });
    await expect(Promise.resolve().then(() => fleetStub(cell).place({
      sandbox: sbx.sandbox, workstream: "ws_test", epoch: 9, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 },
      policy: { version: 1, allow: [], passthrough: [], inject: [], tcp: [], limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 } },
    }))).rejects.toThrow(/already holds a lease/);
  });

  it("re-places a failed sandbox under a new epoch after fencing its old host", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "command_result", cmd: create.cmd, outcome: { status: "error", error: { code: "internal", message: "boom", retryable: false } } }]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await sandboxStub(sbx.sandbox).info()).state).toBe("failed");
    const placed = await adminJson(`/v1/sandboxes/${sbx.sandbox}/place`, { body: {} });
    expect(placed.host).toBe(a.host);
    const cmds = await nextCommands(a.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    expect(cmds.some((c) => c.type === "sandbox_create" && c.epoch === 2)).toBe(true);
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: a.host, epoch: 2 });
  });
});

describe("#2 a restarted runner is a new lineage", () => {
  it("processes the new runner's tool calls and events (seqs restart at 1) and re-queues the cut-off turn", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, "rin_one");
    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "one" } }, 201)).turn;
    await r1.ws.next("run_turn", (m) => m.turn === t1);
    for (let i = 1; i <= 3; i++) {
      r1.ws.send(toolCall(i, `cal_a-${i}`, "read_transcript", { agent: s.agent }));
      await r1.ws.next("tool_result", (m) => m.call === `cal_a-${i}`);
    }
    r1.ws.send({ type: "events", seq: 4, events: [{ agent: s.agent, epoch: 1, seq: 1, ts_ms: 1, turn: t1, type: "turn_started", input_kind: "user" }] });
    await r1.ws.next("ack", (m) => m.up_to === 4);
    r1.ws.close();

    // New runner process: its seqs (channel and AgentEvent) restart at 1.
    const r2 = await runner(s.agent, s.host.host, s.host.host_token, "rin_two");
    expect(r2.ack.last_seq).toBeUndefined();
    const recovery = await r2.ws.next("run_turn");
    expect(recovery.input.kind).toBe("recovery");
    expect(recovery.input.text).toContain("one");
    r2.ws.send(toolCall(1, "cal_b-1", "read_transcript", { agent: s.agent }));
    expect((await r2.ws.next("tool_result", (m) => m.call === "cal_b-1")).outcome.status).toBe("ok");
    r2.ws.send({ type: "events", seq: 2, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: 2, turn: recovery.turn, type: "turn_started", input_kind: "recovery" },
      { agent: s.agent, epoch: 1, seq: 2, ts_ms: 2, turn: recovery.turn, type: "turn_completed", stop_reason: "end_turn" },
    ] });
    await r2.ws.next("ack", (m) => m.up_to === 2);
    const info = await agentStub(s.agent).info();
    expect(info.current_turn).toBeNull();
    const turns = await agentStub(s.agent).turns();
    expect(turns.map((t) => t.status).sort()).toEqual(["done", "interrupted"]);
  });
});

describe("a finished turn's trailing events", () => {
  it("leave the next turn's state alone: its `idle` after `turn_completed` doesn't stand for the turn now running", async () => {
    const s = await setup();
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "one" } }, 201)).turn;
    await ws.next("run_turn", (m) => m.turn === t1);
    const t2 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "two" } }, 201)).turn;
    const ev = (seq: number, turn: string, body: Record<string, unknown>) => ({ agent: s.agent, epoch: 1, seq, ts_ms: seq, turn, ...body });
    // As the runner sends them: the turn's end, then its idle (stamped with the turn that ended).
    ws.send({ type: "events", seq: 1, events: [ev(1, t1, { type: "turn_started", input_kind: "user" }), ev(2, t1, { type: "turn_completed", stop_reason: "end_turn" })] });
    await ws.next("ack", (m) => m.up_to === 1);
    await ws.next("run_turn", (m) => m.turn === t2);
    ws.send({ type: "events", seq: 2, events: [ev(3, t1, { type: "state_changed", state: "idle" })] });
    await ws.next("ack", (m) => m.up_to === 2);
    expect(await agentStub(s.agent).info()).toMatchObject({ current_turn: t2, state: "working" });
    // The running turn's own events still count.
    ws.send({ type: "events", seq: 3, events: [ev(4, t2, { type: "state_changed", state: "waiting_permission" })] });
    await ws.next("ack", (m) => m.up_to === 3);
    expect((await agentStub(s.agent).info()).state).toBe("waiting_permission");
  });
});

describe("a turn recovered while pump awaits", () => {
  it("isn't sent after its recovery turn: the new runner gets the recovery turn alone", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one");
    // Pause the pump that claims the turn after its awaits, before it sends.
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["pump:beforeSend"] = async () => {
        delete inst.testHooks["pump:beforeSend"];
        while (!(inst as unknown as { go?: boolean }).go) await new Promise((r) => setTimeout(r, 10));
      };
    });
    const queued = adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await eventually("the pump to reach its send", async () =>
      runInDurableObject(agentStub(s.agent), (inst: AgentDO) => inst.testHooks["pump:beforeSend"] === undefined));
    // A new runner process says hello meanwhile: the claimed turn is recovered.
    const r2 = await runner(s.agent, s.host.host, s.host.host_token, "rin_two");
    const rec = await r2.ws.next("run_turn");
    expect(rec.input.kind).toBe("recovery");
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      (inst as unknown as { go?: boolean }).go = true;
    });
    const t = (await queued).turn;
    expect(await r2.ws.none("run_turn", 500, (m) => m.turn === t)).toBe(true);
    expect((await agentStub(s.agent).info()).current_turn).toBe(rec.turn);
  });
});

describe("#3 no lost updates across awaits", () => {
  it("a flush interleaved with enqueueTurn keeps the running turn", async () => {
    const s = await setup();
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "a\n"));
    await received(s.agent, 2);
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      await Promise.all([inst.flush(), inst.enqueueTurn({ kind: "user", text: "one" })]);
    });
    const info = await agentStub(s.agent).info();
    expect(info.current_turn).not.toBeNull();
    expect(info.durable_bytes).toBe(2);
    expect((await ws.next("run_turn")).input.text).toBe("one");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "two" } }, 201);
    expect(await ws.none("run_turn", 200)).toBe(true);
  });
});

describe("#4 reassignment can't strand leases", () => {
  it("one agent failing to follow doesn't stop the other sandboxes from moving", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s1 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const s2 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    for (const s of [s1, s2]) await sandboxStub(s.sandbox).reportState(a.host, 1, "running", null, null);
    await sandboxStub(s1.sandbox).attach("agt_doesnotexist0000000000000");
    const b = await connectHost(cell);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    for (const s of [s1, s2]) expect(await sandboxStub(s.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
  });

  it("without capacity, the sandbox waits and is placed by its own retry alarm", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s1 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await sandboxStub(s1.sandbox).reportState(a.host, 1, "running", null, null);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    // No host could take it, so no epoch was spent: the dead host's lease (epoch 1) is still the last one.
    expect(await sandboxStub(s1.sandbox).info()).toMatchObject({ host: null, epoch: 1 });
    const b = await connectHost(cell);
    await runInDurableObject(sandboxStub(s1.sandbox), (_i, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'");
    });
    await runDue(sandboxStub(s1.sandbox));
    expect(await sandboxStub(s1.sandbox).info()).toMatchObject({ host: b.host, epoch: 2 });
  });
});

describe("#5 at-least-once, in order", () => {
  it("a failed batch closes the channel; a later batch is never acked over it; the resend is processed", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const bad = { ts_ms: Date.now(), type: "commit_request", request: "req_x", sandbox: "sbx_nope0000000000000000000000", epoch: 1, kind: "disk_only", disk_manifest: manifest("a"), reason: "timer" };
    const capacity = { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 1, memory_mib_free: 1, hugepages_mib_free: 1, sandboxes: 0, agents: 0, warm: [] } };
    sendEvents(h.ws, [capacity], 1);
    await h.ws.next("ack", (m) => m.up_to === 1);
    sendEvents(h.ws, [bad], 2);
    expect((await h.ws.next("error")).error.retryable).toBe(true);
    expect((await h.ws.whenClosed())?.code).toBe(4500);

    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell));
    expect((await ws2.next("hello_ack")).last_event_seq).toBe(1);
    sendEvents(ws2, [capacity], 3); // skipping 2 is a gap
    expect((await ws2.next("error")).error.message).toMatch(/out of order/);
    expect((await ws2.whenClosed())?.code).toBe(4409);

    const ws3 = await Ws.connect("/v1/fleet", h.host_token);
    ws3.send(hostHello(h.host, cell));
    await ws3.next("hello_ack");
    sendEvents(ws3, [capacity], 2);
    expect((await ws3.next("ack")).up_to).toBe(2);
  });
});

describe("#6 STONITH by fence can't stall", () => {
  it("a failed stonith fence is re-issued until it succeeds", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    const a = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await runInDurableObject(fleet, (inst: FleetDO, st) => {
      inst.ec2Override = null;
      st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, a.host);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    a.ws.close();
    await runDue(fleet);
    const back = await Ws.connect("/v1/fleet", a.host_token);
    back.send(hostHello(a.host, cell, { instance_id: "nestdtest0000001" }));
    await back.next("hello_ack");
    const [fence1] = await nextCommands(back, (c) => c.type === "fence");
    const seq = sendEvents(back, [{ ts_ms: Date.now(), type: "command_result", cmd: fence1.cmd, outcome: { status: "error", error: { code: "internal", message: "busy", retryable: true } } }]);
    const [fence2] = await nextCommands(back, (c) => c.type === "fence" && c.cmd !== fence1.cmd);
    await back.next("ack", (m) => m.up_to >= seq);
    expect(fence2.sandboxes).toEqual([sbx.sandbox]);
    await okResult(back, fence2.cmd);
    expect((await sandboxStub(sbx.sandbox).info()).epoch).toBe(2);
  });
});

describe("#7 session WebSocket authorization", () => {
  it("a host the agent isn't assigned to can't attach, nor can anyone before the agent starts", async () => {
    const s = await setup({ start: false });
    const other = await connectHost(uniqueCell());
    const r1 = await SELF.fetch(`${BASE}/v1/agents/${s.agent}/session`, { headers: { upgrade: "websocket", authorization: `Bearer ${other.host_token}` } });
    expect(r1.status).toBe(403);
    const r2 = await SELF.fetch(`${BASE}/v1/agents/${s.agent}/session`, { headers: { upgrade: "websocket", authorization: `Bearer ${s.host.host_token}` } });
    expect(r2.status).toBe(403); // not started: no host assigned yet
  });

  it("a dead host can't attach even with a valid token", async () => {
    const s = await setup();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    const r = await SELF.fetch(`${BASE}/v1/agents/${s.agent}/session`, { headers: { upgrade: "websocket", authorization: `Bearer ${s.host.host_token}` } });
    expect(r.status).toBe(403);
  });
});

describe("#8 tool calls cut off by an eviction", () => {
  it("a call left dispatching (no outcome) is run again when redelivered", async () => {
    const s = await setup({ captain: true });
    // Simulate an eviction mid-dispatch: the row exists, the seq was never marked processed.
    await runInDurableObject(agentStub(s.agent), (_i, st) => {
      st.storage.sql.exec("INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (1, 'cal_e-1', 'read_transcript', 'dispatching', NULL, 0)");
    });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall(1, "cal_e-1", "read_transcript", { agent: s.agent }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_e-1")).outcome.status).toBe("ok");
  });
});

describe("#9 no secrets at rest outside BrokerDO", () => {
  it("stored command bodies hold references; the host receives the value", async () => {
    const s = await setup({ start: false });
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    expect(start.oauth_token).toBe("sk-ant-oat01-regress");
    const stored = await runInDurableObject(fleetStub(s.cell), (_i, st) =>
      st.storage.sql.exec<{ body: string }>("SELECT body FROM commands UNION ALL SELECT body FROM rel_out").toArray().map((r) => r.body).join("\n"));
    expect(stored).not.toContain("sk-ant-oat01-regress");
    expect(stored).toContain("$nest-secret:claude_oauth_token");
  });

  it("injection secrets travel by reference too (policy set through the admin API)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await adminJson("/v1/admin/secrets/inject:github", { method: "PUT", body: { value: "ghs_REALVALUE" } });
    const sbx = await adminJson("/v1/sandboxes", {
      body: { cell, policy: { allow: [{ host: "api.example.com" }], inject: [{ name: "github", hosts: ["api.github.com"], placeholder: "nest-ph-github-1", locations: [{ type: "authorization_bearer" }] }] } },
    }, 201);
    const [secrets] = await nextCommands(h.ws, (c) => c.type === "secrets_update");
    expect(secrets.secrets[0]).toMatchObject({ binding: "github", value: "ghs_REALVALUE" });
    const stored = await runInDurableObject(fleetStub(cell), (_i, st) =>
      st.storage.sql.exec<{ body: string }>("SELECT body FROM commands").toArray().map((r) => r.body).join("\n"));
    expect(stored).not.toContain("ghs_REALVALUE");
    const updated = await adminJson(`/v1/sandboxes/${sbx.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "api.stripe.com" }], passthrough: ["pinned.example.com"], tcp: [{ host: "db.example.com", port: 5432 }] } });
    expect(updated).toMatchObject({ passthrough: ["pinned.example.com"], tcp: [{ host: "db.example.com", port: 5432 }] });
    const [pu] = await nextCommands(h.ws, (c) => c.type === "policy_update");
    expect(pu.policy.allow.some((r: { host: string }) => r.host === "api.stripe.com")).toBe(true);
  });
});

describe("#11 a new session file starts a new receive stream", () => {
  it("keeps the committed base resumable until the new session is durable", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token);
    r1.ws.send(seg(0, "old\n"));
    await received(s.agent, 4);
    await agentStub(s.agent).flush();
    r1.ws.close();
    const r2 = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1, { session: SESSION2, local_bytes: 9 });
    expect(r2.ack.durable_bytes).toBe(0);
    r2.ws.send(seg(0, "new one\n", false, SESSION2));
    await received(s.agent, 8);
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe("old\n");
    await agentStub(s.agent).flush();
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe("new one\n");
    expect((await agentStub(s.agent).info()).session).toBe(SESSION2);
  });
});

describe("#12 host events are scoped to the reporting host", () => {
  it("an agent_exited from a host the agent no longer runs on is ignored", async () => {
    const s = await setup();
    const other = await connectHost(s.cell);
    const seq = sendEvents(other.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stale" }]);
    await other.ws.next("ack", (m) => m.up_to >= seq);
    expect((await agentStub(s.agent).info()).state).toBe("starting");
  });

  it("a sandbox event about a sandbox the host doesn't hold is dropped; the holder's is logged", async () => {
    const s = await setup();
    const other = await connectHost(s.cell);
    const warn = vi.spyOn(console, "warn");
    try {
      const alert = { ts_ms: Date.now(), sandbox: s.sandbox, epoch: 1, type: "egress_alert", host: "evil.example", reason: "domain_fronting" };
      const seq = sendEvents(other.ws, [{ ts_ms: Date.now(), type: "workstream", event: alert }]);
      await other.ws.next("ack", (m) => m.up_to >= seq);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`dropping egress_alert from ${other.host}`));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("egress_alert evil.example"));
      // The holder's, with the compat `workstream` an older host echoes.
      const seq2 = sendEvents(s.sbxHost.ws, [{ ts_ms: Date.now(), type: "workstream", event: { ...alert, workstream: `ws_${s.sandbox.slice(4)}` } }]);
      await s.sbxHost.ws.next("ack", (m) => m.up_to >= seq2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${s.sandbox}@1 egress_alert evil.example (domain_fronting)`));
    } finally {
      warn.mockRestore();
    }
  });

  it("a salvage commit is accepted only from the host that held that epoch", async () => {
    const s = await setup();
    const other = await connectHost(s.cell);
    await sandboxStub(s.sandbox).reportState(s.host.host, 1, "running", null, null);
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    const salvage = (request: string) => ({ ts_ms: Date.now(), type: "commit_request", request, sandbox: s.sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("c"), reason: "salvage" });
    sendEvents(other.ws, [salvage("req_s1")]);
    const [r] = await nextCommands(other.ws, (c) => c.type === "commit_result" && c.request === "req_s1");
    expect(r.outcome).toMatchObject({ status: "rejected", reason: "stale_epoch" });
  });
});

describe("#13 a nestd restart doesn't fail live sandboxes", () => {
  it("a pending create reported by the new process completes; an unreported one is re-issued", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const s1 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const s2 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create" && c.sandbox === s2.sandbox);
    const restarted = await Ws.connect("/v1/fleet", h.host_token);
    restarted.send(hostHello(h.host, cell, { instance_id: "nestd-restarted", sandboxes: [{ sandbox: s1.sandbox, epoch: 1, state: "running", dirty: false }] }));
    await restarted.next("hello_ack");
    // The unreported one is gone with the old process: placed again under a new epoch.
    const [again] = await nextCommands(restarted, (c) => c.type === "sandbox_create");
    expect(again).toMatchObject({ sandbox: s2.sandbox, epoch: 2 });
    await eventually("the reported sandbox running", async () => (await sandboxStub(s1.sandbox).info()).state === "running");
    expect((await sandboxStub(s2.sandbox).info()).state).not.toBe("failed");
  });
});

describe("#14 a host disconnected past token expiry can reconnect", () => {
  it("an expired token (within the grace window) opens the fleet channel and is rotated at hello", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    const expired = await issueHostToken("test-host-token-secret-0123456789abcdef", { host: h.host, cell, role: "sandbox", exp: Date.now() - 60_000 });
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET token_exp = ? WHERE host = ?", Date.now() - 60_000, h.host);
    });
    const ws = await Ws.connect("/v1/fleet", expired);
    ws.send(hostHello(h.host, cell));
    await ws.next("hello_ack");
    expect((await ws.next("host_token")).expires_ms).toBeGreaterThan(Date.now());
    // The session channel takes no grace.
    const r = await SELF.fetch(`${BASE}/v1/agents/agt_x/session`, { headers: { upgrade: "websocket", authorization: `Bearer ${expired}` } });
    expect(r.status).toBe(401);
  });
});

describe("#15 AWS enrollment binds the role; a bad CSR doesn't burn a token", () => {
  it("rejects an instance enrolling as another role than it was launched as", async () => {
    const cell = uniqueCell();
    const fleet = fleetStub(cell);
    await fleet.registerLaunched({ instance_id: "i-0burst", role: "sandbox", account_id: "111", region: "us-east-1" });
    const req = { protocol_version: 1, role: "brain" as const, cell, proof: { type: "aws_identity_document" as const, document_b64: "", pkcs7_b64: "" }, proxy_ca_csr_pem: await csrPem() };
    await expect(Promise.resolve().then(() => fleet.enroll(req, cell, { instanceId: "i-0burst", accountId: "111", region: "us-east-1" }))).rejects.toThrow(/launched as sandbox/);
    await expect(Promise.resolve().then(() => fleet.enroll({ ...req, role: "sandbox" }, cell, { instanceId: "i-0burst", accountId: "222", region: "us-east-1" }))).rejects.toThrow(/another AWS account/);
    expect((await fleet.enroll({ ...req, role: "sandbox" }, cell, { instanceId: "i-0burst", accountId: "111", region: "us-east-1" })).host).toMatch(/^hst_/);
  });

  it("a malformed CSR leaves the enrollment token usable", async () => {
    const cell = uniqueCell();
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "sandbox", cell } });
    const enroll = (csr: string) => SELF.fetch(`${BASE}/v1/hosts/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, role: "sandbox", cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: csr }),
    });
    expect((await enroll("not a csr")).status).not.toBe(200);
    expect((await enroll(await csrPem())).status).toBe(200);
  });
});

describe("#16 prompt-injection blast radius", () => {
  it("read_transcript can't read an agent it doesn't own", async () => {
    const a = await setup({ captain: true });
    const b = await setup();
    const { ws } = await runner(a.agent, a.host.host, a.host.host_token);
    ws.send(toolCall(1, "cal_n-1", "read_transcript", { agent: b.agent }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_n-1")).outcome.error.code).toBe("forbidden");
  });
});

describe("#17/#14 read_transcript pages by entry", () => {
  it("returns entries after since_seq with the next seq", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "l1\nl2\nl3\nl4\n"));
    await received(s.agent, 12);
    await agentStub(s.agent).flush();
    ws.send(toolCall(1, "cal_r-1", "read_transcript", { agent: s.agent, since_seq: 1, limit: 2 }));
    const r = await ws.next("tool_result", (m) => m.call === "cal_r-1");
    expect(r.outcome.content[0].text).toBe("l2\nl3");
    expect(r.outcome.content[1].value).toEqual({ entries: 2, next_seq: 3, more: true, base: 0 });
    const page = await adminJson(`/v1/agents/${s.agent}/transcript?since=3&base=0`);
    expect(page).toEqual({ lines: ["l4"], next_seq: 4, more: false, base: 0 });

    // The file is rewritten (e.g. trimmed after compaction): an old cursor would skip entries, so a
    // reader holding one starts the new base from the top, told so.
    const base = (await agentStub(s.agent).info()).recv_base;
    ws.send(seg(0, "n1\nn2\n", true));
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    const after = await adminJson(`/v1/agents/${s.agent}/transcript?since=4&base=0`);
    expect(after).toEqual({ lines: ["n1", "n2"], next_seq: 2, more: false, base: 1, reset: true });
    expect(await adminJson(`/v1/agents/${s.agent}/transcript?since=1&base=1`)).toEqual({ lines: ["n2"], next_seq: 2, more: false, base: 1 });
  });
});

describe("sweep bug 5: a rewrite that arrives in several segments is committed only whole", () => {
  it("streamCommittable: all received is durable, and at least the rewrite's stated length (pure)", () => {
    // [recv_durable, received_bytes, recv_total, committable]
    const table: [number, number, number | undefined, boolean][] = [
      [6, 6, undefined, true], // an older runner: as before
      [4, 6, undefined, false],
      [6, 6, 12, false], // the first of two segments, durable: not yet
      [12, 12, 12, true],
      [10, 12, 12, false],
      [20, 20, 12, true], // the file grew past the rewrite
      [0, 0, 0, true],
    ];
    for (const [recv_durable, received_bytes, recv_total, want] of table) {
      expect(streamCommittable({ recv_durable, received_bytes, ...(recv_total !== undefined ? { recv_total } : {}) }), `${recv_durable}/${received_bytes}/${recv_total}`).toBe(want);
    }
  });

  it("a flush between a rewrite's segments keeps the old base resumable; the last segment commits it", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    const old = "o1\no2\no3\n";
    ws.send(seg(0, old));
    await received(s.agent, old.length);
    await agentStub(s.agent).flush();
    const base = (await agentStub(s.agent).info()).base_gen;
    // A compaction rewrite, in two segments; only the first says it is a base, and how long the rewrite is.
    ws.send({ ...seg(0, "n1\nn2\n", true), total_bytes: 12 });
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    // Durable, but not the base yet: transcripts and a resume still read the complete old file.
    expect(await agentStub(s.agent).transcript()).toBe(old);
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base, durable_bytes: old.length, recv_durable: 6 });
    ws.send(seg(6, "n3\nn4\n"));
    await received(s.agent, 12, base + 1);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).transcript()).toBe("n1\nn2\nn3\nn4\n");
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base + 1, durable_bytes: 12 });
  });

  it("a rewrite that never completes is dropped when a new runner comes: it appends to the old base, never spliced into the partial rewrite", async () => {
    const s = await setup({ captain: true });
    const first = await runner(s.agent, s.host.host, s.host.host_token);
    const old = "o1\no2\no3\no4\n";
    first.ws.send(seg(0, old));
    await received(s.agent, old.length);
    await agentStub(s.agent).flush();
    const base = (await agentStub(s.agent).info()).base_gen;
    // The first of a two-segment rewrite arrives and is made durable; the brain dies before the second.
    first.ws.send({ ...seg(0, "n1\nn2\n", true), total_bytes: 12 });
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    const partial = await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ key: string }>("SELECT key FROM segments WHERE base = ?", base + 1).toArray().map((r) => r.key));
    expect(partial).toHaveLength(1);
    expect(await env.BUCKET.head(partial[0]!)).not.toBeNull();
    first.ws.close();

    // A new runner process (the restarted brain, resumed from the old base): told the base's durable bytes.
    const next = await runner(s.agent, s.host.host, s.host.host_token, "rin_two");
    expect(next.ack.durable_bytes).toBe(old.length);
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base, recv_base: base, recv_durable: old.length, received_bytes: old.length });
    expect((await agentStub(s.agent).info()).recv_total).toBeUndefined();
    // Its tailer goes on from there, in the old file.
    next.ws.send(seg(old.length, "o5\n"));
    await received(s.agent, old.length + 3);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).transcript()).toBe(`${old}o5\n`);
    // The partial rewrite's rows and stored bytes are gone, and its number is never used again.
    expect(await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM segments WHERE base > ?", base).toArray().length + st.storage.sql.exec("SELECT 1 FROM seg_buffer WHERE base > ?", base).toArray().length)).toBe(0);
    await eventually("the partial rewrite's bytes deleted", async () => (await env.BUCKET.head(partial[0]!)) === null);
    next.ws.send({ ...seg(0, "m1\n", true), total_bytes: 3 });
    await received(s.agent, 3, base + 2);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base + 2 });
    expect(await agentStub(s.agent).transcript()).toBe("m1\n");
  });

  it("the same runner reconnecting mid-rewrite keeps it: it's told the rewrite's durable bytes and finishes it", async () => {
    const s = await setup({ captain: true });
    const first = await runner(s.agent, s.host.host, s.host.host_token);
    first.ws.send(seg(0, "o1\no2\no3\no4\n"));
    await received(s.agent, 12);
    await agentStub(s.agent).flush();
    const base = (await agentStub(s.agent).info()).base_gen;
    first.ws.send({ ...seg(0, "n1\nn2\n", true), total_bytes: 12 });
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    first.ws.close();
    // The same process, its link dropped: its tailer is still in the rewritten file.
    const again = await runner(s.agent, s.host.host, s.host.host_token);
    expect(again.ack.durable_bytes).toBe(6);
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base, recv_base: base + 1, recv_total: 12 });
    again.ws.send(seg(6, "n3\nn4\n"));
    await received(s.agent, 12, base + 1);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base + 1 });
    expect(await agentStub(s.agent).transcript()).toBe("n1\nn2\nn3\nn4\n");
  });

  it("a brain started from the committed base drops a half-received rewrite at the start itself", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    const old = "o1\no2\no3\no4\n";
    ws.send(seg(0, old));
    await received(s.agent, old.length);
    await agentStub(s.agent).flush();
    const base = (await agentStub(s.agent).info()).base_gen;
    ws.send({ ...seg(0, "n1\nn2\n", true), total_bytes: 12 });
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    // The start's own step (its `resume` is the committed base's), before any runner says hello.
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      await (inst as unknown as { issueStart: (h: string, ref: string, resume: undefined, intent: { reason: string }) => Promise<unknown> })
        .issueStart(s.host.host, "$nest-secret:claude_oauth_token", undefined, { reason: "restart" });
    });
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base, recv_base: base, recv_durable: old.length, received_bytes: old.length });
    expect(await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM segments WHERE base > ?", base).toArray().length)).toBe(0);
    expect(await agentStub(s.agent).transcript()).toBe(old);
  });

  it("a stated length doesn't outlive its rewrite: a later rewrite without one commits at its first durable segment", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send({ ...seg(0, "a1\na2\na3\na4\n", true), total_bytes: 12 });
    const base = (await eventually("the rewrite received", async () => {
      const i = await agentStub(s.agent).info();
      return i.received_bytes === 12 ? i : null;
    })).recv_base;
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).info()).toMatchObject({ base_gen: base, recv_total: 12 });
    // A shorter rewrite with no length (a runner of the previous release): the old 12 must not hold it back.
    ws.send(seg(0, "b1\n", true));
    await received(s.agent, 3, base + 1);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).transcript()).toBe("b1\n");
    expect((await agentStub(s.agent).info()).recv_total).toBeUndefined();
  });

  it("a runner of the previous release (no total_bytes) is committed as before, at the first durable segment", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "o1\no2\no3\n"));
    await received(s.agent, 9);
    await agentStub(s.agent).flush();
    const base = (await agentStub(s.agent).info()).base_gen;
    ws.send(seg(0, "n1\nn2\n", true));
    await received(s.agent, 6, base + 1);
    await agentStub(s.agent).flush();
    expect(await agentStub(s.agent).transcript()).toBe("n1\nn2\n");
  });
});

describe("#18 argument validation", () => {
  it("enforces numeric bounds", async () => {
    const s = await setup();
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall(1, "cal_v-1", "expose_port", { port: 70000 }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_v-1")).outcome.error.message).toMatch(/<= 65535/);
  });
});

describe("#19 cells", () => {
  it("rejects malformed cell names", async () => {
    const res = await admin("/v1/admin/enrollment-tokens", { body: { role: "sandbox", cell: "../../evil" } });
    expect(res.status).toBe(400);
  });
});

describe("#20 deadlines survive a failing handler", () => {
  it("keeps a key whose handler threw and retries it later", async () => {
    const s = await setup();
    await runInDurableObject(agentStub(s.agent), async (_i, st) => {
      const d = new Deadlines(st.storage.sql, st.storage);
      await d.set("x", 1);
      await d.runDue(Date.now(), async () => {
        throw new Error("boom");
      });
      expect(d.has("x")).toBe(true);
      await d.runDue(Date.now() + 10_000, async () => undefined);
      expect(d.has("x")).toBe(false);
    });
  });
});

describe("#21 a deadline re-armed while it runs isn't dropped", () => {
  it("keeps a keepEarlier re-arm made by the key's own handler", async () => {
    const s = await setup();
    await runInDurableObject(agentStub(s.agent), async (_i, st) => {
      const d = new Deadlines(st.storage.sql, st.storage);
      await d.set("x", 1);
      await d.runDue(Date.now(), async () => {
        await d.set("x", Date.now() + 60_000, true);
      });
      expect(d.has("x")).toBe(true);
    });
  });

  // A bare object to hold a deadlines table: an MCP connector nothing else addresses (it arms nothing of its own).
  const bare = () => env.MCP_CONNECTOR.get(env.MCP_CONNECTOR.idFromName(`~deadlines-${crypto.randomUUID()}`));

  it("the arm-if-absent idiom inside the key's own handler re-arms it (a running key isn't armed)", async () => {
    await runInDurableObject(bare(), async (_i, st) => {
      const d = new Deadlines(st.storage.sql, st.storage);
      await d.set("x", 1);
      await d.runDue(Date.now(), async () => {
        if (!d.has("x")) await d.set("x", Date.now() + 60_000);
      });
      expect(d.has("x")).toBe(true);
    });
  });

  it("a re-arm for the very time being run survives (the handler asked to run again)", async () => {
    await runInDurableObject(bare(), async (_i, st) => {
      const d = new Deadlines(st.storage.sql, st.storage);
      await d.set("x", 5);
      let runs = 0;
      await d.runDue(Date.now(), async () => {
        runs++;
        await d.set("x", 5);
      });
      expect(runs).toBe(1);
      expect(st.storage.sql.exec("SELECT at FROM deadlines WHERE key = 'x'").toArray()).toEqual([{ at: 5 }]);
    });
  });

  it("a key cleared or moved by an earlier key's handler doesn't run from the stale snapshot", async () => {
    await runInDurableObject(bare(), async (_i, st) => {
      const d = new Deadlines(st.storage.sql, st.storage);
      await d.set("a", 1);
      await d.set("b", 2);
      await d.set("c", 3);
      const later = Date.now() + 60_000;
      const ran: string[] = [];
      await d.runDue(Date.now(), async (k) => {
        ran.push(k);
        if (k === "a") {
          await d.clear("b");
          await d.set("c", later);
        }
      });
      expect(ran).toEqual(["a"]);
      expect(st.storage.sql.exec("SELECT key, at FROM deadlines ORDER BY key").toArray()).toEqual([{ key: "c", at: later }]);
    });
  });

  it("an unplaced sandbox keeps retrying while there is no capacity", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s1 = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await sandboxStub(s1.sandbox).reportState(a.host, 1, "running", null, null);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    const retryNow = async () => {
      await runInDurableObject(sandboxStub(s1.sandbox), (_i, st) => {
        st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'");
      });
      await runDue(sandboxStub(s1.sandbox));
    };
    await retryNow(); // still no capacity
    expect(await sandboxStub(s1.sandbox).info()).toMatchObject({ host: null });
    const b = await connectHost(cell);
    await retryNow();
    expect((await sandboxStub(s1.sandbox).info()).host).toBe(b.host);
  });
});

describe("#22 a detached agent with waiting work gets a brain", () => {
  const exited = (s: { host: { ws: Ws } }, agent: string, reason: string) =>
    sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent, reason }]);
  const isStart = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;

  it("a turn for a brain that idled out starts it again", async () => {
    const s = await setup();
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.close();
    const seq = exited(s, s.agent, "idle");
    await s.host.ws.next("ack", (m) => m.up_to === seq);
    expect((await agentStub(s.agent).info()).state).toBe("detached");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "wake up" } }, 201);
    const [start] = await nextCommands(s.host.ws, isStart(s.agent));
    // A new start, a new agent epoch.
    expect(start).toMatchObject({ epoch: 2, hands: { sandbox: s.sandbox } });
  });

  it("a brain that dies mid-turn restarts; after repeated crashes only new input retries", async () => {
    const s = await setup();
    let r = await runner(s.agent, s.host.host, s.host.host_token, "rin_c0");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await r.ws.next("run_turn");
    for (let i = 1; i <= 3; i++) {
      r.ws.close();
      const seq = exited(s, s.agent, "crashed");
      await s.host.ws.next("ack", (m) => m.up_to === seq);
      const start = (await nextCommands(s.host.ws, isStart(s.agent))).find(isStart(s.agent));
      expect(start.epoch).toBe(i + 1);
      r = await runner(s.agent, s.host.host, s.host.host_token, `rin_c${i}`, start.epoch);
      await r.ws.next("run_turn", (m) => m.input.kind === "recovery");
    }
    r.ws.close();
    const seq = exited(s, s.agent, "crashed");
    await s.host.ws.next("ack", (m) => m.up_to === seq);
    expect((await agentStub(s.agent).info()).state).toBe("errored");
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStart(s.agent)))).toBe(true);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "try again" } }, 201);
    await nextCommands(s.host.ws, isStart(s.agent));
  });

  it("a restarted brain resumes from every byte received, not only what was flushed", async () => {
    const s = await setup();
    const r = await runner(s.agent, s.host.host, s.host.host_token);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await r.ws.next("run_turn");
    r.ws.send(seg(0, "l1\nl2\n"));
    await received(s.agent, 6);
    expect(await agentStub(s.agent).info()).toMatchObject({ received_bytes: 6, durable_bytes: 0 });
    r.ws.close();
    const seq = exited(s, s.agent, "crashed");
    await s.host.ws.next("ack", (m) => m.up_to === seq);
    const [start] = await nextCommands(s.host.ws, isStart(s.agent));
    expect(start.resume).toMatchObject({ session: SESSION, total_bytes: 6 });
  });

  it("a stopped brain isn't restarted by its exit", async () => {
    const s = await setup();
    const r = await runner(s.agent, s.host.host, s.host.host_token);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await r.ws.next("run_turn");
    r.ws.close();
    const seq = exited(s, s.agent, "stopped");
    await s.host.ws.next("ack", (m) => m.up_to === seq);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStart(s.agent)))).toBe(true);
  });
});

describe("#23 captains move off a silent brain host", () => {
  it("a captain mid-turn restarts on another brain host", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-regress" } });
    const a = await connectHost(cell, "brain");
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", cell } }, 201)).agent as string;
    await nextCommands(a.ws, (c) => c.type === "agent_start" && c.agent === captain);
    const r = await runner(captain, a.host, a.host_token, "rin_cap", 1);
    await adminJson(`/v1/agents/${captain}/turns`, { body: { text: "plan" } }, 201);
    await r.ws.next("run_turn");
    const b = await connectHost(cell, "brain");
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, a.host);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDue(fleetStub(cell));
    await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === captain);
    expect((await agentStub(captain).info()).host).toBe(b.host);
    expect((await r.ws.whenClosed())?.code).toBe(4409);
  });
});

describe("docs #13 guest CLI mapping", () => {
  it("unexposes; notify and emit (a previous release's guest) answer unknown_tool", async () => {
    const s = await setup({ captain: true });
    const stub = agentStub(s.agent);
    expect(await stub.guestCli(s.sandbox, 1, { command: "notify", to: "captain", message: "m", urgency: "low" })).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    expect(await stub.guestCli(s.sandbox, 1, { command: "emit", event: "progress", payload: null })).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    expect((await stub.guestCli(s.sandbox, 1, { command: "expose", port: 3000, exposed: false })).status).toBe("ok");
    const [un] = await nextCommands(s.sbxHost.ws, (c) => c.type === "port_unexpose");
    expect(un).toMatchObject({ sandbox: s.sandbox, port: 3000 });
  });
});

describe("docs #8 hello.agents reconciliation", () => {
  it("a started brain the host no longer reports is marked detached; a reported one is kept", async () => {
    const s = await setup({ start: false });
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    await okResult(s.host.ws, start.cmd);
    const again = await Ws.connect("/v1/fleet", s.host.host_token);
    again.send(hostHello(s.host.host, s.cell, { agents: [] }));
    await again.next("hello_ack");
    await eventually("the brain marked detached", async () => (await agentStub(s.agent).info()).state === "detached");
    // Gone, at its start's epoch: the agent no longer has a host there.
    expect(await agentStub(s.agent).info()).toMatchObject({ state: "detached", host: null });

    // A brain AgentDO took for detached that the host does report is kept.
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.brain = { host: s.host.host, epoch: info.agent_epoch, phase: "live", since_ms: Date.now() };
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    const third = await Ws.connect("/v1/fleet", s.host.host_token);
    third.send(hostHello(s.host.host, s.cell, { agents: [{ agent: s.agent, state: "idle" }] }));
    await third.next("hello_ack");
    await eventually("the reported brain kept", async () => (await agentStub(s.agent).info()).state === "idle");
  });
});

describe("#24 a platform tool re-run after an eviction repeats no side effect", () => {
  it("agent_spawn applies once when a call is dispatched again: one child, its task posted once", async () => {
    const s = await setup();
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.tools = [...info.tools, "agent_spawn"];
      info.spawn = ["captain"];
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    const args = { template: "captain", task: "hello once" };
    ws.send(toolCall(1, "cal_i-1", "agent_spawn", args));
    const child = (await ws.next("tool_result", (m) => m.call === "cal_i-1")).outcome.content[1].value.agent as string;
    // An eviction mid-dispatch leaves the call without an outcome; the runner redelivers it.
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("UPDATE tool_calls SET status = 'dispatching', outcome = NULL");
    });
    ws.send(toolCall(2, "cal_i-1", "agent_spawn", args));
    expect((await ws.next("tool_result", (m) => m.call === "cal_i-1")).outcome.content[1].value.agent).toBe(child);
    expect((await agentStub(s.agent).children()).map((c) => c.agent)).toEqual([child]);
    const posted = await runInDurableObject(agentStub(child), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ input: string }>("SELECT input FROM turns").toArray().filter((r) => r.input.includes("hello once")).length);
    expect(posted).toBe(1);
  });
});

describe("#25 retried submissions are applied once", () => {
  it("a turn or inbox post with the same request id (body or Idempotency-Key) is queued once", async () => {
    const s = await setup({ start: false });
    const post = (path: string, body: unknown, key?: string) => SELF.fetch(`http://cp.test/v1/agents/${s.agent}/${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { authorization: "Bearer test-admin-token", "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    }).then((r) => r.json<any>());
    const t1 = await post("turns", { text: "do it", request_id: "r-1" });
    const t2 = await post("turns", { text: "do it", request_id: "r-1" });
    const t3 = await post("turns", { text: "do it" }, "r-2");
    const t4 = await post("turns", { text: "do it" }, "r-2");
    expect(t1.turn).toBe(t2.turn);
    expect(t3.turn).toBe(t4.turn);
    expect(t3.turn).not.toBe(t1.turn);
    const m1 = await post("inbox", { text: "fyi", request_id: "r-3" });
    const m2 = await post("inbox", { text: "fyi", request_id: "r-3" });
    expect(m1.message).toBe(m2.message);
    const turns = await agentStub(s.agent).turns();
    expect(turns.map((t) => t.input.text)).toEqual(["do it", "do it", "Message from user: fyi"]);
  });
});

describe("#26 a recovery turn says what the transcript can't", () => {
  it("names where the saved transcript ends and the sandbox state it was restored from, and survives a second restart", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, "rin_one");
    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "refactor the parser" } }, 201)).turn;
    await r1.ws.next("run_turn", (m) => m.turn === t1);
    r1.ws.send(seg(0, '{"type":"user"}\n'));
    await received(s.agent, 16);
    await agentStub(s.agent).flush();
    const durable = (await agentStub(s.agent).info()).durable_ms!;
    // The sandbox commits a generation, then moves (restored from that head) while the turn runs.
    sendEvents(s.sbxHost.ws, [{
      ts_ms: Date.now(), type: "commit_request", request: "req_rec", sandbox: s.sandbox, epoch: 1, kind: "disk_only",
      disk_manifest: manifest("e"), reason: "timer",
    }]);
    await nextCommands(s.sbxHost.ws, (c) => c.type === "commit_result" && c.request === "req_rec");
    const head = (await env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)).headGeneration())!;
    // Its host dies: the sandbox gets a new lease (epoch 2) on another sandbox host. The brain host
    // dies too, and the brain, which died with its own host, starts again on another brain host.
    const b = await connectHost(s.cell);
    const c2 = await connectHost(s.cell, "brain");
    s.sbxHost.ws.close();
    await adminJson(`/v1/admin/hosts/${s.sbxHost.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    expect(await sandboxStub(s.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
    s.host.ws.close();
    r1.ws.close();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    await nextCommands(c2.ws, (c) => c.type === "agent_start" && c.agent === s.agent && c.epoch === 2);
    // "Moved during the turn" is SandboxDO's epoch against the one recorded at turn start, not AgentDO's
    // record of the move push (which can be lost): forget that record.
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      delete info.hands_moved_ms;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });

    const r2 = await runner(s.agent, c2.host, c2.host_token, "rin_two", 2);
    const rec = await r2.ws.next("run_turn");
    expect(rec.input.kind).toBe("recovery");
    expect(rec.input.text).toContain(`saved transcript ends at ${new Date(durable).toISOString()}`);
    expect(rec.input.text).toContain(`restored from its state saved at ${new Date(head.created_ms).toISOString()}; running processes stopped`);
    expect(rec.input.text.endsWith("The turn was:\nrefactor the parser")).toBe(true);
    r2.ws.close();

    // Interrupted again: the next recovery turn still carries the original text, once.
    const r3 = await runner(s.agent, c2.host, c2.host_token, "rin_three", 2);
    const rec2 = await r3.ws.next("run_turn");
    expect(rec2.input.kind).toBe("recovery");
    expect(rec2.input.text.split("refactor the parser").length).toBe(2);
    // That recovery turn started after the move: no restore note this time.
    expect(rec2.input.text).not.toContain("restored from");
  });
});

describe("#27 a turn is work until it completes", () => {
  it("SessionStart's mid-turn `ready` neither ends the sandbox's work nor commits early; the turn's end does", async () => {
    const s = await setup();
    const seqh = sendEvents(s.sbxHost.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 1, state: "running" }]);
    await s.sbxHost.ws.next("ack", (m) => m.up_to >= seqh);
    const r = await runner(s.agent, s.host.host, s.host.host_token);
    const t = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "write a file" } }, 201)).turn;
    await r.ws.next("run_turn", (m) => m.turn === t);
    const ev = (seq: number, body: Record<string, unknown>) => ({ agent: s.agent, epoch: 1, seq, ts_ms: Date.now(), turn: t, ...body });
    r.ws.send({ type: "events", seq: 1, events: [ev(1, { type: "turn_started", input_kind: "user" }), ev(2, { type: "state_changed", state: "ready" })] });
    await r.ws.next("ack", (m) => m.up_to === 1);
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([s.agent]);
    expect(await s.sbxHost.ws.none("commands", 300, (m) => (m.commands as any[]).some((c) => c.type === "sandbox_checkpoint"))).toBe(true);

    r.ws.send({ type: "events", seq: 2, events: [ev(3, { type: "turn_completed", stop_reason: "end_turn" })] });
    await r.ws.next("ack", (m) => m.up_to === 2);
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([]);
    const [cp] = await nextCommands(s.sbxHost.ws, (c) => c.type === "sandbox_checkpoint");
    expect(cp).toMatchObject({ sandbox: s.sandbox, reason: "turn_end" });
  });
});

// FleetDO's two BrokerDO calls, routed through hooks that run first (a gate, a failure). Gates are
// module state polled on a timer, not promises: the hooks run in FleetDO's request context. A
// `resolveRefs` hook that returns values answers for BrokerDO (no call to it, so no I/O).
type BrokerHooks = {
  bindingPublicKeys?: () => Promise<void>;
  resolveRefs?: (refs: string[]) => Promise<void | Record<string, string | null>>;
};
async function hookBroker(cell: string, hooks: BrokerHooks): Promise<void> {
  await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
    const self = inst as unknown as { env: Cloudflare.Env };
    const real = self.env;
    const stub = () => real.BROKER.get(real.BROKER.idFromName("broker"));
    const broker = {
      bindingPublicKeys: async (c: string) => {
        await hooks.bindingPublicKeys?.();
        return stub().bindingPublicKeys(c);
      },
      resolveRefs: async (refs: string[], allow: readonly string[]) => {
        return (await hooks.resolveRefs?.(refs)) ?? stub().resolveRefs(refs, allow);
      },
    };
    self.env = Object.create(real, { BROKER: { value: { idFromName: () => undefined, get: () => broker } } }) as Cloudflare.Env;
  });
}

/** A hook that holds its caller until `released`, and records that it was entered. */
function gate() {
  const g = { entered: false, released: false, hook: async () => {} };
  g.hook = async () => {
    g.entered = true;
    while (!g.released) await new Promise((r) => setTimeout(r, 5));
  };
  return g;
}

async function until(what: string, pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

async function untilAsync(what: string, pred: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const fleetRows = <T,>(cell: string, q: string, ...args: SqlStorageValue[]) =>
  runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => st.storage.sql.exec(q, ...args).toArray() as T[]);

const fence = (reason: string) => ({ type: "fence" as const, sandboxes: [], reason });

/**
 * The seqs of the `commands` frames carrying `cmds`, in the order they reached the host, and any
 * repeat of one of them that follows within 150 ms (a batch sent twice on one connection).
 */
async function wireOrder(ws: Ws, cmds: string[]): Promise<number[]> {
  const want = new Set(cmds);
  const carries = (f: Record<string, any>) => (f.commands as { cmd: string }[]).some((c) => cmds.includes(c.cmd));
  const seqs: number[] = [];
  while (want.size) {
    const m = await ws.next("commands", (f) => (f.commands as { cmd: string }[]).some((c) => want.has(c.cmd)));
    for (const c of m.commands as { cmd: string }[]) want.delete(c.cmd);
    seqs.push(m.seq as number);
  }
  for (;;) {
    try {
      seqs.push((await ws.next("commands", carries, 150)).seq as number);
    } catch {
      return seqs;
    }
  }
}

const increasing = (seqs: number[]) => seqs.every((s, i) => i === 0 || s > seqs[i - 1]!);

describe("#28 command delivery across nestd reconnects", () => {
  it("a command issued to a new nestd process during its hello is not failed with the old process's", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const [old] = await fleetStub(cell).issueCommands(h.host, [fence("old")]);
    await h.ws.next("commands"); // the old process never answers it

    const keys = gate();
    await hookBroker(cell, { bindingPublicKeys: keys.hook });
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
    await ws2.next("hello_ack");
    await until("onHello to await BrokerDO", () => keys.entered);
    // Issued while onHello awaits: it goes to the new process.
    const [fresh] = await fleetStub(cell).issueCommands(h.host, [fence("new")]);
    await ws2.next("commands", (m) => m.commands[0].cmd === fresh);
    keys.released = true;
    // An event batch is queued behind the hello, so its ack means the hello is done.
    const seq = sendEvents(ws2, []);
    await ws2.next("ack", (m) => m.up_to === seq);

    expect(await fleetStub(cell).commandResult(old!)).toMatchObject({ status: "error", error: { retryable: true } });
    expect(await fleetStub(cell).commandResult(fresh!)).toBeNull();
    await okResult(ws2, fresh!);
    expect(await fleetStub(cell).commandResult(fresh!)).toEqual({ status: "ok" });
  });

  it("the old process's unanswered commands still fail when FleetDO restarts mid-hello", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const [old] = await fleetStub(cell).issueCommands(h.host, [fence("old")]);
    await h.ws.next("commands");

    const keys = gate();
    await hookBroker(cell, { bindingPublicKeys: keys.hook });
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
    await ws2.next("hello_ack");
    await until("onHello to await BrokerDO", () => keys.entered);
    // FleetDO restarts after the lineage reset and before the failures.
    await runInDurableObject(fleetStub(cell), (_i, st) => st.abort("restart mid-hello")).catch(() => undefined);
    keys.released = true;

    // The same process reconnects: the same instance_id, so no reset this time.
    const ws3 = await Ws.connect("/v1/fleet", h.host_token);
    ws3.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
    await ws3.next("hello_ack");
    const seq = sendEvents(ws3, []);
    await ws3.next("ack", (m) => m.up_to === seq);
    expect(await fleetStub(cell).commandResult(old!)).toMatchObject({ status: "error", error: { retryable: true } });
  });

  it("hello_ack.next_command_seq is the first seq sent on the connection", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const reconnect = async (extra: Record<string, unknown>) => {
      const ws = await Ws.connect("/v1/fleet", h.host_token);
      ws.send(hostHello(h.host, cell, extra));
      return { ws, ack: await ws.next("hello_ack") };
    };
    for (const r of ["a", "b", "c"]) await fleetStub(cell).issueCommands(h.host, [fence(r)]);
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) seqs.push((await h.ws.next("commands")).seq as number);

    // The same process, its batches unacked and the first one processed: the lowest unacked above it.
    const same = await reconnect({ last_command_seq: seqs[0] });
    expect(same.ack.next_command_seq).toBe(seqs[1]);
    expect((await same.ws.next("commands")).seq).toBe(seqs[1]);
    same.ws.send({ type: "ack", up_to: seqs[2] });

    // Nothing pending: the next seq to assign.
    const idle = await reconnect({ last_command_seq: seqs[2] });
    expect(idle.ack.next_command_seq).toBe(seqs[2]! + 1);
    await fleetStub(cell).issueCommands(h.host, [fence("d")]);
    expect((await idle.ws.next("commands")).seq).toBe(seqs[2]! + 1);

    // A new process: its lineage starts above everything the reset dropped.
    const fresh = await reconnect({ instance_id: "nestdtest0000002" });
    expect(fresh.ack.next_command_seq).toBe(seqs[2]! + 2);
  });

  it("a BrokerDO failure while sending an agent_start closes the socket; the reconnect resends it", async () => {
    const s = await setup({ start: false });
    const hooks: BrokerHooks = {
      resolveRefs: async () => {
        throw new Error("BrokerDO unavailable");
      },
    };
    await hookBroker(s.cell, hooks);
    const { cmd } = await agentStub(s.agent).start();
    expect((await s.host.ws.next("error")).error).toMatchObject({ code: "internal", retryable: true });
    await until("the socket to close", () => s.host.ws.closed !== null);
    expect(s.host.ws.closed?.code).toBe(4503);

    delete hooks.resolveRefs; // BrokerDO is back
    const ws2 = await Ws.connect("/v1/fleet", s.host.host_token);
    ws2.send(hostHello(s.host.host, s.cell));
    await ws2.next("hello_ack");
    const [start] = await nextCommands(ws2, (c) => c.cmd === cmd);
    expect(start).toMatchObject({ type: "agent_start", oauth_token: "sk-ant-oat01-regress" });
  });

  it("a hello whose socket closed while it waited in the host's queue doesn't supersede the live socket", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const keys = gate();
    await hookBroker(cell, { bindingPublicKeys: keys.hook });
    // A hello that holds the host's queue on BrokerDO.
    const busy = await Ws.connect("/v1/fleet", h.host_token);
    busy.send(hostHello(h.host, cell));
    await busy.next("hello_ack");
    await until("the queue to be held", () => keys.entered);
    // Hello A waits in the queue, and A drops before it runs.
    const a = await Ws.connect("/v1/fleet", h.host_token);
    a.send(hostHello(h.host, cell));
    a.close();
    await until("FleetDO to see A close", () => a.closed !== null);
    // The host reconnects on B; its hello waits behind A's.
    const b = await Ws.connect("/v1/fleet", h.host_token);
    b.send(hostHello(h.host, cell));
    keys.released = true;

    await b.next("hello_ack");
    expect(a.received.some((m) => m.type === "hello_ack")).toBe(false);
    const [cmd] = await fleetStub(cell).issueCommands(h.host, [fence("after")]);
    expect((await b.next("commands")).commands[0].cmd).toBe(cmd);
    expect(b.closed).toBeNull();
  });

  it("an old process's event batch queued behind the new process's hello doesn't become the new lineage's baseline", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const keys = gate();
    await hookBroker(cell, { bindingPublicKeys: keys.hook });
    // The old process reconnects on `old`; its hello holds the host's queue on BrokerDO.
    const old = await Ws.connect("/v1/fleet", h.host_token);
    old.send(hostHello(h.host, cell));
    await old.next("hello_ack");
    await until("the queue to be held", () => keys.entered);
    // The new process's hello queues next; then the old socket's batch 1 arrives while that socket
    // is still the helloed one, and queues behind it.
    const fresh = await Ws.connect("/v1/fleet", h.host_token);
    fresh.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
    await untilAsync("the new hello to wait in the queue", async () => (await inboundPending(cell, h.host)) === 2);
    sendEvents(old, [], 1);
    await untilAsync("the old batch to wait behind it", async () => (await inboundPending(cell, h.host)) === 3);
    keys.released = true;
    await fresh.next("hello_ack");

    // The new process's own batch 1 answers a command it ran.
    const [cmd] = await fleetStub(cell).issueCommands(h.host, [fence("new")]);
    await fresh.next("commands", (m) => m.commands[0].cmd === cmd);
    sendEvents(fresh, [{ ts_ms: Date.now(), type: "command_result", cmd, outcome: { status: "ok" } }], 1);
    await fresh.next("ack", (m) => m.up_to === 1);
    expect(await fleetStub(cell).commandResult(cmd!)).toEqual({ status: "ok" });
  });
});

/** A batch whose one secret reference FleetDO must resolve in BrokerDO before sending it. */
const secretBatch = () => ({
  type: "secrets_update" as const, sandbox: "sbx_nope0000000000000000000000", epoch: 1,
  secrets: [{ binding: "github", value: "$nest-secret:inject:github" }],
});

describe("#29 command batches go on the wire in seq order", () => {
  it("a batch issued while a hello awaits BrokerDO goes out after the hello's resend of a lower one", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await fleetStub(cell).issueCommands(h.host, [fence("a")]);
    const last = (await h.ws.next("commands")).seq as number;
    h.ws.close();
    await until("FleetDO to see the close", () => h.ws.closed !== null);
    const [resent] = await fleetStub(cell).issueCommands(h.host, [fence("b")]); // unacked while offline

    const keys = gate();
    await hookBroker(cell, { bindingPublicKeys: keys.hook });
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { last_command_seq: last }));
    await ws2.next("hello_ack");
    await until("onHello to await BrokerDO", () => keys.entered);
    const [fresh] = await fleetStub(cell).issueCommands(h.host, [fence("c")]);
    keys.released = true;
    expect(await wireOrder(ws2, [resent!, fresh!])).toEqual([last + 1, last + 2]);
  });

  it("a plain batch doesn't overtake a lower one awaiting BrokerDO for its secrets, and neither goes out twice", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const refs = gate();
    await hookBroker(cell, { resolveRefs: refs.hook });
    const secret = fleetStub(cell).issueCommands(h.host, [secretBatch()]);
    await until("the secret batch to await BrokerDO", () => refs.entered);
    const plain = fleetStub(cell).issueCommands(h.host, [fence("plain")]);
    await untilAsync("the plain batch to be stored", async () =>
      (await fleetRows(cell, "SELECT 1 FROM commands WHERE host = ? AND type = 'fence'", h.host)).length === 1);
    refs.released = true;
    const [[s], [p]] = await Promise.all([secret, plain]);
    expect(increasing(await wireOrder(h.ws, [s!, p!]))).toBe(true);
  });

  it("two agent_starts go out in seq order, once each, when their secrets resolve in reverse", async () => {
    const s = await setup({ start: false });
    const second = await adminJson("/v1/agents", { body: { role: "worker", sandbox: s.sandbox, cell: s.cell, start: false } }, 201);
    const first = gate();
    let calls = 0;
    await hookBroker(s.cell, { resolveRefs: async () => {
      if (calls++ === 0) await first.hook(); // the first start's secrets resolve last
    } });
    const a = agentStub(s.agent).start();
    await until("the first start to await BrokerDO", () => first.entered);
    const b = agentStub(second.agent).start();
    await untilAsync("the second start to be stored", async () =>
      (await fleetRows(s.cell, "SELECT 1 FROM commands WHERE agent = ? AND type = 'agent_start'", second.agent)).length === 1);
    first.released = true;
    const [{ cmd: ca }, { cmd: cb }] = await Promise.all([a, b]);
    expect(increasing(await wireOrder(s.host.ws, [ca!, cb!]))).toBe(true);
  });

  it("a BrokerDO failure holds back its batch and what follows, not a kill ahead of it, and closes", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await fleetStub(cell).issueCommands(h.host, [fence("a")]);
    const last = (await h.ws.next("commands")).seq as number;
    h.ws.close();
    await until("FleetDO to see the close", () => h.ws.closed !== null);
    const kill = { type: "agent_stop" as const, agent: "agt_01killaheadofsecret0000000", reason: "t", mode: "kill" as const, epoch: 1 };
    await fleetStub(cell).issueCommands(h.host, [kill]); // last + 1
    await fleetStub(cell).issueCommands(h.host, [secretBatch()]); // last + 2
    await fleetStub(cell).issueCommands(h.host, [fence("after")]); // last + 3

    await hookBroker(cell, { resolveRefs: async () => { throw new Error("BrokerDO unavailable"); } });
    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell, { last_command_seq: last }));
    await ws2.next("hello_ack");
    expect((await ws2.next("error")).error).toMatchObject({ code: "internal", retryable: true });
    await until("the socket to close", () => ws2.closed !== null);
    expect(ws2.closed?.code).toBe(4503);
    expect(ws2.received.filter((m) => m.type === "commands").map((m) => [m.seq, m.commands[0].type])).toEqual([[last + 1, "agent_stop"]]);
    // The next connection starts after it: the kill isn't sent twice.
    const ws3 = await Ws.connect("/v1/fleet", h.host_token);
    ws3.send(hostHello(h.host, cell, { last_command_seq: last + 1 }));
    expect((await ws3.next("hello_ack")).next_command_seq).toBe(last + 2);
  });

  it("issuing doesn't wait for the send: a kill is stored at once while an earlier batch awaits BrokerDO", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const refs = gate();
    await hookBroker(cell, { resolveRefs: refs.hook });
    const [secret] = await fleetStub(cell).issueCommands(h.host, [secretBatch()]);
    await until("the secret batch to await BrokerDO", () => refs.entered);
    // AgentDO's escalation issues kills by RPC: it gets the id back while the chain is held.
    const kill = await Promise.race([
      fleetStub(cell).issueKill(h.host, "agt_01killwhilechainheld00000", 1, "t"),
      sleep(5_000).then(() => "held"),
    ]);
    expect(kill).toMatch(/^cmd_/);
    refs.released = true;
    expect(increasing(await wireOrder(h.ws, [secret!, kill]))).toBe(true);
  });

  it("a run that throws closes its socket, so the hello resends what it didn't send", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    // An outbox row nothing can parse: the run that reaches it throws.
    await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => {
      const next = st.storage.sql.exec<{ next_out: number }>("SELECT next_out FROM rel_state WHERE chan = ?", h.host).toArray()[0]?.next_out ?? 1;
      st.storage.sql.exec("INSERT OR REPLACE INTO rel_state (chan, next_out, last_in) VALUES (?, ?, (SELECT last_in FROM rel_state WHERE chan = ?))", h.host, next + 1, h.host);
      st.storage.sql.exec("INSERT INTO rel_out (chan, seq, body) VALUES (?, ?, 'not json')", h.host, next);
    });
    await fleetStub(cell).issueCommands(h.host, [fence("behind it")]);
    expect((await h.ws.next("error")).error).toMatchObject({ code: "internal", retryable: true });
    await until("the socket to close", () => h.ws.closed !== null);
    expect(h.ws.closed?.code).toBe(4503);
  });

  it("the tick sends batches above what the socket was sent that no run carried", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    // Pushed without a run (as if the run was lost with a reset of this object).
    const seq = await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      const rel = (inst as unknown as { rel: { push(chan: string, make: (seq: number) => { seq: number }): { seq: number } } }).rel;
      return rel.push(h.host, (s) => ({ type: "commands", seq: s, commands: [{ cmd: "cmd_01tickcarried000000000000", issued_ms: Date.now(), ...fence("tick") }] })).seq;
    });
    expect(await h.ws.none("commands", 150)).toBe(true);
    await runInDurableObject(fleetStub(cell), async (_i: FleetDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
      await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
    });
    await runDue(fleetStub(cell));
    expect((await h.ws.next("commands", (m) => m.seq === seq)).commands[0].cmd).toBe("cmd_01tickcarried000000000000");
  });

  it("a socket being closed is not the host's: nothing more is sent on it", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    // Closed by FleetDO (a send failure, say): listed, CLOSING, until the peer answers.
    const current = await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
      const [ws] = st.getWebSockets(h.host);
      ws!.close(4503, "test");
      return (inst as unknown as { socketFor(host: string): WebSocket | undefined }).socketFor(h.host) ?? null;
    });
    expect(current).toBeNull();
  });

  it("a run whose socket was superseded while it resolved sends nothing there and doesn't revive it", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell); // socket A
    // A superseded socket stays listed (CLOSING) until its peer answers the close, an I/O event. So
    // A's run is released from inside B's hello, right after it superseded A, and resolves without
    // I/O: it resumes while A is still listed.
    const held: { entered: boolean; release?: () => void } = { entered: false };
    let calls = 0;
    await hookBroker(cell, {
      resolveRefs: async (refs) => {
        if (calls++ === 0) {
          held.entered = true;
          await new Promise<void>((r) => { held.release = r; });
        }
        return Object.fromEntries(refs.map((r) => [r, null]));
      },
      bindingPublicKeys: async () => held.release?.(), // B's hello, after superseding A
    });
    const issued = fleetStub(cell).issueCommands(h.host, [secretBatch()]);
    await until("the run on A to await BrokerDO", () => held.entered);
    const b = await Ws.connect("/v1/fleet", h.host_token);
    b.send(hostHello(h.host, cell));
    await b.next("hello_ack");
    const [cmd] = await issued;

    // B's own run sends it, once; A gets nothing; and B stays the host's socket.
    expect(await wireOrder(b, [cmd!])).toHaveLength(1);
    const onA = (c: string) => h.ws.received.filter((m) => m.type === "commands" && (m.commands as { cmd: string }[]).some((x) => x.cmd === c));
    expect(onA(cmd!)).toEqual([]);
    const [after] = await fleetStub(cell).issueCommands(h.host, [fence("after")]);
    expect(await wireOrder(b, [after!])).toHaveLength(1);
  });
});

/** Hold a new nestd process's hello on BrokerDO, then restart FleetDO: after the reset, before anything else. */
async function restartMidHello(cell: string, host: string, token: string, instance: string) {
  const keys = gate();
  await hookBroker(cell, { bindingPublicKeys: keys.hook });
  const ws = await Ws.connect("/v1/fleet", token);
  ws.send(hostHello(host, cell, { instance_id: instance }));
  await ws.next("hello_ack");
  await until("onHello to await BrokerDO", () => keys.entered);
  await runInDurableObject(fleetStub(cell), (_i, st) => st.abort("restart mid-hello")).catch(() => undefined);
  keys.released = true;
}

describe("#30 a nestd restart's capture outlives a FleetDO restart, not its host", () => {
  it("leases the old process held and the new one doesn't report are dropped by the next hello", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    await okResult(h.ws, create.cmd);
    await restartMidHello(cell, h.host, h.host_token, "nestdtest0000002");

    const ws = await Ws.connect("/v1/fleet", h.host_token);
    ws.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002" }));
    // Placed again under a new epoch (here: the one host there is).
    const [again] = await nextCommands(ws, (c) => c.type === "sandbox_create");
    expect(again).toMatchObject({ sandbox: sbx.sandbox, epoch: 2 });
  });

  it("is deleted when the host dies", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await fleetStub(cell).issueCommands(h.host, [fence("old")]);
    await restartMidHello(cell, h.host, h.host_token, "nestdtest0000002");
    const key = `orphaned_commands:${h.host}`;
    expect(await fleetRows(cell, "SELECT 1 FROM kv WHERE key = ?", key)).toHaveLength(1);
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    expect(await fleetRows(cell, "SELECT 1 FROM kv WHERE key = ?", key)).toHaveLength(0);
  });
});
