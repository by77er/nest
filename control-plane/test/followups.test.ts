// Follow-ups that a reset or a failed call used to lose (the state-machine sweep's bugs 2 and 3; the
// sandbox-lease model's SlotFollowups): a command result's follow-ups are owed in the step that records
// it and run again until done (src/lib/command-result.ts); a new placement resets its slots in its own
// step and owes the rest to the `placed` deadline (sandbox.ts `placedStep`).
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { SandboxDO } from "../src/do/sandbox";
import { type Followup, resultFollowups, resultStep } from "../src/lib/command-result";
import { adminJson, connectHost, eventually, hostHello, nextCommands, okResult, runDue, sendEvents, uniqueCell, Ws } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const GUEST = { protocol_version: 1, capabilities: [] };

describe("a result's follow-ups (pure)", () => {
  it("each command type and outcome, swept", () => {
    const row = (type: string, o: Partial<{ sandbox: string | null; agent: string | null; epoch: number | null; purpose: string | null }> = {}) =>
      ({ type, sandbox: "sbx_1", agent: null, epoch: 1, purpose: null, ...o });
    const cases: [ReturnType<typeof row>, "ok" | "error", Followup[]][] = [
      [row("agent_attach", { agent: "agt_1" }), "ok", ["attach_result"]],
      [row("agent_attach", { agent: "agt_1" }), "error", ["attach_result", "command_failed"]],
      [row("agent_attach", { agent: null }), "ok", []],
      [row("sandbox_checkpoint"), "ok", ["checkpoint_result"]],
      [row("sandbox_checkpoint"), "error", ["checkpoint_result"]],
      [row("sandbox_create"), "ok", []],
      [row("sandbox_create"), "error", ["command_failed"]],
      [row("sandbox_create", { epoch: null }), "error", []],
      [row("agent_start", { sandbox: null, agent: "agt_1" }), "error", ["start_failed"]],
      [row("agent_start", { sandbox: null, agent: "agt_1" }), "ok", []],
      [row("fence", { purpose: "stonith_fence", sandbox: null }), "error", []],
      [row("fence", { purpose: "stonith_fence" }), "ok", []],
      [row("agent_stop", { sandbox: null, agent: "agt_1" }), "ok", []],
    ];
    for (const [r, o, want] of cases) expect(resultFollowups(r, { status: o }), `${r.type}/${r.purpose}/${o}`).toEqual(want);
  });

  it("a result: recorded once, its owed follow-ups run again on a redelivery, else ignored", () => {
    expect(resultStep(undefined, "h1")).toBe("ignore");
    expect(resultStep({ host: "h2", recorded: false, owed: false }, "h1")).toBe("ignore");
    expect(resultStep({ host: "h1", recorded: false, owed: false }, "h1")).toBe("record");
    expect(resultStep({ host: "h1", recorded: true, owed: true }, "h1")).toBe("rerun");
    expect(resultStep({ host: "h1", recorded: true, owed: false }, "h1")).toBe("ignore");
    expect(resultStep({ host: "h2", recorded: true, owed: true }, "h1")).toBe("ignore");
  });
});

/** Make FleetDO's next `attachResult` call to SandboxDO fail (a lost reply, or a reset at that await). */
const failNextAttachResult = (cell: string) => runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
  const self = inst as unknown as { sandbox: (id: string) => any };
  const orig = self.sandbox.bind(inst);
  let once = true;
  self.sandbox = (id: string) => {
    const real = orig(id);
    if (!once) return real;
    return new Proxy(real, {
      get: (t, p) => (p === "attachResult" ? () => {
        once = false;
        return Promise.reject(new Error("injected: lost reply"));
      } : (t as any)[p]),
    });
  };
});

async function attachedSandbox(cell: string) {
  const a = await connectHost(cell);
  const s = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { cell } }, 201);
  await nextCommands(a.ws, (c) => c.type === "sandbox_create");
  const seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s.sandbox, epoch: 1, state: "running", guest: GUEST }]);
  await a.ws.next("ack", (m) => m.up_to >= seq);
  return { a, sandbox: s.sandbox, sb: sandboxStub(s.sandbox) };
}

