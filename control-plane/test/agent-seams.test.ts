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
import { adminJson, connectHost, hostHello, nextCommands, okResult, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

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

  it("a start of a live brain restarts it in place under a new epoch (no kill; its runner adopts or replaces it)", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const r = await agentStub(s.agent).start();
    expect(r.host).toBe(s.host.host);
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === r.cmd);
    expect(start).toMatchObject({ type: "agent_start", epoch: 2 });
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_stop"))).toBe(true);
  });

  it("old stored state (main): hands.epoch becomes the agent epoch, and `host` the brain record", async () => {
    const s = await setup();
    // As stored before the agent epoch: the worker's session epoch was the sandbox epoch in `hands`,
    // and `host` its brain's host.
    await editAgent(s.agent, (i) => {
      delete i.agent_epoch;
      delete i.brain;
      delete i.intent;
      i.host = s.host.host;
      i.state = "ready";
      i.hands = { sandbox: s.sandbox, epoch: 7 };
    });
    expect(await agentStub(s.agent).info()).toMatchObject({
      agent_epoch: 7, hands: { sandbox: s.sandbox }, host: s.host.host, brain: { host: s.host.host, epoch: 7, phase: "live" }, intent: null,
    });
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

  it("old stored state (the agent-epoch branch): `host`, `awaiting_exit`, `pending_start` and `stop_requested` become the brain record and intent", async () => {
    const s = await setup();
    const b = await connectHost(s.cell);
    await editAgent(s.agent, (i) => {
      delete i.brain;
      delete i.intent;
      i.host = s.host.host;
      i.awaiting_exit = { host: s.host.host, epoch: 1, since_ms: 1234 };
      i.pending_start = { host_hint: b.host };
      i.stop_requested = 1;
    });
    const info = await agentStub(s.agent).info();
    expect(info).toMatchObject({ brain: { host: s.host.host, epoch: 1, phase: "condemned", since_ms: 1234 }, intent: { host_hint: b.host } });
    for (const k of ["awaiting_exit", "pending_start", "stop_requested"]) expect(info).not.toHaveProperty(k);
    // The old escalation key runs the new escalation: the kill it never recorded is sent (again).
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('exit_wait', 0)");
    });
    await runDurableObjectAlarm(agentStub(s.agent));
    expect((await nextCommands(s.host.ws, (c) => c.type === "agent_stop"))[0]).toMatchObject({ mode: "kill", epoch: 1 });
    // A brain an epoch-less exit left behind (host kept, agent detached) is condemned, not trusted.
    const t = await setup();
    await editAgent(t.agent, (i) => {
      delete i.brain;
      delete i.intent;
      i.host = t.host.host;
      i.state = "detached";
    });
    expect((await agentStub(t.agent).info()).brain).toMatchObject({ host: t.host.host, phase: "condemned" });
    // And no host at all: no brain.
    await editAgent(t.agent, (i) => {
      delete i.brain;
      i.host = null;
    });
    expect((await agentStub(t.agent).info()).brain).toBeNull();
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

describe("one brain per agent: the brain record", () => {
  const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;
  const isKillOf = (agent: string) => (c: any) => c.type === "agent_stop" && c.agent === agent && c.mode === "kill";
  const exited = async (ws: Ws, agent: string, epoch: number | undefined, reason = "stopped") => {
    const seq = sendEvents(ws, [{ ts_ms: Date.now(), type: "agent_exited", agent, reason, ...(epoch !== undefined ? { epoch } : {}) }]);
    await ws.next("ack", (m) => m.up_to >= seq);
  };

  it("rule 2/3: no start elsewhere before the brain's exit; it is condemned and killed once; the start follows its exit at its epoch", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    expect(await stub.start(b.host)).toEqual({ host: b.host, cmd: null, waiting_for: s.host.host });
    const [stop] = await nextCommands(s.host.ws, isKillOf(s.agent));
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    // Asked again while waiting: nothing new is sent, and still no start on b.
    await stub.start(b.host);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_stop"))).toBe(true);
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStartOf(s.agent)))).toBe(true);
    expect(await stub.info()).toMatchObject({
      agent_epoch: 1, host: s.host.host, brain: { host: s.host.host, epoch: 1, phase: "condemned", kill_cmd: stop.cmd }, intent: { host_hint: b.host },
    });
    // The stop's `ok` doesn't release it; neither does an exit for an older start, from another host, or without an epoch.
    await okResult(s.host.ws, stop.cmd);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: s.host.host }]);
    await stub.onExited(s.host.host, "stopped", 0);
    await stub.onExited(b.host, "stopped", 1);
    await stub.onExited(s.host.host, "stopped");
    expect((await stub.info()).brain).toMatchObject({ phase: "condemned", epoch: 1 });
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStartOf(s.agent)))).toBe(true);
    // Work arriving meanwhile wakes through the same intent: the operator's host is kept (M3).
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "meanwhile" } }, 201);
    expect((await stub.info()).intent).toMatchObject({ host_hint: b.host });
    // Its exit at epoch 1: released, and the intent runs (from the alarm) under epoch 2.
    await exited(s.host.ws, s.agent, 1);
    await runDeadline(s.agent, "intent");
    const start = (await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start).toMatchObject({ epoch: 2, hands: { sandbox: s.sandbox, epoch: 2 } });
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
    expect(await stub.info()).toMatchObject({ brain: { host: b.host, epoch: 2, phase: "starting" }, intent: null });
  });

  it("rule 3: an exit from a host of the previous release (no epoch) counts for the start FleetDO sent there", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    await nextCommands(s.host.ws, isKillOf(s.agent));
    await exited(s.host.ws, s.agent, undefined);
    await runDeadline(s.agent, "intent");
    expect((await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent))).toMatchObject({ epoch: 2 });
  });

  it("rule 3: the brain's host expiring releases it", async () => {
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
    await silent(cell, a.host);
    await runDeadline(captain, "intent");
    expect((await nextCommands(b.ws, isStartOf(captain))).find(isStartOf(captain))).toMatchObject({ epoch: 2 });
  });

  it("rule 4: a kill that isn't processed wedges its host; its lease lapses and it is expired, releasing the brain", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const a = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "wedge" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    await nextCommands(a.ws, isStartOf(captain));
    const b = await connectHost(cell, "controller");
    await agentStub(captain).start(b.host);
    await nextCommands(a.ws, (c) => c.type === "agent_stop");
    // 60 s pass and the kill has no result: AgentDO reports the host wedged.
    await runDeadline(captain, "condemned");
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    expect(await wedgedMs(cell, a.host)).not.toBeNull();
    // Its heartbeats get no ack (no renewal: its lease lapses and nestd kills its brains) ...
    a.ws.send({ type: "heartbeat", sent_ms: Date.now(), leases: [] });
    expect(await a.ws.none("heartbeat_ack", 200)).toBe(true);
    // ... and 30 s after its last renewal it is expired like a silent host: the start goes ahead.
    await silent(cell, a.host);
    expect((await fleet.hostStatus(a.host))!.status).toBe("expired");
    expect(await wedgedMs(cell, a.host)).toBeNull();
    await runDeadline(captain, "intent");
    expect((await nextCommands(b.ws, isStartOf(captain))).find(isStartOf(captain))).toMatchObject({ epoch: 2 });
  });

  it("rule 4 (M1): a processed kill never wedges the host: no index row left releases the brain, a row left is waited for, then capped", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    await stub.start(b.host);
    const [kill] = await nextCommands(s.host.ws, isKillOf(s.agent));
    await okResult(s.host.ws, kill.cmd);
    // Processed, still indexed (an old nestd finishing a graceful turn): no wedge, checked again.
    await runDeadline(s.agent, "condemned");
    expect(await wedgedMs(s.cell, s.host.host)).toBeNull();
    expect((await stub.info()).brain).toMatchObject({ phase: "condemned" });
    expect(await deadlineAt(s.agent, "condemned")).not.toBeNull();
    // Past the cap: wedged after all.
    await editAgent(s.agent, (i) => {
      i.brain.kill_ms = Date.now() - 16 * 60_000;
    });
    await runDeadline(s.agent, "condemned");
    expect(await wedgedMs(s.cell, s.host.host)).not.toBeNull();
    // Another agent's brain on a healthy host whose index row is gone (its exit was lost): released.
    const t = await setup();
    await okResult(t.host.ws, t.start.cmd);
    const c = await connectHost(t.cell);
    await agentStub(t.agent).start(c.host);
    const [kill2] = await nextCommands(t.host.ws, isKillOf(t.agent));
    await okResult(t.host.ws, kill2.cmd);
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(t.cell)), (_i, st) => {
      st.storage.sql.exec("DELETE FROM host_agents WHERE agent = ?", t.agent);
    });
    await runDeadline(t.agent, "condemned");
    expect(await wedgedMs(t.cell, t.host.host)).toBeNull();
    expect((await agentStub(t.agent).info()).brain).toBeNull();
    await runDeadline(t.agent, "intent");
    expect((await nextCommands(c.ws, isStartOf(t.agent))).find(isStartOf(t.agent))).toMatchObject({ epoch: 2 });
  });

  it("rule 4/3: escalation releases a brain whose host is expired even when the loss notice was lost", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    await nextCommands(s.host.ws, isKillOf(s.agent));
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET status = 'expired' WHERE host = ?", s.host.host);
    });
    await runDeadline(s.agent, "condemned");
    expect((await agentStub(s.agent).info()).brain).toBeNull();
    await runDeadline(s.agent, "intent");
    expect((await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent))).toMatchObject({ epoch: 2 });
  });

  it("no deadlock: a start that places the sandbox doesn't call back into the agent (errored agent, evicted sandbox)", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    // Errored, no brain, a turn waiting: exactly what a wake would act on.
    await editAgent(s.agent, (i) => {
      i.state = "errored";
      i.brain = null;
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

  it("rule 2: a start racing a graceful stop restarts the brain in place under a new epoch", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const [, started] = await Promise.all([agentStub(s.agent).stop("requested"), agentStub(s.agent).start()]);
    expect(started.cmd).not.toBeNull();
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(2);
  });

  it("concurrent starts merge into the one intent: neither is dropped, one kill, one epoch", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    const [r1, r2, r3] = await Promise.all([stub.start(b.host), stub.start(b.host), stub.start()]);
    expect(r1).toEqual({ host: b.host, cmd: null, waiting_for: s.host.host });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    const stops = await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) =>
      st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE type = 'agent_stop' AND agent = ?", s.agent).one().n);
    expect(stops).toBe(1);
    expect(await stub.info()).toMatchObject({ agent_epoch: 1, intent: { host_hint: b.host } });
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

  it("rule 2/3: a same-host restart replaces the brain without a kill; the replaced brain's late exit releases nothing", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    await agentStub(s.agent).start();
    expect(await agentStub(s.agent).info()).toMatchObject({ agent_epoch: 2, brain: { host: s.host.host, epoch: 2, phase: "starting" } });
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
    await exited(s.host.ws, s.agent, 1);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: s.host.host }]);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: s.host.host, state: "starting", agent_epoch: 2 });
    // The current brain's exit releases it.
    await exited(s.host.ws, s.agent, 2);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: null, brain: null, state: "detached", prev_host: s.host.host });
    expect(await fleetRows(s.cell, s.agent)).toEqual([]);
  });

  it("rule 2 (L4): a start without a hint never moves a live brain to follow its sandbox", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await moveBrain(s, b); // the brain runs on b; its sandbox stays on a
    await agentStub(s.agent).start();
    const start = (await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start.epoch).toBe(3);
    expect(await b.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
    expect((await agentStub(s.agent).info()).brain).toMatchObject({ host: b.host, epoch: 3 });
  });

  it("rule 1: an older session gets nothing once a newer epoch is issued, even before the new brain's hello", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await ws.next("cache_update");
    // A start issued epoch 2 (its agent_start in flight; same host, so the old session stays open).
    await editAgent(s.agent, (i) => {
      i.agent_epoch = 2;
      i.brain.epoch = 2;
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

  it("rule 1 (H3): a condemned brain's sessions are fenced at once, and a reconnect at its own epoch is stale and gets no hands", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    await sleep(50);
    expect(ws.closed?.code).toBe(4409);
    // Its runner reconnects (same process, same epoch) before it dies.
    const ws2 = await Ws.connect(`/v1/agents/${s.agent}/session`, s.host.host_token);
    ws2.send({ type: "hello", protocol_version: 1, agent: s.agent, host: s.host.host, instance_id: "rin_one", epoch: 1, session: SESSION });
    await ws2.next("hello_ack");
    expect((await ws2.next("error")).error.code).toBe("stale_epoch");
    ws2.send({ type: "hands_resolve", request: "req_zombie" });
    const r = await ws2.next("hands_resolved", (m) => m.request === "req_zombie");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    ws2.send({ type: "tool_call", seq: 1, call: "cal_old-2", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "late" } });
    expect(await ws2.none("tool_result", 200)).toBe(true);
    expect((await wsStub(s.workstream).events()).some((e: any) => e.type === "progress")).toBe(false);
  });

  it("rule 1: an answer resolved while a newer start was issued is not handed out (re-check after the resolve)", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["resolveHands:afterResolve"] = async () => {
        delete inst.testHooks["resolveHands:afterResolve"];
        await inst.start(); // a same-host restart mid-resolve: epoch 2, this session stays open
      };
    });
    ws.send({ type: "hands_resolve", request: "req_mid" });
    const r = await ws.next("hands_resolved", (m) => m.request === "req_mid");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
  });

  it("rule 1: a platform call re-checks the epoch before its write after an await; a guest call (L2) is fenced by the lease instead", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await ws.next("cache_update");
    const hookStart = () => runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        await inst.start(); // a same-host restart lands mid-call: epoch 2
      };
    });
    await hookStart();
    ws.send({ type: "tool_call", seq: 1, call: "cal_mid-1", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "mid" } });
    const res = await ws.next("tool_result", (m) => m.call === "cal_mid-1").catch(() => null);
    expect(res === null || res.outcome.status === "error").toBe(true);
    expect((await wsStub(s.workstream).events()).some((e: any) => e.type === "progress" && e.summary === "mid")).toBe(false);
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(2);
    // The guest's `nest emit` with a start landing mid-call still goes through.
    await hookStart();
    const cli = await agentStub(s.agent).guestCli(s.sandbox, 1, { command: "emit", event: "progress", payload: { summary: "guest" } });
    expect(cli.status).toBe("ok");
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(3);
    expect((await wsStub(s.workstream).events()).some((e: any) => e.type === "progress" && e.summary === "guest")).toBe(true);
  });

  it("probe 1 (H2): a start back on the old host while it is condemned starts there once released, and nothing wedges", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    await stub.start(b.host);
    await nextCommands(s.host.ws, isKillOf(s.agent));
    expect(await stub.start(s.host.host)).toEqual({ host: s.host.host, cmd: null, waiting_for: s.host.host });
    await exited(s.host.ws, s.agent, 1);
    await runDeadline(s.agent, "intent");
    const start = (await nextCommands(s.host.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start.epoch).toBe(2);
    // The old escalation alarm, if it fires, finds no condemned brain: no host is wedged.
    await runDeadline(s.agent, "condemned");
    expect(await wedgedMs(s.cell, s.host.host)).toBeNull();
    expect((await stub.info()).brain).toMatchObject({ host: s.host.host, epoch: 2, phase: "starting" });
  });

  it("probe 2 (H2): an exit landing while a start is deciding never strands it", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    await runInDurableObject(stub, (inst: AgentDO, st) => {
      st.storage.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES ('trn_w', 1, ?, 'queued', ?)", JSON.stringify({ kind: "user", text: "go" }), Date.now());
      inst.testHooks["intent:beforeCommit"] = async () => {
        delete inst.testHooks["intent:beforeCommit"];
        await inst.onExited(s.host.host, "crashed", 1); // the brain dies between the decision and its commit
      };
    });
    const r = await stub.start(b.host);
    // Released mid-decision: the start looked again and went straight to b.
    expect(r).toMatchObject({ host: b.host });
    expect(r.cmd).not.toBeNull();
    const start = (await nextCommands(b.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start.epoch).toBe(2);
    expect(await stub.info()).toMatchObject({ brain: { host: b.host, epoch: 2 }, intent: null });
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
  });

  it("probe 3 (H4) / rule 5: a silent burst host with a brain and no lease is expired, releasing the brain", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const fleet = env.FLEET.get(env.FLEET.idFromName(s.cell));
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", s.sandbox);
    });
    await silent(s.cell, s.host.host);
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("expired");
    expect(await agentStub(s.agent).info()).toMatchObject({ brain: null, host: null });
  });

  it("A1: a kill lost before FleetDO stored it never wedges the host: it is owed by the record and issued again, once", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    // The kill's issue fails (as if AgentDO were reset, or the RPC lost, between condemn and the store).
    let armedBeforeIssue = -1;
    await runInDurableObject(stub, (inst: AgentDO, st) => {
      inst.testHooks["kill:beforeIssue"] = async () => {
        delete inst.testHooks["kill:beforeIssue"];
        // The owed kill's alarm was armed with the condemn, before any attempt to issue it.
        armedBeforeIssue = st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'condemned'").toArray().length;
        throw new Error("lost before FleetDO stored it");
      };
    });
    await stub.start(b.host);
    expect((await stub.info()).brain).toMatchObject({ phase: "condemned", epoch: 1 });
    expect((await stub.info()).brain!.kill_cmd).toBeUndefined();
    expect(armedBeforeIssue).toBe(1);
    // Escalation finds no stored kill: it sends it, and never wedges the host.
    await runDeadline(s.agent, "condemned");
    const [kill] = await nextCommands(s.host.ws, isKillOf(s.agent));
    expect(kill).toMatchObject({ mode: "kill", epoch: 1 });
    expect(await wedgedMs(s.cell, s.host.host)).toBeNull();
    expect((await stub.info()).brain).toMatchObject({ kill_cmd: kill.cmd });
    // Issued again (a retry that lost its answer): FleetDO keeps the one kill.
    const fleet = env.FLEET.get(env.FLEET.idFromName(s.cell));
    expect(await fleet.issueKill(s.host.host, s.agent, 1, "again")).toBe(kill.cmd);
    const kills = await runInDurableObject(fleet, (_i, st) =>
      st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE type = 'agent_stop' AND agent = ?", s.agent).one().n);
    expect(kills).toBe(1);
  });

  it("A2: an onHostLost call that fails is retried until the agent took it; the brain is released and its intent runs", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const a = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "lost" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    await nextCommands(a.ws, isStartOf(captain));
    const b = await connectHost(cell, "controller");
    await agentStub(captain).start(b.host);
    await runInDurableObject(agentStub(captain), (inst: AgentDO) => {
      let fails = 2; // the expiry's call and the same tick's retry
      inst.testHooks["hostLost:enter"] = async () => {
        if (--fails === 0) delete inst.testHooks["hostLost:enter"];
        throw new Error("onHostLost lost");
      };
    });
    await silent(cell, a.host);
    // The call failed: FleetDO keeps the row and retries from its tick.
    expect(await fleetRows(cell, captain)).toEqual([{ agent: captain, host: a.host }]);
    expect((await agentStub(captain).info()).brain).toMatchObject({ host: a.host, phase: "condemned" });
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    expect(await fleetRows(cell, captain)).toEqual([]);
    await runDeadline(captain, "intent");
    expect((await nextCommands(b.ws, isStartOf(captain))).find(isStartOf(captain))).toMatchObject({ epoch: 2 });
  });

  it("A2: a start asks for the brain host's status first, and a host it finds expired releases the brain at once", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    // The host expired and the agent never heard (its notice lost for good).
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET status = 'expired' WHERE host = ?", s.host.host);
    });
    const r = await agentStub(s.agent).start(b.host);
    expect(r).toMatchObject({ host: b.host });
    expect(r.cmd).not.toBeNull();
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
    expect((await agentStub(s.agent).info()).brain).toMatchObject({ host: b.host, epoch: 2 });
  });

  it("A3: an expired host that comes back never runs a start issued before its loss (the TLC trace)", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-seams" } });
    const a = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "a3" } }, 201);
    const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
    // start{1} went to a, which never acked or answered it; its lease lapses before the brain runs.
    const batch = await a.ws.next("commands", (m) => (m.commands as any[]).some(isStartOf(captain)));
    const start1 = (batch.commands as any[]).find(isStartOf(captain));
    expect(start1.epoch).toBe(1);
    // The loss notice is delayed (its delivery fails until later).
    await runInDurableObject(agentStub(captain), (inst: AgentDO) => {
      inst.testHooks["hostLost:enter"] = async () => {
        throw new Error("onHostLost not delivered yet");
      };
    });
    await silent(cell, a.host);
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    expect((await fleet.hostStatus(a.host))!.status).toBe("expired");
    // The unanswered start failed with the expiry: the index row is gone and AgentDO heard it.
    const failed = await runInDurableObject(fleet, (_i, st) =>
      st.storage.sql.exec<{ result: string | null }>("SELECT result FROM commands WHERE cmd = ?", start1.cmd).one().result);
    expect(failed).toContain("error");
    // a comes back: its hello reactivates it, and the failed start is not resent. Its report
    // (no brain) releases the record for that epoch, though the loss notice is still delayed.
    const back = await Ws.connect("/v1/fleet", a.host_token);
    back.send(hostHello(a.host, cell, { role: "controller" }));
    await back.next("hello_ack");
    expect(await back.none("commands", 300, (m) => (m.commands as any[]).some((c) => c.cmd === start1.cmd))).toBe(true);
    expect((await agentStub(captain).info()).brain).not.toMatchObject({ host: a.host, epoch: 1 });
    // Had brain 1 run anyway, its hello would not be current.
    const ws1 = await Ws.connect(`/v1/agents/${captain}/session`, a.host_token).catch(() => null);
    if (ws1) {
      ws1.send({ type: "hello", protocol_version: 1, agent: captain, host: a.host, instance_id: "rin_late", epoch: 1, session: SESSION });
      const first = await Promise.race([ws1.next("error").then((m) => m.error.code), sleep(1500).then(() => "none")]);
      expect(first).not.toBe("none");
    }
    // The delayed notice finally lands: nothing it releases is a running brain.
    await runInDurableObject(agentStub(captain), (inst: AgentDO) => {
      delete inst.testHooks["hostLost:enter"];
    });
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    expect((await agentStub(captain).info()).agent_epoch).toBeGreaterThanOrEqual(1);
  });

  it("A3 (c): FleetDO refuses an agent_start for an expired or dead host; the start is retried elsewhere", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell, "controller");
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const body = {
      type: "agent_start", agent: "agt_x0000000000000000000000000", role: "captain", workstream: "ws_x", epoch: 1,
      launch: { builtin_tools: [], system_prompt: { mode: "replace", text: "x" } }, oauth_token: "t", session_ws_url: "ws://x",
    } as const;
    await silent(cell, a.host);
    expect((await fleet.hostStatus(a.host))!.status).toBe("expired");
    await expect(Promise.resolve().then(() => fleet.issueCommands(a.host, [body as any]))).rejects.toThrow(/expired/);
    await fleet.confirmHostDead(a.host);
    await expect(Promise.resolve().then(() => fleet.issueCommands(a.host, [body as any]))).rejects.toThrow(/dead/);
    const rows = await runInDurableObject(fleet, (_i, st) => st.storage.sql.exec("SELECT 1 FROM host_agents").toArray().length);
    expect(rows).toBe(0);
  });

  it("startFailed releases only the brain whose start failed", async () => {
    const s = await setup();
    const stub = agentStub(s.agent);
    await stub.start(); // same-host restart: brain at epoch 2
    await stub.startFailed(s.host.host, { code: "internal", message: "x", retryable: false }, 1);
    expect((await stub.info()).brain).toMatchObject({ epoch: 2 });
    await stub.startFailed(s.host.host, { code: "internal", message: "x", retryable: false }, 2);
    expect(await stub.info()).toMatchObject({ brain: null, state: "errored" });
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
  const tick = async (cell: string) => {
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    await runInDurableObject(fleet, (inst: FleetDO, st) => {
      inst.cellConfigOverride = config;
      inst.ec2Override = null;
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDurableObjectAlarm(fleet);
    return fleet;
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
    await runDeadline(s.agent, "intent");
    const start = (await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent)).find((c) => c.type === "agent_start");
    expect(start.epoch).toBe(2);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: b.host, agent_epoch: 2 });
  });

  it("H3 / rule 5 / M3: with no other host the brain is condemned anyway; the drained host isn't retired while it is indexed; the start avoids it", async () => {
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
    await spotNotice(s.host.ws); // no other host: condemned all the same
    const [kill] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(kill).toMatchObject({ mode: "kill", epoch: 1 });
    expect(await agentStub(s.agent).info()).toMatchObject({ brain: { phase: "condemned" }, intent: { avoid: s.host.host } });
    // Its brain is still indexed there: the drained host is not declared dead while it is alive.
    await tick(s.cell);
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("draining");
    // Released by its exit; no other host yet, and new work doesn't put it back on the drained host.
    const ex = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= ex);
    await runDeadline(s.agent, "intent");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "more" } }, 201);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_start" && c.agent === s.agent))).toBe(true);
    expect(await agentStub(s.agent).info()).toMatchObject({ brain: null, intent: { avoid: s.host.host } });
    // Now the drained host goes, and once another host exists the brain starts there.
    await tick(s.cell);
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("dead");
    const b = await connectHost(s.cell);
    await runDeadline(s.agent, "intent");
    const start = (await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent)).find((c) => c.type === "agent_start");
    expect(start.epoch).toBe(2);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
  });
});

