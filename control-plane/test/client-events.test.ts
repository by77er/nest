// Events to an API client (docs/control-plane/api/clients/#events-to-the-owner): what an agent or sandbox
// in a client's subtree reports reaches that client's webhook, signed, deduplicable, retried with a
// doubling backoff, bounded; and none of it ever holds up an agent. The webhook is a stub (a fetch handler
// for https://hook.test/<id>, installed over the global fetch ClientDO calls) that records each request.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClientDO } from "../src/do/client";
import { BACKLOG_MAX, retryDelayMs, type StampedEvent } from "../src/lib/client-events";
import { adminJson, BASE, connectHost, eventually, nextCommands, runDue, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const clientStub = (id: string) => env.CLIENT.get(env.CLIENT.idFromName(id));
/** vitest.config.ts: CLIENT_WEBHOOK_TIMEOUT_MS. */
const WEBHOOK_TIMEOUT_MS = 2000;

// --- The stub webhook -------------------------------------------------------------------------------------

type Mode = "ok" | "fail" | "hang";
interface Hit { body: string; signature: string | null; at: number; aborted: boolean }

class Hook {
  readonly id = rand();
  readonly hits: Hit[] = [];
  /** What the next request gets; a function of how many came before it. */
  constructor(public mode: Mode | ((n: number) => Mode)) {}

  get url() {
    return `https://hook.test/${this.id}`;
  }

  /** The delivered events, parsed. */
  events(): any[] {
    return this.hits.map((h) => JSON.parse(h.body));
  }

  async handle(req: Request, signal: AbortSignal | null | undefined): Promise<Response> {
    const hit: Hit = { body: await req.text(), signature: req.headers.get("nest-signature"), at: Date.now(), aborted: false };
    const mode = typeof this.mode === "function" ? this.mode(this.hits.length) : this.mode;
    this.hits.push(hit);
    if (mode === "ok") return new Response("ok");
    if (mode === "fail") return new Response("no", { status: 500 });
    // Hangs until the caller gives up, as a real server that never answers would.
    return await new Promise<Response>((_, reject) => {
      signal?.addEventListener("abort", () => {
        hit.aborted = true;
        reject(signal.reason);
      });
    });
  }
}

const hooks = new Map<string, Hook>();
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.hostname !== "hook.test") return realFetch(input as RequestInfo, init);
    const hook = hooks.get(u.pathname.slice(1));
    if (!hook) return new Response("no hook", { status: 404 });
    return hook.handle(req, init?.signal);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// --- Setup ------------------------------------------------------------------------------------------------

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

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };

/** A client on a fresh cell with a no-hands template, and (unless `hook` is null) its webhook. */
async function newClient(hook: Hook | null) {
  const cell = uniqueCell();
  const name = `ev-${rand()}`;
  const grant = { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 10, max_sandboxes: 10 };
  const c = await adminJson("/v1/admin/clients", { body: { name, grant } }, 201);
  await asJson(c.token, `/v1/catalog/templates/${name}/basic`, {
    method: "PUT", body: { capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" },
  });
  let secret: string | null = null;
  if (hook) {
    hooks.set(hook.id, hook);
    secret = (await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: hook.url } })).secret;
  }
  return { id: c.client as string, name, token: c.token as string, cell, tpl: `${name}/basic`, secret };
}
type Client = Awaited<ReturnType<typeof newClient>>;

/** A runner session of an agent: tool calls and event batches share one inbound sequence. */
class Session {
  private seq = 0;
  private evSeq = 0;
  constructor(readonly ws: Ws, readonly agent: string, readonly epoch: number) {}

  async events(evs: Record<string, unknown>[]): Promise<void> {
    const seq = ++this.seq;
    this.ws.send({ type: "events", seq, events: evs.map((e) => ({ agent: this.agent, epoch: this.epoch, seq: ++this.evSeq, ts_ms: Date.now(), ...e })) });
    await this.ws.next("ack", (m) => m.up_to >= seq);
  }