describe("bug 2: a result's follow-up that a failed call cut runs again", () => {
  it("on the redelivered result: the agent_attach ok lands, the slot is confirmed", async () => {
    const cell = uniqueCell();
    const { a, sb } = await attachedSandbox(cell);
    await sb.attach("agt_f1");
    const cmd = (await nextCommands(a.ws, (c) => c.type === "agent_attach")).find((c) => c.type === "agent_attach").cmd as string;
    await failNextAttachResult(cell);
    const seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "command_result", cmd, outcome: { status: "ok" } }]);
    await a.ws.whenClosed(3000);
    expect((await sb.info()).attach_pending).toEqual(["agt_f1"]);
    // nestd reconnects and resends the batch it had no ack for.
    const ws2 = await Ws.connect("/v1/fleet", a.host_token);
    ws2.send(hostHello(a.host, cell));
    await ws2.next("hello_ack");
    ws2.send({ type: "events", seq, events: [{ ts_ms: Date.now(), type: "command_result", cmd, outcome: { status: "ok" } }] });
    await ws2.next("ack", (m) => m.up_to >= seq);
    const info = await eventually("the slot confirmed", async () => {
      const i = await sb.info();
      return i.attach_pending.length === 0 ? i : null;
    });
    expect(info.attach_inflight).toEqual({});
    const owed = await runInDurableObject(fleetStub(cell), (_i: unknown, st: DurableObjectState) =>
      st.storage.sql.exec("SELECT followup_ms FROM commands WHERE cmd = ?", cmd).one().followup_ms);
    expect(owed).toBeNull();
  });

  it("without a redelivery: FleetDO's followups deadline runs it", async () => {
    const cell = uniqueCell();
    const { a, sb } = await attachedSandbox(cell);
    await sb.attach("agt_f2");
    const cmd = (await nextCommands(a.ws, (c) => c.type === "agent_attach")).find((c) => c.type === "agent_attach").cmd as string;
    await failNextAttachResult(cell);
    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "command_result", cmd, outcome: { status: "ok" } }]);
    await a.ws.whenClosed(3000);
    const fleet = fleetStub(cell);
    expect(await runInDurableObject(fleet, (_i: unknown, st: DurableObjectState) =>
      st.storage.sql.exec("SELECT followup_ms FROM commands WHERE cmd = ?", cmd).one().followup_ms)).not.toBeNull();
    await runInDurableObject(fleet, (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE commands SET followup_ms = 0 WHERE cmd = ?", cmd);
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'followups'");
    });
    await runDue(fleet);
    await eventually("the slot confirmed", async () => ((await sb.info()).attach_pending.length === 0 ? true : null));
  });

  it("a sandbox_create failure run twice for the same command counts one attempt and re-issues once", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { cell } }, 201);
    const [create] = await nextCommands(a.ws, (c) => c.type === "sandbox_create");
    const sb = sandboxStub(s.sandbox);
    const err = { code: "internal", message: "boom", retryable: true };
    await sb.commandFailed(a.host, "sandbox_create", 1, err, create.cmd);
    await sb.commandFailed(a.host, "sandbox_create", 1, err, create.cmd);
    const info = await sb.info() as unknown as { create_attempts: number };
    expect(info.create_attempts).toBe(1);
    const creates = await runInDurableObject(fleetStub(cell), (_i: unknown, st: DurableObjectState) =>
      st.storage.sql.exec("SELECT COUNT(*) AS n FROM commands WHERE type = 'sandbox_create' AND sandbox = ?", s.sandbox).one().n);
    expect(creates).toBe(2); // the first, and one re-issue
  });
});

describe("bug 3: a placement's slots reset with it; its other follow-ups owed to a deadline", () => {
  it("a move whose follow-ups throw: no binding for the new guest before its agent_attach is confirmed; the deadline finishes the rest", async () => {
    const cell = uniqueCell();
    const { a, sandbox, sb } = await attachedSandbox(cell);
    await sb.attach("agt_p2");
    const [att] = await nextCommands(a.ws, (c) => c.type === "agent_attach");
    await okResult(a.ws, att.cmd);
    const b = await connectHost(cell);
    await fleetStub(cell).releaseLease(sandbox);
    // The first follow-up stops (pushSecrets throws: BrokerDO or FleetDO; a reset there is the same).
    await runInDurableObject(sb, (inst: SandboxDO) => {
      (inst as unknown as { pushSecrets: () => Promise<void> }).pushSecrets = async () => {
        throw new Error("injected: cut in afterPlaced");
      };
    });
    await sb.leaseLost(a.host, 1, true).then(() => undefined, () => undefined);
    const moved = await sb.info();
    expect(moved.host).toBe(b.host);
    // Reset in the placement's own step: pending again, whatever happened to the follow-ups.
    expect(moved.attach_pending).toEqual(["agt_p2"]);
    const deadlines = () => runInDurableObject(sb, (_i: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT key FROM deadlines").toArray().map((r) => r.key));
    expect(await deadlines()).toContain("placed");
    await nextCommands(b.ws, (c) => c.type === "sandbox_create");
    const seq = sendEvents(b.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox, epoch: moved.epoch, state: "running", guest: GUEST }]);
    await b.ws.next("ack", (m) => m.up_to >= seq);
    // Running on B, its slot not configured there yet: no binding.
    await expect(Promise.resolve().then(() => sb.resolve("agt_p2"))).rejects.toThrow(/not configured/);
    // B gets the slot (from the running report, or the deadline), and once it confirms, a binding.
    const [attB] = await nextCommands(b.ws, (c) => c.type === "agent_attach");
    await okResult(b.ws, attB.cmd);
    await eventually("the slot confirmed on B", async () => ((await sb.info()).attach_pending.length === 0 ? true : null));
    // The rest of the follow-ups (secrets, move notices, idle) from the `placed` deadline, once nothing throws.
    await runInDurableObject(sb, (inst: SandboxDO, st: DurableObjectState) => {
      const self = inst as unknown as { pushSecrets: () => Promise<void>; pushed?: number };
      self.pushed = 0;
      self.pushSecrets = async () => {
        self.pushed! += 1;
      };
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'placed'");
    });
    await runDue(sb);
    expect(await deadlines()).not.toContain("placed");
    expect(await runInDurableObject(sb, (inst: SandboxDO) => (inst as unknown as { pushed: number }).pushed)).toBe(1);
  });
});
