// A sandbox's client layer (docs/control-plane/api/clients/#the-client-layer): egress rules within the
// grant's `egress_hosts`, injection bindings and environment variables, from a sandbox spec, a template
// (joined while its agent is attached) or `PUT /v1/sandboxes/<id>/client-policy` on a live sandbox. Each
// reaches the host through the usual paths: the policy (`policy_update`), the secrets (`secrets_update`)
// and the agents' slots (`agent_attach.env`). The pure checks first.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compileEgress, egressOutsideGrant, narrowEgress } from "../src/lib/client-egress";
import { EnvName, unboundPlaceholders } from "../src/lib/sandbox-env";
import { hostPatternMatches } from "../src/protocol/model";
import { ClientDO } from "../src/do/client";
import { adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell, type Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const BEARER = [{ type: "authorization_bearer" }];

describe("client egress rules and env (pure)", () => {
  it("rules are within egress_hosts exactly or under a wildcard; overrides narrow hosts and ports only; they compile to allow rules", () => {
    expect(egressOutsideGrant([{ host: "nodejs.org" }, { host: "x.npmjs.com" }, { host: "evil.net" }], ["nodejs.org", "*.npmjs.com"])).toEqual(["egress host evil.net"]);
    expect(egressOutsideGrant([{ host: "x.evilnpmjs.com" }], ["*.npmjs.com"])).toEqual(["egress host x.evilnpmjs.com"]);
    expect(narrowEgress([{ host: "nodejs.org" }], [{ host: "nodejs.org", ports: [443] }])).toEqual({ ok: true, value: [{ host: "nodejs.org", ports: [443] }] });
    expect(narrowEgress([{ host: "nodejs.org", ports: [443] }], [{ host: "nodejs.org", ports: [22] }])).toEqual({ ok: false, error: "egress nodejs.org: can't add ports 22" });
    expect(narrowEgress([{ host: "nodejs.org" }], [{ host: "evil.net" }])).toEqual({ ok: false, error: "can't widen egress with evil.net" });
    expect(compileEgress([{ host: "nodejs.org" }])).toEqual([{ host: "nodejs.org", ports: [80, 443], layer: "workstream" }]);
  });

  it("env names are uppercase and never nest's or the guest's own; a placeholder must be one bound beside it", () => {
    for (const ok of ["API_TOKEN", "_X", "A1"]) expect(EnvName.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["PATH", "HOME", "NEST_AGENT_ID", "NEST_ANYTHING", "HTTPS_PROXY", "GITHUB_TOKEN", "LD_PRELOAD", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
      "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "lower", "1A", "A-B", ""]) {
      expect(EnvName.safeParse(bad).success, bad).toBe(false);
    }
    expect(unboundPlaceholders({ A: "nest-ph.cli_x.api.", B: "literal" }, ["nest-ph.cli_x.api."])).toEqual([]);
    expect(unboundPlaceholders({ A: "Bearer nest-ph.cli_y.api." }, ["nest-ph.cli_x.api."])).toEqual(["env A: a placeholder no binding here has"]);
  });
});

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

const GRANT = { credentials: ["claude_oauth_token"], max_agents: 5, max_sandboxes: 5, secrets: { max_count: 3, max_bytes: 64 },
  inject_hosts: ["api.stripe.com"], egress_hosts: ["nodejs.org", "*.npmjs.com", "api.github.com"] };

async function newClient(grant: Record<string, unknown> = {}) {
  const cell = uniqueCell();
  const name = `lay-${rand()}`;
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], ...GRANT, ...grant } } }, 201);
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  return { id: c.client as string, name, token: c.token as string, cell, grant: { cells: [cell], ...GRANT, ...grant } };
}
type Client = Awaited<ReturnType<typeof newClient>>;