  async run(name: string, args: unknown): Promise<any> {
    const call = `cal_${rand()}`;
    this.ws.send({ type: "tool_call", seq: ++this.seq, call, turn: "trn_x", name, arguments: args });
    return (await this.ws.next("tool_result", (m) => m.call === call, 8000)).outcome;
  }

  /** Post a turn and wait for it to reach the runner. */
  async turn(token: string, text: string): Promise<string> {
    await asJson(token, `/v1/agents/${this.agent}/turns`, { body: { text } }, 201);
    return (await this.ws.next("run_turn", (m) => m.input.text === text)).turn as string;
  }

  /** The turn's final words, then its end. */
  complete(turn: string, text = `done with ${turn}`): Promise<void> {
    return this.events([{ type: "assistant_text", turn, text }, { type: "turn_completed", turn, stop_reason: "end_turn" }]);
  }
}

/** An agent of `c` (or the operator's, `c` null) on a brain host of `cell`, with its runner session. */
async function agentWithSession(cell: string, c: Client | null, brain: Awaited<ReturnType<typeof connectHost>>): Promise<Session> {
  let a;
  if (c) a = await asJson(c.token, "/v1/agents", { body: { template: c.tpl, cell } }, 201);
  else {
    const tpl = `op-${rand()}`;
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: { capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" } });
    a = await adminJson("/v1/agents", { body: { template: tpl, cell } }, 201);
  }
  const [start] = (await nextCommands(brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent)).filter((x) => x.agent === a.agent);
  const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, brain.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b" });
  await ws.next("hello_ack");
  return new Session(ws, a.agent, start.epoch);
}

async function world(hook: Hook | null) {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const c = await newClient(hook);
  const brain = await connectHost(c.cell, "brain");
  return { c, brain, session: () => agentWithSession(c.cell, c, brain) };
}

/** What a client does with a delivery: `t` and `v1` from the header, checked against HMAC-SHA256(secret, "<t>.<body>"). */
async function verifies(secret: string, hit: Hit): Promise<boolean> {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(hit.signature ?? "");
  if (!m) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = new Uint8Array(m[2]!.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, mac, enc.encode(`${m[1]}.${hit.body}`));
}

/** Its events' state, as the client reads it. */
const view = async (c: Client) => (await asJson(c.token, "/v1/clients/self")).events;
const outboxRows = (agent: string) => runInDurableObject(agentStub(agent), (_i: unknown, st: DurableObjectState) =>
  st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM client_events").one().n);
const ev = (id: string): StampedEvent => ({ id, type: "sandbox.destroyed", sandbox: `sbx_${id}` });

// --- Pure -------------------------------------------------------------------------------------------------

describe("the retry schedule (pure)", () => {
  it("waits 1 s after the first failure, doubling each time, capped at 5 minutes", () => {
    const want = [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300].map((s) => s * 1000);
    expect(want.map((_, i) => retryDelayMs(i + 1))).toEqual(want);
    expect(retryDelayMs(10_000)).toBe(300_000);
  });
});

// --- The webhook ------------------------------------------------------------------------------------------

describe("the webhook", () => {
  it("is set by the client alone, https only; its secret is answered once and never shown again", async () => {
    const c = await newClient(null);
    await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "http://hook.test/x" } }, 400);
    await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "https://u:p@hook.test/x" } }, 400);
    await adminJson("/v1/clients/self/webhook", { method: "PUT", body: { url: "https://hook.test/x" } }, 403);
    const set = await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "https://hook.test/x" } });
    expect(set.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    // Neither the client's own record nor the operator's view shows it.
    for (const shown of [await asJson(c.token, "/v1/clients/self"), await adminJson(`/v1/admin/clients/${c.id}`)]) {
      expect(shown).toMatchObject({ client: c.id, events: { webhook: "https://hook.test/x" } });
      expect(JSON.stringify(shown)).not.toContain(set.secret);
    }
    expect(await view(c)).toEqual({ webhook: "https://hook.test/x", backlog: 0, dropped: 0, failures: 0, last_error: null });
    // Set again: a new secret.
    expect((await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "https://hook.test/x" } })).secret).not.toBe(set.secret);
  });

  it("answers a retryable 503 while ClientDO still runs a release without setWebhook (the minutes after a deploy)", async () => {
    const c = await newClient(null);
    const proto = ClientDO.prototype as unknown as Record<string, unknown>;
    const method = proto.setWebhook;
    delete proto.setWebhook;
    try {
      const e = await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "https://hook.test/y" } }, 503);
      expect(e.error).toMatchObject({ code: "internal", retryable: true });
    } finally {
      proto.setWebhook = method;
    }
    await asJson(c.token, "/v1/clients/self/webhook", { method: "PUT", body: { url: "https://hook.test/y" } });
  });
});

