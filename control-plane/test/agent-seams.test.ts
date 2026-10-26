// AgentDO and BrokerDO at their seams: side effects that must not be lost, an agent epoch that a sandbox
// move doesn't touch, secret references that must stay in their slot, and states that must not strand an agent.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { FleetDO } from "../src/do/fleet";
import type { AwsCellConfig } from "../src/lib/cells";
import type { SandboxDO } from "../src/do/sandbox";
import { verifyBinding } from "../src/lib/binding";
import { b64urlToBytes } from "../src/lib/util";
import { adminJson, connectHost, nextCommands, okResult, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const wsStub = (id: string) => env.WORKSTREAM.get(env.WORKSTREAM.idFromName(id));

async function setup(opts: { captain?: boolean; launch?: unknown } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
  const host = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "seams" } }, 201);
  let captain: string | undefined;
  if (opts.captain) {
    await connectHost(cell, "controller");
    captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent;
  }
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", {
    body: { role: "worker", sandbox: sbx.sandbox, ...(opts.launch ? { launch: opts.launch } : {}), ...(captain ? { captain } : {}) },
  }, 201);
  const [start] = await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { cell, host, workstream: workstream as string, sandbox: sbx.sandbox as string, agent: worker.agent as string, start, captain };
}

async function runner(agent: string, host: string, token: string, instance = "rin_one", epoch = 1) {
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, token);
  ws.send({ type: "hello", protocol_version: 1, agent, host, instance_id: instance, epoch, session: SESSION });
  await ws.next("hello_ack");
  return ws;
}

/** Edit AgentInfo in place (simulating state an earlier failure left behind). */
async function editAgent(agent: string, fn: (info: Record<string, any>) => void) {
  await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
    fn(info);
    st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
  });
}

/** Make every call into the sandbox fail (its record is unreadable) until `restore` runs. */
async function breakSandbox(sandbox: string) {
  await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
    st.storage.sql.exec("UPDATE kv SET key = 'info_hidden' WHERE key = 'info'");
  });
  return () => runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
    st.storage.sql.exec("UPDATE kv SET key = 'info' WHERE key = 'info_hidden'");
  });
}

/** Run one of AgentDO's deadlines now. */
async function runDeadline(agent: string, key: string) {
  await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = ?", key);
  });
  await runDurableObjectAlarm(agentStub(agent));
}

describe("an event's side effects survive a failure", () => {
  it("an escalation whose routing failed is routed when the batch is resent", async () => {
    const s = await setup({ captain: true });
    const ws1 = await runner(s.agent, s.host.host, s.host.host_token);
    const restore = await breakSandbox(s.sandbox);
    const batch = { type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), type: "escalation", call: "cal_esc-1", tool: "WebFetch", input: { url: "https://x.test" } },
    ] };
    ws1.send(batch);
    expect((await ws1.next("error")).error.code).toBe("unknown_sandbox");
    await sleep(30);
    expect(ws1.closed?.code).toBe(4500);
    expect((await wsStub(s.workstream).events()).some((e) => e.type === "needs_input")).toBe(false);

    await restore();
    const ws2 = await runner(s.agent, s.host.host, s.host.host_token);
    ws2.send(batch);
    expect((await ws2.next("ack")).up_to).toBe(1);
    const needs = (await wsStub(s.workstream).events()).filter((e) => e.type === "needs_input");
    expect(needs.length).toBe(1);
    expect(needs[0]).toMatchObject({ sandbox: s.sandbox, epoch: 1 });
  });

  it("a failed agentActivity is retried from the alarm, and a new session re-asserts a lost one", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token);
    const t = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201)).turn;
    await ws.next("run_turn", (m) => m.turn === t);
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([s.agent]);

    // The turn ends while the sandbox is unreachable: "not working" must still arrive.
    const restore = await breakSandbox(s.sandbox);
    ws.send({ type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), turn: t, type: "turn_completed", stop_reason: "end_turn" },
    ] });
    expect((await ws.next("ack")).up_to).toBe(1);
    // The retry fails too, and is armed again.
    await runDeadline(s.agent, "activity");
    const armed = await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'activity'").toArray().length);
    expect(armed).toBe(1);
    await restore();
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([s.agent]);
    await runDeadline(s.agent, "activity");
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([]);

    // SandboxDO lost the agent's "working" (any lost call): the next session hello says it again.
    const t2 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "more" } }, 201)).turn;
    await ws.next("run_turn", (m) => m.turn === t2);
    await runInDurableObject(sandboxStub(s.sandbox), (_i: SandboxDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.working = [];
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    ws.close();
    await runner(s.agent, s.host.host, s.host.host_token);
    expect((await sandboxStub(s.sandbox).info()).working).toEqual([s.agent]);
  });
});

