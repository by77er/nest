// `injected: "*"` and `at` in a request guard (docs/sandbox/networking/egress/policy/#any-injected-credential):
// `*` holds when nest-proxy substituted a credential, whichever binding's; `at` when it wrote a named
// header whole. The operator's layers (base and operator) use them anywhere; a client names `*` in
// exceptions only. A host of the previous release reads `*` as a binding's name and ignores `at`, which
// fails some positions open, so a guard newly using either is refused (409) while any sandbox host of the
// cell lacks `guard_injected_any`, and a sandbox whose guards hold a fail-open position is placed only on a
// host with it. nest-proxy's side is crates/nest-proxy/tests/injected_any.rs, on the same fixture.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.injected_any.json";
import { ClientGuard, ClientGuards, holdGuards, wireGuard, type ClientGuard as ClientGuardT } from "../src/lib/client-guards";
import { basicAtFailsOpen, failsOpenOnOldProxy, freshInjectedAny, scopeNamesInjectedAny, usesInjectedMatchers } from "../src/lib/injected-any";
import { ClientInjection } from "../src/lib/client-secrets";
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
    expect(FLOOR!.allow).toEqual([{ injected: "*", at: "authorization" }]);
  });

  it("a client's matcher may name the header (at), in a scope or an exception, sent as written", () => {
    const ok = (g: unknown) => ClientGuard.safeParse(g).success;
    const at = { ...API_WRITE, allow: [{ injected: "*", at: "authorization" }, { injected: "svc", at: "X-Api-Key" }] };
    expect(ok(at)).toBe(true);
    expect(wireGuard(ClientGuard.parse(at)).allow).toEqual([{ injected: "*", at: "authorization" }, { injected: "client:svc", at: "X-Api-Key" }]);
    expect(ok({ ...API_WRITE, scope: [{ injected: "svc", at: "authorization" }] })).toBe(true);
    for (const h of ["", "two words", "a:b", "x".repeat(65)]) expect(ok({ ...API_WRITE, allow: [{ at: h }] }), h).toBe(false);
  });

  it("the operator names no binding * or the empty name (a guard's * means any binding)", () => {
    const binding = (name: string) => ({ inject: [{ name, hosts: ["x.org"], placeholder: "nest-ph-x", locations: [{ type: "authorization_bearer" }] }] });
    expect(SandboxPolicyLayer.safeParse(binding("svc")).success).toBe(true);
    for (const name of ["*", ""]) expect(SandboxPolicyLayer.safeParse(binding(name)).success, name).toBe(false);
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

  it("knows where a guard uses them, which positions fail open on an old proxy, and which of a write's guards are new", () => {
    expect(scopeNamesInjectedAny([FLOOR!])).toBe(false);
    expect(scopeNamesInjectedAny([NO_UPLOADS!])).toBe(true);
    const g = (scope: RequestGuard["scope"], allow: RequestGuard["allow"] = []): RequestGuard => ({ name: "n", hosts: [], scope, allow });
    expect(usesInjectedMatchers(g([{ injected: "svc" }], [{ injected: "svc" }]))).toBe(false);
    expect(usesInjectedMatchers(g([{}], [{ at: "x" }]))).toBe(true);
    expect(usesInjectedMatchers(FLOOR!)).toBe(true);
    // Fail open on an old proxy (crates/nest-proxy/tests/guard_equivalence.rs): `*` in a scope, `at` with a
    // binding named in a scope, `at` without `*` in an exception.
    for (const open of [g([{ injected: "*" }]), g([{ injected: "svc", at: "authorization" }]), g([{}], [{ at: "authorization" }]),
      g([{}], [{ injected: "svc", at: "authorization" }])]) expect(failsOpenOnOldProxy([open]), JSON.stringify(open)).toBe(true);
    // Fail closed: `*` in an exception (the floor's form, with or without `at`), `at` alone in a scope, named bindings.
    for (const closed of [FLOOR!, g([{}], [{ injected: "*" }]), g([{ at: "authorization" }]), g([{ injected: "svc" }], [{ injected: "svc" }])]) {
      expect(failsOpenOnOldProxy([closed]), JSON.stringify(closed)).toBe(false);
    }
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

  it("a sandbox whose guards fail open on an old proxy is placed only on a host that knows * and at; fail-closed ones go anywhere", async () => {
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
    // An exception's `at` without `*` there loses its header condition (fail open), as does a scope's `at` with a binding named.
    expect(await place([{ ...FLOOR!, allow: [{ injected: "svc", at: "authorization" }] }])).toBeNull();
    expect(await place([{ ...NO_UPLOADS!, scope: [{ injected: "svc", at: "authorization" }] }])).toBeNull();
    // An exception's `*` there only refuses more (fail closed), with `at` (the floor) or without, and a named binding is as before.
    expect(await place([FLOOR!])).toBe(old.host);
    expect(await place([{ ...FLOOR!, allow: [{ injected: "*" }] }])).toBe(old.host);
    expect(await place([{ ...NO_UPLOADS!, scope: [{ injected: "svc" }] }])).toBe(old.host);
    const current = await connectHost(cell);
    expect(await place([NO_UPLOADS!])).toBe(current.host);
  });

  it("placement reads the cell's base layer from FleetDO, not only the policy the sandbox built from its own copy", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    // A base-layer guard that fails open on an old proxy, written while every host knows `*`.
    await adminJson(base(cell), { method: "PUT", body: { allow: [], guards: [{ ...NO_UPLOADS!, name: "base-scope" }] } });
    const old = await connectHost(cell, "sandbox", { guard_injected_any: false });
    // A sandbox whose policy predates the write (its own copy of the base layer has no guard): still not there.
    const place = () => fleet.place({
      sandbox: `sbx_${rand()}`, workstream: "ws_test", epoch: 1, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 },
      policy: { version: 1, allow: [], passthrough: [], inject: [], tcp: [], guards: [], limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 } },
    });
    expect(await place()).toBeNull();
    // A floor in exceptions only (fail closed there) doesn't keep it off.
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET guard_injected_any = 1 WHERE host = ?", old.host);
    });
    await adminJson(base(cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } });
    await runInDurableObject(fleet, (_i, st) => {
      st.storage.sql.exec("UPDATE hosts SET guard_injected_any = 0 WHERE host = ?", old.host);
    });
    expect(await place()).toBe(old.host);
  });
});