// --- What a client hears ----------------------------------------------------------------------------------

describe("events from a client's subtree", () => {
  it("a turn's end, an ask, an error and the agent's exit reach its webhook, signed with its secret", async () => {
    const hook = new Hook("ok");
    const w = await world(hook);
    const s = await w.session();
    const turn = await s.turn(w.c.token, "work");
    await s.events([{ type: "assistant_text", turn, text: "first words" }]);
    await s.events([{ type: "escalation", turn, call: "cal_esc1", tool: "Bash", input: { command: "ls" } }]);
    await s.events([{ type: "error", turn, error: { code: "error_max_turns", message: "too many turns", retryable: true } }]);
    await s.complete(turn, "final words");
    const evs = await eventually("three events", () => (hook.hits.length >= 3 ? hook.events() : null));
    const ask = (await asJson(w.c.token, `/v1/agents/${s.agent}/asks`))[0].ask;
    expect(evs.map(({ id: _id, ...e }) => e)).toEqual([
      { type: "agent.ask", agent: s.agent, ask, question: expect.stringContaining("Allow Bash?") },
      { type: "agent.error", agent: s.agent, code: "error_max_turns", message: "too many turns" },
      { type: "agent.turn_completed", agent: s.agent, turn, text: "final words" },
    ]);
    expect(new Set(evs.map((e) => e.id)).size).toBe(3);
    for (const h of hook.hits) expect(await verifies(w.c.secret!, h), h.signature ?? "no signature").toBe(true);
    // Another secret doesn't verify (the signature covers the secret, the time and the body).
    expect(await verifies(`${w.c.secret}0`, hook.hits[0]!)).toBe(false);
    expect(await verifies(w.c.secret!, { ...hook.hits[0]!, body: hook.hits[0]!.body.replace("Bash", "bash") })).toBe(false);

    // Its exit: once its end is done, with the note it gave.
    const next = await s.turn(w.c.token, "finish");
    expect(await s.run("exit", { reason: "all done" })).toMatchObject({ status: "ok" });
    await s.complete(next);
    await nextCommands(w.brain.ws, (x) => x.type === "agent_stop" && x.agent === s.agent);
    const seq = sendEvents(w.brain.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: s.epoch }]);
    await w.brain.ws.next("ack", (m) => m.up_to >= seq);
    const exited = await eventually("agent.exited", () => hook.events().find((e) => e.type === "agent.exited"));
    expect(exited).toMatchObject({ agent: s.agent, reason: "exited", text: "all done" });
    s.ws.close();
  });

  it("an agent whose brain can't start (errored) is reported as an error", async () => {
    const hook = new Hook("ok");
    const w = await world(hook);
    const a = await asJson(w.c.token, "/v1/agents", { body: { template: w.c.tpl, cell: w.c.cell } }, 201);
    await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === a.agent);
    // No hello: its start deadline, made due now.
    await runInDurableObject(agentStub(a.agent), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'starting'");
    });
    await runDue(agentStub(a.agent));
    expect((await agentStub(a.agent).info()).lifecycle).toBe("errored");
    const e = await eventually("agent.error", () => hook.events().find((x) => x.type === "agent.error"));
    expect(e).toMatchObject({ agent: a.agent, code: "errored" });
  });

  it("only the owning client hears: not another client, and nobody for the operator's agents", async () => {
    const a = new Hook("ok");
    const b = new Hook("ok");
    const w = await world(a);
    await newClient(b);
    // Every hand-off, by the ClientDO it reached.
    const handed: { to: string; events: StampedEvent[] }[] = [];
    const orig = ClientDO.prototype.enqueue;
    ClientDO.prototype.enqueue = function (this: ClientDO, events: StampedEvent[]) {
      handed.push({ to: (this as any).ctx.id.toString(), events });
      return orig.call(this, events);
    };
    try {
      // The operator's agent first: anything it wrongly reported is handed over before A's last event is.
      const op = await agentWithSession(w.c.cell, null, w.brain);
      await adminJson(`/v1/agents/${op.agent}/turns`, { body: { text: "op" } }, 201);
      await op.complete((await op.ws.next("run_turn")).turn as string);
      const sa = await w.session();
      await sa.complete(await sa.turn(w.c.token, "a"));
      // A sandbox of the client, destroyed.
      const sbx = (await asJson(w.c.token, "/v1/sandboxes", { body: { cell: w.c.cell } })).sandbox as string;
      await asJson(w.c.token, `/v1/sandboxes/${sbx}`, { method: "DELETE" });
      await eventually("a's two events", () => a.hits.length >= 2);
      expect(a.events().map((e) => [e.type, e.agent ?? e.sandbox])).toEqual([["agent.turn_completed", sa.agent], ["sandbox.destroyed", sbx]]);
      await sleep(200); // room for a wrong delivery to land
      expect(b.hits).toEqual([]);
      expect(a.hits).toHaveLength(2);
      const mine = env.CLIENT.idFromName(w.c.id).toString();
      expect(handed.some((h) => h.to === mine)).toBe(true);
      expect(handed.filter((h) => h.to !== mine)).toEqual([]);
      expect(handed.flatMap((h) => h.events).some((e) => "agent" in e && e.agent === op.agent)).toBe(false);
      expect(await outboxRows(op.agent)).toBe(0);
      sa.ws.close();
      op.ws.close();
    } finally {
      ClientDO.prototype.enqueue = orig;
    }
  });
});