describe("the agent epoch is AgentDO's, not the sandbox's", () => {
  it("a sandbox move neither restarts nor reconnects the brain; its next resolve gets fresh hands", async () => {
    const s = await setup();
    expect(s.start).toMatchObject({ epoch: 1, hands: { sandbox: s.sandbox } });
    // The brain runs on another host than its sandbox (an operator's choice): started there under a
    // new agent epoch once the brain on the old host exited.
    const b = await connectHost(s.cell);
    const start = await moveBrain(s, b);
    expect(start).toMatchObject({ epoch: 2, hands: { sandbox: s.sandbox, epoch: 2 } });
    const ws = await runner(s.agent, b.host, b.host_token, "rin_b", 2);

    // The sandbox's host dies: the sandbox gets a new lease (epoch 2) on b. The brain stays.
    s.host.ws.close();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    expect(await sandboxStub(s.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
    const isAttach = (c: any) => c.type === "agent_attach" && c.agent === s.agent && c.epoch === 2;
    const attach = (await nextCommands(b.ws, isAttach)).find(isAttach);
    expect(await b.ws.none("commands", 200, (m) => (m.commands as any[]).some((c) => c.type === "agent_start" && c.agent === s.agent))).toBe(true);
    expect(ws.closed).toBeNull();
    const info = await agentStub(s.agent).info();
    expect(info).toMatchObject({ agent_epoch: 2, host: b.host, hands: { sandbox: s.sandbox } });
    expect(info.hands).toEqual({ sandbox: s.sandbox });

    // Its next resolve, on the same session, gets the new placement and a binding for epoch 2.
    const seq = sendEvents(b.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 2, state: "running", guest: { protocol_version: 1, capabilities: [] } }]);
    await b.ws.next("ack", (m) => m.up_to >= seq);
    await okResult(b.ws, attach.cmd);
    ws.send({ type: "hands_resolve", request: "req_moved" });
    const r = await ws.next("hands_resolved", (m) => m.request === "req_moved");
    expect(r.outcome.status).toBe("ok");
    const claims = await verifyBinding(b64urlToBytes(b.keys[0]!.public_key), r.outcome.hands.binding);
    expect(claims).toMatchObject({ sandbox: s.sandbox, epoch: 2, client: s.agent });

    // Host-relayed calls are fenced by FleetDO's lease check, not by a copy here: the guest CLI and
    // task exits work, and events about the sandbox carry SandboxDO's epoch.
    await editAgent(s.agent, (i) => {
      i.current_turn = "trn_moved";
    });
    const cli = await agentStub(s.agent).guestCli(s.sandbox, 2, { command: "emit", event: "progress", payload: { summary: "after the move" } });
    expect(cli.status).toBe("ok");
    expect((await wsStub(s.workstream).events()).at(-1)).toMatchObject({ type: "progress", sandbox: s.sandbox, epoch: 2 });
    await agentStub(s.agent).onTaskExited(s.sandbox, 2, {
      task_id: "tsk_1", status: "exited", exit_code: 0, output_path: "/tmp/o", output_bytes: 0, started_ms: Date.now(),
    });
    const inbox = await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ message: string }>("SELECT message FROM inbox").toArray().map((m) => m.message).join("\n"));
    expect(inbox).toContain("Background task tsk_1 exited with code 0");
  });

  it("the brain host's loss restarts the brain elsewhere under a new epoch, and the old session is stale", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await r1.next("run_turn");
    const b = await connectHost(s.cell);
    s.host.ws.close();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    // The brain followed its own host's fate: started again (on the sandbox's new host, today's placement).
    const start = (await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent)).find((c) => c.agent === s.agent);
    expect(start.epoch).toBe(2);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
    // A runner still presenting epoch 1 is fenced; the issued epoch is current.
    const stale = await Ws.connect(`/v1/agents/${s.agent}/session`, b.host_token);
    stale.send({ type: "hello", protocol_version: 1, agent: s.agent, host: b.host, instance_id: "rin_old", epoch: 1, session: SESSION });
    await stale.next("hello_ack");
    expect((await stale.next("error")).error.code).toBe("stale_epoch");
    const r2 = await runner(s.agent, b.host, b.host_token, "rin_two", 2);
    expect((await r2.next("run_turn")).input.kind).toBe("recovery");
  });

  it("a running brain whose idle sandbox was evicted gets it placed again by its next resolve", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    // FleetDO took the suspended sandbox off a host going away (its lease dropped); nobody was working in it.
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", s.sandbox);
    });
    await sandboxStub(s.sandbox).evicted(s.host.host, 1);
    expect(await sandboxStub(s.sandbox).info()).toMatchObject({ host: null, state: "suspended" });
    expect(ws.closed).toBeNull();
    ws.send({ type: "hands_resolve", request: "req_evicted" });
    const r = await ws.next("hands_resolved", (m) => m.request === "req_evicted");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "sandbox_not_ready", retryable: true } });
    // The resolve placed it again (a new epoch), so the next one can succeed.
    await nextCommands(s.host.ws, (c) => c.type === "sandbox_create" && c.sandbox === s.sandbox && c.epoch === 2);
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(1);
  });

  it("a start of a brain that is running there sends nothing", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    expect(await agentStub(s.agent).start()).toEqual({ host: s.host.host, cmd: null });
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(1);
  });

  it("old stored state: hands.epoch becomes the agent epoch and is dropped", async () => {
    const s = await setup();
    // As stored before the agent epoch: the worker's session epoch was the sandbox epoch in `hands`.
    await editAgent(s.agent, (i) => {
      delete i.agent_epoch;
      i.hands = { sandbox: s.sandbox, epoch: 7 };
    });
    expect(await agentStub(s.agent).info()).toMatchObject({ agent_epoch: 7, hands: { sandbox: s.sandbox } });
    expect((await agentStub(s.agent).info()).hands).toEqual({ sandbox: s.sandbox });
    // The brain started under the old scheme reconnects with that epoch and is current.
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_legacy", 7);
    expect(await ws.none("error", 150, (m) => m.error.code === "stale_epoch")).toBe(true);
    ws.close();
    await sleep(50);
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    expect(start).toMatchObject({ epoch: 8, hands: { sandbox: s.sandbox, epoch: 8 } });
  });

  it("a previous-release runner's 0 is accepted for an agent without hands (one release), never for a worker", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const ctl = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "legacy" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    const [start] = await nextCommands(ctl.ws, (c) => c.type === "agent_start" && c.agent === captain);
    expect(start.epoch).toBe(1);
    const ws = await runner(captain, ctl.host, ctl.host_token, "rin_cap_legacy", 0);
    expect(await ws.none("error", 150, (m) => m.error.code === "stale_epoch")).toBe(true);

    const s = await setup();
    const w = await Ws.connect(`/v1/agents/${s.agent}/session`, s.host.host_token);
    w.send({ type: "hello", protocol_version: 1, agent: s.agent, host: s.host.host, instance_id: "rin_w0", epoch: 0, session: SESSION });
    await w.next("hello_ack");
    expect((await w.next("error")).error.code).toBe("stale_epoch");
  });
});

