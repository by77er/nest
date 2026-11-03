// An agent's trace history (docs/control-plane/api/#trace-history): its older events normalized from the
// stored transcript, paged backwards, meeting the live ring at its seam with no event twice and none
// missing. The pure parts first (an entry, reading lines backwards across segments, a page), then
// through the Worker and AgentDO with a runner session's transcript bytes in R2.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDO } from "../src/do/agent";
import { REDACTED, TRACE_FIELD_MAX } from "../src/lib/trace";
import {
  decodeCursor, encodeCursor, type HistoryCursor, historyPage, linesBackward, normalizeEntry, type Segment,
} from "../src/lib/trace-history";
import { bytesToB64 } from "../src/lib/util";
import { adminJson, BASE, connectHost, nextCommands, uniqueCell, Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const utf8 = (s: string) => new TextEncoder().encode(s).length;
const SESSION = "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b";
/** A credential-shaped value built from pieces (no literal matches a secret scanner's rule). */
const ghToken = ["ghp", "Z".repeat(36)].join("_");

// --- Claude Code transcript entries ----------------------------------------------------------------------

const iso = (ms: number) => new Date(ms).toISOString();
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const prompt = (ts: number, text: string) => line({ type: "user", isSidechain: false, message: { role: "user", content: text }, uuid: crypto.randomUUID(), timestamp: iso(ts) });
const say = (ts: number, text: string, stop: string | null = null) =>
  line({ type: "assistant", message: { id: "msg_x", role: "assistant", content: [{ type: "text", text }], stop_reason: stop }, uuid: crypto.randomUUID(), timestamp: iso(ts) });
const use = (ts: number, id: string, name: string, input: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" }, uuid: crypto.randomUUID(), timestamp: iso(ts) });
const result = (ts: number, id: string, text: string, isError = false) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] }, uuid: crypto.randomUUID(), timestamp: iso(ts) });

/** A whole turn: its prompt, a text, a tool call and its result, a closing text. */
const turnLines = (t0: number, n: number) =>
  prompt(t0, `do ${n}`) + say(t0 + 1, `looking ${n}`) + use(t0 + 2, `toolu_${n}`, "Bash", { command: `ls ${n}` }) + result(t0 + 3, `toolu_${n}`, `out ${n}`) + say(t0 + 4, `done ${n}`, "end_turn");

/** What an event is, for comparing streams: its type and its identity. */
const key = (e: any) => `${e.type}:${e.call_id ?? e.text ?? e.stop_reason ?? e.input_kind ?? ""}`;

