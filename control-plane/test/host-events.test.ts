// A host's event stream keeps moving past a bad event, and `agent_exited` reasons are an enum on the
// wire (an older nestd's free text still parses).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SandboxId } from "../src/protocol/model";
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
  async function placed() {
    const cell = uniqueCell();
    const holder = await connectHost(cell);
    const ws = (await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "audit" } }, 201)).workstream;
    const sbx = await adminJson<{ sandbox: string; host: string }>("/v1/sandboxes", { body: { workstream: ws, cell } }, 201);
    expect(sbx.host).toBe(holder.host);
    await nextCommands(holder.ws, (c) => c.type === "sandbox_create");
    const other = await connectHost(cell);
    return { cell, holder, other, sandbox: sbx.sandbox };
  }
  const audit = async (h: Awaited<ReturnType<typeof connectHost>>, ts: number, records: unknown[]) => {
    const seq = sendEvents(h.ws, [{ ts_ms: ts, type: "egress_audit", records }]);
    await h.ws.next("ack", (m) => m.up_to === seq);
  };
  const day1 = Date.UTC(2026, 9, 24, 23, 59);
  const day2 = Date.UTC(2026, 9, 25, 0, 1);

  it("is written per sandbox, UTC day, epoch and host, only from a host that held the sandbox at that epoch", async () => {
    const { holder, other, sandbox } = await placed();
    await audit(holder, day2, [record(sandbox, 1, day1, "a.example"), record(sandbox, 1, day2, "b.example"), record(sandbox, 2, day2, "never-held-epoch.example")]);
    await audit(other, day2, [record(sandbox, 1, day2, "never-held-host.example")]);
    const objects = await auditUnder(`audit/${sandbox}/`);
    const keys = Object.keys(objects);
    expect(keys).toHaveLength(2);
    expect(keys.find((k) => k.startsWith(`audit/${sandbox}/2026-10-24/1-${holder.host}-${day2}-`))).toBeDefined();
    expect(objects[keys.find((k) => k.includes("/2026-10-25/"))!]).toContain("b.example");
    const all = Object.values(objects).join("");
    expect(all).not.toContain("never-held-epoch.example");
    expect(all).not.toContain("never-held-host.example");
  });

  it("keeps what a cut-off host buffered at its own epoch after the lease moved on", async () => {
    const { cell, holder, other, sandbox } = await placed();
    // The lease moves to another host at a newer epoch while the holder is partitioned.
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      st.storage.sql.exec("UPDATE leases SET host = ?, epoch = 2 WHERE sandbox = ?", other.host, sandbox);
    });
    await audit(holder, day2, [record(sandbox, 1, day2, "zombie-buffered.example")]);
    await audit(other, day2, [record(sandbox, 1, day2, "other-at-old-epoch.example")]);
    const all = Object.values(await auditUnder(`audit/${sandbox}/`)).join("");
    expect(all).toContain("zombie-buffered.example");
    expect(all).not.toContain("other-at-old-epoch.example");
  });

  it("a resent batch overwrites itself, and a timestamp no Date can hold is still written (never nacked)", async () => {
    const { holder, sandbox } = await placed();
    const batch = [record(sandbox, 1, day2, "twice.example")];
    await audit(holder, day2, batch);
    await audit(holder, day2, batch);
    expect(Object.keys(await auditUnder(`audit/${sandbox}/`))).toHaveLength(1);
    await audit(holder, 9e15, [record(sandbox, 1, 9e15, "far-future.example")]);
    expect(Object.values(await auditUnder(`audit/${sandbox}/`)).join("")).toContain("far-future.example");
  });

  it("a sandbox id is lowercase letters and digits after `sbx_`, since it names R2 keys", () => {
    for (const bad of ["sbx_../x", "sbx_A1", "sbx_", "sbx_a-b", `sbx_${"a".repeat(65)}`]) expect(SandboxId.safeParse(bad).success, bad).toBe(false);
    expect(SandboxId.safeParse("sbx_01jb7m2a4c").success).toBe(true);
  });
});
