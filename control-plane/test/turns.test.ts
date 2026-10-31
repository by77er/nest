import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { MAX_WAITING_DELIVERIES, WAKE_CAP_PER_HOUR } from "../src/lib/channels";
import { admitDelivery, channelRequestId, MERGED_TURN_BYTES, moveNoteDue, recoveryInput, TurnQueue } from "../src/lib/turns";
import type { InboxMessage } from "../src/protocol/control";

/** A fresh queue on a real Durable Object's SQLite (an AgentDO's storage: its own queue's tables). */
async function withQueue<T>(f: (q: TurnQueue, sql: SqlStorage) => T): Promise<T> {
  const stub = env.AGENT.get(env.AGENT.idFromName(`turnq-${crypto.randomUUID()}`));
  return runInDurableObject(stub, (_i: AgentDO, st) => f(new TurnQueue(st.storage.sql), st.storage.sql));
}

const user = (text: string) => ({ kind: "user" as const, text });
const msg = (id: string, text: string): InboxMessage => ({ id, from: "platform", text, interrupt: false, ts_ms: 0 });
const statuses = (q: TurnQueue) => q.list().map((t) => [t.input.text, t.status]);

describe("TurnQueue (the model's Q1-Q4)", () => {
  it("runs turns in the order queued, one claim each", async () => {
    await withQueue((q) => {
      q.enqueue(user("a"));
      q.enqueue(user("b"), "req-b");
      expect(q.turnFor("req-b")).toBeDefined();
      expect(q.claimNext()?.input.text).toBe("a");
      expect(q.claimNext()?.input.text).toBe("b");
      expect(q.claimNext()).toBeUndefined();
      expect(q.hasQueued()).toBe(false);
      expect(statuses(q)).toEqual([["a", "active"], ["b", "active"]]);
    });
  });

  it("recovers an interrupted turn ahead of everything queued, naming the turn it continues", async () => {
    await withQueue((q) => {
      q.enqueue(user("first"));
      const x = q.claimNext()!.turn;
      q.enqueue(user("next"));
      q.recordHandsEpoch(x, 4);
      q.recover(x, ["Restarted."]);
      const r = q.claimNext()!;
      expect(r.input).toEqual({ kind: "recovery", text: "Restarted.\nThe turn was:\nfirst" });
      expect(r.recovers).toBe(x);
      expect(q.startOf(x)).toMatchObject({ hands_epoch: 4 });
      expect(statuses(q)).toContainEqual(["first", "interrupted"]);
      // Interrupted again: the original text, once.
      q.recover(r.turn, ["Again."]);
      expect(q.claimNext()!.input.text).toBe("Again.\nThe turn was:\nfirst");
    });
  });

  it("completes a turn, consuming its inbox mirror and requeueing what the model never saw", async () => {
    await withQueue((q) => {
      q.enqueue(user("work"));
      const t = q.claimNext()!.turn;
      q.mirror(msg("msg_seen", "seen"), t, "inbox/req-1");
      q.mirror(msg("msg_note", "notice one"), t, channelRequestId("team/x", "sub_1", 3));
      q.mirror(msg("msg_note2", "notice two"), t, channelRequestId("team/x", "sub_1", 4));
      expect(q.confirm("msg_seen")).toBe(true);
      expect(q.confirm("msg_seen")).toBe(false);
      expect(q.mirrored().map((m) => m.id)).toEqual(["msg_note", "msg_note2"]);
      q.complete(t);
      expect(q.mirrored()).toEqual([]);
      const next = q.claimNext()!;
      expect(next.input).toEqual({ kind: "event_batch", text: "notice one\n\nnotice two" });
      expect(q.turnFor(`${channelRequestId("team/x", "sub_1", 3)}/requeued`)).toBe(next.turn);
      // Any message, not only a channel's: a direct one comes back as its own turn would show it.
      q.mirror({ ...msg("msg_direct", "ping"), from: "agt_x" }, next.turn);
      q.mirror(msg("msg_note3", "notice three"), next.turn, channelRequestId("team/x", "sub_1", 5));
      q.complete(next.turn);
      expect(q.claimNext()!.input).toEqual({ kind: "inbox", text: "Message from agt_x: ping\n\nnotice three" });
    });
  });

  it("an unseen message that interrupted its turn comes back ahead of the turns already queued; any other, behind them", async () => {
    await withQueue((q) => {
      q.enqueue(user("work"));
      const t = q.claimNext()!.turn;
      q.enqueue(user("queued"));
      q.mirror({ ...msg("msg_stop", "stop that"), from: "user", interrupt: true }, t);
      q.complete(t);
      expect(q.claimNext()!.input.text).toBe("Message from user: stop that");
      const u = q.claimNext()!.turn;
      q.mirror({ ...msg("msg_later", "when you can"), from: "user" }, u);
      q.enqueue(user("next"));
      q.complete(u);
      expect(q.claimNext()!.input.text).toBe("next");
    });
  });

  it("counts channel turns and merges into the one still waiting", async () => {
    await withQueue((q) => {
      const now = Date.now();
      q.enqueue(user("plain"));
      const c = q.enqueue({ kind: "event_batch", text: "n1" }, channelRequestId("team/x", "sub_1", 1), now);
      expect(q.load(now)).toEqual({ hour: 1, oldest: now, waiting: 1 });
      expect(q.waitingChannelTurn()).toEqual({ turn: c, input: { kind: "event_batch", text: "n1" } });
      q.merge(c, { kind: "event_batch", text: "n1\n\nn2" }, now + 1);
      expect(q.load(now + 2)).toMatchObject({ hour: 2, waiting: 1 });
      // A merge's wake leaves the hour's count after an hour.
      expect(q.load(now + 3_600_002).hour).toBe(0);
    });
  });
});