describe("one brain per agent: a start elsewhere waits for the previous brain to be gone", () => {
  const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;

  it("no start elsewhere before its exit; the kill is sent once; the start follows the exit at its epoch", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    expect(await stub.start(b.host)).toEqual({ host: b.host, cmd: null, waiting_for: s.host.host });
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    // Asked again while waiting: nothing new is sent, and still no start on b.
    await stub.start(b.host);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_stop"))).toBe(true);
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStartOf(s.agent)))).toBe(true);
    expect(await stub.info()).toMatchObject({ agent_epoch: 1, host: s.host.host, awaiting_exit: { host: s.host.host, epoch: 1 } });
    // An older start's exit doesn't count; the stop's `ok` doesn't either.
    await okResult(s.host.ws, stop.cmd);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: s.host.host }]);
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStartOf(s.agent)))).toBe(true);
    // Its exit at epoch 1: the waiting start goes ahead under epoch 2.
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await runDeadline(s.agent, "pending_start");
    const start = (await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start).toMatchObject({ epoch: 2, hands: { sandbox: s.sandbox, epoch: 2 } });
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
    const info = await stub.info();
    expect(info.awaiting_exit).toBeUndefined();
    expect(info.pending_start).toBeUndefined();
  });

  it("an exit from a host of the previous release (no epoch) counts for the start it was sent", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped" }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await runDeadline(s.agent, "pending_start");
    expect((await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent))).toMatchObject({ epoch: 2 });
  });

  it("the previous brain's host expiring counts as its exit", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const a = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "expiry" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    await nextCommands(a.ws, isStartOf(captain));
    const b = await connectHost(cell, "controller");
    await agentStub(captain).start(b.host);
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStartOf(captain)))).toBe(true);
    // a goes silent past its lease: expired, its brains handed back, and the start goes ahead.
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, a.host);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    await runDeadline(captain, "pending_start");
    expect((await nextCommands(b.ws, isStartOf(captain))).find(isStartOf(captain))).toMatchObject({ epoch: 2 });
  });

  it("a killed brain that never reports its exit: its host is wedged, its lease lapses, and it is expired", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const a = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "wedge" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    await nextCommands(a.ws, isStartOf(captain));
    const b = await connectHost(cell, "controller");
    await agentStub(captain).start(b.host);
    await nextCommands(a.ws, (c) => c.type === "agent_stop");
    // 60 s pass without an exit: AgentDO reports the host wedged.
    await runDeadline(captain, "exit_wait");
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    // Its heartbeats get no ack (no renewal: its lease lapses and nestd kills its brains) ...
    a.ws.send({ type: "heartbeat", sent_ms: Date.now(), leases: [] });
    expect(await a.ws.none("heartbeat_ack", 200)).toBe(true);
    // ... and 30 s after its last renewal it is expired like a silent host: the start goes ahead.
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, a.host);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    expect((await fleet.hostStatus(a.host))!.status).toBe("expired");
    await runDeadline(captain, "pending_start");
    expect((await nextCommands(b.ws, isStartOf(captain))).find(isStartOf(captain))).toMatchObject({ epoch: 2 });
  });

  it("no deadlock: a start that places the sandbox doesn't call back into the agent (errored agent, evicted sandbox)", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    // Errored, no brain, a turn waiting: exactly what a wake would act on.
    await editAgent(s.agent, (i) => {
      i.state = "errored";
      i.host = null;
    });
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES ('trn_waiting', 1, ?, 'queued', ?)",
        JSON.stringify({ kind: "user", text: "go" }), Date.now());
    });
    // The sandbox was evicted (suspended, lease dropped): the start places it again, and the
    // placement must not call back into this agent while its start is in flight.
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", s.sandbox);
    });
    await sandboxStub(s.sandbox).evicted(s.host.host, 1);
    const started = await Promise.race([
      agentStub(s.agent).start(),
      sleep(5_000).then(() => "deadlocked" as const),
    ]);
    expect(started).not.toBe("deadlocked");
    expect(started).toMatchObject({ host: s.host.host });
    await nextCommands(s.host.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
  });

  it("a brain told to stop isn't taken for live, even when the start races the stop", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const [, started] = await Promise.all([agentStub(s.agent).stop("requested"), agentStub(s.agent).start()]);
    expect(started.cmd).not.toBeNull();
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(2);
  });

  it("a concurrent start with other arguments is refused, not dropped", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    const results = await Promise.allSettled([stub.start(b.host), stub.start()]);
    expect(results[0]!.status).toBe("fulfilled");
    expect(results[1]!.status === "rejected" && String(results[1]!.reason)).toMatch(/another start/);
  });

  it("concurrent starts with the same arguments share one: one kill, one epoch", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    const [r1, r2] = await Promise.all([stub.start(b.host), stub.start(b.host)]);
    expect(r1).toEqual(r2);
    const stops = await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) =>
      st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE type = 'agent_stop' AND agent = ?", s.agent).one().n);
    expect(stops).toBe(1);
    expect((await stub.info()).agent_epoch).toBe(1);
  });

  it("a brain that survives its sandbox moving hears what was lost mid-turn; a notice lost or not, its next turn starts with it", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "first" } }, 201);
    const t1 = await ws.next("run_turn");
    expect(t1.input.text).toBe("first");
    expect((await agentStub(s.agent).info()).told_sandbox_epoch).toBe(1);
    // The sandbox moves (epoch 2) mid-turn: the brain hears it as a system inbox message.
    await agentStub(s.agent).onSandboxMoved(s.sandbox, 2, s.host.host);
    const inbox = await ws.next("inbox");
    expect(inbox.message).toMatchObject({ from: "system" });
    expect(inbox.message.text).toMatch(/Your sandbox moved to another machine/);
    ws.send({ type: "events", seq: 1, events: [{ agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), turn: t1.turn, type: "turn_completed", stop_reason: "end_turn" }] });
    await ws.next("ack");
    // Between turns, with no notice at all (as if it was lost): derived from SandboxDO's epoch.
    await editAgent(s.agent, (i) => {
      i.told_sandbox_epoch = 0;
    });
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "second" } }, 201);
    const t2 = await ws.next("run_turn", (m) => m.input.text.endsWith("second"));
    expect(t2.input.text).toMatch(/^Your sandbox moved to another machine[\s\S]*\n\nsecond$/);
    // Told once: the next turn is plain.
    ws.send({ type: "events", seq: 2, events: [{ agent: s.agent, epoch: 1, seq: 2, ts_ms: Date.now(), turn: t2.turn, type: "turn_completed", stop_reason: "end_turn" }] });
    await ws.next("ack", (m) => m.up_to === 2);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "third" } }, 201);
    expect((await ws.next("run_turn", (m) => m.input.text.endsWith("third"))).input.text).toBe("third");
  });

  it("the brain index keeps a newer start's row against an older brain's exit", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    // Restarted on the same host under epoch 2 (same host: no wait), then epoch 1's late exit arrives.
    await editAgent(s.agent, (i) => {
      i.state = "detached";
    });
    await agentStub(s.agent).start();
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(2);
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: s.host.host }]);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: s.host.host, state: "starting", agent_epoch: 2 });
    // The current brain's exit counts, and clears the host: a later start elsewhere sends no stop.
    const seq2 = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 2 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq2);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: null, state: "detached" });
    expect(await fleetRows(s.cell, s.agent)).toEqual([]);
  });

  it("an older session gets nothing once a newer epoch is issued, even before the new brain's hello", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await ws.next("cache_update");
    // A start issued epoch 2 (its agent_start in flight; same host, so the old session stays open).
    await editAgent(s.agent, (i) => {
      i.agent_epoch = 2;
    });
    ws.send({ type: "tool_call", seq: 1, call: "cal_old-1", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "from the old brain" } });
    ws.send({ type: "events", seq: 2, events: [{ agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), type: "state_changed", state: "working" }] });
    ws.send({ type: "hands_resolve", request: "req_old" });
    const r = await ws.next("hands_resolved", (m) => m.request === "req_old");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    expect(await ws.none("tool_result", 200)).toBe(true);
    expect(await ws.none("ack", 50)).toBe(true);
    expect((await wsStub(s.workstream).events()).some((e: any) => e.type === "progress")).toBe(false);
    expect((await agentStub(s.agent).info()).state).not.toBe("working");
  });

  it("the old session after start(otherHost) is fenced at once, before the exit", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    await sleep(50);
    expect(ws.closed?.code).toBe(4409);
    // Whatever it still manages to send runs nothing.
    try {
      ws.send({ type: "tool_call", seq: 1, call: "cal_old-2", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "late" } });
    } catch {
      // closed
    }
    expect(await ws.none("tool_result", 200)).toBe(true);
    expect((await wsStub(s.workstream).events()).some((e: any) => e.type === "progress")).toBe(false);
  });
});