// --- Never blocking an agent ------------------------------------------------------------------------------

describe("a slow, failing or absent client never blocks an agent", () => {
  for (const mode of ["hang", "fail", "unset"] as const) {
    it(`its webhook ${mode === "unset" ? "unset" : `that ${mode}s`}: the agent's turns go on, and what it reported waits or goes`, async () => {
      const hook = mode === "unset" ? null : new Hook(mode);
      const w = await world(hook);
      const s = await w.session();
      for (const text of ["one", "two", "three"]) await s.complete(await s.turn(w.c.token, text));
      expect((await agentStub(s.agent).turns()).map((t) => t.status)).toEqual(["done", "done", "done"]);
      // Handed over all the same: with a webhook it waits at the client, without one nobody hears it.
      await eventually("the hand-off", async () => (await outboxRows(s.agent)) === 0);
      if (hook) {
        await eventually("an attempt", () => hook.hits.length > 0);
        expect((await view(w.c)).backlog).toBe(3);
      } else {
        expect((await view(w.c)).backlog).toBe(0);
      }
      s.ws.close();
    });
  }

  it("while ClientDO doesn't answer or refuses (a busy one on the previous release), turns go on; the hand-off is retried", async () => {
    const hook = new Hook("ok");
    const w = await world(hook);
    const s = await w.session();
    const orig = ClientDO.prototype.enqueue;
    let mode: "hang" | "refuse" = "hang";
    let calls = 0;
    ClientDO.prototype.enqueue = function (this: ClientDO, ...args: Parameters<ClientDO["enqueue"]>) {
      calls++;
      if (mode === "hang") return new Promise<void>(() => undefined);
      throw new Error("ClientDO does not implement the method enqueue");
    } as ClientDO["enqueue"];
    try {
      const one = await s.turn(w.c.token, "one");
      await s.complete(one);
      await eventually("a hand-off held", () => calls > 0);
      // Held at ClientDO: the agent takes and finishes its next turn.
      await s.complete(await s.turn(w.c.token, "two"));
      mode = "refuse";
      await s.complete(await s.turn(w.c.token, "three"));
      expect(await outboxRows(s.agent)).toBe(3);
    } finally {
      ClientDO.prototype.enqueue = orig;
    }
    // Retried (the deadline's 5 s, after a held call's 10 s timeout at most): each event delivered once.
    await eventually("three deliveries", () => hook.hits.length >= 3, 20_000);
    await sleep(200);
    expect(hook.events().map((e) => e.type)).toEqual(["agent.turn_completed", "agent.turn_completed", "agent.turn_completed"]);
    expect(new Set(hook.events().map((e) => e.id)).size).toBe(3);
    s.ws.close();
  }, 30_000);
});