// A binding's Basic `username` (docs/sandbox/networking/egress/policy/#any-injected-credential): nest-proxy
// writes it with the secret, and only then is the Basic field nest's whole. A host of the previous release
// (no `guard_basic_user`) keeps the request's username and takes any Basic substitution as whole, so `at`
// beside a Basic binding fails open there: such guards wait for every host, and such sandboxes are placed
// only on a host that says it. nest-proxy's side is inject.rs's unit tests.
describe("a Basic username of the binding's", () => {
  it("a client names it on its Basic location (a username, no colon); a narrowing can't change it", () => {
    const binding = (loc: unknown) => ClientInjection.safeParse({ name: "gh", secret: "gh-push", hosts: ["github.com"], locations: [loc] });
    expect(binding({ type: "authorization_basic_password", username: "x-access-token" }).success).toBe(true);
    expect(binding({ type: "authorization_basic_password" }).success).toBe(true);
    for (const u of ["", "a:b", "two words", "x".repeat(65)]) expect(binding({ type: "authorization_basic_password", username: u }).success, u).toBe(false);
    // Two Basic locations differing by username are two locations.
    expect(ClientInjection.safeParse({ name: "gh", secret: "gh-push", hosts: ["github.com"], locations: [
      { type: "authorization_basic_password", username: "a" }, { type: "authorization_basic_password", username: "b" }] }).success).toBe(true);
    expect(ClientInjection.safeParse({ name: "gh", secret: "gh-push", hosts: ["github.com"], locations: [
      { type: "authorization_basic_password", username: "a" }, { type: "authorization_basic_password", username: "a" }] }).success).toBe(false);
  });

  it("knows a policy where at beside a Basic binding fails open on such a host", () => {
    const at: RequestGuard = { name: "n", hosts: ["github.com"], scope: [{}], allow: [{ injected: "*", at: "authorization" }] };
    const plain: RequestGuard = { name: "n", hosts: ["github.com"], scope: [{}], allow: [{ injected: "*" }] };
    const basic = [{ locations: [{ type: "authorization_basic_password" }] }];
    const bearer = [{ locations: [{ type: "authorization_bearer" }] }];
    expect(basicAtFailsOpen([at], basic)).toBe(true);
    expect(basicAtFailsOpen([{ ...at, scope: [{ at: "authorization" }], allow: [] }], basic)).toBe(true);
    expect(basicAtFailsOpen([at], bearer)).toBe(false);
    expect(basicAtFailsOpen([plain], basic)).toBe(false);
  });

  it("a guard newly using at is refused (409) while a host of the cell keeps the request's Basic username; * without at isn't", async () => {
    const c = await newClient();
    const current = await connectHost(c.cell);
    const sbx = (await as(c.token, "/v1/sandboxes", { body: { cell: c.cell } })).body.sandbox as string;
    await nextCommands(current.ws, (x) => x.type === "sandbox_create");
    await connectHost(c.cell, "sandbox", { guard_basic_user: false });
    const withAt: ClientGuardT = { ...API_WRITE, allow: [{ injected: "*", at: "authorization" }] };
    const r = await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [withAt] } });
    expect(r.status).toBe(409);
    expect((await admin(base(c.cell), { method: "PUT", body: { allow: [], guards: [FLOOR] } })).status).toBe(409);
    // `*` alone needs only `guard_injected_any`, which that host has.
    expect((await as(c.token, `/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", body: { guards: [API_WRITE] } })).status).toBe(200);
  });

  it("a sandbox with at beside a Basic binding is placed only on a host that writes the username itself", async () => {
    const cell = uniqueCell();
    const fleet = env.FLEET.get(env.FLEET.idFromName(cell));
    const old = await connectHost(cell, "sandbox", { guard_basic_user: false });
    const binding = (type: string) => ({ name: "client:gh", hosts: ["github.com"], placeholder: "nest-ph.cli_x.gh.", locations: [{ type }] });
    const place = (inject: unknown[]) => fleet.place({
      sandbox: `sbx_${rand()}`, workstream: "ws_test", epoch: 1, image: "x", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 },
      policy: { version: 1, allow: [], passthrough: [], inject: inject as never, tcp: [], guards: [FLOOR!], limits: { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 } },
    });
    expect(await place([binding("authorization_basic_password")])).toBeNull();
    expect(await place([binding("authorization_bearer")])).toBe(old.host);
    const current = await connectHost(cell);
    expect(await place([binding("authorization_basic_password")])).toBe(current.host);
    // Its hello is recorded per host.
    expect(await runInDurableObject(fleet, (_i, st) => st.storage.sql.exec("SELECT host, guard_basic_user AS b FROM hosts ORDER BY b").toArray().map((r) => r.b))).toEqual([0, 1]);
  });
});
