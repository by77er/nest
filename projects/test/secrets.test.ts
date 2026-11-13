// A project's secrets (README.md#secrets): values go to nest at once and nowhere else in the app; nest's
// names are project-scoped; each role's sandboxes get the bindings and variables for it, at the create
// (frozen per start attempt) and live through their client layer, which keeps the network's rules; the
// brief names variables and hosts, never placeholders or values; agents request secrets as "Needs you"
// items; the workflows setting reaches worker sandboxes only; the grant's limits are checked and shown.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, agentClaims, api, callTool, CLIENT, deliverGithub, FakeNest, githubPart, installFetch, prEvent, Signer } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let token: string;
let nest: Signer;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
  nest = await Signer.create("k1");
  fake.jwks = { keys: [await nest.jwk()] };
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };
/** A value no test text otherwise contains, low in entropy (dev/review-lessons.md 9), built at run time. */
const valueOf = (tag: string) => `value-of-${tag}-${"x".repeat(12)}`;

async function newProject() {
  const repo = `o-${rand()}/r-${rand()}`.toLowerCase();
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  return { id: p.id as string, repo, manager: p.settings.manager as string };
}
type P = Awaited<ReturnType<typeof newProject>>;
const put = (p: P, name: string, body: Record<string, unknown>) => api(token, "PUT", `/api/projects/${p.id}/secrets/${name}`, body);
const npm = (value?: string, roles = ["worker"], env = "NPM_TOKEN") =>
  ({ ...(value ? { value } : {}), description: "npm publish", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }], roles, env });
const cf = (value?: string, roles = ["manager"]) =>
  ({ ...(value ? { value } : {}), description: "DNS", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }], roles, env: "CLOUDFLARE_API_TOKEN" });
const drain = (p: P) => env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
const layerPuts = (agent: string) => fake.callsTo("PUT", new RegExp(`/v1/sandboxes/${fake.agents.get(agent)!.sandbox!}/client-policy$`));
async function assignedWorker(p: P) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
  return { task: t.id as string, worker: a.assignee as string };
}
/**
 * A worker whose start was frozen before the app's own GitHub access (README.md#repo-authority): on nest's repos,
 * with nest's push opt-in as the settings had it, as a start in flight across that release is. Its template is
 * written with the repo, and its layer keeps nest's opt-in (B4 converges such workers).
 */
async function legacyWorker(p: P, o: { workflows?: boolean; assign?: boolean } = {}) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const frozen = { extras: o.workflows ? { github_push: { workflows: true } } : {}, names: [], brief: "", rev: 0, model: "claude-opus-5-5" };
  await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => {
    st.storage.sql.exec("INSERT INTO start_specs (key, spec, at_ms) VALUES (?, ?, ?)", `${p.id}/${t.id}/1`, JSON.stringify(frozen), Date.now());
  });
  if (o.assign === false) return { task: t.id as string, worker: "" };
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
  expect(fake.agents.get(a.assignee)!.overrides).toEqual({ repos: [p.repo] });
  return { task: t.id as string, worker: a.assignee as string };
}
/** nest's name for a project's secret: `<project>-<name>-<generation>`, the generation new at each creation. */
const nestKey = (p: { id: string }, name: string) => [...fake.secrets.keys()].find((k) => new RegExp(`^${p.id}-${name}-[a-z0-9]{6}$`).test(k));
const sandboxOf = (agent: string) => fake.sandboxes.get(fake.agents.get(agent)!.sandbox!)!;
/**
 * A sandbox's client layer less the app's own GitHub part (README.md#repo-authority: its binding, variables and
 * hosts, test/github-access.test.ts), which these tests about the owner's secrets keep beside it.
 */
const ownerLayer = (agent: string) => {
  const l = sandboxOf(agent).layer;
  const gh = new Set(githubPart("x", "worker").egress.map((r) => r.host));
  return {
    egress: { allow: (l.egress.allow as { host: string }[]).filter((r) => !gh.has(r.host)) },
    inject: (l.inject as { name: string }[]).filter((b) => !["gh_push", "gh_read"].includes(b.name)),
    env: Object.fromEntries(Object.entries(l.env).filter(([k]) => k !== "GH_TOKEN" && !k.startsWith("GIT_CONFIG"))),
  };
};

/** Every value in every table of an object, as text. */
const dump = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_o: unknown, st: DurableObjectState) => {
    const tables = st.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray();
    return JSON.stringify(tables.map((t) => st.storage.sql.exec(`SELECT * FROM "${t.name as string}"`).toArray()));
  });

