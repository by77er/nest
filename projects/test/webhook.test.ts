// nest's webhook (/hooks/nest) against the events contract (docs/control-plane/api/clients/#events-to-the-owner):
// `Nest-Signature: t=<ms>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`, the body `{id, type, …fields}`,
// delivered at least once (deduplicated by id), routed by agent to its project.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { sign, TOLERANCE_MS, verifySignature } from "../src/webhook";
import { AccessTeam, api, deliver, FakeNest, installFetch } from "./fake-nest";

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
const eid = () => `evt-${rand()}`;

async function projectWithWorker() {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo });
  const t = await api(token, "POST", `/api/projects/${p.body.id}/tasks`, { title: "t" });
  await api(token, "PUT", `/api/projects/${p.body.id}/tasks/${t.body.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
  const a = await api(token, "POST", `/api/projects/${p.body.id}/tasks/${t.body.id}/assign`);
  expect(a.body.state).toBe("in_progress");
  return { project: p.body.id as string, manager: p.body.settings.manager as string, task: t.body.id as string, worker: a.body.assignee as string };
}

const task = async (project: string, id: string) => (await api(token, "GET", `/api/projects/${project}/tasks/${id}`)).body;

// HMAC-SHA256 of "<t>.<body>" keyed by the secret's UTF-8 bytes, computed with Python's hmac module
// for the test pool's secret (vitest.config.ts): the doc's format, not this code's.
const VECTOR_T = 1700000000000;
const VECTOR_BODY = `{"id":"evt_vector","type":"agent.error","agent":"agt_nobody","code":"c","message":"m"}`;
const VECTOR_MAC = "672b46504aaad40acf43da44738c6922f00c786d41553cb199735c7db8a3fd3d";

describe("the webhook's signature", () => {
  it("matches an independently computed vector", async () => {
    const header = `t=${VECTOR_T},v1=${VECTOR_MAC}`;
    expect(await verifySignature(env.NEST_WEBHOOK_SECRET!, header, VECTOR_BODY, VECTOR_T + 1000)).toBe(true);
    expect(await verifySignature(env.NEST_WEBHOOK_SECRET!, header, VECTOR_BODY, VECTOR_T + TOLERANCE_MS + 1)).toBe(false);
    expect(await verifySignature(env.NEST_WEBHOOK_SECRET!, header, VECTOR_BODY.replace("m\"", "n\""), VECTOR_T)).toBe(false);
  });

  const event = () => ({ id: eid(), type: "agent.error", agent: "agt_nobody", code: "x", message: "y" });

  it("accepts nest's signature", async () => {
    expect((await deliver(event())).status).toBe(200);
  });

  const refused: [string, () => Promise<Response>][] = [
    ["no header", () => deliver(event(), { header: "" })],
    ["another secret", () => deliver(event(), { secret: "whsec_other" })],
    ["a signature over another body", async () => {
      const t = Date.now();
      return deliver(event(), { header: `t=${t},v1=${await sign(env.NEST_WEBHOOK_SECRET!, t, "{}")}` });
    }],
    ["a time older than the tolerance", () => deliver(event(), { t: Date.now() - TOLERANCE_MS - 1000 })],
    ["a time past the tolerance in the future", () => deliver(event(), { t: Date.now() + TOLERANCE_MS + 1000 })],
    ["a signature under another time", async () => {
      const e = event();
      const t = Date.now();
      return deliver(e, { header: `t=${t},v1=${await sign(env.NEST_WEBHOOK_SECRET!, t - 1, JSON.stringify(e))}` });
    }],
    ["a v0 signature only", async () => {
      const e = event();
      const t = Date.now();
      return deliver(e, { header: `t=${t},v0=${await sign(env.NEST_WEBHOOK_SECRET!, t, JSON.stringify(e))}` });
    }],
  ];
  it.each(refused)("refuses %s with 401", async (_n, send) => {
    expect((await send()).status).toBe(401);
  });
});

describe("routing nest's events", () => {
  it("appends a manager's completed turn to the chat, once however often it's delivered", async () => {
    const w = await projectWithWorker();
    const e = { id: eid(), type: "agent.turn_completed", agent: w.manager, turn: 3, text: "I specced it." };
    expect((await deliver(e)).status).toBe(200);
    const again = await deliver(e);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
    const chat = (await api(token, "GET", `/api/projects/${w.project}/chat`)).body;
    expect(chat.filter((m: { sender: string; text: string }) => m.sender === "manager" && m.text === "I specced it.")).toHaveLength(1);
  });

  it("stalls a task whose worker exits before its PR", async () => {
    const w = await projectWithWorker();
    expect((await deliver({ id: eid(), type: "agent.exited", agent: w.worker, reason: "exited", text: "gave up" })).status).toBe(200);
    const t = await task(w.project, w.task);
    expect(t.state).toBe("stalled");
    expect(t.history.at(-1)).toMatchObject({ action: "worker_exited", actor: "app:nest" });
  });

  it("leaves a task in review alone when its worker exits", async () => {
    const w = await projectWithWorker();
    const stub = env.PROJECT.get(env.PROJECT.idFromName(w.project));
    await runInDurableObject(stub, (_o, st) => {
      st.storage.sql.exec("UPDATE tasks SET state = 'in_review', pr = 7 WHERE id = ?", w.task);
      st.storage.sql.exec("INSERT INTO task_prs (pr, task, state, attached_by, attached_ms) VALUES (7, ?, 'open', ?, 0)", w.task, w.worker);
    });
    await deliver({ id: eid(), type: "agent.exited", agent: w.worker, reason: "done" });
    expect((await task(w.project, w.task)).state).toBe("in_review");
  });

  it("frees an exited worker's place for auto-assign", async () => {
    const w = await projectWithWorker();
    await api(token, "PATCH", `/api/projects/${w.project}/settings`, { auto_assign: true, max_workers: 1 });
    const next = await api(token, "POST", `/api/projects/${w.project}/tasks`, { title: "next" });
    await api(token, "PUT", `/api/projects/${w.project}/tasks/${next.body.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    expect((await task(w.project, next.body.id)).state).toBe("ready");
    await deliver({ id: eid(), type: "agent.exited", agent: w.worker, reason: "exited" });
    await env.PROJECT.get(env.PROJECT.idFromName(w.project)).drain();
    expect((await task(w.project, next.body.id)).state).toBe("in_progress");
  });

  it("records an ask for the board, and answers it through nest", async () => {
    const w = await projectWithWorker();
    await deliver({ id: eid(), type: "agent.ask", agent: w.worker, ask: "ask_abc123", question: "push?", approval: { name: "x", tool: "y" } });
    const asks = (await api(token, "GET", `/api/projects/${w.project}/asks`)).body;
    expect(asks).toEqual([expect.objectContaining({ ask: "ask_abc123", agent: w.worker, role: "worker", task: w.task, question: "push?", approval: { name: "x", tool: "y" } })]);
    const r = await api(token, "POST", `/api/projects/${w.project}/asks/ask_abc123/answer`, { answer: "yes" });
    expect(r.status).toBe(200);
    expect(fake.answers).toContainEqual({ agent: w.worker, ask: "ask_abc123", answer: "yes" });
    expect((await api(token, "POST", `/api/projects/${w.project}/asks/ask_abc123/answer`, { answer: "yes" })).status).toBe(409);
  });

  it("records an error", async () => {
    const w = await projectWithWorker();
    await deliver({ id: eid(), type: "agent.error", agent: w.worker, code: "errored", message: "kept exiting" });
    const errors = (await api(token, "GET", `/api/projects/${w.project}/errors`)).body;
    expect(errors[0]).toMatchObject({ agent: w.worker, role: "worker", task: w.task, code: "errored", message: "kept exiting" });
  });

  it("routes an agent it hadn't recorded by its labels, only when the app created it", async () => {
    const w = await projectWithWorker();
    // Created by the app (owner = the client) but not recorded: found by its labels.
    const ours = fake.plant({ labels: { project: w.project, role: "manager" } });
    // (An error, not a turn: only the project's current manager's turns are chat, README.md#the-manager-lifecycle.)
    await deliver({ id: eid(), type: "agent.error", agent: ours.agent, code: "errored", message: "from the labels" });
    await deliver({ id: eid(), type: "agent.turn_completed", agent: ours.agent, text: "not the current manager" });
    // Spawned by one of the app's agents with the same labels: its labels mean nothing.
    const spawned = fake.plant({ owner: w.worker, labels: { project: w.project, role: "manager" } });
    expect((await deliver({ id: eid(), type: "agent.error", agent: spawned.agent, code: "errored", message: "spoofed" })).status).toBe(200);
    const errors = ((await api(token, "GET", `/api/projects/${w.project}/errors`)).body as { message: string; role: string }[]);
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ message: "from the labels", role: "manager" })]));
    expect(errors.map((e) => e.message)).not.toContain("spoofed");
    const chat = (await api(token, "GET", `/api/projects/${w.project}/chat`)).body.map((m: { text: string }) => m.text);
    expect(chat).not.toContain("not the current manager");
  });

  it("acknowledges and ignores unknown agents and event types", async () => {
    const before = fake.calls.length;
    expect((await deliver({ id: eid(), type: "agent.exited", agent: "agt_unknown1", reason: "exited" })).status).toBe(200);
    expect((await deliver({ id: eid(), type: "sandbox.destroyed", sandbox: "sbx_x" })).status).toBe(200);
    expect((await deliver({ id: eid(), type: "something.new", agent: "agt_x" })).status).toBe(200);
    // The unknown agent was looked up once, then remembered as not the app's.
    expect((await deliver({ id: eid(), type: "agent.exited", agent: "agt_unknown1", reason: "exited" })).status).toBe(200);
    expect(fake.calls.slice(before).filter((c) => c.path === "/v1/agents/agt_unknown1")).toHaveLength(1);
  });

  it("asks nest to deliver again when it can't route an event now", async () => {
    const w = await projectWithWorker();
    const stranger = fake.plant({ labels: { project: w.project, role: "worker", task: w.task } });
    fake.fail(new RegExp(`^GET /v1/agents/${stranger.agent}$`), 500);
    const e = { id: eid(), type: "agent.error", agent: stranger.agent, code: "c", message: "m" };
    expect((await deliver(e)).status).toBe(502);
    // Not marked seen: the redelivery is handled.
    expect((await deliver(e)).status).toBe(200);
    const errors = (await api(token, "GET", `/api/projects/${w.project}/errors`)).body;
    expect(errors.filter((x: { agent: string }) => x.agent === stranger.agent)).toHaveLength(1);
  });
});
