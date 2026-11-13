// The project's own GitHub access in its agents' sandboxes (README.md#repo-authority, phase B3): per-project
// push and read tokens minted from the app's own GitHub App, written to nest as client secrets with their
// expiry and written again before it; per role, a binding of one of them, the environment git and gh read,
// the GitHub hosts, and the app's own guards in the spawn; never nest's repos. The pure parts first, against
// literal values.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pushFixture from "../../protocol/fixtures/control/egress_policy/egress_policy.app_github_push.json";
import readFixture from "../../protocol/fixtures/control/egress_policy/egress_policy.app_github_read.json";
import { resetAccessKeys } from "../src/access";
import {
  CREDENTIAL_HELPER, githubAccess, githubGrantMissing, githubGuards, githubPermissions, githubSecretName, REFRESH_BEFORE_MS, spawnOverrides, startEgress,
} from "../src/github-access";
import { clientLayerFor, NO_RULES, shrinkLayer } from "../src/network";
import { HOSTS_WAIT } from "../src/nest";
import { secretFeeds, secretProblems } from "../src/secrets";
import { AccessTeam, api, CLIENT, deliverGithub, eventually, FakeNest, GH_INSTALLATION_ID, installFetch, prEvent } from "./fake-nest";

describe("the access (pure)", () => {
  it("a worker's push access: its binding on both GitHub hosts, GH_TOKEN and git's helper, the GitHub hosts within the grant", () => {
    const a = githubAccess({ client: "cli_x", project: "prj_1", repo: "Owner/Repo", role: "worker", egressHosts: ["api.github.com", "*.githubusercontent.com", "npmjs.org"] });
    expect(a.kind).toBe("push");
    expect(a.inject).toEqual({ name: "gh_push", secret: "gh-push-prj_1", hosts: ["github.com", "api.github.com"], locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password" }] });
    expect(a.env).toEqual({
      GH_TOKEN: "nest-ph.cli_x.gh_push.",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_1: `!f() { test "$1" = get || return 0; echo username=x-access-token; echo "password=$GH_TOKEN"; }; f`,
    });
    // github.com isn't in this grant: nest's base layer opens it, or it stays closed.
    expect(a.egress).toEqual([{ host: "api.github.com" }, { host: "*.githubusercontent.com" }]);
    // The helper never holds the placeholder: nest refuses a variable holding one that isn't exactly a binding's.
    expect(CREDENTIAL_HELPER).not.toContain("nest-ph.");
  });

  it("every other role reads: the read token's binding and placeholder", () => {
    for (const role of ["manager", "reviewer", "routine"] as const) {
      const a = githubAccess({ client: "cli_x", project: "prj_1", repo: "o/r", role, egressHosts: [] });
      expect(a.kind, role).toBe("read");
      expect(a.inject.name, role).toBe("gh_read");
      expect(a.inject.secret, role).toBe("gh-read-prj_1");
      expect(a.env.GH_TOKEN, role).toBe("nest-ph.cli_x.gh_read.");
    }
    // Neither placeholder contains the other: nest-proxy finds placeholders as substrings.
    expect("nest-ph.cli_x.gh_push.".includes("nest-ph.cli_x.gh_read.") || "nest-ph.cli_x.gh_read.".includes("nest-ph.cli_x.gh_push.")).toBe(false);
  });

  it("the tokens' permissions: push writes contents and PRs, workflows only when asked; read only reads", () => {
    expect(githubPermissions("push", false)).toEqual({ contents: "write", pull_requests: "write" });
    expect(githubPermissions("push", true)).toEqual({ contents: "write", pull_requests: "write", workflows: "write" });
    expect(githubPermissions("read", true)).toEqual({ contents: "read", metadata: "read" });
    expect(githubSecretName("prj_abc", "push")).toBe("gh-push-prj_abc");
  });

  it("the push guards: pushes and API writes into the repo only, GraphQL only with the sandbox's own token written whole in Authorization, no gists or content-host writes", () => {
    expect(githubGuards("Owner/Repo", "push")).toEqual([
      {
        name: "github-push", hosts: ["github.com"],
        scope: [{ path: "/**/git-receive-pack" }, { path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] }],
        allow: [{ path: "/owner/repo/**" }, { path: "/owner/repo.git/**" }], reason: "git pushes reach only owner/repo", ignore_case: true,
      },
      {
        name: "github-write", hosts: ["github.com"], scope: [{ methods_except: ["GET", "HEAD"] }],
        allow: [
          { methods: ["POST"], path: "/**/git-upload-pack" },
          { methods: ["POST"], path: "/**/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
          { path: "/owner/repo/**" }, { path: "/owner/repo.git/**" },
        ],
        reason: "writes to GitHub reach only owner/repo", ignore_case: true,
      },
      {
        name: "github-api-write", hosts: ["*.github.com"], scope: [{ methods_except: ["GET", "HEAD"] }],
        allow: [{ path: "/repos/owner/repo/**" }, { methods: ["POST"], path: "/graphql", injected: "gh_push", at: "authorization" }],
        reason: "writes to GitHub reach only owner/repo; GraphQL goes only with this sandbox's own GitHub token", ignore_case: true,
      },
      {
        name: "gist-write", hosts: ["gist.github.com"],
        scope: [{ methods_except: ["GET", "HEAD"] }, { path: "/**/info/refs", query: [{ name: "service", values: ["git-receive-pack"] }] }],
        reason: "gists are read-only from a sandbox", ignore_case: true,
      },
      { name: "githubusercontent-write", hosts: ["*.githubusercontent.com"], scope: [{ methods_except: ["GET", "HEAD"] }], reason: "GitHub's content hosts are read-only from a sandbox", ignore_case: true },
    ]);
  });

  it("builds exactly the guards of the fixtures nest-proxy's seam test evaluates (crates/nest-proxy/tests/app_github_guards.rs)", () => {
    // On the wire nest names a client's guard `client:<name>`, and its binding `client:<binding>`.
    const unwire = (g: { name: string; scope: Record<string, unknown>[]; allow?: Record<string, unknown>[] }) => ({
      ...g, name: g.name.replace(/^client:/, ""),
      scope: g.scope.map((m) => (typeof m.injected === "string" ? { ...m, injected: m.injected.replace(/^client:/, "") } : m)),
      ...(g.allow ? { allow: g.allow.map((m) => (typeof m.injected === "string" ? { ...m, injected: m.injected.replace(/^client:/, "") } : m)) } : {}),
    });
    expect(pushFixture.guards.map(unwire)).toEqual(githubGuards("by77er/nest", "push"));
    expect(readFixture.guards.map(unwire)).toEqual(githubGuards("by77er/nest", "read"));
    expect(pushFixture.inject.map((b) => b.name)).toEqual(["client:gh_push"]);
  });

  it("the read guards: no push or REST write anywhere; fetches open; GraphQL only with the read token, which can't write", () => {
    const g = githubGuards("o/r", "read");
    const by = (n: string) => g.find((x) => x.name === n)!;
    expect(by("github-push").allow).toBeUndefined();
    expect(by("github-write").allow).toEqual([
      { methods: ["POST"], path: "/**/git-upload-pack" },
      { methods: ["POST"], path: "/**/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
    ]);
    expect(by("github-api-write").allow).toEqual([{ methods: ["POST"], path: "/graphql", injected: "gh_read", at: "authorization" }]);
    expect(g.map((x) => x.name)).toEqual(["github-push", "github-write", "github-api-write", "gist-write", "githubusercontent-write"]);
  });

  it("a start frozen with the access sends its guards and adds the GitHub hosts no rule names; one frozen before it, nest's repos", () => {
    const spec = { github: { egress: [{ host: "github.com" }, { host: "api.github.com" }], guards: githubGuards("o/r", "read") } };
    // With nest's repos narrowed to none, whatever a shared template not synced since still names.
    expect(spawnOverrides(spec, "o/r", false)).toEqual({ guards: spec.github.guards, repos: [], read_repos: [] });
    expect(spawnOverrides({}, "o/r", true)).toEqual({ repos: ["o/r"] });
    expect(spawnOverrides({}, "o/r", false)).toEqual({ read_repos: ["o/r"] });
    expect(startEgress([{ host: "github.com", ports: [443] }, { host: "pypi.org" }], spec)).toEqual({ egress: { allow: [{ host: "github.com", ports: [443] }, { host: "pypi.org" }, { host: "api.github.com" }] } });
    expect(startEgress([], {})).toEqual({});
  });

  it("names what the grant lacks for it, or nothing", () => {
    expect(githubGrantMissing({ inject_hosts: ["github.com", "api.github.com"], egress_hosts: ["api.github.com"] })).toBeNull();
    expect(githubGrantMissing({ inject_hosts: ["*.github.com", "github.com"], egress_hosts: ["*.github.com"] })).toBeNull();
    expect(githubGrantMissing({ inject_hosts: ["github.com"], egress_hosts: [] })).toBe(
      "waiting for nest's grant for this app to cover its GitHub access: the operator must add api.github.com to inject_hosts, and api.github.com to egress_hosts");
    expect(githubGrantMissing({})).toMatch(/add github\.com and api\.github\.com to inject_hosts/);
  });

  it("the owner's secrets can't take its binding names or variables, and one saved under such a name is never bound", () => {
    const base = { hosts: ["api.example.com"], locations: [{ type: "authorization_bearer" as const }], roles: ["worker" as const] };
    expect(secretProblems({ ...base, name: "gh_push", env: "X" }, null).name).toMatch(/app's own GitHub binding/);
    expect(secretProblems({ ...base, name: "gh_read", env: "X" }, null).name).toMatch(/app's own GitHub binding/);
    for (const v of ["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS"]) {
      expect(secretProblems({ ...base, name: "x", env: v }, null).env, v).toMatch(/GitHub token/);
    }
    const old = { ...base, name: "gh_push", description: "", env: "OLD", nest_name: "prj-gh_push-aaaaaa", size: 1, created_ms: 1, updated_ms: 1 };
    expect(secretFeeds("cli_x", [old]).inject).toEqual([]);
  });

  it("a live layer keeps the GitHub part beside the owner's secrets and rules, never nest's push opt-in; outside the grant, it goes", () => {
    const gh = githubAccess({ client: "cli_x", project: "prj_1", repo: "o/r", role: "worker", egressHosts: ["github.com", "api.github.com"] });
    const own = { name: "npm_token", secret: "prj_1-npm_token-aaaaaa", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" as const }] };
    const held = {
      egress: { allow: [{ host: "pypi.org" }, { host: "github.com" }, { host: "api.github.com" }] },
      inject: [{ ...own, client: "cli_x", placeholder: "nest-ph.cli_x.npm_token." }, { ...gh.inject, client: "cli_x", placeholder: gh.env.GH_TOKEN! }],
      env: { NPM_TOKEN: "nest-ph.cli_x.npm_token.", ...gh.env }, github_push: { workflows: false },
    };
    const rules = { worker: [{ host: "nodejs.org" }, { host: "github.com", ports: [443] }], manager: [] };
    const feed = { inject: gh.inject, env: gh.env, egress: gh.egress };
    // The Secrets page's feed (its binding dropped) and the role's rules: the GitHub part stays, once each.
    expect(clientLayerFor(rules, "worker", { inject: [], env: {}, github_push: { workflows: true }, github: feed }, held)).toEqual({
      egress: { allow: [{ host: "nodejs.org" }, { host: "github.com", ports: [443] }, { host: "api.github.com" }] },
      inject: [gh.inject], env: gh.env, github_push: { workflows: false },
    });
    // No feed of the page's: the owner's kept as held, the GitHub part as fed.
    expect(clientLayerFor(NO_RULES, "worker", { github: feed }, held)).toEqual({
      egress: { allow: gh.egress }, inject: [own, gh.inject], env: { NPM_TOKEN: "nest-ph.cli_x.npm_token.", ...gh.env }, github_push: { workflows: false },
    });
    // Outside the grant now: the binding and its variables go (nest refuses a placeholder no binding has).
    const out = clientLayerFor(NO_RULES, "worker", { github: { inject: null, env: null, egress: [] } }, held);
    expect(out.inject).toEqual([own]);
    expect(out.env).toEqual({ NPM_TOKEN: "nest-ph.cli_x.npm_token." });
    // And a refusal's fallback (what the change removes) keeps the GitHub part the new layer keeps.
    const desired = clientLayerFor(NO_RULES, "worker", { inject: [], env: {}, github: feed }, held);
    expect(shrinkLayer(held, desired)).toEqual({ egress: { allow: gh.egress }, inject: [gh.inject], env: gh.env, github_push: { workflows: false } });
  });
});

// --- Through the app ------------------------------------------------------------------------------------

const fake = new FakeNest();
let restore: () => void;
let token: string;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const r = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, repo, manager: r.body.settings.manager as string | null };
}
type P = Awaited<ReturnType<typeof newProject>>;
const stub = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id));
const drain = (p: P) => stub(p).drain();
const sql = <T>(p: P, f: (s: SqlStorage) => T) => runInDurableObject(stub(p), (_o, st) => f(st.storage.sql));
async function task(p: P) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  return t.id as string;
}
async function assigned(p: P) {
  const t = await task(p);
  return (await api(token, "POST", `/api/projects/${p.id}/tasks/${t}/assign`)).body as { id: string; assignee: string | null; state: string; start_error: string | null };
}
const createOf = (labels: Record<string, string>) =>
  fake.callsTo("POST", /^\/v1\/sandboxes$/).filter((c) => Object.entries(labels).every(([k, v]) => c.body.labels?.[k] === v));
const agentCreateOf = (labels: Record<string, string>) =>
  fake.callsTo("POST", /^\/v1\/agents$/).filter((c) => Object.entries(labels).every(([k, v]) => c.body.labels?.[k] === v));
/** The App's mints for one repo and these permissions. */
const mintsOf = (repo: string, permissions: Record<string, string>) =>
  fake.github.mints().filter((m) => m.repositories?.[0] === repo.split("/")[1] && JSON.stringify(m.permissions) === JSON.stringify(permissions));
const secret = (p: P, kind: "push" | "read") => fake.secrets.get(githubSecretName(p.id, kind));
/** A token as the fake GitHub holds it: its permissions, or undefined once revoked. */
const tokenOf = (t: string) => fake.github.tokens.get(t);
const ghRow = (p: P, kind: "push" | "read") => sql(p, (s) => s.exec("SELECT * FROM gh_access WHERE kind = ?", kind).toArray()[0]);
const dueNow = (p: P, kind: "push" | "read") => sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0 WHERE kind = ?", kind));

describe("the sandbox of each role", () => {
  it("the manager reads: the read token minted for its repo alone, written with its expiry; its binding, variables, GitHub hosts and read guards; none of nest's repos", async () => {
    const p = await newProject();
    expect(p.manager).toMatch(/^agt_/);
    expect(mintsOf(p.repo, { contents: "read", metadata: "read" })).toEqual([{ installation: GH_INSTALLATION_ID, repositories: [p.repo.split("/")[1]], permissions: { contents: "read", metadata: "read" } }]);
    const s = secret(p, "read")!;
    expect(tokenOf(s.value)).toMatchObject({ permissions: { contents: "read", metadata: "read" }, installation: GH_INSTALLATION_ID });
    expect(s.expires_ms).toBe(tokenOf(s.value)!.expires_ms);
    expect(secret(p, "push")).toBeUndefined();
    const [create] = createOf({ project: p.id, role: "manager" });
    expect(create!.body.inject).toEqual([{ name: "gh_read", secret: `gh-read-${p.id}`, hosts: ["github.com", "api.github.com"], locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password" }] }]);
    expect(create!.body.env.GH_TOKEN).toBe(`nest-ph.${CLIENT}.gh_read.`);
    expect(create!.body.env.GIT_CONFIG_VALUE_1).toBe(CREDENTIAL_HELPER);
    expect(create!.body.egress).toEqual({ allow: [{ host: "github.com" }, { host: "api.github.com" }, { host: "*.githubusercontent.com" }] });
    expect(create!.body).not.toHaveProperty("github_push");
    const [agent] = agentCreateOf({ project: p.id, role: "manager" });
    expect(agent!.body.overrides).toEqual({ guards: githubGuards(p.repo, "read"), repos: [], read_repos: [] });
    // Its brief says git and gh are set up, never the placeholder.
    const brief = fake.inbox.find((m) => m.agent === p.manager)!.text;
    expect(brief).toContain(`already signed in to ${p.repo} for reading`);
    expect(brief).not.toContain("nest-ph.");
  });

  it("a worker pushes: the push token minted for its repo alone, its binding and variables, the push guards; none of nest's repos or opt-in", async () => {
    const p = await newProject();
    const t = await assigned(p);
    expect(t.state).toBe("in_progress");
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" })).toHaveLength(1);
    expect(tokenOf(secret(p, "push")!.value)).toMatchObject({ permissions: { contents: "write", pull_requests: "write" } });
    const [create] = createOf({ project: p.id, role: "worker", task: t.id });
    expect((create!.body.inject as { name: string; secret: string }[]).map((b) => [b.name, b.secret])).toEqual([["gh_push", `gh-push-${p.id}`]]);
    expect(create!.body.env.GH_TOKEN).toBe(`nest-ph.${CLIENT}.gh_push.`);
    expect(create!.body).not.toHaveProperty("github_push");
    const [agent] = agentCreateOf({ project: p.id, role: "worker", task: t.id });
    expect(agent!.body.overrides).toEqual({ guards: githubGuards(p.repo, "push"), repos: [], read_repos: [] });
    expect(fake.inbox.find((m) => m.agent === t.assignee)!.text).toContain(`They push only to ${p.repo}.`);
    // A second worker shares the project's push token: no second mint.
    await assigned(p);
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" })).toHaveLength(1);
  });

  it("a reviewer reads, as the manager does", async () => {
    const p = await newProject();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 3, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const [create] = createOf({ project: p.id, role: "reviewer" });
    expect((create!.body.inject as { name: string }[]).map((b) => b.name)).toEqual(["gh_read"]);
    expect(create!.body.egress.allow).toContainEqual({ host: "api.github.com" });
    const [agent] = agentCreateOf({ project: p.id, role: "reviewer" });
    expect(agent!.body.overrides).toEqual({ guards: githubGuards(p.repo, "read"), repos: [], read_repos: [] });
  });

  it("a shared template not synced since the deploy, still naming every repo, is narrowed to none: nest gives the agent no token of its own", async () => {
    const p = await newProject();
    const name = "templates/projects/reviewer";
    const synced = fake.catalog.get(name);
    // As the catalog sync before this release wrote it.
    fake.catalog.set(name, { ...(synced as object), read_repos: ["someone/else", p.repo] });
    try {
      await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 5, sha: sha(), action: "opened" }));
      await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
      const [agent] = agentCreateOf({ project: p.id, role: "reviewer" });
      expect(agent!.body.overrides).toMatchObject({ repos: [], read_repos: [] });
      expect([...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer")).toHaveLength(1);
    } finally {
      fake.catalog.set(name, synced);
    }
  });

  it("no create of any role names a repo of nest's, or nest's push opt-in", async () => {
    const p = await newProject();
    await assigned(p);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 4, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const creates = fake.calls.filter((c) => c.method === "POST" && /^\/v1\/(agents|sandboxes)$/.test(c.path) && c.body.labels?.project === p.id);
    expect(creates.length).toBeGreaterThanOrEqual(6);
    for (const c of creates) {
      expect(c.body.overrides?.repos ?? [], c.path).toEqual([]);
      expect(c.body.overrides?.read_repos ?? [], c.path).toEqual([]);
      expect(JSON.stringify(c.body), c.path).not.toMatch(/"github_push"/);
    }
  });
});

describe("the grant", () => {
  it("without the GitHub hosts in it, a start waits, saying what the operator must add; widened, it goes", async () => {
    const p = await newProject();
    const saved = { inject: [...fake.grant.inject_hosts], egress: [...fake.egressHosts] };
    fake.grant.inject_hosts = saved.inject.filter((h) => h !== "api.github.com");
    try {
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toMatch(/the operator must add api\.github\.com to inject_hosts/);
      expect(createOf({ project: p.id, task: t.id })).toEqual([]);
      fake.grant.inject_hosts = saved.inject;
      await sql(p, (s) => s.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id));
      await drain(p);
      expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("in_progress");
    } finally {
      fake.grant.inject_hosts = saved.inject;
      fake.egressHosts = saved.egress;
    }
  });

  it("a token secret is written only within the grant's secrets limits, checked first", async () => {
    const p = await newProject();
    const saved = fake.grant.secrets.max_count;
    fake.grant.secrets.max_count = fake.secrets.size;
    try {
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toMatch(/max_count .* is used up: the operator must raise it/);
      expect(secret(p, "push")).toBeUndefined();
      // Checked before the write: nest wasn't asked to store it, and the token minted for it was revoked.
      expect(fake.callsTo("PUT", new RegExp(`/v1/clients/self/secrets/gh-push-${p.id}$`))).toEqual([]);
      const minted = fake.github.calls.filter((c) => c.path.endsWith("/access_tokens") && c.body?.permissions?.pull_requests === "write" && c.body?.repositories?.[0] === p.repo.split("/")[1]);
      expect(minted).toHaveLength(1);
      await drain(p);
      expect((await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE kind = 'push'").one().n))).toBe(0);
    } finally {
      fake.grant.secrets.max_count = saved;
    }
  });
});

describe("refreshing", () => {
  it("each token is written again REFRESH_BEFORE_MS before it expires: a new token, its new expiry; the one before is left to expire", async () => {
    const p = await newProject();
    const first = secret(p, "read")!.value;
    const row = await ghRow(p, "read");
    expect(row!.next_ms).toBe((row!.expires_ms as number) - REFRESH_BEFORE_MS);
    await dueNow(p, "read");
    await drain(p);
    const second = secret(p, "read")!;
    expect(second.value).not.toBe(first);
    expect(tokenOf(second.value)).toMatchObject({ permissions: { contents: "read", metadata: "read" } });
    expect(second.expires_ms).toBe(tokenOf(second.value)!.expires_ms);
    expect((await ghRow(p, "read"))!.next_ms).toBe(second.expires_ms! - REFRESH_BEFORE_MS);
    // Proxies may hold the old one until the push lands: it isn't revoked, only forgotten once expired.
    expect(tokenOf(first)).toBeDefined();
  });

  it("a refresh GitHub or nest can't take now is retried with backoff, the token written last still in place", async () => {
    const p = await newProject();
    const before = secret(p, "read")!.value;
    fake.fail(/^PUT \/v1\/clients\/self\/secrets\/gh-read-/, 503, { times: 1 });
    await dueNow(p, "read");
    await drain(p);
    const row = await ghRow(p, "read");
    expect(row).toMatchObject({ attempts: 1, gone: 0 });
    expect(row!.error).toMatch(/503/);
    expect(row!.next_ms as number).toBeGreaterThan(Date.now());
    expect(secret(p, "read")!.value).toBe(before);
    // The token minted for the write that failed is revoked: nothing holds it.
    await drain(p);
    expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE revoke = 1").one().n)).toBe(0);
    await dueNow(p, "read");
    await drain(p);
    expect(secret(p, "read")!.value).not.toBe(before);
    expect(await ghRow(p, "read")).toMatchObject({ attempts: 0, error: null });
  });

  it("workflows on: the push token is written again with workflows: write; off: again without it, and every one that had it revoked", async () => {
    const inst = fake.github.installations[0]!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, workflows: "write" };
    try {
      const p = await newProject();
      const w = await assigned(p);
      const plain = secret(p, "push")!.value;
      expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true })).status).toBe(200);
      await drain(p);
      const withWf = secret(p, "push")!.value;
      expect(tokenOf(withWf)!.permissions).toEqual({ contents: "write", pull_requests: "write", workflows: "write" });
      expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.workflow_workers).toEqual([w.assignee]);
      // A refresh while on keeps it; then off.
      await dueNow(p, "push");
      await drain(p);
      const again = secret(p, "push")!.value;
      expect(tokenOf(again)!.permissions).toHaveProperty("workflows", "write");
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
      await drain(p);
      const off = secret(p, "push")!.value;
      expect(tokenOf(off)!.permissions).toEqual({ contents: "write", pull_requests: "write" });
      expect(tokenOf(withWf)).toBeUndefined();
      expect(tokenOf(again)).toBeUndefined();
      // The one before workflows were ever on had none: left to expire.
      expect(tokenOf(plain)).toBeDefined();
      expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.workflow_workers).toEqual([]);
      // Never nest's opt-in on the worker's sandbox.
      expect(fake.sandboxes.get(fake.agents.get(w.assignee!)!.sandbox!)!.github_push).toBeNull();
    } finally {
      inst.permissions = saved;
    }
  });

  it("workflows on where the App can't grant it: the token is written without it, and the error says why", async () => {
    const p = await newProject();
    await assigned(p);
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    await drain(p);
    expect(tokenOf(secret(p, "push")!.value)!.permissions).toEqual({ contents: "write", pull_requests: "write" });
    expect((await ghRow(p, "push"))!.error).toMatch(/can't grant workflows: write/);
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.workflow_workers).toEqual([]);
  });
});

