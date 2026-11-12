// `injected: "*"` in a request guard (docs/sandbox/networking/egress/policy/#any-injected-credential): a
// matcher that holds when nest-proxy substituted a credential, whichever binding's. The operator's layers
// (base and operator) name it anywhere; a client names it in exceptions only. A host of the previous release
// reads `*` as a binding's name, which fails a scope open, so a guard newly naming it is refused (409) while
// any sandbox host of the cell lacks `guard_injected_any`, and a sandbox whose scopes name it is placed only
// on a host with it. nest-proxy's side is crates/nest-proxy/tests/injected_any.rs, on the same fixture.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.injected_any.json";
import { ClientGuard, ClientGuards, holdGuards, wireGuard, type ClientGuard as ClientGuardT } from "../src/lib/client-guards";
import { freshInjectedAny, namesInjectedAny } from "../src/lib/injected-any";
import { EgressBaseInput, SandboxPolicyLayer } from "../src/do/sandbox";
import { INJECTED_ANY, type RequestGuard } from "../src/protocol/model";
import { ClientDO } from "../src/do/client";
import { admin, adminJson, BASE, connectHost, enrollHost, eventually, nextCommands, uniqueCell } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

/** The fixture's guards by name: the base layer's floor, the operator's scope, the client's exception. */
const [FLOOR, NO_UPLOADS, CLIENT_WIRE] = fixture.guards as RequestGuard[];
/** The client's guard as the client writes it (on the wire `client:api-write`). */
const API_WRITE: ClientGuardT = {
  name: "api-write", hosts: ["api.example.com"], scope: [{ methods_except: ["GET", "HEAD"] }],
  allow: [{ methods: ["POST"], path: "/query", injected: "*" }],
};

describe("injected: \"*\" (pure)", () => {
  it("the base layer's floor, the operator's scope and a client's exception are exactly the fixture nest-proxy's seam test evaluates", () => {
    expect(INJECTED_ANY).toBe("*");
    const base = EgressBaseInput.parse({ allow: [], guards: [FLOOR] }).guards;
    const operator = SandboxPolicyLayer.parse({ guards: [NO_UPLOADS] }).guards;
    // SandboxDO's order: the base layer's, the operator's, then the client's.
    expect([...base, ...operator, ...ClientGuards.parse([API_WRITE]).map(wireGuard)]).toEqual(fixture.guards);
    expect(CLIENT_WIRE!.allow![0]!.injected).toBe("*");
  });

  it("a client names * in an exception, where it stays *, never in a scope; a named binding stays its own", () => {
    const ok = (g: unknown) => ClientGuard.safeParse(g).success;
    expect(ok(API_WRITE)).toBe(true);
    expect(ok({ ...API_WRITE, scope: [{ methods: ["POST"], injected: "*" }] })).toBe(false);
    expect(ClientGuard.safeParse({ ...API_WRITE, scope: [{ injected: "*" }] }).error?.issues[0]?.message).toContain("for exceptions");
    // Only `*` itself: no other pattern, and no wire name.
    for (const injected of ["s*", "**", "*x", "client:svc", ""]) expect(ok({ ...API_WRITE, allow: [{ injected }] }), injected).toBe(false);
    expect(wireGuard(ClientGuard.parse({ ...API_WRITE, allow: [{ injected: "svc" }, { injected: "*" }] })).allow).toEqual([
      { injected: "client:svc" }, { injected: "*" }]);
  });

  it("knows where a guard names it, and which of a write's guards newly do", () => {
    expect(namesInjectedAny([FLOOR!], "scope")).toBe(false);
    expect(namesInjectedAny([FLOOR!], "any")).toBe(true);
    expect(namesInjectedAny([NO_UPLOADS!], "scope")).toBe(true);
    const named: RequestGuard = { name: "n", hosts: [], scope: [{ injected: "svc" }], allow: [{ injected: "svc" }] };
    expect(namesInjectedAny([named], "any")).toBe(false);
    const plain = { name: "plain", hosts: ["x.org"], scope: [{}] };
    expect(freshInjectedAny([FLOOR!, NO_UPLOADS!, plain], [FLOOR])).toEqual([NO_UPLOADS]);
    expect(freshInjectedAny([{ ...FLOOR!, reason: "changed" }], [FLOOR])).toHaveLength(1);
  });
});

