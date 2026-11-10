// The brokered journal's and the MCP forward ledger's steps (`journalStep`, `forwardStep`): the tables,
// the guards through each ledger on a real Durable Object's SQLite, and their age-based settling.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { BrokeredJournal, JOURNAL_EVENTS, JOURNAL_STATUSES, journalStep, type JournalRow } from "../src/lib/brokered";
import { FORWARD_EVENTS, FORWARD_STATUSES, forwardStep } from "../src/lib/mcp-proxy";
import type { ToolOutcome } from "../src/protocol/control";

const fresh = () => env.AGENT.get(env.AGENT.idFromName(`ledger-${crypto.randomUUID()}`));
async function withJournal<T>(f: (j: BrokeredJournal, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(fresh(), (_i: AgentDO, st) => f(new BrokeredJournal(st.storage.sql), st.storage.sql));
}
const row = (key: string): JournalRow => ({ key, action: "github.create_issue", target: "o/r", idem: "i", digest: "d", args: "{}", tainted: false });
const ok: ToolOutcome = { status: "ok", content: [{ type: "text", text: "made" }] };
const failed: ToolOutcome = { status: "error", error: { code: "forbidden", message: "no", retryable: false } };
const unknown: ToolOutcome = { status: "error", error: { code: "outcome_unknown", message: "lost", retryable: false } };

describe("journalStep and forwardStep: every status and event", () => {
  it("journalStep", () => {
    const table = Object.fromEntries((["none", ...JOURNAL_STATUSES] as const).map((st) => [st, Object.fromEntries(JOURNAL_EVENTS.map((e) => [e, journalStep(st, e)]))]));
    expect(table).toEqual({
      none: { send: "sending", done: "done", fail: "failed", unknown: "unknown", refuse: "refused", abandon: "refuse" },
      sending: { send: "sending", done: "done", fail: "failed", unknown: "unknown", refuse: "refuse", abandon: "unknown" },
      done: { send: "refuse", done: "refuse", fail: "refuse", unknown: "refuse", refuse: "refuse", abandon: "refuse" },
      failed: { send: "refuse", done: "refuse", fail: "refuse", unknown: "refuse", refuse: "refuse", abandon: "refuse" },
      unknown: { send: "refuse", done: "done", fail: "failed", unknown: "refuse", refuse: "refuse", abandon: "refuse" },
      refused: { send: "refuse", done: "refuse", fail: "refuse", unknown: "refuse", refuse: "refuse", abandon: "refuse" },
    });
  });

  it("forwardStep", () => {
    const table = Object.fromEntries((["none", ...FORWARD_STATUSES] as const).map((st) => [st, Object.fromEntries(FORWARD_EVENTS.map((e) => [e, forwardStep(st, e)]))]));
    expect(table).toEqual({
      none: { forward: "forwarded", settle: "refuse", abandon: "refuse" },
      forwarded: { forward: "forwarded", settle: "settled", abandon: "settled" },
      settled: { forward: "refuse", settle: "refuse", abandon: "refuse" },
    });
  });
});

describe("BrokeredJournal: the guards are the journal's", () => {
  it("a settled call is never sent again and keeps its outcome", async () => {
    await withJournal((j) => {
      expect(j.sending(row("k"))).toBe(true);
      expect(j.sending(row("k"))).toBe(true);
      expect(j.get("k")).toMatchObject({ status: "sending", attempts: 2, outcome: null });
      expect(j.settle(row("k"), "done", ok, "made")).toBe(true);
      // Another delivery of the same call arrives late: nothing is recorded as leaving, and no outcome replaces it.
      expect(j.sending(row("k"))).toBe(false);
      expect(j.settle(row("k"), "unknown", unknown, "lost")).toBe(false);
      expect(j.settle(row("k"), "failed", failed, "no")).toBe(false);
      expect(j.refuse(row("k"), "a secret")).toBe(false);
      expect(j.get("k")).toMatchObject({ status: "done", attempts: 2, outcome: ok, detail: "made" });
    });
  });

  it("an unknown outcome may still be learned, but the call is never sent again", async () => {
    await withJournal((j) => {
      j.sending(row("k"));
      expect(j.settle(row("k"), "unknown", unknown, "lost")).toBe(true);
      expect(j.sending(row("k"))).toBe(false);
      expect(j.settle(row("k"), "unknown", unknown, "lost again")).toBe(false);
      expect(j.get("k")).toMatchObject({ status: "unknown", detail: "lost" });
      expect(j.settle(row("k"), "done", ok, "found")).toBe(true);
      expect(j.get("k")).toMatchObject({ status: "done", outcome: ok, detail: "found" });
      expect(j.settle(row("k"), "failed", failed, "no")).toBe(false);
    });
  });

  it("a refusal is only of a call that never left; a call can settle with no attempt recorded", async () => {
    await withJournal((j) => {
      expect(j.refuse(row("r"), "a secret")).toBe(true);
      expect(j.sending(row("r"))).toBe(false);
      expect(j.settle(row("r"), "done", ok, "x")).toBe(false);
      expect(j.get("r")).toMatchObject({ status: "refused", args: "(withheld)", attempts: 0 });
      j.sending(row("s"));
      expect(j.refuse(row("s"), "a secret")).toBe(false);
      expect(j.get("s")).toMatchObject({ status: "sending", args: "{}" });
      // Already open: settled without going out.
      expect(j.settle(row("n"), "done", ok, "already open")).toBe(true);
      expect(j.get("n")).toMatchObject({ status: "done", attempts: 0 });
    });
  });

  it("prune gives up on a call still sending after the retention, keeps it for the operator as unknown, then drops it", async () => {
    await withJournal((j, sql) => {
      const day = 86_400_000;
      const now = 100 * day;
      const at = (key: string, created: number, settled?: number) => sql.exec("UPDATE brokered_journal SET created_ms = ?, settled_ms = COALESCE(?, settled_ms) WHERE key = ?", created, settled ?? null, key);
      j.sending(row("stuck"));
      at("stuck", now - 8 * day);
      j.sending(row("recent"));
      at("recent", now - 1 * day);
      j.sending(row("old-done"));
      j.settle(row("old-done"), "done", ok, "x");
      at("old-done", now - 9 * day, now - 9 * day);
      j.sending(row("new-done"));
      j.settle(row("new-done"), "done", ok, "x");
      at("new-done", now - 2 * day, now - 2 * day);

      // A row a previous release sent again after it had settled: still sending, with an old settle time.
      j.sending(row("resent"));
      at("resent", now - 1 * day, now - 9 * day);

      j.prune(now - 7 * day, now);
      expect(j.get("resent")).toMatchObject({ status: "sending" });
      expect(j.get("stuck")).toMatchObject({ status: "unknown", settled_ms: now, outcome: { status: "error", error: { code: "outcome_unknown" } } });
      expect(j.get("recent")).toMatchObject({ status: "sending", outcome: null });
      expect(j.get("old-done")).toBeUndefined();
      expect(j.get("new-done")).toMatchObject({ status: "done" });
      // It still counts toward nothing new and is never sent again; a week after it was given up on, it goes.
      expect(j.sending(row("stuck"))).toBe(false);
      j.prune(now - 1 * day, now + 6 * day);
      expect(j.get("stuck")).toMatchObject({ status: "unknown" });
      j.prune(now + 1, now + 7 * day + 1);
      expect(j.get("stuck")).toBeUndefined();
    });
  });
});

describe("AgentDO's journal call sites", () => {
  it("an attempt of a call that settled meanwhile sends nothing and answers with the outcome that stands", async () => {
    await runInDurableObject(fresh(), (inst: AgentDO) => {
      const a = inst as any;
      expect(a.journalSend(row("k"))).toBeNull();
      expect(a.journalSettle(row("k"), "done", ok, "made")).toEqual(ok);
      // A second delivery, past its checks, reaches its send: told the outcome, and no attempt is recorded.
      expect(a.journalSend(row("k"))).toEqual(ok);
      expect(a.journal.get("k")).toMatchObject({ status: "done", attempts: 1 });
      // Its own late verdict doesn't replace the one that stands.
      expect(a.journalSettle(row("k"), "unknown", unknown, "lost")).toEqual(ok);
      expect(a.unknownOutcome(row("k"), "lost")).toEqual(ok);
      // A refused call stays refused.
      a.journal.refuse(row("r"), "a secret");
      expect(() => a.journalSend(row("r"))).toThrow(/credential/);
    });
  });
});

describe("the MCP forward ledger", () => {
  const ctx = (key: string, epoch = 1) => ({ key, epoch });
  const g = { capability: "notes" };
  const out = (text: string) => ({ outcome: { status: "ok", content: [{ type: "text", text }] }, from_server: true });
  const read = (st: DurableObjectState, key: string) =>
    st.storage.sql.exec<{ status: string; attempts: number; outcome: string | null }>("SELECT status, attempts, outcome FROM mcp_forwards WHERE key = ?", key).toArray()[0];

  it("a settled forward keeps its outcome and is never recorded as leaving again; nothing settles before it was forwarded", async () => {
    await runInDurableObject(fresh(), (inst: AgentDO, st) => {
      const m = (inst as any).mcp;
      // Not forwarded yet: a settle stores nothing.
      expect(m.settle("k", out("early"))).toEqual(out("early"));
      expect(read(st, "k")).toBeUndefined();
      expect(m.recordForward(ctx("k"), g, "send", 1)).toBe(true);
      expect(m.recordForward(ctx("k"), g, "send", 2)).toBe(true);
      expect(read(st, "k")).toMatchObject({ status: "forwarded", attempts: 2, outcome: null });
      expect(m.settle("k", out("first"))).toEqual(out("first"));
      // A late delivery: its forward is refused and its outcome doesn't replace the first.
      expect(m.recordForward(ctx("k"), g, "send", 3)).toBe(false);
      expect(m.settle("k", out("second"))).toEqual(out("first"));
      expect(read(st, "k")).toMatchObject({ status: "settled", attempts: 2 });
      expect(JSON.parse(read(st, "k")!.outcome!)).toEqual(out("first"));
    });
  });

  it("prune settles a forward still open after the retention as unknown, then drops it with the other old settled ones", async () => {
    await runInDurableObject(fresh(), (inst: AgentDO, st) => {
      const m = (inst as any).mcp;
      const sql = st.storage.sql;
      m.recordForward(ctx("stuck"), g, "send", 1);
      m.recordForward(ctx("recent"), g, "send", 1);
      m.recordForward(ctx("old-settled"), g, "send", 1);
      m.settle("old-settled", out("x"));
      sql.exec("UPDATE mcp_forwards SET created_ms = 10 WHERE key IN ('stuck', 'old-settled')");
      // What the stale one is settled as (seen with a cutoff that deletes nothing yet settled before it).
      const before = sql.exec("SELECT COUNT(*) AS n FROM mcp_forwards WHERE status = 'forwarded'").one().n;
      expect(before).toBe(2);
      m.prune(1000);
      expect(read(st, "stuck")).toBeUndefined();
      expect(read(st, "old-settled")).toBeUndefined();
      expect(read(st, "recent")).toMatchObject({ status: "forwarded" });
      // No forward of an older epoch is left open for a newer one to wait on.
      expect(sql.exec("SELECT COUNT(*) AS n FROM mcp_forwards WHERE status = 'forwarded' AND created_ms < 1000").one().n).toBe(0);
    });
  });
});
