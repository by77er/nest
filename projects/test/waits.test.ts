// The manager's waits (README.md#waiting): await_task, await_pr and await_reply on /mcp/board. Each is
// the app's own (ProjectDO holds it and its deadline), resolves exactly once (met, ended or timed out),
// tells the manager once, and its timeout never fires after its condition did. The pure parts first.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { TERMINAL } from "../src/tasks";
import { MAX_WAITS, prVerdict, taskVerdict, timeoutProblem, waitKey, waitMessage } from "../src/waits";
import { AccessTeam, agentClaims, api, callTool, FakeNest, installFetch, Signer } from "./fake-nest";

describe("the waits' rules (pure)", () => {
  it("a task's verdict: met in a wanted state, ended in another terminal one, else pending", () => {
    expect(taskVerdict(["in_review"], "in_review", TERMINAL)).toEqual({ outcome: "met", detail: "now in_review" });
    expect(taskVerdict(["in_review"], "cancelled", TERMINAL)).toEqual({ outcome: "ended", detail: "ended cancelled" });
    expect(taskVerdict(["done"], "done", TERMINAL)?.outcome).toBe("met");
    expect(taskVerdict(["in_review"], "in_progress", TERMINAL)).toBeNull();
  });

  it("a PR's verdict on each event", () => {
    expect(prVerdict("merged", { kind: "merged" })?.outcome).toBe("met");
    expect(prVerdict("merged", { kind: "closed" })?.outcome).toBe("ended");
    expect(prVerdict("closed", { kind: "merged" })?.outcome).toBe("met");
    expect(prVerdict("closed", { kind: "closed" })?.outcome).toBe("met");
    expect(prVerdict("review_done", { kind: "review", conclusion: "passed" })).toEqual({ outcome: "met", detail: "its review is done (passed)" });
    expect(prVerdict("review_done", { kind: "merged" })?.outcome).toBe("ended");
    expect(prVerdict("merged", { kind: "review", conclusion: "passed" })).toBeNull();
  });

  it("the same condition is the same key, whatever the order of its states; timeouts are 10 s to 30 days", () => {
    expect(waitKey("task", "tsk_a", ["done", "in_review"])).toBe(waitKey("task", "tsk_a", ["in_review", "done", "done"]));
    expect(waitKey("task", "tsk_a", ["done"])).not.toBe(waitKey("task", "tsk_b", ["done"]));
    expect(waitKey("pr", "12", "merged")).not.toBe(waitKey("pr", "12", "closed"));
    for (const ok of [10, 3600, 30 * 24 * 3600]) expect(timeoutProblem(ok)).toBeNull();
    for (const bad of [9, 30 * 24 * 3600 + 1, 1.5, "60", undefined]) expect(timeoutProblem(bad), String(bad)).not.toBeNull();
    expect(waitMessage({ id: "aw_1", kind: "pr", target: "12", want: "merged", created_ms: 0 }, "timed_out", "timed out", 2 * 3600_000)).toBe("await aw_1 timed out after 2 h, still waiting for #12 to merge.");
  });
});

// --- Through the app ------------------------------------------------------------------------------------

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
  return { id: p.id as string, manager: p.settings.manager as string, repo, task };
}
type S = Awaited<ReturnType<typeof setup>>;

const stub = (s: S) => env.PROJECT.get(env.PROJECT.idFromName(s.id));
const board = async (s: S, tool: string, args: Record<string, unknown> = {}) =>
  callTool("board", await nest.sign(agentClaims("board", s.manager, { project: s.id, role: "manager", start: "1" })), tool, args);
const ok = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBe(true);
  return r.result.content[0].text as string;
};
/** The manager's inbox messages about waits. */
const told = (s: S) => fake.inbox.filter((m) => m.agent === s.manager && m.text.startsWith("await "));
const settle = async (s: S) => {
  await stub(s).drain();
};
/** Every pending wait's deadline, now: as if its timeout passed. */
const expire = (s: S) => runInDurableObject(stub(s), (_i: unknown, st: DurableObjectState) => {
  st.storage.sql.exec("UPDATE waits SET deadline_ms = 0 WHERE resolved_ms IS NULL");
});