describe("a draining host's brains", () => {
  const config: AwsCellConfig = {
    region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"], spot: true,
    max_hosts: 1, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
  };
  const spotNotice = async (ws: Ws) => {
    const seq = sendEvents(ws, [{ ts_ms: Date.now(), type: "spot_notice", deadline_ms: Date.now() + 120_000 }]);
    await ws.next("ack", (m) => m.up_to >= seq);
  };

  it("are killed there at once and start elsewhere once their exit is reported", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await spotNotice(s.host.ws);
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_start" && c.agent === s.agent))).toBe(true);
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await runDeadline(s.agent, "pending_start");
    const start = (await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent)).find((c) => c.type === "agent_start");
    expect(start.epoch).toBe(2);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: b.host, agent_epoch: 2 });
  });

  it("otherwise restart once the drained host is retired", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const r = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await r.next("run_turn");
    // A launched instance (scale-down retires it); its sandbox is suspended, so the drain evicts it.
    const fleet = env.FLEET.get(env.FLEET.idFromName(s.cell));
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0drain' WHERE host = ?", s.host.host);
    });
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 1, state: "suspended" }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await spotNotice(s.host.ws); // no other host yet: the brain stays
    expect((await agentStub(s.agent).info()).host).toBe(s.host.host);
    const b = await connectHost(s.cell);
    await runInDurableObject(fleet, (inst: FleetDO, st) => {
      inst.cellConfigOverride = config;
      inst.ec2Override = null;
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("dead");
    const start = (await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent)).find((c) => c.type === "agent_start");
    expect(start.epoch).toBe(2);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
  });
});

