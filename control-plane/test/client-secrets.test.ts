// API clients' secrets and injection bindings (docs/control-plane/api/clients/#secrets, #injection): a
// client stores write-only secrets under its own id in BrokerDO, within its grant's `secrets`; its
// templates, spawn overrides and sandbox specs declare bindings naming them, on hosts within its grant's
// `inject_hosts`; the sandbox's policy carries the binding with the placeholder nest assigns, and only
// its proxy's `secrets_update` (from FleetDO) carries the value. The pure checks first, then each
// through the Worker and the Durable Objects with a fake sandbox host.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.client_inject.json";
import {
  ClientInjection, holdInjections, injectHostAllowed, InjectHost, injectionPlaceholder, injectionsOutsideGrant, narrowInjections, wireBinding,
} from "../src/lib/client-secrets";
import { Grant } from "../src/lib/clients";
import { GITHUB_PLACEHOLDER, GITHUB_READ_PLACEHOLDER } from "../src/lib/rules/github";
import { ClientDO } from "../src/do/client";
import { SandboxDO } from "../src/do/sandbox";
import { BrokerDO } from "../src/do/broker";
import { ADMIN, adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell, type Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

// --- Pure ---------------------------------------------------------------------------------------------------

describe("client injection bindings (pure)", () => {
  const stripe = { name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: [{ type: "authorization_bearer" as const }] };

  it("are ordinary bindings on the wire: exactly the fixture nest-proxy's seam test evaluates", () => {
    const held = holdInjections("cli_01JTESTCLIENT", [
      stripe,
      { name: "search", secret: "search-key", hosts: ["*.example.com"], wildcard: true, locations: [{ type: "header", name: "X-Api-Key" }, { type: "authorization_basic_password" }] },
      // A Basic username the binding names: the proxy writes it, so the header is written whole.
      { name: "git", secret: "git-key", hosts: ["git.example.org"], locations: [{ type: "authorization_basic_password", username: "x-access-token" }] },
    ]);
    expect([fixture.inject[0], ...held.map(wireBinding)]).toEqual(fixture.inject);
  });

  it("no placeholder nest assigns contains another, nor the GitHub ones (nest-proxy finds placeholders as substrings)", () => {
    const names = ["a", "ab", "a_b", "b", "abc_1"];
    const all = [...["cli_1", "cli_12", "cli_2"].flatMap((c) => names.map((n) => injectionPlaceholder(c, n))), GITHUB_PLACEHOLDER, GITHUB_READ_PLACEHOLDER];
    for (const x of all) for (const y of all) expect(x === y || !x.includes(y), `${x} contains ${y}`).toBe(true);
    // A name that could break that is refused.
    for (const bad of ["a-b", "a.b", "A", "_a", ""]) expect(ClientInjection.safeParse({ ...stripe, name: bad }).success, bad).toBe(false);
  });

  it("validates hosts, wildcards and headers", () => {
    for (const ok of ["api.stripe.com", "*.example.com", "a-b.c.d"]) expect(InjectHost.safeParse(ok).success, ok).toBe(true);
    // Every numeric form a resolver reads as an address (inet_aton: hex, octal, short forms) is refused too.
    for (const bad of ["*.com", "com", "API.stripe.com", "1.2.3.4", "127.0.0.0x1", "0x7f.0x1", "0177.0.0.1", "10.1", "a.0x1", "a..b", "*.*.b.c",
      "api.stripe.com.", "http://x.y", "x.y:443"]) {
      expect(InjectHost.safeParse(bad).success, bad).toBe(false);
    }
    expect(ClientInjection.safeParse({ ...stripe, hosts: ["*.example.com"] }).success).toBe(false);
    expect(ClientInjection.safeParse({ ...stripe, hosts: ["*.example.com"], wildcard: true }).success).toBe(true);
    // The framing and routing headers, and the routing overrides nest-proxy strips (Fastly-Key authenticates, so it's allowed).
    expect(ClientInjection.safeParse({ ...stripe, locations: [{ type: "header", name: "Fastly-Key" }] }).success).toBe(true);
    for (const h of ["Host", "proxy-authorization", "Transfer-Encoding", "bad header", "Forwarded", "X-Forwarded-Host", "X-Host", "X-Original-URL",
      "X-Rewrite-URL", "Fastly-Host", "fastly-anything"]) {
      expect(ClientInjection.safeParse({ ...stripe, locations: [{ type: "header", name: h }] }).success, h).toBe(false);
    }
    expect(ClientInjection.safeParse({ ...stripe, placeholder: "nest-ph-github" }).success).toBe(false);
  });

  it("a host is within inject_hosts exactly, or under a wildcard entry; a wildcard host only under a wildcard entry as wide", () => {
    const entries = ["api.stripe.com", "*.example.com"];
    expect(injectHostAllowed(entries, "api.stripe.com")).toBe(true);
    expect(injectHostAllowed(entries, "x.example.com")).toBe(true);
    expect(injectHostAllowed(entries, "*.example.com")).toBe(true);
    expect(injectHostAllowed(entries, "*.a.example.com")).toBe(true);
    expect(injectHostAllowed(entries, "example.com")).toBe(false);
    expect(injectHostAllowed(entries, "stripe.com")).toBe(false);
    expect(injectHostAllowed(entries, "*.stripe.com")).toBe(false);
    expect(injectHostAllowed(entries, "api.stripe.com.evil.net")).toBe(false);
    expect(injectHostAllowed(["api.stripe.com"], "*.stripe.com")).toBe(false);
    // A suffix is whole labels: a name that merely ends in the same letters isn't under it.
    expect(injectHostAllowed(entries, "*.evilexample.com")).toBe(false);
    expect(injectHostAllowed(entries, "x.evilexample.com")).toBe(false);
    expect(injectHostAllowed(entries, "evilexample.com")).toBe(false);
    expect(injectionsOutsideGrant([{ name: "s", hosts: ["api.stripe.com", "evil.net"] }], entries)).toEqual(["inject host evil.net (binding s)"]);
    // A grant stored before inject_hosts reads as none (the default), and its entries are validated.
    expect(Grant.parse({}).inject_hosts).toEqual([]);
    expect(Grant.safeParse({ inject_hosts: ["*.com"] }).success).toBe(false);
    expect(Grant.parse({}).secrets).toEqual({ max_count: 0, max_bytes: 4096 });
  });

  it("overrides only narrow: a binding of the template's, its secret, a subset of its hosts and locations", () => {
    const base = holdInjections("cli_x", [{ ...stripe, hosts: ["api.stripe.com", "files.stripe.com"], locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password" }] }]);
    const narrowed = narrowInjections(base, [{ ...stripe, hosts: ["files.stripe.com"] }]);
    expect(narrowed).toEqual({ ok: true, value: [{ ...base[0], hosts: ["files.stripe.com"], locations: [{ type: "authorization_bearer" }] }] });
    expect(narrowInjections(base, [])).toEqual({ ok: true, value: [] });
    expect(narrowInjections(base, undefined)).toEqual({ ok: true, value: base });
    expect(narrowInjections(base, [{ ...stripe, hosts: ["evil.net"] }])).toEqual({ ok: false, error: "binding stripe: can't widen its hosts with evil.net" });
    expect(narrowInjections(base, [{ ...stripe, secret: "other" }])).toEqual({ ok: false, error: "binding stripe: can't change its secret" });
    expect(narrowInjections(base, [{ ...stripe, name: "more" }])).toEqual({ ok: false, error: "can't add the binding more" });
    expect(narrowInjections(base, [{ ...stripe, locations: [{ type: "header", name: "X-Key" }] }])).toEqual({ ok: false, error: "binding stripe: can't add a location" });
  });
});

// --- Through the Worker -------------------------------------------------------------------------------------

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const res = await as(token, path, init);
  const text = await res.text();
  if (status !== undefined) expect(res.status, `${path}: ${text}`).toBe(status);
  else expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true);
  return (text ? JSON.parse(text) : {}) as T;
}

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const BEARER = [{ type: "authorization_bearer" }];

/** A client on a fresh cell with a sandbox host connected, whose grant allows secrets and `api.stripe.com`. */
async function newClient(grant: Record<string, unknown> = {}) {
  const cell = uniqueCell();
  const name = `sec-${rand()}`;
  const g = { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 5, max_sandboxes: 5, secrets: { max_count: 3, max_bytes: 64 },
    inject_hosts: ["api.stripe.com", "*.example.com"], ...grant };
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: g } }, 201);
  return { id: c.client as string, name, token: c.token as string, cell };
}
type Client = Awaited<ReturnType<typeof newClient>>;