describe("an entry (pure)", () => {
  it("gives a prompt's turn start, an assistant's texts and tool calls, a user's tool results; nothing for the rest", () => {
    expect(normalizeEntry(prompt(1000, "hi"), 0)).toMatchObject({ ts: 1000, prompt: true, bodies: [{ type: "turn_started", input_kind: "unknown" }] });
    const a = normalizeEntry(line({ type: "assistant", timestamp: iso(5), message: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "t" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a" } }], stop_reason: "tool_use" } }), 9)!;
    expect(a.bodies).toEqual([{ type: "assistant_text", text: "t" }, { type: "tool_call", call_id: "toolu_1", name: "Read", input: '{"path":"a"}' }]);
    expect(a).toMatchObject({ offset: 9, stop: "tool_use", prompt: false });
    expect(normalizeEntry(result(5, "toolu_1", "x".repeat(500), true), 0)!.bodies).toEqual([{ type: "tool_result", call_id: "toolu_1", is_error: true, summary: "x".repeat(200) }]);
    for (const skip of [
      line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }),
      line({ type: "user", isMeta: true, message: { content: "caveat" } }),
      line({ type: "user", isCompactSummary: true, message: { content: "summary" } }),
      line({ type: "system", subtype: "init" }),
      line({ type: "summary", summary: "s" }),
    ]) expect(normalizeEntry(skip, 0)!.bodies, skip).toEqual([]);
    expect(normalizeEntry("not json", 0)).toBeNull();
  });

  it("redacts and bounds as the live path does", () => {
    const call = normalizeEntry(use(1, "toolu_r", "Bash", { command: `echo ${ghToken}`, token: "plain", body: "y".repeat(20_000) }), 0)!.bodies[0] as any;
    expect(call.input).not.toContain(ghToken);
    expect(call.input).toContain(`"token":"${REDACTED}"`);
    expect(utf8(call.input)).toBeLessThanOrEqual(TRACE_FIELD_MAX);
    expect((normalizeEntry(result(1, "toolu_r", `got ${ghToken}`), 0)!.bodies[0] as any).summary).toBe(`got ${REDACTED}`);
    expect((normalizeEntry(say(1, `key ${ghToken}`), 0)!.bodies[0] as any).text).toBe(`key ${REDACTED}`);
  });
});

/** `text` as R2 segments of `size` bytes (lines cut anywhere, as segments may be). */
function segmented(text: string, size: number) {
  const bytes = new TextEncoder().encode(text);
  const segments: Segment[] = [];
  const store = new Map<string, Uint8Array>();
  for (let o = 0; o < bytes.length; o += size) {
    const k = `s${o}`;
    store.set(k, bytes.slice(o, o + size));
    segments.push({ offset: o, len: Math.min(size, bytes.length - o), key: k });
  }
  const reads: string[] = [];
  const read = async (k: string) => {
    reads.push(k);
    return store.get(k) ?? null;
  };
  return { segments, read, reads, end: bytes.length, store };
}

describe("reading backwards (pure)", () => {
  it("gives every line newest first with its offset, whole across segment cuts, and stops at the budget at a line start", async () => {
    const text = `${"a".repeat(10)}\n${"é".repeat(7)}\n${"c".repeat(30)}\n\nd\n`;
    const lines = text.split("\n").slice(0, -1);
    const offsets: number[] = [];
    let o = 0;
    for (const l of lines) {
      offsets.push(o);
      o += utf8(l) + 1;
    }
    for (const size of [1, 3, 7, 64]) {
      const s = segmented(text, size);
      const got: { offset: number; text: string }[] = [];
      for await (const x of linesBackward(s.segments, s.end, s.read, 1 << 20)) if ("offset" in x) got.push(x);
      expect(got.map((g) => g.text), `size ${size}`).toEqual(lines.filter((l) => l).reverse());
      expect(got.map((g) => g.offset)).toEqual(offsets.filter((_, i) => lines[i]).reverse());
    }
    // A budget of one 7-byte segment: stops once a line is given, at that line's start.
    const s = segmented(text, 7);
    const out: any[] = [];
    for await (const x of linesBackward(s.segments, s.end, s.read, 7)) out.push(x);
    expect(out.at(-1)).toEqual({ stoppedAt: out.at(-2).offset });
    // From an offset: only lines that start before it.
    const from: string[] = [];
    for await (const x of linesBackward(s.segments, offsets[2]!, s.read, 1 << 20)) if ("offset" in x) from.push(x.text);
    expect(from).toEqual([lines[1], lines[0]]);
  });
});

describe("a page (pure)", () => {
  const T = 1_800_000_000_000;
  const none = { calls: new Set<string>(), results: new Set<string>(), texts: new Set<string>() };
  const all = async (text: string, limit: number, cur: HistoryCursor, ring = none, size = 50) => {
    const s = segmented(text, size);
    const pages: any[][] = [];
    let c: HistoryCursor | null = cur;
    for (let n = 0; c && n < 50; n++) {
      const p = await historyPage(s.segments, s.end, c, limit, ring, s.read);
      pages.push(p.events);
      c = p.next_before ? decodeCursor(p.next_before) : null;
    }
    return { pages, events: pages.reverse().flat() };
  };

  it("pages back by whole turns, each closed by a turn_completed, and the pages join to the whole", async () => {
    const text = [0, 1, 2, 3, 4].map((n) => turnLines(T + n * 100, n)).join("");
    const whole = await all(text, 500, { b: 0, o: null, t: T + 10_000, c: true });
    expect(whole.pages).toHaveLength(1);
    const expectTurn = (n: number) => [`turn_started:unknown`, `assistant_text:looking ${n}`, `tool_call:toolu_${n}`, `tool_result:toolu_${n}`, `assistant_text:done ${n}`, `turn_completed:end_turn`];
    expect(whole.events.map(key)).toEqual([0, 1, 2, 3, 4].flatMap(expectTurn));
    // Pages of about 7 events (one turn is 6): each page is whole turns, and together they're the same.
    const paged = await all(text, 7, { b: 0, o: null, t: T + 10_000, c: true });
    expect(paged.pages.length).toBeGreaterThan(2);
    for (const p of paged.pages) expect(p[0].type, JSON.stringify(p.map(key))).toBe("turn_started");
    expect(paged.events.map(key)).toEqual(whole.events.map(key));
    // Oldest first within a page, with each event's entry offset.
    const offs = whole.events.map((e) => e.entry);
    expect(offs).toEqual([...offs].sort((a, b) => a - b));
  });

  it("stops at the seam: nothing written at or after `t`, and the last turn closed only when the seam starts a turn", async () => {
    const text = turnLines(T, 0) + turnLines(T + 1000, 1);
    const before = await all(text, 500, { b: 0, o: null, t: T + 1000, c: true });
    expect(before.events.map(key)).toEqual(["turn_started:unknown", "assistant_text:looking 0", "tool_call:toolu_0", "tool_result:toolu_0", "assistant_text:done 0", "turn_completed:end_turn"]);
    // A seam inside a turn: the turn stays open (the ring goes on with it).
    const mid = await all(text, 500, { b: 0, o: null, t: T + 1003, c: false });
    expect(mid.events.map(key).slice(-4)).toEqual(["turn_completed:end_turn", "turn_started:unknown", "assistant_text:looking 1", "tool_call:toolu_1"]);
  });

  it("leaves out what the ring has near the seam: tool calls and results by id, texts by text", async () => {
    const text = turnLines(T, 0) + turnLines(T + 10_000, 1);
    const ring = { calls: new Set<string>(), results: new Set(["toolu_1"]), texts: new Set(["done 1", "looking 0"]) };
    const p = await all(text, 500, { b: 0, o: null, t: T + 10_010, c: true }, ring);
    const keys = p.events.map(key);
    expect(keys).not.toContain("tool_result:toolu_1");
    expect(keys).not.toContain("assistant_text:done 1");
    // "looking 0" is far from the seam: a text the ring repeats later isn't this one.
    expect(keys).toContain("assistant_text:looking 0");
    expect(keys).toContain("tool_call:toolu_1");
  });

  it("goes on past the byte budget with a cursor, and an empty transcript has nothing", async () => {
    const text = [0, 1, 2, 3].map((n) => turnLines(T + n * 100, n)).join("");
    const s = segmented(text, 64);
    const p = await historyPage(s.segments, s.end, { b: 0, o: null, t: T + 10_000, c: true }, 500, none, s.read, 64 * 3);
    expect(p.next_before).not.toBeNull();
    expect(s.reads.length).toBeLessThanOrEqual(5);
    const empty = await historyPage([], 0, { b: 0, o: null, t: T, c: true }, 50, none, async () => null);
    expect(empty).toEqual({ events: [], next_before: null });
  });

  it("cursors round-trip, and anything else isn't one", () => {
    const c = { b: 3, o: 120, t: T, c: false };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ ...c, o: null }))).toEqual({ ...c, o: null });
    for (const bad of ["", "xyz", encodeCursor({ b: -1, o: 0, t: 0, c: true } as never), btoa("[]")]) expect(decodeCursor(bad), bad).toBeNull();
  });
});

