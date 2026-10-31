// Channels end to end (docs/channels/): ChannelDO through the operator API and its stub (ordering,
// paging, the keyed view, compare-and-set, size limits, retention), subscriptions delivered into
// AgentDO's turn queue and inbox (batched, once per window under retries and a crash mid-delivery,
// `none` and `once`), the built-in channels, permission refusals, the channel tools through the
// real dispatch path, and the catalog's seed migration.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { CatalogDO } from "../src/do/catalog";
import type { ChannelDO } from "../src/do/channel";
import type { Caller } from "../src/lib/channels";
import { SEED_CATALOG_V1, SEED_VERSION } from "../src/lib/spec";
import { admin, adminJson, connectHost, nextCommands, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const chStub = (name: string) => env.CHANNEL.get(env.CHANNEL.idFromName(name));
const enc = encodeURIComponent;
const uniq = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;
const asAgent = (id: string, o: { owner?: string | null; tainted?: boolean } = {}): Caller =>
  ({ principal: id, owner: o.owner ?? null, sandbox: null, grants: [], tainted: o.tainted ?? false });

/** Poll `f` until `ok` holds, within a wall-clock budget (alarms run for real in the pool). */
async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000, what = "condition"): Promise<T> {
  const end = Date.now() + ms;
  let v = await f();
  while (!ok(v)) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 800)}`);
    await sleep(50);
    v = await f();
  }
  return v;
}

/** A DO call that should fail, as a promise (an RPC rejection left bare fails the run; LESSONS). */
const attempt = (f: () => unknown) => Promise.resolve().then(async () => {
  await f();
});

const batchTurns = async (agent: string) => (await agentStub(agent).turns()).filter((t) => t.input.kind === "event_batch");

/** A workstream and a hand-less agent that never starts (its turns just queue). */
/** A hand-less template with the channel tools (`read` among them), made once per file. */
let readerTemplate: Promise<string> | null = null;
function reader(): Promise<string> {
  readerTemplate ??= (async () => {
    const name = uniq("reader");
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT",
      body: {
        capabilities: ["nest", "channels", "messaging-tree"], launch: { builtin_tools: [], system_prompt: { mode: "replace", text: "Read." } },
        hands: "optional", credential: "claude_oauth_token", escalate_to: "user",
      },
    });
    return name;
  })();
  return readerTemplate;
}

/** A workstream and a hand-less agent that never starts (its turns just queue); by default it can `read`. */
async function idleAgent(o: { cell?: string; workstream?: string; owner?: string; template?: string } = {}) {
  const cell = o.cell ?? uniqueCell();
  const workstream = o.workstream ?? (await adminJson("/v1/workstreams", { body: { goal: "channels" } }, 201)).workstream;
  const template = o.template ?? (await reader());
  const a = await adminJson("/v1/agents", { body: { template, workstream, cell, start: false, ...(o.owner ? { owner: o.owner } : {}) } }, 201);
  return { cell, workstream: workstream as string, agent: a.agent as string };
}

/** The wake notices queued for `agent` (several may share one coalesced turn). */
const notices = async (agent: string) => (await batchTurns(agent)).flatMap((t) => t.input.text.split(/\n\n(?=\[nest\] Channel)/));

async function newChannel(retention_days?: number): Promise<string> {
  const name = `team/${uniq("c")}`;
  await adminJson("/v1/admin/channels", { body: { name, ...(retention_days ? { retention_days } : {}) } }, 201);
  return name;
}

const postAs = (name: string, body: unknown, status?: number) => adminJson(`/v1/admin/channels/${enc(name)}/messages`, { body }, status);
const readAs = (name: string, q = "") => adminJson(`/v1/admin/channels/${enc(name)}/messages${q}`);

/** Force a channel's fan-out now (the batch window or a retry backoff elapsed). */
async function fanoutNow(name: string): Promise<void> {
  await runInDurableObject(chStub(name), (_i: ChannelDO, st) => {
    for (const r of st.storage.sql.exec<{ id: string; body: string }>("SELECT id, body FROM subs").toArray()) {
      const s = JSON.parse(r.body);
      if (s.due_ms !== null) st.storage.sql.exec("UPDATE subs SET body = ? WHERE id = ?", JSON.stringify({ ...s, due_ms: 0 }), r.id);
    }
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('fanout', 0)");
  });
  await runDurableObjectAlarm(chStub(name));
}

describe("ChannelDO: the log", () => {
  it("assigns dense seqs in order and pages with since and limit", async () => {
    const name = await newChannel();
    for (let i = 1; i <= 7; i++) expect((await postAs(name, { text: `m${i}` }, 201)).seq).toBe(i);
    const p1 = await readAs(name, "?limit=3");
    expect(p1.messages.map((m: any) => m.text)).toEqual(["m1", "m2", "m3"]);
    expect(p1).toMatchObject({ head: 7, next_seq: 3, more: true });
    const p2 = await readAs(name, `?since=${p1.next_seq}&limit=10`);
    expect(p2.messages.map((m: any) => m.seq)).toEqual([4, 5, 6, 7]);
    expect(p2.more).toBe(false);
    // `from` and `taint` are the platform's: the operator is `user`, untainted.
    expect(p2.messages[0]).toMatchObject({ from: "user", taint: false });
  });

  it("refuses from/taint in a body, reserved names, built-in creates, and unknown free channels", async () => {
    const name = await newChannel();
    expect((await postAs(name, { text: "x", from: "agt_spoof" }, 400)).error.code).toBe("invalid_message");
    expect((await postAs(name, { text: "x", taint: false }, 400)).error.code).toBe("invalid_message");
    expect((await adminJson("/v1/admin/channels", { body: { name: "ws_1/x" } }, 400)).error.message).toMatch(/reserved/);
    expect((await adminJson("/v1/admin/channels", { body: { name: "user" } }, 409)).error.message).toMatch(/built-in/);
    expect((await postAs(`team/${uniq("nope")}`, { text: "x" }, 404)).error.message).toMatch(/no channel/);
    // An agent's built-in channel exists only with its agent.
    expect((await admin(`/v1/admin/channels/${enc("agt_0000nobody/inbox")}/messages`)).status).toBe(404);
  });

  it("idempotency keys land once; an identical repeat within a minute isn't stored", async () => {
    const name = await newChannel();
    expect(await postAs(name, { text: "a", idem_key: "k1" }, 201)).toEqual({ status: "posted", seq: 1 });
    expect(await postAs(name, { text: "a", idem_key: "k1" }, 200)).toEqual({ status: "existing", seq: 1 });
    expect(await postAs(name, { text: "b" }, 201)).toEqual({ status: "posted", seq: 2 });
    expect(await postAs(name, { text: "b" }, 200)).toEqual({ status: "repeat", seq: 2 });
    expect((await readAs(name)).head).toBe(2);
  });

  it("keyed view: newest per key, prefix, keys_only, compare-and-set, and removal by an empty keyed post", async () => {
    const name = await newChannel();
    expect((await postAs(name, { text: "claimed by a", key: "task/1", if_seq: 0 }, 201)).seq).toBe(1);
    // A second claim at the same version loses, with the current seq.
    expect(await postAs(name, { text: "claimed by b", key: "task/1", if_seq: 0 }, 409)).toEqual({ status: "conflict", key: "task/1", current_seq: 1 });
    expect((await postAs(name, { text: "done", key: "task/1", if_seq: 1 }, 201)).seq).toBe(2);
    await postAs(name, { text: "spec v1", key: "spec" }, 201);
    await postAs(name, { text: "t2", key: "task/2" }, 201);
    const view = await readAs(name, "?latest_by_key=true");
    expect(view.messages.map((m: any) => [m.key, m.text])).toEqual([["spec", "spec v1"], ["task/1", "done"], ["task/2", "t2"]]);
    const tasks = await readAs(name, "?latest_by_key=true&prefix=task/&keys_only=true");
    expect(tasks.keys).toEqual([{ key: "task/1", seq: 2, taint: false }, { key: "task/2", seq: 4, taint: false }]);
    // Removal: the key leaves the view; the log keeps the post.
    expect((await postAs(name, { text: "", key: "task/1" }, 201)).seq).toBe(5);
    expect((await readAs(name, "?latest_by_key=true&keys_only=true")).keys.map((k: any) => k.key)).toEqual(["spec", "task/2"]);
    expect((await readAs(name, "?since=4")).messages).toMatchObject([{ seq: 5, key: "task/1", text: "" }]);
    // A removed key is absent again: if_seq 0 claims it.
    expect((await postAs(name, { text: "reclaimed", key: "task/1", if_seq: 0 }, 201)).seq).toBe(6);
    // A keys page continues after `after_key`.
    expect((await readAs(name, "?latest_by_key=true&keys_only=true&limit=1&after_key=spec")).keys.map((k: any) => k.key)).toEqual(["task/1"]);
  });

  it("keeps bodies over 32 KiB in R2 and reads them back; refuses bodies over 1 MiB", async () => {
    const name = await newChannel();
    const big = "x".repeat(40 * 1024);
    await postAs(name, { text: big, data: { n: 1 } }, 201);
    const listed = await env.BUCKET.list({ prefix: `channels/${name}/b/` });
    expect(listed.objects.length).toBe(1);
    const read = await readAs(name);
    expect(read.messages[0].text.length).toBe(big.length);
    expect(read.messages[0].data).toEqual({ n: 1 });
    expect((await postAs(name, { text: "y".repeat(1024 * 1024 + 1) }, 400)).error.message).toMatch(/at most/);
    // Both stored inline rows and the R2 row stay ordered.
    await postAs(name, { text: "small" }, 201);
    expect((await readAs(name, "?since=1")).messages[0]).toMatchObject({ seq: 2, text: "small" });
  });

  it("retention drops old messages but keeps the newest per key, and tiers week-old bodies to R2", async () => {
    const name = await newChannel(1);
    await postAs(name, { text: "old", key: "k" }, 201);
    await postAs(name, { text: "old unkeyed" }, 201);
    await postAs(name, { text: "older version", key: "j" }, 201);
    await postAs(name, { text: "newer version", key: "j" }, 201);
    await postAs(name, { text: "fresh" }, 201);
    await runInDurableObject(chStub(name), (_i: ChannelDO, st) => {
      st.storage.sql.exec("UPDATE messages SET ts_ms = ? WHERE seq <= 4", Date.now() - 2 * 86_400_000);
    });
    await chStub(name).maintain(name);
    const left = (await readAs(name)).messages.map((m: any) => [m.seq, m.text]);
    // 1 (newest for k) and 4 (newest for j) stay; 2 (unkeyed) and 3 (superseded) go; 5 is fresh.
    expect(left).toEqual([[1, "old"], [4, "newer version"], [5, "fresh"]]);

    // Tiering: a body older than 7 days (a channel with longer retention) moves to R2, read transparently.
    const t = await newChannel(30);
    await postAs(t, { text: "tier me", data: { a: [1] } }, 201);
    await runInDurableObject(chStub(t), (_i: ChannelDO, st) => {
      st.storage.sql.exec("UPDATE messages SET ts_ms = ? WHERE seq = 1", Date.now() - 8 * 86_400_000);
    });
    await chStub(t).maintain(t);
    const row = await runInDurableObject(chStub(t), (_i: ChannelDO, st) =>
      st.storage.sql.exec<{ text: string | null; body_ref: string | null }>("SELECT text, body_ref FROM messages WHERE seq = 1").one());
    expect(row.text).toBeNull();
    expect(row.body_ref).toMatch(new RegExp(`^channels/${t}/b/`));
    expect((await readAs(t)).messages[0]).toMatchObject({ text: "tier me", data: { a: [1] } });
  });

  it("lists channels in the directory once registered", async () => {
    const name = await newChannel();
    await until(async () => (await adminJson(`/v1/admin/channels?prefix=${enc(name)}`)).channels, (c: any[]) => c.length === 1, 10_000, "registration");
    expect((await adminJson(`/v1/admin/channels/${enc(name)}`))).toMatchObject({ name, kind: "free", owner: "user", head: 0 });
  });
});

describe("subscriptions", () => {
  it("a burst of posts wakes a subscribed agent once per batch window, with a notice and not the bodies", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    const sub = await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 400 } }, 201);
    expect(sub).toMatchObject({ agent, delivery: "turn", cursor: 0 });
    await postAs(name, { text: "secret body one", kind: "progress" }, 201);
    await postAs(name, { text: "secret body two", kind: "question" }, 201);
    await postAs(name, { text: "secret body three" }, 201);
    const turns = await until(() => batchTurns(agent), (t) => t.length >= 1, 10_000, "a wake");
    await sleep(600);
    expect((await batchTurns(agent)).length).toBe(1);
    const text = turns[0]!.input.text;
    expect(text).toContain(`Channel ${name}: 3 new messages (seq 1-3)`);
    expect(text).toContain("kinds progress, question");
    // Bodies reach the model only through `read`; `user`'s arrive inline (the operator is `user`).
    expect(text).toContain("Message from user (seq 1): secret body one");
    // A later post is a new window.
    await postAs(name, { text: "four" }, 201);
    // The first turn hasn't started (no brain): the second notice joins it rather than queue another.
    const both = await until(() => notices(agent), (n) => n.length === 2, 10_000, "a second notice");
    expect(both[1]).toContain("1 new message (seq 4)");
    expect((await batchTurns(agent)).length).toBe(1);
    expect((await chStub(name).subscriptions(name)).find((s) => s.id === sub.id)).toMatchObject({ cursor: 4, inflight: null });
    expect((await adminJson(`/v1/agents/${agent}/subscriptions`))).toEqual([{ channel: name, subscription: sub.id, hw: 4, ended: false, skipped: 0, skipped_to: null }]);
  });

  it("delivers once even when the channel crashes after the agent took the batch, and retries", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    const sub = await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    // The settle after a delivery fails (as if the object were reset between the agent's ack and the cursor's move).
    await runInDurableObject(chStub(name), (inst: ChannelDO) => {
      inst.testHooks["fanout:afterDeliver"] = async () => {
        delete inst.testHooks["fanout:afterDeliver"];
        throw new Error("reset after the agent took the batch");
      };
    });
    await postAs(name, { text: "one" }, 201);
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(1);
    // The batch is still pinned: the retry carries the same range.
    const pinned = (await chStub(name).subscriptions(name)).find((s) => s.id === sub.id)!;
    expect(pinned).toMatchObject({ cursor: 0, inflight: { after_seq: 0, to_seq: 2 } });
    // A post meanwhile doesn't widen the pinned batch.
    await postAs(name, { text: "three" }, 201);
    await fanoutNow(name);
    const after = (await chStub(name).subscriptions(name)).find((s) => s.id === sub.id)!;
    expect(after).toMatchObject({ cursor: 2, inflight: null });
    expect((await batchTurns(agent)).length).toBe(1);
    // ...and the next window delivers what came after, once.
    await fanoutNow(name);
    await fanoutNow(name);
    const ns = await notices(agent);
    expect(ns.length).toBe(2);
    expect(ns[1]).toContain("1 new message (seq 3)");
  });

  it("a retry of a batch the agent already holds is acknowledged even at its wake cap (dedup before the loop guards)", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    const sub = await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    await runInDurableObject(chStub(name), (inst: ChannelDO) => {
      inst.testHooks["fanout:afterDeliver"] = async () => {
        delete inst.testHooks["fanout:afterDeliver"];
        throw new Error("reset after the agent took the batch");
      };
    });
    await postAs(name, { text: "one" }, 201);
    await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(1);
    // Now the agent is at its cap: the retry must still settle as taken, never be re-planned wider.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      for (let i = 0; i < 60; i++) {
        st.storage.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms, request_id) VALUES (?, ?, ?, 'done', ?, ?)",
          `trn_cap${i}`, -100 - i, JSON.stringify({ kind: "event_batch", text: "x" }), Date.now() - 1000, `chan/other/sub_x/${i}`);
      }
    });
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    expect((await chStub(name).subscriptions(name)).find((x) => x.id === sub.id)).toMatchObject({ cursor: 1, inflight: null });
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("UPDATE turns SET created_ms = ? WHERE request_id LIKE 'chan/other/%'", Date.now() - 2 * 3_600_000);
    });
    await fanoutNow(name);
    const turns = await batchTurns(agent);
    expect(turns.filter((t) => t.input.text.includes("(seq 1)")).length).toBe(1);
    expect(turns.at(-1)!.input.text).toContain("1 new message (seq 2)");
  });

  it("a failed delivery call keeps the batch pinned and is retried with backoff", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    // Fails twice (a single failure can hide a retry that only works once).
    await runInDurableObject(chStub(name), (inst: ChannelDO) => {
      let left = 2;
      inst.testHooks["fanout:beforeDeliver"] = async () => {
        if (--left === 0) delete inst.testHooks["fanout:beforeDeliver"];
        throw new Error("network");
      };
    });
    await postAs(name, { text: "one" }, 201);
    await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(0);
    const s = (await chStub(name).subscriptions(name))[0]!;
    expect(s).toMatchObject({ attempts: 1, inflight: { to_seq: 1 } });
    expect(s.due_ms! - Date.now()).toBeGreaterThan(0);
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    // Still the same pinned range after the second failure, backing off further.
    expect((await chStub(name).subscriptions(name))[0]).toMatchObject({ attempts: 2, inflight: { after_seq: 0, to_seq: 1 } });
    expect((await batchTurns(agent)).length).toBe(0);
    await fanoutNow(name);
    expect((await notices(agent))[0]).toContain("1 new message (seq 1)");
    expect((await chStub(name).subscriptions(name))[0]).toMatchObject({ attempts: 0, cursor: 1, inflight: null });
  });

  it("the agent's own posts never wake it; filters select; a once subscription ends at its first match", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: agent, action: "post" }, { principal: agent, action: "read" }] });
    await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    const asked = await chStub(name).post(name, asAgent(agent), { text: "a question", kind: "question" });
    expect(asked).toMatchObject({ status: "posted", seq: 1 });
    await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(0);
    // A once subscription to replies to seq 1.
    const once = await chStub(name).subscribe(name, asAgent(agent), agent, { filter: { reply_to: 1 }, delivery: "turn", batch_ms: 60_000, once: true });
    await postAs(name, { text: "unrelated" }, 201);
    await postAs(name, { text: "the answer", reply_to: 1 }, 201);
    // A second reply in the same window: the once subscription still takes only the first.
    await postAs(name, { text: "a second answer", reply_to: 1 }, 201);
    await fanoutNow(name);
    await fanoutNow(name);
    const subs = await chStub(name).subscriptions(name);
    expect(subs.some((s) => s.id === once.id)).toBe(false);
    const ns = await notices(agent);
    // One for the catch-all subscription (seq 2-4), one for the once subscription (seq 3 only), ended:
    // two notices, coalesced into the one waiting turn.
    expect(ns.length).toBe(2);
    expect((await batchTurns(agent)).length).toBe(1);
    expect(ns.filter((t) => t.includes("1 new message (seq 3)") && t.includes(`Subscription ${once.id} ended`)).length).toBe(1);
    // Nothing but the once subscription's first match: a later reply isn't delivered by it.
    await postAs(name, { text: "another answer", reply_to: 1 }, 201);
    await fanoutNow(name);
    await fanoutNow(name);
    expect((await notices(agent)).filter((t) => t.includes("ended")).length).toBe(1);
  });

  it("none delivery only keeps a cursor, which a read without since moves (the same page on a re-run)", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: agent, action: "read" }] });
    const s = await chStub(name).subscribe(name, asAgent(agent), agent, { filter: {}, delivery: "none", batch_ms: 0, once: false });
    await postAs(name, { text: "one" }, 201);
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    expect((await agentStub(agent).turns()).length).toBe(0);
    const r1 = await chStub(name).read(name, asAgent(agent), { idem_key: "call-1" }) as any;
    expect(r1.messages.map((m: any) => m.text)).toEqual(["one", "two"]);
    expect(r1.cursor).toBe(s.id);
    // A re-run of the same call reads the same page; a new call reads what's new.
    expect(((await chStub(name).read(name, asAgent(agent), { idem_key: "call-1" })) as any).messages.length).toBe(2);
    expect(((await chStub(name).read(name, asAgent(agent), { idem_key: "call-2" })) as any).messages.length).toBe(0);
    await postAs(name, { text: "three" }, 201);
    expect(((await chStub(name).read(name, asAgent(agent), { idem_key: "call-3" })) as any).messages.map((m: any) => m.text)).toEqual(["three"]);
    expect((await chStub(name).subscriptions(name)).find((x) => x.id === s.id)).toMatchObject({ cursor: 3, due_ms: null });
  });

  it("a subscription whose agent doesn't exist is dropped, not retried for ever", async () => {
    const name = await newChannel();
    await chStub(name).subscribe(name, { principal: "user" }, "agt_0000ghost", { filter: {}, delivery: "turn", batch_ms: 0, once: false });
    await postAs(name, { text: "x" }, 201);
    await fanoutNow(name);
    // The runtime's own alarm may be the one that runs it.
    await until(() => chStub(name).subscriptions(name), (s) => s.length === 0, 10_000, "the ghost subscription dropped");
  });

  it("the agent's loop guards defer a delivery: the channel keeps it, coalesces, and retries", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    // 60 subscription-started turns this hour already.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      for (let i = 0; i < 60; i++) {
        st.storage.sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms, request_id) VALUES (?, ?, ?, 'done', ?, ?)",
          `trn_cap${i}`, -100 - i, JSON.stringify({ kind: "event_batch", text: "x" }), Date.now() - 1000, `chan/other/sub_x/${i}`);
      }
    });
    await postAs(name, { text: "one" }, 201);
    await fanoutNow(name);
    await postAs(name, { text: "two" }, 201);
    const s = (await chStub(name).subscriptions(name))[0]!;
    expect(s).toMatchObject({ cursor: 0, inflight: null });
    expect(s.due_ms! - Date.now()).toBeGreaterThan(30 * 60_000);
    // Once the hour has passed: one wake covering both.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("UPDATE turns SET created_ms = ? WHERE request_id LIKE 'chan/other/%'", Date.now() - 2 * 3_600_000);
    });
    await fanoutNow(name);
    const turns = (await batchTurns(agent)).filter((t) => t.status === "queued");
    expect(turns.length).toBe(1);
    expect(turns[0]!.input.text).toContain("2 new messages (seq 1-2)");
  });
});

describe("permissions (server side)", () => {
  it("an agent can't read another's inbox, post to events, subscribe others, or unsubscribe someone else", async () => {
    const a = await idleAgent();
    const b = await idleAgent({ cell: a.cell, workstream: a.workstream });
    const inbox = `${b.agent}/inbox`;
    await expect(attempt(() => chStub(inbox).read(inbox, asAgent(a.agent), {}, { agent_owner: null }))).rejects.toThrow(/may not read/);
    await expect(attempt(() => chStub(inbox).post(inbox, asAgent(a.agent), { text: "hi" }, { agent_owner: null }))).rejects.toThrow(/may not post/);
    const events = `${a.agent}/events`;
    await expect(attempt(() => chStub(events).post(events, asAgent(a.agent), { text: "turn_completed" }))).rejects.toThrow(/platform only/);
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: a.agent, action: "read" }, { principal: b.agent, action: "read" }] });
    await expect(attempt(() => chStub(name).subscribe(name, asAgent(a.agent), b.agent, { filter: {}, delivery: "turn", batch_ms: 0, once: false })))
      .rejects.toThrow(/only itself/);
    const sb = await chStub(name).subscribe(name, asAgent(b.agent), b.agent, { filter: {}, delivery: "turn", batch_ms: 0, once: false });
    await expect(attempt(() => chStub(name).unsubscribe(name, asAgent(a.agent), sb.id))).rejects.toThrow(/not agt_/);
    // The always-on inbox subscription can't be dropped by its agent.
    await chStub(inbox).post(inbox, { principal: "user" }, { text: "hello" });
    await expect(attempt(() => chStub(inbox).unsubscribe(inbox, asAgent(b.agent), "sub_inbox"))).rejects.toThrow(/always subscribed/);
    // A revoked grant is refused at once.
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [] });
    await expect(attempt(() => chStub(name).read(name, asAgent(a.agent), {}))).rejects.toThrow(/may not read/);
  });

  it("a big post re-checks its permission after the R2 put", async () => {
    const a = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: a.agent, action: "post" }] });
    await runInDurableObject(chStub(name), (inst: ChannelDO, st) => {
      inst.testHooks["post:afterPut"] = async () => {
        delete inst.testHooks["post:afterPut"];
        st.storage.sql.exec("DELETE FROM acl");
      };
    });
    await expect(attempt(() => chStub(name).post(name, asAgent(a.agent), { text: "z".repeat(40 * 1024) }))).rejects.toThrow(/may not post/);
    expect((await readAs(name)).head).toBe(0);
  });
});

describe("built-in channels", () => {
  it("an operator post to an agent's inbox wakes it, with the user's text inline", async () => {
    const { agent } = await idleAgent();
    await postAs(`${agent}/inbox`, { text: "please look at PR 7" }, 201);
    const turns = await until(() => batchTurns(agent), (t) => t.length === 1, 10_000, "an inbox wake");
    expect(turns[0]!.input.text).toContain(`Channel ${agent}/inbox: 1 new message`);
    expect(turns[0]!.input.text).toContain("Message from user (seq 1): please look at PR 7");
  });

  it("a sandbox's events record its placement, ports and destruction", async () => {
    const cell = uniqueCell();
    const host = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "sbx events" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(host.ws, (c) => c.type === "sandbox_create");
    await adminJson(`/v1/sandboxes/${sbx.sandbox}`, { method: "DELETE" });
    const name = `${sbx.sandbox}/events`;
    const msgs = await until(async () => (await readAs(name)).messages as any[], (m) => m.some((x) => x.kind === "destroyed"), 10_000, "sandbox events");
    expect(msgs.map((m) => m.kind)).toEqual(expect.arrayContaining(["moved", "destroyed"]));
    expect(msgs.every((m) => m.from === "platform" && m.taint === false)).toBe(true);
  });

  it("an agent's events carry its turns, brain releases and its stop; its spawner (which can read) is subscribed by default", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-test" } });
    const brain = await connectHost(cell, "brain");
    const spawner = await idleAgent({ cell });
    const child = await adminJson("/v1/agents", { body: { template: "captain", workstream: spawner.workstream, cell, owner: spawner.agent } }, 201);
    const [start] = await nextCommands(brain.ws, (c) => c.type === "agent_start" && c.agent === child.agent);
    const ws = await Ws.connect(`/v1/agents/${child.agent}/session`, brain.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: child.agent, host: brain.host, instance_id: "rin_ev", epoch: start.epoch, session: SESSION });
    await ws.next("hello_ack");
    const t = (await adminJson(`/v1/agents/${child.agent}/turns`, { body: { text: "work" } }, 201)).turn;
    await ws.next("run_turn");
    const ev = (seq: number, body: Record<string, unknown>) => ({ agent: child.agent, epoch: start.epoch, seq, ts_ms: Date.now(), turn: t, ...body });
    ws.send({ type: "events", seq: 1, events: [
      ev(1, { type: "turn_started", input_kind: "user" }),
      ev(2, { type: "state_changed", state: "working" }),
      ev(3, { type: "assistant_text", text: "All done: PR opened." }),
      ev(4, { type: "turn_completed", stop_reason: "end_turn" }),
    ] });
    await ws.next("ack", (m) => m.up_to === 1);
    // A resent batch (an eviction) doesn't post twice.
    const name = `${child.agent}/events`;
    const msgs = await until(async () => (await readAs(name)).messages as any[], (m) => m.some((x) => x.kind === "turn_completed"), 10_000, "child events");
    expect(msgs.map((m) => m.kind)).toEqual(["state_changed", "turn_completed"]);
    expect(msgs[1]).toMatchObject({ from: "platform", text: "All done: PR opened.", data: { turn: t, stop_reason: "end_turn" } });
    // The spawner is woken with a notice about its child's results.
    const wakes = await until(() => batchTurns(spawner.agent), (x) => x.length === 1, 10_000, "the spawner's wake");
    expect(wakes[0]!.input.text).toContain(`Channel ${name}: 1 new message`);
    expect(wakes[0]!.input.text).toContain("kinds turn_completed");
    expect((await chStub(name).subscriptions(name)).map((s) => s.agent)).toEqual([spawner.agent]);
    // The spawner may read its child's events; a stranger may not.
    expect(((await chStub(name).read(name, asAgent(spawner.agent), {}, { agent_owner: spawner.agent })) as any).messages.length).toBe(2);
    const stranger = await idleAgent({ cell });
    await expect(attempt(() => chStub(name).read(name, asAgent(stranger.agent), {}, { agent_owner: spawner.agent }))).rejects.toThrow(/may not read/);
    // An idle exit is a brain release, not the agent ending: reported apart, outside the spawner's filter.
    ws.close();
    await agentStub(child.agent).onExited(brain.host, "idle", start.epoch);
    const released = await until(async () => (await readAs(name)).messages as any[], (m) => m.some((x) => x.kind === "brain_released"), 10_000, "the release");
    expect(released.find((m) => m.kind === "brain_released")).toMatchObject({ text: "brain released (idle)", taint: false, data: { reason: "idle" } });
    expect(released.some((m) => m.kind === "exited")).toBe(false);
    // A later turn with no text of its own doesn't repeat the previous one's.
    const t2 = (await adminJson(`/v1/agents/${child.agent}/turns`, { body: { text: "more" } }, 201)).turn;
    const restart = (await nextCommands(brain.ws, (c) => c.type === "agent_start" && c.agent === child.agent && c.epoch > start.epoch))[0];
    const ws2 = await Ws.connect(`/v1/agents/${child.agent}/session`, brain.host_token);
    ws2.send({ type: "hello", protocol_version: 1, agent: child.agent, host: brain.host, instance_id: "rin_ev2", epoch: restart.epoch, session: SESSION });
    await ws2.next("hello_ack");
    await ws2.next("run_turn", (m) => m.turn === t2);
    const ev2 = (seq: number, body: Record<string, unknown>) => ({ agent: child.agent, epoch: restart.epoch, seq, ts_ms: Date.now(), turn: t2, ...body });
    ws2.send({ type: "events", seq: 1, events: [ev2(1, { type: "turn_started", input_kind: "user" }), ev2(2, { type: "turn_completed", stop_reason: "end_turn" })] });
    await ws2.next("ack", (m) => m.up_to === 1);
    const all = await until(async () => (await readAs(name)).messages as any[], (m) => m.filter((x) => x.kind === "turn_completed").length === 2, 10_000, "the second turn");
    expect(all.filter((m) => m.kind === "turn_completed")[1].text).toBe(`turn ${t2} completed (end_turn)`);
    // A stop is the agent ending: `exited`, which wakes the spawner.
    ws2.close();
    await agentStub(child.agent).onExited(brain.host, "stopped", restart.epoch);
    const end = await until(async () => (await readAs(name)).messages as any[], (m) => m.some((x) => x.kind === "exited"), 10_000, "the stop");
    expect(end.find((m) => m.kind === "exited")).toMatchObject({ data: { reason: "stopped", epoch: restart.epoch } });
    const spawnerNotices = await until(() => notices(spawner.agent), (n) => n.some((x) => x.includes("kinds exited")), 10_000, "the spawner's notice of the stop");
    expect(spawnerNotices.some((x) => x.includes("brain_released"))).toBe(false);
  });

  it("deploy changes nothing for an owner that can't read: no default subscription, and no notice it couldn't act on", async () => {
    const owner = await idleAgent({ template: "captain" });
    const child = await idleAgent({ cell: owner.cell, workstream: owner.workstream, owner: owner.agent });
    const name = `${child.agent}/events`;
    // The child's outbox posts an event (as its runner's events would), naming its owner.
    await runInDurableObject(agentStub(child.agent), (inst: AgentDO) => {
      (inst as any).outbox.push(name, { kind: "turn_completed", text: "done" }, { tainted: false, agent_owner: owner.agent });
    });
    await until(async () => (await readAs(name)).head, (h) => h === 1, 10_000, "the event posted");
    expect(await chStub(name).subscriptions(name)).toEqual([]);
    // Even subscribed by the operator, it is woken only by what arrives inline (the user's own text).
    const team = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(team)}/subscriptions`, { body: { agent: owner.agent, batch_ms: 60_000 } }, 201);
    await chStub(team).post(team, { principal: "platform" }, { text: "an event" });
    await fanoutNow(team);
    expect((await batchTurns(owner.agent)).length).toBe(0);
    expect((await chStub(team).subscriptions(team))[0]).toMatchObject({ cursor: 1, inflight: null });
    await postAs(team, { text: "from the operator" }, 201);
    await fanoutNow(team);
    const ns = await notices(owner.agent);
    expect(ns.length).toBe(1);
    expect(ns[0]).toContain("Message from user (seq 2): from the operator");
  });

  it("a channel notice sent mid-turn that the runner never confirmed comes back as a turn", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-test" } });
    const brain = await connectHost(cell, "brain");
    const a = await idleAgent({ cell });
    await agentStub(a.agent).start();
    const [start] = await nextCommands(brain.ws, (c) => c.type === "agent_start" && c.agent === a.agent);
    const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, brain.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: brain.host, instance_id: "rin_lost", epoch: start.epoch, session: SESSION });
    await ws.next("hello_ack");
    const t = (await adminJson(`/v1/agents/${a.agent}/turns`, { body: { text: "work" } }, 201)).turn;
    await ws.next("run_turn");
    await postAs(`${a.agent}/inbox`, { text: "while you work" }, 201);
    const inbox = await ws.next("inbox", () => true, 10_000);
    // The runner was stopping: it never wrote the notice to the model (no inbox_delivered), and the turn ends.
    const ev = (seq: number, body: Record<string, unknown>) => ({ agent: a.agent, epoch: start.epoch, seq, ts_ms: Date.now(), turn: t, ...body });
    ws.send({ type: "events", seq: 1, events: [ev(1, { type: "turn_started", input_kind: "user" }), ev(2, { type: "turn_completed", stop_reason: "end_turn" })] });
    await ws.next("ack", (m) => m.up_to === 1);
    const next = await ws.next("run_turn", () => true, 10_000);
    expect(next.input.kind).toBe("event_batch");
    expect(next.input.text).toBe(inbox.message.text);
    ws.close();
  });
});

