// A sandbox's client layer (docs/control-plane/api/clients/#the-client-layer): egress rules within the
// grant's `egress_hosts`, injection bindings and environment variables, from a sandbox spec, a template
// (joined while its agent is attached) or `PUT /v1/sandboxes/<id>/client-policy` on a live sandbox. Each
// reaches the host through the usual paths: the policy (`policy_update`), the secrets (`secrets_update`)
// and the agents' slots (`agent_attach.env`). The pure checks first.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { compileEgress, egressOutsideGrant, narrowEgress } from "../src/lib/client-egress";
import { EnvName, githubEnvConflict, unboundPlaceholders } from "../src/lib/sandbox-env";
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
    // The GitHub names are a name like any other; only beside nest's own GitHub token are they reserved.
    for (const name of GITHUB_TAKEOVER) {
      expect(EnvName.safeParse(name).success, name).toBe(true);
      expect(githubEnvConflict(false, { [name]: "x" }), name).toEqual([]);
      expect(githubEnvConflict(true, { A: "x" }, { [name]: "x" }), name).toEqual([name]);
    }
    expect(githubEnvConflict(true, { GH_REPO: "o/r", GIT_SSH_COMMAND: "ssh" })).toEqual([]);
    expect(unboundPlaceholders({ A: "nest-ph.cli_x.api.", B: "literal" }, ["nest-ph.cli_x.api."])).toEqual([]);
    expect(unboundPlaceholders({ A: "Bearer nest-ph.cli_y.api." }, ["nest-ph.cli_x.api."])).toEqual(["env A: a placeholder no binding here has"]);
  });
});

