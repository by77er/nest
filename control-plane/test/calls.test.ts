import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { askRoute, CallLedger } from "../src/lib/calls";
import type { ToolOutcome } from "../src/protocol/control";

/** A fresh ledger on a real Durable Object's SQLite (an AgentDO's storage: its own ledger's tables). */
async function withLedger<T>(f: (l: CallLedger) => T): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(`calls-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_i: AgentDO, st) => f(new CallLedger(st.storage.sql)));
}
const ok: ToolOutcome = { status: "ok", content: [{ type: "text", text: "done" }] };
const unknown: ToolOutcome = { status: "error", error: { code: "outcome_unknown", message: "cancelled", retryable: false } };

describe("askRoute: an answer reaches the model whatever happened to the brain that asked", () => {
  it.each([
    ["answered", true, true, "already_answered"],
    ["cli", true, true, "waiter"],
    ["cli", false, true, "turn"],
    ["sync", false, true, "result"],
    ["sync", false, false, "turn"],
    ["async", false, true, "turn"],
  ] as const)("%s, waiter %s, call current %s: %s", (status, waiter, current, route) => {
    expect(askRoute(status, waiter, current)).toBe(route);
  });
});

describe("CallLedger", () => {
  it("a call answered while it was routed stays done: `wait` moves only a dispatching call", async () => {
    await withLedger((l) => {
      l.begin(1, "cal_a", "ask");
      l.finish(1, "cal_a", ok);
      l.wait(1, "cal_a");
      expect(l.call("cal_a")).toEqual({ epoch: 1, status: "done", outcome: ok });
      l.begin(1, "cal_b", "ask");
      l.wait(1, "cal_b");
      expect(l.call("cal_b")).toMatchObject({ status: "waiting", outcome: null });
    });
  });

  it("a cancel ends a call that hasn't finished and turns its sync ask into a turn; a finished call keeps its outcome", async () => {
    await withLedger((l) => {
      l.cancel(1, "cal_new", unknown, undefined);
      expect(l.call("cal_new")).toEqual({ epoch: 1, status: "done", outcome: unknown });
      l.begin(1, "cal_w", "ask");
      l.recordAsk({ ask: "ask_1", call: "cal_w", epoch: 1, question: "q", status: "sync", deadline: 0 });
      l.cancel(1, "cal_w", unknown, l.call("cal_w"));
      expect(l.ask("ask_1")).toMatchObject({ status: "async" });
      l.begin(1, "cal_d", "emit");
      l.finish(1, "cal_d", ok);
      l.cancel(1, "cal_d", unknown, l.call("cal_d"));
      expect(l.call("cal_d")?.outcome).toEqual(ok);
    });
  });

  it("a call keeps the epoch it was first seen at", async () => {
    await withLedger((l) => {
      l.begin(1, "cal_x", "emit");
      l.begin(2, "cal_x", "emit");
      expect(l.call("cal_x")?.epoch).toBe(1);
    });
  });
});