/** A fake value per test, low-entropy and built at run time (no literal a secret scan would flag). */
const fakeValue = (tag: string) => `value-${tag}-${rand()}`;

async function auditTexts(): Promise<string[]> {
  const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
  return Promise.all(listed.objects.map(async (o) => (await env.BUCKET.get(o.key))!.text()));
}

/** A sandbox the client creates with `body`, placed on a host of its cell: its id, the host's socket, and the first secrets push. */
async function clientSandbox(c: Client, body: Record<string, unknown>) {
  const host = await connectHost(c.cell);
  const sbx = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell, ...body } }, 201);
  // A sandbox with no binding has nothing to push: its create is what the host hears.
  const kind = body.inject ? "secrets_update" : "sandbox_create";
  const cmds = await nextCommands(host.ws, (x) => x.type === kind);
  return { sandbox: sbx.sandbox as string, ws: host.ws, secrets: (cmds.find((x) => x.type === "secrets_update")?.secrets ?? []) as { binding: string; value: string }[] };
}

type Pushed = { binding: string; value: string; expires_ms?: number };
/** The next `secrets_update` to `sandbox` matching `pred`, acknowledged; nothing forces it (no deadline is touched). */
async function pushedTo(ws: Ws, sandbox: string, pred: (secrets: Pushed[]) => boolean, ms = 8_000): Promise<Pushed[]> {
  const ok = (x: any) => x.type === "secrets_update" && x.sandbox === sandbox && pred(x.secrets);
  const msg = await ws.next("commands", (m) => (m.commands as any[]).some(ok), ms);
  ws.send({ type: "ack", up_to: msg.seq });
  return (msg.commands as any[]).find(ok).secrets;
}

/** Run a sandbox's `inject_refresh` deadline now (its 15-minute push) and answer the secrets it pushed. */
async function refreshed(sandbox: string, ws: Ws): Promise<{ binding: string; value: string }[]> {
  const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sandbox));
  await runInDurableObject(stub, (_i, st) => {
    st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('inject_refresh', 0) ON CONFLICT(key) DO UPDATE SET at = 0");
  });
  const got = nextCommands(ws, (x) => x.type === "secrets_update");
  await runDue(stub);
  return (await got).find((x) => x.type === "secrets_update")!.secrets;
}

