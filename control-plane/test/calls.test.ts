import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import {
  APPROVAL_EVENTS, APPROVAL_STATUSES, approvalStep, approvalUsable, ASK_EVENTS, ASK_STATUSES, askRoute, askStep, CALL_EVENTS, CALL_STATUSES, CallLedger, callStep,
} from "../src/lib/calls";
import type { ToolOutcome } from "../src/protocol/control";
import { JOURNAL_EVENTS, JOURNAL_STATUSES, journalStep } from "../src/lib/brokered";
import { FORWARD_EVENTS, FORWARD_STATUSES, forwardStep } from "../src/lib/mcp-proxy";
import { INBOX_EVENTS, INBOX_STATUSES, inboxStep, TURN_EVENTS, TURN_STATUSES, turnStep } from "../src/lib/turns";
import { adminJson, connectHost, nextCommands, uniqueCell } from "./helpers";

/** A fresh ledger on a real Durable Object's SQLite (an AgentDO's storage: its own ledger's tables). */
async function withLedger<T>(f: (l: CallLedger, sql: SqlStorage) => T): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(`calls-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_i: AgentDO, st) => f(new CallLedger(st.storage.sql), st.storage.sql));
}
const ok: ToolOutcome = { status: "ok", content: [{ type: "text", text: "done" }] };
const unknown: ToolOutcome = { status: "error", error: { code: "outcome_unknown", message: "cancelled", retryable: false } };

describe("askRoute: an answer reaches the model whatever happened to the brain that asked", () => {
  it.each([
    ["answered", true, "already_answered"],
    ["cli", true, "turn"],
    ["sync", true, "result"],
    ["sync", false, "turn"],
    ["async", true, "turn"],
  ] as const)("%s, call current %s: %s", (status, current, route) => {
    expect(askRoute(status, current)).toBe(route);
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

describe("the ledgers' steps: every status and event, and nothing leaves a final status", () => {
  it("callStep", () => {
    const table = Object.fromEntries(CALL_STATUSES.map((st) => [st, Object.fromEntries(CALL_EVENTS.map((e) => [e, callStep(st, e)]))]));
    expect(table).toEqual({
      dispatching: { wait: "waiting", finish: "done", cancel: "done" },
      waiting: { wait: "refuse", finish: "done", cancel: "done" },
      done: { wait: "refuse", finish: "refuse", cancel: "refuse" },
    });
  });

  it("askStep", () => {
    const table = Object.fromEntries(ASK_STATUSES.map((st) => [st, Object.fromEntries(ASK_EVENTS.map((e) => [e, askStep(st, e)]))]));
    expect(table).toEqual({
      sync: { detach: "async", answer: "answered" },
      cli: { detach: "async", answer: "answered" },
      async: { detach: "refuse", answer: "answered" },
      answered: { detach: "refuse", answer: "refuse" },
    });
  });

  it("approvalStep", () => {
    const table = Object.fromEntries(APPROVAL_STATUSES.map((st) => [st, Object.fromEntries(APPROVAL_EVENTS.map((e) => [e, approvalStep(st, e)]))]));
    expect(table).toEqual({
      pending: { approve: "approved", deny: "denied" },
      approved: { approve: "refuse", deny: "refuse" },
      denied: { approve: "refuse", deny: "refuse" },
    });
  });

  it.each([
    ["approved, unspent, unexpired", { status: "approved", expires_ms: 200, used_by: null }, true],
    ["spent on this call (its redelivery)", { status: "approved", expires_ms: 200, used_by: "k" }, true],
    ["spent on another call", { status: "approved", expires_ms: 200, used_by: "other" }, false],
    ["expired at this instant", { status: "approved", expires_ms: 100, used_by: null }, false],
    ["no expiry recorded", { status: "approved", expires_ms: null, used_by: null }, false],
    ["pending", { status: "pending", expires_ms: 200, used_by: null }, false],
    ["denied", { status: "denied", expires_ms: 200, used_by: null }, false],
  ] as const)("approvalUsable: %s", (_n, a, usable) => {
    expect(approvalUsable(a, "k", 100)).toBe(usable);
  });
});

describe("CallLedger: the guards are the ledger's", () => {
  it("a finished call keeps its outcome: a second finish, a cancel and a wait change nothing", async () => {
    await withLedger((l) => {
      l.begin(1, "cal_f", "emit");
      expect(l.finish(1, "cal_f", ok)).toBe(true);
      expect(l.finish(1, "cal_f", unknown)).toBe(false);
      l.cancel(1, "cal_f", unknown, l.call("cal_f"));
      expect(l.wait(1, "cal_f")).toBe(false);
      expect(l.call("cal_f")).toEqual({ epoch: 1, status: "done", outcome: ok });
      // A waiting call is finished once too.
      l.begin(1, "cal_w", "ask");
      expect(l.wait(1, "cal_w")).toBe(true);
      expect(l.wait(1, "cal_w")).toBe(false);
      expect(l.finish(1, "cal_w", ok)).toBe(true);
      expect(l.finish(1, "cal_w", unknown)).toBe(false);
      expect(l.call("cal_w")?.outcome).toEqual(ok);
      // Finishing a call nobody began stores nothing.
      expect(l.finish(1, "cal_none", ok)).toBe(false);
      expect(l.call("cal_none")).toBeUndefined();
    });
  });

  it("an ask is answered once, and only a waiting one is detached", async () => {
    await withLedger((l, sql) => {
      const answerOf = (ask: string) => sql.exec<{ answer: string | null }>("SELECT answer FROM asks WHERE ask = ?", ask).one().answer;
      l.recordAsk({ ask: "ask_a", call: "cal_a", epoch: 1, question: "q", status: "async", deadline: 0 });
      expect(l.toAsync("ask_a", "sync")).toBe(false);
      expect(l.answer("ask_a", "first")).toBe(true);
      expect(l.answer("ask_a", "second")).toBe(false);
      expect(answerOf("ask_a")).toBe("first");
      expect(l.toAsync("ask_a", "sync")).toBe(false);
      expect(l.ask("ask_a")?.status).toBe("answered");
      // A previous release's waiting asks: detached only from the status named.
      l.recordAsk({ ask: "ask_s", call: "cal_s", epoch: 1, question: "q", status: "sync", deadline: 0 });
      expect(l.toAsync("ask_s", "cli")).toBe(false);
      expect(l.toAsync("ask_s", "sync")).toBe(true);
      expect(l.ask("ask_s")?.status).toBe("async");
      expect(l.answer("ask_unknown", "x")).toBe(false);
    });
  });

  it("an approval is decided once and spent on one call", async () => {
    await withLedger((l) => {
      l.requestApproval("ask_p", "notes_send", "d1", "mcp__nest__notes_send");
      // Undecided, it can't be spent.
      expect(l.takeApproval("notes_send", "d1", "k1", 50)).toBe(false);
      expect(l.decide("ask_p", true, 100)).toBe(true);
      // Decided, it stays: a later denial or a new expiry changes nothing.
      expect(l.decide("ask_p", false, 999)).toBe(false);
      expect(l.decide("ask_p", true, 999)).toBe(false);
      expect(l.approvalOf("ask_p")?.status).toBe("approved");
      expect(l.takeApproval("notes_send", "other-digest", "k1", 50)).toBe(false);
      expect(l.takeApproval("notes_send", "d1", "k1", 50)).toBe(true);
      expect(l.takeApproval("notes_send", "d1", "k1", 60)).toBe(true); // its redelivery
      expect(l.takeApproval("notes_send", "d1", "k2", 60)).toBe(false);
      expect(l.takeApproval("notes_send", "d1", "k1", 100)).toBe(false); // expired (the first expiry stood)
      // A denial can't be spent or reversed.
      l.requestApproval("ask_d", "notes_send", "d2");
      expect(l.decide("ask_d", false, 100)).toBe(true);
      expect(l.decide("ask_d", true, 100)).toBe(false);
      expect(l.takeApproval("notes_send", "d2", "k3", 50)).toBe(false);
      // Two approvals of the same call: each is spent on one call key.
      l.requestApproval("ask_1", "x", "d");
      l.decide("ask_1", true, 100);
      l.requestApproval("ask_2", "x", "d");
      l.decide("ask_2", true, 100);
      expect(l.takeApproval("x", "d", "ka", 50)).toBe(true);
      expect(l.takeApproval("x", "d", "ka", 50)).toBe(true); // a redelivery uses the one it spent, not the other
      expect(l.takeApproval("x", "d", "kb", 50)).toBe(true);
      expect(l.takeApproval("x", "d", "kc", 50)).toBe(false);
      expect(l.takeApproval("x", "d", "ka", 50)).toBe(true);
    });
  });

  it("a redelivery uses the approval it already spent, even when an older one of the same call is still unspent", async () => {
    await withLedger((l, sql) => {
      l.requestApproval("ask_old", "x", "d");
      l.decide("ask_old", true, 100);
      l.requestApproval("ask_new", "x", "d");
      l.decide("ask_new", true, 100);
      sql.exec("UPDATE approvals SET created_ms = 1 WHERE ask = 'ask_old'");
      sql.exec("UPDATE approvals SET created_ms = 2, used_by = 'ka' WHERE ask = 'ask_new'");
      const spentOn = (ask: string) => sql.exec<{ used_by: string | null }>("SELECT used_by FROM approvals WHERE ask = ?", ask).one().used_by;
      expect(l.takeApproval("x", "d", "ka", 50)).toBe(true);
      // The older, unspent one is left for another call.
      expect(spentOn("ask_old")).toBeNull();
      expect(l.takeApproval("x", "d", "kb", 50)).toBe(true);
      expect(spentOn("ask_old")).toBe("kb");
      expect(l.takeApproval("x", "d", "kc", 50)).toBe(false);
    });
  });

  it("a call dispatched again counts as begun then: the prune doesn't take it for an old one; a finished one is left as it is", async () => {
    await withLedger((l, sql) => {
      const created = (call: string) => sql.exec<{ created_ms: number }>("SELECT created_ms FROM tool_calls WHERE call = ?", call).one().created_ms;
      l.begin(1, "cal_redo", "emit");
      l.begin(1, "cal_left", "emit");
      l.begin(1, "cal_done", "emit");
      l.finish(1, "cal_done", ok);
      sql.exec("UPDATE tool_calls SET created_ms = 5");
      l.redispatch(1, "cal_redo");
      l.redispatch(1, "cal_done");
      expect(created("cal_redo")).toBeGreaterThan(Date.now() - 60_000);
      expect(created("cal_done")).toBe(5);
      l.prune(Date.now() - 1000);
      expect(l.call("cal_redo")).toMatchObject({ status: "dispatching" });
      expect(l.call("cal_left")).toBeUndefined();
      expect(l.call("cal_done")).toBeUndefined();
    });
  });

  it("prune settles by age what can't end on its own, and keeps the operator's open work", async () => {
    await withLedger((l, sql) => {
      const cutoff = Date.now() - 1000;
      const age = (table: string, col: string, id: string) => sql.exec(`UPDATE ${table} SET created_ms = 1 WHERE ${col} = ?`, id);
      const status = (call: string) => l.call(call)?.status;
      l.begin(1, "cal_stuck", "emit");
      l.begin(1, "cal_waiting", "ask");
      l.wait(1, "cal_waiting");
      l.begin(1, "cal_done", "emit");
      l.finish(1, "cal_done", ok);
      l.begin(1, "cal_new", "emit");
      for (const c of ["cal_stuck", "cal_waiting", "cal_done"]) age("tool_calls", "call", c);
      l.recordAsk({ ask: "ask_sync", call: "cal_waiting", epoch: 1, question: "q", status: "sync", deadline: 0 });
      l.recordAsk({ ask: "ask_cli", call: "cal_c", epoch: 1, question: "q", status: "cli", deadline: 0 });
      l.recordAsk({ ask: "ask_open", call: "cal_o", epoch: 1, question: "q", status: "async", deadline: 0 });
      l.recordAsk({ ask: "ask_answered", call: "cal_a", epoch: 1, question: "q", status: "async", deadline: 0 });
      l.answer("ask_answered", "yes");
      l.recordAsk({ ask: "ask_sync_new", call: "cal_n", epoch: 1, question: "q", status: "sync", deadline: 0 });
      for (const a of ["ask_sync", "ask_cli", "ask_open", "ask_answered"]) age("asks", "ask", a);
      l.requestApproval("ask_open", "x", "d");
      l.requestApproval("ask_spent", "x", "d2");
      l.decide("ask_spent", true, 5);
      for (const a of ["ask_open", "ask_spent"]) age("approvals", "ask", a);

      l.prune(cutoff);
      // Old calls go whatever their status: one that never finished can't any more.
      expect(status("cal_stuck")).toBeUndefined();
      expect(status("cal_waiting")).toBeUndefined();
      expect(status("cal_done")).toBeUndefined();
      expect(status("cal_new")).toBe("dispatching");
      // A previous release's waiting asks are answered as a turn from now on; a recent one still waits.
      expect(l.ask("ask_sync")?.status).toBe("async");
      expect(l.ask("ask_cli")?.status).toBe("async");
      expect(l.ask("ask_sync_new")?.status).toBe("sync");
      // The operator's open ask and its pending approval stay, however old; answered and decided ones go.
      expect(l.ask("ask_open")?.status).toBe("async");
      expect(l.approvalOf("ask_open")?.status).toBe("pending");
      expect(l.ask("ask_answered")).toBeUndefined();
      expect(l.approvalOf("ask_spent")).toBeUndefined();
      expect(l.open().map((a) => a.ask).sort()).toEqual(["ask_cli", "ask_open", "ask_sync", "ask_sync_new"]);
    });
  });
});

describe("no ledger's event chains", () => {
  // `apply*` runs one UPDATE per source status, in enum order: were a table to map A to B and B to C on
  // one event, a row could take both steps in one call. No table does: a status an event leads to refuses it.
  const tables: [string, readonly string[], readonly string[], (s: any, e: any) => string][] = [
    ["callStep", CALL_STATUSES, CALL_EVENTS, callStep],
    ["askStep", ASK_STATUSES, ASK_EVENTS, askStep],
    ["approvalStep", APPROVAL_STATUSES, APPROVAL_EVENTS, approvalStep],
    ["turnStep", TURN_STATUSES, TURN_EVENTS, turnStep],
    ["inboxStep", INBOX_STATUSES, INBOX_EVENTS, inboxStep],
    ["journalStep", ["none", ...JOURNAL_STATUSES], JOURNAL_EVENTS, journalStep],
    ["forwardStep", ["none", ...FORWARD_STATUSES], FORWARD_EVENTS, forwardStep],
  ];
  // The events meant to repeat on the status they lead to (an attempt more); they are applied to one row by key, never by `apply*`.
  const repeats = new Set(["journalStep/send", "forwardStep/forward"]);
  it.each(tables)("%s", (name, statuses, events, step) => {
    for (const e of events) {
      for (const from of statuses) {
        const to = step(from, e);
        if (to === "refuse" || to === from || repeats.has(`${name}/${e}`)) continue;
        expect(step(to, e), `${name}: ${from} --${e}--> ${to} --${e}-->`).toBe("refuse");
      }
    }
  });
});

describe("AgentDO.answerAsk", () => {
  it("an answer to a previous release's waiting ask whose call is gone isn't lost: it comes as a turn", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
    const host = await connectHost(cell, "brain");
    const agent = (await adminJson("/v1/agents", { body: { role: "captain", cell } }, 201)).agent as string;
    await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === agent);
    const stub = env.AGENT.get(env.AGENT.idFromName(agent));
    const epoch = (await stub.info()).brain!.epoch;
    // The ask waits inside a call of the current brain, but the call's row is gone (the prune took it).
    await runInDurableObject(stub, (inst: AgentDO) => {
      (inst as any).calls.recordAsk({ ask: "ask_lost", call: "cal_gone", epoch, question: "q", status: "sync", deadline: 0 });
    });
    expect(await stub.answerAsk("ask_lost", "the answer")).toBe("async");
    const turns = await runInDurableObject(stub, (_i: AgentDO, st) =>
      st.storage.sql.exec<{ input: string }>("SELECT input FROM turns").toArray().map((t) => JSON.parse(t.input) as { kind: string; text: string }));
    expect(turns.filter((t) => t.kind === "ask_answer").map((t) => t.text)).toEqual(["Answer to your question ask_lost: the answer"]);
    // With its call still waiting, the answer is that call's result and no turn.
    await runInDurableObject(stub, (inst: AgentDO) => {
      const a = inst as any;
      a.calls.begin(epoch, "cal_here", "ask");
      a.calls.wait(epoch, "cal_here");
      a.calls.recordAsk({ ask: "ask_here", call: "cal_here", epoch, question: "q", status: "sync", deadline: 0 });
    });
    expect(await stub.answerAsk("ask_here", "yes")).toBe("sync");
    host.ws.close();
  });
});

describe("AgentDO.finishCall", () => {
  it("sends a call's result once: a call that already has its outcome keeps it and nothing more goes to the runner", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
    await connectHost(cell, "brain");
    const agent = (await adminJson("/v1/agents", { body: { role: "captain", cell } }, 201)).agent as string;
    const sent = await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (inst: AgentDO) => {
      const a = inst as any;
      a.calls.begin(1, "cal_once", "emit");
      a.finishCall(1, "cal_once", ok);
      a.finishCall(1, "cal_once", unknown);
      // Cancelled by the runner, then its dispatch returns: the runner is told nothing.
      a.calls.cancel(1, "cal_gone", unknown, undefined);
      a.finishCall(1, "cal_gone", ok);
      return (a.rel.pendingAfter("runner", undefined) as { type: string; call?: string; outcome?: ToolOutcome }[]).filter((m) => m.type === "tool_result");
    });
    expect(sent.map((m) => [m.call, m.outcome])).toEqual([["cal_once", ok]]);
  });
});
