// The server against the MCP 2025-11-25 spec (basic/transports, basic/lifecycle, server/tools) and the
// contract in the brief: every request goes through the real Worker and Durable Object.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const BASE = "https://mcp-test.example";
const TOKEN = "test-token";
const ACCEPT = "application/json, text/event-stream";

type Headers = Record<string, string>;

function post(path: string, body: unknown, headers: Headers = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: ACCEPT, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let nextId = 1;
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: nextId++, method, ...(params === undefined ? {} : { params }) });
const initParams = (protocolVersion = "2025-11-25") => ({ protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } });

/** Initializes a session, sends notifications/initialized, and returns a caller bound to it. */
async function connect() {
  const res = await post("/mcp", request("initialize", initParams()));
  expect(res.status).toBe(200);
  const session = res.headers.get("mcp-session-id")!;
  const headers = { "mcp-session-id": session, "mcp-protocol-version": "2025-11-25" };
  expect((await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, headers)).status).toBe(202);
  const rpc = async (method: string, params?: unknown): Promise<any> => {
    const r = await post("/mcp", request(method, params), headers);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^application\/json/);
    return r.json();
  };
  const call = async (name: string, args?: unknown, _meta?: unknown) =>
    (await rpc("tools/call", { name, ...(args === undefined ? {} : { arguments: args }), ...(_meta === undefined ? {} : { _meta }) })).result;
  return { session, headers, rpc, call };
}

async function calls(since = 0): Promise<any[]> {
  const res = await SELF.fetch(`${BASE}/calls?since=${since}`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { calls: any[] }).calls;
}

const lastSeq = async () => (await calls()).at(-1)?.seq ?? 0;
const text = (result: any) => result.content.map((c: any) => c.text).join("");

beforeEach(async () => {
  expect((await post("/reset", {})).status).toBe(200);
});

describe("auth and origin", () => {
  it.each([
    ["POST", "/mcp"],
    ["GET", "/calls"],
    ["POST", "/reset"],
  ])("%s %s needs the bearer token", async (method, path) => {
    for (const authorization of [undefined, "Bearer wrong", `Basic ${TOKEN}`]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method, headers: authorization === undefined ? {} : { authorization } });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    }
  });

  it("refuses a foreign Origin with 403 and admits a listed one", async () => {
    expect((await post("/mcp", request("initialize", initParams()), { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/mcp", request("initialize", initParams()), { origin: "https://allowed.example" })).status).toBe(200);
  });
});

describe("lifecycle", () => {
  it("initialize returns the result, a session id and the tools capability", async () => {
    const res = await post("/mcp", request("initialize", initParams()));
    const body: any = await res.json();
    expect(body.result.protocolVersion).toBe("2025-11-25");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo).toMatchObject({ name: "nest-mcp-test", version: expect.any(String) });
    // Session ids are visible ASCII only (0x21..0x7E).
    expect(res.headers.get("mcp-session-id")).toMatch(/^[\x21-\x7e]+$/);
  });

  it.each([
    ["2025-11-25", "2025-11-25"],
    ["2025-06-18", "2025-06-18"],
    ["2024-11-05", "2025-11-25"], // unsupported: the server offers its latest
    ["1.0.0", "2025-11-25"],
  ])("negotiates %s to %s", async (requested, expected) => {
    const body: any = await (await post("/mcp", request("initialize", initParams(requested)))).json();
    expect(body.result.protocolVersion).toBe(expected);
  });

  it("initialize with bad params is -32602 and opens no session", async () => {
    for (const params of [undefined, { capabilities: {}, clientInfo: { name: "x", version: "1" } }, { protocolVersion: "2025-11-25", capabilities: {} }]) {
      const res = await post("/mcp", request("initialize", params));
      expect(res.status).toBe(200);
      expect(res.headers.get("mcp-session-id")).toBeNull();
      expect(((await res.json()) as any).error.code).toBe(-32602);
    }
  });

  it("ping answers an empty result", async () => {
    const { rpc } = await connect();
    expect((await rpc("ping")).result).toEqual({});
  });

  it("a request without a session is 400, with an unknown one 404", async () => {
    expect((await post("/mcp", request("ping"))).status).toBe(400);
    expect((await post("/mcp", request("ping"), { "mcp-session-id": "no-such-session" })).status).toBe(404);
  });

  it("DELETE ends the session: later requests on it get 404", async () => {
    const { headers } = await connect();
    const del = await SELF.fetch(`${BASE}/mcp`, { method: "DELETE", headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
    expect(del.status).toBe(204);
    expect((await post("/mcp", request("ping"), headers)).status).toBe(404);
  });

  it("notifications and client responses get 202 with no body", async () => {
    const { headers } = await connect();
    for (const msg of [
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", id: 7, result: {} },
    ]) {
      const res = await post("/mcp", msg, headers);
      expect(res.status).toBe(202);
      expect(await res.text()).toBe("");
    }
  });
});

describe("transport and JSON-RPC errors", () => {
  it("an unknown method is -32601", async () => {
    const { rpc } = await connect();
    expect((await rpc("resources/list")).error.code).toBe(-32601);
  });

  it.each([
    ["malformed JSON", "{not json", -32700],
    ["a batch", JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]), -32600],
    ["no jsonrpc field", JSON.stringify({ id: 1, method: "ping" }), -32600],
    ["a null id", JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }), -32600],
  ])("%s is HTTP 400 with an id-less error %i", async (_, body, code) => {
    const { headers } = await connect();
    const res = await post("/mcp", body, headers);
    expect(res.status).toBe(400);
    const json: any = await res.json();
    expect(json.error.code).toBe(code);
    expect("id" in json).toBe(false);
  });

  it("an unsupported MCP-Protocol-Version is 400; the negotiated one or none is accepted", async () => {
    const { session } = await connect();
    expect((await post("/mcp", request("ping"), { "mcp-session-id": session, "mcp-protocol-version": "2099-01-01" })).status).toBe(400);
    expect((await post("/mcp", request("ping"), { "mcp-session-id": session })).status).toBe(200);
  });

  it("Accept without both types is 406, a non-JSON body type 415, GET on the endpoint 405", async () => {
    const { headers } = await connect();
    expect((await post("/mcp", request("ping"), { ...headers, accept: "application/json" })).status).toBe(406);
    expect((await post("/mcp", request("ping"), { ...headers, "content-type": "text/plain" })).status).toBe(415);
    const get = await SELF.fetch(`${BASE}/mcp`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream", ...headers } });
    expect(get.status).toBe(405);
  });
});