// --- Through the Worker and AgentDO ----------------------------------------------------------------------

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const BASIC = { capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" };

async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  if (status !== undefined) expect(res.status, `${path}: ${text}`).toBe(status);
  else expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

async function newClient(cell: string) {
  const name = `th-${rand()}`;
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 20, max_sandboxes: 1 } } }, 201);
  await asJson(c.token, `/v1/catalog/templates/${name}/basic`, { method: "PUT", body: BASIC });
  return { id: c.client as string, token: c.token as string, tpl: `${name}/basic` };
}

/** A client, a brain host, and an agent of the client's with its runner session. */
async function world() {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const cell = uniqueCell();
  const c = await newClient(cell);
  const brain = await connectHost(cell, "brain");
  const a = await asJson(c.token, "/v1/agents", { body: { template: c.tpl, cell } }, 201);
  const [start] = (await nextCommands(brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent)).filter((x) => x.agent === a.agent);
  const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, brain.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: SESSION });
  await ws.next("hello_ack");
  let offset = 0;
  let chan = 0;
  let evSeq = 0;
  return {
    cell, c, brain, ws, agent: a.agent as string, epoch: start.epoch as number,
    /** Transcript bytes, made durable in R2. */
    async write(text: string) {
      ws.send({ type: "segment", session: SESSION, offset, base: false, data_b64: bytesToB64(new TextEncoder().encode(text)) });
      offset += utf8(text);
      await agentStub(a.agent).flush();
      await ws.next("segment_ack", (m) => m.durable_bytes >= offset);
    },
    /** Runner events (each `ts_ms` given), acked. */
    async events(evs: Record<string, unknown>[]) {
      const seq = ++chan;
      ws.send({ type: "events", seq, events: evs.map((e) => ({ agent: a.agent, epoch: start.epoch, seq: ++evSeq, ...e })) });
      await ws.next("ack", (m) => m.up_to >= seq);
    },
    /** A turn posted and sent to the runner. */
    async turn(text: string): Promise<string> {
      await asJson(c.token, `/v1/agents/${a.agent}/turns`, { body: { text } }, 201);
      const run = await ws.next("run_turn", (m) => m.input.text === text);
      ws.send({ type: "ack", up_to: run.seq });
      return run.turn as string;
    },
  };
}

