// Owner-wide grant entries (docs/control-plane/api/clients/#owner-wide-entries): a client grant's
// `repos`, `read_repos` and `github.repos` may name `owner/*`, bound when the operator writes the grant
// to the account's numeric GitHub id, and matched at every check site by the id GitHub says owns the
// repo, never by its login. Templates, spawn specs and overrides still name exact repos. A fake GitHub
// (a fetch handler for https://api.github.com, as in client-github-token.test.ts) answers accounts,
// repos, installations and mints.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrokerDO } from "../src/do/broker";
import { capabilityOutsideGrant, Grant, githubTokenOutsideGrant, githubTokenOwners, inGrantList, ownerLookups, specOutsideGrant } from "../src/lib/clients";
import { OperatorOverrides, Template } from "../src/lib/spec";
import { bytesToB64 } from "../src/lib/util";
import { adminJson, BASE, eventually, uniqueCell } from "./helpers";

interface FakeRepo { owner: number; installation: number | null; public: boolean }

class FakeGitHub {
  /** login (lowercase) → account id, as GitHub has it now. */
  readonly accounts = new Map<string, number>();
  /** repo (lowercase `login/name`) → its owner's id, the App's installation on it, and whether it's public. */
  readonly repos = new Map<string, FakeRepo>();
  /** installation → the account it belongs to. */
  readonly installations = new Map<number, number>();
  readonly mints: { installation: number; repositories: string[] | null; permissions: Record<string, string>; token: string }[] = [];
  /** token → the installation it was minted for (for `GET /installation/repositories`); revoked ones. */
  readonly tokens = new Map<string, number>();
  readonly revoked: string[] = [];
  /** A login whose account answers (`/users/{login}`, its installation) name another login, as GitHub's could after a rename. */
  readonly loginOverride = new Map<string, string>();
  /** Repos whose lookups GitHub doesn't answer (502). */
  readonly down = new Set<string>();
  /** GitHub's unauthenticated reads answer 403 (its anonymous rate limit). */
  limitPublic = false;
  /** Repos GitHub answers with a redirect (moved), as for a renamed or transferred repo. */
  readonly moved = new Set<string>();
  /** Requests by path, to count lookups. */
  readonly asked: string[] = [];
  private n = 0;