describe("going away", () => {
  it("the repo out of the App's reach: its secrets deleted, its tokens revoked, the owner told; back in reach, written again", async () => {
    const p = await newProject();
    await assigned(p);
    const tokens = [secret(p, "read")!.value, secret(p, "push")!.value];
    // The App uninstalled from the repo's account: GitHub refuses its installation (404).
    const inst = fake.github.installations.find((i) => i.id === GH_INSTALLATION_ID)!;
    fake.github.uninstall(GH_INSTALLATION_ID);
    try {
      await sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0"));
      await drain(p);
      expect(secret(p, "read")).toBeUndefined();
      expect(secret(p, "push")).toBeUndefined();
      // Each revoked (GitHub's 401 for a token of an installation gone is as good).
      const revokes = fake.github.calls.filter((c) => c.method === "DELETE" && c.path === "/installation/token").map((c) => c.token);
      for (const t of tokens) expect(revokes).toContain(t);
      expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_tokens").one().n)).toBe(0);
      expect(await ghRow(p, "push")).toMatchObject({ gone: 2, expires_ms: null });
      const chat = (await api(token, "GET", `/api/projects/${p.id}/chat`)).body;
      expect(JSON.stringify(chat)).toMatch(/doesn't reach this project's repo now/);
      // A start meanwhile waits, its error saying why.
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toMatch(/GitHub push token couldn't be written/);
    } finally {
      fake.github.installations.push(inst);
    }
    await sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0"));
    await drain(p);
    expect(tokenOf(secret(p, "push")!.value)).toBeDefined();
    expect(await ghRow(p, "push")).toMatchObject({ gone: 0, error: null });
  });

  it("a project removed: every token revoked and every token secret deleted, retried until nest takes it", async () => {
    const p = await newProject();
    await assigned(p);
    const tokens = [secret(p, "read")!.value, secret(p, "push")!.value];
    await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => { st.storage.sql.exec("DELETE FROM projects WHERE id = ?", p.id); });
    await sql(p, (s) => s.exec("UPDATE settings SET listed_ms = NULL"));
    fake.fail(/^DELETE \/v1\/clients\/self\/secrets\/gh-push-/, 503, { times: 1 });
    await runInDurableObject(stub(p), (o) => (o as unknown as { alarm(): Promise<void> }).alarm());
    for (const t of tokens) expect(tokenOf(t)).toBeUndefined();
    expect(secret(p, "read")).toBeUndefined();
    expect(secret(p, "push")).toBeDefined();
    // The object's own alarm, the project gone, deletes what's left (armed for it, due at once: the pool runs it).
    await eventually(() => !secret(p, "push"), "the push secret deleted by the alarm");
    await eventually(async () => (await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_access").one().n)) === 0, "nothing left to keep");
  });
});

describe("hosts that don't apply guards yet", () => {
  it("a worker's start waits and says so, never dropping the guards; once they do, the same attempt goes on", async () => {
    const p = await newProject();
    fake.hostsBehind = 1;
    try {
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toContain(HOSTS_WAIT);
      // Retried, the guards each time; its sandbox kept for the same attempt.
      await sql(p, (s) => s.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id));
      await drain(p);
      const tries = agentCreateOf({ project: p.id, task: t.id });
      expect(tries.length).toBeGreaterThanOrEqual(2);
      for (const c of tries) expect(c.body.overrides).toEqual({ guards: githubGuards(p.repo, "push"), repos: [], read_repos: [] });
      expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body).toMatchObject({ state: "assigned" });
    } finally {
      fake.hostsBehind = 0;
    }
    const t = ((await api(token, "GET", `/api/projects/${p.id}/tasks`)).body as { id: string; state: string }[]).find((x) => x.state === "assigned")!;
    await sql(p, (s) => s.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id));
    await drain(p);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("in_progress");
    expect([...fake.sandboxes.values()].filter((x) => x.labels.task === t.id)).toHaveLength(1);
  });

  it("a reviewer's start waits too, its job not failed", async () => {
    const p = await newProject();
    fake.hostsBehind = 1;
    try {
      await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 9, sha: sha(), action: "opened" }));
      await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
      const job = await runInDurableObject(env.REVIEW.get(env.REVIEW.idFromName(p.id)), (_o, st) => st.storage.sql.exec("SELECT state, error, agent FROM jobs WHERE pr = 9").one());
      expect(job).toMatchObject({ state: "running", agent: null });
      expect(job.error).toContain(HOSTS_WAIT);
    } finally {
      fake.hostsBehind = 0;
    }
  });

  it("the manager's start waits too, its error shown", async () => {
    fake.hostsBehind = 1;
    try {
      const p = await newProject();
      expect(p.manager).toBeNull();
      const s = (await api(token, "GET", `/api/projects/${p.id}`)).body.settings;
      expect(s.manager_error).toContain(HOSTS_WAIT);
    } finally {
      fake.hostsBehind = 0;
    }
  });
});