/** Put the agent's brain on host `b`: start there, report the old brain's exit, and run the waiting start. */
async function moveBrain(s: { agent: string; host: { host: string; ws: Ws } }, b: { host: string; ws: Ws }) {
  const stub = agentStub(s.agent);
  const prevEpoch = (await stub.info()).agent_epoch;
  await stub.start(b.host);
  await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
  const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: prevEpoch }]);
  await s.host.ws.next("ack", (m) => m.up_to >= seq);
  await runDeadline(s.agent, "pending_start");
  const isStart = (c: any) => c.type === "agent_start" && c.agent === s.agent;
  return (await nextCommands(b.ws, isStart)).find(isStart);
}

describe("FleetDO's brain index", () => {
  it("rows keyed by agent alone (stored before) are rekeyed by (agent, host) in place", async () => {
    const cell = uniqueCell();
    await connectHost(cell);
    const stub = env.FLEET.get(env.FLEET.idFromName(cell));
    const rows = await runInDurableObject(stub, (i, st) => {
      st.storage.sql.exec("DROP TABLE host_agents");
      st.storage.sql.exec("CREATE TABLE host_agents (agent TEXT PRIMARY KEY, host TEXT NOT NULL, cmd TEXT NOT NULL)");
      st.storage.sql.exec("INSERT INTO host_agents (agent, host, cmd) VALUES ('agt_a', 'hst_1', 'cmd_1')");
      (i as unknown as { createHostAgents(): void }).createHostAgents();
      // The same agent on a second host is a second row now.
      st.storage.sql.exec("INSERT INTO host_agents (agent, host, cmd) VALUES ('agt_a', 'hst_2', 'cmd_2')");
      const pk = st.storage.sql.exec<{ name: string; pk: number }>("PRAGMA table_info(host_agents)").toArray().filter((c) => c.pk > 0).map((c) => c.name);
      return { pk, rows: st.storage.sql.exec("SELECT agent, host, cmd FROM host_agents ORDER BY host").toArray() };
    });
    expect(rows.pk.sort()).toEqual(["agent", "host"]);
    expect(rows.rows).toEqual([{ agent: "agt_a", host: "hst_1", cmd: "cmd_1" }, { agent: "agt_a", host: "hst_2", cmd: "cmd_2" }]);
  });
});