/** A client's sandbox placed on a host of its cell, and the host's socket after its create. */
async function placed(c: Client, body: Record<string, unknown> = {}): Promise<{ sandbox: string; ws: Ws }> {
  const host = await connectHost(c.cell);
  const sbx = await ok(c.token, "/v1/sandboxes", { body: { cell: c.cell, ...body } });
  await nextCommands(host.ws, (x) => x.type === "sandbox_create");
  return { sandbox: sbx.sandbox, ws: host.ws };
}
const allowed = (policy: any) => (policy.allow as { host: string }[]).map((a) => a.host);
const nextPolicy = async (ws: Ws) => (await nextCommands(ws, (x) => x.type === "policy_update")).find((x) => x.type === "policy_update")!.policy;

describe("client egress", () => {
  it("a sandbox spec's rules within the grant are allow rules of its policy; one outside is refused", async () => {
    const c = await newClient();
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, egress: { allow: [{ host: "evil.net" }] } } })).status).toBe(403);
    const s = await placed(c, { egress: { allow: [{ host: "nodejs.org" }, { host: "registry.npmjs.com", ports: [443] }] } });
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(policy.allow).toContainEqual({ host: "nodejs.org", ports: [80, 443], layer: "workstream" });
    expect(policy.allow).toContainEqual({ host: "registry.npmjs.com", ports: [443], layer: "workstream" });
  });

  it("never takes away a guard: a client allowing api.github.com still gets the operator's GitHub write guards", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "api.github.com" }] } });
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(allowed(policy)).toContain("api.github.com");
    const guard = policy.guards.find((g: any) => g.name === "github-api-write");
    expect(guard.hosts.some((h: string) => hostPatternMatches(h, "api.github.com"))).toBe(true);
    expect(guard.allow ?? []).toEqual([]);
  });

  it("a template's rules join its agent's sandbox while attached; a spawn may only narrow them; detach takes them away", async () => {
    const c = await newClient();
    await ok(c.token, `/v1/catalog/templates/${c.name}/node`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", egress: { allow: [{ host: "nodejs.org" }] } } });
    expect((await as(c.token, `/v1/catalog/templates/${c.name}/bad`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", egress: { allow: [{ host: "evil.net" }] } } })).status).toBe(403);
    const s = await placed(c);
    expect((await as(c.token, "/v1/agents", { body: { template: `${c.name}/node`, sandbox: s.sandbox, start: false,
      overrides: { egress: { allow: [{ host: "evil.net" }] } } } })).status).toBe(400);
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/node`, sandbox: s.sandbox, start: false,
      overrides: { egress: { allow: [{ host: "nodejs.org", ports: [443] }] } } } });
    expect(a.egress).toEqual({ allow: [{ host: "nodejs.org", ports: [443] }] });
    expect((await nextPolicy(s.ws)).allow).toContainEqual({ host: "nodejs.org", ports: [443], layer: "workstream" });
    await env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox)).detach(a.agent);
    expect(allowed(await nextPolicy(s.ws))).not.toContain("nodejs.org");
  });

  it("the live client layer replaces the rules through a policy push; a narrowed grant takes a rule away at once", async () => {
    const c = await newClient();
    const s = await placed(c);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { egress: { allow: [{ host: "nodejs.org" }, { host: "x.npmjs.com" }] } } });
    expect(allowed(await nextPolicy(s.ws))).toEqual(expect.arrayContaining(["nodejs.org", "x.npmjs.com"]));
    expect(await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).toMatchObject({ egress: { allow: [{ host: "nodejs.org" }, { host: "x.npmjs.com" }] } });
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { egress: { allow: [{ host: "evil.net" }] } } })).status).toBe(403);
    // The grant loses `*.npmjs.com`: the sandbox's next policy, sent at the PATCH, has nodejs.org only.
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { ...c.grant, egress_hosts: ["nodejs.org"] } } });
    const narrowed = allowed(await nextPolicy(s.ws));
    expect(narrowed).toContain("nodejs.org");
    expect(narrowed).not.toContain("x.npmjs.com");
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: {} });
    expect(allowed(await nextPolicy(s.ws))).not.toContain("nodejs.org");
    // Another client's token: as for any id outside its subtree.
    const other = await newClient();
    expect((await as(other.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: {} })).status).toBe(404);
  });
});

describe("the ceiling a sandbox applies", () => {
  it("a client-layer write whose grant read is overtaken by a narrowing PATCH never puts the revoked host back", async () => {
    const c = await newClient();
    const s = await placed(c);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { egress: { allow: [{ host: "x.npmjs.com" }] } } });
    expect(allowed(await nextPolicy(s.ws))).toContain("x.npmjs.com");
    // Hold the sandbox's own grant read (the second scope() of the next PUT; the route's is the first), after it read the old grant.
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
      const put = as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { egress: { allow: [{ host: "x.npmjs.com" }, { host: "nodejs.org" }] } } });
      await eventually("the sandbox's grant read is held", () => reached);
      await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { ...c.grant, egress_hosts: ["nodejs.org"] } } });
      release();
      expect((await put).status).toBe(200);
    } finally {
      ClientDO.prototype.scope = real;
    }
    const after = allowed(await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`));
    expect(after).toContain("nodejs.org");
    expect(after).not.toContain("x.npmjs.com");
  });

  it("a grant change the fan-out missed reaches the sandbox at its periodic re-read", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "x.npmjs.com" }] } });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    const armed = await runInDurableObject(stub, (_i, st) => st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'egress_ceiling'").toArray()[0]?.at ?? 0);
    expect(armed - Date.now()).toBeGreaterThan(14 * 60_000);
    // Narrowed straight in ClientDO: no PATCH, so no fan-out.
    await env.CLIENT.get(env.CLIENT.idFromName(c.id)).setGrant({ ...c.grant, egress_hosts: [] } as never);
    expect(allowed(await stub.policy())).toContain("x.npmjs.com");
    await runInDurableObject(stub, (_i, st) => { st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'egress_ceiling'"); });
    const next = nextPolicy(s.ws);
    await runDue(stub);
    expect(allowed(await next)).not.toContain("x.npmjs.com");
  });

  it("a client's rule never opens a host the operator lets through uninspected", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "nodejs.org" }, { host: "x.npmjs.com" }] } });
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { passthrough: ["nodejs.org"] } });
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(allowed(policy)).not.toContain("nodejs.org");
    expect(allowed(policy)).toContain("x.npmjs.com");
  });

  it("a client's wildcard rule covering a passthrough host is left out too", async () => {
    const c = await newClient({ egress_hosts: ["*.example.com"] });
    const s = await placed(c, { egress: { allow: [{ host: "*.d.example.com" }, { host: "e.example.com" }] } });
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { passthrough: ["q.d.example.com"] } });
    const hosts = allowed(await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`));
    expect(hosts).not.toContain("*.d.example.com");
    expect(hosts).toContain("e.example.com");
  });

  it("a client record that lost its grant revision starts a new epoch, and a sandbox takes its narrowing", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "x.npmjs.com" }] } });
    // Revisions climb past anything a restarted counter would reach soon.
    for (let i = 0; i < 3; i++) await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: c.grant } });
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    expect(allowed(await stub.policy())).toContain("x.npmjs.com");
    // The record loses its revision (and epoch), and the grant is narrowed in the same write: no fan-out.
    await runInDurableObject(env.CLIENT.get(env.CLIENT.idFromName(c.id)), (_i, st) => {
      const r = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'record'").one().value);
      delete r.grant_rev;
      delete r.grant_epoch;
      r.grant = { ...r.grant, egress_hosts: [] };
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'record'", JSON.stringify(r));
    });
    expect(await stub.clientGrantChanged()).toBe(true);
    expect(allowed(await stub.policy())).not.toContain("x.npmjs.com");
  });

  it("only its owner reads a sandbox's client layer", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "nodejs.org" }] } });
    const other = await newClient();
    expect((await as(other.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).status).toBe(404);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).egress.allow).toEqual([{ host: "nodejs.org" }]);
  });
});

describe("the live client layer: bindings and environment", () => {
  const stripe = { name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER };

  it("a binding added live reaches the proxy, and one removed live is dropped", async () => {
    const c = await newClient();
    const value = `value-live-${rand()}`;
    await ok(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await placed(c);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { inject: [stripe] } });
    let cmds = await nextCommands(s.ws, (x) => x.type === "secrets_update");
    expect(cmds.find((x) => x.type === "secrets_update")!.secrets).toContainEqual({ binding: "client:stripe", value });
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`)).inject.map((b: any) => b.name)).toContain("client:stripe");
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { inject: [] } });
    cmds = await nextCommands(s.ws, (x) => x.type === "secrets_update");
    expect(JSON.stringify(cmds.find((x) => x.type === "secrets_update")!.secrets)).not.toContain(value);
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`)).inject.map((b: any) => b.name)).not.toContain("client:stripe");
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { inject: [{ ...stripe, hosts: ["evil.net"] }] } })).status).toBe(403);
  });

  it("env reaches each attached agent's slot: the sandbox's and the agent's, placeholders bound beside it, never a secret's value", async () => {
    const c = await newClient();
    const value = `value-env-${rand()}`;
    await ok(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const ph = `nest-ph.${c.id}.stripe.`;
    // Refused: a reserved name, a placeholder nothing binds here, a stored secret's value.
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, env: { PATH: "/x" } } })).status).toBe(400);
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, env: { STRIPE_KEY: ph } } })).body.error.message).toContain("no binding here has");
    expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, env: { STRIPE_KEY: value } } })).body.error.message).toContain("stored secret");
    const s = await placed(c, { inject: [stripe], env: { STRIPE_KEY: ph, APP_ENV: "staging" } });
    await ok(c.token, `/v1/catalog/templates/${c.name}/w`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { APP_ENV: "test", ROLE: "worker" } } });
    expect((await as(c.token, `/v1/catalog/templates/${c.name}/leak`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { K: value } } })).status).toBe(400);
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false, overrides: { env: { ROLE: "reviewer" } } } });
    const attach = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    // The sandbox's, then the agent's (its template's, then its overrides'): the agent wins on a name both set.
    expect(attach.env).toEqual({ STRIPE_KEY: ph, APP_ENV: "test", ROLE: "reviewer" });
    // Changed live: every attached agent's slot is configured again with it.
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { inject: [stripe], env: { STRIPE_KEY: ph, REGION: "eu" } } });
    const again = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    expect(again.env).toEqual({ STRIPE_KEY: ph, REGION: "eu", APP_ENV: "test", ROLE: "reviewer" });
    // A spawn's override is scanned too.
    expect((await as(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false, overrides: { env: { K: value } } } })).body.error.message)
      .toContain("stored secret");
    // Another client's secret value is just a literal to this one: no oracle on other tenants' secrets.
    const other = await newClient();
    const s2 = await placed(other, { env: { K: value } });
    expect((await ok(other.token, `/v1/sandboxes/${s2.sandbox}/client-policy`)).env).toEqual({ K: value });
    // The operator's values are checked against every secret.
    expect((await adminJson("/v1/sandboxes", { body: { cell: c.cell, env: { K: value } } }, 400)).error.message).toContain("stored secret");
    // A layer's placeholder must be its own bindings' (or the operator's): not the one of the layer it replaces.
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { STRIPE_KEY: ph } } })).body.error.message)
      .toContain("no binding here has");
    // The operator's sandbox has no client: its client layer takes no bindings.
    const op = await adminJson("/v1/sandboxes", { body: { cell: c.cell } });
    expect((await adminJson(`/v1/sandboxes/${op.sandbox}/client-policy`, { method: "PUT", body: { inject: [stripe] } }, 400)).error.message).toContain("operator's");
  });
});
