// The board's JSON API (src/api.ts) and what it makes nest do, against README.md#flows and the client
// interface (docs/control-plane/api/clients/): a fake nest records every call, and a key pair made here
// plays Cloudflare Access.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import worker from "../src/worker";
import { AccessTeam, api, APP, CELL, FakeNest, installFetch } from "./fake-nest";

const fake = new FakeNest();
let restore: () => void;
let team: AccessTeam;
let token: string;

beforeAll(async () => {
  team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const spec = { goal: "Do the thing", acceptance_criteria: ["it works"], files: ["src/a.ts"], test_plan: "npm test" };

async function newProject(o: { auto_assign?: boolean; max_workers?: number } = {}) {
  const repo = `owner-${rand()}/repo-${rand()}`;
  const r = await api(token, "POST", "/api/projects", { name: `p ${repo}`, repo, ...o });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: r.body.id as string, repo, body: r.body };
}

async function readyTask(project: string, title = "a task") {
  const t = await api(token, "POST", `/api/projects/${project}/tasks`, { title, body: "details" });
  expect(t.status).toBe(201);
  const s = await api(token, "PUT", `/api/projects/${project}/tasks/${t.body.id}/spec`, spec);
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  return s.body as { id: string; state: string };
}

const workersOf = (project: string) => [...fake.agents.values()].filter((a) => a.labels.project === project && a.labels.role === "worker");
const liveWorkersOf = (project: string) => workersOf(project).filter((a) => !a.ended);

describe("the Access check", () => {
  it("refuses the page and the API without a valid token for the app's application", async () => {
    const wrongAud = await team.token({ aud: ["another-application"] });
    for (const t of [undefined, "junk", wrongAud]) {
      for (const path of ["/", "/index.html", "/api/projects", "/api/admin/sync"]) {
        const res = await SELF.fetch(`${APP}${path}`, { method: path.endsWith("sync") ? "POST" : "GET", headers: t ? { "cf-access-jwt-assertion": t } : {} });
        expect(res.status, `${path} ${t}`).toBe(403);
      }
    }
  });

  it("serves the page with a strict Content-Security-Policy: only the app's own scripts, nothing framing it", async () => {
    // The test pool has no assets: the Worker's handler, with a stand-in for them.
    const assets = { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) };
    const req = new Request(`${APP}/`, { headers: { "cf-access-jwt-assertion": await team.token() } });
    const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], { ...env, ASSETS: assets } as unknown as Parameters<typeof worker.fetch>[1]);
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("isn't asked of /hooks/* and /mcp/*, which have their own proof", async () => {
    // No Access token: each answers its own refusal, not Access's 403 page.
    expect((await SELF.fetch(`${APP}/hooks/nest`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await SELF.fetch(`${APP}/hooks/github`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await SELF.fetch(`${APP}/mcp/board`, { method: "POST", body: "{}" })).status).toBe(401);
  });
});

describe("projects", () => {
  it("creating one records it, writes the catalog with its repo and starts its manager", async () => {
    const p = await newProject();
    expect(p.body.repo).toBe(p.repo.toLowerCase());
    expect(p.body.catalog_synced).toBe(true);
    // The manager and the reviewer only read the repos; the worker pushes to them.
    for (const role of ["manager", "reviewer"]) {
      const tmpl = fake.catalog.get(`templates/projects/${role}`) as { repos?: string[]; read_repos?: string[] };
      expect(tmpl.read_repos, role).toContain(p.repo.toLowerCase());
      expect(tmpl.repos, role).toBeUndefined();
    }
    const worker = fake.catalog.get("templates/projects/worker") as { repos?: string[]; read_repos?: string[] };
    expect(worker.repos).toContain(p.repo.toLowerCase());
    expect(worker.read_repos).toBeUndefined();
    const managers = [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "manager");
    expect(managers).toHaveLength(1);
    const m = managers[0]!;
    expect(m.template).toBe("projects/manager");
    expect(m.sandbox).toMatch(/^sbx_/);
    expect(fake.sandboxes.get(m.sandbox!)!.labels).toEqual(m.labels);
    // It reads its project's repo and pushes to none.
    expect(m.overrides).toEqual({ read_repos: [p.repo.toLowerCase()] });
    expect(p.body.settings.manager).toBe(m.agent);
    expect(fake.inbox.find((x) => x.agent === m.agent)?.text).toContain(p.repo.toLowerCase());
    // The cell goes where nest takes it: in each create's body, which carries an Idempotency-Key.
    const creates = fake.calls.filter((c) => c.method === "POST" && (c.path === "/v1/agents" || c.path === "/v1/sandboxes"));
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const c of creates) {
      expect(c.body.cell).toBe(CELL);
      expect(c.idempotencyKey).toMatch(new RegExp(`^${p.id}/manager/1/(sandbox|agent)$`));
    }
    expect(fake.calls.filter((c) => c.query.has("cell") && c.method !== "GET")).toEqual([]);

    const list = await api(token, "GET", "/api/projects");
    expect(list.body.projects.map((x: { id: string }) => x.id)).toContain(p.id);
    const one = await api(token, "GET", `/api/projects/${p.id}`);
    expect(one.body.settings.repo).toBe(p.repo.toLowerCase());
  });

  it("refuses a second project for the same repo, and a malformed repo", async () => {
    const p = await newProject();
    expect((await api(token, "POST", "/api/projects", { name: "again", repo: p.repo.toUpperCase() })).status).toBe(409);
    expect((await api(token, "POST", "/api/projects", { name: "bad", repo: "not-a-repo" })).status).toBe(400);
    expect((await api(token, "GET", "/api/projects/prj_doesnotexist")).status).toBe(404);
  });

  it("retries the manager's start from the alarm until nest takes it, failing twice first", async () => {
    fake.fail(/^POST \/v1\/agents$/, 500, { times: 2 });
    const p = await newProject();
    expect(p.body.settings.manager).toBeNull();
    expect(p.body.settings.manager_error).toMatch(/500/);
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    for (let i = 0; i < 2; i++) {
      // Make the retry due now, then run the alarm (the backoff is seconds).
      await runInDurableObject(stub, (_o, st) => {
        st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0");
      });
      await stub.drain();
    }
    const s = await api(token, "GET", `/api/projects/${p.id}/settings`);
    expect(s.body.manager).toMatch(/^agt_/);
    expect(s.body.manager_error).toBeNull();
    // Each attempt sent the same keys, so the sandbox the first one made came back: one sandbox, one manager.
    expect([...fake.sandboxes.values()].filter((x) => x.labels.project === p.id)).toHaveLength(1);
    expect([...fake.agents.values()].filter((a) => a.labels.project === p.id)).toHaveLength(1);
  });

  it("a create whose answer was lost is sent again with its key, and nest answers the one it made", async () => {
    fake.lost.push({ match: /^POST \/v1\/agents$/, times: 1 });
    const p = await newProject();
    expect(p.body.settings.manager).toBeNull();
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    await runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("UPDATE settings SET manager_next_ms = 0"); });
    await stub.drain();
    const managers = [...fake.agents.values()].filter((a) => a.labels.project === p.id);
    expect(managers).toHaveLength(1);
    expect((await api(token, "GET", `/api/projects/${p.id}/settings`)).body.manager).toBe(managers[0]!.agent);
  });

  it("retries a 503 nest marks retryable, within the call", async () => {
    fake.fail(/^POST \/v1\/sandboxes$/, 503, { retryable: true, times: 2 });
    const p = await newProject();
    expect(p.body.settings.manager).toMatch(/^agt_/);
  });
});