/** FleetDO's brain index rows for an agent, sorted by host. */
async function fleetRows(cell: string, agent: string) {
  return runInDurableObject(env.FLEET.get(env.FLEET.idFromName(cell)), (_i, st) =>
    st.storage.sql.exec<{ agent: string; host: string }>("SELECT agent, host FROM host_agents WHERE agent = ? ORDER BY host", agent).toArray());
}

describe("secret references resolve only in their slot", () => {
  it("a launch prompt naming the cell's binding key goes out as literal text", async () => {
    const cell = uniqueCell();
    const ref = `$nest-secret:binding_key:${cell}`;
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const host = await connectHost(cell); // the cell's binding key exists from here on
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "x" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(host.ws, (c) => c.type === "sandbox_create");
    const launch = { builtin_tools: [], system_prompt: { mode: "append", text: ref } };
    const worker = await adminJson("/v1/agents", { body: { role: "worker", sandbox: sbx.sandbox, launch } }, 201);
    const [start] = await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
    expect(start.launch.system_prompt.text).toBe(ref);
    expect(start.oauth_token).toBe("sk-ant-oat01-seams");
    expect(JSON.stringify(start)).not.toContain("private_jwk");
  });

  it("BrokerDO resolves a name only for its purpose, and binding and access keys never", async () => {
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await broker.putSecret("inject:github", "ghs_x");
    await broker.putSecret("claude_oauth_token:captain", "sk-cap");
    await broker.putSecret("access:gateway", '{"client_id":"a","client_secret":"b"}');
    await broker.bindingPublicKeys("seams-cell");
    const refs = ["$nest-secret:inject:github", "$nest-secret:claude_oauth_token:captain", "$nest-secret:access:gateway", "$nest-secret:binding_key:seams-cell"];
    expect(await broker.resolveRefs(refs, ["claude_oauth_token"])).toEqual({
      [refs[0]!]: null, [refs[1]!]: "sk-cap", [refs[2]!]: null, [refs[3]!]: null,
    });
    expect((await broker.resolveRefs(refs, ["inject:"]))[refs[0]!]).toBe("ghs_x");
    // Even a caller that asks for them gets nothing.
    expect(await broker.resolveRefs(refs.slice(2), ["access:", "binding_key:"])).toEqual({ [refs[2]!]: null, [refs[3]!]: null });
  });
});