describe("channel tools through the dispatch path", () => {
  async function setup(launch: { builtin_tools: string[] } = { builtin_tools: [] }) {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-test" } });
    const brain = await connectHost(cell, "brain");
    const tpl = uniq("chan");
    await adminJson(`/v1/admin/templates/${tpl}`, {
      method: "PUT",
      body: {
        capabilities: ["nest", "channels", "messaging-tree", "messaging", "transcripts"], launch: { ...launch, system_prompt: { mode: "replace", text: "Talk." } },
        hands: "optional", credential: "claude_oauth_token", escalate_to: "user",
      },
    });
    const owner = await idleAgent({ cell });
    const a = await adminJson("/v1/agents", { body: { template: tpl, workstream: owner.workstream, cell, owner: owner.agent } }, 201);
    const [start] = await nextCommands(brain.ws, (c) => c.type === "agent_start" && c.agent === a.agent);
    const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, brain.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: brain.host, instance_id: "rin_tools", epoch: start.epoch, session: SESSION });
    await ws.next("hello_ack");
    let seq = 0;
    const call = async (name: string, args: unknown) => {
      const id = `cal_${uniq("t").replace(/-/g, "")}`;
      ws.send({ type: "tool_call", seq: ++seq, call: id, turn: "trn_x", name, arguments: args });
      return (await ws.next("tool_result", (m) => m.call === id)).outcome;
    };
    const value = (o: any) => o.content.find((c: any) => c.type === "json").value;
    return { cell, brain, owner, agent: a.agent as string, ws, call, value, start, nextSeq: () => ++seq };
  }

  it("lists the channel tools and runs them: create, post, read, keyed CAS, subscribe, unsubscribe, message", async () => {
    const s = await setup();
    s.ws.send({ type: "tools_list_request", request: "req_c" });
    expect((await s.ws.next("tools_list")).tools.map((t: any) => t.name)).toEqual(["notify", "ask", "read_transcript", "channel_create", "post", "read", "subscribe", "unsubscribe", "message"]);
    const name = `team/${uniq("t")}`;
    expect((await s.call("channel_create", { channel: name })).status).toBe("ok");
    expect(s.value(await s.call("post", { channel: name, text: "hello", kind: "progress", data: { from: "user", taint: false } }))).toEqual({ status: "posted", seq: 1 });
    // `from` and `taint` are the platform's, whatever the data says; this agent's session is clean.
    const read = s.value(await s.call("read", { channel: name }));
    expect(read.messages[0]).toMatchObject({ from: s.agent, taint: false, kind: "progress", data: { from: "user", taint: false } });
    // Spoofing as an argument is refused before anything runs.
    expect((await s.call("post", { channel: name, text: "x", from: "user" })).error.code).toBe("invalid_message");
    // Keyed compare-and-set.
    expect(s.value(await s.call("post", { channel: name, text: "mine", key: "claim/1", if_seq: 0 })).seq).toBe(2);
    const lost = await s.call("post", { channel: name, text: "mine too", key: "claim/1", if_seq: 0 });
    expect(lost.error.message).toMatch(/conflict: key claim\/1 is at seq 2/);
    expect(s.value(await s.call("read", { channel: name, latest_by_key: true, keys_only: true })).keys).toEqual([{ key: "claim/1", seq: 2, taint: false }]);
    // Subscribe, then a post from the operator wakes it; unsubscribe stops that.
    const sub = s.value(await s.call("subscribe", { channel: name, batch_ms: 0, kinds: ["review"] }));
    expect(sub).toMatchObject({ cursor: 2, delivery: "turn" });
    expect(await adminJson(`/v1/agents/${s.agent}/subscriptions`)).toEqual([{ channel: name, subscription: sub.subscription, hw: 0, ended: false, skipped: 0, skipped_to: null }]);
    expect(s.value(await s.call("unsubscribe", { channel: name, subscription: sub.subscription }))).toEqual({ removed: true });
    expect(await chStub(name).subscriptions(name)).toEqual([]);
    // `message`: its owner yes, a stranger no.
    const m = await s.call("message", { agent: s.owner.agent, text: "status: green", kind: "result" });
    expect(m.status).toBe("ok");
    const ownerInbox = await readAs(`${s.owner.agent}/inbox`);
    expect(ownerInbox.messages[0]).toMatchObject({ from: s.agent, text: "status: green", kind: "result" });
    await until(() => batchTurns(s.owner.agent), (t) => t.length === 1, 10_000, "the owner's wake");
    const stranger = await idleAgent({ cell: s.cell });
    expect((await s.call("message", { agent: stranger.agent, text: "hi" })).error.code).toBe("forbidden");
    // A child that can't `read` is refused, and nothing is posted to its inbox.
    const blind = await adminJson("/v1/agents", { body: { template: "captain", workstream: s.owner.workstream, cell: s.cell, owner: s.agent, start: false } }, 201);
    const refused = await s.call("message", { agent: blind.agent, text: "you won't see this" });
    expect(refused.error.message).toMatch(/can't read channel messages/);
    expect((await readAs(`${blind.agent}/inbox`)).head).toBe(0);
    // Others' channels: can't read another's inbox; can't post to events; `user` is post-only.
    expect((await s.call("read", { channel: `${s.owner.agent}/inbox` })).error.code).toBe("forbidden");
    expect((await s.call("post", { channel: `${s.agent}/events`, text: "fake" })).error.code).toBe("forbidden");
    expect(s.value(await s.call("post", { channel: "user", text: "need a decision" })).status).toBe("posted");
    expect((await s.call("read", { channel: "user" })).error.code).toBe("forbidden");
    expect((await readAs("user", "?since=0")).messages.some((x: any) => x.from === s.agent && x.text === "need a decision")).toBe(true);
  });

  it("a redelivered call lands once; a mid-turn delivery joins the inbox stream", async () => {
    const s = await setup();
    const name = `team/${uniq("r")}`;
    await s.call("channel_create", { channel: name });
    // The same call id again (the runner resent it after a reconnect): the stored outcome, no second post.
    const id = "cal_redeliver1";
    s.ws.send({ type: "tool_call", seq: s.nextSeq(), call: id, turn: "trn_x", name: "post", arguments: { channel: name, text: "once" } });
    const first = await s.ws.next("tool_result", (m) => m.call === id);
    s.ws.send({ type: "tool_call", seq: s.nextSeq(), call: id, turn: "trn_x", name: "post", arguments: { channel: name, text: "once" } });
    const second = await s.ws.next("tool_result", (m) => m.call === id);
    expect(second.outcome).toEqual(first.outcome);
    expect((await readAs(name)).head).toBe(1);
    // Mid-turn: an inbox post reaches the brain as an inbox message (stdin and the Stop hook's mirror), not a turn.
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201);
    await s.ws.next("run_turn");
    await postAs(`${s.agent}/inbox`, { text: "ping mid-turn" }, 201);
    const inbox = await s.ws.next("inbox", () => true, 10_000);
    expect(inbox.message).toMatchObject({ from: "platform" });
    expect(inbox.message.text).toContain(`Channel ${s.agent}/inbox: 1 new message`);
    expect(inbox.message.text).toContain("ping mid-turn");
    expect((await batchTurns(s.agent)).length).toBe(0);
  });

  it("mid-turn, another channel's notice waits for the next turn instead of joining this one", async () => {
    const s = await setup();
    const name = `team/${uniq("mid")}`;
    await s.call("channel_create", { channel: name });
    s.value(await s.call("subscribe", { channel: name, batch_ms: 0 }));
    const t = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "work" } }, 201)).turn;
    await s.ws.next("run_turn");
    await postAs(name, { text: "review this" }, 201);
    await fanoutNow(name);
    // Not pushed into the running turn (where a busy model can pass over it): queued after it.
    expect(await s.ws.next("inbox", () => true, 500).catch(() => null)).toBeNull();
    expect((await batchTurns(s.agent)).map((x) => x.status)).toEqual(["queued"]);
    const ev = (seq: number, body: Record<string, unknown>) => ({ agent: s.agent, epoch: s.start.epoch, seq, ts_ms: Date.now(), turn: t, ...body });
    s.ws.send({ type: "events", seq: s.nextSeq(), events: [ev(1, { type: "turn_started", input_kind: "user" }), ev(2, { type: "turn_completed", stop_reason: "end_turn" })] });
    const next = await s.ws.next("run_turn", () => true, 10_000);
    expect(next.input.kind).toBe("event_batch");
    expect(next.input.text).toContain(`Channel ${name}: 1 new message (seq 1)`);
  });

  it("rule 1: a channel write re-checks the agent epoch after its awaits (a superseded brain posts nothing)", async () => {
    const s = await setup();
    const name = `team/${uniq("fence")}`;
    await s.call("channel_create", { channel: name });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        (inst as any).update((i: any) => {
          i.agent_epoch += 1;
          i.brain.epoch = i.agent_epoch;
        });
      };
    });
    const id = "cal_fenced1";
    s.ws.send({ type: "tool_call", seq: s.nextSeq(), call: id, turn: "trn_x", name: "post", arguments: { channel: name, text: "from a stale brain" } });
    const res = await s.ws.next("tool_result", (m) => m.call === id, 2000).catch(() => null);
    expect(res === null || res.outcome.status === "error").toBe(true);
    expect((await readAs(name)).head).toBe(0);
  });

  it("another agent's text reaching a session inline taints it: notify from a tainted agent, another agent's transcript", async () => {
    const web = await setup({ builtin_tools: ["WebSearch"] });
    const readTainted = (agent: string) => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'read_tainted'").toArray()[0]?.value === "true");
    expect(await readTainted(web.owner.agent)).toBe(false);
    expect((await web.call("notify", { to: "captain", message: "relay this" })).status).toBe("ok");
    expect(await readTainted(web.owner.agent)).toBe(true);
    // A clean agent reading another agent's transcript is tainted from then on.
    const clean = await setup();
    expect(await readTainted(clean.agent)).toBe(false);
    expect((await clean.call("read_transcript", { agent: clean.owner.agent })).status).toBe("ok");
    expect(await readTainted(clean.agent)).toBe(true);
  });

  it("a session that can see untrusted content posts tainted, and reading a tainted message taints a clean one", async () => {
    const web = await setup({ builtin_tools: ["WebSearch"] });
    const name = `team/${uniq("taint")}`;
    await web.call("channel_create", { channel: name });
    await web.call("post", { channel: name, text: "from the web" });
    expect((await readAs(name)).messages[0]).toMatchObject({ from: web.agent, taint: true });
    // A clean agent with read on it reads the tainted message: its own later posts are tainted.
    const clean = await setup();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: clean.agent, action: "read" }] });
    const mine = `team/${uniq("mine")}`;
    await clean.call("channel_create", { channel: mine });
    await clean.call("post", { channel: mine, text: "before" });
    expect(clean.value(await clean.call("read", { channel: name })).tainted).toBe(true);
    await clean.call("post", { channel: mine, text: "after" });
    expect((await readAs(mine)).messages.map((m: any) => m.taint)).toEqual([false, true]);
  });
});