describe("tasks", () => {
  it("are created as drafts, specced to ready, edited, reordered and deleted only as drafts", async () => {
    const p = await newProject();
    const a = await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "first" });
    const b = await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "second" });
    expect(a.body.state).toBe("draft");
    expect(b.body.ord).toBeGreaterThan(a.body.ord);
    expect((await api(token, "PATCH", `/api/projects/${p.id}/tasks/${b.body.id}`, { ord: a.body.ord - 1, title: "second!" })).body.title).toBe("second!");
    const list = await api(token, "GET", `/api/projects/${p.id}/tasks`);
    expect(list.body.map((t: { id: string }) => t.id)).toEqual([b.body.id, a.body.id]);
    const specced = await api(token, "PUT", `/api/projects/${p.id}/tasks/${a.body.id}/spec`, spec);
    expect(specced.body).toMatchObject({ state: "ready", spec });
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${a.body.id}`)).status).toBe(409);
    expect((await api(token, "DELETE", `/api/projects/${p.id}/tasks/${b.body.id}`)).status).toBe(200);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${b.body.id}`)).status).toBe(404);
    const full = await api(token, "GET", `/api/projects/${p.id}/tasks/${a.body.id}`);
    expect(full.body.history.map((h: { action: string; actor: string }) => `${h.actor} ${h.action}`)).toEqual(["owner created", "owner spec"]);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "" })).status).toBe(400);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "x", extra: 1 })).status).toBe(400);
  });

  it("refuses assigning a task that isn't specced", async () => {
    const p = await newProject();
    const t = await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "draft" });
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.body.id}/assign`)).status).toBe(409);
    expect(workersOf(p.id)).toHaveLength(0);
  });

  it("assigning starts one worker labelled with the task, its sandbox pushing only to the repo, its spec as its first input", async () => {
    const p = await newProject();
    const t = await readyTask(p.id, "build it");
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.state).toBe("in_progress");
    const ws = workersOf(p.id);
    expect(ws).toHaveLength(1);
    const w = ws[0]!;
    expect(w.labels).toEqual({ project: p.id, role: "worker", task: t.id, start: "1" });
    expect(w.template).toBe("projects/worker");
    expect(w.overrides).toEqual({ repos: [p.repo.toLowerCase()] });
    expect(fake.sandboxes.get(w.sandbox!)!.labels).toEqual(w.labels);
    expect(r.body.assignee).toBe(w.agent);
    const brief = fake.inbox.filter((x) => x.agent === w.agent);
    expect(brief).toHaveLength(1);
    for (const part of [t.id, `task/${t.id}`, "build it", spec.goal, spec.acceptance_criteria[0]!, spec.test_plan]) expect(brief[0]!.text).toContain(part);
    // The owner wrote the spec: the brief comes from the client itself, untainted.
    expect(brief[0]!.from).toBeUndefined();
  });

  it("a task that nest refuses a worker for (a 4xx) stalls with the reason, and can be reassigned", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    fake.fail(/^POST \/v1\/agents$/, 403);
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(r.body.state).toBe("stalled");
    expect(r.body.start_error).toMatch(/403/);
    const again = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(again.body.state).toBe("in_progress");
    expect(workersOf(p.id).map((w) => w.labels.start)).toEqual(["2"]);
  });

  it("a create nest is still handling (409, retryable) is retried within the call", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    fake.inProgress.push({ match: new RegExp(`^${p.id}/${t.id}/1/agent$`), times: 2 });
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(r.body.state).toBe("in_progress");
    expect(workersOf(p.id)).toHaveLength(1);
  });

  it("a key nest says was used for another request (409, not retryable) stalls the task", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    fake.keys.set(`${p.id}/${t.id}/1/agent`, { digest: "another request", status: 201, body: "{}" });
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(r.body.state).toBe("stalled");
    expect(r.body.start_error).toMatch(/409/);
    expect(workersOf(p.id)).toHaveLength(0);
  });

  it("a worker whose start fails for now is retried, twice, without a second worker", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    fake.fail(/^POST \/v1\/agents\/agt_\w+\/inbox$/, 500, { times: 2 });
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    expect(r.body.state).toBe("assigned");
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    for (let i = 0; i < 2; i++) {
      await runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE id = ?", t.id); });
      await stub.drain();
    }
    const now = await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`);
    expect(now.body.state).toBe("in_progress");
    expect(workersOf(p.id)).toHaveLength(1);
  });

  it("cancelling stops the task's worker for good, sandbox and all", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    const w = workersOf(p.id)[0]!;
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/cancel`, { reason: "not needed" });
    expect(r.body.state).toBe("cancelled");
    const stops = fake.callsTo("POST", new RegExp(`^/v1/agents/${w.agent}/stop$`));
    expect(stops.map((c) => c.body)).toEqual([{ end: true, destroy_sandbox: true, reason: "cancelled" }]);
    expect(fake.sandboxes.get(w.sandbox!)!.ended).toBe(true);
    expect((await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/cancel`, {})).status).toBe(409);
  });

  it("marks done by hand only a task with no PR and no live worker; a running one is refused and keeps its worker", async () => {
    const p = await newProject();
    const t = await readyTask(p.id);
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`);
    const refused = await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/done`);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/worker is running/);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t.id}`)).body.state).toBe("in_progress");
    expect(liveWorkersOf(p.id)).toHaveLength(1);

    const noPr = await readyTask(p.id, "research, no PR");
    const r = await api(token, "POST", `/api/projects/${p.id}/tasks/${noPr.id}/done`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("done");
  });
});

describe("auto-assign", () => {
  it("assigns ready tasks in board order while live workers are under max_workers, and the next as one finishes", async () => {
    const p = await newProject({ auto_assign: true, max_workers: 2 });
    const t1 = await readyTask(p.id, "one");
    const t2 = await readyTask(p.id, "two");
    const t3 = await readyTask(p.id, "three");
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    await stub.drain();
    expect(liveWorkersOf(p.id).map((w) => w.labels.task).sort()).toEqual([t1.id, t2.id].sort());
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${t3.id}`)).body.state).toBe("ready");
    // One is cancelled: its place goes to the next ready task once its worker is stopped.
    await api(token, "POST", `/api/projects/${p.id}/tasks/${t1.id}/cancel`, {});
    await stub.drain();
    expect(liveWorkersOf(p.id).map((w) => w.labels.task).sort()).toEqual([t2.id, t3.id].sort());
    expect(liveWorkersOf(p.id)).toHaveLength(2);
  });

  it("turning it on, or raising the cap, assigns what is ready", async () => {
    const p = await newProject({ max_workers: 1 });
    await readyTask(p.id, "one");
    await readyTask(p.id, "two");
    expect(liveWorkersOf(p.id)).toHaveLength(0);
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { auto_assign: true });
    expect(liveWorkersOf(p.id)).toHaveLength(1);
    const s = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_workers: 3 });
    expect(s.body).toMatchObject({ auto_assign: true, max_workers: 3 });
    expect(liveWorkersOf(p.id)).toHaveLength(2);
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_workers: -1 })).status).toBe(400);
  });
});