/** Env names that would take nest's own GitHub token over (`gh` prefers `GH_TOKEN`; git config from the env). */
const GITHUB_TAKEOVER = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "GIT_CONFIG", "GIT_CONFIG_COUNT",
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

  it("never takes away a guard: a client allowing api.github.com still gets the operator's GitHub write guards", async () => {
    const c = await newClient();
    const s = await placed(c, { egress: { allow: [{ host: "api.github.com" }] } });
    const policy = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    expect(allowed(policy)).toContain("api.github.com");
    const guard = policy.guards.find((g: any) => g.name === "github-api-write");
    expect(guard.hosts.some((h: string) => hostPatternMatches(h, "api.github.com"))).toBe(true);
    // No repo of nest's here: a write passes only with a credential nest injected, never on the client's rule alone.
    expect(guard.allow ?? []).toEqual([{ injected: "*", at: "authorization" }]);
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
  it("the API's policy marks each rule's source (base, operator, repos, client, grant); the host's policy carries none", async () => {
    const c = await newClient();
    const value = `value-src-${rand()}`;
    await ok(c.token, "/v1/clients/self/secrets/stripe-key", { method: "PUT", body: { value } });
    const s = await placed(c, { egress: { allow: [{ host: "nodejs.org" }] }, inject: [{ name: "stripe", secret: "stripe-key", hosts: ["api.stripe.com"], locations: BEARER }] });
    await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { allow: [{ host: "api.stripe.com" }], repos: ["o/r"] } });
    const wire = await nextPolicy(s.ws);
    await adminJson(`/v1/sandboxes/${s.sandbox}/grants`, { body: { host: "example.org", ttl_ms: 600_000 } });
    const view = await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`);
    const source = (host: string) => (view.allow as { host: string; source: string }[]).filter((a) => a.host === host).map((a) => a.source);
    expect(source("registry.npmjs.org")).toEqual(["base"]);
    expect(source("api.stripe.com")).toEqual(["operator"]);
    expect(source("api.github.com")).toEqual(["repos"]);
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

  it("GitHub env names are a client's where nest injects no GitHub token of its own, and refused where it does (create, layer, attach, policy)", async () => {
    const c = await newClient({ github_push: { workflows: true } });
    const takeover = Object.fromEntries(GITHUB_TAKEOVER.map((n) => [n, "anything"]));
    // No kernel GitHub token here: every name goes through, on create and live, and reaches the slots.
    const s = await placed(c, { env: takeover });
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { ...takeover, GH_TOKEN: "other" } } });
    await ok(c.token, `/v1/catalog/templates/${c.name}/w`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { GIT_CONFIG_COUNT: "0" } } });
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false } });
    const attach = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    expect(attach.env).toEqual({ ...takeover, GH_TOKEN: "other", GIT_CONFIG_COUNT: "0" });
    // Then nothing may give it one: the operator's repos or read-only repos, its own `workflows` opt-in, an agent with repos.
    for (const body of [{ repos: ["o/r"] }, { read_repos: ["o/r"] }, { github_push: { workflows: true } }]) {
      const r = await admin(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json() as any).error.message).toContain("GH_TOKEN");
    }
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: takeover, github_push: { workflows: true } } })).status).toBe(400);
    const op = await admin("/v1/agents", { method: "POST", body: { template: "worker", sandbox: s.sandbox, start: false, overrides: { repos: ["o/r"] } } });
    expect(op.status).toBe(400);
    expect((await op.json() as any).error.message).toContain("GIT_CONFIG_COUNT");
    // Nor a fork the operator approved for an attached agent (`github.fork`).
    const sstub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await expect(Promise.resolve().then(() => sstub.allowAgentRepos(a.agent, ["o/fork"]))).rejects.toThrow(/GH_TOKEN/);
    expect(await sstub.pushRepos()).toEqual([]);
    // Nothing of the refused writes stuck: still no GitHub access, and the env as it was.
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/policy`)).inject.map((b: any) => b.name)).not.toContain("github");
    expect((await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`)).github_push).toEqual({ workflows: false });

    // Where nest injects its own token, the names are refused: on create, on the layer, and in a template or spawn beside repos.
    const opBody = { cell: c.cell, policy: { repos: ["o/r"] } };
    for (const name of GITHUB_TAKEOVER) {
      expect((await admin("/v1/sandboxes", { method: "POST", body: { ...opBody, env: { [name]: "x" } } })).status, `create ${name}`).toBe(400);
      expect((await as(c.token, "/v1/sandboxes", { body: { cell: c.cell, github_push: { workflows: true }, env: { [name]: "x" } } })).status, `client create ${name}`).toBe(400);
    }
    const gh = await ok(c.token, "/v1/sandboxes", { body: { cell: c.cell, github_push: { workflows: true } } });
    const live = await as(c.token, `/v1/sandboxes/${gh.sandbox}/client-policy`, { method: "PUT", body: { github_push: { workflows: true }, env: { GH_TOKEN: "x" } } });
    expect([live.status, live.body.error.message]).toEqual([400, expect.stringContaining("reserved where nest injects its own GitHub token")]);
    // Dropping the opt-in in the same write frees them.
    await ok(c.token, `/v1/sandboxes/${gh.sandbox}/client-policy`, { method: "PUT", body: { env: { GH_TOKEN: "x" } } });
    const tpl = { capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token" };
    expect((await as(c.token, `/v1/catalog/templates/${c.name}/push`, { method: "PUT", body: { ...tpl, github_push: { workflows: true }, env: { GH_TOKEN: "x" } } })).status).toBe(400);
    const sbx = await adminJson("/v1/sandboxes", { body: opBody });
    const free = await adminJson("/v1/sandboxes", { body: { cell: c.cell } });
    // The spec's own repos beside its env: refused at its expansion, before any sandbox is asked.
    expect((await adminJson("/v1/agents", { body: { template: "worker", sandbox: free.sandbox, start: false, overrides: { repos: ["o/r"], env: { GIT_ASKPASS: "x" } } } }, 400))
      .error.message).toContain("template worker: env GIT_ASKPASS: reserved");
    // An agent with GitHub names joining a sandbox with repos: refused, and not attached.
    expect((await adminJson("/v1/agents", { body: { template: "worker", sandbox: sbx.sandbox, start: false, overrides: { env: { GH_TOKEN: "x" } } } }, 400))
      .error.message).toContain("GH_TOKEN");
    expect((await adminJson(`/v1/sandboxes/${sbx.sandbox}`)).attached).toEqual([]);
  });

  it("an attached agent's repos reserve the GitHub names for the whole sandbox while it is attached; its own attach again replaces its part", async () => {
    const c = await newClient();
    const s = await placed(c);
    const pusher = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false, overrides: { read_repos: ["o/r"] } } }, 201);
    expect((await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false, overrides: { env: { GH_TOKEN: "x" } } } }, 400))
      .error.message).toContain("GH_TOKEN");
    expect((await as(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { GIT_CONFIG_COUNT: "1" } } })).status).toBe(400);
    // The same agent attached again with no repos replaces its part: nothing else gives the sandbox GitHub access.
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await stub.attach(pusher.agent, undefined, [], [], { env: { GH_TOKEN: "x" } });
    expect((await stub.repoAccess()).read).toEqual([]);
    // And back: its repos again, its env (the GitHub names) replaced by none.
    await stub.attach(pusher.agent, undefined, [], ["o/r"], {});
    expect((await stub.repoAccess()).read).toEqual(["o/r"]);
    // Once it is detached, the sandbox's own env may name them.
    await stub.detach(pusher.agent);
    await ok(c.token, `/v1/sandboxes/${s.sandbox}/client-policy`, { method: "PUT", body: { env: { GIT_CONFIG_COUNT: "1" } } });
  });

  it("an operator binding under a GitHub binding's name, and an agent's push-token opt-in, are nest's own GitHub access too", async () => {
    const cell = uniqueCell();
    for (const name of ["github", "github_read", "github_read_default"]) {
      const inject = [{ name, hosts: ["api.github.com"], placeholder: `nest-ph-${name}-op`, locations: [{ type: "authorization_bearer" }] }];
      expect((await adminJson("/v1/sandboxes", { body: { cell, policy: { inject }, env: { GH_TOKEN: "x" } } }, 400)).error.message, name).toContain("GH_TOKEN");
      const s = await adminJson("/v1/sandboxes", { body: { cell, env: { GH_TOKEN: "x" } } }, 202);
      expect((await adminJson(`/v1/sandboxes/${s.sandbox}/policy`, { method: "PUT", body: { inject } }, 400)).error.message, name).toContain("GH_TOKEN");
    }
    // An agent asking for `workflows: write` on the push token, attaching beside the sandbox's GH_TOKEN.
    const s = await adminJson("/v1/sandboxes", { body: { cell, env: { GH_TOKEN: "x" } } }, 202);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await expect(Promise.resolve().then(() => stub.attach("agt_workflows", undefined, [], [], { workflows: true }))).rejects.toThrow(/GH_TOKEN/);
    expect((await stub.info()).attached).toEqual([]);
  });

  it("an attach that waits on its cell's guard bounds is checked after the wait: an operator's repos written meanwhile refuse its GH_TOKEN", async () => {
    const cell = uniqueCell();
    const s = await adminJson("/v1/sandboxes", { body: { cell } }, 202);
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    // FleetDO's guard-bounds answer held until the operator's write is in.
    const proto = FleetDO.prototype as unknown as { hostsWithoutGuardBounds: () => Promise<string[]> };
    const real = proto.hostsWithoutGuardBounds;
    let state: "idle" | "held" | "go" = "idle";
    proto.hostsWithoutGuardBounds = async function () {
      state = "held";
      while (state === "held") await new Promise((r) => setTimeout(r, 10));
      return [];
    };
    let attached: Promise<unknown>;
    try {
      attached = Promise.resolve().then(() => stub.attach("agt_waits", undefined, [], [], {
        env: { GH_TOKEN: "client" }, guards: [{ name: "g", hosts: ["x.example.org"], scope: [{ methods: ["PUT"] }], client: null }] }))
        .then(() => null, (e: unknown) => e);
      await eventually("the attach waiting on guard bounds", () => state === "held");
      await stub.setPolicy({ repos: ["o/r"] });
    } finally {
      state = "go";
      proto.hostsWithoutGuardBounds = real;
    }
    expect(String(await attached)).toContain("GH_TOKEN");
    expect([(await stub.pushRepos()), (await stub.info()).attached]).toEqual([["o/r"], []]);
  });

  it("a sandbox a previous release left with GitHub names beside nest's own GitHub token never sends them to a slot", async () => {
    const c = await newClient();
    const s = await placed(c, { env: { GH_TOKEN: "client", APP_ENV: "staging" } });
    await ok(c.token, `/v1/catalog/templates/${c.name}/w`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: LAUNCH, hands: "required", credential: "claude_oauth_token", env: { GIT_CONFIG_COUNT: "1", ROLE: "w" } } });
    const a = await ok(c.token, "/v1/agents", { body: { template: `${c.name}/w`, sandbox: s.sandbox, start: false } });
    await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent);
    // What a previous release (which checks none of this) can store: the operator's repos beside that env.
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(s.sandbox));
    await runInDurableObject(stub, async (inst: SandboxDO, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one();
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'ws_layer'", JSON.stringify({ ...JSON.parse(row.value), repos: ["o/r"] }));
      // A slot configured again (as a move or a new placement does).
      await (inst as unknown as { issueAttachCommands(a: string[]): Promise<void> }).issueAttachCommands([a.agent]);
    });
    const again = (await nextCommands(s.ws, (x) => x.type === "agent_attach" && x.agent === a.agent)).find((x) => x.type === "agent_attach")!;
    expect(again.env).toEqual({ APP_ENV: "staging", ROLE: "w" });
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
