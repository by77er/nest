// A host's event stream keeps moving past a bad event, and `agent_exited` reasons are an enum on the
// wire (an older nestd's free text still parses).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminJson, connectHost, nextCommands, sendEvents, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const agentStub = (agent: string) => env.AGENT.get(env.AGENT.idFromName(agent));

async function capacityOf(cell: string, host: string): Promise<Record<string, unknown> | null> {
  const row = await runInDurableObject(fleetStub(cell), (_i, st) =>
    st.storage.sql.exec<{ capacity: string | null }>("SELECT capacity FROM hosts WHERE host = ?", host).toArray()[0]);
  return row?.capacity ? JSON.parse(row.capacity) : null;
}

const capacity = (vcpus: number) => ({
  ts_ms: Date.now(), type: "capacity",
  capacity: { vcpus_free: vcpus, memory_mib_free: 1024, hugepages_mib_free: 0, sandboxes: 0, agents: 0, warm: [] },
});

describe("a bad event in a host's batch", () => {
  it("is quarantined: the batch is acked, the good events in it are applied, and the stream moves on", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    // `NEST_AGENT_ID=x nest notify hi` from inside a sandbox, relayed by a nestd that didn't check it.
    const bad = {
      ts_ms: Date.now(), type: "guest_cli", request: "req_bad", sandbox: "sbx_nope", epoch: 1, agent: "x",
      command: { command: "notify", to: "captain", message: "hi" },
    };
    const seq = sendEvents(h.ws, [capacity(3), bad, capacity(5)]);
    await h.ws.next("ack", (m) => m.up_to === seq);
    expect(await capacityOf(cell, h.host)).toMatchObject({ vcpus_free: 5 });
    // The next batch is in sequence, not a gap: nothing was left unacked.
    const next = sendEvents(h.ws, [capacity(7)]);
    await h.ws.next("ack", (m) => m.up_to === next);
    expect(await capacityOf(cell, h.host)).toMatchObject({ vcpus_free: 7 });
    expect(await h.ws.none("error", 50)).toBe(true);
  });
});

describe("agent_exited reasons", () => {
  async function workerOn(cell: string) {
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-exit" } });
    const sbxHost = await connectHost(cell);
    const host = await connectHost(cell, "brain");
    const ws = (await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "x" } }, 201)).workstream;
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
    const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream: ws, sandbox: sbx.sandbox, cell } }, 201);
    await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
    return { host, agent: worker.agent as string };
  }

  const exited = (ws: Parameters<typeof sendEvents>[0], agent: string, reason: string) =>
    sendEvents(ws, [{ ts_ms: Date.now(), type: "agent_exited", agent, reason }]);
  const isStart = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;

  it("an older nestd's free-text reason is acked and parsed as `unknown`: detached, not restarted even with work waiting", async () => {
    const { host, agent } = await workerOn(uniqueCell());
    await adminJson(`/v1/agents/${agent}/turns`, { body: { text: "queued" } }, 201);
    const seq = exited(host.ws, agent, "idle grace elapsed");
    await host.ws.next("ack", (m) => m.up_to === seq);
    expect((await agentStub(agent).info()).state).toBe("detached");
    expect(await host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isStart(agent)))).toBe(true);
  });

  it("an enum reason that restarts (`fenced`) brings the brain straight back when work is waiting", async () => {
    const { host, agent } = await workerOn(uniqueCell());
    await adminJson(`/v1/agents/${agent}/turns`, { body: { text: "queued" } }, 201);
    const seq = exited(host.ws, agent, "fenced");
    await host.ws.next("ack", (m) => m.up_to === seq);
    await nextCommands(host.ws, isStart(agent));
  });
});