describe("a secret's value", () => {
  it("goes to nest, under a project-scoped name, and is in none of the app's objects or answers", async () => {
    const p = await newProject();
    const value = valueOf(rand());
    const r = await put(p, "npm_token", npm(value));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(fake.secrets.get(nestKey(p, "npm_token")!)?.value).toBe(value);
    const w = await assignedWorker(p);
    // Every answer the board reads.
    const answers = [
      r.body,
      (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body,
      (await api(token, "GET", `/api/projects/${p.id}`)).body,
      (await api(token, "GET", `/api/projects/${p.id}/tasks/${w.task}`)).body,
      (await api(token, "GET", `/api/projects/${p.id}/attention`)).body,
      (await api(token, "GET", "/api/projects")).body,
    ];
    for (const a of answers) expect(JSON.stringify(a)).not.toContain(value);
    // Nor any of the app's Durable Objects, nor any message to an agent.
    expect(await dump(env.PROJECT.get(env.PROJECT.idFromName(p.id)) as unknown as DurableObjectStub)).not.toContain(value);
    expect(await dump(env.DIRECTORY.get(env.DIRECTORY.idFromName("directory")) as unknown as DurableObjectStub)).not.toContain(value);
    expect(await dump(env.REVIEW.get(env.REVIEW.idFromName(p.id)) as unknown as DurableObjectStub)).not.toContain(value);
    expect(JSON.stringify(fake.inbox)).not.toContain(value);
    // Editing without a value keeps nest's, and is refused for a new secret.
    expect((await put(p, "npm_token", { ...npm(), description: "renamed" })).body.description).toBe("renamed");
    expect(fake.secrets.get(nestKey(p, "npm_token")!)?.value).toBe(value);
    expect((await put(p, "other", npm())).status).toBe(400);
  });

  it("is per project: two projects' secrets of one name are two in nest, and deleting one keeps the other", async () => {
    const a = await newProject();
    const b = await newProject();
    await put(a, "npm_token", npm(valueOf("a")));
    await put(b, "npm_token", npm(valueOf("b")));
    expect((await put(a, "other_npm", npm(valueOf("a2")))).body.problems).toEqual({ env: "Another secret uses NPM_TOKEN" });
    expect(fake.secrets.get(nestKey(a, "npm_token")!)?.value).toBe(valueOf("a"));
    expect(fake.secrets.get(nestKey(b, "npm_token")!)?.value).toBe(valueOf("b"));
    expect((await api(token, "DELETE", `/api/projects/${a.id}/secrets/npm_token`)).status).toBe(200);
    expect(nestKey(a, "npm_token")).toBeUndefined();
    expect(nestKey(b, "npm_token")).toBeDefined();
    expect((await api(token, "GET", `/api/projects/${b.id}/secrets`)).body.secrets.map((x: { name: string }) => x.name)).toEqual(["npm_token"]);
  });
});

describe("injection", () => {
  it("binds a secret on the sandboxes of its roles only, its variable holding the placeholder; the brief names the variable", async () => {
    const p = await newProject();
    await put(p, "npm_token", npm(valueOf("w"), ["worker"]));
    await put(p, "cf_token", { value: valueOf("r"), description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "header", name: "X-Auth-Key" }], roles: ["reviewer"], env: "CF_AUTH_KEY" });
    const w = await assignedWorker(p);
    expect(ownerLayer(w.worker).inject).toEqual([{ name: "npm_token", secret: nestKey(p, "npm_token")!, hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] }]);
    expect(ownerLayer(w.worker).env).toEqual({ NPM_TOKEN: `nest-ph.${CLIENT}.npm_token.` });
    const brief = fake.inbox.find((m) => m.agent === w.worker)!.text;
    expect(brief).toContain("- $NPM_TOKEN (npm publish): registry.npmjs.org, as a bearer token.");
    expect(brief).not.toContain("nest-ph.");
    expect(brief).not.toContain("CF_AUTH_KEY");
    // A reviewer gets its own.
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const reviewer = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer")!;
    expect((ownerLayer(reviewer.agent).inject as { name: string }[]).map((b) => b.name)).toEqual(["cf_token"]);
    expect(ownerLayer(reviewer.agent).env).toEqual({ CF_AUTH_KEY: `nest-ph.${CLIENT}.cf_token.` });
    expect(fake.inbox.find((m) => m.agent === reviewer.agent)!.text).toContain("- $CF_AUTH_KEY: api.cloudflare.com, as the X-Auth-Key header.");
    // The manager, started before either, has none.
    expect(ownerLayer(p.manager).inject).toEqual([]);
  });

  it("a start attempt's sandbox is the same request on a retry, though the secrets changed meanwhile", async () => {
    const p = await newProject();
    await put(p, "npm_token", npm(valueOf("x")));
    fake.lost.push({ match: /^POST \/v1\/sandboxes$/, times: 1 });
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    await put(p, "npm_token", npm(undefined, ["manager"]));
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"); });
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    const task = (await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body;
    expect(task.state, JSON.stringify(task)).toBe("in_progress");
    expect([...fake.sandboxes.values()].filter((x) => x.labels.task === t.id)).toHaveLength(1);
    // Created as first asked, with the binding; the change since is owed to its layer once it's live.
    const worker = task.assignee as string;
    // (Its binding, and the app's GitHub one.)
    expect(fake.callsTo("POST", /^\/v1\/sandboxes$/).filter((c) => c.body.labels?.task === t.id).every((c) => c.body.inject?.map((b: { name: string }) => b.name).join() === "npm_token,gh_push")).toBe(true);
    await drain(p);
    expect(ownerLayer(worker)).toMatchObject({ inject: [], env: {} });
  });

  it("deleting a secret names the live agents that had it, and takes it out of their layers", async () => {
    const p = await newProject();
    await put(p, "npm_token", npm(valueOf("d")));
    const w = await assignedWorker(p);
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.secrets[0].holders).toEqual([{ agent: w.worker, role: "worker" }]);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/secrets/npm_token`)).body).toEqual({ deleted: "npm_token", holders: [{ agent: w.worker, role: "worker" }] });
    await drain(p);
    expect(ownerLayer(w.worker)).toMatchObject({ inject: [], env: {} });
    const view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: w.worker, state: "applied" })]));
  });
});

describe("live agents", () => {
  it("a secret added, re-roled or edited reaches live layers at once, keeping each role's network rules", async () => {
    const p = await newProject();
    expect((await api(token, "PUT", `/api/projects/${p.id}/network`, { worker: [], manager: [{ host: "nodejs.org" }] })).status).toBe(200);
    const w = await assignedWorker(p);
    const workerPuts = layerPuts(w.worker).length;
    // Added for the manager: its live layer gets the binding and its variable, beside its rules.
    expect((await put(p, "cf_token", cf(valueOf("c")))).status).toBe(200);
    await drain(p);
    const binding = { name: "cf_token", secret: nestKey(p, "cf_token")!, hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }] };
    expect(ownerLayer(p.manager)).toEqual({ egress: { allow: [{ host: "nodejs.org" }] }, inject: [binding], env: { CLOUDFLARE_API_TOKEN: `nest-ph.${CLIENT}.cf_token.` } });
    // Not for workers: nothing written to theirs.
    expect(layerPuts(w.worker).length).toBe(workerPuts);
    let view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.secrets[0].holders).toEqual([{ agent: p.manager, role: "manager" }]);
    expect(view.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: p.manager, role: "manager", state: "applied" })]));
    // Moved to workers: it leaves the manager's layer (its rules kept) and joins the worker's.
    await put(p, "cf_token", cf(undefined, ["worker"]));
    await drain(p);
    expect(ownerLayer(p.manager)).toEqual({ egress: { allow: [{ host: "nodejs.org" }] }, inject: [], env: {} });
    expect(ownerLayer(w.worker)).toMatchObject({ inject: [binding], env: { CLOUDFLARE_API_TOKEN: `nest-ph.${CLIENT}.cf_token.` } });
    view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.secrets[0].holders).toEqual([{ agent: w.worker, role: "worker" }]);
    // A new variable name reaches it too.
    await put(p, "cf_token", { ...cf(undefined, ["worker"]), env: "CF_API_TOKEN" });
    await drain(p);
    expect(ownerLayer(w.worker).env).toEqual({ CF_API_TOKEN: `nest-ph.${CLIENT}.cf_token.` });
    // A new value, or a new description, changes no layer: nest pushes the value to the proxies itself.
    const before = fake.callsTo("PUT", /\/client-policy$/).length;
    await put(p, "cf_token", { ...cf(valueOf("c2"), ["worker"]), env: "CF_API_TOKEN", description: "renamed" });
    await drain(p);
    expect(fake.callsTo("PUT", /\/client-policy$/).length).toBe(before);
    // And a network change afterwards keeps the secrets in the layer (one feed each, one layer).
    await api(token, "PUT", `/api/projects/${p.id}/network`, { worker: [{ host: "pypi.org" }], manager: [{ host: "nodejs.org" }] });
    expect(ownerLayer(w.worker)).toEqual({ egress: { allow: [{ host: "pypi.org" }] }, inject: [binding], env: { CF_API_TOKEN: `nest-ph.${CLIENT}.cf_token.` } });
  });

  it("a layer nest refuses shows as failed on the Secrets page; a retry after a transient one applies it", async () => {
    const p = await newProject();
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403, { times: 2 });
    await put(p, "cf_token", cf(valueOf("f")));
    await drain(p);
    let agents = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents;
    expect(agents).toEqual([expect.objectContaining({ agent: p.manager, state: "failed", error: expect.stringContaining("403") })]);
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.secrets[0].holders).toEqual([]);
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 503);
    await put(p, "cf_token", { ...cf(undefined), env: "CF_TOKEN" });
    await drain(p);
    agents = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents;
    expect(agents[0].state).toBe("pending");
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE layers SET next_ms = 0 WHERE next_ms IS NOT NULL");
    });
    await drain(p);
    agents = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents;
    expect(agents[0]).toMatchObject({ state: "applied", error: null });
    expect(ownerLayer(p.manager).env).toEqual({ CF_TOKEN: `nest-ph.${CLIENT}.cf_token.` });
  });

  it("a grant narrowed away from one secret never holds back another's removal; the narrowed one is left out and shown", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    await put(p, "npm_token", npm(valueOf("b"), ["manager"]));
    await drain(p);
    expect((ownerLayer(p.manager).inject as { name: string }[]).map((b) => b.name).sort()).toEqual(["cf_token", "npm_token"]);
    const saved = [...fake.grant.inject_hosts];
    fake.grant.inject_hosts = saved.filter((h) => h !== "api.cloudflare.com");
    try {
      expect((await api(token, "DELETE", `/api/projects/${p.id}/secrets/npm_token`)).status).toBe(200);
      await drain(p);
      // npm_token is gone; cf_token, outside the grant now, is left out rather than refused with it.
      expect(ownerLayer(p.manager)).toMatchObject({ inject: [], env: {} });
      const view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
      expect(view.agents).toEqual([expect.objectContaining({ agent: p.manager, state: "applied", error: null })]);
      expect(view.secrets.find((x: { name: string }) => x.name === "cf_token").outside_hosts).toEqual(["api.cloudflare.com"]);
    } finally {
      fake.grant.inject_hosts = saved;
    }
  });

  it("a layer nest refuses still applies what it removes", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    await put(p, "npm_token", npm(valueOf("b"), ["manager"]));
    await drain(p);
    // Refused for good, once: the full layer. The removal alone goes out after it.
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403, { times: 2 });
    await api(token, "DELETE", `/api/projects/${p.id}/secrets/npm_token`);
    await drain(p);
    expect((ownerLayer(p.manager).inject as { name: string }[]).map((b) => b.name)).toEqual(["cf_token"]);
    expect(Object.keys(ownerLayer(p.manager).env)).toEqual(["CLOUDFLARE_API_TOKEN"]);
    const view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.agents[0]).toMatchObject({ state: "failed", error: expect.stringContaining("what it removes is applied") });
    expect(view.secrets.find((x: { name: string }) => x.name === "cf_token").holders).toEqual([{ agent: p.manager, role: "manager" }]);
  });

  it("without the grant: a save is refused (503), and a removal still applies, and only it", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    await put(p, "npm_token", npm(valueOf("b"), ["manager"]));
    await drain(p);
    fake.fail(/GET \/v1\/clients\/self/, 503, { times: 10 });
    try {
      const r = await put(p, "late_token", { ...cf(valueOf("c")), env: "LATE_TOKEN" });
      expect(r.status).toBe(503);
      expect(nestKey(p, "late_token")).toBeUndefined();
      await api(token, "DELETE", `/api/projects/${p.id}/secrets/npm_token`);
      await drain(p);
      // npm_token went; cf_token, unchanged, stays (an unknown grant isn't an empty one).
      expect((ownerLayer(p.manager).inject as { name: string }[]).map((b) => b.name)).toEqual(["cf_token"]);
      expect(Object.keys(ownerLayer(p.manager).env)).toEqual(["CLOUDFLARE_API_TOKEN"]);
      expect((await api(token, "GET", `/api/projects/${p.id}/network`)).body.agents[0]).toMatchObject({ state: "pending", error: expect.stringContaining("grant couldn't be read") });
    } finally {
      fake.failures = fake.failures.filter((f) => !f.match.test("GET /v1/clients/self"));
    }
  });

  it("a refusal is tried once more against the grant read again (it may have narrowed meanwhile)", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    await drain(p);
    const before = layerPuts(p.manager).length;
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403);
    await put(p, "npm_token", npm(valueOf("b"), ["manager"]));
    await drain(p);
    expect(layerPuts(p.manager).length).toBe(before + 2);
    expect((ownerLayer(p.manager).inject as { name: string }[]).map((b) => b.name).sort()).toEqual(["cf_token", "npm_token"]);
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents[0]).toMatchObject({ state: "applied", error: null });
  });

  it("a grant widened again brings a left-out secret back by itself, at the next upkeep", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    await drain(p);
    const upkeep = () => runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE settings SET secrets_next_ms = 0");
    }).then(() => drain(p));
    await upkeep();
    const saved = [...fake.grant.inject_hosts];
    try {
      fake.grant.inject_hosts = saved.filter((h) => h !== "api.cloudflare.com");
      await upkeep();
      expect(ownerLayer(p.manager).inject).toEqual([]);
      fake.grant.inject_hosts = saved;
      await upkeep();
      expect((ownerLayer(p.manager).inject as { name: string }[]).map((b) => b.name)).toEqual(["cf_token"]);
    } finally {
      fake.grant.inject_hosts = saved;
    }
  });

  it("a value write racing a delete can't record the deleted generation's name again", async () => {
    const p = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    // The Worker read the name for a new value; the secret is deleted before the write is recorded.
    const old = (await stub.nestNameFor("cf_token", true))!;
    expect(old).toBe(nestKey(p, "cf_token"));
    await api(token, "DELETE", `/api/projects/${p.id}/secrets/cf_token`);
    const r = await stub.saveSecretMeta({ name: "cf_token", description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }], roles: ["manager"], env: "CLOUDFLARE_API_TOKEN", nest_name: old }, 10);
    expect(r).toMatchObject({ ok: false, status: 409 });
    // A new one gets a new generation, used once.
    const fresh = (await stub.nestNameFor("cf_token", true))!;
    expect(fresh).not.toBe(old);
    const meta = { name: "cf_token", description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" as const }], roles: ["manager" as const], env: "CLOUDFLARE_API_TOKEN", nest_name: fresh };
    expect((await stub.saveSecretMeta(meta, 10)).ok).toBe(true);
    await stub.deleteSecretMeta("cf_token");
    expect(await stub.saveSecretMeta(meta, 10)).toMatchObject({ ok: false, status: 409 });
  });

  it("the sweep deletes this project's nest secrets no row names, once past the grace", async () => {
    const p = await newProject();
    const other = await newProject();
    await put(p, "cf_token", cf(valueOf("a")));
    const long = Date.now() - 3_600_000;
    const ghost = { value: "x", description: null, created_ms: long, updated_ms: long, last_injected_ms: null };
    fake.secrets.set(`${p.id}-ghost-aaaaaa`, ghost);
    fake.secrets.set(`${p.id}-young-aaaaaa`, { ...ghost, created_ms: Date.now(), updated_ms: Date.now() });
    fake.secrets.set(`${other.id}-ghost-aaaaaa`, ghost);
    // A listing without times: of unknown age, so kept.
    fake.secrets.set(`${p.id}-untimed-aaaaaa`, { ...ghost, created_ms: undefined, updated_ms: undefined } as unknown as typeof ghost);
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE settings SET secrets_next_ms = 0");
    });
    await drain(p);
    expect(fake.secrets.has(`${p.id}-ghost-aaaaaa`)).toBe(false);
    expect(fake.secrets.has(`${p.id}-young-aaaaaa`)).toBe(true);
    expect(fake.secrets.has(`${other.id}-ghost-aaaaaa`)).toBe(true);
    expect(fake.secrets.has(`${p.id}-untimed-aaaaaa`)).toBe(true);
    expect(nestKey(p, "cf_token")).toBeDefined();
  });

  it("reviewers' layers follow too; a name made again is a new nest secret, which no old binding reaches", async () => {
    const p = await newProject();
    await put(p, "up_key", { value: valueOf("r1"), description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }], roles: ["reviewer"], env: "UP_KEY" });
    const first = nestKey(p, "up_key")!;
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 7, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const reviewer = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer")!.agent;
    expect(ownerLayer(reviewer).inject).toEqual([expect.objectContaining({ name: "up_key", secret: first })]);
    // Taken off reviewers: it leaves the live reviewer's layer.
    await put(p, "up_key", { ...cf(undefined, ["worker"]), hosts: ["api.cloudflare.com"], env: "UP_KEY" });
    await drain(p);
    expect(ownerLayer(reviewer)).toMatchObject({ inject: [], env: {} });
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: reviewer, role: "reviewer", state: "applied" })]));
    // Deleted and made again under its name: another nest secret, so a binding from before reaches nothing.
    await api(token, "DELETE", `/api/projects/${p.id}/secrets/up_key`);
    await put(p, "up_key", { ...cf(valueOf("r2"), ["worker"]), env: "UP_KEY" });
    const second = nestKey(p, "up_key")!;
    expect(second).not.toBe(first);
    expect(fake.secrets.has(first)).toBe(false);
    expect(fake.secrets.get(second)?.value).toBe(valueOf("r2"));
  });

  it("refuses a variable nest sets, a malformed one, or one another secret uses", async () => {
    const p = await newProject();
    for (const [v, re] of [["PATH", /set by nest/], ["NEST_AGENT", /set by nest/], ["HTTPS_PROXY", /set by nest/], ["GH_TOKEN", /take over the sandbox's GitHub token/], ["GITHUB_ENTERPRISE_TOKEN", /sandbox's GitHub token/], ["GIT_CONFIG_COUNT", /sandbox's GitHub token/], ["GIT_CONFIG_KEY_7", /sandbox's GitHub token/], ["GIT_ASKPASS", /sandbox's GitHub token/], ["lower", /Capital letters/], ["1X", /Capital letters/]] as const) {
      const r = await put(p, "x_token", { ...npm(valueOf("v")), env: v });
      expect(r.status, v).toBe(400);
      expect(r.body.problems.env).toMatch(re);
    }
    expect(nestKey(p, "x_token")).toBeUndefined();
  });
});

describe("the grant", () => {
  it("refuses a host outside inject_hosts, a value too large, and past max_count, and shows its limits", async () => {
    const p = await newProject();
    const outside = await put(p, "x_token", { ...npm(valueOf("o")), hosts: ["api.stripe.com"] });
    expect(Object.keys(outside.body.problems)).toEqual(["hosts"]);
    expect(outside.status).toBe(400);
    expect(outside.body.problems.hosts).toMatch(/api\.stripe\.com is outside the hosts this app may inject into \(api\.cloudflare\.com, registry\.npmjs\.org, \*\.example\.com, github\.com, api\.github\.com\): the operator must widen the grant's inject_hosts/);
    // A wildcard within the grant's.
    expect((await put(p, "wild", { ...npm(valueOf("w")), hosts: ["*.api.example.com"] })).status).toBe(200);
    expect((await put(p, "big", npm("y".repeat(5000), ["worker"], "BIG"))).body.problems.value).toMatch(/at most 4096/);
    expect((await put(p, "Bad-Name", npm(valueOf("n"), ["worker"], "BAD"))).body.problems.name).toBeDefined();
    const saved = fake.grant.secrets.max_count;
    fake.grant.secrets.max_count = fake.secrets.size;
    try {
      const full = await put(p, "one_more", npm(valueOf("m"), ["worker"], "ONE_MORE"));
      expect(full.status).toBe(403);
      expect(full.body.error).toMatch(/max_count/);
    } finally {
      fake.grant.secrets.max_count = saved;
    }
    const g = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.grant;
    expect(g).toMatchObject({ inject_hosts: fake.grant.inject_hosts, max_count: saved, max_bytes: 4096, workflows: true, used: fake.secrets.size });
  });
});

describe("requesting a secret", () => {
  const workerToken = (p: P, w: { task: string; worker: string }) => nest.sign(agentClaims("task", w.worker, { project: p.id, role: "worker", task: w.task, start: "1" }));
  const ok = (r: { status: number; result?: any }) => {
    expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
    return r.result.structuredContent;
  };

  it("for CI is a Needs-you item until the owner marks it done, which the agent is told", async () => {
    const p = await newProject();
    const w = await assignedWorker(p);
    const req = ok(await callTool("task", await workerToken(p, w), "request_secret", { name: "NPM_TOKEN", purpose: "publish from CI", kind: "ci" }));
    expect(req).toMatchObject({ type: "ci", name: "NPM_TOKEN", agent: w.worker, task: w.task });
    const items = (await api(token, "GET", `/api/projects/${p.id}/attention`)).body;
    expect(items).toEqual([expect.objectContaining({ kind: "secret", type: "ci", name: "NPM_TOKEN", purpose: "publish from CI" })]);
    expect(((await api(token, "GET", "/api/projects")).body.projects as any[]).find((x) => x.id === p.id).needs_you).toBe(1);
    // Asked again, the same item.
    expect(ok(await callTool("task", await workerToken(p, w), "request_secret", { name: "NPM_TOKEN", purpose: "again", kind: "ci" })).id).toBe(req.id);
    expect((await api(token, "POST", `/api/projects/${p.id}/secret-requests/${req.id}/done`)).status).toBe(200);
    expect((await api(token, "GET", `/api/projects/${p.id}/attention`)).body).toEqual([]);
    expect(fake.inbox.some((m) => m.agent === w.worker && m.text.includes("added the GitHub Actions secret NPM_TOKEN"))).toBe(true);
  });

  it("to inject is done when the owner saves a secret of its name; names are checked", async () => {
    const p = await newProject();
    const m = await nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" }));
    expect((await callTool("board", m, "request_secret", { name: "Bad Name", purpose: "p", kind: "injected" })).result.isError).toBe(true);
    expect((await callTool("board", m, "request_secret", { name: "GITHUB_TOKEN", purpose: "p", kind: "ci" })).result.isError).toBe(true);
    ok(await callTool("board", m, "request_secret", { name: "cf_token", purpose: "manage DNS", kind: "injected", hosts: ["api.cloudflare.com"] }));
    expect((await api(token, "GET", `/api/projects/${p.id}/attention`)).body[0]).toMatchObject({ kind: "secret", type: "injected", name: "cf_token", hosts: ["api.cloudflare.com"] });
    await put(p, "cf_token", cf(valueOf("c")));
    expect((await api(token, "GET", `/api/projects/${p.id}/attention`)).body).toEqual([]);
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    expect(fake.inbox.some((m) => m.agent === p.manager && m.text.includes("Your sandbox gets it as $CLOUDFLARE_API_TOKEN in a moment"))).toBe(true);
    // Asked for again once it exists: refused, naming its variable and roles.
    const again = await callTool("board", m, "request_secret", { name: "cf_token", purpose: "p", kind: "injected" });
    expect(JSON.stringify(again.result)).toContain("exists already: your sandbox has it as $CLOUDFLARE_API_TOKEN");
    // A worker, not given it, learns only that: not the variable, nor which roles have it.
    const w = await assignedWorker(p);
    const asked = JSON.stringify((await callTool("task", await workerToken(p, w), "request_secret", { name: "cf_token", purpose: "p", kind: "injected" })).result);
    expect(asked).toContain("exists already, but isn't given to your role");
    expect(asked).not.toMatch(/CLOUDFLARE_API_TOKEN|manager/);
  });
});

describe("workers editing CI workflows", () => {
  it("turned off while a start waits on the grant read: the start freezes without it", async () => {
    const p = await newProject();
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    // The start's grant read is held; the owner turns the setting off meanwhile.
    let release!: () => void;
    const hold = { match: /^GET \/v1\/clients\/self$/, release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const assigning = api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    for (let i = 0; i < 400 && !hold.reached; i++) await new Promise((r) => setTimeout(r, 5));
    expect(hold.reached).toBe(true);
    const turning = api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
    for (let i = 0; i < 400; i++) {
      if ((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.workers_edit_workflows === false) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    release();
    await Promise.all([assigning, turning]);
    await drain(p);
    const live = [...fake.sandboxes.values()].filter((x) => x.labels.task === t.id && !x.ended);
    expect(live).toHaveLength(1);
    expect(live[0]!.github_push).toBeNull();
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("in_progress");
  });

  it("reaches live workers on nest's repos both ways through their layer, each shown applied; within the grant; off goes through a refusal", async () => {
    const p = await newProject();
    const w = await legacyWorker(p);
    expect(sandboxOf(w.worker).github_push).toBeNull();
    // On: the live worker's push token may change workflows now, not only workers started from now on.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    await drain(p);
    expect(sandboxOf(w.worker).github_push).toEqual({ workflows: true });
    let view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.workflow_workers).toEqual([w.worker]);
    expect(view.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: w.worker, state: "applied" })]));
    // The manager's never gets it.
    expect(sandboxOf(p.manager).github_push).toBeNull();
    // The grant narrowed: it goes from the live worker at the next upkeep, without anyone saving.
    const saved = fake.grant.github_push;
    fake.grant.github_push = { workflows: false };
    try {
      await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_i: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE settings SET secrets_next_ms = 0"); });
      await drain(p);
      expect(sandboxOf(w.worker).github_push).toBeNull();
    } finally {
      fake.grant.github_push = saved;
    }
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_i: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE settings SET secrets_next_ms = 0"); });
    await drain(p);
    expect(sandboxOf(w.worker).github_push).toEqual({ workflows: true });
    // Off, with nest refusing the whole layer (twice: the retry against the grant read again too): the
    // removal goes through on its own.
    fake.fail(/PUT \/v1\/sandboxes\/.*\/client-policy/, 403, { times: 2 });
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
    await drain(p);
    expect(sandboxOf(w.worker).github_push).toBeNull();
    view = (await api(token, "GET", `/api/projects/${p.id}/secrets`)).body;
    expect(view.workflow_workers).toEqual([]);
    expect(view.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: w.worker, state: "failed", error: expect.stringContaining("what it removes is applied") })]));
  });

  it("to a control plane from before the push opt-in, the layer goes without it, and still applies", async () => {
    const p = await newProject();
    const w = await legacyWorker(p);
    fake.layerWithoutPush = true;
    try {
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
      await drain(p);
      const put = fake.callsTo("PUT", new RegExp(`/v1/sandboxes/${fake.agents.get(w.worker)!.sandbox!}/client-policy$`)).at(-1)!;
      expect(put.body).not.toHaveProperty("github_push");
      expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agent: w.worker, state: "applied" })]));
    } finally {
      fake.layerWithoutPush = false;
    }
  });

  it("off mid-start (one frozen on nest's repos): the attempt is abandoned for a new one without it, and what the old one made is destroyed", async () => {
    const p = await newProject();
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
    const live = await legacyWorker(p, { workflows: true });
    // A start whose sandbox was made with workflows, its answer lost: in flight.
    fake.lost.push({ match: /^POST \/v1\/sandboxes$/, times: 1 });
    const t = { id: (await legacyWorker(p, { workflows: true, assign: false })).task };
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    const made = [...fake.sandboxes.values()].filter((x) => x.labels.task === t.id);
    expect(made).toHaveLength(1);
    expect(made[0]!.github_push).toEqual({ workflows: true });
    const first = made[0]!.labels.start;
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: false });
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"); });
    await drain(p);
    // The old attempt's sandbox, found by its labels, is gone; a new attempt started without workflows.
    expect(made[0]!.ended).toBe(true);
    const fresh = [...fake.sandboxes.values()].filter((x) => x.labels.task === t.id && !x.ended);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.labels.start).not.toBe(first);
    expect(fresh[0]!.github_push).toBeNull();
    // The new attempt is frozen now: the app's own GitHub access, not nest's repos.
    expect([...fake.agents.values()].find((a) => a.sandbox === fresh[0]!.sandbox)!.overrides).toHaveProperty("guards");
    const task = (await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body;
    expect(task.state).toBe("in_progress");
    expect(task.history.some((h: { action: string }) => h.action === "start_abandoned")).toBe(true);
    // Nothing of the old attempt's was resent with its key: no 409.
    expect(fake.calls.filter((c) => c.path === "/v1/sandboxes" && c.method === "POST" && c.body.labels?.task === t.id && c.body.labels?.start === first)).toHaveLength(1);
    // The live worker that had it loses it too, through its layer.
    expect(sandboxOf(live.worker).github_push).toBeNull();
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.workflow_workers).toEqual([]);
    // Looked for once more after the lease (a create still in flight may land late), then forgotten.
    const late = { ...made[0]!, sandbox: "sbx_late1", ended: false };
    fake.sandboxes.set(late.sandbox, late);
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE abandoned SET next_ms = 0"); });
    await drain(p);
    expect(fake.sandboxes.get("sbx_late1")!.ended).toBe(true);
    expect(await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM abandoned").one().n)).toBe(0);
  });

  it("is off by default; on, a start frozen on nest's repos asks nest's opt-in for worker sandboxes only; refused when the grant doesn't allow it", async () => {
    const p = await newProject();
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.workers_edit_workflows).toBe(false);
    const before = await legacyWorker(p);
    expect(sandboxOf(before.worker).github_push).toBeNull();
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true })).body.workers_edit_workflows).toBe(true);
    const after = await legacyWorker(p, { workflows: true });
    expect(sandboxOf(after.worker).github_push).toEqual({ workflows: true });
    // A start frozen now never asks it: the project's push token carries workflows itself.
    expect(sandboxOf((await assignedWorker(p)).worker).github_push).toBeNull();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 2, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const reviewer = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer")!;
    expect(sandboxOf(reviewer.agent).github_push).toBeNull();
    expect(sandboxOf(p.manager).github_push).toBeNull();
    const saved = fake.grant.github_push;
    fake.grant.github_push = { workflows: false };
    try {
      const r = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/github_push\.workflows/);
    } finally {
      fake.grant.github_push = saved;
    }
  });
});
