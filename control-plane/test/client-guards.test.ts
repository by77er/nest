// API clients' request guards (docs/control-plane/api/clients/#request-guards): a client writes guards in
// the operator's generic shape for its own sandboxes (its client layer, a sandbox spec, a template, a
// spawn), bounded and validated before they are stored. On the wire each is an ordinary `RequestGuard`
// named `client:<name>`, after the operator's, its `injected` naming the client's own bindings. A guard
// only refuses: nest-proxy's evaluator (crates/nest-proxy/tests/client_guards.rs, on the same fixture)
// shows a client's exceptions never exempt a request from the operator's guards. The pure checks first.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.client_guards.json";
import {
  ClientGuard, ClientGuards, distinctGuards, guardWork, holdGuards, MAX_LIST_BYTES, outsideOperatorRouting, PathPattern, SANDBOX_MAX_GUARDS,
  sandboxGuardsOverLimit, wireGuard, type ClientGuard as ClientGuardT,
} from "../src/lib/client-guards";
import { expandSpec, type Template } from "../src/lib/spec";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { SandboxPolicyLayer } from "../src/do/sandbox";
import type { RequestGuard } from "../src/protocol/model";
import { adminJson, BASE, connectHost, enrollHost, eventually, nextCommands, uniqueCell, type Ws } from "./helpers";
import { ClientDO } from "../src/do/client";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };

const NO_DELETE: ClientGuardT = {
  name: "no-delete", hosts: ["files.example.com"], scope: [{ methods: ["DELETE"] }], allow: [{ path: "/store/theirs/**" }],
  reason: "the client's: no deletes outside /store/theirs",
};
const API_WRITE: ClientGuardT = {
  name: "api-write", hosts: ["api.example.com"], scope: [{ methods_except: ["GET", "HEAD"] }],
  allow: [{ methods: ["POST"], path: "/query", injected: "svc" }, { methods: ["POST"], path: "/batch", body_json: { pointer: "/op", values: ["read"] } }],
};
const PUSH: ClientGuardT = {
  name: "push", hosts: ["git.example.com"], ignore_case: true,
  scope: [{ path: "/**/git-receive-pack" }, { path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] }],
  allow: [{ path: "/me/box/**" }, { path: "/me/box.git/**" }],
};

/** A guard refusing every write on `host`, named `name`. */
const writes = (name: string, host = "files.example.com"): ClientGuardT => ({ name, hosts: [host], scope: [{ methods_except: ["GET", "HEAD"] }] });

