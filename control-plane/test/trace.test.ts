// An agent's live trace (docs/control-plane/api/#live-trace): `GET /v1/agents/<id>/trace` as a
// hibernatable WebSocket AgentDO holds beside (never with) the runner's session socket. Who may connect,
// what streams and in what order, resuming with `after` and the gap, the bounds and redaction, the cap,
// the end, and that no trace socket can hold up the runner. The pure parts first.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDO } from "../src/do/agent";
import {
  inputSummary, REDACTED, redactText, redactValue, TRACE_FIELD_MAX, TRACE_SOCKETS_MAX, TRACE_TEXT_MAX, TraceRing, traceOf,
} from "../src/lib/trace";
import { adminJson, BASE, connectHost, eventually, nextCommands, uniqueCell, Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const utf8 = (s: string) => new TextEncoder().encode(s).length;
/**
 * Credential-shaped samples, built at run time from pieces so no literal in this file matches a secret
 * scanner's rule (the repo's convention): nest's own (redacted) and other services' (passed), none a value.
 */
const fake = {
  client: ["nest", "cli", "abc123", "a".repeat(64)].join("_"),
  webhook: ["whsec", "0f".repeat(32)].join("_"),
  anthropic: ["sk", "ant", "oat01", "AbCdEfGh123"].join("-"),
  github: ["ghp", "A".repeat(36)].join("_"),
  githubPat: ["github", "pat", "B".repeat(40)].join("_"),
  slack: ["xoxb", "1234567890", "abcdef"].join("-"),
  aws: ["AK", "IA", "ABCDEFGHIJKLMNOP"].join(""),
  pem: ["-----BEGIN RSA PRIVATE", " KEY-----\nMIIabc\n-----END RSA PRIVATE", " KEY-----"].join(""),
  bearer: (v: string) => ["Bear", "er ", v].join(""),
};
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

/** The upgrade's answer, without accepting it. */
const upgrade = (agent: string, token: string | null, query = "", headers: Record<string, string> = { upgrade: "websocket" }) =>
  SELF.fetch(`${BASE}/v1/agents/${agent}/trace${query}`, { headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) } });

const trace = (agent: string, token: string, after?: number) => Ws.connect(`/v1/agents/${agent}/trace${after === undefined ? "" : `?after=${after}`}`, token);

/** Every message a trace socket got until it holds one matching `until`. */
async function readUntil(ws: Ws, until: (m: any) => boolean, ms = 3000): Promise<any[]> {
  const end = Date.now() + ms;
  for (;;) {
    const i = ws.received.findIndex(until);
    if (i >= 0) return ws.received.splice(0, i + 1);
    if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(ws.received).slice(0, 1500)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function newClient(cell: string) {
  const name = `tr-${rand()}`;
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 20, max_sandboxes: 1 } } }, 201);
  await asJson(c.token, `/v1/catalog/templates/${name}/basic`, { method: "PUT", body: BASIC });
  return { id: c.client as string, token: c.token as string, tpl: `${name}/basic` };
}
type Client = Awaited<ReturnType<typeof newClient>>;

/** A runner session: tool calls and event batches share one inbound sequence. */
class Session {
  private seq = 0;
  private evSeq = 0;
  constructor(readonly ws: Ws, readonly agent: string, readonly epoch: number) {}

  /** Send a batch and wait for its ack (3 s at most: `Ws.next`). */
  async events(evs: Record<string, unknown>[]): Promise<number> {
    const seq = ++this.seq;
    this.ws.send({ type: "events", seq, events: evs.map((e) => ({ agent: this.agent, epoch: this.epoch, seq: ++this.evSeq, ts_ms: Date.now(), ...e })) });
    await this.ws.next("ack", (m) => m.up_to >= seq);
    return seq;
  }

