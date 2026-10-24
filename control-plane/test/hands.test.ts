// The control plane's side of the seam (docs/sandbox/gateway/, docs/control-plane/durable-objects/sandbox/):
// hosts get the cell's binding keys, SandboxDO configures slots with agent_attach and hands out
// bindings only once a slot is confirmed, resolve answers not-ready or not-bound otherwise, and the
// runner gets its target over the session channel. The oracle for every token is verifyBinding with
// the key the host received, never the code that minted it.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { kidOf, verifyBinding } from "../src/lib/binding";
import { b64urlToBytes } from "../src/lib/util";
import type { HandsTarget } from "../src/protocol/gateway";
import { adminJson, connectHost, enrollHost, GATEWAY_URL, hostHello, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const HOUR = 3_600_000;
const rejects = (p: Promise<unknown>) => expect(Promise.resolve().then(() => p)).rejects;

async function runAlarm(stub: DurableObjectStub, key: string) {
  await runInDurableObject(stub, (_i, st) => {
    st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = ?", key);
  });
  await runDurableObjectAlarm(stub);
}

/** An attach command's result: an error nestd would give while the guest is unreachable (retryable). */
async function failResult(ws: Ws, cmd: string, retryable = true) {
  const seq = sendEvents(ws, [{
    ts_ms: Date.now(), type: "command_result", cmd,
    outcome: { status: "error", error: { code: "busy", message: "no guest connection", retryable } },
  }]);
  await ws.next("ack", (m) => m.up_to >= seq);
}

/** What nestd reports for the guest with every `running` (shape: protocol/fixtures/control/host_event/sandbox_state.running.json). */
const GUEST = { protocol_version: 1, capabilities: [] };
const running = async (ws: Ws, sandbox: string, epoch: number, state = "running", guest: unknown = GUEST) => {
  const seq = sendEvents(ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox, epoch, state, ...(state === "running" && guest ? { guest } : {}) }]);
  await ws.next("ack", (m) => m.up_to >= seq);
};

async function setup(opts: { guest?: unknown } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-hands" } });
  const host = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "hands" } }, 201);
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, start: false } }, 201);
  const [attach] = await nextCommands(host.ws, (c) => c.type === "agent_attach" && c.agent === worker.agent);
  // nestd reports `running` once the guest is up, before any attach result; resolve needs it.
  await running(host.ws, sbx.sandbox, 1, "running", "guest" in opts ? opts.guest : GUEST);
  const pub = b64urlToBytes(host.keys[0]!.public_key);
  return { cell, host, workstream, sandbox: sbx.sandbox as string, agent: worker.agent as string, attach, pub };
}

async function verified(pub: Uint8Array, target: HandsTarget) {
  const claims = await verifyBinding(pub, target.binding);
  expect(claims, "the binding verifies with the key the host received").not.toBeNull();
  return claims!;
}

describe("binding keys", () => {
  it("every host receives the cell's keys after hello_ack, and the kid names the key", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    expect(a.keys).toHaveLength(1);
    const pub = b64urlToBytes(a.keys[0]!.public_key);
    expect(pub.length).toBe(65);
    expect(a.keys[0]!.kid).toBe(await kidOf(pub));
    // A second host in the same cell gets the same key; another cell gets its own.
    const b = await connectHost(cell, "controller");
    expect(b.keys).toEqual(a.keys);
    const other = await connectHost(uniqueCell());
    expect(other.keys[0]!.kid).not.toBe(a.keys[0]!.kid);
  });
});

