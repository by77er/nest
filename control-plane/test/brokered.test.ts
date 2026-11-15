// Brokered actions and egress widening (docs/agents/tools/#taint-and-sinks): the pipeline end to end
// inside the pool. A runner session calls `http_request`, `brokered` or `egress_policy`; each profile's
// server is a stub (a fetch handler for https://http.test/<id>/…, installed over the global fetch AgentDO
// calls) that records every request. Each guarantee has a test that fails without it.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { secretNeedles } from "../src/do/broker";
import { authorize, type BrokeredGrant, brokeredToolDefs, grantOfEntry, pathCovered, REMOVED_ACTIONS, safePath } from "../src/lib/brokered";
import { CallLedger } from "../src/lib/calls";
import { bytesToB64 } from "../src/lib/util";
import { adminJson, connectHost, nextCommands, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const catalogStub = () => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

// --- An http profile's server ----------------------------------------------------------------------------

class HttpStub {
  readonly requests: { method: string; path: string; search: string; headers: Record<string, string>; body: string }[] = [];
  readonly next: { delay?: number; status?: number; location?: string }[] = [];
  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const headers = Object.fromEntries(req.headers);
    this.requests.push({ method: req.method, path: u.pathname, search: u.search, headers, body: req.method === "GET" ? "" : await req.text() });
    const b = this.next.shift() ?? {};
    if (b.delay) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, b.delay);
        req.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }
    if (b.location) return new Response(null, { status: b.status ?? 302, headers: { location: b.location } });
    // Echoes what it got, the credential included: the proxy must mask it.
    return new Response(JSON.stringify({ path: u.pathname, auth: headers.authorization ?? null, n: this.requests.length }), {
      status: b.status ?? 200, headers: { "content-type": "application/json" },
    });
  }
}

const stubs = new Map<string, HttpStub>();
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    const u = new URL(req.url);
    if (u.hostname === "http.test") return stubs.get(u.pathname.split("/")[1]!)?.handle(req) ?? new Response("no stub", { status: 503 });
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

// --- Setup -------------------------------------------------------------------------------------------------

