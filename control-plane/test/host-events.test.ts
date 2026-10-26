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
    const host = await connectHost(cell);
    const ws = (await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "x" } }, 201)).workstream;
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    await nextCommands(host.ws, (c) => c.type === "sandbox_create");
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

describe("egress audit in R2", () => {
  const record = (sandbox: string, epoch: number, ts: number, host: string) => ({
    sandbox, epoch, ts_ms: ts, host, port: 443, bytes_up: 0, bytes_down: 0, verdict: "deny", reason: "not_allowed",
  });
  async function auditUnder(prefix: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const o of (await env.BUCKET.list({ prefix })).objects) out[o.key] = await (await env.BUCKET.get(o.key))!.text();
    return out;
  }

  it("is written per sandbox and UTC day, and only from the lease holder at its epoch", async () => {
    const cell = uniqueCell();
    const holder = await connectHost(cell);
    const ws = (await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "audit" } }, 201)).workstream;
    const sbx = await adminJson<{ sandbox: string; host: string }>("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    expect(sbx.host).toBe(holder.host);
    const other = await connectHost(cell);
    const day1 = Date.UTC(2026, 9, 24, 23, 59);
    const day2 = Date.UTC(2026, 9, 25, 0, 1);
    const records = [record(sbx.sandbox, 1, day1, "a.example"), record(sbx.sandbox, 1, day2, "b.example"), record(sbx.sandbox, 2, day2, "stale-epoch.example")];
    const seq = sendEvents(holder.ws, [{ ts_ms: day2, type: "egress_audit", records }]);
    await holder.ws.next("ack", (m) => m.up_to === seq);
    const seq2 = sendEvents(other.ws, [{ ts_ms: day2, type: "egress_audit", records: [record(sbx.sandbox, 1, day2, "not-holder.example")] }]);
    await other.ws.next("ack", (m) => m.up_to === seq2);

    const objects = await auditUnder(`audit/${sbx.sandbox}/`);
    const byDay = (day: string) => Object.entries(objects).filter(([k]) => k.startsWith(`audit/${sbx.sandbox}/${day}/`)).map(([, v]) => v).join("");
    expect(byDay("2026-10-24")).toContain("a.example");
    expect(byDay("2026-10-25")).toContain("b.example");
    expect(Object.keys(objects)).toHaveLength(2);
    const all = Object.values(objects).join("");
    expect(all).not.toContain("stale-epoch.example");
    expect(all).not.toContain("not-holder.example");
    expect(await auditUnder(`audit/${holder.host}/`)).toEqual({});
  });
});
