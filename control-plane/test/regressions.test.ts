// Regression tests for the control-plane review findings (one block per finding).
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { FleetDO } from "../src/do/fleet";
import { Deadlines } from "../src/lib/reliable";
import { issueHostToken } from "../src/lib/tokens";
import { bytesToB64 } from "../src/lib/util";
import {
  admin, adminJson, BASE, connectHost, csrPem, hostHello, manifest, nextCommands, okResult, sendEvents, sleep, uniqueCell, Ws,
} from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const SESSION2 = "ses_0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

async function workstream() {
  return (await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "x" } }, 201)).workstream;
}

async function setup(opts: { start?: boolean; captain?: boolean } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-regress" } });
  const host = await connectHost(cell);
  const ws = await workstream();
  let captain: string | undefined;
  if (opts.captain) {
    await connectHost(cell, "controller");
    captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream: ws, cell } }, 201)).agent;
  }
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "sandbox_create");
  const start = opts.start ?? true;
  const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream: ws, sandbox: sbx.sandbox, cell, start, ...(captain ? { captain } : {}) } }, 201);
  if (start) await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { cell, host, workstream: ws, sandbox: sbx.sandbox as string, agent: worker.agent as string, captain };
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
    const ws = await workstream();
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    expect(create.epoch).toBe(1);
    await connectHost(cell);
    const res = await admin(`/v1/sandboxes/${sbx.sandbox}/place`, { body: {} });
    expect(res.status).toBe(409);
    expect(await fleetStub(cell).leaseOf(sbx.sandbox)).toMatchObject({ host: a.host, epoch: 1 });
    await expect(Promise.resolve().then(() => fleetStub(cell).place({
      sandbox: sbx.sandbox, workstream: ws, epoch: 9, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 },
      policy: { version: 1, allow: [], passthrough: [], inject: [], tcp: [], limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 } },
    }))).rejects.toThrow(/already holds a lease/);
  });

  it("re-places a failed sandbox under a new epoch after fencing its old host", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const ws = await workstream();
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
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
      r1.ws.send(toolCall(i, `cal_a-${i}`, "emit", { event: "progress", summary: `p${i}` }));
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
    r2.ws.send(toolCall(1, "cal_b-1", "emit", { event: "progress", summary: "new" }));
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

describe("#3 no lost updates across awaits", () => {
  it("a flush interleaved with enqueueTurn keeps the running turn", async () => {
    const s = await setup();
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "a\n"));
    await sleep(50);
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      await Promise.all([inst.flush(), inst.enqueueTurn({ kind: "user", text: "one" })]);
    });
    const info = await agentStub(s.agent).info();
    expect(info.current_turn).not.toBeNull();
    expect(info.durable_bytes).toBe(2);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "two" } }, 201);
    await sleep(50);
    expect(ws.drain().filter((m) => m.type === "run_turn").map((m) => m.input.text)).toEqual(["one"]);
  });
});