const history = (agent: string, token: string, q = "") => SELF.fetch(`${BASE}/v1/agents/${agent}/trace/history${q}`, { headers: { authorization: `Bearer ${token}` } });

/** Every history event before `before` (or the seam), paging with `limit`. */
async function backfill(agent: string, token: string, before?: string, limit = 500) {
  const pages: any[][] = [];
  let cur: string | null | undefined = before;
  for (let n = 0; n < 50; n++) {
    const res = await history(agent, token, `?limit=${limit}${cur ? `&before=${cur}` : ""}`);
    expect(res.status).toBe(200);
    const p = (await res.json()) as { events: any[]; next_before: string | null };
    pages.unshift(p.events);
    cur = p.next_before;
    if (!cur) break;
  }
  return pages.flat();
}

/** The trace's connect messages up to `live`. */
async function connect(agent: string, token: string) {
  const t = await Ws.connect(`/v1/agents/${agent}/trace`, token);
  const got: any[] = [];
  for (;;) {
    const m = await new Promise<any>((resolve, reject) => {
      const i = setInterval(() => {
        const x = t.received.shift();
        if (x) {
          clearInterval(i);
          resolve(x);
        }
      }, 5);
      setTimeout(() => {
        clearInterval(i);
        reject(new Error(`no live; got ${JSON.stringify(got).slice(0, 800)}`));
      }, 3000);
    });
    got.push(m);
    if (m.type === "live") break;
  }
  t.close();
  return got;
}

