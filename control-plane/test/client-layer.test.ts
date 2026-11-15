// A sandbox's client layer (docs/control-plane/api/clients/#the-client-layer): egress rules within the
// grant's `egress_hosts`, injection bindings and environment variables, from a sandbox spec, a template
// (joined while its agent is attached) or `PUT /v1/sandboxes/<id>/client-policy` on a live sandbox. Each
// reaches the host through the usual paths: the policy (`policy_update`), the secrets (`secrets_update`)
// and the agents' slots (`agent_attach.env`). The pure checks first.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compileEgress, egressOutsideGrant, narrowEgress } from "../src/lib/client-egress";
import { EnvName, unboundPlaceholders } from "../src/lib/sandbox-env";
import { SandboxDO } from "../src/do/sandbox";
import { FleetDO } from "../src/do/fleet";
import { hostPatternMatches } from "../src/protocol/model";
import { ClientDO } from "../src/do/client";
import { admin, adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell, type Ws } from "./helpers";

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
    for (const bad of ["PATH", "HOME", "NEST_AGENT_ID", "NEST_ANYTHING", "HTTPS_PROXY", "LD_PRELOAD", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
      "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "lower", "1A", "A-B", ""]) {
      expect(EnvName.safeParse(bad).success, bad).toBe(false);
    }
    // GitHub's and git's names are names like any other: nest injects no GitHub token of its own to reserve them for.
    for (const name of GITHUB_NAMES) expect(EnvName.safeParse(name).success, name).toBe(true);
    expect(unboundPlaceholders({ A: "nest-ph.cli_x.api.", B: "literal" }, ["nest-ph.cli_x.api."])).toEqual([]);
    expect(unboundPlaceholders({ A: "Bearer nest-ph.cli_y.api." }, ["nest-ph.cli_x.api."])).toEqual(["env A: a placeholder no binding here has"]);
  });
});

/** Env names nest reserved while it injected a GitHub token of its own (`gh` prefers `GH_TOKEN`; git config from the env). */
const GITHUB_NAMES = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "GIT_CONFIG", "GIT_CONFIG_COUNT",
  "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"];

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
    expect(policy.allow).toContainEqual({ host: "nodejs.org", ports: [80, 443], layer: "workstream", source: "client" });
    expect(policy.allow).toContainEqual({ host: "registry.npmjs.com", ports: [443], layer: "workstream", source: "client" });
  });

  it("never takes away a guard: a client allowing api.github.com still gets the operator's write guard there", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "api.github.com" }] } });
    const mine = { name: "api-write", hosts: ["*.github.com"], scope: [{ methods_except: ["GET", "HEAD"] }], reason: "read-only", ignore_case: true };
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { guards: [mine] } });
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(allowed(policy)).toContain("api.github.com");
    const guard = policy.guards.find((g: any) => g.name === "api-write");
    expect(guard.hosts.some((h: string) => hostPatternMatches(h, "api.github.com"))).toBe(true);
    // The client's rule opens the host; the operator's guard still refuses its writes.
    expect(guard).toEqual(mine);
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