describe("attach and resolve", () => {
  it("issues agent_attach to the sandbox's host at create, and no binding until its ok", async () => {
    const s = await setup();
    expect(s.attach).toMatchObject({ type: "agent_attach", sandbox: s.sandbox, epoch: 1, agent: s.agent });
    expect(s.attach.cwd).toBeUndefined();
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve(s.agent))).rejects.toThrow(/sandbox_not_ready/);
    await okResult(s.host.ws, s.attach.cmd);
    const target = await sandboxStub(s.sandbox).resolve(s.agent);
    expect(target).toMatchObject({ url: GATEWAY_URL, sandbox: s.sandbox, epoch: 1, guest: { protocol_version: 1, capabilities: [] } });
    const claims = await verified(s.pub, target);
    expect(claims).toMatchObject({ v: 1, kid: s.host.keys[0]!.kid, sandbox: s.sandbox, epoch: 1, client: s.agent, scope: "hands" });
    expect(claims.exp_ms).toBeGreaterThan(Date.now() + HOUR - 10_000);
    expect(claims.exp_ms).toBeLessThan(Date.now() + HOUR + 10_000);
    // The operator route hands out the same kind of target (what a person's CLI and the e2e probe use).
    const viaApi = await adminJson<HandsTarget>(`/v1/sandboxes/${s.sandbox}/resolve`, { body: { client: s.agent } });
    expect((await verified(s.pub, viaApi)).client).toBe(s.agent);
    // Another cell's key does not verify it.
    const stranger = await connectHost(uniqueCell());
    expect(await verifyBinding(b64urlToBytes(stranger.keys[0]!.public_key), target.binding)).toBeNull();
  });

  it("an unattached client is not_bound; an unplaced sandbox is not ready", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve("agt_nobody000000000000000000"))).rejects.toThrow(/not_bound/);
    const empty = uniqueCell();
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "no hosts" } }, 201);
    const unplaced = await adminJson("/v1/sandboxes", { body: { workstream, cell: empty } }, 202);
    const w = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: unplaced.sandbox, cell: empty, start: false } }, 201);
    await expect(Promise.resolve().then(() => sandboxStub(unplaced.sandbox).resolve(w.agent))).rejects.toThrow(/sandbox_not_ready/);
  });

  it("a new placement re-issues agent_attach under the new epoch; the old epoch's binding is not renewed", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    const first = await sandboxStub(s.sandbox).resolve(s.agent);
    // The host lost the sandbox (its lease released, the sandbox evicted); something wakes it.
    await fleetStub(s.cell).releaseLease(s.sandbox);
    await sandboxStub(s.sandbox).evicted(s.host.host, 1);
    await sandboxStub(s.sandbox).wake();
    await nextCommands(s.host.ws, (c) => c.type === "sandbox_create" && c.epoch === 2);
    const [again] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && c.epoch === 2);
    expect(again).toMatchObject({ sandbox: s.sandbox, agent: s.agent });
    await running(s.host.ws, s.sandbox, 2);
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve(s.agent))).rejects.toThrow(/sandbox_not_ready/);
    await okResult(s.host.ws, again.cmd);
    const second = await sandboxStub(s.sandbox).resolve(s.agent);
    const secondClaims = await verified(s.pub, second);
    const firstClaims = await verified(s.pub, first);
    expect(secondClaims.epoch).toBe(2);
    expect(firstClaims.epoch).toBe(1);
    expect(second.epoch).toBe(secondClaims.epoch);
    // The pending mark was re-issued and cleared, not left over from the old placement.
    expect((await sandboxStub(s.sandbox).info()).attach_pending).toEqual([]);
  });

  it("an attach that fails twice is retried with backoff and a stale attempt's result is ignored", async () => {
    const s = await setup();
    await failResult(s.host.ws, s.attach.cmd);
    expect((await sandboxStub(s.sandbox).info()).attach_attempts[s.agent]).toBe(1);
    await runAlarm(sandboxStub(s.sandbox), "attach_retry");
    const [second] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && c.cmd !== s.attach.cmd);
    await failResult(s.host.ws, second.cmd);
    expect((await sandboxStub(s.sandbox).info()).attach_attempts[s.agent]).toBe(2);
    await runAlarm(sandboxStub(s.sandbox), "attach_retry");
    const [third] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && ![s.attach.cmd, second.cmd].includes(c.cmd));
    // A late ok for the first attempt proves nothing about the slot the third attempt configures.
    await okResult(s.host.ws, s.attach.cmd);
    await rejects(sandboxStub(s.sandbox).resolve(s.agent)).toThrow(/sandbox_not_ready/);
    await okResult(s.host.ws, third.cmd);
    expect((await verified(s.pub, await sandboxStub(s.sandbox).resolve(s.agent))).client).toBe(s.agent);
    expect((await sandboxStub(s.sandbox).info()).attach_attempts[s.agent]).toBe(0);
  });

  it("an attach to a suspended sandbox completes once the sandbox reports running", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await running(s.host.ws, s.sandbox, 1, "suspended");
    const other = await adminJson("/v1/agents", { body: { role: "worker", workstream: s.workstream, sandbox: s.sandbox, cell: s.cell, start: false } }, 201);
    const [first] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && c.agent === other.agent);
    await failResult(s.host.ws, first.cmd);
    await running(s.host.ws, s.sandbox, 1, "running");
    const [again] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && c.agent === other.agent && c.cmd !== first.cmd);
    await rejects(sandboxStub(s.sandbox).resolve(other.agent)).toThrow(/sandbox_not_ready/);
    await okResult(s.host.ws, again.cmd);
    expect((await verified(s.pub, await sandboxStub(s.sandbox).resolve(other.agent))).client).toBe(other.agent);
  });

  it("a resolve on a suspended sandbox is not ready until it reports running", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await running(s.host.ws, s.sandbox, 1, "suspended");
    // resolve wakes the sandbox (a resume to the host) but never mints while the resume is in flight:
    // nestd forgets the gateway entry on suspend and re-adds it only before it reports `running`.
    await rejects(sandboxStub(s.sandbox).resolve(s.agent)).toThrow(/sandbox_not_ready/);
    const [resume] = await nextCommands(s.host.ws, (c) => c.type === "sandbox_resume");
    await okResult(s.host.ws, resume.cmd);
    await rejects(sandboxStub(s.sandbox).resolve(s.agent)).toThrow(/sandbox_not_ready/);
    await running(s.host.ws, s.sandbox, 1, "running");
    expect((await verified(s.pub, await sandboxStub(s.sandbox).resolve(s.agent))).epoch).toBe(1);
  });

  it("a host that missed its binding keys gets them on its next heartbeat", async () => {
    const s = await setup();
    // The keys went out after hello_ack. Forget that they did (what a FleetDO restart does), and the
    // next heartbeat carries them again; one that has them gets none.
    await runInDurableObject(fleetStub(s.cell), (inst) => {
      (inst as unknown as { keysSent: Set<string> }).keysSent.clear();
    });
    s.host.ws.send({ type: "heartbeat", sent_ms: 1, leases: [] });
    const again = await s.host.ws.next("binding_key");
    expect(again.keys).toEqual(s.host.keys);
    s.host.ws.send({ type: "heartbeat", sent_ms: 2, leases: [] });
    await s.host.ws.next("heartbeat_ack");
    expect(await s.host.ws.none("binding_key", 200)).toBe(true);
  });

  it("a repeat attach of a confirmed agent sends nothing and keeps the slot confirmed", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await sandboxStub(s.sandbox).attach(s.agent);
    expect(await s.host.ws.none("commands", 200)).toBe(true);
    expect((await verified(s.pub, await sandboxStub(s.sandbox).resolve(s.agent))).client).toBe(s.agent);
  });

  it("eviction while the slot is pending: not ready, then re-issued and confirmed under the new epoch", async () => {
    const s = await setup();
    await fleetStub(s.cell).releaseLease(s.sandbox);
    await sandboxStub(s.sandbox).evicted(s.host.host, 1);
    await rejects(sandboxStub(s.sandbox).resolve(s.agent)).toThrow(/sandbox_not_ready/);
    await okResult(s.host.ws, s.attach.cmd); // the old placement's late result changes nothing
    await sandboxStub(s.sandbox).wake();
    const [again] = await nextCommands(s.host.ws, (c) => c.type === "agent_attach" && c.epoch === 2);
    expect((await sandboxStub(s.sandbox).info()).attach_pending).toEqual([s.agent]);
    await running(s.host.ws, s.sandbox, 2);
    await okResult(s.host.ws, again.cmd);
    expect((await verified(s.pub, await sandboxStub(s.sandbox).resolve(s.agent))).epoch).toBe(2);
  });

  it("a host that advertises no gateway is not ready, not an error", async () => {
    const cell = uniqueCell();
    const enrolled = await enrollHost(cell);
    const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
    ws.send(hostHello(enrolled.host, cell, { gateway_url: undefined }));
    await ws.next("hello_ack");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "no gateway" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(ws, (c) => c.type === "sandbox_create");
    const w = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, start: false } }, 201);
    const [attach] = await nextCommands(ws, (c) => c.type === "agent_attach");
    await okResult(ws, attach.cmd);
    await rejects(sandboxStub(sbx.sandbox).resolve(w.agent)).toThrow(/sandbox_not_ready/);
  });

  it("two resolves mint distinct tokens that both verify", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    const a = await sandboxStub(s.sandbox).resolve(s.agent);
    const b = await sandboxStub(s.sandbox).resolve(s.agent);
    expect(a.binding).not.toBe(b.binding);
    expect((await verified(s.pub, a)).client).toBe(s.agent);
    expect((await verified(s.pub, b)).client).toBe(s.agent);
  });

  it("a detach during signing yields not_bound, never a token", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    const stub = sandboxStub(s.sandbox);
    const [resolved, detached] = await Promise.allSettled([stub.resolve(s.agent), stub.detach(s.agent)]);
    expect(detached.status).toBe("fulfilled");
    if (resolved.status === "fulfilled") {
      // The resolve won the race: its token names a client the gateway no longer accepts after agent_detach.
      expect((await verified(s.pub, resolved.value)).client).toBe(s.agent);
    } else {
      expect(String(resolved.reason)).toMatch(/not_bound/);
    }
    await rejects(stub.resolve(s.agent)).toThrow(/not_bound/);
  });

  it("detach issues agent_detach with the kill, and resolve is not_bound afterwards", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await sandboxStub(s.sandbox).detach(s.agent);
    const [detach] = await nextCommands(s.host.ws, (c) => c.type === "agent_detach");
    expect(detach).toMatchObject({ sandbox: s.sandbox, epoch: 1, agent: s.agent, kill_processes: true });
    await expect(Promise.resolve().then(() => sandboxStub(s.sandbox).resolve(s.agent))).rejects.toThrow(/not_bound/);
  });

  it("the guest's version comes only from a running report: none reported is not ready, never a guess", async () => {
    const s = await setup({ guest: null });
    await okResult(s.host.ws, s.attach.cmd);
    const unknown = await sandboxStub(s.sandbox).resolve(s.agent).then(() => null, (e: Error) => e);
    expect(unknown?.message).toMatch(/^nest:sandbox_not_ready:503:1:/);
    const guest = { protocol_version: 1, capabilities: ["pty", "cgroup_v2"] };
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 1, state: "running", guest }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    expect((await sandboxStub(s.sandbox).resolve(s.agent)).guest).toEqual(guest);
  });

  it("the private key rests only in BrokerDO; no token or key is stored in FleetDO or SandboxDO", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    await sandboxStub(s.sandbox).resolve(s.agent);
    const fleetRows = await runInDurableObject(fleetStub(s.cell), (_i, st) =>
      st.storage.sql.exec<{ body: string }>("SELECT body FROM commands UNION ALL SELECT body FROM rel_out").toArray().map((r) => r.body).join("\n"));
    expect(fleetRows).not.toContain("nbd_");
    expect(fleetRows).not.toContain('"d":');
    const sandboxRows = await runInDurableObject(sandboxStub(s.sandbox), (_i, st) =>
      st.storage.sql.exec<{ value: string }>("SELECT value FROM kv").toArray().map((r) => r.value).join("\n"));
    expect(sandboxRows).not.toContain("nbd_");
    const broker = await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i, st) =>
      st.storage.sql.exec<{ name: string }>("SELECT name FROM secrets").toArray().map((r) => r.name));
    expect(broker).toContain(`binding_key:${s.cell}`);
  });
});

