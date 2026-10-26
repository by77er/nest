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
    // The brain runs on another host than its sandbox (an operator's choice): AgentDO stops it where
    // it was before starting it there, under a new agent epoch.
    const b = await connectHost(s.cell);
    const { cmd } = await agentStub(s.agent).start(b.host);
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ type: "agent_stop", agent: s.agent });
    const [start] = await nextCommands(b.ws, (c) => c.cmd === cmd);
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

  it("a start elsewhere stops the old brain, and FleetDO lists it until its exit is reported", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const { cmd } = await agentStub(s.agent).start(b.host);
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    await nextCommands(b.ws, (c) => c.cmd === cmd);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: s.host.host }, { agent: s.agent, host: b.host }].sort((x, y) => x.host.localeCompare(y.host)));
    // The stop's `ok` isn't the brain gone; its exit is.
    await okResult(s.host.ws, stop.cmd);
    expect(await fleetRows(s.cell, s.agent)).toHaveLength(2);
    // The old host's report of the brain's exit drops its row and changes nothing else.
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect(await fleetRows(s.cell, s.agent)).toEqual([{ agent: s.agent, host: b.host }]);
    expect(await agentStub(s.agent).info()).toMatchObject({ host: b.host, state: "starting", agent_epoch: 2 });
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

