// The outbox machine (src/outbox.ts, README.md#outboxes): every retry queue's rows go owed → retrying →
// done or failed by one function. The table is the rule, one sentence a row; a seeded random walk then
// checks what must hold of any row whatever happens to it.
import { describe, expect, it } from "vitest";
import { NestError } from "../src/nest";
import { GitHubError } from "../src/github";
import { OUTBOX, type OutboxEvent, type OutboxRow, outboxState, outboxStep, prunable, pruneBefore, verdict } from "../src/outbox";

const NOW = 1_000_000_000;
const owed: OutboxRow = { next_ms: NOW, attempts: 0, error: null };
const retrying: OutboxRow = { next_ms: NOW + 5_000, attempts: 2, error: "nest 503" };
const failed: OutboxRow = { next_ms: null, attempts: 3, error: "nest 409 ended" };
const done: OutboxRow = { next_ms: null, attempts: 1, error: null };

describe("a row's state", () => {
  it("is read from its columns", () => {
    expect(outboxState(owed)).toBe("owed");
    expect(outboxState(retrying)).toBe("retrying");
    expect(outboxState(failed)).toBe("failed");
    expect(outboxState(done)).toBe("done");
    // Waiting for something it needs (no attempt made): still being sent, with why.
    expect(outboxState({ next_ms: NOW, attempts: 0, error: "the manager isn't started yet" })).toBe("retrying");
  });
});

describe("the outbox's steps", () => {
  const ok = (r: OutboxRow, e: OutboxEvent, policy = {}) => {
    const s = outboxStep(r, e, NOW, policy);
    if (!s.ok) throw new Error(s.error);
    return s;
  };

  it("sent: owed or retrying is done; done again changes nothing", () => {
    expect(ok(owed, { kind: "sent" })).toMatchObject({ state: "done", row: { next_ms: null, error: null, attempts: 1 } });
    expect(ok(retrying, { kind: "sent" }).state).toBe("done");
    expect(ok(done, { kind: "sent" }).row).toEqual(done);
    expect(outboxStep(failed, { kind: "sent" }, NOW).ok).toBe(false);
  });

  it("a transient failure is retried with backoff, as often as it takes unless the queue caps it", () => {
    const s = ok(owed, { kind: "failed", error: "nest 503", permanent: false });
    expect(s).toMatchObject({ state: "retrying", row: { attempts: 1, error: "nest 503", next_ms: NOW + 5_000 } });
    expect(ok(retrying, { kind: "failed", error: "again", permanent: false }).row.next_ms).toBe(NOW + 20_000);
    expect(ok({ ...retrying, attempts: 40 }, { kind: "failed", error: "x", permanent: false }).state).toBe("retrying");
    expect(ok({ ...retrying, attempts: 2 }, { kind: "failed", error: "x", permanent: false }, { maxAttempts: 3 }).state).toBe("failed");
    expect(ok({ ...retrying, attempts: 1 }, { kind: "failed", error: "x", permanent: false }, { maxAttempts: 3 }).state).toBe("retrying");
  });

  it("a permanent failure fails it at once, with the reason", () => {
    expect(ok(owed, { kind: "failed", error: "nest 403 forbidden", permanent: true })).toMatchObject({ state: "failed", row: { next_ms: null, error: "nest 403 forbidden" } });
    expect(outboxStep(done, { kind: "failed", error: "x", permanent: true }, NOW).ok).toBe(false);
  });

  it("wait: due again, with why, never failed and never counted as an attempt (B9)", () => {
    let r: OutboxRow = owed;
    for (let i = 0; i < 50; i++) r = ok(r, { kind: "wait", error: "the manager isn't started yet" }).row;
    expect(outboxState(r)).toBe("retrying");
    expect(r.attempts).toBe(0);
    expect(r.next_ms).toBe(NOW + 5_000);
  });

  it("retry: a failed row is owed afresh; any other is left as it is, so asking twice sends once", () => {
    expect(ok(failed, { kind: "retry" })).toMatchObject({ state: "owed", row: { next_ms: NOW, attempts: 0, error: null } });
    for (const r of [owed, retrying, done]) expect(ok(r, { kind: "retry" }).row).toEqual(r);
  });
});

