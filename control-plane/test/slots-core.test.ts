// Client slots and the binding readiness rule (lib/slots.ts), checked directly against the actions
// of docs/verification/gateway-bindings (P1-P6, S7). The DO-level paths (commands, alarms, awaits)
// are in hands.test.ts.
import { describe, expect, it } from "vitest";
import { attach, attachResult, detach, due, newPlacement, sent, setWorking, type Slots, unbindable } from "../src/lib/slots";

const empty = (): Slots => ({ attached: [], attach_cwd: {}, attach_pending: [], attach_inflight: {}, attach_attempts: {}, working: [] });
/** `agt_a` attached on a placed sandbox, its `agent_attach` (cmd_1) in flight. */
function inflight(): Slots {
  const c = empty();
  attach(c, "agt_a", "/work", true);
  sent(c, ["agt_a"], ["cmd_1"]);
  return c;
}

describe("slots", () => {
  it("attach sends only on a placed sandbox, and a repeat for a confirmed slot with the same cwd sends nothing", () => {
    const c = empty();
    expect(attach(c, "agt_a", null, false)).toBe(false);
    expect(c).toMatchObject({ attached: ["agt_a"], attach_pending: [] });
    const d = inflight();
    expect(attachResult(d, "agt_a", "cmd_1", true, false)).toEqual({ kind: "confirmed" });
    expect(attach(d, "agt_a", "/work", true)).toBe(false);
    expect(d.attach_pending).toEqual([]);
    // A different cwd is configured again, pending until confirmed.
    expect(attach(d, "agt_a", "/other", true)).toBe(true);
    expect(d.attach_pending).toEqual(["agt_a"]);
  });

  it("only the command in flight counts; a retryable failure backs off 2, 4, 8, 16, 30, 30 s", () => {
    const c = inflight();
    expect(attachResult(c, "agt_a", "cmd_old", true, false)).toEqual({ kind: "stale" });
    expect(c.attach_pending).toEqual(["agt_a"]);
    const delays: number[] = [];
    for (let n = 2; n <= 7; n++) {
      const r = attachResult(c, "agt_a", `cmd_${n - 1}`, false, true);
      if (r.kind === "retry") delays.push(r.delayMs);
      expect(due(c, false)).toEqual(["agt_a"]);
      sent(c, ["agt_a"], [`cmd_${n}`]);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    // A guest coming up resets the backoff.
    due(c, true);
    expect(attachResult(c, "agt_a", "cmd_7", false, true)).toEqual({ kind: "retry", delayMs: 2_000 });
    expect(attachResult(c, "agt_a", "cmd_7", false, false)).toEqual({ kind: "stale" });
  });

  it("a non-retryable failure leaves the slot pending, with nothing in flight, for the next running report", () => {
    const c = inflight();
    expect(attachResult(c, "agt_a", "cmd_1", false, false)).toEqual({ kind: "failed" });
    expect(c.attach_pending).toEqual(["agt_a"]);
    expect(due(c, true)).toEqual(["agt_a"]);
  });

  it("a new placement makes every slot pending with nothing in flight; detach removes the agent everywhere", () => {
    const c = inflight();
    attach(c, "agt_b", null, true);
    attachResult(c, "agt_a", "cmd_1", true, false);
    expect(newPlacement(c)).toEqual(["agt_a", "agt_b"]);
    expect(c).toMatchObject({ attach_pending: ["agt_a", "agt_b"], attach_inflight: {} });
    sent(c, ["agt_a", "agt_b"], ["cmd_2", "cmd_3"]);
    setWorking(c, "agt_a", true);
    detach(c, "agt_a");
    expect(c).toEqual({ attached: ["agt_b"], attach_cwd: { agt_b: null }, attach_pending: ["agt_b"], attach_inflight: { agt_b: "cmd_3" }, attach_attempts: { agt_b: 0 }, working: [] });
    // A result for a detached agent's command changes nothing.
    expect(attachResult(c, "agt_a", "cmd_2", true, false)).toEqual({ kind: "stale" });
  });

  it("working counts only attached agents, and a turn ends only for one that was working", () => {
    const c = inflight();
    expect(setWorking(c, "agt_z", true)).toEqual({ turnEnded: false });
    expect(c.working).toEqual([]);
    setWorking(c, "agt_a", true);
    expect(setWorking(c, "agt_a", true)).toEqual({ turnEnded: false });
    expect(setWorking(c, "agt_a", false)).toEqual({ turnEnded: true });
    expect(setWorking(c, "agt_a", false)).toEqual({ turnEnded: false });
  });
});

describe("the binding readiness rule (gateway-bindings S7)", () => {
  const ready = () => {
    const c = inflight();
    attachResult(c, "agt_a", "cmd_1", true, false);
    return { ...c, state: "running" as const, host: "hst_a", placing: null, guest: { protocol_version: 1, capabilities: [] } };
  };

  it("allows an attached, confirmed client of a running, placed sandbox whose guest reported", () => {
    expect(unbindable(ready(), "agt_a")).toBeNull();
  });

  it("refuses each missing condition, retryably only when it is a matter of waiting", () => {
    const rows: [string, (r: ReturnType<typeof ready>) => unknown, string, boolean][] = [
      ["not attached", (r) => { r.attached = []; }, "not_bound", false],
      ["destroyed", (r) => { Object.assign(r, { state: "destroyed", host: null }); }, "forbidden", false],
      ["unplaced", (r) => { r.host = null as unknown as string; }, "sandbox_not_ready", true],
      ["being placed", (r) => { r.placing = 3 as unknown as null; }, "sandbox_not_ready", true],
      ["suspended", (r) => { Object.assign(r, { state: "suspended" }); }, "sandbox_not_ready", true],
      ["slot pending", (r) => { r.attach_pending = ["agt_a"]; }, "sandbox_not_ready", true],
      ["no guest version", (r) => { r.guest = null as unknown as typeof r.guest; }, "sandbox_not_ready", true],
    ];
    for (const [why, change, code, retryable] of rows) {
      const r = ready();
      change(r);
      const e = unbindable(r, "agt_a");
      expect(e && { code: e.code, retryable: e.retryable }, why).toEqual({ code, retryable });
    }
  });
});
