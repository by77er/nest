// What each role may do over MCP (README.md#the-mcp-server-agents-see-only-their-own-work): scope comes
// from the caller's labels, every write records its taint, and a retried write (same `nest/call` key,
// docs/interfaces/remote-mcp/) is applied once.
import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, agentClaims, api, callTool, eventually, FakeNest, installFetch, mcp, Signer } from "./fake-nest";

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
const spec = { goal: "g", acceptance_criteria: ["a"], files: ["f"], test_plan: "t" };

async function newProject(o: Record<string, unknown> = {}) {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status).toBe(201);
  return { id: p.body.id as string, manager: p.body.settings.manager as string };
}

const managerToken = (p: { id: string; manager: string }, over: Record<string, unknown> = {}) =>
  nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" }, over));
const workerToken = (project: string, task: string, agent = `agt_w${rand()}`, over: Record<string, unknown> = {}) =>
  nest.sign(agentClaims("task", agent, { project, role: "worker", task, start: "1" }, over));

const ok = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError).toBe(true);
  return r.result.content[0].text as string;
};

describe("the server", () => {
  it("speaks the MCP subset nest uses", async () => {
    const p = await newProject();
    const t = await managerToken(p);
    const init = await mcp("board", t, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "nest" } });
    expect(await init.json()).toMatchObject({ jsonrpc: "2.0", result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
    const older = await mcp("board", t, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "nest" } });
    expect(((await older.json()) as any).result.protocolVersion).toBe("2025-03-26");
    expect((await mcp("board", t, "notifications/initialized")).status).toBe(202);
    const unknown = (await (await mcp("board", t, "resources/list")).json()) as any;
    expect(unknown.error.code).toBe(-32601);
    expect((await (await mcp("board", t, "tools/call", { name: "nope", arguments: {} })).json() as any).result.isError).toBe(true);
  });
});