describe("review fixes", () => {
  const kvTainted = (agent: string) => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
    st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'read_tainted'").toArray()[0]?.value === "true");

  it("deliveries to an agent whose turn hasn't started coalesce into that one turn (5 channels, 1 turn)", async () => {
    const { agent } = await idleAgent();
    const names: string[] = [];
    for (let i = 0; i < 5; i++) {
      const name = await newChannel();
      names.push(name);
      await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
      await postAs(name, { text: `news ${i}` }, 201);
    }
    for (const name of names) await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(1);
    const ns = await notices(agent);
    expect(ns.length).toBe(5);
    for (const name of names) expect(ns.some((n) => n.includes(`Channel ${name}:`))).toBe(true);
    // Each subscription was acknowledged (its cursor moved): nothing is redelivered.
    for (const name of names) expect((await chStub(name).subscriptions(name))[0]).toMatchObject({ cursor: 1, inflight: null });
  });

  // Over 2,400 R2 operations: well under a second alone, but its time grows with the machine's load.
  it("expiry deletes R2 bodies before their rows, at most 1000 keys a call, past 1000 at once", { timeout: 30_000 }, async () => {
    const name = await newChannel(1);
    const N = 1205;
    await runInDurableObject(chStub(name), async (_i: ChannelDO, st) => {
      const old = Date.now() - 3 * 86_400_000;
      const refs = Array.from({ length: N }, (_, i) => `channels/${name}/b/old${i + 1}`);
      for (let i = 0; i < N; i += 100) {
        await Promise.all(refs.slice(i, i + 100).map((ref, j) => env.BUCKET.put(ref, JSON.stringify({ text: `t${i + j + 1}`, data: null }))));
      }
      for (let seq = 1; seq <= N; seq++) {
        const ref = refs[seq - 1]!;
        st.storage.sql.exec(`INSERT INTO messages (seq, ts_ms, from_p, taint, kind, text, data, reply_to, key, mentions, body_ref, bytes)
          VALUES (?, ?, 'user', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, 10)`, seq, old, ref);
      }
      st.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('head', ?)", String(N));
    });
    const calls: number[] = [];
    // Rows still present when each delete call is made: the bodies of a page go before its rows.
    const rowsAtCall: number[] = [];
    let failFirst = true;
    await runInDurableObject(chStub(name), async (inst: ChannelDO, st) => {
      const bucket = (inst as any).env.BUCKET as R2Bucket;
      (inst as any).env = { ...(inst as any).env, BUCKET: new Proxy(bucket, {
        get(target, prop) {
          if (prop === "delete") {
            return async (keys: string | string[]) => {
              const ks = Array.isArray(keys) ? keys : [keys];
              if (ks.length > 1000) throw new Error(`R2 delete of ${ks.length} keys`);
              if (failFirst) {
                failFirst = false;
                throw new Error("R2 unavailable");
              }
              calls.push(ks.length);
              rowsAtCall.push(st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n);
              return target.delete(ks);
            };
          }
          const v = (target as any)[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      }) };
    });
    // A failed R2 delete leaves every row (and its reference) in place.
    await expect(attempt(() => chStub(name).maintain(name))).rejects.toThrow(/R2 unavailable/);
    expect((await readAs(name, "?limit=1")).head).toBe(N);
    expect(await runInDurableObject(chStub(name), (_i: ChannelDO, st) => st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages").one().n)).toBe(N);
    await chStub(name).maintain(name);
    expect(rowsAtCall).toEqual([N, N - 1000]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(1000);
    expect(calls.reduce((a, b) => a + b, 0)).toBe(N);
    expect((await env.BUCKET.list({ prefix: `channels/${name}/b/old` })).objects.length).toBe(0);
    expect((await readAs(name)).messages.length).toBe(0);
  });

  it("a refused call makes no channel, no directory entry and no alarm", async () => {
    const a = await idleAgent();
    const name = `sbx_${uniq("x").replace(/-/g, "")}/events`;
    await expect(attempt(() => chStub(name).read(name, asAgent(a.agent), {}))).rejects.toThrow(/may not read/);
    await expect(attempt(() => chStub(name).post(name, asAgent(a.agent), { text: "x" }))).rejects.toThrow(/platform only/);
    const stored = await runInDurableObject(chStub(name), async (_i: ChannelDO, st) => ({
      meta: st.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'meta'").toArray().length,
      deadlines: st.storage.sql.exec("SELECT 1 FROM deadlines").toArray().length,
      alarm: await st.storage.getAlarm(),
    }));
    expect(stored).toEqual({ meta: 0, deadlines: 0, alarm: null });
  });

  it("idempotency keys are per poster: the same key from two posters is two posts", async () => {
    const name = await newChannel();
    const a = await idleAgent();
    await adminJson(`/v1/admin/channels/${enc(name)}/acl`, { method: "PUT", body: [{ principal: a.agent, action: "post" }] });
    expect(await chStub(name).post(name, { principal: "user" }, { text: "one", idem_key: "k" })).toEqual({ status: "posted", seq: 1 });
    expect(await chStub(name).post(name, asAgent(a.agent), { text: "two", idem_key: "k" })).toEqual({ status: "posted", seq: 2 });
    expect(await chStub(name).post(name, asAgent(a.agent), { text: "two again", idem_key: "k" })).toEqual({ status: "existing", seq: 2 });
  });

  it("the outbox dead-letters a row refused for good after bounded tries, and the rows behind it go through", async () => {
    const { agent } = await idleAgent();
    await runInDurableObject(agentStub(agent), (inst: AgentDO) => {
      (inst as any).outbox.push("Not A Channel", { kind: "x", text: "refused for good" }, { tainted: false });
      (inst as any).outbox.push(`${agent}/events`, { kind: "state_changed", text: "behind it" }, { tainted: false });
    });
    const events = `${agent}/events`;
    // The refused row is tried MAX_REFUSALS times (from the alarm, 5 s apart: forced here), then
    // dropped; the runtime's own alarm may take some of the tries.
    const delivered = async () => ((await readAs(events)).messages as any[]).some((x) => x.text === "behind it");
    const end = Date.now() + 20_000;
    while (!(await delivered())) {
      if (Date.now() > end) throw new Error("the row behind the refused one never went through");
      await runInDurableObject(agentStub(agent), async (_i: AgentDO, st) => {
        st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('chan_out', 0)");
        await st.storage.setAlarm(Date.now() + 60_000); // run below, not by the runtime
      });
      await runDurableObjectAlarm(agentStub(agent));
    }
    const left = await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM chan_out").toArray().length);
    expect(left).toBe(0);
  }, 30_000);

  it("deadlines run the outbox after every other due key", async () => {
    const order: string[] = [];
    await runInDurableObject(chStub(uniq("~deadlines")), async (_i: ChannelDO, st) => {
      const { Deadlines } = await import("../src/lib/reliable");
      const d = new Deadlines(st.storage.sql, st.storage);
      st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('chan_out', 1), ('intent', 2), ('condemned', 3)");
      await d.runDue(Date.now(), async (k) => {
        order.push(k);
      }, 5_000, ["chan_out"]);
    });
    expect(order).toEqual(["intent", "condemned", "chan_out"]);
  });

  it("text relayed through the inbox API under another name, or a workstream batch, taints; the operator's own doesn't", async () => {
    const a = await idleAgent();
    await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "from the operator" } }, 201);
    expect(await kvTainted(a.agent)).toBe(false);
    await adminJson(`/v1/agents/${a.agent}/inbox`, { body: { text: "relayed", from: "agt_someone" } }, 201);
    expect(await kvTainted(a.agent)).toBe(true);
    const b = await idleAgent();
    await adminJson(`/v1/workstreams/${b.workstream}/subscriber`, { method: "PUT", body: { subscriber: b.agent } });
    await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(b.workstream)).ingest({ workstream: b.workstream, ts_ms: Date.now(), agent: a.agent, type: "blocked", reason: "x" });
    await runDurableObjectAlarm(env.WORKSTREAM.get(env.WORKSTREAM.idFromName(b.workstream)));
    await until(() => kvTainted(b.agent), (t) => t, 10_000, "the subscriber tainted by the batch");
  });
});

describe("review round 2", () => {
  const captain = () => idleAgent({ template: "captain" });

  it("an agent without read gets every operator message: six in one window (P6), across batches", async () => {
    const { agent } = await captain();
    const inbox = `${agent}/inbox`;
    for (let i = 1; i <= 6; i++) await postAs(inbox, { text: `operator message ${i}` }, 201);
    const want = [1, 2, 3, 4, 5, 6].map((i) => `operator message ${i}`);
    const ns = await until(() => notices(agent), (n) => want.every((w) => n.join("\n").includes(w)), 15_000, "all six");
    for (const w of want) expect(ns.join("\n").split(w).length - 1, w).toBe(1);
    expect((await batchTurns(agent)).length).toBe(1);
  });

  it("an agent without read gets the operator's text from a mixed batch (P7); the peer post is recorded as skipped", async () => {
    const { agent } = await captain();
    const peer = await idleAgent();
    const inbox = `${agent}/inbox`;
    await adminJson(`/v1/admin/channels/${enc(inbox)}/acl`, { method: "PUT", body: [{ principal: peer.agent, action: "post" }] });
    await chStub(inbox).post(inbox, asAgent(peer.agent), { text: "a peer's message" });
    await postAs(inbox, { text: "please stop" }, 201);
    const ns = await until(() => notices(agent), (n) => n.length >= 1, 10_000, "the operator's message");
    expect(ns.join("\n")).toContain("Message from user (seq 2): please stop");
    expect(ns.join("\n")).not.toContain("a peer's message");
    const subs = await adminJson(`/v1/agents/${agent}/subscriptions`);
    expect(subs).toEqual([expect.objectContaining({ channel: inbox, subscription: "sub_inbox", hw: 2, skipped: 1, skipped_to: 2 })]);
  });

  it("operator messages past the inline budget come whole in later batches; one too big to inline arrives as a note", async () => {
    const { agent } = await captain();
    const inbox = `${agent}/inbox`;
    const a = `A${"a".repeat(6 * 1024)}`;
    const b = `B${"b".repeat(6 * 1024)}`;
    await postAs(inbox, { text: a }, 201);
    await postAs(inbox, { text: b }, 201);
    const ns = await until(() => notices(agent), (n) => n.join("").includes(b), 15_000, "both whole");
    expect(ns.join("").includes(a)).toBe(true);
    expect(ns.length).toBe(2);
    // One too big to keep inline (its body is in R2) arrives as a note that it needs `read`, never silently.
    await postAs(inbox, { text: "z".repeat(40 * 1024) }, 201);
    const more = await until(() => notices(agent), (n) => n.length === 3, 15_000, "the note");
    expect(more[2]).toContain("Message from user (seq 3, too long to show here)");
    expect(more.join("\n")).not.toContain("`read`");
  });

  it("a lost partial ack (P10): the retry settles the cursor at up_to, and every message arrives exactly once", async () => {
    const { agent } = await captain();
    const inbox = `${agent}/inbox`;
    await postAs(inbox, { text: "message 1" }, 201);
    await until(() => notices(agent), (n) => n.join("").includes("message 1"), 10_000, "message 1");
    // The settle after AgentDO took the next batch fails (as a reset there would).
    await runInDurableObject(chStub(inbox), (inst: ChannelDO) => {
      inst.testHooks["fanout:afterDeliver"] = async () => {
        delete inst.testHooks["fanout:afterDeliver"];
        throw new Error("reset after the agent took part of the batch");
      };
    });
    for (let i = 2; i <= 8; i++) await postAs(inbox, { text: `message ${i}` }, 201);
    const want = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `message ${i}`);
    const end = Date.now() + 20_000;
    for (;;) {
      const all = (await notices(agent)).join("\n");
      if (want.every((w) => all.includes(w)) && (await chStub(inbox).subscriptions(inbox))[0]?.cursor === 8) break;
      if (Date.now() > end) throw new Error(`not all delivered: ${all.slice(0, 400)}`);
      await fanoutNow(inbox);
    }
    const all = (await notices(agent)).join("\n");
    for (const w of want) expect(all.split(new RegExp(`${w}\\b`)).length - 1, w).toBe(1);
  }, 30_000);

  it("merges that wake count toward the hourly wake cap", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    await postAs(name, { text: "one" }, 201);
    await fanoutNow(name);
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    expect((await notices(agent)).length).toBe(2);
    // One channel turn and one merge so far: 58 more merges' worth reaches the cap of 60.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      expect(st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM chan_wakes").one().n).toBe(1);
      for (let i = 0; i < 58; i++) st.storage.sql.exec("INSERT INTO chan_wakes (ts_ms) VALUES (?)", Date.now() - 1000);
    });
    await postAs(name, { text: "three" }, 201);
    await fanoutNow(name);
    expect((await notices(agent)).length).toBe(2);
    const s = (await chStub(name).subscriptions(name))[0]!;
    expect(s).toMatchObject({ cursor: 2, inflight: null });
    expect(s.due_ms! - Date.now()).toBeGreaterThan(30 * 60_000);
  });

  it("a notice merged into a waiting turn wakes the agent (Q1's wake), and the merged text is capped", async () => {
    const { agent } = await idleAgent();
    const name = await newChannel();
    await adminJson(`/v1/admin/channels/${enc(name)}/subscriptions`, { body: { agent, batch_ms: 60_000 } }, 201);
    await postAs(name, { text: "one" }, 201);
    await fanoutNow(name);
    expect((await batchTurns(agent)).length).toBe(1);
    // As if the agent had gone `errored` with its start dropped: only new input starts it again.
    await runInDurableObject(agentStub(agent), (inst: AgentDO, st) => {
      (inst as any).update((i: any) => {
        i.intent = null;
        i.state = "errored";
      });
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'intent'");
    });
    await postAs(name, { text: "two" }, 201);
    await fanoutNow(name);
    expect((await notices(agent)).length).toBe(2);
    expect((await agentStub(agent).info()).intent).toMatchObject({ reason: "wake" });
    // Past the cap the delivery waits; the channel keeps the message.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      const t = st.storage.sql.exec<{ turn: string }>("SELECT turn FROM turns WHERE request_id LIKE 'chan/%' AND status = 'queued'").one().turn;
      st.storage.sql.exec("UPDATE turns SET input = ? WHERE turn = ?", JSON.stringify({ kind: "event_batch", text: "x".repeat(64 * 1024) }), t);
    });
    await postAs(name, { text: "three" }, 201);
    await fanoutNow(name);
    const s = (await chStub(name).subscriptions(name))[0]!;
    expect(s).toMatchObject({ cursor: 2, inflight: null });
    expect(s.due_ms! - Date.now()).toBeGreaterThan(0);
  });

  it("the spawner's subscription isn't marked made when it wasn't; once the owner can read, the next event makes it", async () => {
    const owner = await captain();
    const child = await idleAgent({ cell: owner.cell, workstream: owner.workstream, owner: owner.agent });
    const name = `${child.agent}/events`;
    await runInDurableObject(agentStub(child.agent), (inst: AgentDO) => {
      (inst as any).outbox.push(name, { kind: "state_changed", text: "state: working" }, { tainted: false, agent_owner: owner.agent });
    });
    await until(async () => (await readAs(name)).head, (h) => h === 1, 10_000, "the first event");
    expect(await chStub(name).subscriptions(name)).toEqual([]);
    // The owner's "no" is remembered only briefly: say it has since gained `read`.
    await runInDurableObject(agentStub(owner.agent), (inst: AgentDO) => {
      (inst as any).update((i: any) => {
        i.tools = [...i.tools, "read"];
      });
    });
    await runInDurableObject(agentStub(child.agent), (inst: AgentDO, st) => {
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'owner_reads'", JSON.stringify({ owner: owner.agent, reads: false, ms: Date.now() - 11 * 60_000 }));
      (inst as any).outbox.push(name, { kind: "state_changed", text: "state: idle" }, { tainted: false, agent_owner: owner.agent });
    });
    await until(() => chStub(name).subscriptions(name), (s) => s.length === 1, 10_000, "the spawner's subscription");
    expect((await chStub(name).subscriptions(name))[0]).toMatchObject({ id: "sub_spawner", agent: owner.agent, cursor: 1 });
  });

  it("the outbox never dead-letters a plain (retryable) failure: the row waits and then goes through", async () => {
    const { agent } = await idleAgent();
    const events = `${agent}/events`;
    let failures = 0;
    await runInDurableObject(chStub(events), (inst: ChannelDO) => {
      inst.testHooks["post:enter"] = async () => {
        failures++;
        if (failures >= 5) delete inst.testHooks["post:enter"];
        throw new Error("network");
      };
    });
    await runInDurableObject(agentStub(agent), (inst: AgentDO) => {
      (inst as any).outbox.push(events, { kind: "state_changed", text: "kept through failures" }, { tainted: false });
    });
    const force = () => runInDurableObject(agentStub(agent), async (_i: AgentDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('chan_out', 0)");
      await st.storage.setAlarm(Date.now() + 60_000);
    });
    const end = Date.now() + 20_000;
    while (failures < 4) {
      if (Date.now() > end) throw new Error("the post wasn't tried");
      await force();
      await runDurableObjectAlarm(agentStub(agent));
    }
    // Past MAX_REFUSALS tries, still queued and never counted as a refusal.
    expect(await runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ refusals: number }>("SELECT refusals FROM chan_out").toArray())).toEqual([{ refusals: 0 }]);
    while (!((await readAs(events)).messages as any[]).some((m) => m.text === "kept through failures")) {
      if (Date.now() > end) throw new Error("the post never went through");
      await force();
      await runDurableObjectAlarm(agentStub(agent));
    }
  }, 30_000);
});