  async turn(token: string, text: string): Promise<string> {
    await asJson(token, `/v1/agents/${this.agent}/turns`, { body: { text } }, 201);
    const run = await this.ws.next("run_turn", (m) => m.input.text === text);
    this.ws.send({ type: "ack", up_to: run.seq });
    return run.turn as string;
  }
}

async function world() {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const cell = uniqueCell();
  const c = await newClient(cell);
  const brain = await connectHost(cell, "brain");
  /** An agent of `c` with its runner session connected. */
  const session = async (): Promise<Session> => {
    const a = await asJson(c.token, "/v1/agents", { body: { template: c.tpl, cell } }, 201);
    const [start] = (await nextCommands(brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent)).filter((x) => x.agent === a.agent);
    const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, brain.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b" });
    await ws.next("hello_ack");
    return new Session(ws, a.agent, start.epoch);
  };
  /** An agent of `c` never started. */
  const unstarted = async (client: Client = c): Promise<string> =>
    (await asJson(client.token, "/v1/agents", { body: { template: client.tpl, cell, start: false } }, 201)).agent;
  return { cell, c, brain, session, unstarted };
}

// --- Pure ------------------------------------------------------------------------------------------------

describe("redaction and bounds (pure)", () => {
  it("redacts nest's own credentials in text, keeping a bearer header's scheme, and no other service's shapes", () => {
    for (const s of [fake.client, fake.webhook]) {
      const out = redactText(`before ${s} after`);
      expect(out, s).toBe(`before ${REDACTED} after`);
    }
    // No credential shapes of other services (the owner, 2026-11-12): they pass, as any other text.
    for (const s of [fake.anthropic, fake.github, fake.githubPat, fake.slack, fake.aws, fake.pem]) expect(redactText(`before ${s} after`), s).toBe(`before ${s} after`);
    expect(redactText(`Authorization: ${fake.bearer("abcdefgh.ijk")}`)).toBe(`Authorization: ${fake.bearer(REDACTED)}`);
    // Ordinary text passes.
    expect(redactText("git push origin main; the token count is 12")).toBe("git push origin main; the token count is 12");
  });

  it("redacts credential-named keys at any depth, and shapes in other strings", () => {
    const v = redactValue({
      command: `curl -H "Authorization: ${fake.bearer("abcdefghijk")}" https://x`, env: { GITHUB_TOKEN: "anything", PATH: "/bin" },
      headers: [{ name: "x", password: "hunter22" }], api_key: "k", empty_token: "", n: 3,
    });
    expect(v).toEqual({
      command: `curl -H "Authorization: ${fake.bearer(REDACTED)}" https://x`, env: { GITHUB_TOKEN: REDACTED, PATH: "/bin" },
      headers: [{ name: "x", password: REDACTED }], api_key: REDACTED, empty_token: "", n: 3,
    });
  });

  it("bounds a tool's input and each field (UTF-8 bytes), and assistant text more loosely", () => {
    const big = { content: "é".repeat(10_000) };
    const s = inputSummary(big);
    expect(utf8(s)).toBeLessThanOrEqual(TRACE_FIELD_MAX);
    expect(s.endsWith("…")).toBe(true);
    expect(inputSummary(undefined)).toBe("null");
    const base = { agent: "agt_x", epoch: 1, seq: 1, ts_ms: 1, turn: "trn_x" } as const;
    const r = traceOf({ ...base, type: "tool_result", call_id: "c", is_error: false, summary: "x".repeat(10_000) });
    expect(utf8((r as { summary: string }).summary)).toBeLessThanOrEqual(TRACE_FIELD_MAX);
    const t = traceOf({ ...base, type: "assistant_text", text: "y".repeat(40_000) }) as { text: string };
    expect(utf8(t.text)).toBeLessThanOrEqual(TRACE_TEXT_MAX);
    expect(utf8(t.text)).toBeGreaterThan(TRACE_FIELD_MAX);
    // A secret is redacted before the cut, so a cut can't leave it half-matched.
    // Placed so a cut first would keep "nest_cli_" and 7 of its characters, one short of the shape.
    const cut = traceOf({ ...base, type: "error", error: { code: "x", message: `${"z".repeat(TRACE_FIELD_MAX - 3 - 17)} ${["nest", "cli", "Q".repeat(36)].join("_")}`, retryable: false } }) as { message: string };
    expect(cut.message).not.toMatch(/nest_cli|QQQ/);
  });

  it("streams what the trace shows and nothing else", () => {
    const base = { agent: "agt_x", epoch: 1, seq: 1, ts_ms: 1, turn: "trn_x" } as const;
    expect(traceOf({ ...base, type: "state_changed", state: "working" })).toBeNull();
    expect(traceOf({ ...base, type: "escalation", call: "cal_x", tool: "Bash", input: {} })).toBeNull();
    expect(traceOf({ ...base, type: "capabilities", capabilities: [] })).toBeNull();
    expect(traceOf({ ...base, type: "inbox_delivered", message: "msg_x" })).toBeNull();
    expect(traceOf({ ...base, type: "usage", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })).toBeNull();
    expect(traceOf({ ...base, type: "turn_completed", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, cost_usd_estimate: 0.1 } }))
      .toEqual({ type: "turn_completed", stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } });
    expect(traceOf({ ...base, type: "tool_call", call_id: "toolu_1", name: "Bash", input: { command: "ls", token: "t0ps3cret" } }))
      .toEqual({ type: "tool_call", call_id: "toolu_1", name: "Bash", input: `{"command":"ls","token":"${REDACTED}"}` });
  });
});

