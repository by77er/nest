// Telling a worker its task changed (README.md#task-changes): a new title, body or spec, or its block
// cleared, by the owner or the manager, reaches the task's live worker once, coalesced over a window,
// relayed when a tainted session made a change, posted idempotently, and recorded on the task.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { NOTIFY_WINDOW_MS } from "../src/do/project";
import { AccessTeam, agentClaims, api, callTool, FakeNest, installFetch, Signer } from "./fake-nest";

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
const spec = { goal: "Old goal", acceptance_criteria: ["a"], files: ["f"], test_plan: "t" };

async function setup() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "Old title", body: "Old body" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const worker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body.assignee as string;
  return { id: p.id as string, manager: p.settings.manager as string, task: t.id as string, worker };
}
type S = Awaited<ReturnType<typeof setup>>;

const stub = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.id));
/** Run the alarm's work as if the window had passed. */
const afterWindow = async (s: S) => {
  await runInDurableObject(stub(s), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET notify_next_ms = 0 WHERE notify_next_ms IS NOT NULL"); });
  await stub(s).drain();
};
/** The messages about changes in the worker's inbox (its brief excluded). */
const notes = (s: S) => fake.inbox.filter((m) => m.agent === s.worker && m.text.startsWith(`Your task ${s.task} was changed`));
const managerToken = (s: S, over: Record<string, unknown> = {}) => nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" }, over));
const history = async (s: S) => (await api(token, "GET", `/api/projects/${s.id}/tasks/${s.task}`)).body.history as { action: string; detail: string }[];
const ok = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};

describe("a change to a task with a live worker", () => {
  it("by the owner reaches the worker once, after the window, with the title before and after", async () => {
    const s = await setup();
    expect((await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { title: "New title" })).status).toBe(200);
    // Not before the window: the alarm is set for it.
    await stub(s).drain();
    expect(notes(s)).toHaveLength(0);
    const due = await runInDurableObject(stub(s), (_o, st) => st.storage.sql.exec("SELECT notify_next_ms AS t FROM tasks").one().t as number);
    expect(due).toBeGreaterThan(Date.now() + NOTIFY_WINDOW_MS - 2_000);
    await afterWindow(s);
    await afterWindow(s);
    const n = notes(s);
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toContain("by the owner: title");
    expect(n[0]!.text).toContain("Title, before: Old title");
    expect(n[0]!.text).toContain("Title, now: New title");
    expect(n[0]!.text).toContain("get_task");
    expect(n[0]!.from).toBeUndefined();
    const h = (await history(s)).at(-1)!;
    expect(h.action).toBe("worker_notified");
    expect(JSON.parse(h.detail)).toMatchObject({ agent: s.worker, fields: ["title"], changes: 1 });
  });

  it("by the manager (a re-spec) reaches it with the whole new spec, relayed when the manager's session was tainted", async () => {
    const s = await setup();
    const t = await managerToken(s, { tainted: true });
    ok(await callTool("board", t, "write_spec", { task: s.task, goal: "New goal", acceptance_criteria: ["b", "c"], files: ["g"], test_plan: "run it" }));
    await afterWindow(s);
    const n = notes(s);
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toContain("by the manager: spec");
    for (const part of ["Goal: New goal", "- b", "- c", "Files likely touched: g", "Test plan: run it"]) expect(n[0]!.text).toContain(part);
    expect(n[0]!.from).toBe("projects/board");
  });

  it("a burst is one message: each field's first before and last after", async () => {
    const s = await setup();
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { title: "Second" });
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { title: "Third", body: "New body" });
    ok(await callTool("board", await managerToken(s), "update_task", { task: s.task, title: "Fourth" }));
    await afterWindow(s);
    const n = notes(s);
    expect(n).toHaveLength(1);
    expect(n[0]!.text).toContain("by the owner and the manager: title, body");
    expect(n[0]!.text).toContain("Title, before: Old title");
    expect(n[0]!.text).toContain("Title, now: Fourth");
    expect(n[0]!.text).not.toContain("Second");
    expect(n[0]!.text).toContain("Body, before:\nOld body");
    expect(n[0]!.text).toContain("Body, now:\nNew body");
  });

  it("a block the manager clears is told; one the worker clears itself isn't", async () => {
    const s = await setup();
    const m = await managerToken(s);
    ok(await callTool("board", m, "block_task", { task: s.task, reason: "wait for a decision" }));
    ok(await callTool("board", m, "unblock_task", { task: s.task }));
    await afterWindow(s);
    expect(notes(s).map((x) => x.text).join()).toContain("Its block was cleared");
    const w = await nest.sign(agentClaims("task", s.worker, { project: s.id, role: "worker", task: s.task, start: "1" }));
    ok(await callTool("task", w, "report_blocked", { reason: "r" }));
    ok(await callTool("task", w, "clear_blocked"));
    await afterWindow(s);
    expect(notes(s)).toHaveLength(1);
  });

  it("a reorder isn't told", async () => {
    const s = await setup();
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { ord: 99 });
    await afterWindow(s);
    expect(notes(s)).toHaveLength(0);
  });

  it("a post whose answer was lost is retried with the same request id, landing once; later changes are the next message", async () => {
    const s = await setup();
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { title: "Retried" });
    fake.lostInbox.push({ agent: s.worker, times: 1 });
    await afterWindow(s);
    // A change after the first try isn't added to that set.
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { body: "Later" });
    await afterWindow(s);
    await afterWindow(s);
    const posts = fake.calls.filter((c) => c.path === `/v1/agents/${s.worker}/inbox` && String(c.body.text).startsWith(`Your task ${s.task} was changed`));
    expect(posts.map((c) => c.body.request_id)).toEqual([posts[0]!.body.request_id, posts[0]!.body.request_id, expect.not.stringMatching(posts[0]!.body.request_id)]);
    const n = notes(s);
    expect(n).toHaveLength(2);
    expect(n[0]!.text).toContain("Title, now: Retried");
    expect(n[0]!.text).not.toContain("Later");
    expect(n[1]!.text).toContain("Body, now:\nLater");
  });
});

describe("a task without a live worker", () => {
  it("tells nobody: not a draft, not a ready task, not one whose worker exited", async () => {
    const s = await setup();
    const draft = (await api(token, "POST", `/api/projects/${s.id}/tasks`, { title: "d" })).body;
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${draft.id}`, { title: "d2" });
    await api(token, "PUT", `/api/projects/${s.id}/tasks/${draft.id}/spec`, spec);
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${draft.id}`, { body: "b2" });
    // The live worker's task, once its worker ended.
    await runInDurableObject(stub(s), (_o, st) => { st.storage.sql.exec("UPDATE tasks SET worker_live = 0 WHERE id = ?", s.task); });
    await api(token, "PATCH", `/api/projects/${s.id}/tasks/${s.task}`, { title: "Nobody hears" });
    // Nothing is even noted to tell.
    expect(await runInDurableObject(stub(s), (_o, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM task_changes").one().n)).toBe(0);
    expect(await runInDurableObject(stub(s), (_o, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM tasks WHERE notify_next_ms IS NOT NULL").one().n)).toBe(0);
    await afterWindow(s);
    expect(fake.inbox.filter((m) => m.text.includes("was changed by"))).toEqual(expect.not.arrayContaining([expect.objectContaining({ agent: s.worker })]));
    expect(notes(s)).toHaveLength(0);
  });
});