describe("tools/list", () => {
  it("lists the five tools with object input schemas and the brief's annotations", async () => {
    const { rpc } = await connect();
    const { tools } = (await rpc("tools/list")).result;
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["counter_add", "echo", "note_get", "note_put", "slow"]);
    const expected: Record<string, { args: string[]; readOnly: boolean; idempotent: boolean }> = {
      echo: { args: ["text"], readOnly: true, idempotent: true },
      note_put: { args: ["key", "value"], readOnly: false, idempotent: true },
      note_get: { args: ["key"], readOnly: true, idempotent: true },
      counter_add: { args: ["name", "n"], readOnly: false, idempotent: false },
      slow: { args: ["ms"], readOnly: true, idempotent: true },
    };
    for (const [name, want] of Object.entries(expected)) {
      const t = byName[name];
      expect(t.inputSchema.type).toBe("object");
      expect(Object.keys(t.inputSchema.properties).sort()).toEqual([...want.args].sort());
      expect([...t.inputSchema.required].sort()).toEqual([...want.args].sort());
      expect(t.annotations).toMatchObject({ readOnlyHint: want.readOnly, idempotentHint: want.idempotent, destructiveHint: expect.any(Boolean) });
    }
  });

  it("a cursor it never issued is -32602", async () => {
    const { rpc } = await connect();
    expect((await rpc("tools/list", { cursor: "bogus" })).error.code).toBe(-32602);
  });
});