describe("the ring (in a Durable Object's SQLite)", () => {
  const inDO = <T>(fn: (sql: SqlStorage) => T) => runInDurableObject(agentStub(`agt_ring${rand()}`), (_i: unknown, st: DurableObjectState) => fn(st.storage.sql));
  const body = (n: number) => ({ type: "assistant_text" as const, text: `t${n}` });

  it("keeps the newest `max`, numbers from 1 and never reuses a seq; `after` gives the backlog and the gap before it", async () => {
    await inDO((sql) => {
      sql.exec("DROP TABLE IF EXISTS trace");
      sql.exec("DROP TABLE IF EXISTS trace_head");
      const ring = new TraceRing(sql, 5, 60_000);
      expect(ring.after(0, 0)).toEqual({ gap: null, events: [] });
      for (let i = 1; i <= 10; i++) expect(ring.append(body(i), 100 + i, i % 2 ? "trn_a" : null, 0)!.seq).toBe(i);
      const all = ring.after(0, 0);
      expect(all.gap).toEqual({ from: 1, to: 5 });
      expect(all.events.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
      expect(all.events[0]).toEqual({ seq: 6, ts_ms: 106, type: "assistant_text", text: "t6" });
      expect(all.events[1]).toEqual({ seq: 7, ts_ms: 107, turn: "trn_a", type: "assistant_text", text: "t7" });
      expect(ring.after(4, 0).gap).toEqual({ from: 5, to: 5 });
      expect(ring.after(5, 0)).toMatchObject({ gap: null });
      expect(ring.after(5, 0).events.map((e) => e.seq)).toEqual([6, 7, 8, 9, 10]);
      expect(ring.after(8, 0)).toEqual({ gap: null, events: [expect.objectContaining({ seq: 9 }), expect.objectContaining({ seq: 10 })] });
      expect(ring.after(10, 0)).toEqual({ gap: null, events: [] });
      // Ahead of the head: nothing until new events.
      expect(ring.after(99, 0)).toEqual({ gap: null, events: [] });
      // Aged out entirely: the whole range is a gap, and the next seq still follows the head.
      expect(ring.after(7, 60_001)).toEqual({ gap: { from: 8, to: 10 }, events: [] });
      expect(ring.append(body(11), 0, null, 60_001)!.seq).toBe(11);
      expect(ring.after(0, 60_001)).toEqual({ gap: { from: 1, to: 10 }, events: [expect.objectContaining({ seq: 11 })] });
    });
  });

  it("records an event that names its source once", async () => {
    await inDO((sql) => {
      sql.exec("DROP TABLE IF EXISTS trace");
      sql.exec("DROP TABLE IF EXISTS trace_head");
      const ring = new TraceRing(sql);
      expect(ring.append(body(1), 1, null, 0, "1.1.1.assistant_text")).not.toBeNull();
      expect(ring.append(body(1), 1, null, 0, "1.1.1.assistant_text")).toBeNull();
      expect(ring.append(body(2), 1, null, 0)).not.toBeNull();
      expect(ring.head()).toBe(2);
    });
  });
});

// --- Through the Worker and AgentDO ------------------------------------------------------------------------

describe("who may connect", () => {
  it("the operator and the agent's own client; any other client gets the same 404 as an unknown agent", async () => {
    const w = await world();
    const a = await w.unstarted();
    const other = await newClient(w.cell);
    const mine = await upgrade(a, w.c.token);
    expect(mine.status).toBe(101);
    mine.webSocket!.accept();
    mine.webSocket!.close();
    const op = await upgrade(a, "test-admin-token");
    expect(op.status).toBe(101);
    op.webSocket!.accept();
    op.webSocket!.close();
    const theirs = await upgrade(a, other.token);
    const nobody = await upgrade(`agt_${rand()}nope`, other.token);
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(await theirs.json()).toEqual(await nobody.json());
    // The operator asking for an agent that doesn't exist: 404 too, from AgentDO.
    const missing = await upgrade(`agt_${rand()}gone`, "test-admin-token");
    expect(missing.status).toBe(404);
    expect((await missing.json() as any).error.code).toBe("unknown_agent");
  });

  it("refuses a host's token, an agent's caller identity, no token, no upgrade and a bad `after`", async () => {
    const w = await world();
    const a = await w.unstarted();
    expect((await upgrade(a, w.brain.host_token)).status).toBe(401);
    const identity = await env.BROKER.get(env.BROKER.idFromName("broker")).signIdentity({ aud: "https://nest.test", sub: a, owner: w.c.id, epoch: 1, tainted: false });
    expect((await upgrade(a, identity.token)).status).toBe(401);
    expect((await upgrade(a, null)).status).toBe(401);
    expect((await upgrade(a, w.c.token, "", {})).status).toBe(426);
    for (const q of ["?after=-1", "?after=x", "?after=1.5", "?after="]) expect((await upgrade(a, w.c.token, q)).status, q).toBe(400);
  });
});

describe("what streams", () => {
  it("a turn's events, in order, with one seq per agent, beside the runner's session and never in its way", async () => {
    const w = await world();
    const s = await w.session();
    const t = await trace(s.agent, w.c.token);
    const turn = await s.turn(w.c.token, "work");
    await s.events([
      { type: "turn_started", turn, input_kind: "user" },
      { type: "assistant_text", turn, text: "looking" },
      { type: "tool_call", turn, call_id: "toolu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", turn, call_id: "toolu_1", is_error: true, summary: "no such file" },
      { type: "state_changed", turn, state: "working", detail: "x" },
      { type: "usage", turn, usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    await s.events([{ type: "escalation", turn, call: "cal_esc1", tool: "Bash", input: { command: "rm -rf /" } }]);
    await s.events([{ type: "turn_completed", turn, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 } }]);
    const got = await readUntil(t, (m) => m.type === "state" && m.state === "idle");
    // The backlog (its start, before this socket) ended with `live`, before the turn.
    const live = got.findIndex((m) => m.type === "live");
    expect(live).toBeGreaterThanOrEqual(0);
    expect(got[live]).toEqual({ type: "live" });
    expect(got.slice(live + 1).some((m) => m.type === "turn_started")).toBe(true);
    const seqs = got.filter((m) => m.type !== "live").map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    const ask = (await asJson(w.c.token, `/v1/agents/${s.agent}/asks`))[0].ask;
    // From its first `working` (the turn's start, sent to the runner) to its `idle`.
    const from = got.findIndex((m) => m.type === "state" && m.state === "working");
    expect(got.slice(from).map(({ seq: _s, ts_ms: _t, ...m }) => m)).toEqual([
      { type: "state", state: "working", turn },
      { type: "turn_started", turn, input_kind: "user" },
      { type: "assistant_text", turn, text: "looking" },
      { type: "tool_call", turn, call_id: "toolu_1", name: "Bash", input: `{"command":"ls"}` },
      { type: "tool_result", turn, call_id: "toolu_1", is_error: true, summary: "no such file" },
      { type: "ask", turn, ask, question: expect.stringContaining("Allow Bash?") },
      { type: "turn_completed", turn, stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      { type: "state", state: "idle" },
    ]);
    for (const m of got.filter((x) => x.type !== "live")) expect(typeof m.ts_ms).toBe("number");
    await asJson(w.c.token, `/v1/agents/${s.agent}/asks/${ask}/answer`, { body: { answer: "no" } });
    expect((await t.next("ask_answered")).ask).toBe(ask);
    // A trace client's frames are ignored; the session socket is unaffected (the answer reaches the runner as its next turn).
    // Even a well-formed runner hello is nothing on a trace socket: no hello_ack, and the runner's session stays.
    t.send({ type: "hello", protocol_version: 1, agent: s.agent, host: w.brain.host, instance_id: `rin_${rand()}`, epoch: s.epoch, session: "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b" });
    expect(await t.none("hello_ack", 300)).toBe(true);
    expect(await t.none("error", 50)).toBe(true);
    const answered = await s.ws.next("run_turn", (m) => m.input.kind === "ask_answer");
    expect(answered.turn).not.toBe(turn);
    expect(s.ws.closed).toBeNull();
    await runInDurableObject(agentStub(s.agent), (_i: unknown, st: DurableObjectState) => {
      expect(st.getWebSockets("session").length).toBe(1);
      expect(st.getWebSockets("trace").length).toBe(1);
    });
    expect(t.closed).toBeNull();
    t.close();
    s.ws.close();
  });

  it("a resent batch is traced once", async () => {
    const w = await world();
    const s = await w.session();
    const turn = await s.turn(w.c.token, "work");
    const ev = { agent: s.agent, epoch: s.epoch, seq: 900, ts_ms: Date.now(), turn, type: "assistant_text", text: "once" };
    // Applied, then the batch's ack is lost and the runner sends it again under a new channel seq after a reconnect: a fresh
    // channel seq with the same event (the dedup table is cleared only for a new lineage).
    await runInDurableObject(agentStub(s.agent), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("DELETE FROM events");
    });
    s.ws.send({ type: "events", seq: 1, events: [ev] });
    await s.ws.next("ack", (m) => m.up_to >= 1);
    await runInDurableObject(agentStub(s.agent), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("DELETE FROM events"); // as if the throw came before its dedup row
    });
    s.ws.send({ type: "events", seq: 2, events: [ev] });
    await s.ws.next("ack", (m) => m.up_to >= 2);
    const t = await trace(s.agent, w.c.token, 0);
    await readUntil(t, (m) => m.type === "state" && m.state === "working");
    await new Promise((r) => setTimeout(r, 100));
    expect(t.drain().filter((m) => m.type === "assistant_text")).toEqual([expect.objectContaining({ text: "once" })]);
    t.close();
    s.ws.close();
  });

  it("redacts and bounds tool inputs and results on the live path", async () => {
    const w = await world();
    const s = await w.session();
    const t = await trace(s.agent, w.c.token);
    const turn = await s.turn(w.c.token, "work");
    const pat = fake.client;
    await s.events([
      { type: "tool_call", turn, call_id: "toolu_2", name: "WebFetch", input: { url: "https://x", headers: { Authorization: fake.bearer("abcdefghijkl") }, body: "y".repeat(20_000) } },
      { type: "tool_result", turn, call_id: "toolu_2", is_error: false, summary: `got ${pat}` },
    ]);
    const call = await t.next("tool_call");
    expect(call.input).not.toContain("abcdefghijkl");
    expect(call.input).toContain(`"Authorization":"${REDACTED}"`);
    expect(utf8(call.input)).toBeLessThanOrEqual(TRACE_FIELD_MAX);
    expect((await t.next("tool_result")).summary).toBe(`got ${REDACTED}`);
    t.close();
    s.ws.close();
  });
});

describe("resume", () => {
  it("`after` gives exactly what was missed, then live events; events gone from the ring come as a gap first", async () => {
    const w = await world();
    const s = await w.session();
    const turn = await s.turn(w.c.token, "work");
    const t1 = await trace(s.agent, w.c.token);
    await s.events([{ type: "assistant_text", turn, text: "one" }]);
    const last = (await t1.next("assistant_text")).seq as number;
    t1.close();
    await s.events([{ type: "assistant_text", turn, text: "two" }, { type: "assistant_text", turn, text: "three" }]);
    const t2 = await trace(s.agent, w.c.token, last);
    const missed = await readUntil(t2, (m) => m.text === "three");
    expect(missed.map((m) => [m.seq, m.text])).toEqual([[last + 1, "two"], [last + 2, "three"]]);
    // Then `live`, next: nothing else was owed.
    await eventually("live", () => t2.received.length > 0);
    expect(t2.received[0]).toEqual({ type: "live" });
    await s.events([{ type: "assistant_text", turn, text: "four" }]);
    expect(await t2.next("assistant_text")).toMatchObject({ seq: last + 3, text: "four" });
    t2.close();
    // The ring lost everything up to `last + 1` (pruned): a client after 1 hears the gap, then the rest.
    await runInDurableObject(agentStub(s.agent), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("DELETE FROM trace WHERE seq <= ?", last + 1);
    });
    const t3 = await trace(s.agent, w.c.token, 1);
    const back = await readUntil(t3, (m) => m.text === "four");
    expect(back[0]).toEqual({ type: "gap", from: 2, to: last + 1 });
    expect(back.slice(1).map((m) => m.seq)).toEqual([last + 2, last + 3]);
    expect(await t3.next("live")).toEqual({ type: "live" });
    t3.close();
    s.ws.close();
  });
});

describe("never blocking the agent", () => {
  it("a socket whose send throws is closed, one whose send never settles is never awaited, and the runner's ack comes regardless", async () => {
    const w = await world();
    const s = await w.session();
    const turn = await s.turn(w.c.token, "work");
    const broken = await trace(s.agent, w.c.token);
    const slow = await trace(s.agent, w.c.token);
    const fine = await trace(s.agent, w.c.token);
    // Each socket's place, as AgentDO numbered them (oldest first).
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO, st: DurableObjectState) => {
      const [b, sl] = st.getWebSockets("trace").sort((x, y) => (x.deserializeAttachment() as any).n - (y.deserializeAttachment() as any).n);
      const nb = (b!.deserializeAttachment() as any).n;
      const ns = (sl!.deserializeAttachment() as any).n;
      inst.testTraceSend = (ws, data) => {
        const n = (ws.deserializeAttachment() as any).n;
        if (n === nb) throw new Error("socket gone");
        ws.send(data);
        return n === ns ? new Promise(() => {}) : undefined;
      };
    });
    try {
      const t0 = Date.now();
      await s.events([{ type: "assistant_text", turn, text: "still acked" }]);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect((await fine.next("assistant_text")).text).toBe("still acked");
      expect((await slow.next("assistant_text")).text).toBe("still acked");
      expect((await broken.whenClosed())?.code).toBe(1011);
      // Later events still go to the others.
      await s.events([{ type: "assistant_text", turn, text: "and again" }]);
      expect((await fine.next("assistant_text")).text).toBe("and again");
    } finally {
      await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
        inst.testTraceSend = null;
      });
    }
    slow.close();
    fine.close();
    s.ws.close();
  });

  it(`holds at most ${TRACE_SOCKETS_MAX} trace sockets: a new one past the cap closes the oldest`, async () => {
    const w = await world();
    const a = await w.unstarted();
    const socks: Ws[] = [];
    for (let i = 0; i < TRACE_SOCKETS_MAX + 1; i++) socks.push(await trace(a, w.c.token));
    expect((await socks[0]!.whenClosed())?.code).toBe(4008);
    for (const ws of socks.slice(1)) expect(ws.closed).toBeNull();
    // The rest still hear what happens.
    await asJson(w.c.token, `/v1/agents/${a}/start`, { method: "POST" });
    for (const ws of socks.slice(1)) expect((await ws.next("state")).state).toBe("starting");
    for (const ws of socks) ws.close();
  });

  it("answers the keepalive without involving AgentDO's handlers", async () => {
    const w = await world();
    const a = await w.unstarted();
    const res = await upgrade(a, w.c.token);
    const ws = res.webSocket!;
    ws.accept();
    const got: string[] = [];
    ws.addEventListener("message", (e) => {
      got.push(e.data as string);
    });
    ws.send("ping");
    await eventually("pong", () => got.includes("pong"));
    ws.close();
  });
});