describe("FleetDO and SandboxDO at the seam", () => {
  it("a wedged host's hello is refused until it is expired", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell, "controller");
    await env.FLEET.get(env.FLEET.idFromName(cell)).hostWedged(a.host, "test");
    const again = await Ws.connect("/v1/fleet", a.host_token);
    again.send(hostHello(a.host, cell, { role: "controller" }));
    expect(await again.none("hello_ack", 200)).toBe(true);
    expect(again.closed?.code).toBe(4408);
  });

  it("rule 5: a silent burst host expired without leases is retired once the idle grace passes", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const fleet = env.FLEET.get(env.FLEET.idFromName(s.cell));
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", s.sandbox);
      st.storage.sql.exec("UPDATE hosts SET instance_id = 'i-0silent' WHERE host = ?", s.host.host);
    });
    await silent(s.cell, s.host.host);
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("expired");
    const cfg: AwsCellConfig = {
      region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["c8i.large"], spot: true,
      max_hosts: 1, idle_grace_ms: 0, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
    };
    for (let n = 0; n < 2; n++) {
      await runInDurableObject(fleet, (inst: FleetDO, st) => {
        inst.cellConfigOverride = cfg;
        inst.ec2Override = null;
        st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
      });
      await runDurableObjectAlarm(fleet);
    }
    expect((await fleet.hostStatus(s.host.host))!.status).toBe("dead");
  });

  it("SandboxDO tells agents of a move from its alarm, never inside the call that moved it", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["sandboxMoved:enter"] = async () => {
        await new Promise((r) => setTimeout(r, 600));
      };
    });
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", s.sandbox);
    });
    const t0 = Date.now();
    await sandboxStub(s.sandbox).evicted(s.host.host, 1);
    expect(Date.now() - t0).toBeLessThan(400);
    await runDurableObjectAlarm(sandboxStub(s.sandbox));
    for (let n = 0; n < 40 && (await agentStub(s.agent).info()).hands_moved_ms === undefined; n++) await sleep(50);
    expect((await agentStub(s.agent).info()).hands_moved_ms).toBeDefined();
  });
});