describe("client request guards (pure)", () => {
  it("are ordinary guards on the wire after the operator's: exactly the fixture nest-proxy's seam test evaluates", () => {
    const parsed = ClientGuards.parse([NO_DELETE, API_WRITE, PUSH]);
    // The operator's guard, as its layer has it, then the client's (SandboxDO's order).
    const operator = SandboxPolicyLayer.parse({ guards: [fixture.guards[0]] }).guards;
    expect([...operator, ...parsed.map(wireGuard)]).toEqual(fixture.guards);
  });

  it("are named client:<name>, and every injected names the client's own binding, in scope and exceptions alike", () => {
    const g = wireGuard({ name: "x", hosts: ["a.example.com"], scope: [{ injected: "github" }], allow: [{ injected: "svc", path: "/q" }] });
    expect(g.name).toBe("client:x");
    expect(g.scope).toEqual([{ injected: "client:github" }]);
    expect(g.allow).toEqual([{ path: "/q", injected: "client:svc" }]);
    // A name or binding that is already prefixed, or any other shape, is refused rather than taken as written.
    for (const injected of ["client:svc", "github-read", "Svc", ""]) {
      expect(ClientGuard.safeParse({ ...writes("y"), allow: [{ injected }] }).success, injected).toBe(false);
    }
    for (const name of ["client:y", "Y", "-y", "y".repeat(49), ""]) expect(ClientGuard.safeParse(writes(name)).success, name).toBe(false);
    // The operator's layer can't take a client's name.
    expect(SandboxPolicyLayer.safeParse({ guards: [{ name: "client:x", hosts: ["a.example.com"], scope: [{}] }] }).success).toBe(false);
    expect(SandboxPolicyLayer.safeParse({ guards: [{ name: "x", hosts: ["a.example.com"], scope: [{}] }] }).success).toBe(true);
  });

  it("are bounded: per guard, per list, and paths whose cost in the proxy stays linear", () => {
    const ok = (g: unknown) => ClientGuard.safeParse(g).success;
    expect(ok(writes("w"))).toBe(true);
    expect(ok({ ...writes("w"), scope: [] })).toBe(false);
    expect(ok({ ...writes("w"), hosts: [] })).toBe(false);
    expect(ok({ ...writes("w"), hosts: Array.from({ length: 9 }, (_, i) => `h${i}.example.com`) })).toBe(false);
    expect(ok({ ...writes("w"), hosts: ["a.example.com", "a.example.com"] })).toBe(false);
    for (const bad of ["127.0.0.1", "*", "*.com", "Example.com", "localhost"]) expect(ok({ ...writes("w"), hosts: [bad] }), bad).toBe(false);
    expect(ok({ ...writes("w"), scope: Array.from({ length: 9 }, () => ({})) })).toBe(false);
    expect(ok({ ...writes("w"), allow: Array.from({ length: 65 }, () => ({ path: "/a" })) })).toBe(false);
    expect(ok({ ...writes("w"), surprise: 1 })).toBe(false);
    expect(ok({ ...writes("w"), scope: [{ methods: ["GET"], surprise: 1 }] })).toBe(false);
    expect(ok({ ...writes("w"), reason: "a\nb" })).toBe(false);
    for (const good of ["/", "/a/*/b", "/**/git-receive-pack", "/me/box/**", "/a/**/b/c/d/e"]) expect(PathPattern.safeParse(good).success, good).toBe(true);
    for (const bad of ["a", "", "/a//b", "/**/x/**", "/**/a/b/c/d/e", `/${Array(17).fill("a").join("/")}`, "/a b", "/a?b", "/a#b", "/a\\b", `/${"a".repeat(256)}`]) {
      expect(PathPattern.safeParse(bad).success, bad).toBe(false);
    }
    // A list: at most 16, each name once, at most 16 KiB.
    expect(ClientGuards.safeParse(Array.from({ length: 16 }, (_, i) => writes(`g${i}`))).success).toBe(true);
    expect(ClientGuards.safeParse(Array.from({ length: 17 }, (_, i) => writes(`g${i}`))).success).toBe(false);
    expect(ClientGuards.safeParse([writes("g"), writes("g", "other.example.com")]).success).toBe(false);
    const fat = (i: number) => ({ ...writes(`g${i}`), reason: "r".repeat(300), allow: Array.from({ length: 10 }, (_, j) => ({ path: `/${"p".repeat(100)}${j}` })) });
    const big = Array.from({ length: 16 }, (_, i) => fat(i));
    expect(ClientGuard.safeParse(fat(0)).success).toBe(true);
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_LIST_BYTES);
    expect(ClientGuards.safeParse(big).success).toBe(false);
  });

  it("a sandbox applies at most so many client guards, scope matchers and bytes", () => {
    const wire = (n: number, scope = 1) => Array.from({ length: n }, (_, i) => wireGuard({ ...writes(`g${i}`), scope: Array.from({ length: scope }, () => ({})) }));
    expect(sandboxGuardsOverLimit(wire(SANDBOX_MAX_GUARDS))).toBeNull();
    expect(sandboxGuardsOverLimit(wire(SANDBOX_MAX_GUARDS + 1))).toContain("at most 32 client guards");
    expect(sandboxGuardsOverLimit(wire(16, 4))).toBeNull();
    expect(sandboxGuardsOverLimit(wire(17, 4))).toContain("scope matchers");
    // Exceptions count too, with their query parameters and body fields: the review's 534 exceptions of
    // four query names and a body field each, in a few guards, is far past it.
    const heavy = (n: number) => wireGuard({ ...writes(`h${n}`), allow: Array.from({ length: 40 }, () => ({ query: [1, 2, 3, 4].map((i) => ({ name: `q${i}` })), body_json: { pointer: "/op", values: ["read"] } })) });
    expect(guardWork(heavy(0))).toBe(1 + 40 * (1 + 4 + 2));
    expect(sandboxGuardsOverLimit([heavy(0)])).toBeNull();
    expect(sandboxGuardsOverLimit([heavy(0), heavy(1)])).toContain("matcher work");
    // Each value counts, and a scope's query twice (matched as sent and decoded): the second review's
    // 58 scope matchers of one query parameter with 16 values each are far past it.
    const values = (n: number) => wireGuard({ ...writes(`v${n}`), scope: [{ query: [{ name: "q", values: Array.from({ length: 16 }, (_, i) => `v${i}`) }] }] });
    expect(guardWork(values(0))).toBe(1 + 2 * 17);
    expect(guardWork({ scope: [{}], allow: [{ query: [{ name: "q", values: ["a", "b"] }] }] })).toBe(1 + 1 + 3);
    expect(guardWork({ scope: [{ body_json: { pointer: "/op", values: ["a", "b", "c"] } }] })).toBe(1 + 4);
    expect(sandboxGuardsOverLimit(Array.from({ length: 14 }, (_, i) => values(i)))).toBeNull();
    expect(sandboxGuardsOverLimit(Array.from({ length: 15 }, (_, i) => values(i)))).toContain("matcher work");
    expect(sandboxGuardsOverLimit(wire(32))).toBeNull();
  });

  it("a guard on a host the operator splices or routes as TCP loses that host (the operator's routing stands); identical guards count once, same names don't merge", () => {
    const g = (hosts: string[]): RequestGuard => ({ name: "client:g", hosts, scope: [{}] });
    expect(outsideOperatorRouting([g(["a.example.com", "b.example.com"])], ["a.example.com"])).toEqual([g(["b.example.com"])]);
    expect(outsideOperatorRouting([g(["*.example.com"])], ["x.example.com"])).toEqual([]);
    expect(outsideOperatorRouting([g(["x.example.com"])], ["*.example.com"])).toEqual([]);
    expect(outsideOperatorRouting([g(["x.example.com"])], [])).toEqual([g(["x.example.com"])]);
    expect(distinctGuards([g(["a.example.com"]), g(["a.example.com"]), g(["b.example.com"])])).toEqual([g(["a.example.com"]), g(["b.example.com"])]);
    expect(holdGuards("cli_x", [writes("w")])).toEqual([{ ...writes("w"), client: "cli_x" }]);
  });

  it("a spawn's guards are held as its subtree's client's, and a subtree with no client is refused", () => {
    const tpl = { capabilities: [], launch: LAUNCH, hands: "optional", credential: "claude_oauth_token" } as unknown as Template;
    const catalog = { capabilities: {}, templates: { t: tpl } };
    const spawn = { template: "t", hands: false, by: "spawner" as const, overrides: { guards: [writes("w")] } };
    const held = expandSpec(catalog, PLATFORM_TOOL_NAMES, spawn, { acme: "cli_acme" }, "acme");
    expect(held.ok && held.value.guards).toEqual([{ ...writes("w"), client: "cli_acme" }]);
    const none = expandSpec(catalog, PLATFORM_TOOL_NAMES, spawn, {}, "ghost");
    expect(none.ok ? "expanded" : none.error).toContain("no client is named ghost");
    // The operator's subtree: the operator's.
    const op = expandSpec(catalog, PLATFORM_TOOL_NAMES, spawn, {}, null);
    expect(op.ok && op.value.guards).toEqual([{ ...writes("w"), client: null }]);
  });
});