describe("the verdict", () => {
  it("is permanent for a refusal that will repeat, nest's or GitHub's, and transient otherwise", () => {
    expect(verdict(new NestError(403, "forbidden", "no", false))).toEqual({ permanent: true, error: "nest 403 forbidden: no" });
    expect(verdict(new NestError(503, "unavailable", "busy", true)).permanent).toBe(false);
    expect(verdict(new NestError(409, "busy", "in flight", true)).permanent).toBe(false);
    expect(verdict(new GitHubError(404, "Not Found", false)).permanent).toBe(true);
    expect(verdict(new GitHubError(403, "rate limit", true)).permanent).toBe(false);
    expect(verdict(new TypeError("fetch failed")).permanent).toBe(false);
    expect(verdict("odd").error).toBe("odd");
  });
});

describe("pruning", () => {
  it("drops a queue's ended rows past its keep, never one still being sent, and never the chat's or an issue close's", () => {
    const week = 7 * 86_400_000;
    expect(pruneBefore(OUTBOX.messages, NOW)).toBe(NOW - week);
    expect(prunable(done, NOW - week - 1, OUTBOX.messages, NOW)).toBe(true);
    expect(prunable(failed, NOW - week - 1, OUTBOX.messages, NOW)).toBe(true);
    expect(prunable(done, NOW - week + 1, OUTBOX.messages, NOW)).toBe(false);
    expect(prunable(retrying, 0, OUTBOX.messages, NOW)).toBe(false);
    expect(prunable(owed, 0, OUTBOX.messages, NOW)).toBe(false);
    expect(prunable(done, 0, OUTBOX.chat, NOW)).toBe(false);
    expect(prunable(failed, 0, OUTBOX.issue_closes, NOW)).toBe(false);
    // A failed stop is never pruned: its agent may still be running, its place counted.
    expect(pruneBefore(OUTBOX.stops, NOW)).toBeNull();
  });
});

/** mulberry32: a failure names its seed and replays. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("a seeded random walk over a row", () => {
  it("never leaves done, leaves failed only by retry, never fails while waiting, and is due exactly while being sent", () => {
    const events = (next: () => number): OutboxEvent => {
      const k = Math.floor(next() * 5);
      return k === 0 ? { kind: "sent" } : k === 1 ? { kind: "failed", error: "e", permanent: next() < 0.3 } : k === 2 ? { kind: "wait", error: "w" } : k === 3 ? { kind: "retry" } : { kind: "failed", error: "t", permanent: false };
    };
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const policy = next() < 0.5 ? {} : { maxAttempts: 1 + Math.floor(next() * 5) };
      let r: OutboxRow = owed;
      for (let i = 0; i < 100; i++) {
        const e = events(next);
        const before = outboxState(r);
        const s = outboxStep(r, e, NOW + i, policy);
        if (!s.ok) {
          expect(["done", "failed"], `seed ${seed}`).toContain(before);
          continue;
        }
        const after = s.state;
        if (before === "done") expect(s.row, `seed ${seed}: done is final`).toEqual(r);
        if (before === "failed" && after !== "failed") expect(e.kind, `seed ${seed}`).toBe("retry");
        if (e.kind === "wait") expect(after, `seed ${seed}`).toBe("retrying");
        if (e.kind === "wait") expect(s.row.attempts).toBe(r.attempts);
        expect(s.row.next_ms !== null, `seed ${seed}: due iff owed or retrying`).toBe(after === "owed" || after === "retrying");
        if (policy.maxAttempts !== undefined && after === "retrying" && e.kind === "failed") expect(s.row.attempts).toBeLessThan(policy.maxAttempts);
        r = s.row;
        if (after === "done" && next() < 0.3) r = owed;
      }
    }
  });
});