/** An agent whose one capability grants `brokered` (and the platform `tools`), with a runner session. */
async function setup(brokered: unknown[], opts: { tools?: string[]; hands?: boolean } = {}) {
  const id = rand();
  const cap = `b${id}`;
  await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: { tools: opts.tools ?? [], brokered } });
  const tpl = `t-${id}`;
  await adminJson(`/v1/admin/templates/${tpl}`, {
    method: "PUT",
    body: {
      capabilities: ["nest", cap], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } },
      hands: opts.hands ? "required" : "forbidden", credential: "claude_oauth_token",
    },
  });
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  let sandbox: string | undefined;
  let sbxHost: Awaited<ReturnType<typeof connectHost>> | undefined;
  if (opts.hands) {
    sbxHost = await connectHost(cell);
    sandbox = (await adminJson("/v1/sandboxes", { body: { cell } }, 201)).sandbox;
    await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  }
  const host = await connectHost(cell, "brain");
  const ag = await adminJson("/v1/agents", { body: { template: tpl, cell, ...(sandbox ? { sandbox } : {}) } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === ag.agent);
  const ws = await Ws.connect(`/v1/agents/${ag.agent}/session`, host.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: ag.agent, host: host.host, instance_id: "rin_one", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  return { id, agent: ag.agent as string, ws, sandbox, sbxHost };
}

const seqs = new WeakMap<Ws, number>();
function call(ws: Ws, callId: string, name: string, args: unknown) {
  const seq = (seqs.get(ws) ?? 0) + 1;
  seqs.set(ws, seq);
  ws.send({ type: "tool_call", seq, call: callId, turn: "trn_x", name, arguments: args });
}
/** What another delivery of a call settled it as. */
const STANDING = { status: "ok", content: [{ type: "text", text: "made by the other delivery" }] };

/**
 * Just before `callId`'s request would leave (its epoch check), its journal row is settled, as another
 * delivery of the same call finishing first would leave it.
 */
async function settleBeforeSend(agent: string, callId: string, action: string, target: string): Promise<void> {
  await runInDurableObject(agentStub(agent), (inst: AgentDO) => {
    inst.testHooks["dispatch:beforeWrite"] = async () => {
      delete inst.testHooks["dispatch:beforeWrite"];
      (inst as any).journal.settle({ key: `${agent}/1/${callId}`, action, target, idem: "i", digest: "d", args: "{}", tainted: false }, "done", STANDING, "by the other delivery");
    };
  });
}

const result = async (ws: Ws, callId: string, timeoutMs = 6000) => (await ws.next("tool_result", (m) => m.call === callId, timeoutMs)).outcome;
const run = async (ws: Ws, name: string, args: unknown) => {
  const id = `cal_${rand()}`;
  call(ws, id, name, args);
  return result(ws, id);
};
const taint = (agent: string) => runInDurableObject(agentStub(agent), (inst: AgentDO) => (inst as any).kvPut("read_tainted", true));
const tainted = (agent: string) => runInDurableObject(agentStub(agent), (_: AgentDO, st) =>
  JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'read_tainted'").toArray()[0]?.value ?? "false") as boolean);
const answer = (agent: string, ask: string, text: string) => adminJson(`/v1/agents/${agent}/asks/${ask}/answer`, { body: { answer: text } });
const lastTurn = async (agent: string) => (await agentStub(agent).turns()).at(-1)!.input as { kind: string; text: string };
const journal = (agent: string) => adminJson(`/v1/agents/${agent}/brokered`);
/** Every event on the agent's trace ring, as stored. */
const traceRows = (agent: string) => runInDurableObject(agentStub(agent), (_: AgentDO, st) =>
  st.storage.sql.exec<{ body: string }>("SELECT body FROM trace ORDER BY seq").toArray().map((r) => JSON.parse(r.body) as Record<string, any>));
const outbound = async (agent: string) => (await traceRows(agent)).filter((e) => e.type === "outbound");
/**
 * An agent granted profile `p` (`GET`/`POST` under `/v1/items`, its credential `http:p<id>`, `allow` when
 * tainted unless `extra` says otherwise) on its own stub, plus the entries in `more`.
 */
async function profileSetup(extra: Record<string, unknown> = {}, more: unknown[] = [], opts: { tools?: string[] } = {}) {
  const id = rand();
  const stub = new HttpStub();
  stubs.set(id, stub);
  const secret = `prof-${rand()}-credential`;
  await adminJson(`/v1/admin/secrets/http:p${id}`, { method: "PUT", body: { value: secret } });
  const s = await setup([{ action: "http.request", profile: "p", base_url: `https://http.test/${id}`, methods: ["GET", "POST"], paths: ["/v1/items"],
    // Its answers taint the session; the gate on its calls is tested on its own below.
    auth: { secret: `http:p${id}` }, when_tainted: "allow", ...extra }, ...more], opts);
  return { ...s, stub, secret, sid: id };
}

// --- Pure parts --------------------------------------------------------------------------------------------

describe("authority and the scan (pure)", () => {
  const g = (e: unknown) => grantOfEntry("c", e as any);
  it("a profile covers its methods and whole-segment paths; read-only is no sink; the balanced default is approve", () => {
    const rw = g({ action: "http.request", profile: "p", base_url: "https://api.example.com/", methods: ["GET", "POST"], paths: ["/v1/items"] });
    const ro = g({ action: "http.request", profile: "q", base_url: "https://api.example.com", methods: ["GET", "HEAD"], per_hour: 5 });
    expect(rw).toMatchObject({ base_url: "https://api.example.com", when_tainted: "approve", per_hour: 60, trusted: false });
    const req = (profile: string, method: string, path: string) => authorize([rw, ro], "http.request", { profile, method, path });
    expect(req("p", "POST", "/v1/items/3")).toMatchObject({ ok: true, value: { target: "p", sink: true, when_tainted: "approve", per_hour: 60 } });
    expect(req("q", "GET", "/anything")).toMatchObject({ ok: true, value: { target: "q", sink: false, per_hour: 5 } });
    for (const [profile, method, path] of [["p", "DELETE", "/v1/items"], ["p", "GET", "/v1/itemsx"], ["p", "GET", "/v1/items/../x"], ["p", "GET", "/v1/items/%2e%2e"],
      ["p", "GET", "/v1/items//x"], ["q", "GET", "x"], ["r", "GET", "/"]] as const) {
      expect(req(profile, method, path).ok, `${profile} ${method} ${path}`).toBe(false);
    }
    expect(pathCovered("/v1/", "/v1/x")).toBe(true);
    expect(safePath("/a/./b")).toBe(false);
  });

  it("a stored grant of a removed action (a spec from before it went) covers nothing and makes no tool: no removed action is back in the registry", () => {
    const rw = g({ action: "http.request", profile: "p", base_url: "https://api.example.com", methods: ["GET"] });
    // As the previous release stored them: unscoped, so they would cover any repo.
    const stale = REMOVED_ACTIONS.map((action) => ({ capability: "old", action, repos: null, when_tainted: "allow", per_hour: 30 }) as unknown as BrokeredGrant);
    expect(brokeredToolDefs([...stale, rw]).map((t) => t.name)).toEqual(["http_request"]);
    expect(brokeredToolDefs(stale)).toEqual([]);
    for (const action of REMOVED_ACTIONS) {
      expect(authorize(stale, action as "http.request", { repo: "o/r", profile: "p", method: "GET", path: "/" }).ok, action).toBe(false);
    }
  });

  it("the scan looks for a stored value raw, base64'd, inside JSON, or as a PEM's body", () => {
    const n = secretNeedles(JSON.stringify({ client_id: "short", client_secret: "aaaaaaaaaaaaaaaa-secret" }));
    expect(n).toContain("aaaaaaaaaaaaaaaa-secret");
    expect(n).not.toContain("short");
    expect(secretNeedles("tiny")).toEqual([]);
    expect(secretNeedles("a-long-enough-value")).toContain(btoa("a-long-enough-value"));
    // A PEM-armoured value (built at run time: no key block in the source) yields its 64-character body lines.
    const body = bytesToB64(crypto.getRandomValues(new Uint8Array(96))).match(/.{1,64}/g)!;
    const armor = (edge: string) => `-----${edge} ${"PRIVATE KEY"}-----`;
    const needles = secretNeedles([armor("BEGIN"), ...body, armor("END"), ""].join("\n"));
    expect(needles).toContain(body[0]);
  });
});

// --- The pipeline, through profiles -----------------------------------------------------------------------------

describe("the brokered pipeline", () => {
  it("lists one tool per granted action, narrowed to the profiles; a call goes out once and is journaled", async () => {
    const p = await profileSetup({}, [{ action: "http.request", profile: "other", base_url: "https://http.test/none", methods: ["GET"] }]);
    const tools = (p.ws.send({ type: "tools_list_request", request: `req_${rand()}` }), (await p.ws.next("tools_list")).tools as any[]);
    const brokered = tools.filter((t) => t.name === "http_request" || t.name.startsWith("github_") || t.name === "email_send");
    expect(brokered.map((t) => t.name)).toEqual(["http_request"]);
    expect(brokered[0].input_schema.properties.profile.enum).toEqual(["p", "other"]);
    expect((await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" })).status).toBe("ok");
    expect(p.stub.requests).toHaveLength(1);
    const j = await journal(p.agent);
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ action: "http.request", target: "p", status: "done", attempts: 1, tainted: false, detail: "HTTP 200" });
    expect(j[0].idem).toMatch(/^http:p:[0-9a-f]{24}$/);
  });

  it("refuses an action it doesn't grant, a profile it doesn't grant and an action that isn't one; an mcp capability may not shadow a brokered tool", async () => {
    // No brokered grant at all: the action's own tool doesn't exist for it, and `brokered` reaches nothing.
    const none = await setup([], { tools: ["brokered"] });
    const req = { profile: "p", method: "GET", path: "/v1/items" };
    expect(await run(none.ws, "http_request", req)).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    expect(await run(none.ws, "brokered", { action: "http.request", args: req }))
      .toMatchObject({ status: "error", error: { code: "forbidden", message: expect.stringContaining("http.request isn't granted to this agent") } });
    expect(await journal(none.agent)).toEqual([]);
    const p = await profileSetup({}, [], { tools: ["brokered"] });
    expect(await run(p.ws, "brokered", { action: "http.request", args: { profile: "nope", method: "GET", path: "/v1/items" } }))
      .toMatchObject({ status: "error", error: { code: "forbidden" } });
    for (const action of ["email.send", "github.create_pr", "nothing.here"]) {
      expect(await run(p.ws, "brokered", { action, args: {} }), action).toMatchObject({ status: "error", error: { code: "invalid_message" } });
    }
    expect(p.stub.requests).toEqual([]);
    const put = (name: string, body: unknown, status: number) => adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body }, status);
    expect((await put("http", { mcp: { url: "https://mcp.example.com/mcp", auth: "cap:x" } }, 400)).error.message).toContain("http_request");
    // A removed action's tool stays reserved while stored grants of it may exist (a rollback runs them again).
    expect((await put("github", { mcp: { url: "https://mcp.example.com/mcp", auth: "cap:x" } }, 400)).error.message).toContain("github_comment");
    expect((await put("email", { mcp: { url: "https://mcp.example.com/mcp", auth: "cap:x" } }, 400)).error.message).toContain("email_send");
  });

  it("a call whose brain stopped being current before it left never reaches the profile", async () => {
    const p = await profileSetup();
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        (inst as any).update((i: any) => {
          i.agent_epoch += 1;
          i.brain.epoch = i.agent_epoch;
        });
      };
    });
    call(p.ws, "cal_f1", "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" });
    await p.ws.next("ack", (m) => m.up_to >= 1);
    const outcome = await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).calls.call("cal_f1")?.outcome);
    expect(outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    expect(p.stub.requests).toEqual([]);
  });

  it("a redelivered call that left before reads as unknown unless the request is retryable: a POST isn't sent again, a GET is", async () => {
    const p = await profileSetup();
    // A call an earlier incarnation sent and never settled (its tool_calls row still dispatching, its journal row `sending`).
    const plant = (callId: string) => runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      (inst as any).calls.begin(1, callId, "http_request");
      (inst as any).journal.sending({ key: `${p.agent}/1/${callId}`, action: "http.request", target: "p", idem: "i", digest: "d", args: "{}", tainted: false });
    });
    await plant("cal_redo1");
    call(p.ws, "cal_redo1", "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" });
    expect(await result(p.ws, "cal_redo1")).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect(p.stub.requests).toEqual([]);
    await plant("cal_redo2");
    call(p.ws, "cal_redo2", "http_request", { profile: "p", method: "GET", path: "/v1/items" });
    expect((await result(p.ws, "cal_redo2")).status).toBe("ok");
    expect(p.stub.requests).toHaveLength(1);
    const j = await journal(p.agent);
    expect(j.find((e: any) => e.key.endsWith("/cal_redo1"))).toMatchObject({ status: "unknown", attempts: 1 });
    expect(j.find((e: any) => e.key.endsWith("/cal_redo2"))).toMatchObject({ status: "done", attempts: 2 });
  });

  it("a call first begun over a week ago and redelivered now gets its result, even when the hourly prune runs under its dispatch", async () => {
    const p = await profileSetup();
    // An earlier incarnation began the call and never finished it; its row is past the retention.
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO, st) => {
      (inst as any).calls.begin(1, "cal_old1", "http_request");
      st.storage.sql.exec("UPDATE tool_calls SET created_ms = ? WHERE call = 'cal_old1'", Date.now() - 8 * 86_400_000);
      // The prune fires while the redelivered call is out.
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        (inst as any).prune();
      };
    });
    call(p.ws, "cal_old1", "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" });
    expect((await result(p.ws, "cal_old1")).status).toBe("ok");
    expect(p.stub.requests).toHaveLength(1);
  });

  it("an action is capped per hour; refused calls don't count", async () => {
    const p = await profileSetup({ per_hour: 2 });
    const stored = `s3cr3t-${rand()}-value`;
    await adminJson(`/v1/admin/secrets/http:cap${p.id}`, { method: "PUT", body: { value: stored } });
    const post = (body: string) => run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body });
    expect((await post(stored)).status).toBe("error"); // refused by the scan
    expect((await post("1")).status).toBe("ok");
    expect((await post("2")).status).toBe("ok");
    expect(await post("3")).toMatchObject({ status: "error", error: { code: "rate_limited", retryable: true } });
    expect(p.stub.requests).toHaveLength(2);
  });
});

