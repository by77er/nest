// Blocked tasks (README.md#blocked): the manager and a worker block a task over MCP (a worker only its
// own), the block reaches the manager and the owner's attention list beside the asks, the owner's answer
// goes to the right inboxes, and the projects list counts what waits on the owner.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, agentClaims, api, callTool, deliver, FakeNest, holdAsk, installFetch, Signer } from "./fake-nest";

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
const spec = { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" };

async function setup() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  const task = async (title: string) => {
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
    return t.id as string;
  };
  const mine = await task("mine");
  const other = await task("other");
  const worker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${mine}/assign`)).body.assignee as string;
  const otherWorker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${other}/assign`)).body.assignee as string;
  return { id: p.id as string, manager: p.settings.manager as string, mine, other, worker, otherWorker };
}
type S = Awaited<ReturnType<typeof setup>>;

const workerToken = (s: S, agent: string, task: string, over: Record<string, unknown> = {}) =>
  nest.sign(agentClaims("task", agent, { project: s.id, role: "worker", task, start: "1" }, over));
const managerToken = (s: S) => nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" }));
const drain = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.id)).drain();
const attention = async (s: S) => (await api(token, "GET", `/api/projects/${s.id}/attention`)).body as any[];
const task = async (s: S, id: string) => (await api(token, "GET", `/api/projects/${s.id}/tasks/${id}`)).body;
const inboxOf = (agent: string) => fake.inbox.filter((x) => x.agent === agent);

const ok = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.result?.isError).toBe(true);
  return r.result.content[0].text as string;
};