// --- Through the Worker and the Durable Objects, with a fake sandbox host ----------------------------------

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}
async function ok(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const r = await as(token, path, init);
  expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return r.body;
}

async function newClient() {
  const cell = uniqueCell();
  const name = `grd-${rand()}`;
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: {
    cells: [cell], credentials: ["claude_oauth_token"], max_agents: 8, max_sandboxes: 5, secrets: { max_count: 3, max_bytes: 64 },
    inject_hosts: ["api.example.com"], egress_hosts: ["files.example.com"],
  } } }, 201);
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  return { id: c.client as string, name, token: c.token as string, cell };
}
type Client = Awaited<ReturnType<typeof newClient>>;

async function placed(c: Client, body: Record<string, unknown> = {}): Promise<{ sandbox: string; ws: Ws }> {
  const host = await connectHost(c.cell);
  const sbx = await ok(c.token, "/v1/sandboxes", { body: { cell: c.cell, ...body } });
  await nextCommands(host.ws, (x) => x.type === "sandbox_create");
  return { sandbox: sbx.sandbox, ws: host.ws };
}
const nextPolicy = async (ws: Ws) => (await nextCommands(ws, (x) => x.type === "policy_update")).find((x) => x.type === "policy_update")!.policy;
const names = (policy: { guards?: RequestGuard[] }) => (policy.guards ?? []).map((g) => g.name);
const OPERATOR_GUARD = { name: "store-write", hosts: ["files.example.com"], scope: [{ methods_except: ["GET", "HEAD"] }], allow: [{ path: "/store/mine/**" }] };