describe("a worker's cell and workstream are its sandbox's", () => {
  it("are taken from the sandbox, and a mismatch is refused", async () => {
    const cell = uniqueCell();
    await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "a" } }, 201);
    const other = (await adminJson("/v1/workstreams", { body: { goal: "b" } }, 201)).workstream;
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    const base = { role: "worker", sandbox: sbx.sandbox, start: false };
    expect((await adminJson("/v1/agents", { body: { ...base, workstream: other } }, 409)).error.code).toBe("invalid_message");
    expect((await adminJson("/v1/agents", { body: { ...base, cell: uniqueCell() } }, 409)).error.code).toBe("invalid_message");
    const w = await adminJson("/v1/agents", { body: base }, 201);
    expect(w).toMatchObject({ cell, workstream });
    // AgentDO checks it too, for any caller.
    // Wrapped: an RPC thenable that rejects is otherwise also reported as unhandled.
    await expect(Promise.resolve().then(() => agentStub("agt_direct0000000000000000000").create({
      agent: "agt_direct0000000000000000000", role: "worker", workstream: other, cell, sandbox: sbx.sandbox,
    }))).rejects.toThrow(/workstream/);
  });
});

describe("`starting` has a deadline", () => {
  it("a start no brain answers becomes `errored`, and the next turn starts it again", async () => {
    const s = await setup();
    expect((await agentStub(s.agent).info()).state).toBe("starting");
    await runDeadline(s.agent, "starting");
    expect((await agentStub(s.agent).info()).state).toBe("errored");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "anyone there?" } }, 201);
    const [again] = await nextCommands(s.host.ws, (c) => c.type === "agent_start" && c.agent === s.agent);
    expect(again).toMatchObject({ epoch: 2, hands: { sandbox: s.sandbox, epoch: 2 } });
    expect((await agentStub(s.agent).info()).state).toBe("starting");
  });
});

describe("captains named in several places", () => {
  it("a worker's recorded captain in another workstream can't be notified", async () => {
    const other = await setup({ captain: true });
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const host = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "mine" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(host.ws, (c) => c.type === "sandbox_create");
    const w = await adminJson("/v1/agents", { body: { role: "worker", sandbox: sbx.sandbox, captain: other.captain } }, 201);
    await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === w.agent);
    const ws = await runner(w.agent, host.host, host.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_cap-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "hi" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_cap-1")).outcome.error.code).toBe("forbidden");
    expect(await agentStub(other.captain!).turns()).toEqual([]);
  });

  it("a turn for an agent that was never created is refused and writes nothing", async () => {
    const ghost = agentStub("agt_ghost00000000000000000000");
    await expect(Promise.resolve().then(() => ghost.enqueueTurn({ kind: "event_batch", text: "x" }))).rejects.toThrow(/unknown agent/);
    const rows = await runInDurableObject(ghost, (_i: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM turns").toArray().length);
    expect(rows).toBe(0);
  });
});