/** Put the agent's brain on host `b`: start there, report the old brain's exit, and run the intent. */
async function moveBrain(s: { agent: string; host: { host: string; ws: Ws } }, b: { host: string; ws: Ws }) {
  const stub = agentStub(s.agent);
  const prevEpoch = (await stub.info()).agent_epoch;
  await stub.start(b.host);
  await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
  const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: prevEpoch }]);
  await s.host.ws.next("ack", (m) => m.up_to >= seq);
  await runDeadline(s.agent, "intent");
  const isStart = (c: any) => c.type === "agent_start" && c.agent === s.agent;
  return (await nextCommands(b.ws, isStart)).find(isStart);
}

/** Make `host` silent past its lease and run FleetDO's tick. */
async function silent(cell: string, host: string) {
  const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
  await runInDurableObject(fleet, (_i, st) => {
    st.storage.sql.exec("UPDATE hosts SET last_rx = ? WHERE host = ?", Date.now() - 31_000, host);
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDurableObjectAlarm(fleet);
}

async function wedgedMs(cell: string, host: string) {
  return runInDurableObject(env.FLEET.get(env.FLEET.idFromName(cell)), (_i, st) =>
    st.storage.sql.exec<{ w: number | null }>("SELECT wedged_ms AS w FROM hosts WHERE host = ?", host).one().w);
}

async function deadlineAt(agent: string, key: string) {
  return runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
    st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = ?", key).toArray()[0]?.at ?? null);
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
  it("a start no brain answers is condemned and `errored`; waiting work starts it again once its host releases it", async () => {
    const s = await setup();
    expect((await agentStub(s.agent).info()).state).toBe("starting");
    await runDeadline(s.agent, "starting");
    expect(await agentStub(s.agent).info()).toMatchObject({ state: "errored", brain: { phase: "condemned", epoch: 1 } });
    const [kill] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(kill).toMatchObject({ mode: "kill", epoch: 1 });
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "anyone there?" } }, 201);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_start"))).toBe(true);
    // nestd answers the kill of a brain that never ran with its exit at the kill's epoch.
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await runDeadline(s.agent, "intent");
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