describe("#4 reassignment can't strand leases", () => {
  it("one agent failing to follow doesn't stop the other sandboxes from moving", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const ws = await workstream();
    const s1 = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    const s2 = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    for (const s of [s1, s2]) await sandboxStub(s.sandbox).reportState(a.host, 1, "running", null, null);
    await sandboxStub(s1.sandbox).attachAgent("agt_doesnotexist0000000000000");
    const b = await connectHost(cell);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    for (const s of [s1, s2]) expect(await sandboxStub(s.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
  });

  it("without capacity, the sandbox waits and is placed by its own retry alarm", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const ws = await workstream();
    const s1 = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    await sandboxStub(s1.sandbox).reportState(a.host, 1, "running", null, null);
    a.ws.close();
    await adminJson(`/v1/admin/hosts/${a.host}/confirm-dead?cell=${cell}`, { body: {} });
    expect(await sandboxStub(s1.sandbox).info()).toMatchObject({ host: null, epoch: 2 });
    const b = await connectHost(cell);
    await runInDurableObject(sandboxStub(s1.sandbox), (_i, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'");
    });
    await runDurableObjectAlarm(sandboxStub(s1.sandbox));
    expect(await sandboxStub(s1.sandbox).info()).toMatchObject({ host: b.host, epoch: 3 });
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
    await sleep(50);
    expect(h.ws.closed?.code).toBe(4500);

    const ws2 = await Ws.connect("/v1/fleet", h.host_token);
    ws2.send(hostHello(h.host, cell));
    expect((await ws2.next("hello_ack")).last_event_seq).toBe(1);
    sendEvents(ws2, [capacity], 3); // skipping 2 is a gap
    expect((await ws2.next("error")).error.message).toMatch(/out of order/);
    await sleep(50);
    expect(ws2.closed?.code).toBe(4409);

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
    const ws = await workstream();
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    await runInDurableObject(fleet, (inst: FleetDO, st) => {
      inst.ec2Override = null;
      st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, a.host);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    a.ws.close();
    await runDurableObjectAlarm(fleet);
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
      st.storage.sql.exec("INSERT INTO tool_calls (epoch, call, name, status, outcome, created_ms) VALUES (1, 'cal_e-1', 'notify', 'dispatching', NULL, 0)");
    });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall(1, "cal_e-1", "notify", { to: "captain", message: "hello" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_e-1")).outcome.status).toBe("ok");
  });
});

describe("#9 no secrets at rest outside BrokerDO", () => {
  it("stored command bodies hold references; the host receives the value", async () => {
    const s = await setup();
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
    const ws = await workstream();
    await adminJson("/v1/admin/secrets/inject:github", { method: "PUT", body: { value: "ghs_REALVALUE" } });
    const sbx = await adminJson("/v1/sandboxes", {
      body: { workstream: ws, cell, policy: { allow: [{ host: "api.example.com" }], inject: [{ name: "github", hosts: ["api.github.com"], placeholder: "nest-ph-github-1", locations: [{ type: "authorization_bearer" }] }] } },
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
    await sleep(30);
    await agentStub(s.agent).flush();
    r1.ws.close();
    const r2 = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1, { session: SESSION2, local_bytes: 9 });
    expect(r2.ack.durable_bytes).toBe(0);
    r2.ws.send(seg(0, "new one\n", false, SESSION2));
    await sleep(30);
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

  it("a workstream event about a sandbox the host doesn't hold is dropped", async () => {
    const s = await setup();
    const other = await connectHost(s.cell);
    const seq = sendEvents(other.ws, [{ ts_ms: Date.now(), type: "workstream", event: { workstream: s.workstream, ts_ms: Date.now(), sandbox: s.sandbox, epoch: 1, type: "egress_alert", host: "evil.example", reason: "domain_fronting" } }]);
    await other.ws.next("ack", (m) => m.up_to >= seq);
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).events();
    expect(events.some((e) => e.type === "egress_alert")).toBe(false);
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
    const ws = await workstream();
    const s1 = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    const s2 = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create" && c.sandbox === s2.sandbox);
    const restarted = await Ws.connect("/v1/fleet", h.host_token);
    restarted.send(hostHello(h.host, cell, { instance_id: "nestd-restarted", sandboxes: [{ sandbox: s1.sandbox, epoch: 1, state: "running", dirty: false }] }));
    await restarted.next("hello_ack");
    const [again] = await nextCommands(restarted, (c) => c.type === "sandbox_create");
    expect(again).toMatchObject({ sandbox: s2.sandbox, epoch: 1 });
    await sleep(50);
    expect((await sandboxStub(s1.sandbox).info()).state).toBe("running");
    expect((await sandboxStub(s2.sandbox).info()).state).not.toBe("failed");
  });
});

describe("#14 a host disconnected past token expiry can reconnect", () => {
  it("an expired token (within the grace window) opens the fleet channel and is rotated at hello", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    const expired = await issueHostToken("test-host-token-secret-0123456789abcdef", { host: h.host, cell, role: "burst", exp: Date.now() - 60_000 });
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
    await fleet.registerLaunched({ instance_id: "i-0burst", role: "burst", account_id: "111", region: "us-east-1" });
    const req = { protocol_version: 1, role: "controller" as const, cell, proof: { type: "aws_identity_document" as const, document_b64: "", pkcs7_b64: "" }, proxy_ca_csr_pem: await csrPem() };
    await expect(Promise.resolve().then(() => fleet.enroll(req, cell, { instanceId: "i-0burst", accountId: "111", region: "us-east-1" }))).rejects.toThrow(/launched as burst/);
    await expect(Promise.resolve().then(() => fleet.enroll({ ...req, role: "burst" }, cell, { instanceId: "i-0burst", accountId: "222", region: "us-east-1" }))).rejects.toThrow(/another AWS account/);
    expect((await fleet.enroll({ ...req, role: "burst" }, cell, { instanceId: "i-0burst", accountId: "111", region: "us-east-1" })).host).toMatch(/^hst_/);
  });

  it("a malformed CSR leaves the enrollment token usable", async () => {
    const cell = uniqueCell();
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } });
    const enroll = (csr: string) => SELF.fetch(`${BASE}/v1/hosts/enroll`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol_version: 1, role: "burst", cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: csr }),
    });
    expect((await enroll("not a csr")).status).not.toBe(200);
    expect((await enroll(await csrPem())).status).toBe(200);
  });
});