describe("tools/call", () => {
  it("echo returns its text as a text block", async () => {
    const { call } = await connect();
    expect(await call("echo", { text: "hi there" })).toEqual({ content: [{ type: "text", text: "hi there" }], isError: false });
  });

  it("note_put stores durably for another session; note_get of a missing key is a tool error", async () => {
    const a = await connect();
    expect((await a.call("note_put", { key: "k", value: "v1" })).isError).toBe(false);
    expect((await a.call("note_put", { key: "k", value: "v2" })).isError).toBe(false);
    const b = await connect();
    expect(text(await b.call("note_get", { key: "k" }))).toBe("v2");
    const missing = await b.call("note_get", { key: "nope" });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/not found/);
  });

  it("counter_add is not idempotent: two identical calls add twice", async () => {
    const { call } = await connect();
    const since = await lastSeq();
    expect(text(await call("counter_add", { name: "c", n: 2 }))).toBe("2");
    expect(text(await call("counter_add", { name: "c", n: 2 }))).toBe("4");
    expect(text(await call("counter_add", { name: "c", n: -5 }))).toBe("-1");
    expect((await calls(since)).filter((c) => c.tool === "counter_add")).toHaveLength(3);
  });

  it("slow waits at least ms before answering", async () => {
    const { call } = await connect();
    const t0 = Date.now();
    const result = await call("slow", { ms: 200 });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190); // the 200 ms timer, less clock granularity
    expect(result.isError).toBe(false);
  });

  it.each([
    ["slow", { ms: 30_001 }],
    ["slow", { ms: 1.5 }],
    ["echo", {}],
    ["echo", { text: 3 }],
    ["echo", { text: "x", extra: true }],
    ["note_put", { key: "", value: "v" }],
    ["counter_add", { name: "c", n: "1" }],
  ])("%s with bad arguments %j is a tool execution error", async (name, args) => {
    const { call } = await connect();
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/invalid arguments/);
  });

  it("an unknown tool or a call without a name is a -32602 protocol error", async () => {
    const { rpc } = await connect();
    expect((await rpc("tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { arguments: {} })).error.code).toBe(-32602);
    expect((await rpc("tools/call", { name: "echo", arguments: "text" })).error.code).toBe(-32602);
  });
});

describe("the test surface", () => {
  it("/calls records each call in order with its session, arguments, _meta and outcome", async () => {
    const { session, call, rpc } = await connect();
    const since = await lastSeq();
    const meta = { "nest/agent": "agt_1", "nest/epoch": 3, "nest/call": "agt_1/3/c1", "nest/taint": false };
    await call("echo", { text: "a" }, meta);
    await call("note_get", { key: "absent" });
    await rpc("tools/call", { name: "nope" });
    const log = await calls(since);
    expect(log.map((c) => c.tool)).toEqual(["echo", "note_get", "nope"]);
    expect(log[0]).toMatchObject({ session, arguments: { text: "a" }, _meta: meta, result_or_error: { result: { isError: false } } });
    expect(log[1]).toMatchObject({ _meta: null, result_or_error: { result: { isError: true } } });
    expect(log[2].result_or_error.error.code).toBe(-32602);
    expect(log[0].seq).toBeLessThan(log[1].seq);
    expect(log[0].ts_ms).toEqual(expect.any(Number));
    expect(await calls(log[1].seq)).toHaveLength(1);
  });

  it("a call still running is logged on arrival with no outcome, then completed", async () => {
    const { call, rpc } = await connect();
    const since = await lastSeq();
    const pending = call("slow", { ms: 500 }); // the slow tool's 500 ms timer keeps it in flight below
    let entry: any;
    for (let i = 0; i < 40 && entry === undefined; i++) {
      entry = (await calls(since)).find((c) => c.tool === "slow");
      if (entry === undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect(entry?.result_or_error).toBeNull();
    // The object keeps answering while the slow call waits.
    expect((await rpc("ping")).result).toEqual({});
    await pending;
    expect((await calls(since)).find((c) => c.tool === "slow").result_or_error.result.isError).toBe(false);
  });

  it("/reset clears notes, counters and the log, keeps sessions, and never reuses a seq", async () => {
    const { call } = await connect();
    await call("note_put", { key: "k", value: "v" });
    await call("counter_add", { name: "c", n: 5 });
    const before = await lastSeq();
    expect(before).toBeGreaterThan(0);
    expect((await post("/reset", {})).status).toBe(200);
    expect(await calls()).toEqual([]);
    expect((await call("note_get", { key: "k" })).isError).toBe(true);
    expect(text(await call("counter_add", { name: "c", n: 1 }))).toBe("1");
    expect((await calls())[0].seq).toBeGreaterThan(before);
  });

  it("/calls rejects a bad since", async () => {
    const res = await SELF.fetch(`${BASE}/calls?since=-1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(400);
  });
});

describe("the tool list changing (POST/DELETE /tools)", () => {
  const tools = (method: "POST" | "DELETE", name: string) =>
    SELF.fetch(`${BASE}/tools?name=${name}`, { method, headers: { authorization: `Bearer ${TOKEN}` } });
  /** One SSE body's JSON-RPC messages, in order. */
  const sse = async (r: Response) => (await r.text()).split("\n\n").filter(Boolean)
    .map((e) => JSON.parse(e.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")));

  it("initialize says the list can change", async () => {
    const body: any = await (await post("/mcp", request("initialize", initParams()))).json();
    expect(body.result.capabilities.tools.listChanged).toBe(true);
  });

  it("adding a tool lists it and owes each session one list_changed, sent before the response on its next request's SSE stream", async () => {
    const a = await connect();
    const b = await connect();
    const added = await tools("POST", "extra_one");
    expect(added.status).toBe(200);
    expect(((await added.json()) as any).tools).toContain("extra_one");
    for (const s of [a, b]) {
      const r = await post("/mcp", request("tools/list"), s.headers);
      expect(r.headers.get("content-type")).toMatch(/^text\/event-stream/);
      const [notice, reply] = await sse(r);
      expect(notice).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      expect(reply.result.tools.map((t: any) => t.name)).toContain("extra_one");
      // Once: the next request is plain JSON again.
      expect((await s.rpc("ping")).result).toEqual({});
    }
    expect(text(await a.call("extra_one", { text: "hi" }))).toBe("extra_one: hi");
    // No change, no notice; removing it owes another and unlists it.
    expect((await tools("POST", "extra_one")).status).toBe(200);
    expect((await pingType(a))).toMatch(/^application\/json/);
    expect((await tools("DELETE", "extra_one")).status).toBe(200);
    const [notice, reply] = await sse(await post("/mcp", request("tools/list"), a.headers));
    expect(notice.method).toBe("notifications/tools/list_changed");
    expect(reply.result.tools.map((t: any) => t.name)).not.toContain("extra_one");
  });

  it("refuses a name outside extra_<name>", async () => {
    expect((await tools("POST", "echo")).status).toBe(400);
    expect((await tools("POST", "extra_UPPER")).status).toBe(400);
  });
});

/** The content type of a ping on a session (JSON unless a notice is owed). */
async function pingType(s: { headers: Record<string, string> }): Promise<string> {
  return (await post("/mcp", request("ping"), s.headers)).headers.get("content-type") ?? "";
}