  async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    this.asked.push(`${req.method} ${u.pathname}`);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const loginOf = (id: number) => {
      const login = [...this.accounts].find(([, i]) => i === id)?.[0] ?? `ghost-${id}`;
      return this.loginOverride.get(login) ?? login;
    };
    const authed = req.headers.has("authorization");
    if (!authed && this.limitPublic) return json(403, { message: "API rate limit exceeded" });
    let m: RegExpMatchArray | null;
    if ((m = u.pathname.match(/^\/users\/([^/]+)\/installation$/))) {
      const id = this.accounts.get(decodeURIComponent(m[1]!).toLowerCase());
      const inst = id === undefined ? undefined : [...this.installations].find(([, a]) => a === id)?.[0];
      return inst !== undefined && authed ? json(200, { id: inst, account: { id, login: loginOf(id!) } }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/users\/([^/]+)$/))) {
      const login = decodeURIComponent(m[1]!).toLowerCase();
      const id = this.accounts.get(login);
      return id !== undefined ? json(200, { id, login: this.loginOverride.get(login) ?? login, type: "User" }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/installation)?$/)) && this.down.has(m[1]!.toLowerCase())) {
      return json(502, { message: "Bad Gateway" });
    }
    if ((m = u.pathname.match(/^\/user\/(\d+)$/))) {
      const id = Number(m[1]);
      return [...this.accounts.values()].includes(id) ? json(200, { id, login: loginOf(id) }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/installation)?$/)) && this.moved.has(m[1]!.toLowerCase())) {
      return json(301, { message: "Moved Permanently", url: "https://api.github.com/repositories/1" });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/installation$/))) {
      const r = this.repos.get(m[1]!.toLowerCase());
      return r?.installation != null && authed ? json(200, { id: r.installation, account: { id: r.owner, login: loginOf(r.owner) } }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)$/))) {
      const r = this.repos.get(m[1]!.toLowerCase());
      return r?.public ? json(200, { full_name: m[1], owner: { id: r.owner, login: loginOf(r.owner) } }) : json(404, { message: "Not Found" });
    }
    if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)) && req.method === "POST") {
      const body = await req.json() as { repositories?: string[]; permissions: Record<string, string> };
      const installation = Number(m[1]);
      const ok = (body.repositories ?? []).every((name) => [...this.repos].some(([r, f]) => f.installation === installation && r.endsWith(`/${name.toLowerCase()}`)));
      if (!ok) return json(422, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
      const token = `ghs_own${String(++this.n).padStart(30, "0")}`;
      this.mints.push({ installation, repositories: body.repositories ?? null, permissions: body.permissions, token });
      this.tokens.set(token, installation);
      return json(201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    }
    if (u.pathname === "/app/installations" && req.method === "GET") {
      const page = Number(u.searchParams.get("page") ?? "1");
      const all = [...this.installations].map(([id, account]) => ({ id, account: { id: account, login: loginOf(account) } }));
      return json(200, all.slice((page - 1) * 100, page * 100));
    }
    if (u.pathname === "/installation/repositories" && req.method === "GET") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const inst = this.tokens.get(token);
      if (inst === undefined || this.revoked.includes(token)) return json(401, { message: "Bad credentials" });
      const page = Number(u.searchParams.get("page") ?? "1");
      const all = [...this.repos].filter(([, f]) => f.installation === inst).map(([r, f]) => ({ full_name: r, owner: { id: f.owner, login: loginOf(f.owner) } }));
      return json(200, { total_count: all.length, repositories: all.slice((page - 1) * 100, page * 100) });
    }
    if (u.pathname === "/installation/token" && req.method === "DELETE") {
      this.revoked.push((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
      return new Response(null, { status: 204 });
    }
    if (u.pathname === "/app") return json(200, { id: 4242, slug: "nest-test-app" });
    return json(404, { message: "Not Found" });
  }
}

const gh = new FakeGitHub();
const realFetch = globalThis.fetch;
beforeAll(async () => {
  const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
  const have = await runInDurableObject(broker, async (_i, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM secrets WHERE name = 'github_app'").one().n);
  if (!have) {
    const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]) as CryptoKeyPair;
    const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey) as ArrayBuffer);
    const armor = (edge: "BEGIN" | "END") => `-----${edge} ${"PRIVATE KEY"}-----`;
    const pem = [armor("BEGIN"), ...bytesToB64(der).match(/.{1,64}/g)!, armor("END"), ""].join("\n");
    await adminJson("/v1/admin/secrets/github_app", { method: "PUT", body: { value: JSON.stringify({ app_id: "77", private_key: pem }) } });
  }
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    return new URL(req.url).hostname === "api.github.com" ? gh.handle(req) : realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
let nextId = 5_000_000;

/** A fresh GitHub account (unique login and id) with the App installed on it, and `names` repos under it. */
function account(names: string[] = ["app"], opts: { installed?: boolean; public?: boolean } = {}) {
  const login = `own${rand()}`;
  const id = ++nextId;
  gh.accounts.set(login, id);
  const installation = opts.installed === false ? null : ++nextId;
  if (installation !== null) gh.installations.set(installation, id);
  for (const n of names) gh.repos.set(`${login}/${n}`, { owner: id, installation, public: opts.public ?? false });
  return { login, id, installation, repo: (n: string) => `${login}/${n}` };
}

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<any> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await res.text();
  expect(res.status, `${path}: ${text}`).toBe(status);
  return JSON.parse(text);
}

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const basic = (extra: Record<string, unknown> = {}) => ({ capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token", ...extra });

async function newClient(grant: Record<string, unknown>) {
  const cell = uniqueCell();
  const name = `og-${rand()}`;
  const g = { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 10, max_sandboxes: 10, ...grant };
  const c = await adminJson("/v1/admin/clients", { body: { name, grant: g } }, 201);
  return { id: c.client as string, name, token: c.token as string, cell, grant: c.grant };
}

const putTemplate = (c: { token: string; name: string }, entry: string, body: Record<string, unknown>, status = 200) =>
  as(c.token, `/v1/catalog/templates/${c.name}/${entry}`, { method: "PUT", body: basic(body) }, status);

// --- Pure --------------------------------------------------------------------------------------------------

describe("matching (pure)", () => {
  const grant = Grant.parse({ repos: ["Acme/*", "solo/app"], read_repos: ["docs/*"], github: { repos: ["acme/*"], permissions: { checks: "write" } }, repo_owners: { acme: 11, docs: 22 } });

  it("an exact entry matches by name; an owner-wide one only by the owner id GitHub gave, never by login", () => {
    expect(inGrantList("Solo/App", grant.repos, grant)).toBe(true);
    // Under acme/* by name, but no answer from GitHub: not in.
    expect(inGrantList("acme/x", grant.repos, grant)).toBe(false);
    expect(inGrantList("acme/x", grant.repos, grant, { "acme/x": 11 })).toBe(true);
    // Same login, another account (a renamed and re-registered login): not in.
    expect(inGrantList("acme/x", grant.repos, grant, { "acme/x": 99 })).toBe(false);
    // Another login, the same account (the owner renamed itself): in, by id.
    expect(inGrantList("acme-renamed/x", grant.repos, grant, { "acme-renamed/x": 11 })).toBe(true);
    expect(inGrantList("acme/x", grant.repos, grant, { "acme/x": null })).toBe(false);
    // An entry whose login has no id matches nothing.
    const unbound = Grant.parse({ repos: ["acme/*"] });
    expect(inGrantList("acme/x", unbound.repos, unbound, { "acme/x": 11 })).toBe(false);
  });

  it("each check site takes the answer: push, read, brokered (unscoped stays outside), tokens", () => {
    const spec = (s: Record<string, unknown>) => ({ credential: "c", ...s }) as never;
    const g = { ...grant, credentials: ["c"] };
    const owners = { "acme/x": 11, "docs/guide": 22, "evil/x": 99 };
    expect(specOutsideGrant(spec({ repos: ["acme/x"] }), g, owners)).toEqual([]);
    expect(specOutsideGrant(spec({ repos: ["evil/x"] }), g, owners)).toEqual(["repos evil/x"]);
    // A read-only owner-wide entry reads, never pushes.
    expect(specOutsideGrant(spec({ read_repos: ["docs/guide"] }), g, owners)).toEqual([]);
    expect(specOutsideGrant(spec({ repos: ["docs/guide"] }), g, owners)).toEqual(["repos docs/guide"]);
    const gb = (repos: string[] | null) => ({ capability: "b", action: "github.comment", repos, when_tainted: "allow", per_hour: 30 }) as never;
    expect(specOutsideGrant(spec({ brokered: [gb(["acme/x"])] }), g, owners)).toEqual([]);
    expect(specOutsideGrant(spec({ brokered: [gb(["evil/x"])] }), g, owners)).toHaveLength(1);
    // An owner-wide entry is still one account's repos: an unscoped action stays outside.
    expect(specOutsideGrant(spec({ brokered: [gb(null)] }), g, owners)[0]).toContain("on any repo");
    expect(capabilityOutsideGrant("b", { brokered: [{ action: "github.comment", repos: ["acme/x"] }] } as never, g, owners)).toEqual([]);
    expect(capabilityOutsideGrant("b", { brokered: [{ action: "github.comment" }] } as never, g, owners)).toHaveLength(1);
    // Tokens: exact is settled here; under an owner-wide entry, the mint confirms the accounts named.
    const req = (repo: string) => ({ repo, permissions: { checks: "read" } }) as never;
    expect(githubTokenOwners(req("acme/x"), g)).toEqual([11]);
    expect(githubTokenOutsideGrant(req("acme/x"), g)).toEqual([]);
    // A repo not named exactly under a grant with owner-wide entries is the mint's to confirm; without any, it's outside here.
    expect(githubTokenOutsideGrant(req("solo/app"), g)).toEqual([]);
    expect(githubTokenOutsideGrant(req("solo/app"), Grant.parse({ github: { repos: ["acme/app"], permissions: { checks: "write" } } }))).toEqual(["github repo solo/app"]);
    // Only what a list with an owner-wide entry doesn't name exactly is looked up (solo/app: not in
    // github.repos, which has acme/*), and nothing for a grant of exact entries.
    expect(ownerLookups(g, ["Solo/App", "acme/x"])).toEqual(["acme/x", "solo/app"]);
    expect(ownerLookups(Grant.parse({ repos: ["acme/*", "solo/app"], repo_owners: { acme: 11 } }), ["Solo/App", "acme/x"])).toEqual(["acme/x"]);
    expect(ownerLookups({ ...Grant.parse({ repos: ["solo/app"] }) }, ["acme/x"])).toEqual([]);
    // Named exactly in one list but possibly in another only by its owner: looked up.
    const mixed = Grant.parse({ repos: ["acme/*"], github: { repos: ["acme/x"], permissions: {} }, repo_owners: { acme: 11 } });
    expect(ownerLookups(mixed, ["acme/x"])).toEqual(["acme/x"]);
  });

  it("owner-wide entries are the grant's only: templates, spawn specs and overrides name exact repos", () => {
    expect(Grant.safeParse({ repos: ["acme/*"] }).success).toBe(true);
    expect(Grant.safeParse({ repos: ["*/*"] }).success).toBe(false);
    expect(Grant.safeParse({ repos: ["acme/app*"] }).success).toBe(false);
    for (const field of ["repos", "read_repos"]) {
      expect(Template.safeParse(basic({ [field]: ["acme/*"] })).success, `template ${field}`).toBe(false);
      expect(OperatorOverrides.safeParse({ [field]: ["acme/*"] }).success, `overrides ${field}`).toBe(false);
    }
  });
});

// --- Through the API -----------------------------------------------------------------------------------

describe("writing a grant", () => {
  it("binds each owner-wide login to its account id, keeps it while the entry stays, and refuses one GitHub can't resolve", async () => {
    const a = account();
    const c = await newClient({ repos: [`${a.login}/*`] });
    expect(c.grant.repo_owners).toEqual({ [a.login]: a.id });
    expect((await as(c.token, "/v1/clients/self")).grant).toMatchObject({ repos: [`${a.login}/*`], repo_owners: { [a.login]: a.id } });
    // The login is renamed away and registered again by another account: a PATCH keeps the stored id.
    gh.accounts.set(a.login, 777_000_001);
    const kept = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], credentials: ["claude_oauth_token"], repos: [`${a.login}/*`], max_agents: 3 } } });
    expect(kept.grant.repo_owners).toEqual({ [a.login]: a.id });
    // An id the request sends is ignored.
    const sent = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], repos: [`${a.login}/*`], repo_owners: { [a.login]: 1 } } } });
    expect(sent.grant.repo_owners).toEqual({ [a.login]: a.id });
    // No such account: refused, nothing saved.
    const none = `nobody${rand()}`;
    const res = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], repos: [`${none}/*`] } } }, 409);
    expect(res.error.message).toContain(none);
    expect((await adminJson(`/v1/admin/clients/${c.id}`)).grant.repos).toEqual([`${a.login}/*`]);
    // Dropped, then written again: resolved afresh (now to the account that holds the login).
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell] } } });
    const again = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], read_repos: [`${a.login}/*`] } } });
    expect(again.grant.repo_owners).toEqual({ [a.login]: 777_000_001 });
  });

  it("an account answer for another login is refused: the id is bound only to the login GitHub names", async () => {
    const a = account();
    // GitHub's answer for the login names a different account (as a lookup that followed a rename could).
    gh.loginOverride.set(a.login, `someone${rand()}`);
    const cell = uniqueCell();
    const res = await adminJson("/v1/admin/clients", { body: { name: `og-${rand()}`, grant: { cells: [cell], repos: [`${a.login}/*`] } } }, 409);
    expect(res.error.message).toContain(a.login);
    gh.loginOverride.delete(a.login);
  });

  it("a spec naming more repos than BrokerDO looks up at once is checked whole, in batches", async () => {
    const names = Array.from({ length: 101 }, (_, i) => `r${i}`);
    const a = account(names);
    const c = await newClient({ repos: [`${a.login}/*`] });
    await putTemplate(c, "many", { read_repos: names.slice(0, 100).map((n) => a.repo(n)), repos: [a.repo("r100")] });
  });

  it("the public profile's answer is held to the login too: an account the App isn't on, answered as another login, is refused", async () => {
    const a = account(["app"], { installed: false, public: true });
    gh.loginOverride.set(a.login, `someone${rand()}`);
    await adminJson("/v1/admin/clients", { body: { name: `og-${rand()}`, grant: { cells: [uniqueCell()], read_repos: [`${a.login}/*`] } } }, 409);
    gh.loginOverride.delete(a.login);
    const c = await newClient({ read_repos: [`${a.login}/*`] });
    expect(c.grant.repo_owners).toEqual({ [a.login]: a.id });
  });

  it("an id the operator sends for a new login is dropped: GitHub's is stored, and the answer shows it", async () => {
    const a = account();
    const c = await newClient({ repos: [`${a.login}/*`], repo_owners: { [a.login]: 1 } });
    expect(c.grant.repo_owners).toEqual({ [a.login]: a.id });
    const b = account();
    const patched = await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], repos: [`${a.login}/*`, `${b.login}/*`], repo_owners: { [b.login]: 2 } } } });
    expect(patched.grant.repo_owners).toEqual({ [a.login]: a.id, [b.login]: b.id });
  });

  it("GitHub's anonymous limit hit while resolving a login says so (503, retry later), not that there's no such account", async () => {
    const a = account([], { installed: false });
    gh.limitPublic = true;
    try {
      const res = await adminJson("/v1/admin/clients", { body: { name: `og-${rand()}`, grant: { cells: [uniqueCell()], repos: [`${a.login}/*`] } } }, 503);
      expect(res.error).toMatchObject({ retryable: true });
      expect(res.error.message).toContain("try again later");
    } finally {
      gh.limitPublic = false;
    }
  });

  it("a grant of exact entries asks GitHub nothing", async () => {
    const before = gh.asked.length;
    const c = await newClient({ repos: ["acme/app"] });
    expect(c.grant.repo_owners).toBeUndefined();
    await putTemplate(c, "p", { repos: ["acme/app"] });
    expect(gh.asked.length).toBe(before);
  });
});