describe("#16 prompt-injection blast radius", () => {
  it("notify can't reach an agent in another workstream", async () => {
    const a = await setup({ captain: true });
    const b = await setup();
    const { ws } = await runner(a.agent, a.host.host, a.host.host_token);
    ws.send(toolCall(1, "cal_n-1", "notify", { to: b.agent, message: "hi" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_n-1")).outcome.error.code).toBe("forbidden");
  });
});

describe("#17/#14 read_transcript pages by entry", () => {
  it("returns entries after since_seq with the next seq", async () => {
    const s = await setup({ captain: true });
    const { ws } = await runner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "l1\nl2\nl3\nl4\n"));
    await sleep(30);
    await agentStub(s.agent).flush();
    ws.send(toolCall(1, "cal_r-1", "read_transcript", { agent: s.agent, since_seq: 1, limit: 2 }));
    const r = await ws.next("tool_result", (m) => m.call === "cal_r-1");
    expect(r.outcome.content[0].text).toBe("l2\nl3");
    expect(r.outcome.content[1].value).toEqual({ entries: 2, next_seq: 3, more: true });
    const page = await adminJson(`/v1/agents/${s.agent}/transcript?since=3`);
    expect(page).toEqual({ lines: ["l4"], next_seq: 4, more: false });
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
    const res = await admin("/v1/admin/enrollment-tokens", { body: { role: "burst", cell: "../../evil" } });
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

describe("docs #13 guest CLI mapping", () => {
  it("maps urgency low, validates emit events, defaults the summary, and unexposes", async () => {
    const s = await setup({ captain: true });
    const stub = agentStub(s.agent);
    expect((await stub.guestCli(s.sandbox, 1, { command: "notify", to: "captain", message: "m", urgency: "low" })).status).toBe("ok");
    const bad = await stub.guestCli(s.sandbox, 1, { command: "emit", event: "nonsense", payload: null });
    expect(bad).toMatchObject({ status: "error", error: { code: "invalid_message" } });
    expect((await stub.guestCli(s.sandbox, 1, { command: "emit", event: "progress", payload: null })).status).toBe("ok");
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).events();
    expect(events.at(-1)).toMatchObject({ type: "progress", summary: "progress" });
    expect((await stub.guestCli(s.sandbox, 1, { command: "expose", port: 3000, exposed: false })).status).toBe("ok");
    const [un] = await nextCommands(s.host.ws, (c) => c.type === "port_unexpose");
    expect(un).toMatchObject({ sandbox: s.sandbox, port: 3000 });
  });
});

describe("docs #8 hello.agents reconciliation", () => {
  it("a started brain the host no longer reports is marked detached; a reported one is kept", async () => {
    const s = await setup();
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    await okResult(s.host.ws, start.cmd);
    const again = await Ws.connect("/v1/fleet", s.host.host_token);
    again.send(hostHello(s.host.host, s.cell, { agents: [] }));
    await again.next("hello_ack");
    await sleep(50);
    expect((await agentStub(s.agent).info()).state).toBe("detached");

    const third = await Ws.connect("/v1/fleet", s.host.host_token);
    third.send(hostHello(s.host.host, s.cell, { agents: [{ agent: s.agent, state: "idle", hands: { sandbox: s.sandbox, epoch: 1 } }] }));
    await third.next("hello_ack");
    await sleep(50);
    expect((await agentStub(s.agent).info()).state).toBe("idle");
  });
});
