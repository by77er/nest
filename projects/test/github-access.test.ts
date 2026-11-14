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
import { DirectoryDO } from "../src/do/directory";
import { AppTokens } from "../src/github-app";
import {
  CREDENTIAL_HELPER, githubAccess, githubGrantMissing, githubGuards, githubPermissions, githubSecretName, REFRESH_BEFORE_MS, spawnOverrides, startEgress,
} from "../src/github-access";
import { clientLayerFor, NO_RULES, shrinkLayer } from "../src/network";
import { HOSTS_WAIT, HOSTS_WORDS, NestError, nestFrom } from "../src/nest";
import { secretFeeds, secretProblems } from "../src/secrets";
import { AccessTeam, api, CLIENT, deliver, deliverGithub, eventually, FakeNest, GH_INSTALLATION_ID, installFetch, prEvent } from "./fake-nest";

describe("the access (pure)", () => {
  it("a worker's push access: its binding on both GitHub hosts, GH_TOKEN and git's helper, the GitHub hosts within the grant", () => {
    const a = githubAccess({ client: "cli_x", project: "prj_1", repo: "Owner/Repo", role: "worker", egressHosts: ["api.github.com", "*.githubusercontent.com", "npmjs.org"] });
    expect(a.kind).toBe("push");
    // The Basic username nest-proxy writes itself (nest #273): only then is the field nest's whole for the guards' `at`.
    expect(a.inject).toEqual({ name: "gh_push", secret: "gh-push-prj_1", hosts: ["github.com", "api.github.com"], locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password", username: "x-access-token" }] });
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
          { methods: ["POST"], path: "/*/*/git-upload-pack" },
          { methods: ["POST"], path: "/*/*/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
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
      { methods: ["POST"], path: "/*/*/git-upload-pack" },
      { methods: ["POST"], path: "/*/*/info/lfs/objects/batch", body_json: { pointer: "/operation", values: ["download"] } },
    ]);
    expect(by("github-api-write").allow).toEqual([{ methods: ["POST"], path: "/graphql", injected: "gh_read", at: "authorization" }]);
    expect(g.map((x) => x.name)).toEqual(["github-push", "github-write", "github-api-write", "gist-write", "githubusercontent-write"]);
  });

  it("a start's spawn sends the overrides it froze (none since B4; one frozen by B3, nest's repos narrowed to none, sent again), and adds the GitHub hosts no rule names", () => {
    const spec = { github: { egress: [{ host: "github.com" }, { host: "api.github.com" }], guards: githubGuards("o/r", "read") } };
    expect(spawnOverrides({ ...spec, overrides: {} })).toEqual({});
    // Its retries send the request its Idempotency-Key is bound to.
    expect(spawnOverrides(spec)).toEqual({ repos: [], read_repos: [] });
    expect(startEgress([{ host: "github.com", ports: [443] }, { host: "pypi.org" }], spec)).toEqual({ egress: { allow: [{ host: "github.com", ports: [443] }, { host: "pypi.org" }, { host: "api.github.com" }] } });
    expect(startEgress([], {})).toEqual({});
  });

  it("tells nest's refusal while hosts don't apply guards by its code, or by the words both of nest's refusals use (control-plane's own source)", () => {
    const src = import.meta.glob(["../../control-plane/src/do/sandbox.ts", "../../control-plane/src/lib/injected-any.ts"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    const sentences = Object.values(src).flatMap((t) => t.split("\n").filter((l) => l.includes("every sandbox host of cell") && /NestError|`/.test(l)));
    // requireGuardBounds' and injectedAnyConflict's.
    expect(sentences.length).toBeGreaterThanOrEqual(2);
    for (const l of sentences) expect(HOSTS_WORDS.test(l), l).toBe(true);
    const err = (code: string, msg: string) => new NestError(409, code, msg, false);
    expect(err("hosts_not_ready", "anything").hostsNotReady).toBe(true);
    expect(err("conflict", "request guards need every sandbox host of cell use1 to bound guarded requests").hostsNotReady).toBe(true);
    expect(err("conflict", "this Idempotency-Key was used for a different request").hostsNotReady).toBe(false);
    expect(err("conflict", "this Idempotency-Key was used for a different request").permanent).toBe(true);
    expect(err("hosts_not_ready", "x").permanent).toBe(false);
  });

  it("names what the grant lacks for it, or nothing", () => {
    const egress = ["github.com", "api.github.com", "*.githubusercontent.com"];
    expect(githubGrantMissing({ inject_hosts: ["github.com", "api.github.com"], egress_hosts: egress })).toBeNull();
    expect(githubGrantMissing({ inject_hosts: ["*.github.com", "github.com"], egress_hosts: ["*.github.com", "github.com", "*.githubusercontent.com"] })).toBeNull();
    // Exactly the hosts the bindings inject into and git, gh and the guards reach: the README's operator step.
    expect(githubGrantMissing({ inject_hosts: ["github.com"], egress_hosts: ["api.github.com"] })).toBe(
      "waiting for nest's grant for this app to cover its GitHub access: the operator must add api.github.com to inject_hosts, and github.com and *.githubusercontent.com to egress_hosts");
    expect(githubGrantMissing({})).toMatch(/add github\.com and api\.github\.com to inject_hosts/);
  });

  it("the owner's secrets can't take its binding names or variables, and one saved under such a name is never bound", () => {
    const base = { hosts: ["api.example.com"], locations: [{ type: "authorization_bearer" as const }], roles: ["worker" as const] };
    expect(secretProblems({ ...base, name: "gh_push", env: "X" }, null).name).toBe("gh_push is reserved for the app's own GitHub token: choose another name");
    expect(secretProblems({ ...base, name: "gh_read", env: "X" }, null).name).toBe("gh_read is reserved for the app's own GitHub token: choose another name");
    for (const v of ["GH_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_VALUE_1", "GIT_CONFIG_PARAMETERS", "GIT_ASKPASS"]) {
      expect(secretProblems({ ...base, name: "x", env: v }, null).env, v).toMatch(/GitHub token/);
    }
    const old = { ...base, name: "gh_push", description: "", env: "OLD", nest_name: "prj-gh_push-aaaaaa", size: 1, created_ms: 1, updated_ms: 1 };
    expect(secretFeeds("cli_x", [old]).inject).toEqual([]);
  });

  it("a live layer keeps the GitHub part beside the owner's secrets and rules, never nest's push opt-in; outside the grant, it goes", () => {
    const other = { name: "mine", hosts: ["x.example.com"], scope: [{ methods: ["DELETE"] }] };
    const gh = githubAccess({ client: "cli_x", project: "prj_1", repo: "o/r", role: "worker", egressHosts: ["github.com", "api.github.com"] });
    const own = { name: "npm_token", secret: "prj_1-npm_token-aaaaaa", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" as const }] };
    const held = {
      egress: { allow: [{ host: "pypi.org" }, { host: "github.com" }, { host: "api.github.com" }] },
      inject: [{ ...own, client: "cli_x", placeholder: "nest-ph.cli_x.npm_token." }, { ...gh.inject, client: "cli_x", placeholder: gh.env.GH_TOKEN! }],
      env: { NPM_TOKEN: "nest-ph.cli_x.npm_token.", ...gh.env }, github_push: { workflows: false }, guards: [githubGuards("o/old-name", "push")[0]!, other],
    };
    const rules = { worker: [{ host: "nodejs.org" }, { host: "github.com", ports: [443] }], manager: [] };
    const feed = { inject: gh.inject, env: gh.env, egress: gh.egress, guards: gh.guards };
    // The Secrets page's feed (its binding dropped) and the role's rules: the GitHub part stays, once each.
    expect(clientLayerFor(rules, "worker", { inject: [], env: {}, github_push: { workflows: true }, github: feed }, held)).toEqual({
      egress: { allow: [{ host: "nodejs.org" }, { host: "github.com", ports: [443] }, { host: "api.github.com" }] },
      inject: [gh.inject], env: gh.env, github_push: { workflows: false },
      // The app's guards for the repo's name now in place of the old ones of those names, any other kept.
      guards: [...gh.guards, other],
    });
    // No feed of the page's: the owner's kept as held, the GitHub part as fed.
    expect(clientLayerFor(NO_RULES, "worker", { github: feed }, held)).toEqual({
      egress: { allow: gh.egress }, inject: [own, gh.inject], env: { NPM_TOKEN: "nest-ph.cli_x.npm_token.", ...gh.env }, github_push: { workflows: false },
      guards: [...gh.guards, other],
    });
    // Outside the grant now: the binding and its variables go (nest refuses a placeholder no binding has).
    const out = clientLayerFor(NO_RULES, "worker", { github: { inject: null, env: null, egress: [], guards: gh.guards } }, held);
    expect(out.inject).toEqual([own]);
    expect(out.env).toEqual({ NPM_TOKEN: "nest-ph.cli_x.npm_token." });
    // ...but never its guards: they only refuse, and hold while the sandbox lives.
    expect(out.guards).toEqual([...gh.guards, other]);
    // A sandbox on nest's repos (no GitHub feed): a page's change keeps whatever guards it has.
    expect(clientLayerFor(NO_RULES, "worker", { inject: [], env: {} }, held).guards).toEqual(held.guards);
    // And a refusal's fallback (what the change removes) keeps the GitHub part the new layer keeps.
    const desired = clientLayerFor(NO_RULES, "worker", { inject: [], env: {}, github: feed }, held);
    // Guards only refuse: it keeps every one the sandbox has (so it adds none, and goes through while hosts lag).
    expect(shrinkLayer(held, desired)).toEqual({ egress: { allow: gh.egress }, inject: [gh.inject], env: gh.env, github_push: { workflows: false }, guards: held.guards });
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
/** The App's mints for one repo, by its id (the binding's), and these permissions. */
const mintsOf = (repo: string, permissions: Record<string, string>) =>
  fake.github.mints().filter((m) => m.repository_ids?.[0] === fake.github.repo(repo).id && JSON.stringify(m.permissions) === JSON.stringify(permissions));
const secret = (p: P, kind: "push" | "read") => fake.secrets.get(githubSecretName(p.id, kind));
/** A token as the fake GitHub holds it: its permissions, or undefined once revoked. */
const tokenOf = (t: string) => fake.github.tokens.get(t);
const ghRow = (p: P, kind: "push" | "read") => sql(p, (s) => s.exec("SELECT * FROM gh_access WHERE kind = ?", kind).toArray()[0]);
const dueNow = (p: P, kind: "push" | "read") => sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0 WHERE kind = ?", kind));

/**
 * Run `f` inside the project's object with its alarm held (none armed, none runs): an alarm's own refresh can't
 * run beside the one a test drives, and mask an interleaving.
 */
/**
 * Bind the project to another repo in DirectoryDO (the operator's rebind, its notice to ProjectDO not sent): a
 * repo the binding's installation reaches, under another name. Its name.
 */
async function rebindInDirectory(p: P): Promise<string> {
  const to = `n-${rand()}/x-${rand()}`.toLowerCase();
  const id = fake.github.repo(to).id;
  await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => {
    st.storage.sql.exec("UPDATE projects SET repo = ?, repo_id = ? WHERE id = ?", to, id, p.id);
  });
  return to;
}
const dirStub = () => env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
/** Bind the project to `repo` (its id `id`) in DirectoryDO, as a rebind writes it. */
async function bindTo(p: P, repo: string, id: number) {
  await runInDurableObject(dirStub(), (_o, st) => { st.storage.sql.exec("UPDATE projects SET repo = ?, repo_id = ? WHERE id = ?", repo, id, p.id); });
}
const boundRow = (p: P) => runInDurableObject(dirStub(), (_o, st) => st.storage.sql.exec("SELECT repo_id, repo_gen FROM projects WHERE id = ?", p.id).one() as { repo_id: number; repo_gen: number });
const layerGuards = (agent: string) => fake.sandboxes.get(fake.agents.get(agent)!.sandbox!)!.layer.guards;

async function alarmHeld<T>(p: P, f: (o: any, st: DurableObjectState) => Promise<T>): Promise<T> {
  const run = runInDurableObject as unknown as (s: unknown, g: (o: any, st: DurableObjectState) => Promise<T>) => Promise<T>;
  return run(stub(p), async (o: any, st: DurableObjectState) => {
    await st.storage.deleteAlarm();
    const arm = o.arm;
    o.arm = async () => {};
    try {
      return await f(o, st);
    } finally {
      o.arm = arm;
    }
  });
}

describe("the sandbox of each role", () => {
  it("the manager reads: the read token minted for its repo alone, written with its expiry; its binding, variables, GitHub hosts and read guards; none of nest's repos", async () => {
    const p = await newProject();
    expect(p.manager).toMatch(/^agt_/);
    expect(mintsOf(p.repo, { contents: "read", metadata: "read" })).toEqual([{ installation: GH_INSTALLATION_ID, repositories: undefined, repository_ids: [fake.github.repo(p.repo).id], permissions: { contents: "read", metadata: "read" } }]);
    const s = secret(p, "read")!;
    expect(tokenOf(s.value)).toMatchObject({ permissions: { contents: "read", metadata: "read" }, installation: GH_INSTALLATION_ID });
    expect(s.expires_ms).toBe(tokenOf(s.value)!.expires_ms);
    expect(secret(p, "push")).toBeUndefined();
    const [create] = createOf({ project: p.id, role: "manager" });
    expect(create!.body.inject).toEqual([{ name: "gh_read", secret: `gh-read-${p.id}`, hosts: ["github.com", "api.github.com"], locations: [{ type: "authorization_bearer" }, { type: "authorization_basic_password", username: "x-access-token" }] }]);
    // The guards with the sandbox: they hold before its agent is made and after it ends.
    expect(create!.body.guards).toEqual(githubGuards(p.repo, "read"));
    expect(create!.body.env.GH_TOKEN).toBe(`nest-ph.${CLIENT}.gh_read.`);
    expect(create!.body.env.GIT_CONFIG_VALUE_1).toBe(CREDENTIAL_HELPER);
    expect(create!.body.egress).toEqual({ allow: [{ host: "github.com" }, { host: "api.github.com" }, { host: "*.githubusercontent.com" }] });
    expect(create!.body).not.toHaveProperty("github_push");
    const [agent] = agentCreateOf({ project: p.id, role: "manager" });
    expect(agent!.body.overrides).toEqual({});
    expect(fake.sandboxes.get(fake.agents.get(p.manager!)!.sandbox!)!.layer.guards).toEqual(githubGuards(p.repo, "read"));
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
    expect(agent!.body.overrides).toEqual({});
    expect(create!.body.guards).toEqual(githubGuards(p.repo, "push"));
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
    expect(agent!.body.overrides).toEqual({});
    expect(create!.body.guards).toEqual(githubGuards(p.repo, "read"));
  });

  it("a shared template not synced since the deploy, still naming every repo, is written again before a start from it: nest gives the agent no token of its own, with no narrowing", async () => {
    const p = await newProject();
    const names = ["templates/projects/reviewer", "templates/projects/routine"];
    const synced = names.map((n) => fake.catalog.get(n));
    // As the catalog sync of a release before B3 wrote them.
    names.forEach((n, i) => fake.catalog.set(n, { ...(synced[i] as object), read_repos: ["someone/else", p.repo] }));
    try {
      await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 5, sha: sha(), action: "opened" }));
      await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
      expect(fake.catalog.get(names[0]!)).toEqual(synced[0]);
      const [agent] = agentCreateOf({ project: p.id, role: "reviewer" });
      expect(agent!.body.overrides).toEqual({});
      expect([...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer")).toHaveLength(1);
      // A routine run's too.
      const routine = (await api(token, "POST", `/api/projects/${p.id}/routines`, {
        name: "R", kind: "custom", prompt: "Look around.", enabled: true, triggers: { timer: null, tasks_done: null, prs_merged: null },
        cooldown_min: 0, max_minutes: 30, max_turns: 3, proposals: "triage",
      })).body.id as string;
      await api(token, "POST", `/api/projects/${p.id}/routines/${routine}/run`);
      await drain(p);
      expect(fake.catalog.get(names[1]!)).toEqual(synced[1]);
      const [run] = agentCreateOf({ project: p.id, role: "routine" });
      expect(run!.body.overrides).toEqual({});
      expect([...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "routine")).toHaveLength(1);
    } finally {
      names.forEach((n, i) => fake.catalog.set(n, synced[i]));
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
      const minted = fake.github.calls.filter((c) => c.path.endsWith("/access_tokens") && c.body?.permissions?.pull_requests === "write" && c.body?.repository_ids?.[0] === fake.github.repo(p.repo).id);
      expect(minted).toHaveLength(1);
      await drain(p);
      expect((await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE kind = 'push'").one().n))).toBe(0);
    } finally {
      fake.grant.secrets.max_count = saved;
    }
  });
});

describe("the grant, live", () => {
  it("a token over the grant's max_bytes isn't written, and the start says the operator must raise it", async () => {
    const p = await newProject();
    const saved = fake.grant.secrets.max_bytes;
    fake.grant.secrets.max_bytes = 8;
    try {
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toMatch(/over the grant's secrets\.max_bytes \(8\): the operator must raise it/);
      expect(secret(p, "push")).toBeUndefined();
    } finally {
      fake.grant.secrets.max_bytes = saved;
    }
  });

  it("the grant narrowed away from the GitHub hosts: live layers drop the binding and its variables, keep the guards; widened, they come back", async () => {
    const p = await newProject();
    const sb = fake.sandboxes.get(fake.agents.get(p.manager!)!.sandbox!)!;
    const has = () => (sb.layer.inject as { name: string }[]).some((b) => b.name === "gh_read");
    expect(has()).toBe(true);
    const saved = [...fake.grant.inject_hosts];
    const upkeep = async () => {
      await sql(p, (s) => s.exec("UPDATE settings SET secrets_next_ms = 0"));
      await drain(p);
    };
    try {
      // The grant as first seen, then narrowed: a change owes every live layer.
      await upkeep();
      fake.grant.inject_hosts = saved.filter((h) => h !== "api.github.com");
      await upkeep();
      expect(has()).toBe(false);
      expect(Object.keys(sb.layer.env).filter((k) => k === "GH_TOKEN" || k.startsWith("GIT_CONFIG"))).toEqual([]);
      expect(sb.layer.guards).toEqual(githubGuards(p.repo, "read"));
      fake.grant.inject_hosts = saved;
      await upkeep();
      expect(has()).toBe(true);
      expect(sb.layer.env.GH_TOKEN).toBe(`nest-ph.${CLIENT}.gh_read.`);
    } finally {
      fake.grant.inject_hosts = saved;
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

  it("workflows turned off while a refresh minted with them is in flight: its token never stays the secret's, the toggle's own refresh runs after it, and it's revoked", async () => {
    const inst = fake.github.installations[0]!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, workflows: "write" };
    try {
      const p = await newProject();
      await assigned(p);
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
      await drain(p);
      const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
        const nest = nestFrom(env as any)!;
        const orig = o.secretRoom.bind(o);
        let open!: () => void;
        const gate = new Promise<void>((r) => { open = r; });
        let entered!: () => void;
        const inRoom = new Promise<void>((r) => { entered = r; });
        o.secretRoom = async (...args: unknown[]) => { entered(); await gate; return orig(...args); };
        try {
          // Minted with workflows (the setting on), held before its write.
          const p1 = o.refreshGithub(nest, "push");
          await inRoom;
          o.secretRoom = orig;
          const inflight = st.storage.sql.exec("SELECT token FROM gh_tokens WHERE kind = 'push' ORDER BY seq DESC LIMIT 1").one().token as string;
          // The toggle (its drain runs the toggle's own refresh, after the one in flight).
          const u = o.updateSettings({ workers_edit_workflows: false });
          setTimeout(() => open(), 50);
          await Promise.all([p1, u]);
          return { inflight, row: st.storage.sql.exec("SELECT workflows FROM gh_access WHERE kind = 'push'").one() };
        } finally {
          o.secretRoom = orig;
        }
      });
      expect(out.row.workflows).toBe(0);
      const now = secret(p, "push")!.value;
      expect(now).not.toBe(out.inflight);
      expect(tokenOf(now)!.permissions).toEqual({ contents: "write", pull_requests: "write" });
      expect(tokenOf(out.inflight), "the in-flight workflows token left valid").toBeUndefined();
    } finally {
      inst.permissions = saved;
    }
  });

  it("workflows turned off while the push token's refresh has lapsed: revoked at once, and the next worker gets one without", async () => {
    const inst = fake.github.installations[0]!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, workflows: "write" };
    try {
      const p = await newProject();
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
      const w = await assigned(p);
      const wf = secret(p, "push")!.value;
      expect(tokenOf(wf)!.permissions.workflows).toBe("write");
      await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
      await dueNow(p, "push");
      await drain(p);
      expect((await ghRow(p, "push"))!.next_ms).toBeNull();
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
      await drain(p);
      expect(tokenOf(wf), "the lapsed workflows token left valid").toBeUndefined();
      await assigned(p);
      expect(tokenOf(secret(p, "push")!.value)!.permissions).toEqual({ contents: "write", pull_requests: "write" });
    } finally {
      inst.permissions = saved;
    }
  });

  it("a rebind while a refresh of the old repo is in flight (the alarm held): its token never stays the secret's, it's revoked, and live layers' guards follow the new name", async () => {
    const p = await newProject();
    await assigned(p);
    const proto = AppTokens.prototype as any;
    const origMint = proto.sandboxToken;
    const out = await alarmHeld(p, async (o: any) => {
      const nest = nestFrom(env as any)!;
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      let entered!: () => void;
      const inMint = new Promise<void>((r) => { entered = r; });
      let inflight = "";
      proto.sandboxToken = async function (this: unknown, ...args: unknown[]) { const t = await origMint.apply(this, args); inflight = t.token; entered(); await gate; return t; };
      try {
        const p1 = o.refreshGithub(nest, "push");
        await inMint;
        proto.sandboxToken = origMint;
        await rebindInDirectory(p);
        const r = o.githubRebound();
        setTimeout(() => open(), 50);
        await Promise.all([p1, r]);
      } finally {
        proto.sandboxToken = origMint;
      }
      // The alarm's own run, once the rebind's is due.
      await o.drain();
      return { inflight };
    });
    expect(secret(p, "push")!.value).not.toBe(out.inflight);
    expect(tokenOf(out.inflight), "the pre-rebind token left valid").toBeUndefined();
    expect(tokenOf(secret(p, "push")!.value)).toBeDefined();
    // Found stale before its write: never written to nest at all.
    expect(fake.callsTo("PUT", /\/v1\/clients\/self\/secrets\/gh-push-/).some((c) => c.body?.value === out.inflight)).toBe(false);
  });

  it("a rebind while that refresh's write is in flight (the alarm held): written, then revoked at once, and written again for the new repo", async () => {
    const p = await newProject();
    await assigned(p);
    let release!: () => void;
    const hold = { match: /^PUT \/v1\/clients\/self\/secrets\/gh-push-/, release: new Promise<void>((r) => { release = r; }), reached: false };
    fake.holds.push(hold);
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      const p1 = o.refreshGithub(nest, "push");
      for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
      const inflight = st.storage.sql.exec("SELECT token FROM gh_tokens WHERE kind = 'push' ORDER BY seq DESC LIMIT 1").one().token as string;
      await rebindInDirectory(p);
      const r = o.githubRebound();
      release();
      await Promise.all([p1, r]);
      await o.drain();
      return { inflight, reached: hold.reached };
    });
    expect(out.reached).toBe(true);
    expect(tokenOf(out.inflight), "the token written across the rebind left valid").toBeUndefined();
    expect(secret(p, "push")!.value).not.toBe(out.inflight);
    expect(tokenOf(secret(p, "push")!.value)).toBeDefined();
  });

  it("an operator's rebind (Re-read, then Bind to the repo shown): the old repo's tokens revoked, both written for the new one by its id", async () => {
    const p = await newProject();
    await assigned(p);
    const old = [secret(p, "read")!.value, secret(p, "push")!.value];
    // The repo renamed away, another made under the name: the operator binds the new one.
    fake.github.rename(p.repo, `${p.repo}-old`);
    const newId = fake.github.take(p.repo);
    expect((await api(token, "POST", `/api/admin/bindings/${p.id}/bind`, { repo_id: newId })).status).toBe(200);
    await drain(p);
    for (const t of old) expect(tokenOf(t)).toBeUndefined();
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" }).at(-1)!.repository_ids).toEqual([newId]);
    expect(tokenOf(secret(p, "push")!.value)).toBeDefined();
  });

  it("workflows on where the App can't grant it: the token is written without it, and the error says why", async () => {
    const p = await newProject();
    await assigned(p);
    const before = secret(p, "push")!.value;
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    await drain(p);
    // A new token, minted again without it once the App refused it.
    expect(secret(p, "push")!.value).not.toBe(before);
    expect(tokenOf(secret(p, "push")!.value)!.permissions).toEqual({ contents: "write", pull_requests: "write" });
    expect((await ghRow(p, "push"))!.error).toMatch(/can't grant workflows: write/);
    // A start takes it: refused, not missing.
    const w2 = await assigned(p);
    expect(w2.state, JSON.stringify(w2)).not.toBe("failed");
    expect(w2.start_error).toBeNull();
    // Shown on Settings (under the toggle, beside each live worker), and told once in the chat.
    const view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.workflow_workers).toEqual([]);
    expect(view.workflows_refused).toBe("the GitHub App's installation doesn't grant workflows: write");
    await dueNow(p, "push");
    await drain(p);
    const chat = JSON.stringify((await api(token, "GET", `/api/projects/${p.id}/chat`)).body);
    expect(chat.match(/doesn't grant workflows: write, so workers' pushes can't change/g)).toHaveLength(1);
    // Off: nothing refuses.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.workflows_refused).toBeNull();
  });

  it("workflows turned on while a start's refresh is being written: the start doesn't go on with the token that toggle revokes", async () => {
    const inst = fake.github.installations[0]!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, workflows: "write" };
    try {
      const p = await newProject();
      const w0 = await assigned(p);
      await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w0.assignee!, reason: "done" });
      await dueNow(p, "push");
      await drain(p);
      expect((await ghRow(p, "push"))!.next_ms).toBeNull();
      // Unexpired, though not fresh enough for a start.
      await sql(p, (s) => s.exec("UPDATE gh_access SET expires_ms = ? WHERE kind = 'push'", Date.now() + 5 * 60_000));
      let release!: () => void;
      const hold = { match: /^PUT \/v1\/clients\/self\/secrets\/gh-push-/, release: new Promise<void>((r) => { release = r; }), reached: false };
      fake.holds.push(hold);
      const out = await alarmHeld(p, async (o: any) => {
        const nest = nestFrom(env as any)!;
        const e = o.ensureGithub(nest, "push").then(() => "ok", (x: Error) => `threw: ${x.message}`);
        for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
        const u = o.updateSettings({ workers_edit_workflows: true });
        release();
        const [res] = await Promise.all([e, u]);
        return res as string;
      });
      expect(out).toMatch(/^threw: the project's GitHub push token couldn't be written: a setting or the repo's binding changed/);
      // What it wrote is owed its revoke: had the start gone on, its worker would hold a dead token.
      const written = secret(p, "push")!.value;
      expect(await sql(p, (s) => s.exec("SELECT revoke FROM gh_tokens WHERE token = ?", written).one().revoke)).toBe(1);
      await drain(p);
      expect(tokenOf(written)).toBeUndefined();
    } finally {
      inst.permissions = saved;
    }
  });

  it("workflows turned on while the push token's refresh has lapsed: the next worker gets one with it", async () => {
    const inst = fake.github.installations[0]!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, workflows: "write" };
    try {
      const p = await newProject();
      const w = await assigned(p);
      await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
      await dueNow(p, "push");
      await drain(p);
      expect((await ghRow(p, "push"))!.next_ms).toBeNull();
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
      await assigned(p);
      expect(tokenOf(secret(p, "push")!.value)!.permissions).toEqual({ contents: "write", pull_requests: "write", workflows: "write" });
    } finally {
      inst.permissions = saved;
    }
  });
});

describe("going away", () => {
  it("the repo not selected in the App's installation (422): the owner is told to select it, and nothing else", async () => {
    const p = await newProject();
    await assigned(p);
    const inst = fake.github.installations.find((i) => i.id === GH_INSTALLATION_ID)!;
    const saved = inst.repos;
    inst.repos = new Set();
    try {
      for (let i = 0; i < 2; i++) {
        await sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0"));
        await drain(p);
      }
      expect(await ghRow(p, "push")).toMatchObject({ gone: 2 });
      const chat = JSON.stringify((await api(token, "GET", `/api/projects/${p.id}/chat`)).body);
      expect(chat).toContain(`The GitHub App can't reach ${p.repo}: the repo isn't selected in its installation, so agents' GitHub tokens were revoked and new agents wait to start. Select the repo in the App's installation settings. The app checks again every 30 minutes`);
      expect(chat).not.toMatch(/Install the App|GitHub 422|not accessible/);
    } finally {
      inst.repos = saved;
    }
  });

  it("the repo out of the App's reach: its secrets deleted, its tokens revoked, the owner told; back in reach, written again", async () => {
    const p = await newProject();
    await assigned(p);
    const tokens = [secret(p, "read")!.value, secret(p, "push")!.value];
    // The App uninstalled from the repo's account: GitHub refuses its installation (404).
    const inst = fake.github.installations.find((i) => i.id === GH_INSTALLATION_ID)!;
    fake.github.uninstall(GH_INSTALLATION_ID);
    try {
      // One refusal takes nothing away (a lookup's moment): retried soon, the tokens kept.
      await sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0"));
      await drain(p);
      expect(secret(p, "read")!.value).toBe(tokens[0]);
      expect(await ghRow(p, "read")).toMatchObject({ refusals: 1, gone: 0 });
      expect(fake.github.calls.filter((c) => c.method === "DELETE" && c.path === "/installation/token" && tokens.includes(c.token!))).toEqual([]);
      // Twice running: gone.
      await sql(p, (s) => s.exec("UPDATE gh_access SET next_ms = 0"));
      await drain(p);
      expect(secret(p, "read")).toBeUndefined();
      expect(secret(p, "push")).toBeUndefined();
      // Each revoked (GitHub's 401 for a token of an installation gone is as good).
      const revokes = fake.github.calls.filter((c) => c.method === "DELETE" && c.path === "/installation/token").map((c) => c.token);
      for (const t of tokens) expect(revokes).toContain(t);
      expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_tokens").one().n)).toBe(0);
      expect(await ghRow(p, "push")).toMatchObject({ gone: 2, expires_ms: null });
      // One message for both tokens, naming the repo and what to do.
      const chat = JSON.stringify((await api(token, "GET", `/api/projects/${p.id}/chat`)).body);
      expect(chat.match(/The GitHub App can't reach/g)).toHaveLength(1);
      expect(chat).toContain(`The GitHub App can't reach ${p.repo}: the App isn't installed on it, so agents' GitHub tokens were revoked`);
      expect(chat).not.toMatch(/GitHub 404|asked for/);
      expect(chat).toMatch(/so agents' GitHub tokens were revoked and new agents wait to start\. Install the App on the repo\. The app checks again every 30 minutes and will tell you when it's back\./);
      expect(chat).not.toMatch(/Select the repo/);
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
    expect(await ghRow(p, "push")).toMatchObject({ gone: 0, error: null, refusals: 0 });
    // And told it's back, once.
    const chat = JSON.stringify((await api(token, "GET", `/api/projects/${p.id}/chat`)).body);
    expect(chat.match(/reaches .* again/g)).toHaveLength(1);
  });

  it("the installation lacking a permission the token needs: the owner told as such, retried later, nothing revoked", async () => {
    const p = await newProject();
    await assigned(p);
    const had = secret(p, "push")!.value;
    const inst = fake.github.installations.find((i) => i.id === GH_INSTALLATION_ID)!;
    const saved = { ...inst.permissions };
    inst.permissions = { ...saved, pull_requests: "read" };
    try {
      await dueNow(p, "push");
      await drain(p);
      const row = await ghRow(p, "push");
      expect(row).toMatchObject({ gone: 0, refusals: 0 });
      expect(row!.error).toBe("The GitHub App's installation doesn't grant everything the workers' push token needs (contents: write, pull_requests: write; GitHub doesn't say which is missing)");
      expect(row!.next_ms as number).toBeGreaterThan(Date.now() + 20 * 60_000);
      expect(secret(p, "push")!.value).toBe(had);
      expect(tokenOf(had)).toBeDefined();
      const chat = JSON.stringify((await api(token, "GET", `/api/projects/${p.id}/chat`)).body);
      expect(chat).toContain("The GitHub App's installation doesn't grant everything the workers' push token needs (contents: write, pull_requests: write; GitHub doesn't say which is missing). Give the GitHub App Contents: read and write and Pull requests: read and write in the App's own settings (Permissions & events) if it lacks them, then accept them in its installation settings on GitHub. Agents keep their current token until it expires; the app tries again every 30 minutes.");
      expect(chat).not.toMatch(/can't reach|asked for/);
    } finally {
      inst.permissions = saved;
    }
  });

  it("the repo rebound to another repo under another name: the old one's tokens revoked, both written for the new one, and live layers' guards name it", async () => {
    const p = await newProject();
    const w = await assigned(p);
    expect(layerGuards(w.assignee!)).toEqual(githubGuards(p.repo, "push"));
    const old = [secret(p, "read")!.value, secret(p, "push")!.value];
    const to = await rebindInDirectory(p);
    await stub(p).githubRebound();
    await drain(p);
    await drain(p);
    for (const t of old) expect(tokenOf(t)).toBeUndefined();
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(to);
    expect(tokenOf(secret(p, "read")!.value)!.repo).toBe(to);
    expect(layerGuards(w.assignee!), "the worker's").toEqual(githubGuards(to, "push"));
    expect(layerGuards(p.manager!), "the manager's").toEqual(githubGuards(to, "read"));
    // Told again (a sync's read, the operator's retry): nothing more happens.
    const now = [secret(p, "read")!.value, secret(p, "push")!.value];
    await stub(p).githubRebound();
    await drain(p);
    expect([secret(p, "read")!.value, secret(p, "push")!.value]).toEqual(now);
    for (const t of now) expect(tokenOf(t)).toBeDefined();
  });

  it("a rebind whose notice to ProjectDO failed is followed at the operator's retry (the binding unchanged by then)", async () => {
    const p = await newProject();
    await assigned(p);
    const old = [secret(p, "read")!.value, secret(p, "push")!.value];
    fake.github.rename(p.repo, `${p.repo}-old`);
    const newId = fake.github.take(p.repo);
    const { ProjectDO } = await import("../src/do/project");
    const proto = ProjectDO.prototype as any;
    const orig = proto.githubRebound;
    proto.githubRebound = async function () { throw new Error("ProjectDO unreachable for now"); };
    let first: number | string;
    try {
      first = await api(token, "POST", `/api/admin/bindings/${p.id}/bind`, { repo_id: newId }).then((r) => r.status, (e) => `threw ${e}`);
    } finally {
      proto.githubRebound = orig;
    }
    // The bind landed in DirectoryDO; ProjectDO never heard.
    const bound = await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => st.storage.sql.exec("SELECT repo_id FROM projects WHERE id = ?", p.id).one());
    expect(bound.repo_id).toBe(newId);
    for (const t of old) expect(tokenOf(t), `first bind ${first}`).toBeDefined();
    const again = await api(token, "POST", `/api/admin/bindings/${p.id}/bind`, { repo_id: newId });
    expect(again.status).toBe(200);
    await drain(p);
    for (const t of old) expect(tokenOf(t), "an old repo's token left valid").toBeUndefined();
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(p.repo);
  });

  it("a rebind no notice reached is followed at the next start, which never takes the old repo's token", async () => {
    const p = await newProject();
    await assigned(p);
    const old = [secret(p, "read")!.value, secret(p, "push")!.value];
    const to = await rebindInDirectory(p);
    const w = await assigned(p);
    expect(w.state, JSON.stringify(w)).not.toBe("failed");
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(to);
    expect(layerGuards(w.assignee!)).toEqual(githubGuards(to, "push"));
    await drain(p);
    for (const t of old) expect(tokenOf(t), "an old repo's token left valid").toBeUndefined();
  });

  it("a rename applied (the same repo id): live layers' guards follow the new name", async () => {
    const p = await newProject();
    const w = await assigned(p);
    const to = `${p.repo}-moved`;
    fake.github.rename(p.repo, to);
    const r = await api(token, "POST", `/api/admin/bindings/${p.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rename).toEqual({ applied: to });
    await drain(p);
    expect(layerGuards(w.assignee!), "the worker's").toEqual(githubGuards(to, "push"));
    expect(layerGuards(p.manager!), "the manager's").toEqual(githubGuards(to, "read"));
  });

  it("a start right after a rebind, before its refresh: never takes the old repo's token, still unexpired", async () => {
    const p = await newProject();
    await assigned(p);
    const old = secret(p, "push")!.value;
    const out = await alarmHeld(p, async (o: any) => {
      const to = await rebindInDirectory(p);
      await o.githubRebound();
      await o.ensureGithub(nestFrom(env as any)!, "push");
      return to;
    });
    expect(secret(p, "push")!.value).not.toBe(old);
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(out);
  });

  it("a rebind there and back (X, Y, X) before Y's token is written: a start doesn't take X's revoked token", async () => {
    const p = await newProject();
    await assigned(p);
    const x = await boundRow(p);
    const y = `n-${rand()}/x-${rand()}`.toLowerCase();
    const out = await alarmHeld(p, async (o: any) => {
      const nest = nestFrom(env as any)!;
      const old = secret(p, "push")!.value;
      await bindTo(p, y, fake.github.repo(y).id);
      await o.githubRebound();
      // Y's refresh hasn't written; the revokes owed run.
      await o.githubCleanup(nest);
      await bindTo(p, p.repo, x.repo_id);
      await o.githubRebound();
      await o.ensureGithub(nest, "push");
      return { old, now: secret(p, "push")!.value };
    });
    expect(tokenOf(out.old)).toBeUndefined();
    expect(out.now).not.toBe(out.old);
    expect(tokenOf(out.now), "the start took a revoked token").toBeDefined();
  });

  it("X, Y, X with no live worker: the next worker's token is a live one, refreshed before it expires", async () => {
    const p = await newProject();
    await assigned(p);
    const x = await boundRow(p);
    const y = `n-${rand()}/x-${rand()}`.toLowerCase();
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      await bindTo(p, y, fake.github.repo(y).id);
      await o.githubRebound();
      await o.githubCleanup(nest);
      await bindTo(p, p.repo, x.repo_id);
      await o.githubRebound();
      // The alarm's upkeep with no worker live: the push refresh lapses.
      st.storage.sql.exec("UPDATE gh_access SET next_ms = NULL WHERE kind = 'push'");
      await o.ensureGithub(nest, "push");
      // The new worker's layer holds it.
      o.githubHolds("push");
      const r = st.storage.sql.exec("SELECT next_ms, expires_ms FROM gh_access WHERE kind = 'push'").one();
      return { next: r.next_ms as number, expires: r.expires_ms as number, valid: tokenOf(secret(p, "push")!.value) !== undefined };
    });
    expect(out.valid).toBe(true);
    expect(out.next).toBeLessThanOrEqual(out.expires - REFRESH_BEFORE_MS + 1000);
  });

  it("a toggle across a refresh's write with no live worker: the next start doesn't take the token written and revoked", async () => {
    // The App can't grant workflows: on, the push token is written without it (`wf_refused`), fresh either way.
    const p = await newProject();
    const w = await assigned(p);
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    await drain(p);
    expect((await ghRow(p, "push"))!.wf_refused).toBe(1);
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
    let release!: () => void;
    const hold = { match: /^PUT \/v1\/clients\/self\/secrets\/gh-push-/, release: new Promise<void>((r) => { release = r; }), reached: false };
    fake.holds.push(hold);
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      // A refresh in flight; turned off meanwhile: what it writes is stale, revoked at once, and nothing holds
      // the token to write it again.
      const r = o.refreshGithub(nest, "push");
      for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((x) => setTimeout(x, 5));
      const inflight = st.storage.sql.exec("SELECT token FROM gh_tokens WHERE kind = 'push' ORDER BY seq DESC LIMIT 1").one().token as string;
      const u = o.updateSettings({ workers_edit_workflows: false });
      release();
      await Promise.all([r, u]);
      const held = secret(p, "push")!.value;
      await o.githubCleanup(nest);
      await o.ensureGithub(nest, "push");
      return { inflight, held, now: secret(p, "push")!.value };
    });
    expect(out.held).toBe(out.inflight);
    expect(tokenOf(out.inflight)).toBeUndefined();
    expect(tokenOf(out.now), "the start took the revoked token").toBeDefined();
  });

  it("a start's binding read in flight across a rebind's notice: never moves the access back to the old repo", async () => {
    const p = await newProject();
    await assigned(p);
    const y = `n-${rand()}/x-${rand()}`.toLowerCase();
    const idY = fake.github.repo(y).id;
    const proto = DirectoryDO.prototype as any;
    const orig = proto.binding;
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let reached!: () => void;
    const inRead = new Promise<void>((r) => { reached = r; });
    let hold = true;
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      const old = secret(p, "push")!.value;
      proto.binding = async function (this: unknown, ...a: unknown[]) {
        const r = await orig.apply(this, a);
        if (hold) { hold = false; reached(); await gate; }
        return r;
      };
      let e: Promise<unknown>;
      try {
        e = o.ensureGithub(nest, "push").then(() => "ok", (x: unknown) => `threw ${x}`);
        await inRead;
      } finally {
        proto.binding = orig;
      }
      await bindTo(p, y, idY);
      await o.githubRebound();
      const gen = o.ghGen;
      const revokes = () => st.storage.sql.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE revoke = 1").one().n as number;
      const revoked = revokes();
      open();
      const res = await e!;
      // The read from before the notice was ignored: no rebind back to X (nothing more revoked, no new generation).
      return { old, now: secret(p, "push")!.value, res, follows: st.storage.sql.exec("SELECT gh_repo_id FROM settings").one().gh_repo_id, genMoved: o.ghGen - gen, revokedAfter: revokes() - revoked };
    });
    expect(out.follows).toBe(idY);
    expect(out.genMoved).toBe(0);
    expect(out.revokedAfter).toBe(0);
    expect(out.now, "the start took the old repo's token").not.toBe(out.old);
    if (out.res === "ok") expect(tokenOf(out.now)!.repo).toBe(y);
  });

  it("a rebind followed by a refresh alone, then another's notice: followed (the refresh held the binding's own generation)", async () => {
    const p = await newProject();
    await assigned(p);
    const y = await rebindInDirectory(p);
    // No notice: the refresh's own read follows Y (nothing else reads the binding meanwhile).
    await alarmHeld(p, async (o: any) => {
      await o.refreshGithub(nestFrom(env as any)!, "push");
    });
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(y);
    expect(await sql(p, (s) => s.exec("SELECT gh_repo_gen FROM settings").one().gh_repo_gen)).toBe((await boundRow(p)).repo_gen);
    // Then another rebind, told by its notice.
    const z = `n-${rand()}/z-${rand()}`.toLowerCase();
    await bindTo(p, z, fake.github.repo(z).id);
    await stub(p).githubRebound();
    expect(await sql(p, (s) => s.exec("SELECT gh_repo_id FROM settings").one().gh_repo_id)).toBe(fake.github.repo(z).id);
    await drain(p);
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(z);
  });

  it("a refresh that, having followed Y, mints for Z bound meanwhile: no start takes that token while the access follows Y", async () => {
    const p = await newProject();
    await assigned(p);
    const y = `n-${rand()}/y-${rand()}`.toLowerCase();
    const z = `n-${rand()}/z-${rand()}`.toLowerCase();
    const idY = fake.github.repo(y).id;
    const idZ = fake.github.repo(z).id;
    await bindTo(p, y, idY);
    const proto = DirectoryDO.prototype as any;
    const orig = proto.binding;
    let reads = 0;
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      // The refresh's first read answers Y; Z is bound right after it, so its read after following answers Z.
      proto.binding = async function (this: any, ...a: unknown[]) {
        const r = await orig.apply(this, a);
        if (++reads === 1) this.ctx.storage.sql.exec("UPDATE projects SET repo = ?, repo_id = ? WHERE id = ?", z, idZ, p.id);
        return r;
      };
      try {
        await o.refreshGithub(nest, "push");
      } finally {
        proto.binding = orig;
      }
      const row = st.storage.sql.exec("SELECT repo_id FROM gh_access WHERE kind = 'push'").one();
      return { minted: row.repo_id, follows: st.storage.sql.exec("SELECT gh_repo_id FROM settings").one().gh_repo_id, fresh: o.githubFresh("push") };
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(out).toEqual({ minted: idZ, follows: idY, fresh: false });
  });

  it("a write to nest whose answer was lost (it landed): its token, revoked, is no start's", async () => {
    const p = await newProject();
    await assigned(p);
    const { Nest } = await import("../src/nest");
    const nproto = Nest.prototype as any;
    const origPut = nproto.putSecret;
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      nproto.putSecret = async function (this: unknown, ...a: unknown[]) {
        await origPut.apply(this, a);
        throw new Error("nest's answer was lost");
      };
      try {
        await dueNow(p, "push");
        await o.refreshGithub(nest, "push");
      } finally {
        nproto.putSecret = origPut;
      }
      const lost = secret(p, "push")!.value;
      await o.githubCleanup(nest);
      await o.ensureGithub(nest, "push");
      return { lost, now: secret(p, "push")!.value };
    });
    expect(tokenOf(out.lost)).toBeUndefined();
    expect(out.now).not.toBe(out.lost);
    expect(tokenOf(out.now), "the start took the revoked token").toBeDefined();
  });

  it("a read without a generation (a DirectoryDO of the previous release): followed only to another repo, the generation held kept", async () => {
    const p = await newProject();
    await assigned(p);
    const y = `n-${rand()}/y-${rand()}`.toLowerCase();
    const idY = fake.github.repo(y).id;
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const before = st.storage.sql.exec("SELECT gh_repo_id, gh_repo_gen FROM settings").one();
      const gen = o.ghGen;
      await o.githubRebound({ repo_id: before.gh_repo_id });
      const same = { gen: o.ghGen - gen, row: st.storage.sql.exec("SELECT gh_repo_id, gh_repo_gen FROM settings").one() };
      await o.githubRebound({ repo_id: idY });
      return { before, same, after: st.storage.sql.exec("SELECT gh_repo_id, gh_repo_gen FROM settings").one(), moved: o.ghGen - gen };
    });
    expect(out.same).toEqual({ gen: 0, row: out.before });
    expect(out.after).toEqual({ gh_repo_id: idY, gh_repo_gen: out.before.gh_repo_gen });
    expect(out.moved).toBe(1);
  });

  it("DirectoryDO unreachable at a start: the start throws, nothing minted", async () => {
    const p = await newProject();
    await assigned(p);
    const proto = DirectoryDO.prototype as any;
    const orig = proto.binding;
    const before = fake.github.mints().length;
    proto.binding = async function () { throw new Error("DirectoryDO down"); };
    try {
      const r = await alarmHeld(p, async (o: any) => o.ensureGithub(nestFrom(env as any)!, "push").then(() => "ok", (x: unknown) => `threw ${x}`));
      expect(r).toMatch(/threw/);
    } finally {
      proto.binding = orig;
    }
    expect(fake.github.mints().length).toBe(before);
  });

  it("a stale notice (a read from before the rebind) landing after it: ignored, no old-repo token minted after", async () => {
    const p = await newProject();
    await assigned(p);
    const x = await boundRow(p);
    const y = `n-${rand()}/x-${rand()}`.toLowerCase();
    const idY = fake.github.repo(y).id;
    const olds = [secret(p, "push")!.value, secret(p, "read")!.value];
    const out = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      await bindTo(p, y, idY);
      await o.githubRebound();
      const mintsBefore = fake.github.mints().length;
      const revokesBefore = st.storage.sql.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE revoke = 1").one().n;
      // A sync's read from before the rebind, delivered late: older than the one followed, so ignored at once
      // (not followed back to X, revoking Y's, then forward again).
      await o.githubRebound({ repo_id: x.repo_id, gen: x.repo_gen });
      expect(st.storage.sql.exec("SELECT gh_repo_id FROM settings").one().gh_repo_id).toBe(idY);
      expect(st.storage.sql.exec("SELECT COUNT(*) AS n FROM gh_tokens WHERE revoke = 1").one().n).toBe(revokesBefore);
      await o.drain();
      await o.drain();
      const xMints = fake.github.mints().slice(mintsBefore).filter((m: any) => m.repository_ids?.[0] === x.repo_id).length;
      return { xMints, follows: st.storage.sql.exec("SELECT gh_repo_id FROM settings").one().gh_repo_id };
    });
    expect(out.xMints).toBe(0);
    expect(out.follows).toBe(idY);
    for (const t of olds) expect(tokenOf(t)).toBeUndefined();
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(y);
    expect(tokenOf(secret(p, "read")!.value)!.repo).toBe(y);
  });

  it("the project removed while a refresh follows a rebind: no secret left, every token revoked", async () => {
    const p = await newProject();
    await assigned(p);
    const y = `n-${rand()}/x-${rand()}`.toLowerCase();
    await bindTo(p, y, fake.github.repo(y).id);
    let release!: () => void;
    const hold = { match: /^PUT \/v1\/clients\/self\/secrets\/gh-push-/, release: new Promise<void>((r) => { release = r; }), reached: false };
    fake.holds.push(hold);
    const toks = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      st.storage.sql.exec("UPDATE gh_access SET next_ms = 0 WHERE kind = 'push'");
      const r = o.refreshGithub(nest, "push").catch(() => {});
      for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((x) => setTimeout(x, 5));
      st.storage.sql.exec("DELETE FROM settings");
      await o.githubTeardown(nest);
      release();
      await r;
      await o.githubCleanup(nest);
      return st.storage.sql.exec("SELECT token FROM gh_tokens").toArray().map((x: any) => x.token as string);
    });
    expect(hold.reached).toBe(true);
    expect(secret(p, "push")).toBeUndefined();
    for (const t of toks) expect(tokenOf(t)).toBeUndefined();
  });

  it("a rebind no notice reached is followed at the next refresh", async () => {
    const p = await newProject();
    await assigned(p);
    const old = secret(p, "push")!.value;
    const to = await rebindInDirectory(p);
    await dueNow(p, "push");
    await drain(p);
    await drain(p);
    expect(tokenOf(old)).toBeUndefined();
    expect(tokenOf(secret(p, "push")!.value)!.repo).toBe(to);
  });

  it("the binding's installation not the one answering for the repo now: no token minted from it, the error says to re-read", async () => {
    const p = await newProject();
    await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, st) => {
      st.storage.sql.exec("UPDATE projects SET installation_id = ? WHERE id = ?", 990_001, p.id);
    });
    const before = fake.github.mints().length;
    const t = await assigned(p);
    expect(t.state).toBe("assigned");
    expect(fake.github.mints().filter((m) => m.permissions?.pull_requests === "write").length).toBe(fake.github.mints().slice(0, before).filter((m) => m.permissions?.pull_requests === "write").length);
    expect((await ghRow(p, "push"))!.error).toMatch(/not the bound 990001: re-read the binding/);
  });

  it("only while something holds it: an idle project's token lapses; a new holder schedules it again", async () => {
    const p = await newProject();
    const w = await assigned(p);
    // The worker ends: nothing holds the push token, so its refresh lapses.
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
    const before = mintsOf(p.repo, { contents: "write", pull_requests: "write" }).length;
    await dueNow(p, "push");
    await drain(p);
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" }).length).toBe(before);
    expect((await ghRow(p, "push"))!.next_ms).toBeNull();
    // The manager still holds the read token: refreshed.
    await dueNow(p, "read");
    const reads = mintsOf(p.repo, { contents: "read", metadata: "read" }).length;
    await drain(p);
    expect(mintsOf(p.repo, { contents: "read", metadata: "read" }).length).toBe(reads + 1);
    // A new worker holds it again: its start writes it if it expires soon, and it's scheduled.
    await sql(p, (s) => s.exec("UPDATE gh_access SET expires_ms = ? WHERE kind = 'push'", Date.now() + 60_000));
    await assigned(p);
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" }).length).toBe(before + 1);
    expect((await ghRow(p, "push"))!.next_ms).not.toBeNull();
  });

  it("a refresh whose write lands after the project's teardown deleted everything: its secret deleted again, and its token revoked", async () => {
    const p = await newProject();
    await assigned(p);
    let release!: () => void;
    const hold = { match: /^PUT \/v1\/clients\/self\/secrets\/gh-push-/, release: new Promise<void>((r) => { release = r; }), reached: false };
    fake.holds.push(hold);
    const inflight = await alarmHeld(p, async (o: any, st: DurableObjectState) => {
      const nest = nestFrom(env as any)!;
      const p1 = o.refreshGithub(nest, "push");
      for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
      expect(hold.reached).toBe(true);
      await runInDurableObject(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")), (_o, d) => { d.storage.sql.exec("DELETE FROM projects WHERE id = ?", p.id); });
      const t = st.storage.sql.exec("SELECT token FROM gh_tokens WHERE kind = 'push' ORDER BY seq DESC LIMIT 1").one().token as string;
      // The project goes meanwhile: its teardown revokes, deletes and, nothing left owed, forgets every row.
      st.storage.sql.exec("UPDATE settings SET listed_ms = NULL");
      await o.alarm();
      expect(st.storage.sql.exec("SELECT COUNT(*) AS n FROM gh_access").one().n).toBe(0);
      release();
      await p1;
      return t;
    });
    expect(secret(p, "push"), "the secret written after the teardown left in nest").toBeUndefined();
    expect(tokenOf(inflight)).toBeUndefined();
  });

  it("a worker started while the lapsed push token still has 20 minutes left: its start takes it as it is, and the new holder schedules its refresh (due now: under 30 minutes left)", async () => {
    const p = await newProject();
    const w = await assigned(p);
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
    await dueNow(p, "push");
    await drain(p);
    expect((await ghRow(p, "push"))!.next_ms).toBeNull();
    // Lapsed, with more than a start's 10 minutes left but less than the refresh's 30: nothing writes it unless the holder schedules it.
    await sql(p, (s) => s.exec("UPDATE gh_access SET expires_ms = ? WHERE kind = 'push'", Date.now() + 20 * 60_000));
    const had = secret(p, "push")!.value;
    const before = mintsOf(p.repo, { contents: "write", pull_requests: "write" }).length;
    const w2 = await assigned(p);
    // The start took the token as it was (more than 10 minutes left)...
    const create = createOf({ project: p.id, task: w2.id })[0]!;
    expect(create.body.inject.map((x: { name: string }) => x.name)).toEqual(["gh_push"]);
    // ...and the holder scheduled the refresh the lapse had dropped, which ran: a new token, its next write scheduled.
    expect(mintsOf(p.repo, { contents: "write", pull_requests: "write" }).length, "the new holder left the token to expire").toBe(before + 1);
    expect(secret(p, "push")!.value).not.toBe(had);
    expect((await ghRow(p, "push"))!.next_ms as number).toBeGreaterThan(Date.now());
  });

  it("an ended agent's sandbox: nest's 409 (destroyed already) is done; one it can't take is given up after its tries, and forgotten", async () => {
    const p = await newProject();
    const a = await assigned(p);
    fake.fail(/^DELETE \/v1\/sandboxes\//, 409, { times: 1 });
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: a.assignee!, reason: "done" });
    await drain(p);
    expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM sandbox_ends WHERE agent = ?", a.assignee).one().n)).toBe(0);
    const b = await assigned(p);
    fake.fail(/^DELETE \/v1\/sandboxes\//, 503, { times: 100 });
    try {
      await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: b.assignee!, reason: "done" });
      await drain(p);
      await sql(p, (s) => s.exec("UPDATE sandbox_ends SET attempts = 11, next_ms = 0 WHERE agent = ?", b.assignee));
      await drain(p);
      expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM sandbox_ends WHERE agent = ?", b.assignee).one().n)).toBe(0);
      const tries = fake.callsTo("DELETE", new RegExp(`/v1/sandboxes/${fake.agents.get(b.assignee!)!.sandbox}$`)).length;
      await drain(p);
      expect(fake.callsTo("DELETE", new RegExp(`/v1/sandboxes/${fake.agents.get(b.assignee!)!.sandbox}$`)).length).toBe(tries);
    } finally {
      fake.failures = [];
    }
  });

  it("an ended agent's sandbox is destroyed, whatever its role: its binding and guards go with it", async () => {
    const p = await newProject();
    const w = await assigned(p);
    const sbx = fake.agents.get(w.assignee!)!.sandbox!;
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: w.assignee!, reason: "done" });
    await drain(p);
    expect(fake.sandboxes.get(sbx)!.ended).toBe(true);
    // A reviewer's too (ReviewDO's stop of an ended agent destroys nothing).
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 11, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const r = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer")!;
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: r.agent, reason: "done" });
    await drain(p);
    expect(fake.sandboxes.get(r.sandbox!)!.ended).toBe(true);
    // A destroy nest can't take now is retried.
    const m = fake.agents.get((await assigned(p)).assignee!)!;
    fake.fail(/^DELETE \/v1\/sandboxes\//, 503, { times: 1 });
    await deliver({ id: `evt-${crypto.randomUUID()}`, type: "agent.exited", agent: m.agent, reason: "done" });
    await drain(p);
    expect(fake.sandboxes.get(m.sandbox!)!.ended).toBe(false);
    expect(await sql(p, (s) => s.exec("SELECT attempts FROM sandbox_ends WHERE agent = ?", m.agent).one().attempts)).toBe(1);
    await sql(p, (s) => s.exec("UPDATE sandbox_ends SET next_ms = 0 WHERE next_ms IS NOT NULL"));
    await drain(p);
    expect(fake.sandboxes.get(m.sandbox!)!.ended).toBe(true);
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
    // Armed for its retry: the object's own alarm, the project gone, deletes what's left.
    expect(await runInDurableObject(stub(p), (_o, st) => st.storage.getAlarm())).not.toBeNull();
    await sql(p, (s) => s.exec("UPDATE gh_access SET del_next_ms = 0 WHERE gone = 1"));
    await runInDurableObject(stub(p), (o) => (o as unknown as { alarm(): Promise<void> }).alarm());
    expect(secret(p, "push")).toBeUndefined();
    expect(await sql(p, (s) => s.exec("SELECT COUNT(*) AS n FROM gh_access").one().n)).toBe(0);
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
      // Retried, the guards in its sandbox's create each time, refused there: nothing made, no window without them.
      await sql(p, (s) => s.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id));
      await drain(p);
      const tries = createOf({ project: p.id, task: t.id });
      expect(tries.length).toBeGreaterThanOrEqual(2);
      for (const c of tries) expect(c.body.guards).toEqual(githubGuards(p.repo, "push"));
      expect([...fake.sandboxes.values()].filter((x) => x.labels.task === t.id)).toEqual([]);
      expect(agentCreateOf({ project: p.id, task: t.id })).toEqual([]);
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

  it("a nest from before its code (conflict, in its words) is told apart the same; another conflict isn't", async () => {
    const p = await newProject();
    fake.hostsBehind = 1;
    fake.hostsCode = "conflict";
    try {
      const t = await assigned(p);
      expect(t.state).toBe("assigned");
      expect(t.start_error).toContain(HOSTS_WAIT);
    } finally {
      fake.hostsBehind = 0;
      fake.hostsCode = "hosts_not_ready";
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