describe("recoveryInput", () => {
  it("keeps the original turn's text once, however often it's recovered", () => {
    const once = recoveryInput(user("do it"), ["A.", "B."]);
    expect(once).toEqual({ kind: "recovery", text: "A. B.\nThe turn was:\ndo it" });
    expect(recoveryInput(once, ["C."]).text).toBe("C.\nThe turn was:\ndo it");
    // A user's text that happens to contain the mark is kept whole (only a recovery turn is split).
    expect(recoveryInput(user("x\nThe turn was:\ny"), ["N."]).text).toBe("N.\nThe turn was:\nx\nThe turn was:\ny");
  });
});

describe("admitDelivery", () => {
  const now = 10_000_000;
  const idle = { hour: 0, oldest: null, waiting: 0 };
  const waiting = { turn: "trn_w", input: { kind: "event_batch" as const, text: "earlier" } };

  it("joins the running turn only for the agent's own inbox", () => {
    // Even past the guards: a message to the agent mid-turn always reaches it.
    expect(admitDelivery({ midTurnInbox: true, load: { hour: 999, oldest: now, waiting: 999 }, waiting, text: "t", now })).toEqual({ kind: "join" });
    expect(admitDelivery({ midTurnInbox: false, load: idle, waiting: undefined, text: "t", now })).toEqual({ kind: "queue" });
  });

  it("merges into a waiting channel turn, up to the size cap", () => {
    expect(admitDelivery({ midTurnInbox: false, load: idle, waiting, text: "later", now }))
      .toEqual({ kind: "merge", turn: "trn_w", input: { kind: "event_batch", text: "earlier\n\nlater" } });
    expect(admitDelivery({ midTurnInbox: false, load: idle, waiting, text: "x".repeat(MERGED_TURN_BYTES), now }).kind).toBe("defer");
  });

  it("defers past the hourly cap until the oldest wake ages out, and past the waiting cap", () => {
    expect(admitDelivery({ midTurnInbox: false, load: { hour: WAKE_CAP_PER_HOUR, oldest: now - 3_000_000, waiting: 0 }, waiting: undefined, text: "t", now }))
      .toEqual({ kind: "defer", retry_after_ms: 600_000 });
    expect(admitDelivery({ midTurnInbox: false, load: { hour: WAKE_CAP_PER_HOUR, oldest: now - 3_599_999, waiting: 0 }, waiting: undefined, text: "t", now }))
      .toEqual({ kind: "defer", retry_after_ms: 1_000 });
    expect(admitDelivery({ midTurnInbox: false, load: { hour: 0, oldest: null, waiting: MAX_WAITING_DELIVERIES }, waiting, text: "t", now }).kind).toBe("defer");
  });
});

describe("moveNoteDue", () => {
  const continued = { started_ms: 1_000, hands_epoch: 2 };
  it("is due when the sandbox moved since the brain was last told", () => {
    expect(moveNoteDue({ epoch: 3, told: 2, continued: undefined, movedMs: undefined })).toBe(true);
    expect(moveNoteDue({ epoch: 3, told: 3, continued: undefined, movedMs: 5_000 })).toBe(false);
    // Never told anything yet (the first turn): nothing to compare with.
    expect(moveNoteDue({ epoch: 3, told: undefined, continued: undefined, movedMs: 5_000 })).toBe(false);
  });

  it("for a recovery turn, is due when the sandbox moved during the turn it continues, told or not", () => {
    // The brain was told mid-turn (told = 3), then restarted: the recovery turn still says so.
    expect(moveNoteDue({ epoch: 3, told: 3, continued, movedMs: undefined })).toBe(true);
    expect(moveNoteDue({ epoch: 2, told: 2, continued, movedMs: 5_000 })).toBe(false);
    // No epoch recorded at that turn's start: AgentDO's record of the last move decides.
    expect(moveNoteDue({ epoch: 3, told: 3, continued: { started_ms: 1_000, hands_epoch: null }, movedMs: 999 })).toBe(false);
    expect(moveNoteDue({ epoch: 3, told: 3, continued: { started_ms: 1_000, hands_epoch: null }, movedMs: 1_000 })).toBe(true);
  });

  it("with SandboxDO unreachable, falls back to the last move AgentDO heard of, for a recovery turn only", () => {
    expect(moveNoteDue({ epoch: null, told: 2, continued: undefined, movedMs: 5_000 })).toBe(false);
    expect(moveNoteDue({ epoch: null, told: 2, continued, movedMs: 5_000 })).toBe(true);
    expect(moveNoteDue({ epoch: null, told: 2, continued, movedMs: 500 })).toBe(false);
  });
});
