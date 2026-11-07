// Repo allowlists (docs/sandbox/networking/egress/policy/#repo-allowlists): the GitHub rule constructor
// (pure, against the shared fixture nest-proxy evaluates), attenuation in specs, and SandboxDO turning an
// allowlist into guards, a binding and a token BrokerDO mints for exactly those repos, refreshed before
// it expires and never pushed once stale. A fake GitHub stands in for api.github.com.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../../protocol/fixtures/control/egress_policy/egress_policy.github.json";
import readFixture from "../../protocol/fixtures/control/egress_policy/egress_policy.github_read.json";
import { grantOfEntry } from "../src/lib/brokered";
import { SANDBOX_READ_TOKEN_PERMISSIONS, SANDBOX_TOKEN_PERMISSIONS } from "../src/lib/github";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { canonicalRepos, narrowRepos, Repo } from "../src/lib/repos";
import { GITHUB_PLACEHOLDER, GITHUB_READ_PLACEHOLDER, githubBinding, githubEgress, githubGuards } from "../src/lib/rules/github";
import { BrokerDO } from "../src/do/broker";
import { Grant, specOutsideGrant } from "../src/lib/clients";
import { type Catalog, expandSpec, SEED_CATALOG } from "../src/lib/spec";
import { bytesToB64 } from "../src/lib/util";
import { adminJson, connectHost, nextCommands, runDue, type Ws, uniqueCell } from "./helpers";

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

  it("with read-only repos, builds exactly the guards and bindings in the fixture nest-proxy's seam test evaluates", () => {
    // by77er/nest is on both lists: pushable, so not read-only.
    const f = githubEgress(["by77er/nest"], ["By77er/Private-Lib", "by77er/nest"]);
    expect(f.guards).toEqual(readFixture.guards);
    expect(f.inject).toEqual(readFixture.inject);
    expect(f.allow).toEqual([{ host: "api.github.com" }]);
  });

  it("read-only repos alone: no push or REST write exception for them, no `github` binding, GraphQL only with the read-only bindings", () => {
    const f = githubEgress([], ["a/b"]);
    expect(f.guards.find((g) => g.name === "github-push")!.allow).toBeUndefined();
    expect(f.guards.find((g) => g.name === "github-write")!.allow!.map((a) => a.path)).toEqual(["/**/git-upload-pack", "/**/info/lfs/objects/batch"]);
    // Never `github`: a push token the proxy still holds under it has no binding and no exception.
    expect(f.guards.find((g) => g.name === "github-api-write")!.allow).toEqual([
      { methods: ["POST"], path: "/graphql", injected: "github_read" }, { methods: ["POST"], path: "/graphql", injected: "github_read_default" },
    ]);
    expect(f.inject.map((b) => [b.name, b.placeholder])).toEqual([["github_read", GITHUB_READ_PLACEHOLDER], ["github_read_default", GITHUB_PLACEHOLDER]]);
    expect(f.allow).toEqual([{ host: "api.github.com" }]);
    // nest-proxy looks for a placeholder as a substring before it substitutes an exact one: neither may contain the other.
    expect(GITHUB_READ_PLACEHOLDER.includes(GITHUB_PLACEHOLDER) || GITHUB_PLACEHOLDER.includes(GITHUB_READ_PLACEHOLDER)).toBe(false);
    // No read-only repos: exactly the push allowlist's rules, as before them.
    expect(githubEgress(["a/b"], [])).toEqual(githubEgress(["a/b"]));
    expect(githubEgress(["a/b"], ["A/B"])).toEqual(githubEgress(["a/b"]));
  });

  it("an operator's own binding gets no GraphQL exception from read-only repos, and keeps the default placeholder", () => {
    const pat = { ...githubBinding(), name: "github" };
    // The operator's `github` (a credential nest didn't mint) and no allowlist: GraphQL stays refused for it.
    const f = githubEgress([], ["a/b"], [pat]);
    expect(f.guards.find((g) => g.name === "github-api-write")!.allow).toEqual([{ methods: ["POST"], path: "/graphql", injected: "github_read" }]);
    expect(f.inject.map((b) => b.name)).toEqual(["github_read"]);
    // Nor for an operator's binding named `github_read`, or one taking the default placeholder under another name.
    const theirs = githubEgress([], ["a/b"], [{ ...pat, name: "github_read", placeholder: "x" }]);
    expect(theirs.guards.find((g) => g.name === "github-api-write")!.allow).toBeUndefined();
    expect(theirs.inject.map((b) => b.name)).toEqual(["github_read"]);
    expect(githubEgress([], ["a/b"], [{ ...pat, name: "mine" }]).inject.map((b) => b.name)).toEqual(["github_read"]);
    // With an allowlist, as before read-only repos: the exception names `github`, whoever's it is.
    expect(githubEgress(["a/c"], [], [pat])).toEqual(githubEgress(["a/c"]));
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
      gh: { tools: [], rules: [], prompt: "", brokered: [{ action: "github.create_pr" }, { action: "github.comment", repos: ["other/repo"] }] },
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

describe("read-only repos in specs", () => {
  const catalog: Catalog = {
    capabilities: { ...SEED_CATALOG.capabilities, gh: { tools: [], rules: [], prompt: "", brokered: [{ action: "github.comment" }] } },
    templates: { reviewer: { ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands", "gh"], repos: ["me/app"], read_repos: ["Me/Lib", "me/docs", "ME/APP"] } },
  };
  const expand = (by: "operator" | "spawner", overrides: Record<string, unknown> = {}) =>
    expandSpec(catalog, PLATFORM_TOOL_NAMES, { template: "reviewer", hands: true, by, overrides } as never);

  it("come from the template, less its push allowlist, and scope no brokered action", () => {
    const r = expand("operator");
    expect(r.ok && r.value.repos).toEqual(["me/app"]);
    expect(r.ok && r.value.read_repos).toEqual(["me/docs", "me/lib"]);
    expect(r.ok && r.value.brokered!.map((g) => (g.action === "http.request" ? null : g.repos))).toEqual([["me/app"]]);
  });

  it("the operator replaces them; a spawner (or a client) may only narrow them, to the template's read-only repos or its push allowlist", () => {
    expect((expand("operator", { read_repos: ["x/y"] }) as any).value.read_repos).toEqual(["x/y"]);
    expect((expand("spawner", { read_repos: ["ME/LIB"] }) as any).value.read_repos).toEqual(["me/lib"]);
    // Reading a repo it could push to is narrower: dropped from the allowlist, it stays readable.
    const down = expand("spawner", { repos: [], read_repos: ["me/app"] }) as any;
    expect([down.value.repos, down.value.read_repos]).toEqual([undefined, ["me/app"]]);
    expect(expand("spawner", { read_repos: ["me/lib", "attacker/x"] })).toEqual({ ok: false, error: "template reviewer: can't widen the repos it may read with attacker/x" });
    // A read-only repo never becomes pushable.
    expect(expand("spawner", { repos: ["me/lib"] })).toEqual({ ok: false, error: "template reviewer: can't widen the repo allowlist with me/lib" });
    const none = expand("spawner", { read_repos: [] }) as any;
    expect("read_repos" in none.value).toBe(false);
  });

  it("an allowlist override keeps a template's read-only repo that was also on its allowlist readable", () => {
    const tpl = { ...catalog.templates.reviewer!, repos: ["me/app"], read_repos: ["me/app", "me/lib"] };
    const cat = { ...catalog, templates: { reviewer: tpl } };
    for (const by of ["operator", "spawner"] as const) {
      const r = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "reviewer", hands: true, by, overrides: { repos: [] } } as never) as any;
      expect([by, r.value.repos, r.value.read_repos]).toEqual([by, undefined, ["me/app", "me/lib"]]);
    }
  });

  it("a spawner narrowing the allowlist to none drops the unscoped GitHub grants it scoped, rather than leaving them on any repo", () => {
    const r = expand("spawner", { repos: [], read_repos: ["me/app"] }) as any;
    expect(r.value.brokered).toBeUndefined();
    // Scoped grants keep the repos the catalog named; the operator (the root) may still leave them unscoped.
    const cat: Catalog = { ...catalog, capabilities: { ...catalog.capabilities, gh: { ...catalog.capabilities.gh!, brokered: [{ action: "github.comment" }, { action: "github.create_pr", repos: ["me/app"] }] } } };
    const s = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "reviewer", hands: true, by: "spawner", overrides: { repos: [] } }) as any;
    expect(s.value.brokered.map((g: any) => [g.action, g.repos])).toEqual([["github.create_pr", ["me/app"]]]);
    const o = expand("operator", { repos: [] }) as any;
    expect(o.value.brokered.map((g: any) => g.repos)).toEqual([null]);
  });

  it("a template without them expands to a spec without them, as before", () => {
    const { read_repos: _, ...tpl } = catalog.templates.reviewer!;
    const r = expandSpec({ ...catalog, templates: { reviewer: tpl } }, PLATFORM_TOOL_NAMES, { template: "reviewer", hands: true, by: "operator" });
    expect(r.ok && Object.keys(r.value)).not.toContain("read_repos");
  });
});

