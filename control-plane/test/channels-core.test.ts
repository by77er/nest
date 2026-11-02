// The channels core (lib/channels.ts): names, validation, permissions, the post guards, filters,
// batching and delivery outcomes, envelopes and taint. Pure functions, checked directly, with
// seeded generators (mulberry32: a failure names its seed) for the properties.
import { describe, expect, it } from "vitest";
import {
  afterDelivery, type Batch, beginDelivery, type Caller, type ChannelFacts, checkPost, clip, decidePost, type DeliveryOutcome, deliveryBackoff,
  envelopeText, type Filter, INLINE_BODY_BYTES, type LogView, matches, MAX_BODY_BYTES, type MessageMeta, onAppend, parseChannel, patternMatches,
  permits, planBatch, type PostState, RATE_LIMIT_POSTS, chunks, R2_DELETE_MAX, REPEAT_WINDOW_MS, sessionTaint, settleDelivery, SubscribeInput,
  type Subscription, takeBatch,
} from "../src/lib/channels";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = "agt_aaaa";
const B = "agt_bbbb";
const C = "agt_cccc";
const agent = (id: string, o: Partial<{ owner: string | null; sandbox: string | null; grants: Caller extends infer _ ? any[] : never; tainted: boolean }> = {}): Caller =>
  ({ principal: id, owner: o.owner ?? null, sandbox: o.sandbox ?? null, grants: o.grants ?? [], tainted: o.tainted ?? false });
const facts = (name: string, o: Partial<ChannelFacts> = {}): ChannelFacts => {
  const k = parseChannel(name);
  if (!k.ok) throw new Error(k.error);
  return { name, kind: k.value, owner: null, acl: [], ...o };
};

describe("channel names", () => {
  it("built-ins are recognized; reserved and malformed names are refused", () => {
    expect(parseChannel(`${A}/inbox`)).toEqual({ ok: true, value: { kind: "inbox", agent: A } });
    expect(parseChannel(`${A}/events`)).toEqual({ ok: true, value: { kind: "events", agent: A } });
    expect(parseChannel("sbx_0123/events")).toEqual({ ok: true, value: { kind: "sandbox_events", sandbox: "sbx_0123" } });
    expect(parseChannel("user")).toEqual({ ok: true, value: { kind: "user" } });
    expect(parseChannel("team/review")).toEqual({ ok: true, value: { kind: "free" } });
    expect(parseChannel("ws/auth/ci")).toEqual({ ok: true, value: { kind: "free" } });
    for (const bad of ["", "Team", "a//b", "/a", "a/", "a b", `${A}/memory`, `${A}`, "sbx_1/inbox", "user/x", "platform", "ws_1/x", "hk_1", "x".repeat(129)]) {
      expect(parseChannel(bad).ok, bad).toBe(false);
    }
  });
});

describe("post validation", () => {
  it("refuses from/taint in the body, bad keys and kinds, oversized bodies; offloads big ones", () => {
    expect(checkPost({ text: "hi", from: "user" }).ok).toBe(false);
    expect(checkPost({ text: "hi", taint: false }).ok).toBe(false);
    expect(checkPost({ text: "hi", key: "Has Space" }).ok).toBe(false);
    expect(checkPost({ text: "hi", key: "x".repeat(65) }).ok).toBe(false);
    expect(checkPost({ text: "hi", kind: "BAD KIND" }).ok).toBe(false);
    expect(checkPost({ text: "hi", if_seq: 1 }).ok).toBe(false); // if_seq needs a key
    expect(checkPost({ text: "" }).ok).toBe(false); // nothing to say
    expect(checkPost({ text: "", key: "k", data: { a: 1 } }).ok).toBe(false); // a removal carries no data
    const rm = checkPost({ text: "", key: "task/1" });
    expect(rm.ok && rm.value.removes_key).toBe(true);
    const small = checkPost({ text: "x".repeat(INLINE_BODY_BYTES) });
    expect(small.ok && small.value.inline).toBe(true);
    const big = checkPost({ text: "x".repeat(INLINE_BODY_BYTES + 1) });
    expect(big.ok && !big.value.inline).toBe(true);
    expect(checkPost({ text: "x".repeat(MAX_BODY_BYTES + 1) }).ok).toBe(false);
    // Multi-byte text is measured in bytes.
    const mb = checkPost({ text: "é".repeat(INLINE_BODY_BYTES / 2 + 1) });
    expect(mb.ok && !mb.value.inline).toBe(true);
  });
});