describe("the manager", () => {
  it("reads and writes its own project's board, each write recorded with its taint", async () => {
    const p = await newProject();
    const t = await managerToken(p, { tainted: true });
    const created = ok(await callTool("board", t, "create_task", { title: "from the manager", body: "b" }));
    expect(created.state).toBe("draft");
    expect(ok(await callTool("board", t, "write_spec", { task: created.id, ...spec })).state).toBe("ready");
    const list = ok(await callTool("board", t, "list_tasks"));
    expect(list.tasks.map((x: { id: string }) => x.id)).toEqual([created.id]);
    const full = (await api(token, "GET", `/api/projects/${p.id}/tasks/${created.id}`)).body;
    expect(full.history.map((h: { actor: string; action: string; tainted: boolean }) => [h.actor, h.action, h.tainted])).toEqual([
      [p.manager, "created", true], [p.manager, "spec", true],
    ]);
  });

  it("the board marks a task tainted once any tainted session wrote to it, and only that task", async () => {
    const p = await newProject();
    const clean = await managerToken(p);
    const dirty = await managerToken(p, { tainted: true });
    const a = ok(await callTool("board", clean, "create_task", { title: "clean" }));
    const b = ok(await callTool("board", clean, "create_task", { title: "touched" }));
    const c = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "the owner's" })).body;
    ok(await callTool("board", dirty, "update_task", { task: b.id, body: "from a tainted session" }));
    // A later clean write doesn't clear it: the taint is in the history.
    ok(await callTool("board", clean, "write_spec", { task: b.id, ...spec }));
    const tasks = (await api(token, "GET", `/api/projects/${p.id}/tasks`)).body as { id: string; tainted: boolean }[];
    expect(Object.fromEntries(tasks.map((t) => [t.id, t.tainted]))).toEqual({ [a.id]: false, [b.id]: true, [c.id]: false });
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks/${b.id}`)).body.tainted).toBe(true);
  });

  it("can't reach another project's tasks", async () => {
    const a = await newProject();
    const b = await newProject();
    const tb = (await api(token, "POST", `/api/projects/${b.id}/tasks`, { title: "b's" })).body;
    const t = await managerToken(a);
    expect(toolError(await callTool("board", t, "get_task", { task: tb.id }))).toMatch(/unknown task/);
    expect(toolError(await callTool("board", t, "cancel_task", { task: tb.id }))).toMatch(/unknown task/);
    expect((await api(token, "GET", `/api/projects/${b.id}/tasks/${tb.id}`)).body.state).toBe("draft");
  });

  it("is held to its own project by the project's object too, not only by the routing", async () => {
    const a = await newProject();
    const b = await newProject();
    const tb = (await api(token, "POST", `/api/projects/${b.id}/tasks`, { title: "b's" })).body;
    const caller = { kind: "agent" as const, agent: a.manager, role: "manager" as const, labels: { project: a.id, role: "manager" }, tainted: false };
    const r = await env.PROJECT.get(env.PROJECT.idFromName(b.id)).mcpCall("board", caller, "get_task", { task: tb.id }, null);
    expect(r).toEqual({ result: null, error: "unknown project" });
  });

  it("assigns within max_workers, and the worker's brief from a tainted spec taints the worker", async () => {
    const p = await newProject({ max_workers: 1 });
    const t = await managerToken(p, { tainted: true });
    const one = ok(await callTool("board", t, "create_task", { title: "one" }));
    const two = ok(await callTool("board", t, "create_task", { title: "two" }));
    ok(await callTool("board", t, "write_spec", { task: one.id, ...spec }));
    ok(await callTool("board", t, "write_spec", { task: two.id, ...spec }));
    expect(ok(await callTool("board", t, "assign_task", { task: one.id })).state).toBe("assigned");
    expect(toolError(await callTool("board", t, "assign_task", { task: two.id }))).toMatch(/max_workers/);
    // The worker is started by the alarm, after the call answered.
    const w = await eventually(() => [...fake.agents.values()].find((a) => a.labels.task === one.id), "the worker");
    const brief = await eventually(() => fake.inbox.find((x) => x.agent === w.agent), "the brief");
    expect(brief.from).toBe("projects/board");
  });
});

describe("a worker", () => {
  async function setup() {
    const p = await newProject();
    const mine = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "mine", body: "my body" })).body;
    const other = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "other", body: "secret body" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${mine.id}/spec`, spec);
    const assigned = (await api(token, "POST", `/api/projects/${p.id}/tasks/${mine.id}/assign`)).body;
    return { p, mine, other, agent: assigned.assignee as string };
  }

  it("reads its own task, with the branch to push", async () => {
    const s = await setup();
    const got = ok(await callTool("task", await workerToken(s.p.id, s.mine.id, s.agent), "get_task"));
    expect(got).toMatchObject({ id: s.mine.id, title: "mine", body: "my body", spec, branch: `task/${s.mine.id}` });
  });

  it("can't read another task: no tool takes a task id, and its labels decide", async () => {
    const s = await setup();
    const t = await workerToken(s.p.id, s.mine.id, s.agent);
    expect(toolError(await callTool("task", t, "get_task", { task: s.other.id }))).toMatch(/not an argument/);
    // A worker labelled for the other task by the app would see that one only; one labelled for a task
    // of another project sees nothing.
    const elsewhere = await newProject();
    const t2 = await workerToken(elsewhere.id, s.other.id);
    const r = toolError(await callTool("task", t2, "get_task"));
    expect(r).toMatch(/unknown task/);
    expect(r).not.toContain("secret body");
    // Nor the board.
    expect((await callTool("board", await workerToken(s.p.id, s.mine.id, s.agent), "list_tasks")).status).toBe(401);
  });

  it("reports progress, a blocker and its PR, each recorded with its taint", async () => {
    const s = await setup();
    const t = await workerToken(s.p.id, s.mine.id, s.agent, { tainted: true });
    ok(await callTool("task", t, "report_progress", { text: "halfway" }));
    ok(await callTool("task", t, "report_blocker", { text: "need a key" }));
    expect(ok(await callTool("task", t, "report_pr", { number: 12 }))).toMatchObject({ state: "in_review", pr: 12 });
    const full = (await api(token, "GET", `/api/projects/${s.p.id}/tasks/${s.mine.id}`)).body;
    expect(full.pr).toBe(12);
    expect(full.history.slice(-3).map((h: { action: string; tainted: boolean; detail: string }) => [h.action, h.tainted])).toEqual([
      ["progress", true], ["blocker", true], ["pr_opened", true],
    ]);
    expect((await api(token, "GET", `/api/projects/${s.p.id}/tasks/${s.other.id}`)).body.history).toHaveLength(1);
  });
});

describe("a retried write", () => {
  it("is applied once for the caller's own call key", async () => {
    const p = await newProject();
    const t = await managerToken(p);
    const key = `${p.manager}/1/call-${rand()}`;
    const a = ok(await callTool("board", t, "create_task", { title: "once" }, { "nest/call": key }));
    const b = ok(await callTool("board", t, "create_task", { title: "once" }, { "nest/call": key }));
    expect(b.id).toBe(a.id);
    expect((await api(token, "GET", `/api/projects/${p.id}/tasks`)).body).toHaveLength(1);
  });

  it("isn't answered from another agent's call key", async () => {
    const p = await newProject();
    const t = await managerToken(p);
    const key = `agt_someoneelse/1/call-${rand()}`;
    const a = ok(await callTool("board", t, "create_task", { title: "x" }, { "nest/call": key }));
    const b = ok(await callTool("board", t, "create_task", { title: "x" }, { "nest/call": key }));
    expect(b.id).not.toBe(a.id);
  });
});
