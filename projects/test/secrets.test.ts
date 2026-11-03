// A project's secrets (README.md#secrets): values go to nest at once and nowhere else in the app; nest's
// names are project-scoped; each role's sandboxes get the bindings for it, frozen per start attempt; the
// brief names placeholders and hosts, never values; agents request secrets as "Needs you" items; the
// workflows setting reaches worker sandboxes only; the grant's limits are checked and shown.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, agentClaims, api, callTool, CLIENT, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

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
const npm = (value?: string, roles = ["worker"]) => ({ ...(value ? { value } : {}), description: "npm publish", hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }], roles });
async function assignedWorker(p: P) {
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
  return { task: t.id as string, worker: a.assignee as string };
}
const sandboxOf = (agent: string) => fake.sandboxes.get(fake.agents.get(agent)!.sandbox!)!;

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
    expect(fake.secrets.get(`${p.id}-npm_token`)?.value).toBe(value);
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
    expect(fake.secrets.get(`${p.id}-npm_token`)?.value).toBe(value);
    expect((await put(p, "other", npm())).status).toBe(400);
  });

  it("is per project: two projects' secrets of one name are two in nest, and deleting one keeps the other", async () => {
    const a = await newProject();
    const b = await newProject();
    await put(a, "npm_token", npm(valueOf("a")));
    await put(b, "npm_token", npm(valueOf("b")));
    expect(fake.secrets.get(`${a.id}-npm_token`)?.value).toBe(valueOf("a"));
    expect(fake.secrets.get(`${b.id}-npm_token`)?.value).toBe(valueOf("b"));
    expect((await api(token, "DELETE", `/api/projects/${a.id}/secrets/npm_token`)).status).toBe(200);
    expect(fake.secrets.has(`${a.id}-npm_token`)).toBe(false);
    expect(fake.secrets.has(`${b.id}-npm_token`)).toBe(true);
    expect((await api(token, "GET", `/api/projects/${b.id}/secrets`)).body.secrets.map((x: { name: string }) => x.name)).toEqual(["npm_token"]);
  });
});

describe("injection", () => {
  it("binds a secret on the sandboxes of its roles only, and names its placeholder and hosts in the brief", async () => {
    const p = await newProject();
    await put(p, "npm_token", npm(valueOf("w"), ["worker"]));
    await put(p, "cf_token", { value: valueOf("r"), description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "header", name: "X-Auth-Key" }], roles: ["reviewer"] });
    const w = await assignedWorker(p);
    expect(sandboxOf(w.worker).inject).toEqual([{ name: "npm_token", secret: `${p.id}-npm_token`, hosts: ["registry.npmjs.org"], locations: [{ type: "authorization_bearer" }] }]);
    const brief = fake.inbox.find((m) => m.agent === w.worker)!.text;
    expect(brief).toContain(`NPM_TOKEN=nest-ph.${CLIENT}.npm_token.`);
    expect(brief).toContain("on registry.npmjs.org, as Authorization: Bearer <placeholder>");
    expect(brief).not.toContain("cf_token");
    // A reviewer gets its own.
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: sha(), action: "opened" }));
    await env.REVIEW.get(env.REVIEW.idFromName(p.id)).drain();
    const reviewer = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer")!;
    expect(sandboxOf(reviewer.agent).inject!.map((b) => b.name)).toEqual(["cf_token"]);
    expect(fake.inbox.find((m) => m.agent === reviewer.agent)!.text).toContain(`CF_TOKEN=nest-ph.${CLIENT}.cf_token.`);
    // The manager, started before either, has none.
    expect(sandboxOf(p.manager).inject).toEqual([]);
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
  });

  it("deleting a secret names the live agents that had it", async () => {
    const p = await newProject();
    await put(p, "npm_token", npm(valueOf("d")));
    const w = await assignedWorker(p);
    expect((await api(token, "GET", `/api/projects/${p.id}/secrets`)).body.secrets[0].holders).toEqual([{ agent: w.worker, role: "worker" }]);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/secrets/npm_token`)).body).toEqual({ deleted: "npm_token", holders: [{ agent: w.worker, role: "worker" }] });
  });
});

describe("the grant", () => {
  it("refuses a host outside inject_hosts, a value too large, and past max_count, and shows its limits", async () => {
    const p = await newProject();
    const outside = await put(p, "x_token", { ...npm(valueOf("o")), hosts: ["api.stripe.com"] });
    expect(outside.status).toBe(400);
    expect(outside.body.problems.hosts).toMatch(/api\.stripe\.com is outside the hosts this app may inject into \(api\.cloudflare\.com, registry\.npmjs\.org, \*\.example\.com\): the operator must widen the grant's inject_hosts/);
    // A wildcard within the grant's.
    expect((await put(p, "wild", { ...npm(valueOf("w")), hosts: ["*.api.example.com"] })).status).toBe(200);
    expect((await put(p, "big", npm("y".repeat(5000)))).body.problems.value).toMatch(/at most 4096/);
    expect((await put(p, "Bad-Name", npm(valueOf("n")))).body.problems.name).toBeDefined();
    const saved = fake.grant.secrets.max_count;
    fake.grant.secrets.max_count = fake.secrets.size;
    try {
      const full = await put(p, "one_more", npm(valueOf("m")));
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
    await put(p, "cf_token", { value: valueOf("c"), description: "", hosts: ["api.cloudflare.com"], locations: [{ type: "authorization_bearer" }], roles: ["manager"] });
    expect((await api(token, "GET", `/api/projects/${p.id}/attention`)).body).toEqual([]);
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    expect(fake.inbox.some((m) => m.agent === p.manager && m.text.includes("set up the secret cf_token"))).toBe(true);
  });
});

describe("workers editing CI workflows", () => {
  it("is off by default; on, it reaches worker sandboxes only; refused when the grant doesn't allow it", async () => {
    const p = await newProject();
    expect((await api(token, "GET", `/api/projects/${p.id}`)).body.settings.workers_edit_workflows).toBe(false);
    const before = await assignedWorker(p);
    expect(sandboxOf(before.worker).github_push).toBeNull();
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { workers_edit_workflows: true })).body.workers_edit_workflows).toBe(true);
    const after = await assignedWorker(p);
    expect(sandboxOf(after.worker).github_push).toEqual({ workflows: true });
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