describe("permissions", () => {
  it("an agent reads and posts its own inbox; no other agent may read it, and none posts without a grant", () => {
    expect(permits("read", agent(A), facts(`${A}/inbox`)).ok).toBe(true);
    expect(permits("post", agent(A), facts(`${A}/inbox`)).ok).toBe(true);
    expect(permits("read", agent(B), facts(`${A}/inbox`)).ok).toBe(false);
    expect(permits("post", agent(B), facts(`${A}/inbox`)).ok).toBe(false);
    // Even its owner can't read it (read isn't part of messaging), only post with a grant.
    expect(permits("read", agent(B), facts(`${A}/inbox`, { agent_owner: B })).ok).toBe(false);
  });

  it("events channels are posted by the platform only, whatever the grants or grant list say", () => {
    const g = [{ action: "post" as const, channel: "**" }, { action: "post" as const, channel: "{self}/events" }];
    expect(permits("post", agent(A, { grants: g }), facts(`${A}/events`)).ok).toBe(false);
    expect(permits("post", agent(A), facts(`${A}/events`, { acl: [{ principal: A, action: "post" }] })).ok).toBe(false);
    expect(permits("post", agent(A, { sandbox: "sbx_1", grants: g }), facts("sbx_1/events")).ok).toBe(false);
    expect(permits("post", { principal: "platform" }, facts(`${A}/events`)).ok).toBe(true);
  });

  it("the spawner reads its child's events; others don't; an agent reads its own sandbox's events only", () => {
    expect(permits("read", agent(B), facts(`${A}/events`, { agent_owner: B })).ok).toBe(true);
    expect(permits("read", agent(C), facts(`${A}/events`, { agent_owner: B })).ok).toBe(false);
    expect(permits("read", agent(A), facts(`${A}/events`)).ok).toBe(true);
    expect(permits("read", agent(A, { sandbox: "sbx_1" }), facts("sbx_1/events")).ok).toBe(true);
    expect(permits("read", agent(A, { sandbox: "sbx_2" }), facts("sbx_1/events")).ok).toBe(false);
  });

  it("a free channel: its owner holds both; others need its grant list or a capability grant", () => {
    expect(permits("post", agent(A), facts("team/x", { owner: A })).ok).toBe(true);
    expect(permits("read", agent(B), facts("team/x", { owner: A })).ok).toBe(false);
    expect(permits("read", agent(B), facts("team/x", { owner: A, acl: [{ principal: B, action: "read" }] })).ok).toBe(true);
    expect(permits("post", agent(B), facts("team/x", { owner: A, acl: [{ principal: B, action: "read" }] })).ok).toBe(false);
    expect(permits("post", agent(B, { grants: [{ action: "post", channel: "team/*" }] }), facts("team/x", { owner: A })).ok).toBe(true);
    expect(permits("post", agent(B, { grants: [{ action: "post", channel: "team/*" }] }), facts("team/x/y", { owner: A })).ok).toBe(false);
    expect(permits("post", agent(B, { grants: [{ action: "post", channel: "team/**" }] }), facts("team/x/y", { owner: A })).ok).toBe(true);
    expect(permits("post", agent(B, { grants: [{ action: "read", channel: "team/*" }] }), facts("team/x", { owner: A })).ok).toBe(false);
  });

  it("user: posted with a grant, read only by the operator", () => {
    expect(permits("post", agent(A, { grants: [{ action: "post", channel: "user" }] }), facts("user")).ok).toBe(true);
    expect(permits("post", agent(A), facts("user")).ok).toBe(false);
    expect(permits("read", agent(A, { grants: [{ action: "post", channel: "user" }] }), facts("user")).ok).toBe(false);
    expect(permits("read", { principal: "user" }, facts("user")).ok).toBe(true);
  });

  it("wildcards never reach user or a built-in channel; an exact name or a relation does", () => {
    const wide = [{ action: "read" as const, channel: "*" }, { action: "read" as const, channel: "**" }, { action: "read" as const, channel: "*/inbox" },
      { action: "read" as const, channel: "*/events" }, { action: "post" as const, channel: "**" }, { action: "read" as const, channel: "{owner}/**" }];
    for (const name of ["user", `${B}/inbox`, `${B}/events`, "sbx_1/events"]) {
      for (const action of ["read", "post"] as const) {
        expect(permits(action, agent(A, { owner: B, grants: wide }), facts(name, { agent_owner: C })).ok, `${action} ${name}`).toBe(false);
      }
    }
    // Free channels still match wildcards.
    expect(permits("read", agent(A, { grants: wide }), facts("team/x/y")).ok).toBe(true);
    // An exact name, or a relation, does reach a built-in.
    expect(permits("read", agent(A, { grants: [{ action: "read", channel: "user" }] }), facts("user")).ok).toBe(true);
    expect(permits("post", agent(A, { grants: [{ action: "post", channel: `${B}/inbox` }] }), facts(`${B}/inbox`)).ok).toBe(true);
    expect(permits("post", agent(A, { owner: B, grants: [{ action: "post", channel: "{owner}/inbox" }] }), facts(`${B}/inbox`)).ok).toBe(true);
  });

  it("{owner} and {child} name only the caller's own owner and children", () => {
    const tree = [{ action: "post" as const, channel: "{owner}/inbox" }, { action: "post" as const, channel: "{child}/inbox" }];
    // A (owner B) reaches B's inbox; not C's.
    expect(permits("post", agent(A, { owner: B, grants: tree }), facts(`${B}/inbox`)).ok).toBe(true);
    expect(permits("post", agent(A, { owner: B, grants: tree }), facts(`${C}/inbox`)).ok).toBe(false);
    // B reaches A's inbox (A's owner is B), C doesn't.
    expect(permits("post", agent(B, { grants: tree }), facts(`${A}/inbox`, { agent_owner: B })).ok).toBe(true);
    expect(permits("post", agent(C, { grants: tree }), facts(`${A}/inbox`, { agent_owner: B })).ok).toBe(false);
    // An unknown owner (null) never matches.
    expect(permits("post", agent(C, { grants: tree }), facts(`${A}/inbox`, { agent_owner: null })).ok).toBe(false);
    expect(patternMatches("{child}/events", agent(B), facts(`${A}/inbox`, { agent_owner: B }))).toBe(false);
    expect(patternMatches("{self}/inbox", agent(A), facts(`${A}/inbox`))).toBe(true);
  });

  it("property: with no grants, grant list or ownership, an agent can do nothing to another agent's channels", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const ids = [A, B, C];
      const me = ids[Math.floor(r() * 3)]!;
      const other = ids.filter((x) => x !== me)[Math.floor(r() * 2)]!;
      const owner = r() < 0.5 ? null : ids[Math.floor(r() * 3)]!;
      const name = `${other}/${r() < 0.5 ? "inbox" : "events"}`;
      const f = facts(name, { agent_owner: r() < 0.5 ? owner : null });
      for (const action of ["post", "read"] as const) {
        const d = permits(action, agent(me, { owner }), f);
        const spawnerRead = action === "read" && name.endsWith("/events") && f.agent_owner === me;
        expect(d.ok, `seed ${seed} ${me} ${action} ${name}`).toBe(spawnerRead);
      }
    }
  });
});