describe("client secrets", () => {
  it("are write-only: a write answers metadata, a listing names and metadata, the audit no value; the operator sees the same", async () => {
    const c = await newClient();
    const value = fakeValue("w");
    const put = await asJson(c.token, `/v1/clients/self/secrets/stripe-key`, { method: "PUT", body: { value, description: "the test key" } });
    expect(put).toEqual({ name: "stripe-key", description: "the test key", size: value.length, created_ms: put.created_ms, updated_ms: put.updated_ms, last_injected_ms: null,
      expires_ms: null, sandboxes: 0 });
    const again = fakeValue("w2x");
    const replaced = await asJson(c.token, `/v1/clients/self/secrets/stripe-key`, { method: "PUT", body: { value: again } });
    expect(replaced).toMatchObject({ name: "stripe-key", description: null, size: again.length, created_ms: put.created_ms });
    const listing = await asJson(c.token, "/v1/clients/self/secrets");
    expect(listing.secrets.map((s: any) => s.name)).toEqual(["stripe-key"]);
    const admin = await adminJson(`/v1/admin/clients/${c.id}/secrets`);
    expect(admin).toEqual(listing);
    const texts = [JSON.stringify(put), JSON.stringify(replaced), JSON.stringify(listing), JSON.stringify(admin), ...(await auditTexts())];
    for (const t of texts) expect(t.includes(value) || t.includes(again)).toBe(false);
    expect((await auditTexts()).some((t) => t.includes(`"client_secret_put"`) && t.includes(c.id))).toBe(true);
    // A name outside the rule, and no self for the operator.
    expect((await as(c.token, "/v1/clients/self/secrets/Bad.Name", { method: "PUT", body: { value } })).status).toBe(400);
    expect((await adminJson("/v1/clients/self/secrets", {}, 403)).error.code).toBe("forbidden");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "DELETE" });
    expect((await asJson(c.token, "/v1/clients/self/secrets")).secrets).toEqual([]);
    expect((await as(c.token, "/v1/clients/self/secrets/stripe-key", { method: "DELETE" })).status).toBe(404);
  });

  it("are within the grant: at most max_count of them (a replacement takes no place), each at most max_bytes", async () => {
    const c = await newClient({ secrets: { max_count: 1, max_bytes: 16 } });
    await asJson(c.token, "/v1/clients/self/secrets/a", { method: "PUT", body: { value: "0123456789abcdef" } });
    await asJson(c.token, "/v1/clients/self/secrets/a", { method: "PUT", body: { value: "fedcba9876543210" } });
    expect((await asJson(c.token, "/v1/clients/self/secrets/b", { method: "PUT", body: { value: "x" } }, 403)).error.message).toContain("secrets.max_count is 1");
    expect((await asJson(c.token, "/v1/clients/self/secrets/a", { method: "PUT", body: { value: "0123456789abcdefX" } }, 403)).error.message).toContain("secrets.max_bytes is 16");
    // A grant stored before `secrets` (or one naming none) stores nothing.
    const none = await newClient({ secrets: undefined });
    await runInDurableObject(env.CLIENT.get(env.CLIENT.idFromName(none.id)), (_i, st) => {
      const r = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'record'").one().value);
      delete r.grant.secrets;
      delete r.grant.inject_hosts;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'record'", JSON.stringify(r));
    });
    expect((await as(none.token, "/v1/clients/self/secrets/a", { method: "PUT", body: { value: "x" } })).status).toBe(403);
  });

  it("are a client's own: another client's listing and delete don't see them, the operator can't write one by name, and a deleted client's go", async () => {
    const a = await newClient();
    const b = await newClient({ cells: [] });
    await asJson(a.token, "/v1/clients/self/secrets/shared", { method: "PUT", body: { value: fakeValue("a") } });
    expect((await asJson(b.token, "/v1/clients/self/secrets")).secrets).toEqual([]);
    expect((await as(b.token, "/v1/clients/self/secrets/shared", { method: "DELETE" })).status).toBe(404);
    expect((await asJson(a.token, "/v1/clients/self/secrets")).secrets.map((s: any) => s.name)).toEqual(["shared"]);
    await adminJson(`/v1/admin/secrets/client-secret:${b.id}:shared`, { method: "PUT", body: { value: "x" } }, 403);
    await adminJson(`/v1/admin/clients/${a.id}`, { method: "DELETE" });
    expect((await adminJson(`/v1/admin/clients/${a.id}/secrets`)).secrets).toEqual([]);
    const left = await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i, st) =>
      st.storage.sql.exec("SELECT name FROM secrets WHERE name LIKE ?", `client-secret:${a.id}:%`).toArray().length);
    expect(left).toBe(0);
  });
});