describe("client request guards on a sandbox", () => {
  it("the live client layer's guards reach the proxy unchanged after the operator's, are read back as written, and go when emptied", async () => {
    const c = await newClient();
    const s = await placed(c);
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "files.example.com" }], guards: [OPERATOR_GUARD] } });
    expect(names(await nextPolicy(s.ws))).toContain("store-write");
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [NO_DELETE, API_WRITE] } });
    const wire = await nextPolicy(s.ws);
    // What nest-proxy gets: the operator's guards untouched, then the client's in the wire shape.
    const at = names(wire).indexOf("store-write");
    expect(wire.guards.slice(at)).toEqual([OPERATOR_GUARD, wireGuard(NO_DELETE), wireGuard(API_WRITE)]);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([NO_DELETE, API_WRITE]);
    // Replaced live, then emptied by a write without them (the whole layer is replaced).
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [PUSH] } });
    expect(names(await nextPolicy(s.ws)).filter((n) => n.startsWith("client:"))).toEqual(["client:push"]);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: {} });
    expect(names(await nextPolicy(s.ws)).filter((n) => n.startsWith("client:"))).toEqual([]);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([]);
  });

  it("guards are validated before they are stored: a bad one is 400 and the layer is unchanged", async () => {
    const c = await newClient();
    const s = await placed(c, { guards: [NO_DELETE] });
    expect(names(await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`))).toContain("client:no-delete");
    for (const bad of [[{ ...NO_DELETE, name: "client:x" }], [{ ...NO_DELETE, scope: [{ path: "/**/a/**" }] }], [{ ...NO_DELETE, allow: [{ injected: "client:svc" }] }]]) {
      expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: bad } })).status).toBe(400);
      expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: bad } })).status).toBe(400);
    }
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([NO_DELETE]);
    // The operator's layer can't use a client's name.
    expect((await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { guards: [{ ...OPERATOR_GUARD, name: "client:no-delete" }] } }, 400))).toBeTruthy();
  });

  it("a template's guards join its agent's sandbox while attached; a spawn adds guards but never drops the template's; detach takes them away", async () => {
    const c = await newClient();
    const tpl = { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token" };
    await ok(c.token, `/v1/catalog/templates/${c.name}/g`, { method: "PUT", body: { ...tpl, guards: [PUSH] } });
    expect((await as(c.token, `/v1/catalog/templates/${c.name}/bad`, { method: "PUT", body: { ...tpl, guards: [{ ...PUSH, hosts: ["*"] }] } })).status).toBe(400);
    const s = await placed(c);
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/g`, sandbox: s.sandbox, start: false, overrides: { guards: [NO_DELETE] } } });
    expect(a.guards).toEqual([{ ...PUSH, client: c.id }, { ...NO_DELETE, client: c.id }]);
    const wire = await nextPolicy(s.ws);
    expect(wire.guards.filter((g: RequestGuard) => g.name.startsWith("client:"))).toEqual([wireGuard(PUSH), wireGuard(NO_DELETE)]);
    // An empty list of a spawner's adds nothing and drops nothing.
    const b = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/g`, sandbox: s.sandbox, start: false, overrides: { guards: [] } } });
    expect(b.guards).toEqual([{ ...PUSH, client: c.id }]);
    await env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)).detach(a.agent);
    expect(names(await nextPolicy(s.ws)).filter((n) => n.startsWith("client:"))).toEqual(["client:push"]);
    await env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)).detach(b.agent);
    expect(names(await nextPolicy(s.ws)).filter((n) => n.startsWith("client:"))).toEqual([]);
  });

  it("an attached agent's guards count only when they are its sandbox's client's or the operator's", async () => {
    const c = await newClient();
    const s = await placed(c);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await stub.attach("agt_other", undefined, [], [], { guards: holdGuards("cli_someoneelse", [API_WRITE]) });
    expect(names(await stub.policy())).not.toContain("client:api-write");
    await stub.attach("agt_own", undefined, [], [], { guards: holdGuards(c.id, [API_WRITE]) });
    expect(names(await stub.policy())).toContain("client:api-write");
    await stub.attach("agt_op", undefined, [], [], { guards: holdGuards(null, [PUSH]) });
    expect(names(await stub.policy())).toContain("client:push");
  });

  it("a layer or an attach past the sandbox's bound is refused, and nothing is stored", async () => {
    const c = await newClient();
    const s = await placed(c);
    const four = (i: number): ClientGuardT => ({ ...writes(`g${i}`), scope: [{ methods: ["PUT"] }, { methods: ["POST"] }, { methods: ["DELETE"] }, { methods: ["PATCH"] }] });
    // 16 guards of 4 scope matchers each: the sandbox's 64.
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: Array.from({ length: 16 }, (_, i) => four(i)) } });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    const before = names(await stub.policy());
    await expect(Promise.resolve().then(() => stub.attach("agt_more", undefined, [], [], { guards: holdGuards(c.id, [writes("one-more")]) }))).rejects.toThrow(/scope matchers/);
    expect(names(await stub.policy())).toEqual(before);
    expect((await stub.info()).attached).not.toContain("agt_more");
    // A layer alone past it (each list within its own bounds): 400, and the layer stays as it was.
    const five = (i: number): ClientGuardT => ({ ...four(i), scope: [...four(i).scope, { methods: ["MOVE"] }] });
    const over = await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: Array.from({ length: 13 }, (_, i) => five(i)) } });
    expect(over.status).toBe(400);
    expect(over.body.error.message).toContain("scope matchers");
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toHaveLength(16);
    expect(names(await stub.policy())).toEqual(before);
  });

  it("a create past the sandbox's bound is refused (400) and creates nothing", async () => {
    const c = await newClient();
    const eight = (i: number): ClientGuardT => ({ ...writes(`g${i}`), scope: Array.from({ length: 8 }, (_, j) => ({ methods: [`M${"ABCDEFGH"[j]}`] })) });
    const r = await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: Array.from({ length: 16 }, (_, i) => eight(i)) } });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("scope matchers");
    // Its client admitted no place for it: the registry is as empty as before, and a create within the bound still goes.
    expect((await ok(c.token, "/v1/sandboxes")).sandboxes).toEqual([]);
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: Array.from({ length: 8 }, (_, i) => eight(i)) } })).status).toBeLessThan(300);
    // And SandboxDO refuses it too, whoever calls it.
    const id = `sbx_${rand()}`;
    await expect(Promise.resolve().then(() => env.SANDBOX.get(env.SANDBOX.idFromName(id)).create({
      sandbox: id, cell: c.cell, client: c.id, guards: Array.from({ length: 16 }, (_, i) => eight(i)),
    }))).rejects.toThrow(/scope matchers/);
  });

  it("an agent's guards leave the sandbox's store at its detach", async () => {
    const c = await newClient();
    const s = await placed(c);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await stub.attach("agt_kept", undefined, [], [], { guards: holdGuards(c.id, [PUSH]) });
    await stub.attach("agt_gone", undefined, [], [], { guards: holdGuards(c.id, [API_WRITE]) });
    await stub.detach("agt_gone");
    const stored = await runInDurableObject(stub, (_i, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'agent_guards'").one().value) as Record<string, unknown>);
    expect(Object.keys(stored)).toEqual(["agt_kept"]);
  });

  it("are refused (409), never dropped, while a sandbox host of the cell runs a nest-proxy that doesn't bound them", async () => {
    const c = await newClient();
    const s = await placed(c);
    // A host of the previous release joins the cell: its hello says nothing of guard bounds.
    await connectHost(c.cell, "sandbox", { guard_bounds: false });
    const layer = await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [NO_DELETE] } });
    expect(layer.status).toBe(409);
    // A code of its own, so a client tells it from another conflict without reading the message.
    expect(layer.body.error).toMatchObject({ code: "hosts_not_ready", retryable: false });
    expect(layer.body.error.message).toContain("bound guarded requests");
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([]);
    // A layer without guards still goes through.
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { A: "1" } } });
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: [NO_DELETE] } })).status).toBe(409);
    expect((await ok(c.token, "/v1/sandboxes")).sandboxes.map((x: { sandbox: string }) => x.sandbox)).toEqual([s.sandbox]);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await expect(Promise.resolve().then(() => stub.attach("agt_g", undefined, [], [], { guards: holdGuards(c.id, [PUSH]) }))).rejects.toThrow(/bound guarded requests/);
    expect((await stub.info()).attached).not.toContain("agt_g");
    // Another subtree's guards don't count here, so they aren't refused either.
    await stub.attach("agt_other", undefined, [], [], { guards: holdGuards("cli_someoneelse", [PUSH]) });
  });

  it("a write that adds no guard goes through while a host can't bound them; one that adds a guard is refused", async () => {
    const c = await newClient();
    const s = await placed(c, { guards: [NO_DELETE, PUSH] });
    await connectHost(c.cell, "sandbox", { guard_bounds: false });
    // The whole layer again, with its env changed and a guard dropped: nothing added, so accepted.
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [PUSH], env: { A: "1" } } });
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`))).toMatchObject({ guards: [PUSH], env: { A: "1" } });
    // Putting back the one it dropped adds a guard to what is stored now: refused.
    const back = await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [PUSH, NO_DELETE] } });
    expect(back.status).toBe(409);
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [{ ...PUSH, reason: "changed" }] } })).status).toBe(409);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([PUSH]);
  });

  it("a write let through as adding no guard is refused if the guards it was checked against changed meanwhile", async () => {
    const c = await newClient();
    const s = await placed(c, { guards: [NO_DELETE] });
    await connectHost(c.cell, "sandbox", { guard_bounds: false });
    // Hold the sandbox's own grant read (the second scope() of the PUT; the route's is the first).
    const real = ClientDO.prototype.scope;
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached = false;
    ClientDO.prototype.scope = async function (this: ClientDO) {
      const r = await real.call(this);
      if (++calls === 2) {
        reached = true;
        await gate;
      }
      return r;
    };
    try {
      const put = as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [NO_DELETE] } });
      await eventually("the write's grant read is held", () => reached);
      // Meanwhile the guards are emptied (a write without guards always goes through).
      await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: {} });
      release();
      const r = await put;
      expect(r.status).toBe(409);
      expect(r.body.error.message).toContain("changed while this layer was written");
    } finally {
      ClientDO.prototype.scope = real;
    }
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([]);
  });

  it("a sandbox with client guards is placed only on a host that bounds them, and waits rather than go elsewhere", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const old = await connectHost(cell, "sandbox", { guard_bounds: false });
    const policy = (guards: RequestGuard[]) => ({
      version: 1, allow: [], passthrough: [], inject: [], tcp: [], guards, limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 },
    });
    const place = (sandbox: string, guards: RequestGuard[]) => fleet.place({
      sandbox, workstream: "ws_test", epoch: 1, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 }, policy: policy(guards),
    });
    expect(await place(`sbx_${rand()}`, [wireGuard(NO_DELETE)])).toBeNull();
    // The operator's guards alone go anywhere, as before.
    expect(await place(`sbx_${rand()}`, [{ name: "store-write", hosts: ["files.example.com"], scope: [{}] }])).toBe(old.host);
    const current = await connectHost(cell);
    expect(await place(`sbx_${rand()}`, [wireGuard(NO_DELETE)])).toBe(current.host);
  });

  it("an expired host of the previous release still counts (it may come back); a dead one doesn't", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const old = await connectHost(cell, "sandbox", { guard_bounds: false });
    await connectHost(cell);
    expect(await fleet.hostsWithoutGuardBounds()).toEqual([old.host]);
    const status = (to: string) => runInDurableObject(fleet, (_i, st) => { st.storage.sql.exec("UPDATE hosts SET status = ? WHERE host = ?", to, old.host); });
    await status("expired");
    expect(await fleet.hostsWithoutGuardBounds()).toEqual([old.host]);
    await status("dead");
    expect(await fleet.hostsWithoutGuardBounds()).toEqual([]);
  });

  it("a host not heard from since enrolling counts as one that doesn't bound them", async () => {
    const c = await newClient();
    const s = await placed(c);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [NO_DELETE] } });
    await enrollHost(c.cell, "sandbox");
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { guards: [NO_DELETE, PUSH] } })).status).toBe(409);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).guards).toEqual([NO_DELETE]);
  });

  it("a client's guard never changes how the operator routes a passthrough host or a TCP exception", async () => {
    const c = await newClient();
    const s = await placed(c, { guards: [{ ...writes("w"), hosts: ["pinned.example.com", "db.example.com", "files.example.com"] }] });
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: {
      allow: [{ host: "pinned.example.com" }], passthrough: ["pinned.example.com"], tcp: [{ host: "db.example.com", port: 5432 }] } });
    const g = (await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`)).guards.find((x: RequestGuard) => x.name === "client:w");
    expect(g.hosts).toEqual(["files.example.com"]);
  });
});