// --- The secret scan -------------------------------------------------------------------------------------

describe("the secret scan", () => {
  it("arguments holding any stored secret's value are refused before anything is asked or sent, without the value in the error; the journal names which secret", async () => {
    const p = await profileSetup({ when_tainted: "approve" }); // a tainted call would be asked
    await taint(p.agent);
    const stored = `s3cr3t-${rand()}-value`;
    await adminJson(`/v1/admin/secrets/http:leak${p.id}`, { method: "PUT", body: { value: stored } });
    for (const args of [{ body: `look: ${stored}` }, { query: { q: `b64 ${btoa(stored)}` } }]) {
      const o = await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", ...args });
      expect(o).toMatchObject({ status: "error", error: { code: "forbidden", message: "Not sent: the arguments contain a credential nest holds. Remove it and call again." } });
      expect(JSON.stringify(o)).not.toContain(stored);
    }
    expect(await adminJson(`/v1/agents/${p.agent}/asks`)).toEqual([]); // the operator was never asked to approve a leak
    expect(p.stub.requests).toEqual([]);
    const j = await journal(p.agent);
    expect(j.map((e: any) => e.status)).toEqual(["refused", "refused"]);
    expect(j.map((e: any) => e.detail)).toEqual([`the value of http:leak${p.id}`, `the value of http:leak${p.id}`]);
    expect(j.map((e: any) => e.args)).toEqual(["(withheld)", "(withheld)"]);
    expect(JSON.stringify(j)).not.toContain(stored);
  });
});

