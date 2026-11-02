import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { moveNoteDue, recoveryInput, TurnQueue } from "../src/lib/turns";
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
      q.mirror(msg("msg_note", "note one"), t, "inbox/req-2");
      q.mirror({ ...msg("msg_note2", "note two"), from: "agt_x" }, t);
      expect(q.confirm("msg_seen")).toBe(true);
      expect(q.confirm("msg_seen")).toBe(false);
      expect(q.mirrored().map((m) => m.id)).toEqual(["msg_note", "msg_note2"]);
      q.complete(t);
      expect(q.mirrored()).toEqual([]);
      // As one turn, each shown as its own turn would show it, keyed by the first so it is queued once.
      const next = q.claimNext()!;
      expect(next.input).toEqual({ kind: "inbox", text: "Message from platform: note one\n\nMessage from agt_x: note two" });
      expect(q.turnFor("inbox/req-2/requeued")).toBe(next.turn);
    });
  });

  it("an unseen message that interrupted its turn comes back ahead of the turns already queued; any other, by when it arrived", async () => {
    await withQueue((q) => {
      q.enqueue(user("work"), null, 1);
      const t = q.claimNext(1)!.turn;
      q.enqueue(user("queued"), null, 2);
      q.mirror({ ...msg("msg_stop", "stop that"), from: "user", interrupt: true }, t, null, 3);
      q.complete(t, 4);
      expect(q.claimNext(5)!.input.text).toBe("Message from user: stop that");
      expect(q.claimNext(5)!.input.text).toBe("queued");
      // Behind the turns queued before it arrived (at the same ms too), ahead of those queued after.
      q.enqueue(user("more"), null, 5);
      const u = q.claimNext(5)!.turn;
      q.enqueue(user("before"), null, 6);
      q.enqueue(user("same ms"), null, 7);
      q.mirror({ ...msg("msg_later", "when you can"), from: "user" }, u, null, 7);
      q.mirror({ ...msg("msg_later2", "and this"), from: "user" }, u, null, 9);
      q.enqueue(user("after"), null, 8);
      q.enqueue(user("last"), null, 10);
      q.complete(u, 11);
      expect([1, 2, 3, 4].map(() => q.claimNext(12)!.input.text))
        .toEqual(["before", "same ms", "Message from user: when you can\n\nMessage from user: and this", "after"]);
      expect(q.claimNext(12)!.input.text).toBe("last");
      // Arrived before every queued turn: ahead of them all.
      q.enqueue(user("w"), null, 13);
      const v = q.claimNext(13)!.turn;
      q.mirror(msg("msg_early", "early"), v, null, 14);
      q.enqueue(user("queued later"), null, 15);
      q.complete(v, 16);
      expect(q.claimNext(17)!.input.text).toBe("Message from platform: early");
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