// --- Across a rollback ------------------------------------------------------------------------------------

describe("deadlines a rolled-back release dropped (it has no handler for them)", () => {
  it("an agent's waiting events are handed over at its next alarm", async () => {
    const hook = new Hook("ok");
    const w = await world(hook);
    const a = await asJson(w.c.token, "/v1/agents", { body: { template: w.c.tpl, cell: w.c.cell, start: false } }, 201);
    await runInDurableObject(agentStub(a.agent), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("INSERT INTO client_events (client, id, body) VALUES (?, 'r1', ?)", w.c.id, JSON.stringify(ev("r1")));
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'client_events'");
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(agentStub(a.agent));
    expect(await eventually("the delivery", () => hook.events()[0])).toMatchObject({ id: "r1" });
  });

  it("a client's backlog is delivered from its next hourly prune", async () => {
    const hook = new Hook("ok");
    const c = await newClient(hook);
    await runInDurableObject(clientStub(c.id), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("INSERT INTO outbox (id, body) VALUES ('r2', ?)", JSON.stringify(ev("r2")));
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'deliver'");
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    await runDue(clientStub(c.id));
    expect(await eventually("the delivery", () => hook.events()[0])).toMatchObject({ id: "r2" });
  });
});

// --- Delivery ---------------------------------------------------------------------------------------------

describe("delivery", () => {
  it("a failed delivery is retried after 1 s, then 2 s, with the same id and body; a success resets the schedule", async () => {
    const hook = new Hook((n) => (n < 2 ? "fail" : "ok"));
    const c = await newClient(hook);
    await clientStub(c.id).enqueue([ev(`e${rand()}`)]);
    await eventually("the third attempt", () => hook.hits.length >= 3, 8000);
    const [h1, h2, h3] = hook.hits;
    expect(h2!.at - h1!.at).toBeGreaterThanOrEqual(1000);
    expect(h3!.at - h2!.at).toBeGreaterThanOrEqual(2000);
    expect(new Set(hook.hits.map((h) => h.body)).size).toBe(1);
    expect(await eventually("the backlog delivered", async () => (await view(c)).backlog === 0 && view(c))).toMatchObject({ failures: 0, last_error: null });
  }, 15_000);

  it("the wait doubles from the failures counted so far, and stops doubling at 5 minutes", async () => {
    const hook = new Hook("fail");
    const c = await newClient(hook);
    const stub = clientStub(c.id);
    // Planted: `n` failures so far and a delivery due now. One run follows; the next is minutes away.
    const after = async (n: number) => {
      await runInDurableObject(stub, (_i: ClientDO, st: DurableObjectState) => {
        st.storage.sql.exec("INSERT OR IGNORE INTO outbox (id, body) VALUES ('x', '{}')");
        st.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('delivery', ?)", JSON.stringify({ failures: n, dropped: 0 }));
        st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('deliver', 0)");
      });
      await runDue(stub);
      return runInDurableObject(stub, (_i: ClientDO, st: DurableObjectState) => {
        const d = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'delivery'").one().value);
        const at = st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'deliver'").one().at;
        return { failures: d.failures as number, wait: at - (d.failed_ms as number) };
      });
    };
    expect(await after(0)).toEqual({ failures: 1, wait: 1000 });
    expect(await after(8)).toEqual({ failures: 9, wait: 256_000 });
    expect(await after(9)).toEqual({ failures: 10, wait: 300_000 });
    expect(await after(30)).toEqual({ failures: 31, wait: 300_000 });
  });

  it("an attempt with no answer is cut off after the timeout and counts as a failure", async () => {
    const hook = new Hook((n) => (n === 0 ? "hang" : n === 1 ? "fail" : "ok"));
    const c = await newClient(hook);
    await clientStub(c.id).enqueue([ev(`e${rand()}`)]);
    // ClientDO takes more while its delivery hangs (well inside the 2 s it hangs for).
    await eventually("the hanging attempt", () => hook.hits.length === 1);
    await clientStub(c.id).enqueue([ev(`f${rand()}`)]);
    expect(hook.hits[0]!.aborted).toBe(false);
    expect((await view(c)).backlog).toBe(2);
    // Cut off at the timeout, counted as the first failure (the next attempt 1 s later), and recorded as such.
    await eventually("the second attempt", () => hook.hits.length === 2, WEBHOOK_TIMEOUT_MS + 3000);
    expect(hook.hits[0]!.aborted).toBe(true);
    expect(hook.hits[1]!.at - hook.hits[0]!.at).toBeGreaterThanOrEqual(WEBHOOK_TIMEOUT_MS + 1000);
    await eventually("both delivered", () => hook.hits.length === 4, 5000);
    expect(hook.hits[2]!.at - hook.hits[1]!.at).toBeGreaterThanOrEqual(2000);
    expect(await eventually("the backlog delivered", async () => (await view(c)).backlog === 0)).toBe(true);
  }, 15_000);

  it("the last failure's reason is in the client's record until a delivery succeeds", async () => {
    const hook = new Hook("hang");
    const c = await newClient(hook);
    await clientStub(c.id).enqueue([ev(`e${rand()}`)]);
    expect(await eventually("the failure recorded", async () => (await view(c)).failures > 0 && view(c), WEBHOOK_TIMEOUT_MS + 3000))
      .toMatchObject({ backlog: 1, last_error: `no answer within ${WEBHOOK_TIMEOUT_MS} ms` });
  }, 15_000);

  it("an event handed over twice is kept once", async () => {
    const hook = new Hook("fail");
    const c = await newClient(hook);
    const e = ev(`e${rand()}`);
    await clientStub(c.id).enqueue([e]);
    await clientStub(c.id).enqueue([e, ev(`f${rand()}`)]);
    expect((await view(c)).backlog).toBe(2);
  });

  it(`the backlog holds ${BACKLOG_MAX}: past it the oldest go, counted in the client's record`, async () => {
    const hook = new Hook("fail");
    const c = await newClient(hook);
    const tag = rand();
    const events = Array.from({ length: BACKLOG_MAX + 3 }, (_, i) => ev(`${tag}-${i}`));
    await clientStub(c.id).enqueue(events.slice(0, BACKLOG_MAX));
    await clientStub(c.id).enqueue(events.slice(BACKLOG_MAX));
    expect(await view(c)).toMatchObject({ backlog: BACKLOG_MAX, dropped: 3 });
    const kept = await runInDurableObject(clientStub(c.id), (_i: ClientDO, st: DurableObjectState) =>
      st.storage.sql.exec<{ id: string }>("SELECT id FROM outbox ORDER BY seq").toArray().map((r) => r.id));
    expect(kept[0]).toBe(`${tag}-3`);
    expect(kept[kept.length - 1]).toBe(`${tag}-${BACKLOG_MAX + 2}`);
  });
});