describe("chat and approvals", () => {
  it("the owner's message goes to the manager's inbox, once, and is logged", async () => {
    const p = await newProject();
    const r = await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "hello manager" });
    expect(r.status).toBe(201);
    expect(r.body.delivered).toBe(true);
    const m = p.body.settings.manager as string;
    const posted = fake.inbox.filter((x) => x.agent === m && x.text === "hello manager");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.request_id).toBe(`${p.id}/chat/${r.body.seq}`);
    const log = await api(token, "GET", `/api/projects/${p.id}/chat`);
    expect(log.body.map((x: { sender: string; text: string }) => `${x.sender}: ${x.text}`)).toEqual(["owner: hello manager"]);
  });

  it("a message nest can't take now is kept and sent again by the alarm", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents\/agt_\w+\/inbox$/, 500);
    const r = await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "later" });
    expect(r.body.delivered).toBe(false);
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    await runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("UPDATE chat SET next_ms = 0 WHERE next_ms IS NOT NULL"); });
    await runDurableObjectAlarm(stub);
    const log = await api(token, "GET", `/api/projects/${p.id}/chat`);
    expect(log.body[0]).toMatchObject({ text: "later", delivered: true });
  });

  it("a message nest refuses for good (the manager ended) is kept, marked undelivered, and not sent again", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents\/agt_\w+\/inbox$/, 404);
    const r = await api(token, "POST", `/api/projects/${p.id}/chat`, { text: "anyone?" });
    expect(r.body.delivered).toBe(false);
    const sent = fake.callsTo("POST", /\/inbox$/).length;
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    expect(fake.callsTo("POST", /\/inbox$/).length).toBe(sent);
    const log = await api(token, "GET", `/api/projects/${p.id}/chat`);
    expect(log.body[0]).toMatchObject({ text: "anyone?", delivered: false, error: expect.stringMatching(/404/) });
  });
});