describe("the history route", () => {
  it("gives an agent's transcript as trace events (the ring empty of them), with the connect's cursor", async () => {
    const w = await world();
    const T = Date.now() - 60_000;
    await w.write(turnLines(T, 0) + turnLines(T + 1000, 1));
    const msgs = await connect(w.agent, w.c.token);
    const h = msgs.find((m) => m.type === "history");
    expect(h).toMatchObject({ type: "history", before: expect.any(String) });
    const events = await backfill(w.agent, w.c.token, h.before);
    expect(events.map(key)).toEqual([0, 1].flatMap((n) => [`turn_started:unknown`, `assistant_text:looking ${n}`, `tool_call:toolu_${n}`, `tool_result:toolu_${n}`, `assistant_text:done ${n}`, `turn_completed:end_turn`]));
    expect(events[0]).toEqual({ ts_ms: T, entry: 0, type: "turn_started", input_kind: "unknown" });
    // Without a cursor: from the seam, the same.
    expect((await backfill(w.agent, w.c.token)).map(key)).toEqual(events.map(key));
    w.ws.close();
  });

  it("meets the ring at its seam: history and the ring together have each event once, at a turn's start or within one", async () => {
    const w = await world();
    const T = Date.now() - 60_000;
    await w.write(turnLines(T, 0));
    // The next turn runs live: the ring has it, and the transcript too (written after its turn_started).
    const turn = await w.turn("go on");
    const T1 = Date.now();
    await w.events([
      { ts_ms: T1, turn, type: "turn_started", input_kind: "user" },
      { ts_ms: T1 + 5, turn, type: "assistant_text", text: "looking 1" },
      { ts_ms: T1 + 6, turn, type: "tool_call", call_id: "toolu_1", name: "Bash", input: { command: "ls 1" } },
      { ts_ms: T1 + 9, turn, type: "tool_result", call_id: "toolu_1", is_error: false, summary: "out 1" },
      { ts_ms: T1 + 12, turn, type: "assistant_text", text: "done 1" },
      { ts_ms: T1 + 13, turn, type: "turn_completed", stop_reason: "end_turn" },
    ]);
    await w.write(prompt(T1 + 1, "go on") + say(T1 + 4, "looking 1") + use(T1 + 5, "toolu_1", "Bash", { command: "ls 1" }) + result(T1 + 8, "toolu_1", "out 1") + say(T1 + 11, "done 1", "end_turn"));
    const ringKeys = async () => (await connect(w.agent, w.c.token)).filter((m) => typeof m.seq === "number" && ["turn_started", "assistant_text", "tool_call", "tool_result", "turn_completed"].includes(m.type)).map(key);
    const expected = [0, 1].flatMap((n) => [`turn_started:${n ? "user" : "unknown"}`, `assistant_text:looking ${n}`, `tool_call:toolu_${n}`, `tool_result:toolu_${n}`, `assistant_text:done ${n}`, "turn_completed:end_turn"]);
    // At a turn's start.
    expect([...(await backfill(w.agent, w.c.token)).map(key), ...(await ringKeys())]).toEqual(expected);
    // Within one: the ring pruned up to its tool call (as a long turn's would be), so the seam is its result.
    await runInDurableObject(agentStub(w.agent), (_i: unknown, st: DurableObjectState) => {
      const rows = st.storage.sql.exec<{ seq: number; body: string }>("SELECT seq, body FROM trace ORDER BY seq").toArray();
      const call = rows.find((r) => JSON.parse(r.body).type === "tool_call")!;
      st.storage.sql.exec("DELETE FROM trace WHERE seq <= ?", call.seq);
    });
    const joined = [...(await backfill(w.agent, w.c.token)).map(key), ...(await ringKeys())];
    // Each once (the result's entry was written before the runner stamped it: left to the ring), none missing.
    expect(joined.filter((k) => k !== "turn_completed:end_turn")).toEqual(expected.filter((k) => k !== "turn_completed:end_turn").map((k) => (k === "turn_started:user" ? "turn_started:unknown" : k)));
    w.ws.close();
  });

  it("pages back with `limit`, and the pages join to the whole", async () => {
    const w = await world();
    const T = Date.now() - 60_000;
    await w.write([0, 1, 2, 3, 4, 5].map((n) => turnLines(T + n * 100, n)).join(""));
    const whole = await backfill(w.agent, w.c.token);
    const paged = await backfill(w.agent, w.c.token, undefined, 5);
    expect(whole).toHaveLength(36);
    expect(paged.map(key)).toEqual(whole.map(key));
    const first = await (await history(w.agent, w.c.token, "?limit=5")).json() as any;
    expect(first.events[0].type).toBe("turn_started");
    expect(first.events.at(-1)).toMatchObject({ type: "turn_completed" });
    w.ws.close();
  });

  it("an agent with no transcript has none, and its connect offers none", async () => {
    const w = await world();
    const a = await asJson(w.c.token, "/v1/agents", { body: { template: w.c.tpl, cell: w.cell, start: false } }, 201);
    expect(await asJson(w.c.token, `/v1/agents/${a.agent}/trace/history`)).toEqual({ events: [], next_before: null });
    expect((await connect(a.agent, w.c.token)).map((m) => m.type)).toEqual(["live"]);
    w.ws.close();
  });

  it("is the owner's: the operator and the agent's client; another client gets the unknown agent's 404, a host token 401", async () => {
    const w = await world();
    const other = await newClient(w.cell);
    expect((await history(w.agent, "test-admin-token")).status).toBe(200);
    expect((await history(w.agent, w.c.token)).status).toBe(200);
    const theirs = await history(w.agent, other.token);
    const nobody = await history(`agt_${rand()}none`, other.token);
    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual(await nobody.json());
    expect((await history(w.agent, w.brain.host_token)).status).toBe(401);
    for (const q of ["?before=%21%21", "?limit=x", `?before=${btoa("[]")}`]) expect((await history(w.agent, w.c.token, q)).status, q).toBe(400);
    w.ws.close();
  });

  it("a cursor from a rewritten transcript starts over, and a release without the method answers a retryable 503", async () => {
    const w = await world();
    await w.write(turnLines(Date.now() - 60_000, 0));
    const stale = encodeCursor({ b: 99, o: 10, t: Date.now(), c: true });
    const r = await asJson(w.c.token, `/v1/agents/${w.agent}/trace/history?before=${stale}`);
    expect(r).toMatchObject({ events: [], reset: true });
    expect(decodeCursor(r.next_before)).toMatchObject({ b: 0, o: null });
    const proto = AgentDO.prototype as unknown as Record<string, unknown>;
    const m = proto.traceHistory;
    delete proto.traceHistory;
    try {
      const res = await history(w.agent, w.c.token);
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toMatchObject({ code: "internal", retryable: true });
    } finally {
      proto.traceHistory = m;
    }
    w.ws.close();
  });

  it("says where to backfill from on a gap", async () => {
    const w = await world();
    const T = Date.now() - 60_000;
    await w.write(turnLines(T, 0));
    const turn = await w.turn("more");
    await w.events([{ ts_ms: Date.now(), turn, type: "turn_started", input_kind: "user" }, { ts_ms: Date.now(), turn, type: "assistant_text", text: "x" }]);
    await runInDurableObject(agentStub(w.agent), (_i: unknown, st: DurableObjectState) => {
      const first = st.storage.sql.exec<{ seq: number }>("SELECT MIN(seq) AS seq FROM trace").one().seq;
      st.storage.sql.exec("DELETE FROM trace WHERE seq <= ?", first + 1);
    });
    const msgs = await connect(w.agent, w.c.token);
    const gap = msgs.find((m) => m.type === "gap");
    expect(gap).toMatchObject({ from: 1, before: expect.any(String) });
    expect(msgs.find((m) => m.type === "history")?.before).toBe(gap.before);
    w.ws.close();
  });
});
