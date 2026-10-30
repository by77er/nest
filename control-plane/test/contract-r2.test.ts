// cancel_call (runner abandoned a platform call) and inbox_delivered (prune the inbox mirror).
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminJson, connectHost, nextCommands, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

async function setup() {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "ship it" } }, 201);
  const captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent as string;
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, captain } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  const ws = await Ws.connect(`/v1/agents/${worker.agent}/session`, host.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: worker.agent, host: host.host, instance_id: "rin_r2", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  return { workstream, agent: worker.agent as string, captain, ws };
}

describe("cancel_call", () => {
  it("stops an ask's sync wait without a tool_result; a later answer arrives as a turn", async () => {
    const s = await setup();
    s.ws.send({ type: "tool_call", seq: 1, call: "cal_c1-1", turn: "trn_x", name: "ask", arguments: { question: "Deploy?", to: "user" } });
    expect((await s.ws.next("ack")).up_to).toBe(1);
    s.ws.send({ type: "cancel_call", seq: 2, call: "cal_c1-1", reason: "timed out" });
    expect((await s.ws.next("ack")).up_to).toBe(2);
    await sleep(250);
    await runDurableObjectAlarm(agentStub(s.agent));
    expect(await s.ws.none("tool_result", 100)).toBe(true);
    const note = (await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).userNotifications()).at(-1)!;
    const ask = /\[(ask_[A-Za-z0-9]+)\]/.exec(note.text)![1];
    expect((await adminJson(`/v1/agents/${s.agent}/asks/${ask}/answer`, { body: { answer: "yes" } })).delivered).toBe("async");
    expect((await agentStub(s.agent).turns()).at(-1)!.input).toMatchObject({ kind: "ask_answer" });
  });

  it("a call cancelled before it arrives never runs; the same call id gets outcome_unknown", async () => {
    const s = await setup();
    s.ws.send({ type: "cancel_call", seq: 1, call: "cal_c2-1", reason: "timed out" });
    expect((await s.ws.next("ack")).up_to).toBe(1);
    s.ws.send({ type: "tool_call", seq: 2, call: "cal_c2-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "should never arrive" } });
    const r = await s.ws.next("tool_result", (m) => m.call === "cal_c2-1");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect(await agentStub(s.captain).turns()).toEqual([]);
  });
});

describe("inbox_delivered", () => {
  it("prunes the delivered message from the runner's inbox mirror", async () => {
    const s = await setup();
    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "go" } }, 201)).turn;
    const run = await s.ws.next("run_turn");
    s.ws.send({ type: "ack", up_to: run.seq });
    const msg = (await adminJson(`/v1/agents/${s.agent}/inbox`, { body: { text: "rebase first" } }, 201));
    const inbox = await s.ws.next("inbox");
    await s.ws.next("cache_update", (m) => m.cache.inbox.length === 1);
    s.ws.send({ type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), turn: t1, type: "inbox_delivered", message: inbox.message.id },
    ] });
    expect((await s.ws.next("ack")).up_to).toBe(1);
    const pruned = await s.ws.next("cache_update", (m) => m.cache.inbox.length === 0);
    expect(pruned.cache.inbox).toEqual([]);
    expect(msg).toBeDefined();
  });
});