describe("catalog seed migration", () => {
  const catalogStub = (name: string) => env.CATALOG.get(env.CATALOG.idFromName(name));

  /** A catalog as the previous release seeded it: version 1, no `seed_version`. */
  async function v1Catalog(edit?: (sql: SqlStorage) => void) {
    const stub = catalogStub(uniq("catalog-v1"));
    await runInDurableObject(stub, (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      sql.exec("DELETE FROM capabilities");
      sql.exec("DELETE FROM templates");
      sql.exec("DELETE FROM kv");
      for (const [n, c] of Object.entries(SEED_CATALOG_V1.capabilities)) {
        const { grants: _g, ...old } = c;
        sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?)", n, JSON.stringify(old));
      }
      for (const [n, t] of Object.entries(SEED_CATALOG_V1.templates)) sql.exec("INSERT INTO templates (name, body) VALUES (?, ?)", n, JSON.stringify(t));
      sql.exec("INSERT INTO kv (key, value) VALUES ('seeded', '1')");
      edit?.(sql);
    });
    return stub;
  }
  const restart = (stub: ReturnType<typeof catalogStub>) =>
    runInDurableObject(stub, async (_i: CatalogDO, st) => new CatalogDO(st, env as never).catalog());

  it("adds the new seed capabilities once, keeps the operator's entries, and never resurrects a deleted one", async () => {
    const stub = await v1Catalog((sql) => {
      // The operator deleted `memory` and made their own `channels` before this release.
      sql.exec("DELETE FROM capabilities WHERE name = 'memory'");
      sql.exec("INSERT INTO capabilities (name, body) VALUES ('channels', ?)", JSON.stringify({ tools: ["notify"], rules: [], prompt: "mine" }));
    });
    const after = await restart(stub);
    expect(after.capabilities["messaging-tree"]?.tools).toEqual(["message"]);
    expect(after.capabilities.channels).toMatchObject({ tools: ["notify"], prompt: "mine" });
    expect(after.capabilities).not.toHaveProperty("memory");
    // Templates are the operator's: unchanged.
    expect(after.templates.worker?.capabilities).toEqual(SEED_CATALOG_V1.templates.worker!.capabilities);
    const version = await runInDurableObject(stub, (_i: CatalogDO, st) => st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'seed_version'").one().value);
    expect(version).toBe(String(SEED_VERSION));
    // Deleted after the migration: stays deleted across restarts.
    await stub.deleteCapability("messaging-tree");
    expect(await restart(stub)).not.toHaveProperty("capabilities.messaging-tree");
    // A capability stored before grants existed still parses and expands (no grants).
    expect((await stub.expand({ template: "worker", hands: true, by: "operator" })).channel_grants).toEqual([]);
  });

  it("a fresh catalog has the channel capabilities and records the current version", async () => {
    const stub = catalogStub(uniq("catalog-fresh"));
    const cat = await stub.catalog();
    expect(cat.capabilities.channels?.grants).toEqual([{ action: "post", channel: "user" }]);
    expect(Object.keys(cat.templates).sort()).toEqual(["captain", "worker"]);
  });
});