describe("the check sites", () => {
  it("templates and spawns: a repo of the bound account is in (push or read as granted); another owner's isn't; the spec stays exact", async () => {
    const a = account(["app", "lib"]);
    const d = account(["guide"], { installed: false, public: true });
    const other = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`], read_repos: [`${d.login}/*`] });
    // Push to the bound account's repo; read the read-only account's public repo (the App isn't on it).
    await putTemplate(c, "w", { repos: [a.repo("app")], read_repos: [d.repo("guide")] });
    // Push to a read-only account's repo: refused. Another account's repo: refused.
    expect((await putTemplate(c, "x", { repos: [d.repo("guide")] }, 403)).error.message).toContain(`repos ${d.repo("guide")}`);
    expect((await putTemplate(c, "y", { repos: [other.repo("app")] }, 403)).error.message).toContain(`repos ${other.repo("app")}`);
    // A repo no one can confirm (not found): refused.
    expect((await putTemplate(c, "z", { repos: [`${a.login}/nope`] }, 403)).error.message).toContain("nope");
    // An owner-wide entry in a template: 400, never a widening.
    await putTemplate(c, "star", { repos: [`${a.login}/*`] }, 400);
    // Spawned: exactly the repos named; an override narrows within the grant, and can't name a wildcard.
    const agent = await as(c.token, "/v1/agents", { body: { template: `${c.name}/w`, cell: c.cell, start: false, overrides: { repos: [a.repo("app")] } } }, 201);
    expect(agent.repos).toEqual([a.repo("app")]);
    await as(c.token, "/v1/agents", { body: { template: `${c.name}/w`, cell: c.cell, start: false, overrides: { repos: [`${a.login}/*`] } } }, 400);
  });

  it("a renamed owner: the same login now held by another account matches nothing", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`], github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    // The account renames away; someone else registers the login and a repo with the same name.
    const thief = ++nextId;
    const thiefInst = ++nextId;
    gh.accounts.set(a.login, thief);
    gh.installations.set(thiefInst, thief);
    gh.repos.set(a.repo("evil"), { owner: thief, installation: thiefInst, public: true });
    expect((await putTemplate(c, "t", { repos: [a.repo("evil")] }, 403)).error.message).toContain(`repos ${a.repo("evil")}`);
    const res = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("evil"), permissions: { contents: "read" } } }, 403);
    expect(res.error.message).toContain(a.repo("evil"));
    expect(gh.mints.filter((m) => m.installation === thiefInst)).toEqual([]);
    expect((await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("evil")] } })).repos)
      .toEqual([{ repo: a.repo("evil"), push: false, read: false, github: false }]);
  });

  it("names under no bound account's login cost GitHub nothing; a renamed account is followed by its id", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`], github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    // Warm: the bound account's login is learned once.
    await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } });
    const before = gh.asked.length;
    const random = Array.from({ length: 100 }, () => `x${rand()}/y${rand()}`);
    const r = await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: random } });
    expect(r.repos.every((x: { push: boolean }) => !x.push)).toBe(true);
    await putTemplate(c, "rnd", { repos: random.slice(0, 5) }, 403);
    const t = await as(c.token, "/v1/clients/self/github-token", { body: { repo: random[0], permissions: { contents: "read" } } }, 403);
    expect(t.error.message).toContain("outside");
    expect(gh.asked.length).toBe(before);
    // The account renames itself: its login is learned again once the kept one is past its time, and its repos match under the new login.
    const renamed = `ren${rand()}`;
    gh.accounts.delete(a.login);
    gh.accounts.set(renamed, a.id);
    gh.repos.set(`${renamed}/app`, { owner: a.id, installation: a.installation, public: false });
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_account_logins SET fetched_ms = 0 WHERE account_id = ?", a.id);
    });
    expect((await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [`${renamed}/app`] } })).repos[0]).toMatchObject({ push: true });
  });

  it("a client past its hourly budget of owner lookups is refused (429, retryable) and GitHub isn't asked", async () => {
    const a = account(["app", "lib"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } });
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_lookup_budget SET used = 600 WHERE client = ?", c.id);
    });
    const before = gh.asked.length;
    const res = await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("lib")] } }, 429);
    expect(res.error).toMatchObject({ code: "rate_limited", retryable: true });
    expect(gh.asked.length).toBe(before);
    // Another client's budget is its own.
    const other = await newClient({ repos: [`${a.login}/*`] });
    expect((await as(other.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("lib")] } })).repos[0]).toMatchObject({ push: true });
  });

  it("a login taken over while nest still holds the old owner's login: the mint's fresh lookup refuses the new owner's repo", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    // nest learns the bound account's login (kept a few minutes).
    await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } });
    // Within that window the account renames away and another takes its login, with nest's App on it.
    const thief = ++nextId;
    const thiefInst = ++nextId;
    gh.accounts.set(a.login, thief);
    gh.installations.set(thiefInst, thief);
    gh.repos.set(a.repo("evil"), { owner: thief, installation: thiefInst, public: true });
    const mints = gh.mints.length;
    await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("evil"), permissions: { contents: "read" } } }, 403);
    expect(gh.mints.length).toBe(mints);
  });

  it("the budget is an hour's: past the hour, lookups go on again", async () => {
    const a = account(["app", "lib"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } });
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await runInDurableObject(broker, (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_lookup_budget SET used = 600, window_ms = ? WHERE client = ?", Date.now() - 3_600_001, c.id);
    });
    expect((await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("lib")] } })).repos[0]).toMatchObject({ push: true });
    expect(await runInDurableObject(broker, (_i: BrokerDO, st) =>
      st.storage.sql.exec<{ used: number }>("SELECT used FROM github_lookup_budget WHERE client = ?", c.id).one().used)).toBe(1);
  });

  it("a token's fresh owner lookup spends the client's budget: past it, 429 and nothing minted", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read", metadata: "read" } } });
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const used = () => runInDurableObject(broker, (_i: BrokerDO, st) =>
      st.storage.sql.exec<{ used: number }>("SELECT used FROM github_lookup_budget WHERE client = ?", c.id).toArray()[0]?.used ?? 0);
    // Learn the login first (it spends too), then count the mint's own lookup.
    await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } });
    const before = await used();
    await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } });
    expect(await used()).toBe(before + 1);
    // A second permission set: a new mint, a new lookup; at the limit, refused before it.
    await runInDurableObject(broker, (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_lookup_budget SET used = 600 WHERE client = ?", c.id);
    });
    const mints = gh.mints.length;
    const res = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { metadata: "read" } } }, 429);
    expect(res.error).toMatchObject({ retryable: true });
    expect(gh.mints.length).toBe(mints);
  });

  it("an account's login is found past the first page of the App's installations; one GitHub can't give is asked again within a minute", async () => {
    // A hundred installations ahead of the one that matters.
    for (let k = 0; k < 100; k++) account([]);
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    // Only the App's answer can say it (the anonymous profile is rate limited).
    gh.limitPublic = true;
    try {
      expect((await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } })).repos[0]).toMatchObject({ push: true });
    } finally {
      gh.limitPublic = false;
    }
    // An account GitHub can't name now: its row is a miss, kept a minute, not five.
    const b = account(["x"], { installed: false, public: true });
    const cb = await newClient({ repos: [`${b.login}/*`] });
    gh.accounts.delete(b.login);
    expect((await as(cb.token, "/v1/clients/self/grant/repos", { body: { repos: [b.repo("x")] } })).repos[0]).toMatchObject({ push: false });
    gh.accounts.set(b.login, b.id);
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_account_logins SET fetched_ms = ? WHERE account_id = ?", Date.now() - 61_000, b.id);
    });
    expect((await as(cb.token, "/v1/clients/self/grant/repos", { body: { repos: [b.repo("x")] } })).repos[0]).toMatchObject({ push: true });
  });

  it("GitHub not answering at the token route is a retryable 503, not the 403 of a repo the grant doesn't cover", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    gh.down.add(a.repo("app"));
    try {
      const res = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } }, 503);
      expect(res.error).toMatchObject({ retryable: true });
      expect(res.error.message).not.toMatch(/502|Bad Gateway/);
    } finally {
      gh.down.delete(a.repo("app"));
    }
    expect((await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } })).token).toBeTruthy();
  });

  it("all clients together are held to one hourly cap: past it, 429 for everyone, and GitHub isn't asked", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await runInDurableObject(broker, (_i: BrokerDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO github_lookup_budget (client, window_ms, used) VALUES ('*', ?, 2000)", Date.now());
    });
    const before = gh.asked.length;
    try {
      const res = await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app")] } }, 429);
      expect(res.error.message).toContain("all clients");
      expect(gh.asked.length).toBe(before);
    } finally {
      await runInDurableObject(broker, (_i: BrokerDO, st) => {
        st.storage.sql.exec("DELETE FROM github_lookup_budget WHERE client = '*'");
      });
    }
  });

  it("a listing is charged for every GitHub call it makes", async () => {
    const a = account(["app", "lib"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    const used = () => runInDurableObject(broker, (_i: BrokerDO, st) =>
      st.storage.sql.exec<{ used: number }>("SELECT used FROM github_lookup_budget WHERE client = ?", c.id).toArray()[0]?.used ?? 0);
    const before = await used();
    const asked = gh.asked.length;
    await as(c.token, "/v1/clients/self/grant/repos");
    const all = () => runInDurableObject(broker, (_i: BrokerDO, st) =>
      st.storage.sql.exec<{ used: number }>("SELECT used FROM github_lookup_budget WHERE client = '*'").toArray()[0]?.used ?? 0);
    // The installations' pages, the mint, the listing's page and the revoke: each one counted, to the client and to all clients.
    const calls = gh.asked.length - asked;
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(await used()).toBe(before + calls);
    const allBefore = await all();
    await runInDurableObject(broker, (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_account_repos SET fetched_ms = 0");
    });
    const asked2 = gh.asked.length;
    await as(c.token, "/v1/clients/self/grant/repos");
    expect(await all()).toBe(allBefore + (gh.asked.length - asked2));
  });

  it("a token for a moved repo, or one not found, answers the same 403 as a name outside the grant", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    gh.moved.add(a.repo("old"));
    const moved = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("old"), permissions: { contents: "read" } } }, 403);
    const missing = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("nope"), permissions: { contents: "read" } } }, 403);
    const strip = (e: { error: { message: string } }, repo: string) => e.error.message.replace(repo, "R");
    expect(strip(moved, a.repo("old"))).toBe(strip(missing, a.repo("nope")));
    expect(moved.error.message).not.toMatch(/301|Moved/i);
  });

  it("tokens: minted from the bound account's installation by GitHub's answer; a cached one only while that holds", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    const t = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } });
    expect(t.installation_id).toBe(a.installation);
    expect(gh.mints.at(-1)).toMatchObject({ installation: a.installation, repositories: ["app"] });
    // Cached: served again without a mint.
    const mints = gh.mints.length;
    expect((await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } })).token).toBe(t.token);
    expect(gh.mints.length).toBe(mints);
    // A repo the bound account doesn't own: refused (403), nothing minted.
    const other = account(["app"]);
    await as(c.token, "/v1/clients/self/github-token", { body: { repo: other.repo("app"), permissions: { contents: "read" } } }, 403);
    expect(gh.mints.length).toBe(mints);
    // The grant now binds another account only: the cached token, from the first account's installation, isn't served.
    await adminJson(`/v1/admin/clients/${c.id}`, { method: "PATCH", body: { grant: { cells: [c.cell], github: { repos: [`${other.login}/*`], permissions: { contents: "read" } } } } });
    const res = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } }, 403);
    expect(JSON.stringify(res)).not.toContain(t.token);
    expect(gh.mints.length).toBe(mints);
  });

  it("a BrokerDO of the previous release (no owner-checked mint) refuses: 503, nothing minted, never a mint for any repo", async () => {
    const a = account(["app"]);
    const c = await newClient({ github: { repos: [`${a.login}/*`], permissions: { contents: "read" } } });
    const proto = BrokerDO.prototype as unknown as Record<string, unknown>;
    const method = proto.clientGithubTokenOwned;
    delete proto.clientGithubTokenOwned;
    const mints = gh.mints.length;
    try {
      const e = await as(c.token, "/v1/clients/self/github-token", { body: { repo: a.repo("app"), permissions: { contents: "read" } } }, 503);
      expect(e.error).toMatchObject({ retryable: true });
    } finally {
      proto.clientGithubTokenOwned = method;
    }
    expect(gh.mints.length).toBe(mints);
  });

  it("GET-free membership: nest answers which repos the grant covers, by list", async () => {
    const a = account(["app"]);
    const d = account(["guide"]);
    const c = await newClient({ repos: [`${a.login}/*`, "solo/app"], read_repos: [`${d.login}/*`], github: { repos: [a.repo("app")], permissions: { contents: "read" } } });
    const r = await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [a.repo("app"), d.repo("guide"), "Solo/App", `${a.login}/nope`] } });
    expect(r.repos).toEqual([
      { repo: a.repo("app"), push: true, read: true, github: true },
      { repo: `${a.login}/nope`, push: false, read: false, github: false },
      { repo: d.repo("guide"), push: false, read: true, github: false },
      { repo: "solo/app", push: true, read: true, github: false },
    ].sort((x, y) => (x.repo < y.repo ? -1 : 1)));
    await as(c.token, "/v1/clients/self/grant/repos", { body: { repos: [`${a.login}/*`] } }, 400);
  });

  it("lists what the grant covers: exact entries, and each owner-wide account's installation repos, with no token handed out", async () => {
    const a = account(["app", "lib"]);
    const d = account(["guide"], { installed: false, public: true });
    const c = await newClient({ repos: [`${a.login}/*`, "Solo/App"], read_repos: [`${d.login}/*`], github: { repos: [a.repo("app")], permissions: { contents: "read" } } });
    // Another account's repo in the same fake: never listed; nor one the installation's answer says another account owns.
    const other = account(["app"]);
    gh.repos.set(`${a.login}/foreign`, { owner: other.id, installation: a.installation, public: false });
    const r = await as(c.token, "/v1/clients/self/grant/repos");
    expect(r).toEqual({
      repos: [
        { repo: a.repo("app"), push: true, read: true, github: true },
        { repo: a.repo("lib"), push: true, read: true, github: false },
        { repo: "solo/app", push: true, read: true, github: false },
      ],
      // The App isn't on d: its repos can't be listed (a POST answers for one by name).
      unlisted: [`${d.login}/*`], complete: true,
    });
    // Read with a whole-installation token for metadata only, never answered, revoked after.
    const listing = gh.mints.find((m) => m.installation === a.installation && m.repositories === null)!;
    expect(listing.permissions).toEqual({ metadata: "read" });
    expect(JSON.stringify(r)).not.toContain(listing.token);
    await eventually("the listing token revoked", () => gh.revoked.includes(listing.token));
    // Kept a few minutes: asked again, nothing new is minted.
    const mints = gh.mints.length;
    await as(c.token, "/v1/clients/self/grant/repos");
    expect(gh.mints.length).toBe(mints);
  });

  it("the listing token is audited as covering the whole installation, and revoked even when its audit can't be written", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    const proto = BrokerDO.prototype as unknown as { auditMint: (r: Record<string, unknown>) => Promise<void> };
    const real = proto.auditMint;
    const records: Record<string, unknown>[] = [];
    const listed = () => gh.asked.filter((p) => p === "GET /installation/repositories").length;
    const before = listed();
    proto.auditMint = async function (this: unknown, r: Record<string, unknown>) {
      records.push(r);
      throw new Error("R2 unavailable");
    };
    try {
      await as(c.token, "/v1/clients/self/grant/repos", {}, 500);
    } finally {
      proto.auditMint = real;
    }
    const listing = gh.mints.find((m) => m.installation === a.installation && m.repositories === null)!;
    expect(records.at(-1)).toMatchObject({ all_repos: true, installation: a.installation, permissions: { metadata: "read" } });
    expect(records.at(-1)).not.toHaveProperty("repos");
    // Never used to list, and revoked.
    expect(listed()).toBe(before);
    await eventually("the token revoked", () => gh.revoked.includes(listing.token));
  });

  it("a brokered capability a client writes: scoped to the bound account's repos is in, unscoped isn't", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    await as(c.token, `/v1/catalog/capabilities/${c.name}/gh`, { method: "PUT", body: { tools: [], brokered: [{ action: "github.comment", repos: [a.repo("app")] }] } });
    expect((await as(c.token, `/v1/catalog/capabilities/${c.name}/gh2`, { method: "PUT", body: { tools: [], brokered: [{ action: "github.comment" }] } }, 403)).error.message)
      .toContain("on any repo");
    await as(c.token, `/v1/catalog/capabilities/${c.name}/gh3`, { method: "PUT", body: { tools: [], brokered: [{ action: "github.comment", repos: [`${a.login}/*`] }] } }, 400);
  });

  it("GitHub's answer is kept a few minutes, so repeated checks don't ask again", async () => {
    const a = account(["app"]);
    const c = await newClient({ repos: [`${a.login}/*`] });
    await putTemplate(c, "one", { repos: [a.repo("app")] });
    const asked = gh.asked.filter((p) => p.includes(a.login)).length;
    await putTemplate(c, "two", { repos: [a.repo("app")] });
    expect(gh.asked.filter((p) => p.includes(a.login)).length).toBe(asked);
    // Past its time, asked again.
    await runInDurableObject(env.BROKER.get(env.BROKER.idFromName("broker")), (_i: BrokerDO, st) => {
      st.storage.sql.exec("UPDATE github_repo_owners SET fetched_ms = 0 WHERE repo = ?", a.repo("app"));
    });
    await putTemplate(c, "three", { repos: [a.repo("app")] });
    expect(gh.asked.filter((p) => p.includes(a.login)).length).toBeGreaterThan(asked);
  });
});