// --- Through the Worker and the Durable Objects, with fake sandbox hosts ---------------------------------

const base = (cell: string) => `/v1/admin/egress/base?cell=${cell}`;
/** The GitHub constructor's guards' names (`githubGuards`), in every sandbox's policy. */
const CONSTRUCTED = /^(github|gist|githubusercontent)-/;

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}) {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

async function newClient(cell = uniqueCell()) {
  const c = await adminJson("/v1/admin/clients", { body: { name: `any-${rand()}`, grant: {
    cells: [cell], credentials: ["claude_oauth_token"], max_agents: 8, max_sandboxes: 5, secrets: { max_count: 3, max_bytes: 64 },
    inject_hosts: ["api.example.com"], egress_hosts: ["api.example.com"],
  } } }, 201);
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  return { id: c.client as string, token: c.token as string, cell };
}

describe("injected: \"*\" through the control plane", () => {
  it("reaches nest-proxy as the fixture: the base layer's floor, the operator's guard, then the client's", async () => {
    const c = await newClient();
    const host = await connectHost(c.cell);
    await adminJson(base(c.cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } });
    const sbx = await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: [API_WRITE] } });
    expect(sbx.status, JSON.stringify(sbx.body)).toBe(201);
    await nextCommands(host.ws, (x) => x.type === "sandbox_create");
    await adminJson(`/v1/sandboxes/${sbx.body.sandbox}/policy`, { method: "PUT", body: { guards: [NO_UPLOADS] } });
    const [update] = await nextCommands(host.ws, (x) => x.type === "policy_update");
    // The GitHub constructor's guards (always built, between the base layer's and the operator's) aside.
    expect(update.policy.guards.filter((g: RequestGuard) => !CONSTRUCTED.test(g.name))).toEqual(fixture.guards);
  });

  it("is refused (409) in every layer while a sandbox host of the cell reads * as a name; other guards still go through", async () => {
    const c = await newClient();
    const current = await connectHost(c.cell);
    const sbx = (await as(c.token, "/v1/sandboxes", { body: { cell: c.cell } })).body.sandbox as string;
    await nextCommands(current.ws, (x) => x.type === "sandbox_create");
    // A host of the previous release joins: its hello bounds guards but says nothing of `*`.
    await connectHost(c.cell, "sandbox", { guard_injected_any: false });
    const named: RequestGuard = { ...FLOOR!, name: "named", allow: [{ injected: "svc" }] };
    // The base layer.
    const b = await admin(base(c.cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } });
    expect(b.status).toBe(409);
    expect((await b.json() as { error: { message: string } }).error.message).toContain("injected \"*\"");
    expect((await adminJson(base(c.cell))).version).toBe(0);
    await adminJson(base(c.cell), { method: "PUT", body: { allow: [], guards: [named] } });
    // The operator layer, live and at create.
    expect((await admin(`/v1/sandboxes/${sbx}/policy`, { method: "PUT", body: { guards: [NO_UPLOADS] } })).status).toBe(409);
    expect((await adminJson(`/v1/sandboxes/${sbx}/policy`)).guards.map((g: RequestGuard) => g.name).filter((n: string) => !CONSTRUCTED.test(n))).toEqual(["named"]);
    expect((await admin("/v1/sandboxes", { body: { cell: c.cell, policy: { guards: [FLOOR] } } })).status).toBe(409);
    await adminJson(`/v1/sandboxes/${sbx}/policy`, { method: "PUT", body: { guards: [named] } });
    // A client's layer, live and at create, and an attached agent's.
    expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [API_WRITE] } })).status).toBe(409);
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: [API_WRITE] } })).status).toBe(409);
    await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [{ ...API_WRITE, allow: [{ injected: "svc" }] }] } })
      .then((r) => expect(r.status, JSON.stringify(r.body)).toBe(200));
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sbx));
    await expect(Promise.resolve().then(() => stub.attach("agt_any", undefined, [], [], { guards: holdGuards(c.id, [API_WRITE]) }))).rejects.toThrow(/injected "\*"/);
    expect((await stub.info()).attached).not.toContain("agt_any");
  });

  it("one already stored stays writable while such a host is in the cell; one newly added is refused", async () => {
    const c = await newClient();
    const current = await connectHost(c.cell);
    await adminJson(base(c.cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } });
    const sbx = (await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: [API_WRITE] } })).body.sandbox as string;
    await nextCommands(current.ws, (x) => x.type === "sandbox_create");
    await adminJson(`/v1/sandboxes/${sbx}/policy`, { method: "PUT", body: { guards: [NO_UPLOADS] } });
    await connectHost(c.cell, "sandbox", { guard_injected_any: false });
    // The same guards again, beside other changes: accepted.
    await adminJson(base(c.cell), { method: "PUT", body: { allow: [{ host: "deb.debian.org" }], guards: [FLOOR] } });
    await adminJson(`/v1/sandboxes/${sbx}/policy`, { method: "PUT", body: { allow: [{ host: "x.example.org" }], guards: [NO_UPLOADS] } });
    expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { env: { A: "1" }, guards: [API_WRITE] } })).status).toBe(200);
    // Changed (a new guard, even the same one renamed or reworded): refused.
    expect((await admin(base(c.cell), { method: "PUT", body: { allow: [], guards: [{ ...FLOOR!, reason: "changed" }] } })).status).toBe(409);
    expect((await admin(`/v1/sandboxes/${sbx}/policy`, { method: "PUT", body: { guards: [{ ...NO_UPLOADS!, name: "renamed" }] } })).status).toBe(409);
    expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [{ ...API_WRITE, name: "other" }] } })).status).toBe(409);
  });

  it("a client write let through because its * guard was stored is refused if that guard went meanwhile", async () => {
    const c = await newClient();
    const current = await connectHost(c.cell);
    const sbx = (await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, guards: [API_WRITE] } })).body.sandbox as string;
    await nextCommands(current.ws, (x) => x.type === "sandbox_create");
    await connectHost(c.cell, "sandbox", { guard_injected_any: false });
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
      // Its `*` guard is stored, and a plain guard is new (so the write isn't "adds none").
      const plain: ClientGuardT = { name: "plain", hosts: ["api.example.com"], scope: [{ methods: ["DELETE"] }] };
      const put = as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [API_WRITE, plain] } });
      await eventually("the write's grant read is held", () => reached);
      // Meanwhile the guards are emptied (a write without guards always goes through).
      expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: {} })).status).toBe(200);
      release();
      const r = await put;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.message).toContain("changed while this layer was written");
    } finally {
      ClientDO.prototype.scope = real;
    }
    expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`)).body.guards).toEqual([]);
  });

  it("a host not heard from since enrolling, or expired, counts; a dead one doesn't", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    await connectHost(cell);
    expect(await fleet.hostsWithoutInjectedAny()).toEqual([]);
    const enrolled = await enrollHost(cell, "sandbox");
    expect(await fleet.hostsWithoutInjectedAny()).toEqual([enrolled.host]);
    expect((await admin(base(cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } })).status).toBe(409);
    const status = (to: string) => runInDurableObject(fleet, (_i, st) => { st.storage.sql.exec("UPDATE hosts SET status = ? WHERE host = ?", to, enrolled.host); });
    await status("expired");
    expect(await fleet.hostsWithoutInjectedAny()).toEqual([enrolled.host]);
    await status("dead");
    expect(await fleet.hostsWithoutInjectedAny()).toEqual([]);
    await adminJson(base(cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } });
  });

  it("a sandbox whose scopes name * is placed only on a host that reads it as any binding; one naming it only in exceptions goes anywhere", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const old = await connectHost(cell, "sandbox", { guard_injected_any: false });
    const policy = (guards: RequestGuard[]) => ({
      version: 1, allow: [], passthrough: [], inject: [], tcp: [], guards, limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 },
    });
    const place = (guards: RequestGuard[]) => fleet.place({
      sandbox: `sbx_${rand()}`, workstream: "ws_test", epoch: 1, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 }, policy: policy(guards),
    });
    // A scope's `*` there would match nothing (fail open): no placement while that host is all there is.
    expect(await place([NO_UPLOADS!])).toBeNull();
    // An exception's `*` there only refuses more (fail closed), and a named binding is as before.
    expect(await place([FLOOR!])).toBe(old.host);
    expect(await place([{ ...NO_UPLOADS!, scope: [{ injected: "svc" }] }])).toBe(old.host);
    const current = await connectHost(cell);
    expect(await place([NO_UPLOADS!])).toBe(current.host);
  });
});