// --- The sink gate ---------------------------------------------------------------------------------------

describe("the sink gate for brokered actions", () => {
  it("tainted: an allow profile goes, an approve one waits for the operator once per exact call; an approval lets that one call through once, by either tool; a denial never", async () => {
    const gid = rand();
    const gated = new HttpStub();
    stubs.set(gid, gated);
    const p = await profileSetup({}, [{ action: "http.request", profile: "gated", base_url: `https://http.test/${gid}`, methods: ["POST"] }], { tools: ["brokered"] });
    // Untainted: not gated, approve or not.
    expect((await run(p.ws, "http_request", { profile: "gated", method: "POST", path: "/x", body: "a" })).status).toBe("ok");
    await taint(p.agent);
    expect((await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "ok" })).status).toBe("ok");
    const args = { profile: "gated", method: "POST", path: "/x", body: "details" };
    const p1 = await run(p.ws, "http_request", args);
    expect(p1).toMatchObject({ status: "pending", ask: expect.stringMatching(/^ask_/), message: expect.stringContaining("mcp__nest__http_request") });
    // Asked again before a decision (keys in another order, through `brokered`): the same ask.
    expect((await run(p.ws, "brokered", { action: "http.request", args: { body: "details", path: "/x", method: "POST", profile: "gated" } })).ask).toBe(p1.ask);
    // Held for the operator: listed once, with the tool to call again.
    const asks = await adminJson(`/v1/agents/${p.agent}/asks`);
    expect(asks).toEqual([{ ask: p1.ask, question: expect.stringContaining("http.request on gated"), created_ms: expect.any(Number),
      approval: { name: "http.request", tool: "mcp__nest__http_request" }, input: expect.anything(), input_bytes: expect.any(Number) }]);
    expect(gated.requests).toHaveLength(1);

    await answer(p.agent, p1.ask, "approve");
    expect(await lastTurn(p.agent)).toMatchObject({ kind: "ask_answer", text: expect.stringContaining("call mcp__nest__http_request again") });
    expect((await run(p.ws, "http_request", { ...args, body: "other" })).status).toBe("pending");
    expect((await run(p.ws, "brokered", { action: "http.request", args })).status).toBe("ok");
    expect(gated.requests).toHaveLength(2);
    const p2 = await run(p.ws, "http_request", args);
    expect(p2.status).toBe("pending");
    await answer(p.agent, p2.ask, "no");
    expect((await run(p.ws, "http_request", args)).status).toBe("pending");
    expect(gated.requests).toHaveLength(2);
  });
});