describe("await_task", () => {
  it("resolves once when the task gets there, and its timeout never fires after", async () => {
    const s = await setup();
    const t = await s.task("a");
    const worker = (await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/assign`)).body.assignee as string;
    const w = ok(await board(s, "await_task", { task: t, states: ["in_review"], timeout_s: 3600 }));
    expect(w.status).toBe("waiting");
    expect(w.wait).toMatchObject({ id: expect.stringMatching(/^aw_/), kind: "task", target: t, want: ["in_review"] });
    // The worker reports its PR: the task is in review, and the manager is told in that step.
    ok(await callTool("task", await nest.sign(agentClaims("task", worker, { project: s.id, role: "worker", task: t, start: "1" })), "report_pr", { number: 7 }));
    await settle(s);
    expect(told(s).map((m) => m.text)).toEqual([`await ${w.wait.id}: task ${t}: now in_review.`]);
    // The deadline passing later changes nothing: resolved already.
    await expire(s);
    await settle(s);
    expect(told(s)).toHaveLength(1);
    const waits = (await api(token, "GET", `/api/projects/${s.id}/waits`)).body;
    expect(waits.pending).toEqual([]);
    expect(waits.recent[0]).toMatchObject({ id: w.wait.id, outcome: "met", detail: "now in_review" });
  });

  it("times out once, and a condition after that changes nothing", async () => {
    const s = await setup();
    const t = await s.task("a");
    const w = ok(await board(s, "await_task", { task: t, states: ["done"], timeout_s: 60 }));
    await expire(s);
    await settle(s);
    await settle(s);
    expect(told(s).map((m) => m.text)).toEqual([expect.stringMatching(new RegExp(`^await ${w.wait.id} timed out after .*, still waiting for ${t} to be done\\.$`))]);
    await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/done`);
    await settle(s);
    expect(told(s)).toHaveLength(1);
  });

  it("answers at once when the task is there already, and ends a wait when the task ends first", async () => {
    const s = await setup();
    const t = await s.task("a");
    expect(ok(await board(s, "await_task", { task: t, states: ["ready", "done"], timeout_s: 60 }))).toEqual({ status: "met", detail: `task ${t}: now ready` });
    const w = ok(await board(s, "await_task", { task: t, states: ["in_review"], timeout_s: 60 }));
    await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/cancel`, {});
    await settle(s);
    expect(told(s).map((m) => m.text)).toEqual([`await ${w.wait.id} ended without its condition: task ${t}: ended cancelled. It was waiting for ${t} to be in_review.`]);
    expect((await api(token, "GET", `/api/projects/${s.id}/waits`)).body.pending).toEqual([]);
  });

  it("the same wait twice is one wait; a cancelled one tells nothing; there's a cap", async () => {
    const s = await setup();
    const t = await s.task("a");
    const a = ok(await board(s, "await_task", { task: t, states: ["in_review", "done"], timeout_s: 60 }));
    const b = ok(await board(s, "await_task", { task: t, states: ["done", "in_review"], timeout_s: 600 }));
    expect(b.wait.id).toBe(a.wait.id);
    expect(ok(await board(s, "list_waits")).waits).toHaveLength(1);
    ok(await board(s, "cancel_wait", { wait: a.wait.id }));
    await api(token, "POST", `/api/projects/${s.id}/tasks/${t}/done`);
    await settle(s);
    expect(told(s)).toEqual([]);
    // The cap: pending waits on distinct PRs.
    for (let i = 1; i <= MAX_WAITS; i++) ok(await board(s, "await_pr", { pr: 1000 + i, until: "merged", timeout_s: 60 }));
    expect(toolError(await board(s, "await_pr", { pr: 9999, until: "merged", timeout_s: 60 }))).toMatch(/at most 32 waits/);
    expect(toolError(await board(s, "await_task", { task: t, states: ["done"], timeout_s: 5 }))).toMatch(/timeout_s must be at least 10/);
  });
});

describe("await_pr", () => {
  it("merged, closed and review_done, each from its event, once", async () => {
    const s = await setup();
    const merged = ok(await board(s, "await_pr", { pr: 21, until: "merged", timeout_s: 600 }));
    const closed = ok(await board(s, "await_pr", { pr: 22, until: "merged", timeout_s: 600 }));
    const reviewed = ok(await board(s, "await_pr", { pr: 23, until: "review_done", timeout_s: 600 }));
    await stub(s).onPullRequest({ pr: 21, task: null, action: "closed", merged: true });
    await stub(s).onPullRequest({ pr: 22, task: null, action: "closed", merged: false });
    await stub(s).onReviewEnded({ pr: 23, sha: "a".repeat(40), state: "done", conclusion: "success" });
    await stub(s).onReviewEnded({ pr: 23, sha: "a".repeat(40), state: "done", conclusion: "success" });
    await settle(s);
    expect(told(s).map((m) => m.text).sort()).toEqual([
      `await ${closed.wait.id} ended without its condition: PR #22: closed without merging. It was waiting for #22 to merge.`,
      `await ${merged.wait.id}: PR #21: merged.`,
      `await ${reviewed.wait.id}: PR #23: its review is done (success).`,
    ].sort());
  });

  it("answers at once for a PR already recorded merged on a task (README.md#prs)", async () => {
    const s = await setup();
    const t = await s.task("t");
    // Two PRs on one task, one merged: the task stays in review, but that PR has merged.
    await stub(s).onPullRequest({ pr: 31, task: t, action: "opened", merged: false, node: "PR_31", fork: false, title: "t" });
    await stub(s).onPullRequest({ pr: 32, task: t, action: "opened", merged: false, node: "PR_32", fork: false, title: "t" });
    await stub(s).onPullRequest({ pr: 31, task: t, action: "closed", merged: true });
    expect(ok(await board(s, "await_pr", { pr: 31, until: "merged", timeout_s: 600 })).status).toBe("met");
    // The one still open is waited on.
    expect(ok(await board(s, "await_pr", { pr: 32, until: "merged", timeout_s: 600 })).status).toBe("waiting");
  });

  it("a PR merged already answers each call at once: no wait left behind, no message (which would wake the manager to ask again)", async () => {
    const s = await setup();
    const t = await s.task("t");
    await stub(s).onPullRequest({ pr: 41, task: t, action: "opened", merged: false, node: "PR_41", fork: false, title: "t" });
    await stub(s).onPullRequest({ pr: 41, task: t, action: "closed", merged: true });
    for (let i = 0; i < 3; i++) expect(ok(await board(s, "await_pr", { pr: 41, until: "merged", timeout_s: 600 })).status).toBe("met");
    await settle(s);
    expect(told(s)).toEqual([]);
    const rows = await runInDurableObject(stub(s), (_i: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM waits").one().n);
    expect(rows).toBe(0);
  });

  it("keeps the 10 most recent resolved waits, the page's, and prunes the rest", async () => {
    const s = await setup();
    for (let i = 0; i < 13; i++) {
      const w = ok(await board(s, "await_pr", { pr: 500 + i, until: "merged", timeout_s: 600 }));
      ok(await board(s, "cancel_wait", { wait: w.wait.id }));
    }
    const kept = await runInDurableObject(stub(s), (_i: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM waits").one().n);
    expect(kept).toBe(10);
    const recent = (await stub(s).waits()) as { ok: true; value: { recent: { target: string }[] } };
    // The three oldest went (resolved in that order, a few might share a millisecond: compared as a set).
    expect(recent.value.recent.map((w) => w.target).sort()).toEqual(Array.from({ length: 10 }, (_, k) => String(503 + k)).sort());
  });

  it("a review that ends in the queue reaches the wait through ReviewDO's outbox", async () => {
    const s = await setup();
    const w = ok(await board(s, "await_pr", { pr: 31, until: "review_done", timeout_s: 600 }));
    const review = env.REVIEW.get(env.REVIEW.idFromName(s.id));
    await runInDurableObject(review, async (inst: any, st: DurableObjectState) => {
      st.storage.sql.exec("INSERT INTO jobs (pr, sha, state, attempts, created_ms, updated_ms) VALUES (31, ?, 'running', 0, 1, 1)", "b".repeat(40));
      const row = st.storage.sql.exec("SELECT * FROM jobs WHERE pr = 31").one();
      inst.end(row, "done", "success", { title: "t", summary: "s" });
      await inst.drain();
    });
    await settle(s);
    expect(told(s).map((m) => m.text)).toEqual([`await ${w.wait.id}: PR #31: its review is done (success).`]);
  });
});

describe("await_reply", () => {
  it("is met by the owner's chat message, once", async () => {
    const s = await setup();
    const w = ok(await board(s, "await_reply", { timeout_s: 600 }));
    await api(token, "POST", `/api/projects/${s.id}/chat`, { text: "go ahead" });
    await api(token, "POST", `/api/projects/${s.id}/chat`, { text: "and again" });
    await settle(s);
    expect(told(s).map((m) => m.text)).toEqual([`await ${w.wait.id}: the owner: replied in chat.`]);
  });
});
