// Asks (README.md#asks): nest's alone. "Needs you" and the board read the project's agents' open asks from
// nest when asked (`GET /v1/asks` by the `project` label), so an ask answered anywhere, or whose agent
// ended, is gone without the app hearing of it; the app keeps no copy. Answering goes to nest, and only an
// answer that reached its ask wakes the manager's await_reply.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetAccessKeys } from "../src/access";
import { AccessTeam, agentClaims, answerInNest, api, callTool, deliver, FakeNest, holdAsk, installFetch, Signer } from "./fake-nest";

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
  const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
  await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, spec);
  const worker = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body.assignee as string;
  return { id: p.id as string, manager: p.settings.manager as string, task: t.id as string, worker };
}
type S = Awaited<ReturnType<typeof setup>>;
const stub = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.id));

const ok = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result;
};
const askId = () => `ask_${rand()}`;
const asks = async (s: S) => (await api(token, "GET", `/api/projects/${s.id}/asks`)).body as { ask: string; agent: string; role: string | null; task: string | null; at_ms: number; previous: boolean }[];
const attention = async (s: S) => (await api(token, "GET", `/api/projects/${s.id}/attention`)).body as { kind: string; ask?: string }[];
const askIds = async (s: S) => (await attention(s)).filter((x) => x.kind === "ask").map((x) => x.ask);
const count = async (s: S) => ((await api(token, "GET", "/api/projects")).body.projects as { id: string; needs_you: number }[]).find((p) => p.id === s.id)!.needs_you;
const answer = (s: S, ask: string, text = "approve") => api(token, "POST", `/api/projects/${s.id}/asks/${ask}/answer`, { answer: text });