describe("client injection bindings", () => {
  const stripe = (extra: Record<string, unknown> = {}) => ({ name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER, ...extra });

  it("a sandbox spec's binding reaches its proxy: the policy holds the placeholder, only secrets_update the value, audited without it", async () => {
    const c = await newClient();
    const value = fakeValue("e2e");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(s.secrets).toContainEqual({ binding: "client:stripe", value });
    const policy = await asJson(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(policy.inject).toContainEqual({ name: "client:stripe", hosts: ["api.stripe.com"], placeholder: `nest-ph.${c.id}.stripe.`, locations: BEARER });
    expect(JSON.stringify(policy)).not.toContain(value);
    expect(JSON.stringify(await asJson(c.token, `/v1/sandboxes/${s.sandbox}`))).not.toContain(value);
    const texts = await auditTexts();
    const rec = texts.map((t) => JSON.parse(t)).find((r) => r.event === "client_secret_injected" && r.sandbox === s.sandbox);
    expect(rec).toMatchObject({ client: c.id, caller: "SandboxDO", bindings: [{ binding: "client:stripe", secret: "stripe-key", hosts: ["api.stripe.com"] }] });
    expect(texts.some((t) => t.includes(value))).toBe(false);
    expect((await asJson(c.token, "/v1/clients/self/secrets")).secrets[0].last_injected_ms).toBeGreaterThan(0);
  });

  it("names only its own client's secrets: a binding naming another client's secret gets no value", async () => {
    const a = await newClient();
    const b = await newClient();
    const value = fakeValue("theirs");
    await asJson(a.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await clientSandbox(b, { inject: [stripe()] });
    expect(s.secrets.find((x) => x.binding === "client:stripe")).toBeUndefined();
    expect(JSON.stringify(s.secrets)).not.toContain(value);
    // The operator has no client secrets to bind: its bindings go in the policy layer.
    expect((await adminJson("/v1/sandboxes", { body: { cell: a.cell, inject: [stripe()] } }, 400)).error.message).toContain("policy.inject");
  });

  it("refuses hosts outside inject_hosts at the sandbox, at the template and at the spawn; overrides only narrow", async () => {
    const c = await newClient();
    const outside = await asJson(c.token, "/v1/sandboxes", { body: { cell: c.cell, inject: [stripe({ hosts: ["api.stripe.com", "evil.net"] })] } }, 403);
    expect(outside.error.message).toContain("inject host evil.net (binding stripe)");
    const tpl = (inject: unknown[]) => ({ capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", inject });
    expect((await asJson(c.token, `/v1/catalog/templates/${c.name}/bad`, { method: "PUT", body: tpl([stripe({ hosts: ["evil.net"] })]) }, 403)).error.message)
      .toContain("inject host evil.net");
    await asJson(c.token, `/v1/catalog/templates/${c.name}/coder`, { method: "PUT", body: tpl([stripe({ hosts: ["api.stripe.com", "x.example.com"] })]) });
    // Only a client's template declares bindings: the operator's go in a sandbox's policy.
    await adminJson(`/v1/admin/templates/opbind-${rand()}`, { method: "PUT", body: tpl([stripe()]) }, 400);
    const value = fakeValue("tpl");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await clientSandbox(c, {});
    // A spawn may narrow the template's binding, never widen it.
    const wider = await asJson(c.token, "/v1/agents", { body: { template: `${c.name}/coder`, sandbox: s.sandbox, start: false,
      overrides: { inject: [stripe({ hosts: ["api.stripe.com", "evil.net"] })] } } }, 400);
    expect(wider.error.message).toContain("can't widen its hosts with evil.net");
    const a = await asJson(c.token, "/v1/agents", { body: { template: `${c.name}/coder`, sandbox: s.sandbox, start: false, overrides: { inject: [stripe()] } } }, 201);
    expect(a.inject).toEqual([{ ...stripe(), client: c.id, placeholder: `nest-ph.${c.id}.stripe.` }]);
    // Attached, the agent's binding joins the sandbox's: the narrowed one, and its value goes to the proxy.
    const cmds = await nextCommands(s.ws, (x) => x.type === "secrets_update");
    expect(cmds.find((x) => x.type === "secrets_update")!.secrets).toContainEqual({ binding: "client:stripe", value });
    const policy = await asJson(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(policy.inject.find((b: any) => b.name === "client:stripe").hosts).toEqual(["api.stripe.com"]);
  });

  it("an operator binding can't take a client binding's name; one stored under it anyway is never pushed the client's secret", async () => {
    const c = await newClient();
    const value = fakeValue("b1");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const evil = { name: "client:stripe", hosts: ["evil.net"], placeholder: `nest-ph.${c.id}.stripe.`, locations: BEARER };
    expect((await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { inject: [evil] } }, 400)).error.message).toContain("client:");
    // Planted past the API (a layer stored by a release before the check): the operator's binding is kept, the client's value isn't pushed.
    await runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)), (_i, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one();
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'ws_layer'", JSON.stringify({ ...JSON.parse(row.value), inject: [evil] }));
    });
    const secrets = await refreshed(s.sandbox, s.ws);
    expect(JSON.stringify(secrets)).not.toContain(value);
    const policy = await asJson(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(policy.inject.filter((b: any) => b.name === "client:stripe")).toEqual([evil]);
  });

  it("another client's template attached to a client's sandbox brings no binding, and never resolves to the sandbox client's secret", async () => {
    const a = await newClient();
    const b = await newClient();
    const valueA = fakeValue("a-own");
    const valueB = fakeValue("b-own");
    await asJson(a.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: valueA } });
    await asJson(b.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: valueB } });
    await asJson(b.token, `/v1/catalog/templates/${b.name}/coder`, { method: "PUT",
      body: { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", inject: [stripe()] } });
    const s = await clientSandbox(a, {});
    // The operator (who may attach anything anywhere) puts B's agent in A's sandbox.
    const agent = await adminJson("/v1/agents", { body: { template: `${b.name}/coder`, sandbox: s.sandbox, start: false } }, 201);
    expect(agent.inject).toEqual([expect.objectContaining({ client: b.id })]);
    const secrets = await refreshed(s.sandbox, s.ws);
    expect(JSON.stringify(secrets)).not.toContain(valueA);
    expect(JSON.stringify(secrets)).not.toContain(valueB);
    expect((await adminJson(`/v1/sandboxes/${s.sandbox}/policy`)).inject.map((x: any) => x.name)).not.toContain("client:stripe");
    // BrokerDO too: a binding is looked up under the client that declared it, never the sandbox's.
    const refs = await env.BROKER.get(env.BROKER.idFromName("broker")).clientInjectionRefs(b.id, s.sandbox, [{ binding: "client:stripe", secret: "stripe-key", hosts: ["api.stripe.com"] }], "test");
    expect(refs).toEqual([{ binding: "client:stripe", value: `$nest-secret:client-secret:${b.id}:stripe-key` }]);
  });

  it("an attached agent's bindings go at detach; a stale agent key a previous release left counts for nothing", async () => {
    const c = await newClient();
    const value = fakeValue("x11");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    await asJson(c.token, `/v1/catalog/templates/${c.name}/coder`, { method: "PUT",
      body: { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", inject: [stripe()] } });
    const s = await clientSandbox(c, {});
    const ag = await asJson(c.token, "/v1/agents", { body: { template: `${c.name}/coder`, sandbox: s.sandbox, start: false } }, 201);
    expect((await nextCommands(s.ws, (x) => x.type === "secrets_update")).find((x) => x.type === "secrets_update")!.secrets).toContainEqual({ binding: "client:stripe", value });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await stub.detach(ag.agent);
    const after = (await nextCommands(s.ws, (x) => x.type === "secrets_update")).find((x) => x.type === "secrets_update")!.secrets;
    expect(JSON.stringify(after)).not.toContain(value);
    expect((await stub.policy()).inject.map((b) => b.name)).not.toContain("client:stripe");
    // A previous release's detach left its agent's keys: they don't count once that agent isn't attached.
    await runInDurableObject(stub, (_i, st) => {
      const held = [{ ...stripe(), client: c.id, placeholder: `nest-ph.${c.id}.stripe.` }];
      st.storage.sql.exec("INSERT INTO kv (key, value) VALUES ('agent_inject', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ [ag.agent]: held }));
      st.storage.sql.exec("INSERT INTO kv (key, value) VALUES ('agent_github_push', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify({ [ag.agent]: true }));
    });
    expect(await stub.clientInjections()).toEqual([]);
    expect(await stub.pushWorkflows()).toBe(false);
  });

  it("the refresh carries a replaced value, takes a deleted one away, and applies a narrowed grant, with no policy change", async () => {
    const c = await newClient();
    const first = fakeValue("v1");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: first } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(s.secrets).toContainEqual({ binding: "client:stripe", value: first });
    // Its push armed the next one 15 minutes on: what reaches the proxy without anyone forcing it.
    const at = await runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)), (_i, st) =>
      st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'inject_refresh'").toArray()[0]?.at ?? 0);
    expect(at - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(at - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // Each write is pushed at once (below, "pushed on write"); the refresh after it carries the same.
    const second = fakeValue("v2");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: second } });
    await pushedTo(s.ws, s.sandbox, (x) => x.some((y) => y.value === second));
    expect(await refreshed(s.sandbox, s.ws)).toContainEqual({ binding: "client:stripe", value: second });
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "DELETE" });
    await pushedTo(s.ws, s.sandbox, (x) => !x.some((y) => y.binding === "client:stripe"));
    expect((await refreshed(s.sandbox, s.ws)).map((x) => x.binding)).not.toContain("client:stripe");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: first } });
    await pushedTo(s.ws, s.sandbox, (x) => x.some((y) => y.value === first));
    expect(await refreshed(s.sandbox, s.ws)).toContainEqual({ binding: "client:stripe", value: first });
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token"], max_sandboxes: 5, secrets: { max_count: 3 }, inject_hosts: [] } } });
    expect((await refreshed(s.sandbox, s.ws)).map((x) => x.binding)).not.toContain("client:stripe");
  });

  it("a reference that resolves to nothing goes out as no secret, never an empty one", async () => {
    const c = await newClient();
    const s = await clientSandbox(c, {});
    const cell = c.cell;
    const host = (await runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)), (_i, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value).host)) as string;
    await env.FLEET.get(env.FLEET.idFromName(cell)).issueCommands(host, [{ type: "secrets_update", sandbox: s.sandbox, epoch: 1,
      secrets: [{ binding: "gone", value: `$nest-secret:client-secret:${c.id}:never-stored` }, { binding: "also", value: "$nest-secret:inject:never-stored" }] } as any]);
    const cmd = (await nextCommands(s.ws, (x) => x.type === "secrets_update")).find((x) => x.type === "secrets_update")!;
    expect(cmd.secrets).toEqual([]);
  });

  it("a grant narrowed after the spawn takes the value away at the sandbox's next push", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("narrow") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(s.secrets.map((x) => x.binding)).toContain("client:stripe");
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token"], max_sandboxes: 5, secrets: { max_count: 3 }, inject_hosts: [] } } });
    // A policy change pushes the secrets again.
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "api.stripe.com" }] } });
    const cmds = await nextCommands(s.ws, (x) => x.type === "secrets_update");
    expect(cmds.find((x) => x.type === "secrets_update")!.secrets.map((x: any) => x.binding)).not.toContain("client:stripe");
  });
});