describe("the catalog sync", () => {
  it("is idempotent: a second run writes the same entries with the same bodies", async () => {
    await newProject();
    const first = await api(token, "POST", "/api/admin/sync");
    expect(first.status).toBe(200);
    const snapshot = new Map(fake.catalog);
    const puts = fake.callsTo("PUT", /^\/v1\/catalog\//).length;
    const second = await api(token, "POST", "/api/admin/sync");
    expect(second.body.written).toEqual(first.body.written);
    expect(fake.callsTo("PUT", /^\/v1\/catalog\//).length - puts).toBe(6);
    expect(new Map(fake.catalog)).toEqual(snapshot);
    expect([...fake.catalog.keys()].sort()).toEqual([
      "capabilities/projects/board", "capabilities/projects/review", "capabilities/projects/task",
      "templates/projects/manager", "templates/projects/reviewer", "templates/projects/worker",
    ]);
    expect((await api(token, "GET", "/api/admin/sync")).status).toBe(405);
  });

  it("names the app's MCP servers and ties each template to its own", async () => {
    await api(token, "POST", "/api/admin/sync");
    const cap = (n: string) => fake.catalog.get(`capabilities/projects/${n}`) as { mcp: { url: string; tools: string[]; read_only: string[] } };
    for (const n of ["board", "task", "review"]) expect(cap(n).mcp.url).toBe(`${APP}/mcp/${n}`);
    expect(cap("board").mcp.read_only.sort()).toEqual(["get_task", "list_tasks"]);
    const tmpl = (n: string) => fake.catalog.get(`templates/projects/${n}`) as { capabilities: string[]; hands: string; credential: string };
    expect(tmpl("manager").capabilities).toContain("projects/board");
    expect(tmpl("worker").capabilities).toContain("projects/task");
    expect(tmpl("reviewer").capabilities).toContain("projects/review");
    expect(tmpl("worker").capabilities).not.toContain("projects/board");
  });
});
