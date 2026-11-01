// Repo allowlists (docs/sandbox/networking/egress/policy/#repo-allowlists): the GitHub rule constructor
// (pure, against the shared fixture nest-proxy evaluates), attenuation in specs, and SandboxDO turning an
// allowlist into guards, a binding and a token BrokerDO mints for exactly those repos, refreshed before
// it expires and never pushed once stale. A fake GitHub stands in for api.github.com.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.github.json";
import { grantOfEntry } from "../src/lib/brokered";
import { SANDBOX_TOKEN_PERMISSIONS } from "../src/lib/github";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { canonicalRepos, narrowRepos, Repo } from "../src/lib/repos";
import { GITHUB_PLACEHOLDER, githubEgress, githubGuards } from "../src/lib/rules/github";
import { type Catalog, expandSpec, SEED_CATALOG } from "../src/lib/spec";
import { bytesToB64 } from "../src/lib/util";
import { adminJson, connectHost, nextCommands, uniqueCell, type Ws } from "./helpers";

// --- the constructor (pure) ----------------------------------------------------------------------------

describe("the GitHub rule constructor", () => {
  it("builds exactly the guards and binding in the fixture nest-proxy's seam test evaluates", () => {
    const f = githubEgress(["By77er/Nest", "by77er/nest-fork", "by77er/nest"]);
    expect(f.guards).toEqual(fixture.guards);
    expect(f.inject).toEqual(fixture.inject);
    expect(f.allow).toEqual([{ host: "api.github.com" }]);
  });

  it("an empty allowlist still refuses every push: the guards stay, with no repo exceptions, no token, no GraphQL", () => {
    const f = githubEgress([]);
    expect(f.guards.map((g) => g.name)).toEqual(["github-push", "github-write", "github-api-write", "gist-write", "githubusercontent-write"]);
    const push = f.guards.find((g) => g.name === "github-push")!;
    expect(push.allow).toBeUndefined();
    expect(f.guards.find((g) => g.name === "github-api-write")!.allow).toBeUndefined();
    // Fetches stay open with no allowlist.
    expect(f.guards.find((g) => g.name === "github-write")!.allow!.map((a) => a.path)).toEqual(["/**/git-upload-pack", "/**/info/lfs/objects/batch"]);
    expect(f.inject).toEqual([]);
    expect(f.allow).toEqual([]);
  });

  it("uses the placeholder the guest image's credential helper and GITHUB_TOKEN carry", () => {
    const files = import.meta.glob(["../../images/guest/git-credential-nest", "../../images/guest/build.sh"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    const helper = files["../../images/guest/git-credential-nest"]!;
    const build = files["../../images/guest/build.sh"]!;
    expect(helper).toContain(`password=${GITHUB_PLACEHOLDER}\n`);
    expect(build).toContain(`GITHUB_TOKEN=${GITHUB_PLACEHOLDER}"`);
    expect(githubEgress(["a/b"]).inject[0]!.placeholder).toBe(GITHUB_PLACEHOLDER);
  });

  it("names repos exactly: no wildcard, no .git, case folded", () => {
    for (const bad of ["by77er/*", "by77er", "by77er/nest.git", "by77er/..", "-x/y", "a/b/c"]) expect(Repo.safeParse(bad).success, bad).toBe(false);
    expect(canonicalRepos(["B/X", "b/x", "a/y"])).toEqual(["a/y", "b/x"]);
    expect(githubGuards(["B/X"])).toEqual(githubGuards(["b/x"]));
  });
});

// --- attenuation (pure) -----------------------------------------------------------------------------------

describe("push allowlists in specs", () => {
  const catalog: Catalog = {
    capabilities: {
      ...SEED_CATALOG.capabilities,
      gh: { tools: [], rules: [], prompt: "", params: [], grants: [], brokered: [{ action: "github.create_pr" }, { action: "github.comment", repos: ["other/repo"] }] },
    },
    templates: { coder: { ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands", "gh"], repos: ["Me/App", "me/lib"] } },
  };
  const expand = (by: "operator" | "spawner", overrides: Record<string, unknown> = {}) =>
    expandSpec(catalog, PLATFORM_TOOL_NAMES, { template: "coder", hands: true, by, overrides } as never);

  it("comes from the template, scopes the unscoped GitHub grants to it, and leaves scoped ones as the catalog named them", () => {
    const r = expand("operator");
    expect(r.ok && r.value.repos).toEqual(["me/app", "me/lib"]);
    expect(r.ok && r.value.brokered!.map((g) => (g.action === "http.request" ? null : g.repos))).toEqual([["me/app", "me/lib"], ["other/repo"]]);
  });

  it("the operator replaces it; a spawner may only narrow it", () => {
    const o = expand("operator", { repos: ["x/y"] });
    expect(o.ok && o.value.repos).toEqual(["x/y"]);
    const narrowed = expand("spawner", { repos: ["ME/LIB"] });
    expect(narrowed.ok && narrowed.value.repos).toEqual(["me/lib"]);
    expect(expand("spawner", { repos: ["me/lib", "attacker/x"] })).toEqual({ ok: false, error: "template coder: can't widen the repo allowlist with attacker/x" });
    expect(narrowRepos(["a/b"], [])).toEqual({ ok: true, value: [] });
  });

  it("no allowlist: unscoped grants stay unscoped and the spec has no repos (as before)", () => {
    const { repos: _, ...tpl } = catalog.templates.coder!;
    const r = expandSpec({ ...catalog, templates: { coder: tpl } }, PLATFORM_TOOL_NAMES, { template: "coder", hands: true, by: "operator" });
    expect(r.ok && r.value.repos).toBeUndefined();
    expect(r.ok && r.value.brokered![0]).toEqual(grantOfEntry("gh", { action: "github.create_pr" }));
  });
});

// --- SandboxDO and BrokerDO with a fake GitHub ------------------------------------------------------------------

class FakeGitHub {
  readonly installs = new Map<string, number>();
  readonly mints: { installation: number; repositories: string[]; permissions: Record<string, string>; token: string }[] = [];
  /** Lifetime of the next tokens. */
  ttlMs = 3_600_000;
  /** Holds the next mint until released. */
  hold: Promise<void> | null = null;
  private n = 0;

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      const id = this.installs.get(m[1]!.toLowerCase());
      return id ? json(200, { id }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      const body = await req.json() as { repositories: string[]; permissions: Record<string, string> };
      const installation = Number(m[1]);
      const ok = body.repositories.every((name) => [...this.installs].some(([r, i]) => i === installation && r.endsWith(`/${name}`)));
      if (!ok) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const hold = this.hold;
      this.hold = null;
      if (hold) await hold;
      const token = `ghs_sbx${String(++this.n).padStart(30, "0")}`;
      this.mints.push({ installation, ...body, token });
      return json(201, { token, expires_at: new Date(Date.now() + this.ttlMs).toISOString() });
    }
    return json(404, { message: "Not Found" });
  }
}

const gh = new FakeGitHub();
const realFetch = globalThis.fetch;
beforeAll(async () => {
  // Any RSA key will do: the fake doesn't check the JWT. Kept if another file stored the App already.
  const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
  const have = await runInDurableObject(broker, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = 'github_app'").one().n);
  if (!have) {
    const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey) as ArrayBuffer);
    // The armor is built from its label, so no literal key block sits in the source for the secret scan.
    const armor = (edge: "BEGIN" | "END") => `-----${edge} ${"PRIVATE KEY"}-----`;
    const pem = [armor("BEGIN"), ...bytesToB64(der).match(/.{1,64}/g)!, armor("END"), ""].join("\n");
    await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ app_id: "77", private_key: pem }) } });
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    return new URL(req.url).hostname === "api.github.com" ? gh.handle(req) : realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
/** A repo in a fresh installation of the fake. */
function repo(installation = 1000 + Math.floor(Math.random() * 1e6)): string {
  const r = `own-${rand()}/app-${rand()}`;
  gh.installs.set(r, installation);
  return r;
}
async function placed(policy: Record<string, unknown> = {}): Promise<{ sandbox: string; ws: Ws }> {
  const cell = uniqueCell();
  const h = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "x" } }, 201);
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell, policy } }, 201);
  return { sandbox: sbx.sandbox, ws: h.ws };
}
const ghSecret = (cmds: any[]) => cmds.find((c) => c.type === "secrets_update")?.secrets.find((s: any) => s.binding === "github");