// docs/control-plane/durable-objects/broker/#client-secret-pushes: a write or delete reaches every sandbox
// that asked for the secret at once, not at its 15-minute push; an expiry travels with the value.
describe("client secrets pushed on write, and expiring", () => {
  const stripe = () => ({ name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER });
  const pushed = pushedTo;
  const holds = (value: string) => (s: Pushed[]) => s.some((x) => x.binding === "client:stripe" && x.value === value);
  const lacks = (s: Pushed[]) => !s.some((x) => x.binding === "client:stripe");
  const sandboxIs = (sandbox: string) => function (this: { ctx: DurableObjectState }) {
    return this.ctx.id.equals(env.SANDBOX.idFromName(sandbox));
  };
  async function refreshAt(sandbox: string): Promise<number> {
    return runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(sandbox)), (_i, st) =>
      st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'inject_refresh'").toArray()[0]?.at ?? 0);
  }

  it("a write reaches the sandbox's proxy at once, a secret stored after its binding too, and a delete takes it away", async () => {
    const c = await newClient();
    // Bound before the secret exists: the sandbox asks for it, and gets nothing yet.
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(s.secrets).toEqual([]);
    expect(await refreshAt(s.sandbox) - Date.now()).toBeGreaterThan(14 * 60_000);
    const first = fakeValue("w1");
    const view = await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: first } });
    expect(view.sandboxes).toBe(1);
    expect(await pushed(s.ws, s.sandbox, holds(first))).toContainEqual({ binding: "client:stripe", value: first });
    const second = fakeValue("w2");
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: second } });
    await pushed(s.ws, s.sandbox, holds(second));
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "DELETE" });
    await pushed(s.ws, s.sandbox, lacks);
    // Still bound: storing it again pushes it again.
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: first } });
    await pushed(s.ws, s.sandbox, holds(first));
    // None of it waited for the 15-minute push.
    expect(await refreshAt(s.sandbox) - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("an expiry travels with the value, an expired secret isn't injected, and an expiry already past is refused", async () => {
    const c = await newClient();
    const value = fakeValue("exp");
    const at = new Date(Date.now() + 3_600_000);
    const view = await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value, expires_at: at.toISOString() } });
    expect(view.expires_ms).toBe(at.getTime());
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(s.secrets).toContainEqual({ binding: "client:stripe", value, expires_ms: at.getTime() });
    // An offset other than Z is the same instant.
    const later = new Date(Date.now() + 7_200_000);
    const offset = new Date(later.getTime() + 2 * 3_600_000).toISOString().replace("Z", "+02:00");
    expect((await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value, expires_at: offset } })).expires_ms).toBe(later.getTime());
    await pushed(s.ws, s.sandbox, (x) => x.some((y) => y.binding === "client:stripe" && y.expires_ms === later.getTime()));
    // Replaced without one: it never expires, and the push says so.
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    expect(await pushed(s.ws, s.sandbox, (x) => x.some((y) => y.binding === "client:stripe" && y.expires_ms === undefined)))
      .toContainEqual({ binding: "client:stripe", value });
    for (const bad of [new Date(Date.now() - 1000).toISOString(), "tomorrow", "2026-11-12T10:00:00"]) {
      expect((await as(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value, expires_at: bad } })).status, bad).toBe(400);
    }
    // Once past its expiry, the next push carries none of it; the listing still shows it, and when it expired.
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value, expires_at: at.toISOString() } });
    await pushed(s.ws, s.sandbox, (x) => x.some((y) => y.expires_ms === at.getTime()));
    const past = Date.now() - 1;
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i, st) => {
      st.storage.sql.exec("UPDATE secrets SET expires_ms = ? WHERE name = ?", past, `client-secret:${c.id}:stripe-key`);
    });
    expect((await refreshed(s.sandbox, s.ws)).map((x) => x.binding)).not.toContain("client:stripe");
    // BrokerDO hands out no reference to it at all (FleetDO, resolving one, would find nothing either).
    expect(await env.BROKER.get(env.BROKER.idFromName("broker")).clientInjectionRefs(c.id, s.sandbox,
      [{ binding: "client:stripe", secret: "stripe-key", hosts: ["api.stripe.com"] }], "test")).toEqual([]);
    expect((await asJson(c.token, "/v1/clients/self/secrets")).secrets).toEqual([expect.objectContaining({ name: "stripe-key", expires_ms: past })]);
  });

  it("a notice the sandbox fails to take is tried again until it does", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("n1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const proto = SandboxDO.prototype as any;
    const real = proto.clientSecretsChanged;
    const mine = sandboxIs(s.sandbox);
    let calls = 0;
    // Twice: a give-up after the first or second failure would never deliver it (review lesson 6).
    proto.clientSecretsChanged = async function (this: any, ...args: unknown[]) {
      if (mine.call(this) && ++calls <= 2) throw new Error("SandboxDO unavailable");
      return real.apply(this, args);
    };
    try {
      const second = fakeValue("n2");
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: second } });
      await pushed(s.ws, s.sandbox, holds(second), 12_000);
      expect(calls).toBe(3);
    } finally {
      proto.clientSecretsChanged = real;
    }
    expect(await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i, st) =>
      st.storage.sql.exec("SELECT 1 FROM client_secret_pushes WHERE sandbox = ?", s.sandbox).toArray().length)).toBe(0);
  });

  it("a push that fails in the sandbox is tried again with backoff", { timeout: 30_000 }, async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("p1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const proto = SandboxDO.prototype as any;
    const real = proto.pushSecrets;
    const mine = sandboxIs(s.sandbox);
    let calls = 0;
    // Twice (2 s, then 4 s): a give-up after the first or second failure leaves it to the 15-minute push.
    proto.pushSecrets = async function (this: any, ...args: unknown[]) {
      if (mine.call(this) && ++calls <= 2) throw new Error("FleetDO unavailable");
      return real.apply(this, args);
    };
    try {
      const second = fakeValue("p2");
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: second } });
      await pushed(s.ws, s.sandbox, holds(second), 20_000);
      expect(calls).toBe(3);
    } finally {
      proto.pushSecrets = real;
    }
    expect(await refreshAt(s.sandbox) - Date.now()).toBeGreaterThan(14 * 60_000);
  });

  it("a write that lands while the sandbox's own refresh is in flight is pushed again after it", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("r1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    // Hold the refresh at its read of the client's grant (before it asks BrokerDO for the references).
    const proto = ClientDO.prototype as any;
    const real = proto.scope;
    const clientId = env.CLIENT.idFromName(c.id);
    // Flags, not promises: a promise the held DO resolved would run the test's continuation in its I/O context.
    const hold = { armed: true, reached: false, released: false };
    const release = () => { hold.released = true; };
    proto.scope = async function (this: any, ...args: unknown[]) {
      if (hold.armed && this.ctx.id.equals(clientId)) {
        hold.armed = false;
        hold.reached = true;
        while (!hold.released) await new Promise((r) => setTimeout(r, 10));
      }
      return real.apply(this, args);
    };
    const injected = async () => (await auditTexts()).map((t) => JSON.parse(t)).filter((r) => r.event === "client_secret_injected" && r.sandbox === s.sandbox).length;
    try {
      const before = await injected();
      await runInDurableObject(stub, (_i, st) => {
        st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('inject_refresh', 0) ON CONFLICT(key) DO UPDATE SET at = 0");
      });
      const refresh = runDue(stub);
      await eventually("the refresh to reach the hold", () => hold.reached);
      const second = fakeValue("r2");
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: second } });
      // BrokerDO's notice reached the sandbox while its refresh waited.
      await eventually("the notice to land", () => runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i, st) =>
        st.storage.sql.exec("SELECT 1 FROM client_secret_pushes WHERE sandbox = ?", s.sandbox).toArray().length === 0));
      release();
      await refresh;
      // The refresh pushed, and then the notice's own push: two, not one the refresh's re-arm swallowed.
      await eventually("a push after the refresh", async () => (await injected()) >= before + 2);
      await pushed(s.ws, s.sandbox, holds(second));
    } finally {
      release();
      proto.scope = real;
    }
  });
});