describe("where each allow rule came from", () => {
  it("the API's policy marks each rule's source (base, operator, client, grant); the host's policy carries none", async () => {
    const c = await newClient();
    const value = `value-src-${rand()}`;
    await ok(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await placed(c, { egress: { allow: [{ host: "nodejs.org" }] }, inject: [{ name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER }] });
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "api.stripe.com" }] } });
    const wire = await nextPolicy(s.ws);
    await adminJson(`/v1/sandboxes/${s.sandbox}/grants`, { body: { host: "example.org", ttl_ms: 600_000 } });
    const view = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    const source = (host: string) => (view.allow as { host: string; source: string }[]).filter((a) => a.host === host).map((a) => a.source);
    expect(source("registry.npmjs.org")).toEqual(["base"]);
    expect(source("api.stripe.com")).toEqual(["operator"]);
    expect(new Set((view.allow as { source: string }[]).map((a) => a.source))).toEqual(new Set(["base", "operator", "client", "grant"]));
    expect(source("nodejs.org")).toEqual(["client"]);
    expect(source("example.org")).toEqual(["grant"]);
    // `layer` stays as the wire has it, for one release.
    expect(view.allow.find((a: any) => a.host === "nodejs.org").layer).toBe("workstream");
    // Never to a host: the proxy's policy has `layer` and no `source`.
    expect(wire.allow.every((a: any) => !("source" in a))).toBe(true);
    expect(wire.allow.find((a: any) => a.host === "nodejs.org")).toEqual({ host: "nodejs.org", ports: [80, 443], layer: "workstream" });
    // What the client reads holds no secret, no secret reference, and no other client.
    const text = JSON.stringify(view);
    expect(text).not.toContain(value);
    expect(text).not.toContain("$nest-secret");
    expect((text.match(/cli_[A-Za-z0-9]+/g) ?? []).every((id) => id === c.id)).toBe(true);
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

  it("GitHub's env names are a client's everywhere: nest injects no GitHub token of its own to reserve them for (create, layer, template, slot)", async () => {
    const c = await newClient();
    const takeover = Object.fromEntries(GITHUB_NAMES.map((n) => [n, "anything"]));
    const s = await placed(c, { env: takeover });
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { ...takeover, GH_TOKEN: "other" } } });
    await ok(c.token, `/v1/catalog/templates/${c.name}/w`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { GIT_CONFIG_COUNT: "0" } } });
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false } });
    const attach = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    expect(attach.env).toEqual({ ...takeover, GH_TOKEN: "other", GIT_CONFIG_COUNT: "0" });
    // An operator binding under GitHub's old binding name is the operator's like any other: the names stay the client's.
    const inject = [{ name: "github", hosts: ["api.github.com"], placeholder: "nest-ph-github-op", locations: BEARER }];
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { inject } });
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { GH_TOKEN: "again" } } });
  });

  it("the removed repo fields: taken only when they grant nothing (and dropped), refused otherwise, at every write that took them", async () => {
    const c = await newClient();
    const s = await placed(c);
    const tpl = { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token" };
    const refused = async (r: Response | { status: number; body: any }, field: string) => {
      const [status, body] = r instanceof Response ? [r.status, await r.json() as any] : [r.status, r.body];
      expect([status, body.error.message], field).toEqual([400, expect.stringContaining(`${field} is no longer accepted`)]);
    };
    // The operator's layer and its sandbox create.
    for (const [field, value] of [["repos", ["o/r"]], ["read_repos", ["o/r"]], ["github_push", { workflows: true }]] as const) {
      const name = field === "github_push" ? "github_push.workflows" : field;
      await refused(await admin(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { [field]: value } }), name);
      await refused(await admin("/v1/sandboxes", { method: "POST", body: { cell: c.cell, policy: { [field]: value } } }), name);
      // A template, the operator's or a client's, and a spawn's overrides, the operator's or a client's.
      await refused(await admin("/v1/admin/templates/removed-fields", { method: "PUT", body: { ...tpl, [field]: value } }), name);
      await refused(await as(c.token, `/v1/catalog/templates/${c.name}/removed`, { method: "PUT", body: { ...tpl, [field]: value } }), name);
      await refused(await admin("/v1/agents", { method: "POST", body: { template: "worker", sandbox: s.sandbox, start: false, overrides: { [field]: value } } }), name);
    }
    await ok(c.token, `/v1/catalog/templates/${c.name}/x`, { method: "PUT", body: tpl });
    for (const [field, value] of [["repos", ["o/r"]], ["read_repos", ["o/r"]], ["github_push", { workflows: true }]] as const) {
      const r = await as(c.token, "/v1/agents", { body: { template: `${c.name}/x`, sandbox: s.sandbox, start: false, overrides: { [field]: value } } });
      await refused(r, field === "github_push" ? "github_push.workflows" : field);
    }
    // The client layer and a client's sandbox create: `github_push` only.
    await refused(await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { github_push: { workflows: true } } }), "github_push.workflows");
    await refused(await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, github_push: { workflows: true } } }), "github_push.workflows");

    // What grants nothing goes through, and is dropped: what an app narrowing to none (or an old client) sends.
    const none = { repos: [], read_repos: [], github_push: { workflows: false } };
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "api.stripe.com" }], ...none } });
    expect(await adminJson("/v1/admin/templates/removed-fields", { method: "PUT", body: { ...tpl, ...none } })).toEqual(tpl);
    expect(await ok(c.token, `/v1/catalog/templates/${c.name}/x`, { method: "PUT", body: { ...tpl, ...none } })).toEqual(tpl);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { GH_TOKEN: "x" }, github_push: { workflows: false } } });
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/x`, sandbox: s.sandbox, start: false, overrides: { repos: [], read_repos: [] } } });
    const b = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false, overrides: none } }, 201);
    for (const { agent } of [a, b]) {
      const stored = await runInDurableObject(env.AGENT.get(env.AGENT.idFromName(agent)), (_i, st) =>
        JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value) as object);
      expect(["repos", "read_repos", "github_push"].filter((k) => Object.hasOwn(stored, k)), agent).toEqual([]);
    }
    expect(Object.hasOwn(await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`), "github_push")).toBe(false);
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(policy.inject.map((b: any) => b.name)).toEqual([]);
    expect(policy.guards.map((g: any) => g.name)).toEqual([]);
    expect(allowed(policy)).not.toContain("api.github.com");
  });

  it("what a previous release stored or sends of them is ignored: no binding, guard, host or token from it, and GitHub's env names reach the slot", async () => {
    const c = await newClient();
    const s = await placed(c, { env: { GH_TOKEN: "client", APP_ENV: "staging" } });
    await ok(c.token, `/v1/catalog/templates/${c.name}/w`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { GIT_CONFIG_COUNT: "1", ROLE: "w" } } });
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false } });
    await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    // The operator's layer as the previous release stored it, with repos, read-only repos and the push opt-in.
    await runInDurableObject(stub, async (inst: SandboxDO, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one();
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'ws_layer'", JSON.stringify({ ...JSON.parse(row.value), repos: ["o/r"], read_repos: ["o/s"], github_push: { workflows: true } }));
      // A slot configured again (as a move or a new placement does).
      await (inst as unknown as { issueAttachCommands(a: string[]): Promise<void> }).issueAttachCommands([a.agent]);
    });
    const again = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    expect(again.env).toEqual({ GH_TOKEN: "client", APP_ENV: "staging", GIT_CONFIG_COUNT: "1", ROLE: "w" });
    // An attach from an AgentDO of the previous release, which still passes an agent's repos and push opt-in.
    await stub.attach("agt_previous", undefined, ["o/r"], ["o/s"], { workflows: true } as never);
    expect((await stub.info()).attached).toContain("agt_previous");
    // And a client layer from its Worker, with the opt-in.
    await stub.setClientLayer({ egress: [], inject: [], env: { GH_TOKEN: "client" }, guards: [], workflows: true } as never);
    const policy = await stub.policy();
    expect(policy.inject.map((b) => b.name)).toEqual([]);
    expect(policy.guards!.map((g) => g.name)).toEqual([]);
    expect(policy.allow.filter((r) => r.host === "api.github.com")).toEqual([]);
    expect(Object.hasOwn(await stub.clientLayer(), "github_push")).toBe(false);
    // The layer reads without them, and keeps them stored (a rollback reads them again).
    await runInDurableObject(stub, (_i: SandboxDO, st) => {
      expect(JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one().value).repos).toEqual(["o/r"]);
    });
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