describe("a sandbox's push allowlist", () => {
  it("becomes guards with its repos as exceptions, the github binding, and a token minted for exactly those repos", async () => {
    const r = repo();
    const before = gh.mints.length;
    const { sandbox, ws } = await placed({ repos: [r.toUpperCase()] });
    const cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    const policy = await sandboxStub(sandbox).policy() as any;
    expect(policy.guards.find((g: any) => g.name === "github-push").allow).toEqual([{ path: `/${r}/**` }, { path: `/${r}.git/**` }]);
    expect(policy.inject).toEqual([{ name: "github", hosts: ["github.com", "api.github.com"], placeholder: GITHUB_PLACEHOLDER,
      locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password" }] }]);
    expect(policy.allow.some((a: any) => a.host === "api.github.com")).toBe(true);
    const mint = gh.mints.slice(before);
    expect(mint.map((m) => ({ repositories: m.repositories, permissions: m.permissions }))).toEqual([{ repositories: [r.split("/")[1]], permissions: SANDBOX_TOKEN_PERMISSIONS }]);
    expect(ghSecret(cmds)).toMatchObject({ binding: "github", value: mint[0]!.token });
    expect(JSON.stringify(policy)).not.toContain(mint[0]!.token);
    // Audited with its target, before it was handed out; never the value.
    const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
    const records = await Promise.all(listed.objects.map(async (o) => (await env.BUCKET.get(o.key))!.text()));
    const rec = records.map((t) => JSON.parse(t)).find((x) => x.target?.sandbox === sandbox && x.expires_ms);
    expect(rec).toMatchObject({ event: "github_installation_token", repos: [r], permissions: SANDBOX_TOKEN_PERMISSIONS, target: { sandbox, epoch: 1 }, caller: "SandboxDO" });
    expect(records.some((t) => t.includes(mint[0]!.token))).toBe(false);
  });

  it("an attached agent's repos join it while attached; detaching or emptying the allowlist takes the token away", async () => {
    const mine = repo(4242);
    const theirs = repo(4242);
    const { sandbox, ws } = await placed({ repos: [mine] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    const stub = sandboxStub(sandbox);
    const agent = `agt_${rand()}${rand()}${rand()}`;
    await stub.attach(agent, undefined, [theirs]);
    let cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.at(-1)!.repositories.sort()).toEqual([mine, theirs].map((r) => r.split("/")[1]).sort());
    expect(ghSecret(cmds).value).toBe(gh.mints.at(-1)!.token);
    expect((await stub.pushRepos()).sort()).toEqual([mine, theirs].sort());
    await stub.detach(agent);
    cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.at(-1)!.repositories).toEqual([mine.split("/")[1]]);
    expect(ghSecret(cmds).value).toBe(gh.mints.at(-1)!.token);
    // Emptied: the proxy's set is replaced without it, the policy has no binding, and BrokerDO forgot it.
    const policy = await stub.setWorkstreamPolicy({ repos: [] });
    expect(policy.inject).toEqual([]);
    expect(policy.guards!.find((g) => g.name === "github-push")!.allow).toBeUndefined();
    cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(cmds.find((c) => c.type === "secrets_update").secrets).toEqual([]);
    const left = await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), async (_i, st) =>
      st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = ?", `inject:github:${sandbox}`).one().n);
    expect(left).toBe(0);
  });

  it("is refreshed before the token expires: a fresh mint, pushed again", async () => {
    const r = repo();
    gh.ttlMs = 16 * 60_000; // refreshed 15 minutes before: about a minute from now
    const { sandbox, ws } = await placed({ repos: [r] });
    gh.ttlMs = 3_600_000;
    const first = ghSecret(await nextCommands(ws, (c) => c.type === "secrets_update")).value;
    const stub = sandboxStub(sandbox);
    const at = await runInDurableObject(stub, async (_i, st) => st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'inject_refresh'").one().at);
    expect(at).toBeGreaterThan(Date.now());
    expect(at).toBeLessThan(Date.now() + 2 * 60_000);
    await runInDurableObject(stub, async (_i, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'inject_refresh'"));
    await runDurableObjectAlarm(stub);
    const second = ghSecret(await nextCommands(ws, (c) => c.type === "secrets_update")).value;
    expect(second).not.toBe(first);
    expect(second).toBe(gh.mints.at(-1)!.token);
  });

  it("a token minted for an allowlist that changed meanwhile is never pushed", async () => {
    const a = repo(5151);
    const b = repo(5151);
    const { sandbox, ws } = await placed({});
    const stub = sandboxStub(sandbox);
    let release!: () => void;
    gh.hold = new Promise<void>((r) => { release = r; });
    const before = gh.mints.length;
    const slow = stub.setWorkstreamPolicy({ repos: [a] });
    // Let the first mint reach the fake and wait there.
    await new Promise((r) => setTimeout(r, 200));
    await stub.setWorkstreamPolicy({ repos: [b] });
    release();
    await slow;
    const minted = gh.mints.slice(before);
    const forA = minted.find((m) => m.repositories[0] === a.split("/")[1])!;
    const forB = minted.find((m) => m.repositories[0] === b.split("/")[1])!;
    expect(forA && forB).toBeTruthy();
    // Every secrets_update since: a's token never went out, and the last one (what the proxy holds) is b's.
    const pushed: (string | null)[] = [];
    for (;;) {
      const cmds = await Promise.race([nextCommands(ws, (c) => c.type === "secrets_update"), new Promise<null>((r) => setTimeout(() => r(null), 500))]);
      if (!cmds) break;
      for (const c of cmds.filter((x) => x.type === "secrets_update")) pushed.push(c.secrets.find((x: any) => x.binding === "github")?.value ?? null);
    }
    expect(pushed).not.toContain(forA.token);
    expect(pushed.at(-1)).toBe(forB.token);
  });

  it("with the App on none of its repos: the binding stays (the proxy says the credential is unavailable), no token, the refusal audited", async () => {
    const r = `own-${rand()}/not-installed`;
    const { sandbox, ws } = await placed({ repos: [r] });
    const cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(ghSecret(cmds)).toBeUndefined();
    expect((await sandboxStub(sandbox).policy()).inject.map((b) => b.name)).toEqual(["github"]);
    const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
    const records = await Promise.all(listed.objects.map(async (o) => JSON.parse(await (await env.BUCKET.get(o.key))!.text())));
    expect(records.find((x) => x.target?.sandbox === sandbox)).toMatchObject({ repos: [r], refused: "the GitHub App isn't installed on these repos" });
  });

  it("guards the operator writes by hand are layered with the constructed ones, in the same policy push", async () => {
    const { sandbox, ws } = await placed({});
    const mine = { name: "registry-publish", hosts: ["registry.npmjs.org"], scope: [{ methods: ["PUT"] }], reason: "no publishing" };
    const policy = await sandboxStub(sandbox).setWorkstreamPolicy({ guards: [mine] });
    expect(policy.guards!.map((g) => g.name)).toEqual([...githubGuards([]).map((g) => g.name), "registry-publish"]);
    const [update] = (await nextCommands(ws, (c) => c.type === "policy_update")).filter((c) => c.type === "policy_update");
    expect(update.policy.guards.at(-1)).toEqual(mine);
  });

  it("static injection secrets are keyed by sandbox first, then the old workstream key, then the binding", async () => {
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const b = `svc-${rand()}`;
    await broker.putSecret(`inject:${b}`, "global-value");
    await broker.putSecret(`inject:${b}:ws_old`, "ws-value");
    const ref = async (scope: Parameters<typeof broker.injectionSecretRefs>[1]) => (await broker.injectionSecretRefs([b], scope))[0]!.value;
    expect(await ref({ sandbox: "sbx_none", workstream: "ws_old" })).toBe(`$nest-secret:inject:${b}:ws_old`);
    expect(await ref("ws_old")).toBe(`$nest-secret:inject:${b}:ws_old`);
    await broker.putSecret(`inject:${b}:sbx_mine`, "sandbox-value");
    expect(await ref({ sandbox: "sbx_mine", workstream: "ws_old" })).toBe(`$nest-secret:inject:${b}:sbx_mine`);
    expect(await ref({ sandbox: "sbx_other" })).toBe(`$nest-secret:inject:${b}`);
  });
});