// What BrokerDO keeps of who asked (docs/control-plane/durable-objects/broker/#client-secret-pushes).
describe("client secret pushes: who asked", () => {
  const BEARER_ = [{ type: "authorization_bearer" }];
  const stripe = () => ({ name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER_ });
  const broker = () => env.BROKER.get(env.BROKER.idFromName("broker"));
  const rows = (client: string, sandbox: string) => runInDurableObject(broker(), (_i, st) =>
    st.storage.sql.exec<{ name: string }>("SELECT name FROM client_secret_sandboxes WHERE client = ? AND sandbox = ? ORDER BY name", client, sandbox)
      .toArray().map((r) => r.name));
  const queued = (sandbox: string) => runInDurableObject(broker(), (_i, st) =>
    st.storage.sql.exec("SELECT 1 FROM client_secret_pushes WHERE sandbox = ?", sandbox).toArray().length);
  const count = async (c: Client, name = "stripe-key") =>
    ((await asJson(c.token, "/v1/clients/self/secrets")).secrets as any[]).find((x) => x.name === name)?.sandboxes;
  /** Patch SandboxDO's `method` for one sandbox only; restore with the answer's `restore`. */
  function patchSandbox(sandbox: string, method: string, fn: (real: (...a: unknown[]) => Promise<any>, self: any, args: unknown[]) => Promise<any>) {
    const proto = SandboxDO.prototype as any;
    const real = proto[method];
    const id = env.SANDBOX.idFromName(sandbox);
    proto[method] = async function (this: any, ...args: unknown[]) {
      return this.ctx.id.equals(id) ? fn((...a) => real.apply(this, a), this, args) : real.apply(this, args);
    };
    return { restore: () => { proto[method] = real; } };
  }

  it("a stale push that lands after a newer one keeps the newer one's secrets recorded", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("o1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    const proto = ClientDO.prototype as any;
    const real = proto.scope;
    const clientId = env.CLIENT.idFromName(c.id);
    const hold = { armed: true, reached: false, released: false };
    proto.scope = async function (this: any, ...args: unknown[]) {
      if (hold.armed && this.ctx.id.equals(clientId)) {
        hold.armed = false;
        hold.reached = true;
        while (!hold.released) await new Promise((r) => setTimeout(r, 10));
      }
      return real.apply(this, args);
    };
    try {
      // Push A (the refresh) waits at the grant read, before it records what it asks for.
      await runInDurableObject(stub, (_i, st) => {
        st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('inject_refresh', 0) ON CONFLICT(key) DO UPDATE SET at = 0");
      });
      const refresh = runDue(stub);
      await eventually("the refresh to reach the hold", () => hold.reached);
      // Push B binds another secret and records it.
      const other = { name: "other", secret: "other-key", hosts: ["api.stripe.com"], locations: BEARER_ };
      await asJson(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { inject: [other] } });
      await eventually("push B to record other-key", async () => (await rows(c.id, s.sandbox)).includes("other-key"));
      hold.released = true;
      await refresh;
      // A, stale and dropped, recorded only what it asked for, beside B's.
      expect(await rows(c.id, s.sandbox)).toEqual(["other-key", "stripe-key"]);
      expect((await asJson(c.token, "/v1/clients/self/secrets/other-key", { method: "PUT", body: { value: fakeValue("o2") } })).sandboxes).toBe(1);
    } finally {
      hold.released = true;
      proto.scope = real;
    }
  });

  it("a write while the previous notice is in flight gets a notice of its own (seq)", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("q0") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const hold = { armed: true, reached: false, released: false };
    let calls = 0;
    const p = patchSandbox(s.sandbox, "clientSecretsChanged", async (real, _self, args) => {
      calls++;
      if (hold.armed) {
        hold.armed = false;
        hold.reached = true;
        while (!hold.released) await new Promise((r) => setTimeout(r, 10));
      }
      return real(...args);
    });
    try {
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("q1") } });
      await eventually("the first notice held", () => hold.reached);
      const v2 = fakeValue("q2");
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: v2 } });
      hold.released = true;
      // The first answer doesn't take the second write's notice with it.
      await eventually("a second notice", () => calls >= 2);
      await eventually("the queue drained", async () => (await queued(s.sandbox)) === 0);
    } finally {
      hold.released = true;
      p.restore();
    }
  });

  it("forgets a destroyed sandbox at its destroy, and a gone one a notice finds", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("d1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    expect(await count(c)).toBe(1);
    await asJson(c.token, `/v1/sandboxes/${s.sandbox}`, { method: "DELETE" });
    await eventually("the destroy to forget it", async () => (await count(c)) === 0);
    // One recorded by a BrokerDO that missed the destroy (a previous release): the next write's notice finds it gone.
    const ghost = `sbx_ghost${rand()}`;
    await runInDurableObject(broker(), (_i, st) => {
      st.storage.sql.exec("INSERT INTO client_secret_sandboxes (client, name, sandbox, asked_ms) VALUES (?, 'stripe-key', ?, 1)", c.id, ghost);
    });
    expect(await count(c)).toBe(1);
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("d2") } });
    await eventually("gone forgotten", async () => (await count(c)) === 0);
  });

  it("forgets an unbound sandbox for the client, and names its bindings no longer name, at the next write", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("u1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    // A name asked for earlier that no binding names now.
    await runInDurableObject(broker(), (_i, st) => {
      st.storage.sql.exec("INSERT INTO client_secret_sandboxes (client, name, sandbox, asked_ms) VALUES (?, 'old-key', ?, 1)", c.id, s.sandbox);
    });
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("u2") } });
    await eventually("old-key forgotten, stripe-key kept", async () => JSON.stringify(await rows(c.id, s.sandbox)) === JSON.stringify(["stripe-key"]));
    // Unbound altogether: forgotten for the client at the next write.
    await asJson(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: {} });
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("u3") } });
    await eventually("unbound forgotten", async () => (await count(c)) === 0);
  });

  it("an answer forgets only what was asked for before its notice went: a push recorded meanwhile stands", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("a1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    // While the notice is with the sandbox, a push of its records `fresh-key`; then it answers `unbound`.
    const p = patchSandbox(s.sandbox, "clientSecretsChanged", async () => {
      await new Promise((r) => setTimeout(r, 5));
      await env.BROKER.get(env.BROKER.idFromName("broker")).clientInjectionRefs(c.id, s.sandbox,
        [{ binding: "client:fresh", secret: "fresh-key", hosts: ["api.stripe.com"] }], "test");
      return { status: "unbound" };
    });
    try {
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("a2") } });
      await eventually("the notice answered", async () => (await queued(s.sandbox)) === 0);
      expect(await rows(c.id, s.sandbox)).toEqual(["fresh-key"]);
    } finally {
      p.restore();
    }
  });

  it("a name asked for again while its notice is out survives an answer that no longer names it", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("m1") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    // Unbound when the sandbox answered, bound again (a push asks for it anew) before the answer lands:
    // the re-ask moves its `asked_ms` past the notice's, so the answer can't take it.
    const p = patchSandbox(s.sandbox, "clientSecretsChanged", async () => {
      await new Promise((r) => setTimeout(r, 5));
      await env.BROKER.get(env.BROKER.idFromName("broker")).clientInjectionRefs(c.id, s.sandbox,
        [{ binding: "client:stripe", secret: "stripe-key", hosts: ["api.stripe.com"] }], "test");
      return { status: "unbound" };
    });
    try {
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("m2") } });
      await eventually("the notice answered", async () => (await queued(s.sandbox)) === 0);
      expect(await rows(c.id, s.sandbox)).toEqual(["stripe-key"]);
    } finally {
      p.restore();
    }
  });

  it("a BrokerDO of the previous release (no resolveRefsExpiring): the push goes out, with the expiry it was queued with", async () => {
    const c = await newClient();
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("f0") } });
    const s = await clientSandbox(c, { inject: [stripe()] });
    const proto = BrokerDO.prototype as any;
    const real = proto.resolveRefsExpiring;
    delete proto.resolveRefsExpiring;
    try {
      const v = fakeValue("f1");
      const at = Date.now() + 3_600_000;
      await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: v, expires_at: new Date(at).toISOString() } });
      // FleetDO falls back to `resolveRefs`; the entry keeps what `clientInjectionRefs` put on it.
      expect(await pushedTo(s.ws, s.sandbox, (x) => x.some((y) => y.value === v))).toContainEqual({ binding: "client:stripe", value: v, expires_ms: at });
    } finally {
      proto.resolveRefsExpiring = real;
    }
  });

  it("a sandbox that doesn't answer holds no other notice past its call's timeout", { timeout: 40_000 }, async () => {
    const a = await newClient();
    await asJson(a.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("h1") } });
    const sa = await clientSandbox(a, { inject: [stripe()] });
    const b = await newClient();
    await asJson(b.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("h2") } });
    const sb = await clientSandbox(b, { inject: [stripe()] });
    const hang = { reached: false, released: false };
    const p = patchSandbox(sa.sandbox, "clientSecretsChanged", async (real, _self, args) => {
      hang.reached = true;
      while (!hang.released) await new Promise((r) => setTimeout(r, 20));
      return real(...args);
    });
    try {
      await asJson(a.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: fakeValue("h3") } });
      await eventually("A's notice to hang", () => hang.reached);
      // B's write is queued behind the alarm run A holds: it goes once A's call times out (10 s).
      const vb = fakeValue("h4");
      await asJson(b.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value: vb } });
      await pushedTo(sb.ws, sb.sandbox, (x) => x.some((y) => y.value === vb), 25_000);
    } finally {
      hang.released = true;
      p.restore();
    }
  });

  it("roll-forward: a BrokerDO that finds notices waiting and no alarm arms it again, and they're delivered", async () => {
    const stub = env.BROKER.get(env.BROKER.idFromName(`rearm-${rand()}`));
    const sbx = `sbx_rearm${rand()}`;
    await runInDurableObject(stub, async (_i, st) => {
      st.storage.sql.exec("INSERT INTO client_secret_sandboxes (client, name, sandbox, asked_ms) VALUES ('cli_x', 'k', ?, 1)", sbx);
      st.storage.sql.exec("INSERT INTO client_secret_pushes (sandbox, client, due_ms, attempts, seq) VALUES (?, 'cli_x', 5, 0, 1)", sbx);
      // As a previous release's run of the alarm leaves it: rows waiting, no alarm.
      await st.storage.deleteAlarm();
      expect(await st.storage.getAlarm()).toBeNull();
      // The next release's object starts on this storage.
      new BrokerDO(st as any, env as any);
    });
    await eventually("the waiting notice delivered (a sandbox never made: forgotten)", () => runInDurableObject(stub, (_i, st) =>
      st.storage.sql.exec("SELECT 1 FROM client_secret_pushes").toArray().length === 0
      && st.storage.sql.exec("SELECT 1 FROM client_secret_sandboxes").toArray().length === 0));
  });

  it("a push carries the expiry stored with the value when FleetDO sends it, not the one the command was queued with", async () => {
    const c = await newClient();
    const s = await clientSandbox(c, {});
    const host = (await runInDurableObject(env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)), (_i, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value).host)) as string;
    const value = fakeValue("st");
    const at = Date.now() + 3_600_000;
    await asJson(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value, expires_at: new Date(at).toISOString() } });
    await asJson(c.token, "/v1/clients/self/secrets/never", { method: "PUT", body: { value: fakeValue("nv") } });
    // Queued with an expiry a token replaced meanwhile had (earlier), and one with none at all.
    await env.FLEET.get(env.FLEET.idFromName(c.cell)).issueCommands(host, [{ type: "secrets_update", sandbox: s.sandbox, epoch: 1, secrets: [
      { binding: "client:stripe", value: `$nest-secret:client-secret:${c.id}:stripe-key`, expires_ms: Date.now() + 60_000 },
      { binding: "client:never", value: `$nest-secret:client-secret:${c.id}:never`, expires_ms: Date.now() + 60_000 },
    ] } as any]);
    const cmd = (await nextCommands(s.ws, (x) => x.type === "secrets_update")).find((x) => x.type === "secrets_update")!;
    expect(cmd.secrets).toEqual([{ binding: "client:stripe", value, expires_ms: at }, { binding: "client:never", value: expect.any(String) }]);
  });
});