describe("the end", () => {
  it("sends `ended` and closes once its end is done; a later connect gets it again and is closed", async () => {
    const w = await world();
    const a = await w.unstarted();
    const t = await trace(a, w.c.token);
    await asJson(w.c.token, `/v1/agents/${a}/stop`, { body: { end: true, reason: "finished" } });
    const ended = await t.next("ended", () => true, 8000);
    expect(ended).toMatchObject({ type: "ended", reason: "stopped" });
    expect(typeof ended.seq).toBe("number");
    expect((await t.whenClosed())?.code).toBe(1000);
    // From the start: its backlog ends with the stored `ended`.
    const again = await trace(a, w.c.token);
    const backlog = await readUntil(again, (m) => m.type === "ended");
    expect(backlog.at(-1)).toEqual(ended);
    expect((await again.whenClosed())?.code).toBe(1000);
    expect(again.received.filter((m) => m.type === "live")).toEqual([]);
    // Past it: `ended` again without a seq.
    const past = await trace(a, w.c.token, ended.seq);
    expect(await past.next("ended")).toEqual({ type: "ended", reason: "stopped" });
    expect((await past.whenClosed())?.code).toBe(1000);
  });
});

describe("the minutes after a deploy", () => {
  it("answers a retryable 503 while AgentDO still runs a release without the trace", async () => {
    const w = await world();
    const a = await w.unstarted();
    const proto = AgentDO.prototype as unknown as { fetch: (r: Request) => Promise<Response> };
    const fetch = proto.fetch;
    // The previous release's fetch: only the session route, which refuses a request without a host.
    proto.fetch = async (r: Request) =>
      r.headers.get("upgrade")?.toLowerCase() !== "websocket" || !r.headers.get("x-nest-host")
        ? new Response("expected websocket upgrade", { status: 400 }) : new Response("agent is not assigned to this host", { status: 403 });
    try {
      const res = await upgrade(a, w.c.token);
      expect(res.status).toBe(503);
      expect((await res.json() as any).error).toMatchObject({ code: "internal", retryable: true });
    } finally {
      proto.fetch = fetch;
    }
    const ok = await upgrade(a, w.c.token);
    expect(ok.status).toBe(101);
    ok.webSocket!.accept();
    ok.webSocket!.close();
  });
});