describe("post guards", () => {
  const post = (raw: unknown) => {
    const c = checkPost(raw);
    if (!c.ok) throw new Error(c.error);
    return c.value;
  };
  const st = (o: Partial<PostState> = {}): PostState => ({ head: 10, ...o });

  it("an idempotency key returns the first seq; compare-and-set refuses a stale if_seq", () => {
    expect(decidePost(post({ text: "a", idem_key: "k" }), A, st({ idem_seq: 4 }), 0)).toEqual({ kind: "existing", seq: 4 });
    expect(decidePost(post({ text: "a", key: "t/1", if_seq: 0 }), A, st(), 0)).toMatchObject({ kind: "append", seq: 11 });
    expect(decidePost(post({ text: "a", key: "t/1", if_seq: 0 }), A, st({ key_seq: 7 }), 0)).toEqual({ kind: "conflict", current_seq: 7 });
    expect(decidePost(post({ text: "a", key: "t/1", if_seq: 7 }), A, st({ key_seq: 7 }), 0)).toMatchObject({ kind: "append" });
    expect(decidePost(post({ text: "a", key: "t/1", if_seq: 6 }), A, st({ key_seq: 7 }), 0)).toEqual({ kind: "conflict", current_seq: 7 });
    // The idempotency key wins over a conflict its own first post caused.
    expect(decidePost(post({ text: "a", key: "t/1", if_seq: 0, idem_key: "k" }), A, st({ key_seq: 11, idem_seq: 11 }), 0)).toEqual({ kind: "existing", seq: 11 });
    expect(decidePost(post({ text: "a", reply_to: 11 }), A, st(), 0)).toMatchObject({ kind: "invalid" });
  });

  it("a repeat never swallows a state change: claim, release, re-claim lands; so does A-B-A on a key", () => {
    // Replays the post log through decidePost, keeping the keyed view and each sender's last post.
    const sim = () => {
      let head = 0;
      const view = new Map<string, number>();
      const last = new Map<string, PostState["last_by_sender"]>();
      return (from: string, raw: Record<string, unknown>, now: number) => {
        const p = post(raw);
        const key = raw.key as string | undefined;
        const d = decidePost(p, from, { head, ...(key && view.has(key) ? { key_seq: view.get(key)! } : {}), ...(last.get(from) ? { last_by_sender: last.get(from)! } : {}) }, now);
        if (d.kind === "append") {
          head = d.seq;
          if (key) {
            if (p.removes_key) view.delete(key);
            else view.set(key, d.seq);
          }
          last.set(from, { seq: d.seq, ts_ms: now, text: p.input.text, data_json: p.data_json, ...(p.input.kind ? { kind: p.input.kind } : {}), ...(key ? { key } : {}) });
        }
        return { d, view };
      };
    };
    const s1 = sim();
    expect(s1(A, { text: "mine", key: "task/1", if_seq: 0 }, 1000).d).toMatchObject({ kind: "append", seq: 1 });
    expect(s1(B, { text: "", key: "task/1" }, 2000).d).toMatchObject({ kind: "append", seq: 2 });
    // A re-claims within the minute: its compare-and-set passes, so the post must land.
    expect(s1(A, { text: "mine", key: "task/1", if_seq: 0 }, 3000).d).toMatchObject({ kind: "append", seq: 3 });
    // C's claim now loses: one owner.
    const c = s1(C, { text: "mine", key: "task/1", if_seq: 0 }, 4000);
    expect(c.d).toEqual({ kind: "conflict", current_seq: 3 });
    expect(c.view.get("task/1")).toBe(3);
    // A-B-A on plain keyed state: the key ends where A left it.
    const s2 = sim();
    s2(A, { text: "up", key: "status" }, 1000);
    s2(B, { text: "down", key: "status" }, 2000);
    expect(s2(A, { text: "up", key: "status" }, 3000).d).toMatchObject({ kind: "append", seq: 3 });
    // An identical keyed post while the key is still the sender's previous one is a repeat.
    expect(s2(A, { text: "up", key: "status" }, 4000).d).toEqual({ kind: "repeat", seq: 3 });
    // A post whose compare-and-set passed always lands, even identical to the sender's last one.
    expect(s2(A, { text: "up", key: "status", if_seq: 3 }, 5000).d).toMatchObject({ kind: "append", seq: 4 });
    // Same text without the key, after a keyed post: not a repeat (a different message).
    const s3 = sim();
    s3(A, { text: "x", key: "k" }, 1000);
    expect(s3(A, { text: "x" }, 2000).d).toMatchObject({ kind: "append", seq: 2 });
  });

  it("drops a sender's identical repeat within a minute, and rate-limits agents (not user or platform)", () => {
    const prev = { seq: 9, ts_ms: 1000, text: "same", data_json: null };
    expect(decidePost(post({ text: "same" }), A, st({ last_by_sender: prev }), 1000 + REPEAT_WINDOW_MS - 1)).toEqual({ kind: "repeat", seq: 9 });
    expect(decidePost(post({ text: "same" }), A, st({ last_by_sender: prev }), 1000 + REPEAT_WINDOW_MS)).toMatchObject({ kind: "append" });
    expect(decidePost(post({ text: "same", kind: "progress" }), A, st({ last_by_sender: prev }), 1001)).toMatchObject({ kind: "append" });
    expect(decidePost(post({ text: "x" }), A, st({ rate: { start_ms: 0, count: RATE_LIMIT_POSTS } }), 10)).toMatchObject({ kind: "rate_limited" });
    expect(decidePost(post({ text: "x" }), A, st({ rate: { start_ms: 0, count: RATE_LIMIT_POSTS } }), 60_000)).toMatchObject({ kind: "append", rate: { count: 1 } });
    expect(decidePost(post({ text: "x" }), "user", st({ rate: { start_ms: 0, count: 10_000 } }), 10)).toMatchObject({ kind: "append", rate: null });
    expect(decidePost(post({ text: "x" }), "platform", st({ rate: { start_ms: 0, count: 10_000 } }), 10)).toMatchObject({ kind: "append" });
  });

  it("property: competing compare-and-sets on a key: exactly one per if_seq wins, and the view is the newest per key", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const view = new Map<string, number>();
      let head = 0;
      const keys = ["a", "b", "c"];
      for (let step = 0; step < 40; step++) {
        const key = keys[Math.floor(r() * keys.length)]!;
        const seen = view.get(key) ?? 0;
        // Two posters read the same version and race.
        const racers = 1 + Math.floor(r() * 3);
        let wins = 0;
        for (let i = 0; i < racers; i++) {
          const remove = r() < 0.2;
          const d = decidePost(post({ text: remove ? "" : `v${step}.${i}`, key, if_seq: seen }), `agt_r${i}`, { head, ...(view.has(key) ? { key_seq: view.get(key)! } : {}) }, step * 1000);
          if (d.kind === "append") {
            wins++;
            head = d.seq;
            if (remove) view.delete(key);
            else view.set(key, d.seq);
          } else {
            expect(d.kind, `seed ${seed}`).toBe("conflict");
          }
        }
        // The first racer always wins. Every win moves the key to a fresh seq, or to absent (0) on a
        // removal: so racers on a present key's version have exactly one winner, and a later racer
        // on an absent key wins again only after a removal left it absent.
        const ctx = `seed ${seed} step ${step}`;
        expect(wins >= 1, ctx).toBe(true);
        if (seen !== 0) expect(wins, ctx).toBe(1);
        // The view is the newest per key.
        if (view.has(key)) expect(view.get(key), ctx).toBe(head);
      }
    }
  });
});

