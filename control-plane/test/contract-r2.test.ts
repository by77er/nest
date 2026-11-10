// cancel_call (runner abandoned a platform call) and inbox_delivered (prune the inbox mirror).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminJson, connectHost, eventually, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

async function setup() {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  const captain = (await adminJson("/v1/agents", { body: { role: "captain", cell } }, 201)).agent as string;
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", sandbox: sbx.sandbox, cell, captain } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  const ws = await Ws.connect(`/v1/agents/${worker.agent}/session`, host.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: worker.agent, host: host.host, instance_id: "rin_r2", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  return { agent: worker.agent as string, captain, ws };
}

describe("cancel_call", () => {
  it("a call cancelled before it arrives never runs; the same call id gets outcome_unknown", async () => {
    const s = await setup();
    s.ws.send({ type: "cancel_call", seq: 1, call: "cal_c2-1", reason: "timed out" });
    expect((await s.ws.next("ack")).up_to).toBe(1);
    s.ws.send({ type: "tool_call", seq: 2, call: "cal_c2-1", turn: "trn_x", name: "exit", arguments: { reason: "should never happen" } });
    const r = await s.ws.next("tool_result", (m) => m.call === "cal_c2-1");
    expect(r.outcome).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect((await agentStub(s.agent).info()).ended).toBeUndefined();
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

describe("the hourly prune", () => {
  it("leaves the agent's own turn alone however old it is, and requeues a message mirrored to a turn long gone", async () => {
    const s = await setup();
    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "a long job" } }, 201)).turn;
    const run = await s.ws.next("run_turn");
    s.ws.send({ type: "ack", up_to: run.seq });
    // The turn has run for eight days under a live brain; a message from then was mirrored to a turn that is gone.
    const old = Date.now() - 8 * 86_400_000;
    await runInDurableObject(agentStub(s.agent), (_i, st) => {
      st.storage.sql.exec("UPDATE turns SET started_ms = ?, created_ms = ? WHERE turn = ?", old, old, t1);
      st.storage.sql.exec("INSERT INTO inbox (id, message, turn, status, created_ms) VALUES ('msg_old', ?, 'trn_gone', 'delivered', ?)",
        JSON.stringify({ id: "msg_old", from: "operator", text: "never shown", interrupt: false, ts_ms: old }), old);
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(agentStub(s.agent));
    expect((await agentStub(s.agent).info()).current_turn).toBe(t1);
    const turns = await runInDurableObject(agentStub(s.agent), (_i, st) =>
      st.storage.sql.exec<{ turn: string; status: string; input: string }>("SELECT turn, status, input FROM turns ORDER BY ord").toArray());
    expect(turns.find((t) => t.turn === t1)!.status).toBe("active");
    const queued = turns.filter((t) => t.status === "queued");
    expect(queued).toHaveLength(1);
    expect(JSON.parse(queued[0]!.input)).toMatchObject({ kind: "inbox", text: "Message from operator: never shown" });
    expect(await runInDurableObject(agentStub(s.agent), (_i, st) => st.storage.sql.exec("SELECT 1 FROM inbox WHERE status = 'delivered'").toArray().length)).toBe(0);
  });
});
