// AgentDO and BrokerDO at their seams: side effects that must not be lost, an epoch copy that must not
// fence, secret references that must stay in their slot, and states that must not strand an agent.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { SandboxDO } from "../src/do/sandbox";
import { adminJson, connectHost, nextCommands, sleep, uniqueCell, Ws } from "./helpers";

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

describe("AgentDO's copy of the sandbox epoch is not an authority", () => {
  it("after a lost move push, the guest CLI and task exits still work and events carry SandboxDO's epoch", async () => {
    const s = await setup();
    const b = await connectHost(s.cell);
    s.host.ws.close();
    await adminJson(`/v1/admin/hosts/${s.host.host}/confirm-dead?cell=${s.cell}`, { body: {} });
    expect(await sandboxStub(s.sandbox).info()).toMatchObject({ epoch: 2, host: b.host });
    await nextCommands(b.ws, (c) => c.type === "agent_start" && c.agent === s.agent);
    // As if `onSandboxMoved` never arrived: AgentDO still holds epoch 1 (and is mid-turn).
    await editAgent(s.agent, (i) => {
      i.hands.epoch = 1;
      i.current_turn = "trn_lostpush";
    });

    // FleetDO relays these only from the lease holder at epoch 2; AgentDO must not refuse them.
    const r = await agentStub(s.agent).guestCli(s.sandbox, 2, { command: "emit", event: "progress", payload: { summary: "after the move" } });
    expect(r.status).toBe("ok");
    expect((await wsStub(s.workstream).events()).at(-1)).toMatchObject({ type: "progress", sandbox: s.sandbox, epoch: 2 });
    await agentStub(s.agent).onTaskExited(s.sandbox, 2, {
      task_id: "tsk_1", status: "exited", exit_code: 0, output_path: "/tmp/o", output_bytes: 0, started_ms: Date.now(),
    });
    const inbox = await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ message: string }>("SELECT message FROM inbox").toArray().map((m) => m.message).join("\n"));
    expect(inbox).toContain("Background task tsk_1 exited with code 0");

    // The next start reads SandboxDO's epoch, so the cache heals and the brain starts at epoch 2.
    await editAgent(s.agent, (i) => {
      i.current_turn = null;
    });
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(b.ws, (c) => c.cmd === cmd);
    expect(start.hands).toEqual({ sandbox: s.sandbox, epoch: 2 });
  });
});

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
    expect(again.hands).toEqual({ sandbox: s.sandbox, epoch: 1 });
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