describe("filters and batching", () => {
  const m = (seq: number, o: Partial<MessageMeta> = {}): MessageMeta => ({ seq, ts_ms: seq, from: B, taint: false, ...o });
  const sub = (o: Partial<Subscription> = {}): Subscription => ({
    id: "sub_x", agent: A, filter: {}, delivery: "turn", batch_ms: 100, once: false, cursor: 0, due_ms: null, inflight: null, attempts: 0, ...o,
  });

  it("matches every given criterion; an agent's own posts never match", () => {
    expect(matches({}, m(1), A)).toBe(true);
    expect(matches({}, m(1, { from: A }), A)).toBe(false);
    expect(matches({ kinds: ["question"] }, m(1), A)).toBe(false);
    expect(matches({ kinds: ["question"] }, m(1, { kind: "question" }), A)).toBe(true);
    expect(matches({ from: ["user"] }, m(1), A)).toBe(false);
    expect(matches({ keys: ["ref/main"] }, m(1, { key: "ref/main/1" }), A)).toBe(true);
    expect(matches({ keys: ["ref/main"] }, m(1, { key: "ref/dev" }), A)).toBe(false);
    expect(matches({ keys: ["ref/"] }, m(1), A)).toBe(false);
    expect(matches({ mentions_me: true }, m(1, { mentions: [C] }), A)).toBe(false);
    expect(matches({ mentions_me: true }, m(1, { mentions: [A] }), A)).toBe(true);
    expect(matches({ reply_to: 3 }, m(4, { reply_to: 3 }), A)).toBe(true);
    expect(matches({ reply_to: 3, kinds: ["x"] }, m(4, { reply_to: 3 }), A)).toBe(false);
  });

  it("a match opens one batch window; later matches don't move it; none delivery never opens one", () => {
    expect(onAppend(sub(), m(1), 1000)).toBe(1100);
    expect(onAppend(sub({ due_ms: 1100 }), m(2), 1050)).toBe(1100);
    expect(onAppend(sub(), m(1, { from: A }), 1000)).toBeNull();
    expect(onAppend(sub({ delivery: "none" }), m(1), 1000)).toBeNull();
    expect(onAppend(sub({ filter: { kinds: ["q"] } }), m(1), 1000)).toBeNull();
  });

  it("plans one batch over every match after the cursor, with senders, kinds, taint and user texts inline", () => {
    const msgs = [m(1), m(2, { from: A }), m(3, { from: "user", text: "hello" } as never), m(4, { kind: "q", taint: true }), m(5, { from: C })];
    const p = planBatch(sub(), msgs);
    expect(p).toMatchObject({ kind: "deliver", batch: { after_seq: 0, to_seq: 5, count: 4, first_seq: 1, last_seq: 5, kinds: ["q"], tainted: 1, ends: false } });
    if (p.kind !== "deliver") throw new Error();
    expect(p.batch.senders).toEqual([{ from: B, n: 2 }, { from: C, n: 1 }, { from: "user", n: 1 }]);
    expect(p.batch.inline).toEqual([{ seq: 3, text: "hello" }]);
    expect(planBatch(sub({ cursor: 5 }), msgs)).toEqual({ kind: "idle" });
    expect(planBatch(sub({ filter: { kinds: ["zzz"] } }), msgs)).toEqual({ kind: "advance", to_seq: 5 });
    // once: only the first match, and the batch ends the subscription.
    expect(planBatch(sub({ once: true, filter: { kinds: ["q"] } }), msgs)).toMatchObject({ kind: "deliver", batch: { to_seq: 4, count: 1, ends: true } });
  });

  it("outcomes: ok moves the cursor and unpins; defer unpins without moving; error keeps the batch and backs off; stale answers change nothing", () => {
    const b: Batch = { after_seq: 0, to_seq: 5, count: 2, first_seq: 1, last_seq: 5, senders: [], kinds: [], tainted: 0, inline: [], ends: false };
    const pinned = sub({ inflight: b, due_ms: 99_999 });
    expect(afterDelivery(pinned, b, { status: "ok" }, 1000)).toMatchObject({ cursor: 5, inflight: null, due_ms: null, attempts: 0 });
    expect(afterDelivery(pinned, b, { status: "defer", retry_after_ms: 500 }, 1000)).toMatchObject({ cursor: 0, inflight: null });
    expect(afterDelivery(pinned, b, { status: "error" }, 1000)).toMatchObject({ cursor: 0, inflight: b, attempts: 1, due_ms: 1000 + deliveryBackoff(1) });
    // A stale answer (another batch is pinned, or none) changes nothing.
    expect(afterDelivery(sub({ inflight: { ...b, to_seq: 9 } }), b, { status: "ok" }, 1000)).toMatchObject({ cursor: 0 });
    expect(afterDelivery(sub({ cursor: 7 }), b, { status: "ok" }, 1000)).toMatchObject({ cursor: 7 });
    // A once subscription ends with its batch.
    expect(afterDelivery(sub({ once: true, inflight: { ...b, ends: true } }), { ...b, ends: true }, { status: "ok" }, 1000)).toBeNull();
    expect(deliveryBackoff(1)).toBe(1000);
    expect(deliveryBackoff(30)).toBe(300_000);
  });

  it("subscribe input: once needs turn delivery; batch_ms is bounded", () => {
    expect(SubscribeInput.safeParse({ delivery: "none", once: true }).success).toBe(false);
    expect(SubscribeInput.safeParse({ batch_ms: 10 * 60_000 + 1 }).success).toBe(false);
    expect(SubscribeInput.parse({})).toMatchObject({ delivery: "turn", once: false, filter: {} });
  });

  /** The log as ChannelDO's delivery reads it, scanning at most `scan` messages (small: a backlog spans several scans). */
  const logView = (log: readonly (MessageMeta & { text?: string })[], scan: number): LogView =>
    ({ head: log.length, scan: (after) => log.filter((x) => x.seq > after).slice(0, scan) });
  type Attempt = "ok" | "defer" | "error_before" | "error_after";
  const outcomeOf = (o: Attempt, upTo: number, batch: Batch): DeliveryOutcome =>
    o === "ok" ? { status: "ok", ...(upTo < batch.to_seq ? { up_to: upTo } : {}) }
      : o === "defer" ? { status: "defer", retry_after_ms: 5 } : { status: "error" };

  /**
   * A channel, one subscription and its AgentDO (a high-water mark), driven by random posts, alarm
   * ticks and delivery outcomes (taken, deferred, failed before or after the agent took it: an ack
   * lost), then drained, through the delivery steps ChannelDO and AgentDO run. With `reads`, every
   * match is admitted exactly once, in order, and nothing else is. Without, the agent takes each
   * batch only up to `inline_to` (a partial ack) and is shown only the user's messages: every user
   * message that matches reaches it exactly once, in order.
   */
  function simulate(seed: number, reads: boolean) {
    const r = rng(seed);
    const senders = reads ? [A, B, C, "user", "platform"] : ["user", "user", "user", B, "platform"];
    const kinds = [undefined, "progress", "question"];
    const filter: Filter = r() < 0.3 ? { kinds: ["question"] } : r() < 0.3 ? { from: [B, "user"] } : {};
    const scan = 1 + Math.floor(r() * 8);
    let s: Subscription | null = {
      id: "sub_p", agent: A, filter, delivery: "turn", batch_ms: Math.floor(r() * 50), once: reads && r() < 0.15, cursor: 0, due_ms: null,
      inflight: null, attempts: 0,
    };
    const log: (MessageMeta & { text?: string })[] = [];
    let hw = 0;
    const admitted: Batch[] = [];
    const shown: number[] = [];
    let now = 0;
    let lastCursor = 0;
    const tick = (attempt: () => Attempt) => {
      if (!s || s.due_ms === null || s.due_ms > now) return;
      const view = logView(log, scan);
      const { save, send: batch } = beginDelivery(s, view, now);
      if (save) s = save;
      if (!batch) return;
      const take = takeBatch({ channel: "team/c", subscription: s.id, batch }, reads);
      expect(take.up_to > batch.after_seq, `seed ${seed}: no progress`).toBe(true);
      // AgentDO deduplicates before its loop guards: a batch it already holds is always `ok`.
      const o = take.up_to <= hw ? (r() < 0.5 ? "ok" : "error_before") : attempt();
      if ((o === "ok" || o === "error_after") && take.up_to > hw) {
        hw = take.up_to;
        admitted.push(take.shown.batch);
        for (const m of take.shown.batch.inline) {
          expect(m.seq <= take.up_to, `seed ${seed}: shown past up_to`).toBe(true);
          shown.push(m.seq);
        }
      }
      s = settleDelivery(s, batch, outcomeOf(o, take.up_to, batch), view, now);
      if (s) {
        expect(s.cursor >= lastCursor, `seed ${seed}: cursor went back`).toBe(true);
        lastCursor = s.cursor;
      }
    };
    for (let step = 0; step < 80; step++) {
      now += Math.floor(r() * 30);
      if (r() < 0.55) {
        const kind = kinds[Math.floor(r() * 3)];
        const from = senders[Math.floor(r() * senders.length)]!;
        const msg = {
          seq: log.length + 1, ts_ms: now, from, taint: r() < 0.3, ...(kind ? { kind } : {}),
          ...(from === "user" ? { text: reads ? `t${log.length + 1}` : "x".repeat(1 + Math.floor(r() * 3000)) } : {}),
        } as MessageMeta & { text?: string };
        log.push(msg);
        if (s) s = { ...s, due_ms: onAppend(s, msg, now) };
      } else {
        tick(() => (["ok", "defer", "error_before", "error_after"] as const)[Math.floor(r() * 4)]!);
      }
    }
    // Drain: every attempt succeeds.
    for (let i = 0; i < 1000 && s && (s.due_ms !== null || s.inflight); i++) {
      now = Math.max(now + 1, s.due_ms ?? now);
      tick(() => "ok");
    }
    return { log, filter, admitted, shown, ended: s === null };
  }

  it("property: an agent without read gets every matching user message exactly once, in order, through partial acks", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { log, filter, shown } = simulate(seed, false);
      const want = log.filter((x) => x.from === "user" && matches(filter, x, A)).map((x) => x.seq);
      expect(shown, `seed ${seed}`).toEqual(want);
    }
  });

  it("property: delivery is exactly-once per match at the agent, in order, under retries, defers and lost acks", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { log, filter, admitted, ended } = simulate(seed, true);
      const ctx = `seed ${seed}`;
      const want = log.filter((x) => matches(filter, x, A));
      if ((admitted.length && admitted[0]!.ends) || ended) {
        // A once subscription delivers exactly its first match, then ends.
        expect(admitted.length, ctx).toBe(want.length ? 1 : 0);
        if (want.length) expect(admitted[0]!.first_seq, ctx).toBe(want[0]!.seq);
        continue;
      }
      // Ranges are contiguous and disjoint; counts add up to every match exactly once.
      let after = 0;
      for (const b of admitted) {
        expect(b.after_seq >= after, ctx).toBe(true);
        const inRange = log.filter((x) => x.seq > b.after_seq && x.seq <= b.to_seq && matches(filter, x, A));
        expect(b.count, ctx).toBe(inRange.length);
        expect(b.count > 0, ctx).toBe(true);
        after = b.to_seq;
      }
      expect(admitted.reduce((n, b) => n + b.count, 0), ctx).toBe(want.length);
      expect(admitted.every((b) => b.senders.every((x) => x.from !== A)), ctx).toBe(true);
    }
  });
});