describe("the signing key", () => {
  it("cannot be replaced through the admin secrets route", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const res = await adminJson(`/v1/admin/secrets/binding_key:${cell}`, { method: "PUT", body: { value: "{}" } }, 403);
    expect(res.error?.code ?? res.code).toBe("forbidden");
    const again = await connectHost(cell);
    expect(again.keys).toEqual(a.keys);
  });
});

describe("hands_resolve on the session channel", () => {
  it("answers not-ready with a retry hint while the slot is pending, then a verifying target", async () => {
    const s = await setup();
    const { cmd } = await agentStub(s.agent).start();
    const [start] = await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    expect(start).toMatchObject({ type: "agent_start", hands: { sandbox: s.sandbox, epoch: 1 } });
    expect(start.hands.binding, "no binding ever passes through a host command").toBeUndefined();
    const ws = await Ws.connect(`/v1/agents/${s.agent}/session`, s.host.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: s.agent, host: s.host.host, instance_id: "rin_hands", epoch: 1 });
    await ws.next("hello_ack");
    ws.send({ type: "hands_resolve", request: "req_1" });
    const notReady = await ws.next("hands_resolved", (m) => m.request === "req_1");
    expect(notReady.hands).toBeUndefined();
    expect(notReady.error).toMatchObject({ code: "sandbox_not_ready", retryable: true });
    expect(notReady.retry_after_ms).toBe(2000);
    await okResult(s.host.ws, s.attach.cmd);
    ws.send({ type: "hands_resolve", request: "req_2" });
    const ready = await ws.next("hands_resolved", (m) => m.request === "req_2");
    expect(ready.error).toBeUndefined();
    expect(ready.hands).toMatchObject({ url: GATEWAY_URL, sandbox: s.sandbox, epoch: 1 });
    expect((await verified(s.pub, ready.hands as HandsTarget)).client).toBe(s.agent);
    // The target went AgentDO → runner and nowhere else: nothing of it rests in AgentDO either.
    const agentRows = await runInDurableObject(agentStub(s.agent), (_i, st) =>
      st.storage.sql.exec<{ v: string }>("SELECT value AS v FROM kv UNION ALL SELECT body AS v FROM rel_out").toArray().map((r) => r.v).join("\n"));
    expect(agentRows).not.toContain("nbd_");
  });

  it("a stale runner (old epoch) gets no target", async () => {
    const s = await setup();
    await okResult(s.host.ws, s.attach.cmd);
    const { cmd } = await agentStub(s.agent).start();
    await nextCommands(s.host.ws, (c) => c.cmd === cmd);
    const ws = await Ws.connect(`/v1/agents/${s.agent}/session`, s.host.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: s.agent, host: s.host.host, instance_id: "rin_old", epoch: 0 });
    await ws.next("hello_ack");
    await ws.next("error", (m) => m.error.code === "stale_epoch");
    ws.send({ type: "hands_resolve", request: "req_stale" });
    const r = await ws.next("hands_resolved", (m) => m.request === "req_stale");
    expect(r.hands).toBeUndefined();
    expect(r.error).toMatchObject({ code: "stale_epoch", retryable: false });
  });

  it("a captain has no hands: not_bound, not retryable", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-hands" } });
    const ctl = await connectHost(cell, "controller");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "captain" } }, 201);
    const captain = await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201);
    await nextCommands(ctl.ws, (c) => c.type === "agent_start" && c.agent === captain.agent);
    const ws = await Ws.connect(`/v1/agents/${captain.agent}/session`, ctl.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: captain.agent, host: ctl.host, instance_id: "rin_cap", epoch: 0 });
    await ws.next("hello_ack");
    ws.send({ type: "hands_resolve", request: "req_c" });
    const r = await ws.next("hands_resolved");
    expect(r.error).toMatchObject({ code: "not_bound", retryable: false });
    expect(r.retry_after_ms).toBeUndefined();
  });
});