// --- Removed actions --------------------------------------------------------------------------------------------

describe("removed actions (stored before they went)", () => {
  /** A capability row as the previous release stored it, beside a profile this release runs. */
  async function plantCapability(name: string, profile: unknown): Promise<void> {
    const body = {
      tools: [], rules: [{ pattern: "Bash", decision: "allow" }], prompt: "old",
      brokered: [{ action: "github.create_issue", repos: ["o/r"], when_tainted: "approve" }, { action: "github.comment" }, { action: "github.fork" }, profile],
    };
    await runInDurableObject(catalogStub(), (_i, st) => {
      st.storage.sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body", name, JSON.stringify(body));
    });
  }

  it("a write naming one is refused by name; a stored capability naming one reads, and spawns, without it", async () => {
    for (const action of REMOVED_ACTIONS) {
      const r = await adminJson(`/v1/admin/capabilities/w${rand()}`, { method: "PUT", body: { brokered: [{ action }] } }, 400);
      expect(r.error.message, action).toContain(`${action} is no longer a brokered action`);
    }
    // Handed to CatalogDO by a previous release's Worker (whose schema still took them): refused there too.
    await expect(Promise.resolve().then(() => catalogStub().putCapability(`w${rand()}`, { tools: [], rules: [], prompt: "", brokered: [{ action: "github.comment" }] } as never)))
      .rejects.toThrow(/github.comment is no longer a brokered action/);
    const id = rand();
    const stub = new HttpStub();
    stubs.set(id, stub);
    const cap = `old${id}`;
    await plantCapability(cap, { action: "http.request", profile: "p", base_url: `https://http.test/${id}`, methods: ["GET"] });
    const read = (await adminJson("/v1/admin/catalog")).capabilities[cap];
    expect(read).toMatchObject({ prompt: "old", brokered: [{ action: "http.request", profile: "p" }] });
    expect(read.brokered).toHaveLength(1);
    // Its rules are read, not `unreadable` (an agent watching it keeps them).
    expect(await catalogStub().watchRules("agt_watchold", [cap])).toEqual({ rules: { [cap]: [{ pattern: "Bash", decision: "allow" }] }, unreadable: [] });
    await catalogStub().watchRules("agt_watchold", []);
    // A template listing it is written and spawns; the agent has the profile only.
    await adminJson(`/v1/admin/templates/t-${id}`, { method: "PUT", body: {
      capabilities: ["nest", cap], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "forbidden", credential: "claude_oauth_token",
    } });
    const ag = await adminJson("/v1/agents", { body: { template: `t-${id}`, cell: uniqueCell(), start: false } }, 201);
    expect((await adminJson(`/v1/agents/${ag.agent}`)).brokered.map((g: any) => g.action)).toEqual(["http.request"]);
  });

  it("a spec's stored grants of one stay in its record (a rollback runs them) but are neither shown, listed nor callable; its journal rows stay readable", async () => {
    const p = await profileSetup({}, [], { tools: ["brokered"] });
    const stale = { capability: "old", action: "github.comment", repos: null, when_tainted: "allow", per_hour: 30 };
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      (inst as any).update((i: any) => {
        i.brokered = [stale, ...i.brokered];
      });
      (inst as any).journal.settle({ key: `${p.agent}/1/cal_gh_old`, action: "github.comment", target: "o/r", idem: "comment:o/r#1:x", digest: "d", args: "{\"body\":\"hi\"}", tainted: false },
        "done", { status: "ok", content: [{ type: "text", text: "Done: https://github.com/o/r/issues/1#issuecomment-1" }] }, "{\"url\":\"…\"}");
    });
    // Shown without it.
    expect((await adminJson(`/v1/agents/${p.agent}`)).brokered.map((g: any) => g.action)).toEqual(["http.request"]);
    // Kept in the record, for a rollback.
    const stored = await runInDurableObject(agentStub(p.agent), (_: AgentDO, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value).brokered);
    expect(stored[0]).toEqual(stale);
    // Not listed, and not callable by either tool.
    const tools = (p.ws.send({ type: "tools_list_request", request: `req_${rand()}` }), (await p.ws.next("tools_list")).tools as any[]);
    expect(tools.map((t) => t.name)).not.toContain("github_comment");
    expect(await run(p.ws, "github_comment", { repo: "o/r", issue_number: 1, body: "x" })).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    expect(await run(p.ws, "brokered", { action: "github.comment", args: { repo: "o/r", issue_number: 1, body: "x" } }))
      .toMatchObject({ status: "error", error: { code: "invalid_message" } });
    // The journal still reads its past call.
    expect((await journal(p.agent)).find((e: any) => e.key.endsWith("/cal_gh_old"))).toMatchObject({ action: "github.comment", target: "o/r", status: "done" });
  });
});