describe("R2 deletes", () => {
  it("chunks never exceed R2's 1000 keys and cover every key once, in order", () => {
    for (const n of [0, 1, 999, 1000, 1001, 2500]) {
      const xs = Array.from({ length: n }, (_, i) => i);
      const cs = chunks(xs, R2_DELETE_MAX);
      expect(cs.every((c) => c.length > 0 && c.length <= 1000), `${n}`).toBe(true);
      expect(cs.flat(), `${n}`).toEqual(xs);
    }
  });
});

describe("envelope and taint", () => {
  it("names the channel, range, senders, kinds and taint, never bodies except the user's", () => {
    const b: Batch = {
      after_seq: 3, to_seq: 9, count: 3, first_seq: 4, last_seq: 9, senders: [{ from: B, n: 2 }, { from: "user", n: 1 }], kinds: ["q"], tainted: 2,
      inline: [{ seq: 6, text: "from the user" }], ends: false,
    };
    const t = envelopeText({ channel: "team/x", subscription: "sub_1", batch: b }, Date.UTC(2026, 9, 29), Date.UTC(2026, 9, 29) - 5 * 60_000);
    expect(t).toContain("Channel team/x: 3 new messages (seq 4-9) from agt_bbbb (2), user; kinds q; 2 tainted.");
    expect(t).toContain('channel "team/x", since 3');
    // Under a filter the cursor lags behind messages that didn't match: the hint starts at the first match.
    const filtered = envelopeText({ channel: "team/x", subscription: "sub_1", batch: { ...b, after_seq: 0, first_seq: 52, last_seq: 52, count: 1 } }, Date.UTC(2026, 9, 29), null);
    expect(filtered).toContain('channel "team/x", since 51');
    expect(t).toContain("Message from user (seq 6): from the user");
    expect(t).toContain("last turn started 5 min ago");
    // For an agent without `read`: never pointed at the tool.
    const blind = envelopeText({ channel: "team/x", subscription: "sub_1", batch: { ...b, inline: [{ seq: 6, text: "hi" }, { seq: 7, text: "", cut: true }] } }, Date.UTC(2026, 9, 29), null, false);
    expect(blind).not.toContain("`read`");
    expect(blind).toContain("Message from user (seq 7, too long to show here)");
  });

  it("taint: hands, a web built-in or a tainted read; clip keeps at most the byte budget", () => {
    expect(sessionTaint({ hands: false, builtin_tools: [], read_tainted: false })).toBe(false);
    expect(sessionTaint({ hands: true, builtin_tools: [], read_tainted: false })).toBe(true);
    expect(sessionTaint({ hands: false, builtin_tools: ["WebSearch"], read_tainted: false })).toBe(true);
    expect(sessionTaint({ hands: false, builtin_tools: ["TodoWrite"], read_tainted: true })).toBe(true);
    expect(new TextEncoder().encode(clip("é".repeat(5000), 2048)).length).toBeLessThanOrEqual(2048);
    expect(clip("short", 2048)).toBe("short");
  });
});
