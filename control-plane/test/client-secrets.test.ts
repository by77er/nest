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
import { ADMIN, adminJson, BASE, connectHost, nextCommands, uniqueCell } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);

// --- Pure ---------------------------------------------------------------------------------------------------

describe("client injection bindings (pure)", () => {
  const stripe = { name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: [{ type: "authorization_bearer" as const }] };

  it("are ordinary bindings on the wire: exactly the fixture nest-proxy's seam test evaluates", () => {
    const held = holdInjections("cli_01JTESTCLIENT", [
      stripe,
      { name: "search", secret: "search-key", hosts: ["*.example.com"], wildcard: true, locations: [{ type: "header", name: "X-Api-Key" }, { type: "authorization_basic_password" }] },
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
    for (const bad of ["*.com", "com", "API.stripe.com", "1.2.3.4", "a..b", "*.*.b.c", "api.stripe.com.", "http://x.y", "x.y:443"]) {
      expect(InjectHost.safeParse(bad).success, bad).toBe(false);
    }
    expect(ClientInjection.safeParse({ ...stripe, hosts: ["*.example.com"] }).success).toBe(false);
    expect(ClientInjection.safeParse({ ...stripe, hosts: ["*.example.com"], wildcard: true }).success).toBe(true);
    for (const h of ["Host", "proxy-authorization", "Transfer-Encoding", "bad header"]) {
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

describe("client secrets", () => {
  it("are write-only: a write answers metadata, a listing names and metadata, the audit no value; the operator sees the same", async () => {
    const c = await newClient();
    const value = fakeValue("w");
    const put = await asJson(c.token, `/v1/clients/self/secrets/stripe-key`, { method: "PUT", body: { value, description: "the test key" } });
    expect(put).toEqual({ name: "stripe-key", description: "the test key", size: value.length, created_ms: put.created_ms, updated_ms: put.updated_ms, last_injected_ms: null });
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