describe("asks are nest's, read when asked", () => {
  it("lists the project's agents' open asks with role and task from their labels, oldest first", async () => {
    const s = await setup();
    const w = askId();
    const m = askId();
    holdAsk(s.worker, w, { question: "push?", created_ms: 2000, approval: { name: "brokered", tool: "WebFetch" } });
    holdAsk(s.manager, m, { question: "which?", created_ms: 1000 });
    expect(await asks(s)).toEqual([
      { ask: m, agent: s.manager, role: "manager", task: null, question: "which?", approval: null, at_ms: 1000, previous: false },
      { ask: w, agent: s.worker, role: "worker", task: s.task, question: "push?", approval: { name: "brokered", tool: "WebFetch" }, at_ms: 2000, previous: false },
    ]);
    expect(await askIds(s)).toEqual([m, w]);
    expect(await count(s)).toBe(2);
  });

  it("an ask answered elsewhere (the operator, through nest) is gone from Needs you, the board and the count, with no event", async () => {
    const s = await setup();
    const a = askId();
    await deliver({ id: `evt-${rand()}`, type: "agent.ask", agent: s.worker, ask: a, question: "push?" });
    expect(await askIds(s)).toEqual([a]);
    expect(await count(s)).toBe(1);
    expect(answerInNest(s.worker, a)).toBe("async");
    expect(await askIds(s)).toEqual([]);
    expect(await asks(s)).toEqual([]);
    expect(await count(s)).toBe(0);
    // Answering it here now is refused, and nest isn't asked to answer it again.
    const before = fake.answers.length;
    const r = await answer(s, a);
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("isn't open any more");
    expect(fake.answers.length).toBe(before);
  });

  it("an ended agent's asks are gone (nest lists live agents' only)", async () => {
    const s = await setup();
    const a = askId();
    holdAsk(s.worker, a);
    expect(await askIds(s)).toEqual([a]);
    fake.agents.get(s.worker)!.ended = true;
    expect(await askIds(s)).toEqual([]);
  });

  it("only agents the app made itself, of this project: not one an agent spawned with its labels, nor another project's", async () => {
    const s = await setup();
    const other = await setup();
    const spawned = fake.plant({ owner: s.worker, labels: { project: s.id, role: "manager" } });
    holdAsk(spawned.agent, askId());
    const theirs = askId();
    holdAsk(other.worker, theirs);
    expect(await askIds(s)).toEqual([]);
    // Nor in the projects list's count, which reads every project's at once.
    expect(await count(s)).toBe(0);
    // Answering another project's ask through this one is refused before nest is asked.
    const before = fake.answers.length;
    expect((await answer(s, theirs)).status).toBe(409);
    expect(fake.answers.length).toBe(before);
    expect(await askIds(other)).toEqual([theirs]);
  });

  it("nest not answering: Needs you lists the app's own items and says the asks are unknown; the count is unknown, not 0", async () => {
    const s = await setup();
    holdAsk(s.worker, askId());
    ok(await callTool("board", await nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" })), "block_task", { task: s.task, reason: "decide" }));
    fake.fail(/^GET \/v1\/asks$/, 500, { times: 3 });
    const a = (await api(token, "GET", `/api/projects/${s.id}/attention`));
    expect(a.status).toBe(200);
    expect(a.body.map((x: { kind: string }) => x.kind)).toEqual(["asks_unavailable", "blocked"]);
    expect(a.body[0].error).toContain("nest couldn't list the agents' asks");
    expect((await api(token, "GET", `/api/projects/${s.id}/asks`)).status).toBe(502);
    expect(await count(s)).toBeNull();
    // nest back: the ask is there again, and the count has it.
    expect((await attention(s)).map((x) => x.kind).sort()).toEqual(["ask", "blocked"]);
    expect(await count(s)).toBe(2);
  });

  it("pages through every page of nest's answer, oldest first across pages, and reads an agent's whole list past 20", async () => {
    const s = await setup();
    const extra = fake.plant({ labels: { project: s.id, role: "worker", task: s.task } });
    // Agents in creation order: the manager, the worker, then `extra`; the oldest ask is on the last page.
    holdAsk(s.manager, `ask_mgr${rand()}`, { created_ms: 3000 });
    holdAsk(extra.agent, `ask_xtr${rand()}`, { created_ms: 1000 });
    const many = Array.from({ length: 22 }, (_, i) => holdAsk(s.worker, `ask_w${String(i).padStart(2, "0")}${rand()}`, { created_ms: 2000 + i }).ask);
    fake.asksPageMax = 1;
    try {
      const calls = fake.calls.length;
      const got = await asks(s);
      expect(got.map((x) => x.at_ms)).toEqual([1000, ...many.map((_, i) => 2000 + i), 3000]);
      expect(got.filter((x) => x.agent === s.worker).map((x) => x.ask)).toEqual(many);
      const pages = fake.calls.slice(calls).filter((c) => c.path === "/v1/asks");
      expect(pages.map((c) => c.query.get("cursor"))).toEqual([null, "1", "2"]);
      // The worker's 22 come from its own list (the page showed 20 and named it in `more`).
      expect(fake.calls.slice(calls).filter((c) => c.path === `/v1/agents/${s.worker}/asks`)).toHaveLength(1);
    } finally {
      fake.asksPageMax = 100;
    }
    {
      // The projects list counts all 24, from one read for every project (no project label).
      const before = fake.calls.length;
      expect(await count(s)).toBe(24);
      const listing = fake.calls.slice(before).filter((c) => c.path === "/v1/asks");
      expect(listing.length).toBeGreaterThan(0);
      expect(listing.every((c) => c.query.getAll("label").length === 0)).toBe(true);
    }
  });

  it("on a control plane without GET /v1/asks, reads each agent's asks instead", async () => {
    const s = await setup();
    const a = askId();
    const b = askId();
    holdAsk(s.worker, a, { created_ms: 2000 });
    holdAsk(s.manager, b, { created_ms: 1000 });
    fake.asksRouteMissing = true;
    try {
      const calls = fake.calls.length;
      expect(await asks(s)).toEqual([
        expect.objectContaining({ ask: b, agent: s.manager, role: "manager" }),
        expect.objectContaining({ ask: a, agent: s.worker, role: "worker", task: s.task }),
      ]);
      const made = fake.calls.slice(calls).map((c) => `${c.method} ${c.path}`);
      expect(made).toEqual(expect.arrayContaining([`GET /v1/agents/${s.worker}/asks`, `GET /v1/agents/${s.manager}/asks`]));
      answerInNest(s.worker, a);
      expect((await asks(s)).map((x) => x.ask)).toEqual([b]);
      expect((await answer(s, b)).status).toBe(200);
      expect(await asks(s)).toEqual([]);
    } finally {
      fake.asksRouteMissing = false;
    }
  });

  it("a replaced manager still running (its stop refused) has its asks labelled the previous manager's", async () => {
    const s = await setup();
    const old = s.manager;
    fake.fail(new RegExp(`^POST /v1/agents/${old}/stop$`), 409, { times: 50 });
    await api(token, "POST", `/api/projects/${s.id}/manager/restart`);
    const next = ((await api(token, "GET", `/api/projects/${s.id}`)).body.settings.manager) as string;
    expect(next).not.toBe(old);
    holdAsk(old, askId());
    holdAsk(next, askId());
    const listed = await asks(s);
    expect(listed.find((a) => a.agent === old)?.previous).toBe(true);
    expect(listed.find((a) => a.agent === next)?.previous).toBe(false);
  });
});

describe("answering", () => {
  const board = async (s: S, tool: string, args: Record<string, unknown> = {}) =>
    callTool("board", await nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" })), tool, args);
  const told = (s: S) => fake.inbox.filter((m) => m.agent === s.manager && m.text.startsWith("await "));

  it("goes to nest for the ask's own agent, and wakes the manager's await_reply", async () => {
    const s = await setup();
    const a = askId();
    holdAsk(s.worker, a);
    const w = (await board(s, "await_reply", { timeout_s: 600 })).result.structuredContent;
    const r = await answer(s, a, "deny");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ delivered: "async" });
    expect(fake.answers).toContainEqual({ agent: s.worker, ask: a, answer: "deny" });
    expect(await askIds(s)).toEqual([]);
    await vi.waitFor(async () => {
      await stub(s).drain();
      expect(told(s).map((m) => m.text)).toEqual([`await ${w.wait.id}: the owner: answered ask ${a}.`]);
    });
  });

  it("an answer nest says came too late (answered elsewhere meanwhile) wakes nothing", async () => {
    const s = await setup();
    const a = askId();
    holdAsk(s.worker, a);
    await board(s, "await_reply", { timeout_s: 600 });
    // Answered in nest while the app's answer is on its way.
    let release!: () => void;
    const hold = { match: new RegExp(`^POST /v1/agents/${s.worker}/asks/${a}/answer$`), release: new Promise<void>((r) => (release = r)), reached: false };
    fake.holds.push(hold);
    const answering = answer(s, a);
    await vi.waitFor(() => expect(hold.reached).toBe(true));
    answerInNest(s.worker, a);
    release();
    const r = await answering;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ delivered: "already_answered" });
    await stub(s).drain();
    expect(told(s)).toEqual([]);
  });

  it("an agent.ask event is still written to the old asks table (never read here), so a rollback lists asks raised meanwhile", async () => {
    const s = await setup();
    const a = askId();
    await deliver({ id: `evt-${rand()}`, type: "agent.ask", agent: s.worker, ask: a, question: "push?" });
    const rows = await runInDurableObject(stub(s), (_o, st) => st.storage.sql.exec("SELECT ask, agent, role, task, question, answered_ms FROM asks").toArray());
    expect(rows).toEqual([{ ask: a, agent: s.worker, role: "worker", task: s.task, question: "push?", answered_ms: null }]);
    // Nothing reads it: answered in nest, it's gone from Needs you though its row stays.
    answerInNest(s.worker, a);
    expect(await askIds(s)).toEqual([]);
  });
});