describe("one brain per agent, also while a sandbox stays put", () => {
  const isFloor = (agent: string, e: number) => (c: any) => c.type === "client_floor" && c.agent === agent && c.agent_epoch === e;

  it("a brain moving hosts: the old one is killed, and the gateway refuses its bindings before the new one starts", async () => {
    const s = await setup();
    const b = await connectHost(s.cell);
    const { cmd } = await agentStub(s.agent).start(b.host);
    // The sandbox (still on the old host) raised the agent's floor at its gateway to epoch 2 ...
    const floor = (await nextCommands(s.host.ws, isFloor(s.agent, 2))).find(isFloor(s.agent, 2));
    // ... and the old brain is killed, not left to finish its turn.
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    await nextCommands(b.ws, (c) => c.cmd === cmd);
    // Issued in that order: the floor before the new brain's start.
    const order = await commandOrder(s.cell, [floor.cmd, cmd]);
    expect(order[0]).toBeLessThan(order[1]!);
    // A binding for the old start is no longer minted, even if asked for directly.
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve(s.agent, 1))).rejects.toThrow(/superseded/);
    expect((await sandboxStub(s.sandbox).info()).client_epochs).toEqual({ [s.agent]: 2 });

    // The new brain's binding waits for the gateway to confirm floor 2: the sandbox is running and
    // the slot confirmed, but until the floor's `ok` there is no binding at epoch 2.
    const isAttach = (c: any) => c.type === "agent_attach" && c.agent === s.agent;
    const attach = (await nextCommands(s.host.ws, isAttach)).find(isAttach);
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 1, state: "running", guest: { protocol_version: 1, capabilities: [] } }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    await okResult(s.host.ws, attach.cmd);
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve(s.agent, 2))).rejects.toThrow(/floor 2 is not confirmed/);
    await okResult(s.host.ws, floor.cmd);
    const target = await sandboxStub(s.sandbox).resolve(s.agent, 2);
    const claims = await verifyBinding(b64urlToBytes(s.host.keys[0]!.public_key), target.binding);
    expect(claims).toMatchObject({ agent_epoch: 2, client: s.agent });
  });

  it("a host of the previous release (no kill on arrival) holds a move until its brain exits or it is dead", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    // The brain's host predates the capability.
    await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET capabilities = '[]' WHERE host = ?", s.host.host);
    });
    const b = await connectHost(s.cell);
    await expect(Promise.resolve().then(() => agentStub(s.agent).start(b.host))).rejects.toThrow(/must exit first/);
    expect((await agentStub(s.agent).info()).agent_epoch).toBe(1);
    // Once it exits (the host's report clears the agent's host), the start goes ahead.
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    const { cmd } = await agentStub(s.agent).start(b.host);
    expect((await nextCommands(b.ws, (c) => c.cmd === cmd))[0]).toMatchObject({ epoch: 2 });
  });

  it("a brain told to stop isn't taken for live: a start on its host starts a new one", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    await agentStub(s.agent).stop("requested");
    const { cmd } = await agentStub(s.agent).start();
    expect(cmd).not.toBeNull();
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

  it("a brain that survives its sandbox moving is told what was lost: mid-turn as inbox, otherwise before its next turn", async () => {
    const s = await setup();
    const b = await connectHost(s.cell);
    const { cmd } = await agentStub(s.agent).start(b.host);
    await nextCommands(b.ws, (c) => c.cmd === cmd);
    const ws = await runner(s.agent, b.host, b.host_token, "rin_b", 2);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "first" } }, 201);
    const t1 = await ws.next("run_turn");
    // The sandbox's host dies mid-turn; the sandbox is restored elsewhere.
    s.host.ws.close();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    const inbox = await ws.next("inbox");
    expect(inbox.message).toMatchObject({ from: "system" });
    expect(inbox.message.text).toMatch(/Your sandbox moved to another machine/);
    // Between turns: the next turn starts with the note.
    ws.send({ type: "events", seq: 1, events: [{ agent: s.agent, epoch: 2, seq: 1, ts_ms: Date.now(), turn: t1.turn, type: "turn_completed", stop_reason: "end_turn" }] });
    await ws.next("ack");
    await agentStub(s.agent).onSandboxMoved(s.sandbox, b.host);
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "second" } }, 201);
    const t2 = await ws.next("run_turn", (m) => m.input.text.endsWith("second"));
    expect(t2.input.text).toMatch(/^Your sandbox moved to another machine[\s\S]*\n\nsecond$/);
  });

  it("concurrent starts share one: one epoch, one agent_start; a wake meanwhile starts nothing", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    const [r1, r2] = await Promise.all([stub.start(b.host), stub.start(b.host)]);
    expect(r1).toEqual(r2);
    expect((await stub.info()).agent_epoch).toBe(2);
    const starts = await runInDurableObject(env.FLEET.get(env.FLEET.idFromName(s.cell)), (_i, st) =>
      st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM commands WHERE type = 'agent_start' AND agent = ?", s.agent).one().n);
    expect(starts).toBe(2); // setup's, and one more
  });

  it("the wake() guard: a wake while a start is in flight does not start a second brain", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    await runDeadline(s.agent, "starting"); // errored: a wake would start it again
    const stub = agentStub(s.agent);
    const b = await connectHost(s.cell);
    // A turn arrives (it wakes the agent) while an operator's start is in flight.
    const [started] = await Promise.all([
      stub.start(b.host),
      adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "now" } }, 201),
    ]);
    expect(started.host).toBe(b.host);
    expect((await stub.info()).agent_epoch).toBe(2);
  });

  it("the brain index keeps a newer start's row against an older stop's result and an older brain's exit", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    const stub = agentStub(s.agent);
    await stub.start(b.host); // epoch 2 on b; stop{epoch 1} to a
    const [stopA] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    // Back to a under epoch 3 before a confirmed the stop: a stop{epoch 2} goes to b.
    await editAgent(s.agent, (i) => {
      i.state = "detached";
    });
    await stub.start(s.host.host);
    expect((await stub.info()).agent_epoch).toBe(3);
    // a runs the stop (for epoch 1), then the start (epoch 3): the stop's result keeps epoch 3's row.
    await okResult(s.host.ws, stopA.cmd);
    expect((await fleetRows(s.cell, s.agent)).map((r) => r.host)).toContain(s.host.host);
    // The killed epoch-1 brain's exit on a changes nothing either.
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect((await fleetRows(s.cell, s.agent)).map((r) => r.host)).toContain(s.host.host);
    expect(await stub.info()).toMatchObject({ host: s.host.host, state: "starting", agent_epoch: 3 });
    // The current brain's exit counts, and clears the host: the next start sends no stop.
    const seq2 = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 3 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq2);
    expect(await stub.info()).toMatchObject({ host: null, state: "detached" });
    expect((await fleetRows(s.cell, s.agent)).map((r) => r.host)).not.toContain(s.host.host);
    await stub.start(b.host);
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => c.type === "agent_stop" && c.epoch === 3))).toBe(true);
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

  it("the old session after start(otherHost) is refused too", async () => {
    const s = await setup();
    const ws = await runner(s.agent, s.host.host, s.host.host_token, "rin_one", 1);
    const b = await connectHost(s.cell);
    await agentStub(s.agent).start(b.host);
    // Whether the close (4409) or the epoch check stops them, nothing the old brain sends runs.
    const trySend = (m: unknown) => {
      try {
        ws.send(m);
      } catch {
        // closed by the start
      }
    };
    trySend({ type: "tool_call", seq: 1, call: "cal_old-2", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "late" } });
    trySend({ type: "hands_resolve", request: "req_old2" });
    expect(await ws.none("tool_result", 200)).toBe(true);
    expect(await ws.none("hands_resolved", 50, (m) => m.outcome?.status === "ok")).toBe(true);
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

  it("move off it at once when another host can take them: killed there, fenced at the gateway, started elsewhere", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.start.cmd);
    const b = await connectHost(s.cell);
    await spotNotice(s.host.ws);
    const [stop] = await nextCommands(s.host.ws, (c) => c.type === "agent_stop" && c.agent === s.agent);
    expect(stop).toMatchObject({ mode: "kill", epoch: 1 });
    await nextCommands(s.host.ws, isClientFloor(s.agent, 2));
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

const isClientFloor = (agent: string, e: number) => (c: any) => c.type === "client_floor" && c.agent === agent && c.agent_epoch === e;

/** Issue order (rowid) of FleetDO commands. */
async function commandOrder(cell: string, cmds: string[]) {
  return runInDurableObject(env.FLEET.get(env.FLEET.idFromName(cell)), (_i, st) =>
    cmds.map((c) => st.storage.sql.exec<{ r: number }>("SELECT rowid AS r FROM commands WHERE cmd = ?", c).one().r));
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