// --- SandboxDO and BrokerDO with a fake GitHub ------------------------------------------------------------------

class FakeGitHub {
  readonly installs = new Map<string, number>();
  readonly mints: { installation: number; repositories: string[]; permissions: Record<string, string>; token: string }[] = [];
  /** Tokens revoked (`DELETE /installation/token`, authorized by the token itself). */
  readonly revoked: string[] = [];
  /** The next revokes that fail (GitHub's answer lost). */
  failRevokes = 0;
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
    if (u.pathname === "/installation/token" && req.method === "DELETE" && this.failRevokes > 0) {
      this.failRevokes--;
      return json(502, { message: "Bad Gateway" });
    }
    if (u.pathname === "/installation/token" && req.method === "DELETE") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (!this.mints.some((m) => m.token === token) || this.revoked.includes(token)) return json(401, { message: "Bad credentials" });
      this.revoked.push(token);
      return new Response(null, { status: 204 });
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
  const sbx = await adminJson("/v1/sandboxes", { body: { cell, policy } }, 201);
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
    const policy = await stub.setPolicy({ repos: [] });
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
    await runDue(stub);
    const second = ghSecret(await nextCommands(ws, (c) => c.type === "secrets_update")).value;
    expect(second).not.toBe(first);
    expect(second).toBe(gh.mints.at(-1)!.token);
  });

  it("after the App is reinstalled (a new installation id), a sandbox's token is minted from the new one at once", async () => {
    const r = repo();
    const old = gh.installs.get(r)!;
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const source = { kind: "github_app" as const, binding: "github", repos: [r] };
    const first = await broker.injectionSecret({ sandbox: `sbx_${rand()}`, epoch: 1 }, source, "test");
    expect(first).not.toBeNull();
    expect(gh.mints.at(-1)!.installation).toBe(old);
    gh.installs.set(r, old + 1);
    // Another sandbox (nothing held to reuse): the cached id is refused, looked up afresh, minted from the new one.
    const second = await broker.injectionSecret({ sandbox: `sbx_${rand()}`, epoch: 1 }, source, "test");
    expect(second).toMatchObject({ covers: [r] });
    expect(gh.mints.at(-1)!.installation).toBe(old + 1);
  });

  it("a sandbox's held token is reused, but never after the App is replaced: the next push mints under the new one", async () => {
    const r = repo();
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const source = { kind: "github_app" as const, binding: "github", repos: [r] };
    const target = { sandbox: `sbx_${rand()}`, epoch: 1 };
    await broker.injectionSecret(target, source, "test");
    const minted = gh.mints.length;
    await broker.injectionSecret(target, source, "test");
    expect(gh.mints.length).toBe(minted);
    const was = await runInDurableObject(broker, (_i, st) => st.storage.sql.exec<{ value: string }>("SELECT value FROM secrets WHERE name = 'github_app'").one().value);
    const creds = JSON.parse(was) as { app_id: string; private_key: string };
    await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ ...creds, app_id: `${creds.app_id}9` }) } });
    try {
      await broker.injectionSecret(target, source, "test");
      expect(gh.mints.length).toBe(minted + 1);
    } finally {
      await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: was } });
    }
  });

  it("a token minted for an allowlist that changed meanwhile is never pushed", async () => {
    const a = repo(5151);
    const b = repo(5151);
    const { sandbox, ws } = await placed({});
    const stub = sandboxStub(sandbox);
    let release!: () => void;
    gh.hold = new Promise<void>((r) => { release = r; });
    const before = gh.mints.length;
    const slow = stub.setPolicy({ repos: [a] });
    // Let the first mint reach the fake and wait there.
    await new Promise((r) => setTimeout(r, 200));
    await stub.setPolicy({ repos: [b] });
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
    const policy = await sandboxStub(sandbox).setPolicy({ guards: [mine] });
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

const readSecret = (cmds: any[]) => cmds.find((c) => c.type === "secrets_update")?.secrets.find((s: any) => s.binding === "github_read");
/** The next secrets_update and the policy_update after it: the secrets must come first, in the same batch or an earlier one. */
async function secretsThenPolicy(ws: Ws): Promise<{ secrets: any[]; policy: any }> {
  const first = await nextCommands(ws, (c) => c.type === "policy_update" || c.type === "secrets_update");
  const si = first.findIndex((c) => c.type === "secrets_update");
  const pi = first.findIndex((c) => c.type === "policy_update");
  expect(si, "a secrets_update before the policy_update").toBeGreaterThanOrEqual(0);
  expect(pi === -1 || si < pi, "secrets_update before policy_update").toBe(true);
  const policy = pi >= 0 ? first[pi] : (await nextCommands(ws, (c) => c.type === "policy_update")).find((c) => c.type === "policy_update");
  return { secrets: first, policy };
}

describe("a sandbox's read-only repos", () => {
  it("alone: a token that can only read, for exactly those repos, under both read-only bindings; pushes to them stay refused", async () => {
    const r = repo();
    const before = gh.mints.length;
    const { sandbox, ws } = await placed({ read_repos: [r.toUpperCase()] });
    const cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    const mint = gh.mints.slice(before);
    expect(mint.map((m) => ({ repositories: m.repositories, permissions: m.permissions }))).toEqual([{ repositories: [r.split("/")[1]], permissions: SANDBOX_READ_TOKEN_PERMISSIONS }]);
    expect(Object.values(mint[0]!.permissions)).toEqual(["read", "read"]);
    // The guest's default placeholder (`github_read_default`) and the read-only one both carry it; nothing is under `github`.
    expect(ghSecret(cmds)).toBeUndefined();
    expect(cmds.find((c) => c.type === "secrets_update").secrets.find((x: any) => x.binding === "github_read_default")).toMatchObject({ value: mint[0]!.token });
    expect(readSecret(cmds)).toMatchObject({ binding: "github_read", value: mint[0]!.token });
    const policy = await sandboxStub(sandbox).policy() as any;
    expect(policy.guards.find((g: any) => g.name === "github-push").allow).toBeUndefined();
    expect(policy.guards.find((g: any) => g.name === "github-api-write").allow.filter((a: any) => a.path !== "/graphql")).toEqual([]);
    expect(policy.inject.map((b: any) => [b.name, b.placeholder])).toEqual([["github_read", GITHUB_READ_PLACEHOLDER], ["github_read_default", GITHUB_PLACEHOLDER]]);
    const listed = await env.BUCKET.list({ prefix: "audit/broker/" });
    const records = await Promise.all(listed.objects.map(async (o) => JSON.parse(await (await env.BUCKET.get(o.key))!.text())));
    expect(records.find((x) => x.target?.sandbox === sandbox && x.expires_ms)).toMatchObject({ repos: [r], permissions: SANDBOX_READ_TOKEN_PERMISSIONS, binding: "github_read" });
  });

  it("with a push allowlist: the push token covers only the allowlist, the read-only token only the read-only repos", async () => {
    const pushable = repo(6161);
    const readable = repo(6161);
    const before = gh.mints.length;
    // On both lists, `pushable` stays pushable; `readable` gains no write anywhere.
    const { sandbox, ws } = await placed({ repos: [pushable], read_repos: [readable, pushable] });
    // The push that carries both tokens (pushes before it may carry fewer).
    let last: any;
    while (!last) {
      const update = (await nextCommands(ws, (c) => c.type === "secrets_update")).find((c) => c.type === "secrets_update");
      if (["github", "github_read"].every((b) => update.secrets.some((x: any) => x.binding === b))) last = update;
    }
    const mints = gh.mints.slice(before);
    expect(mints.map((m) => [m.repositories, m.permissions]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual([
      [[pushable.split("/")[1]], SANDBOX_TOKEN_PERMISSIONS], [[readable.split("/")[1]], SANDBOX_READ_TOKEN_PERMISSIONS],
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    for (const m of mints) if (m.repositories.includes(readable.split("/")[1]!)) expect(Object.values(m.permissions).every((l) => l === "read"), JSON.stringify(m)).toBe(true);
    const write = mints.find((m) => m.permissions.contents === "write")!;
    const read = mints.find((m) => m.permissions.contents === "read")!;
    expect(last.secrets.find((x: any) => x.binding === "github").value).toBe(write.token);
    expect(last.secrets.find((x: any) => x.binding === "github_read").value).toBe(read.token);
    const policy = await sandboxStub(sandbox).policy() as any;
    expect(policy.guards.find((g: any) => g.name === "github-push").allow).toEqual([{ path: `/${pushable}/**` }, { path: `/${pushable}.git/**` }]);
  });

  it("an attached agent's join while attached and go at detach; a sandbox with none keeps its push token alone", async () => {
    const mine = repo(7171);
    const theirs = repo(7171);
    const { sandbox, ws } = await placed({ repos: [mine] });
    const first = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(readSecret(first)).toBeUndefined();
    const stub = sandboxStub(sandbox);
    const agent = `agt_${rand()}${rand()}${rand()}`;
    const before = gh.mints.length;
    await stub.attach(agent, undefined, [], [theirs]);
    let cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    const read = gh.mints.slice(before).find((m) => m.permissions.contents === "read")!;
    expect(read.repositories).toEqual([theirs.split("/")[1]]);
    expect(readSecret(cmds).value).toBe(read.token);
    // The allowlist didn't change: its token is reused, not minted wider.
    expect(gh.mints.slice(before).filter((m) => m.permissions.contents === "write")).toEqual([]);
    expect(await stub.repoAccess()).toEqual({ push: [mine], read: [theirs] });
    await stub.detach(agent);
    cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(readSecret(cmds)).toBeUndefined();
    expect(ghSecret(cmds)).toBeDefined();
    expect((await stub.policy()).inject.map((b) => b.name)).toEqual(["github"]);
  });

  it("an allowlist moved to the read list: the push token leaves the proxy before the policy changes, the new policy has no `github` binding, and BrokerDO forgets the push token", async () => {
    const r = repo();
    const { sandbox, ws } = await placed({ repos: [r] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    const stub = sandboxStub(sandbox);
    const before = gh.mints.length;
    await stub.setPolicy({ read_repos: [r] });
    // The secrets go first (the proxy drops the push token), then a policy with no binding it could go out under.
    const { secrets: cmds, policy: update } = await secretsThenPolicy(ws);
    expect(update.policy.inject.map((b: any) => b.name)).toEqual(["github_read", "github_read_default"]);
    expect(update.policy.guards.find((g: any) => g.name === "github-api-write").allow.map((a: any) => a.injected)).toEqual(["github_read", "github_read_default"]);
    expect(ghSecret(cmds)).toBeUndefined();
    expect(gh.mints.slice(before).map((m) => m.permissions)).toEqual([SANDBOX_READ_TOKEN_PERMISSIONS]);
    const held = await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), async (_i, st) =>
      st.storage.sql.exec("SELECT name FROM secrets WHERE name LIKE ?", `inject:%:${sandbox}`).toArray().map((x) => x.name));
    expect(held).toEqual([`inject:github_read:${sandbox}`]);
    // Emptied too: the read-only token goes.
    await stub.setPolicy({ repos: [r] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    const after = await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), async (_i, st) =>
      st.storage.sql.exec("SELECT name FROM secrets WHERE name LIKE ?", `inject:%:${sandbox}`).toArray().map((x) => x.name));
    expect(after).toEqual([`inject:github:${sandbox}`]);
  });

  it("part of an allowlist moved to the read list: the narrowed push token reaches the proxy before the policy that makes the repo read-only", async () => {
    const moved = repo(8181);
    const kept = repo(8181);
    const { sandbox, ws } = await placed({ repos: [moved, kept] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    await sandboxStub(sandbox).setPolicy({ repos: [kept], read_repos: [moved] });
    const { secrets, policy } = await secretsThenPolicy(ws);
    const push = secrets.find((c) => c.type === "secrets_update").secrets.find((x: any) => x.binding === "github");
    const mint = gh.mints.find((m) => m.token === push.value)!;
    expect([mint.repositories, mint.permissions]).toEqual([[kept.split("/")[1]], SANDBOX_TOKEN_PERMISSIONS]);
    expect(policy.policy.guards.find((g: any) => g.name === "github-push").allow).toEqual([{ path: `/${kept}/**` }, { path: `/${kept}.git/**` }]);
  });

  it("an operator's own `github` binding never resolves to a push token nest minted before, once the repo is read-only", async () => {
    const x = repo(9191);
    const { sandbox, ws } = await placed({ repos: [x] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const minted = await runInDurableObject(broker, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = ?", `inject:github:${sandbox}`).one().n);
    expect(minted).toBe(1);
    await broker.putSecret("inject:github", "operator-static-value");
    await sandboxStub(sandbox).setPolicy({ inject: [githubBinding()], repos: [repo(9191)], read_repos: [x] });
    const { secrets } = await secretsThenPolicy(ws);
    expect(secrets.find((c) => c.type === "secrets_update").secrets.find((s: any) => s.binding === "github").value).toBe("operator-static-value");
    const left = await runInDurableObject(broker, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = ?", `inject:github:${sandbox}`).one().n);
    expect(left).toBe(0);
    await runInDurableObject(broker, async (_i, st) => { st.storage.sql.exec("DELETE FROM secrets WHERE name = 'inject:github'"); });
  });

  it("with a BrokerDO of the previous release (no readInjectionSecret): no token for the read-only repos, never a push token, retried in 2 minutes", async () => {
    const r = repo();
    const proto = BrokerDO.prototype as unknown as Record<string, unknown>;
    const method = proto.readInjectionSecret;
    delete proto.readInjectionSecret;
    const before = gh.mints.length;
    let sandbox: string;
    try {
      const p = await placed({ read_repos: [r] });
      sandbox = p.sandbox;
      const cmds = await nextCommands(p.ws, (c) => c.type === "secrets_update");
      expect(cmds.find((c) => c.type === "secrets_update").secrets).toEqual([]);
    } finally {
      proto.readInjectionSecret = method;
    }
    expect(gh.mints.slice(before).filter((m) => m.repositories.includes(r.split("/")[1]!))).toEqual([]);
    const at = await runInDurableObject(sandboxStub(sandbox), async (_i, st) => st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'inject_refresh'").one().at);
    expect(at).toBeGreaterThan(Date.now() + 60_000);
    expect(at).toBeLessThan(Date.now() + 3 * 60_000);
  });

  it("a sandbox stored before them (no read_repos in its layer, no agent_read_repos) reads as having none", async () => {
    const r = repo();
    const { sandbox, ws } = await placed({ repos: [r] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    const stub = sandboxStub(sandbox);
    const want = await stub.policy();
    await runInDurableObject(stub, async (_i, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'ws_layer'").one();
      const { read_repos: _, ...old } = JSON.parse(row.value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'ws_layer'", JSON.stringify(old));
      st.storage.sql.exec("DELETE FROM kv WHERE key = 'agent_read_repos'");
    });
    expect(await stub.repoAccess()).toEqual({ push: [r], read: [] });
    expect(await stub.policy()).toEqual(want);
    // Attaching an agent with none (as the previous AgentDO does) writes no read-only list.
    await stub.attach(`agt_${rand()}${rand()}${rand()}`, undefined, [r]);
    const stored = await runInDurableObject(stub, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM kv WHERE key = 'agent_read_repos'").one().n);
    expect(stored).toBe(0);
  });
});

// --- workflows: write, opt-in (docs/control-plane/api/clients/#workflow-files) -----------------------------------

describe("workflows: write on a sandbox's push token", () => {
  const WITH_WORKFLOWS = { contents: "write", pull_requests: "write", workflows: "write" };
  const catalog: Catalog = {
    capabilities: SEED_CATALOG.capabilities,
    templates: { ci: { ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands"], repos: ["me/app"], github_push: { workflows: true } } },
  };
  const expand = (by: "operator" | "spawner", overrides: Record<string, unknown> = {}) =>
    expandSpec(catalog, PLATFORM_TOOL_NAMES, { template: "ci", hands: true, by, overrides } as never);

  it("comes from the template; a spawner may only turn it off, the operator either way, and a client's grant must allow it", () => {
    expect((expand("operator") as any).value.github_push).toEqual({ workflows: true });
    expect((expand("spawner") as any).value.github_push).toEqual({ workflows: true });
    expect((expand("spawner", { github_push: { workflows: false } }) as any).value.github_push).toBeUndefined();
    expect(expand("spawner", { github_push: { workflows: true } }).ok).toBe(false);
    expect((expand("operator", { github_push: { workflows: false } }) as any).value.github_push).toBeUndefined();
    const { github_push: _, ...plain } = catalog.templates.ci!;
    const off = expandSpec({ ...catalog, templates: { ci: plain } }, PLATFORM_TOOL_NAMES, { template: "ci", hands: true, by: "operator" }) as any;
    expect("github_push" in off.value).toBe(false);
    const spec = (expand("operator") as any).value;
    expect(specOutsideGrant(spec, Grant.parse({ credentials: [spec.credential], repos: ["me/app"] }))).toEqual(["github_push.workflows"]);
    expect(specOutsideGrant(spec, Grant.parse({ credentials: [spec.credential], repos: ["me/app"], github_push: { workflows: true } }))).toEqual([]);
  });

  it("is minted exactly {contents, pull_requests, workflows: write} only when asked; the read-only token never has it", async () => {
    const pushable = repo(7171);
    const readable = repo(7171);
    const before = gh.mints.length;
    const { ws } = await placed({ repos: [pushable], read_repos: [readable], github_push: { workflows: true } });
    while (gh.mints.length < before + 2) await nextCommands(ws, (c) => c.type === "secrets_update");
    const mints = gh.mints.slice(before).map((m) => [m.repositories, m.permissions]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const want = [[[pushable.split("/")[1]], WITH_WORKFLOWS], [[readable.split("/")[1]], SANDBOX_READ_TOKEN_PERMISSIONS]];
    expect(mints).toEqual(want.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    // BrokerDO itself never puts it on a read-only token, whatever the source asks.
    const ro = repo();
    const b1 = gh.mints.length;
    await env.BROKER.get(env.BROKER.idFromName("broker")).readInjectionSecret({ sandbox: `sbx_${rand()}${rand()}`, epoch: 1 },
      { kind: "github_app", binding: "github_read", repos: [ro], workflows: true }, "test");
    expect(gh.mints.slice(b1).map((m) => m.permissions)).toEqual([SANDBOX_READ_TOKEN_PERMISSIONS]);
    // Without it: the push token as before.
    const plain = repo();
    const b2 = gh.mints.length;
    await nextCommands((await placed({ repos: [plain] })).ws, (c) => c.type === "secrets_update");
    expect(gh.mints.slice(b2).map((m) => m.permissions)).toEqual([SANDBOX_TOKEN_PERMISSIONS]);
  });

  it("a template asking for it reaches the token through the agent's spec and its attach (AgentDO, not a direct attach)", async () => {
    const r = repo(9191);
    const tpl = `ci-${rand()}`;
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: {
      capabilities: ["nest", "hands"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "required",
      credential: "claude_oauth_token", repos: [r], github_push: { workflows: true },
    } });
    const { sandbox, ws } = await placed({});
    const before = gh.mints.length;
    const a = await adminJson("/v1/agents", { body: { template: tpl, sandbox, start: false } }, 201);
    expect(a.github_push).toEqual({ workflows: true });
    while (!gh.mints.slice(before).length) await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.slice(before).map((m) => [m.repositories, m.permissions])).toEqual([[[r.split("/")[1]], WITH_WORKFLOWS]]);
  });

  it("a client gets it at sandbox create only within its grant's github_push", async () => {
    const cell = uniqueCell();
    const asClient = async (token: string, path: string, body: unknown, status: number) => {
      const res = await SELF.fetch(`http://cp.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      const text = await res.text();
      expect(res.status, text).toBe(status);
      return JSON.parse(text);
    };
    const mk = async (grant: Record<string, unknown>) => (await adminJson("/v1/admin/clients", { body: { name: `wf-${rand()}`, grant: { cells: [cell], max_sandboxes: 2, ...grant } } }, 201)).token as string;
    const without = await mk({});
    expect((await asClient(without, "/v1/sandboxes", { cell, github_push: { workflows: true } }, 403)).error.message).toContain("github_push.workflows");
    const withIt = await mk({ github_push: { workflows: true } });
    const sbx = await asClient(withIt, "/v1/sandboxes", { cell, github_push: { workflows: true } }, 202);
    expect(await sandboxStub(sbx.sandbox).pushWorkflows()).toBe(true);
    const plain = await asClient(withIt, "/v1/sandboxes", { cell }, 202);
    expect(await sandboxStub(plain.sandbox).pushWorkflows()).toBe(false);
  });

  it("a client's live layer turns it on and off: the next mint has it or not, the one with it revoked; within the grant only", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const call = async (token: string, method: string, path: string, body: unknown, status: number) => {
      const res = await SELF.fetch(`http://cp.test${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await res.text();
      expect(res.status, text).toBe(status);
      return text ? JSON.parse(text) : null;
    };
    const mk = async (grant: Record<string, unknown>) => (await adminJson("/v1/admin/clients", { body: { name: `wf-${rand()}`, grant: { cells: [cell], max_sandboxes: 2, ...grant } } }, 201)).token as string;
    const token = await mk({ github_push: { workflows: true } });
    const sbx = await call(token, "POST", "/v1/sandboxes", { cell }, 201);
    const layer = `/v1/sandboxes/${sbx.sandbox}/client-policy`;
    expect((await call(token, "GET", layer, undefined, 200)).github_push).toEqual({ workflows: false });
    // A push allowlist to mint for (an attached agent's repos).
    const r = repo(6161);
    const stub = sandboxStub(sbx.sandbox);
    await stub.attach(`agt_${rand()}${rand()}${rand()}`, undefined, [r]);
    while (gh.mints.at(-1)?.repositories[0] !== r.split("/")[1]) await nextCommands(h.ws, (c) => c.type === "secrets_update");
    const plain = gh.mints.at(-1)!;
    expect(plain.permissions).toEqual(SANDBOX_TOKEN_PERMISSIONS);
    // On, live: the next push carries a token with workflows: write.
    // The proxy's next set carrying the latest token (an earlier push may still be in the queue).
    const pushed = async () => {
      for (;;) {
        const cmds = await nextCommands(h.ws, (c) => c.type === "secrets_update");
        if (ghSecret(cmds)?.value === gh.mints.at(-1)!.token) return gh.mints.at(-1)!;
      }
    };
    await call(token, "PUT", layer, { github_push: { workflows: true } }, 200);
    const on = await pushed();
    expect(on.permissions).toEqual(WITH_WORKFLOWS);
    expect(await stub.pushWorkflows()).toBe(true);
    expect((await call(token, "GET", layer, undefined, 200)).github_push).toEqual({ workflows: true });
    expect(gh.revoked).not.toContain(on.token);
    // Off (here by leaving it out: the layer is replaced whole): the next token is without it, and the
    // one with it is revoked at GitHub, not left valid for its hour.
    // (GitHub's first answer to the revoke is lost: it's tried again.)
    gh.failRevokes = 1;
    await call(token, "PUT", layer, { env: { CI: "1" } }, 200);
    const off = await pushed();
    expect(off.permissions).toEqual(SANDBOX_TOKEN_PERMISSIONS);
    expect(off.token).not.toBe(on.token);
    expect(gh.revoked).toContain(on.token);
    expect(await stub.pushWorkflows()).toBe(false);
    // A client whose grant lacks it: refused (403) live, as at create; off still goes through.
    const without = await mk({});
    const other = await call(without, "POST", "/v1/sandboxes", { cell }, 201);
    const refused = await call(without, "PUT", `/v1/sandboxes/${other.sandbox}/client-policy`, { github_push: { workflows: true } }, 403);
    expect(refused.error.message).toContain("github_push.workflows");
    expect(await sandboxStub(other.sandbox).pushWorkflows()).toBe(false);
    await call(without, "PUT", `/v1/sandboxes/${other.sandbox}/client-policy`, { github_push: { workflows: false } }, 200);
  });

  it("an attached agent's spec asking for it adds it while attached, and never reuses a token without it", async () => {
    const r = repo(8181);
    const { sandbox, ws } = await placed({ repos: [r] });
    await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.at(-1)!.permissions).toEqual(SANDBOX_TOKEN_PERMISSIONS);
    const stub = sandboxStub(sandbox);
    const agent = `agt_${rand()}${rand()}${rand()}`;
    await stub.attach(agent, undefined, [], [], { workflows: true });
    let cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.at(-1)!.permissions).toEqual(WITH_WORKFLOWS);
    expect(ghSecret(cmds).value).toBe(gh.mints.at(-1)!.token);
    await stub.detach(agent);
    cmds = await nextCommands(ws, (c) => c.type === "secrets_update");
    expect(gh.mints.at(-1)!.permissions).toEqual(SANDBOX_TOKEN_PERMISSIONS);
    expect(ghSecret(cmds).value).toBe(gh.mints.at(-1)!.token);
  });
});