describe("a worker", () => {
  it("blocks its own task, which the manager is told of and the owner sees", async () => {
    const s = await setup();
    const t = ok(await callTool("task", await workerToken(s, s.worker, s.mine, { tainted: true }), "report_blocked", { reason: "No staging DB credentials", question: "Can you add STAGING_DB_URL?" }));
    expect(t.state).toBe("in_progress");
    expect(t.blocked).toMatchObject({ by: s.worker, role: "worker", reason: "No staging DB credentials", question: "Can you add STAGING_DB_URL?", tainted: true });
    await drain(s);
    // The manager is told, as relayed text: the worker's session was tainted.
    const told = inboxOf(s.manager).find((m) => m.text.includes(s.mine))!;
    expect(told.text).toContain("No staging DB credentials");
    expect(told.from).toBe("projects/board");
    const items = await attention(s);
    expect(items).toEqual([expect.objectContaining({ kind: "blocked", task: s.mine, title: "mine", by: s.worker, reason: "No staging DB credentials" })]);
  });

  it("can't block another task: its labels name its task, and the task's worker must be it", async () => {
    const s = await setup();
    // No tool takes a task id.
    expect(toolError(await callTool("task", await workerToken(s, s.worker, s.mine), "report_blocked", { reason: "r", task: s.other }))).toMatch(/not an argument/);
    // A worker labelled for a task that isn't the one it works on.
    expect(toolError(await callTool("task", await workerToken(s, s.worker, s.other), "report_blocked", { reason: "r" }))).toMatch(/only the task's own worker/);
    expect((await task(s, s.other)).blocked).toBeNull();
    // Nor clear another's block.
    ok(await callTool("task", await workerToken(s, s.otherWorker, s.other), "report_blocked", { reason: "r" }));
    expect(toolError(await callTool("task", await workerToken(s, s.worker, s.other), "clear_blocked"))).toMatch(/only the task's own worker/);
    expect((await task(s, s.other)).blocked).not.toBeNull();
  });

  it("clears its own block", async () => {
    const s = await setup();
    const t = await workerToken(s, s.worker, s.mine);
    ok(await callTool("task", t, "report_blocked", { reason: "r" }));
    expect(toolError(await callTool("task", t, "report_blocked", { reason: "again" }))).toMatch(/already blocked/);
    expect(ok(await callTool("task", t, "clear_blocked", { note: "found it in the wiki" })).blocked).toBeNull();
    expect(toolError(await callTool("task", t, "clear_blocked"))).toMatch(/isn't blocked/);
    expect(await attention(s)).toEqual([]);
  });
});

describe("the owner's answer", () => {
  it("to a worker's block goes to the worker and to the manager, and clears it", async () => {
    const s = await setup();
    ok(await callTool("task", await workerToken(s, s.worker, s.mine, { tainted: true }), "report_blocked", { reason: "r", question: "which region?" }));
    const r = await api(token, "POST", `/api/projects/${s.id}/tasks/${s.mine}/answer`, { answer: "eu-west-1" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.blocked).toBeNull();
    const toWorker = inboxOf(s.worker).filter((m) => m.text.includes("eu-west-1"));
    const toManager = inboxOf(s.manager).filter((m) => m.text.includes("eu-west-1"));
    expect(toWorker).toHaveLength(1);
    expect(toManager).toHaveLength(1);
    // The owner's words: not relayed, however tainted the blocking session was.
    expect(toWorker[0]!.from).toBeUndefined();
    expect(toManager[0]!.text).toContain(s.worker);
    expect(inboxOf(s.otherWorker).some((m) => m.text.includes("eu-west-1"))).toBe(false);
    expect((await task(s, s.mine)).history.at(-1)).toMatchObject({ action: "block_answered", actor: "owner" });
    expect((await api(token, "POST", `/api/projects/${s.id}/tasks/${s.mine}/answer`, { answer: "again" })).status).toBe(409);
  });

  it("to the manager's block goes to the manager only", async () => {
    const s = await setup();
    ok(await callTool("board", await managerToken(s), "block_task", { task: s.other, reason: "Needs a product decision", question: "CSV or JSON?" }));
    const before = inboxOf(s.otherWorker).length;
    await api(token, "POST", `/api/projects/${s.id}/tasks/${s.other}/answer`, { answer: "JSON" });
    expect(inboxOf(s.manager).filter((m) => m.text.includes("JSON"))).toHaveLength(1);
    expect(inboxOf(s.otherWorker)).toHaveLength(before);
  });

  it("a message nest can't take now is sent again by the alarm", async () => {
    const s = await setup();
    ok(await callTool("board", await managerToken(s), "block_task", { task: s.other, reason: "r" }));
    fake.fail(new RegExp(`^POST /v1/agents/${s.manager}/inbox$`), 503, { retryable: true, times: 3 });
    await api(token, "POST", `/api/projects/${s.id}/tasks/${s.other}/answer`, { answer: "later" });
    expect(inboxOf(s.manager).some((m) => m.text.includes("later"))).toBe(false);
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(s.id)), (_o, st) => { st.storage.sql.exec("UPDATE messages SET next_ms = 0 WHERE next_ms IS NOT NULL"); });
    await drain(s);
    expect(inboxOf(s.manager).filter((m) => m.text.includes("later"))).toHaveLength(1);
  });
});

describe("what needs the owner", () => {
  it("lists asks and blocked tasks together, oldest first, and the projects list counts them", async () => {
    const s = await setup();
    // nest's asks, each a second apart around the block, so the order is unambiguous.
    holdAsk(s.worker, `ask_first${s.id.slice(-6)}`, { question: "push?", created_ms: 1000 });
    ok(await callTool("board", await managerToken(s), "block_task", { task: s.other, reason: "decide" }));
    holdAsk(s.manager, `ask_third${s.id.slice(-6)}`, { question: "which?", created_ms: 3000 });
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(s.id)), (_o, st) => {
      st.storage.sql.exec("UPDATE tasks SET blocked_ms = 2000 WHERE id = ?", s.other);
    });
    expect((await attention(s)).map((x) => (x.kind === "ask" ? x.ask : x.task))).toEqual([`ask_first${s.id.slice(-6)}`, s.other, `ask_third${s.id.slice(-6)}`]);
    const count = async () => ((await api(token, "GET", "/api/projects")).body.projects as any[]).find((p) => p.id === s.id).needs_you;
    expect(await count()).toBe(3);
    expect((await api(token, "POST", `/api/projects/${s.id}/asks/ask_first${s.id.slice(-6)}/answer`, { answer: "yes" })).status).toBe(200);
    await api(token, "POST", `/api/projects/${s.id}/tasks/${s.other}/answer`, { answer: "this" });
    expect(await count()).toBe(1);
    expect((await attention(s)).map((x) => x.kind)).toEqual(["ask"]);
  });

  it("a blocked ready task isn't auto-assigned, and a task that ends drops its block", async () => {
    const s = await setup();
    const r = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "later" })).body;
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${r.id}/spec`, spec);
    ok(await callTool("board", await managerToken(s), "block_task", { task: r.id, reason: "wait" }));
    await api(token, "PATCH", `/api/projects/${s.id}/settings`, { auto_assign: true, max_workers: 10 });
    expect((await task(s, r.id)).state).toBe("ready");
    await api(token, "POST", `/api/projects/${s.id}/tasks/${r.id}/cancel`, {});
    expect((await task(s, r.id)).blocked).toBeNull();
    expect(await attention(s)).toEqual([]);
  });
});