// --- http.request -----------------------------------------------------------------------------------------

describe("http.request profiles", () => {
  it("attaches the profile's credential, masks it if reflected, follows no redirect, keeps to its methods and paths, and its answer taints", async () => {
    const p = await profileSetup();
    const o = await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items/3", query: { x: 1, y: "a b" } });
    expect(p.stub.requests[0]).toMatchObject({ method: "GET", path: `/${p.sid}/v1/items/3`, search: "?x=1&y=a+b", headers: { authorization: `Bearer ${p.secret}` } });
    expect(o.content[0].text).not.toContain(p.secret);
    expect(JSON.parse(o.content[0].text).auth).toBe(`Bearer ${"*".repeat(p.secret.length)}`);
    expect(o.content[1].value).toMatchObject({ status: 200, content_type: "application/json" });
    expect(await tainted(p.agent)).toBe(true);

    p.stub.next.push({ status: 302, location: "https://elsewhere.example/steal" });
    const red = await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items" });
    expect(red, JSON.stringify(red)).toMatchObject({ status: "ok" });
    expect(red.content[1].value).toMatchObject({ status: 302, location: "https://elsewhere.example/steal" });
    expect(p.stub.requests).toHaveLength(2);
    for (const [method, path] of [["DELETE", "/v1/items"], ["GET", "/v2"], ["GET", "/v1/items/../../admin"]]) {
      expect(await run(p.ws, "http_request", { profile: "p", method, path }), `${method} ${path}`).toMatchObject({ status: "error", error: { code: expect.stringMatching(/forbidden|invalid_message/) } });
    }
    expect(p.stub.requests).toHaveLength(2);
  });

  it("no credential shapes are looked for: a call carrying strings shaped like other services' tokens and keys goes out, unrefused", async () => {
    const p = await profileSetup();
    // Built at run time: shaped like a GitHub token, an AWS access key id and a PEM private key's armour, none of them stored in nest.
    const shaped = [`ghp_${"Ab1".repeat(12)}`, `AKIA${"Q".repeat(16)}`, ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")];
    const o = await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body: JSON.stringify({ note: shaped.join(" ") }) });
    expect(o, JSON.stringify(o)).toMatchObject({ status: "ok" });
    expect(p.stub.requests).toHaveLength(1);
    for (const x of shaped) expect(p.stub.requests[0]!.body).toContain(x);
    expect((await journal(p.agent)).map((e: any) => e.status)).toEqual(["done"]);
  });

  it("an http request settled by another delivery just before it would leave isn't sent", async () => {
    const p = await profileSetup();
    await settleBeforeSend(p.agent, "cal_hs1", "http.request", "p");
    call(p.ws, "cal_hs1", "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" });
    expect(await result(p.ws, "cal_hs1")).toEqual(STANDING);
    expect(p.stub.requests).toEqual([]);
  });

  it("a tainted session's rw profile call waits for approval; a read-only profile isn't a sink; a trusted profile's answer doesn't taint", async () => {
    const id = rand();
    const stub = new HttpStub();
    stubs.set(id, stub);
    const s = await setup([
      { action: "http.request", profile: "rw", base_url: `https://http.test/${id}`, methods: ["GET", "POST"] },
      { action: "http.request", profile: "ro", base_url: `https://http.test/${id}`, methods: ["GET"], trusted: true },
    ]);
    expect((await run(s.ws, "http_request", { profile: "ro", method: "GET", path: "/a" })).status).toBe("ok");
    expect(await tainted(s.agent)).toBe(false);
    await taint(s.agent);
    expect((await run(s.ws, "http_request", { profile: "ro", method: "GET", path: "/b" })).status).toBe("ok");
    expect((await run(s.ws, "http_request", { profile: "rw", method: "GET", path: "/c" })).status).toBe("pending");
    expect(stub.requests.map((r) => r.path)).toEqual([`/${id}/a`, `/${id}/b`]);
  });

  it("each request it sends is on the agent's trace: where, the outcome and the sizes; never a query value, the body or the injected credential", async () => {
    const p = await profileSetup();
    const body = JSON.stringify({ note: "body-text-never-traced" });
    const o = await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", query: { q: "query-value-never-traced" }, body });
    expect(o.status).toBe("ok");
    const answer = o.content[0].text as string;
    expect(await outbound(p.agent)).toEqual([expect.objectContaining({
      type: "outbound", via: "brokered", name: "http.request", method: "POST", host: "http.test", path: `/${p.sid}/v1/items`, status: 200,
      bytes_up: new TextEncoder().encode(body).length, bytes_down: new TextEncoder().encode(answer).length, duration_ms: expect.any(Number),
    })]);
    const all = JSON.stringify(await traceRows(p.agent));
    // The stub echoes the credential back: the record has the answer's size, never its text.
    expect(JSON.parse(answer).auth).toContain("*");
    for (const never of [p.secret, "query-value-never-traced", "body-text-never-traced", "?q="]) expect(all).not.toContain(never);
  });

  it("a lost answer is retried once for an idempotent method, never for POST", async () => {
    // vitest.config.ts: BROKERED_TIMEOUT_MS = 1500.
    const p = await profileSetup();
    p.stub.next.push({ delay: 2500 });
    expect((await run(p.ws, "http_request", { profile: "p", method: "GET", path: "/v1/items" })).status).toBe("ok");
    expect(p.stub.requests).toHaveLength(2);
    // Each attempt is on the trace: the one that timed out without a status.
    expect((await outbound(p.agent)).map((x) => [x.method, x.status ?? x.error])).toEqual([["GET", "aborted"], ["GET", 200]]);
    p.stub.next.push({ delay: 2500 });
    expect(await run(p.ws, "http_request", { profile: "p", method: "POST", path: "/v1/items", body: "{}" })).toMatchObject({ status: "error", error: { code: "outcome_unknown" } });
    expect(p.stub.requests).toHaveLength(3);
  }, 15_000);
});

// --- Egress widening ---------------------------------------------------------------------------------------

describe("egress_policy", () => {
  it("widening its own sandbox's egress from a tainted session waits for approval, then adds expiring grants; narrowing is never gated", async () => {
    const s = await setup([], { tools: ["egress_policy"], hands: true });
    const req = { allow: [{ host: "API.Example.com" }, { host: "*.cdn.example.net", ports: [443] }], ttl_s: 600 };
    const p1 = await run(s.ws, "egress_policy", req);
    expect(p1).toMatchObject({ status: "pending", message: expect.stringContaining("mcp__nest__egress_policy") });
    const policy = () => env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox!)).policy();
    expect((await policy()).allow.some((r) => r.host === "api.example.com")).toBe(false);
    await answer(s.agent, p1.ask, "yes");
    const before = Date.now();
    const o = await run(s.ws, "egress_policy", req);
    expect(o.status).toBe("ok");
    const allow = (await policy()).allow.filter((r) => r.layer === "sandbox");
    expect(allow.map((r) => [r.host, r.ports])).toEqual([["api.example.com", [80, 443]], ["*.cdn.example.net", [443]]]);
    expect(allow[0]!.expires_ms).toBeGreaterThanOrEqual(before + 600_000);
    const [update] = await nextCommands(s.sbxHost!.ws, (c) => c.type === "policy_update" && c.policy.allow.some((r: any) => r.host === "api.example.com"));
    expect(update.sandbox).toBe(s.sandbox);
    // Spent: the same widening again needs a new approval.
    expect((await run(s.ws, "egress_policy", req)).status).toBe("pending");
    // Narrowing: not gated.
    expect((await run(s.ws, "egress_policy", { revoke: ["api.example.com"] })).status).toBe("ok");
    expect((await policy()).allow.map((r) => r.host)).not.toContain("api.example.com");
    expect(await run(s.ws, "egress_policy", { allow: [{ host: "10.0.0.1" }] })).toMatchObject({ status: "error", error: { code: "invalid_message" } });
  });

  it("an agent without a sandbox has no egress to widen", async () => {
    const s = await setup([], { tools: ["egress_policy"] });
    expect(await run(s.ws, "egress_policy", { allow: [{ host: "example.com" }] })).toMatchObject({ status: "error", error: { code: "not_bound" } });
  });
});

// --- Rollback: approvals rows of the previous release -----------------------------------------------------------

describe("approvals of the previous release", () => {
  it("a row written without `tool` (a remote MCP tool's) is still decided, and the turn names mcp__nest__<name>", async () => {
    const s = await setup([]);
    await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => {
      const sql = st.storage.sql;
      sql.exec("DROP TABLE approvals");
      sql.exec(`CREATE TABLE approvals (ask TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL,
        status TEXT NOT NULL, expires_ms INTEGER, used_by TEXT, created_ms INTEGER NOT NULL)`);
      sql.exec("INSERT INTO approvals (ask, name, digest, status, created_ms) VALUES ('ask_old', 'notes_put', 'd', 'pending', ?)", Date.now());
      sql.exec("INSERT INTO asks (ask, call, epoch, question, status, deadline, created_ms) VALUES ('ask_old', 'cal_old', 1, 'q', 'async', 0, 0)");
      new CallLedger(sql); // this release's constructor on the old shape
    });
    await answer(s.agent, "ask_old", "approve");
    expect(await lastTurn(s.agent)).toMatchObject({ text: expect.stringContaining("call mcp__nest__notes_put again") });
  });
});
