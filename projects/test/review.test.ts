// The review pipeline (README.md#built-the-review-pipeline) end to end in workerd: GitHub's webhook to /hooks/github, the
// project's ReviewDO queue and its alarm, the reviewer's tools on /mcp/review, and the check runs and
// agents it makes, against a fake GitHub and a fake nest (test/fake-nest.ts).
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHECK_NAME, signGithub } from "../src/github";
import { MAX_RETRIES } from "../src/do/review";
import { AccessTeam, agentClaims, api, callTool, deliver, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

const fake = new FakeNest();
const gh = fake.github;
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
const eid = () => `evt-${rand()}`;
let clock = Date.parse("2026-11-02T00:00:00Z");
/** Each PR event a later `updated_at` than the last, as GitHub stamps them. */
const later = () => new Date((clock += 1000)).toISOString();

interface P {
  id: string;
  repo: string;
}

async function newProject(o: Record<string, unknown> = {}): Promise<P> {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo };
}

const reviews = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const run = (p: P) => reviews(p).drain();
const jobs = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[];
const job = async (p: P, pr: number, s: string) => (await jobs(p)).find((j) => j.pr === pr && j.sha === s);
const reviewers = (p: P, pr?: number) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer" && (pr === undefined || a.labels.pr === String(pr)));
const live = (p: P, pr?: number) => reviewers(p, pr).filter((a) => !a.ended);

function push(p: P, number: number, s: string, action = "synchronize", o: Record<string, unknown> = {}) {
  return deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action, updated_at: later(), ...o }));
}

/** A PR opened and its review started: its check run in progress and its reviewer briefed. */
async function opened(p: P, number = 1, o: Record<string, unknown> = {}) {
  const s = sha();
  expect((await push(p, number, s, "opened", o)).status).toBe(200);
  await run(p);
  const reviewer = live(p, number).find((a) => a.labels.sha === s)!;
  expect(reviewer).toBeDefined();
  return { sha: s, reviewer: reviewer.agent };
}

const reviewerToken = (p: P, agent: string, pr: number, s: string, over: Record<string, unknown> = {}) =>
  nest.sign(agentClaims("review", agent, { project: p.id, role: "reviewer", pr: String(pr), sha: s, start: "1" }, over));

const dim = (verdict: "pass" | "fail", notes = `${verdict} because`) => ({ verdict, notes });
const verdict = (c: "pass" | "fail", q: "pass" | "fail", a: "pass" | "fail") => ({ correctness: dim(c), quality: dim(q), architecture: dim(a), summary: "the summary" });

const toolOk = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError).toBe(true);
  return r.result.content[0].text as string;
};

/** Make a job's backed-off next step due now. */
const dueNow = (p: P) => runInDurableObject(reviews(p), (_o, st) => { st.storage.sql.exec("UPDATE jobs SET next_ms = 0 WHERE next_ms IS NOT NULL"); });

describe("/hooks/github", () => {
  it("refuses a missing or wrong signature with 401, and acts on neither", async () => {
    const p = await newProject();
    const body = prEvent({ repo: p.repo, number: 1, sha: sha(), action: "opened" });
    expect((await deliverGithub("pull_request", body, { signature: null })).status).toBe(401);
    expect((await deliverGithub("pull_request", body, { secret: "another secret" })).status).toBe(401);
    // A signature over another body: the payload edited after it was signed.
    const signature = await signGithub(env.GITHUB_WEBHOOK_SECRET!, new TextEncoder().encode(JSON.stringify(body)));
    const tampered = prEvent({ repo: p.repo, number: 2, sha: sha(), action: "opened" });
    expect((await deliverGithub("pull_request", tampered, { signature })).status).toBe(401);
    expect(await jobs(p)).toEqual([]);
    // The same body with its own signature is taken.
    expect((await deliverGithub("pull_request", body, { signature })).status).toBe(200);
    expect((await jobs(p)).map((j) => j.pr)).toEqual([1]);
  });

  it("handles a delivery once however often GitHub sends it", async () => {
    const p = await newProject();
    const delivery = crypto.randomUUID();
    const s = sha();
    const body = prEvent({ repo: p.repo, number: 5, sha: s, action: "opened", updated_at: later() });
    expect(await (await deliverGithub("pull_request", body, { delivery })).json()).toEqual({ ok: true });
    expect(await (await deliverGithub("pull_request", body, { delivery })).json()).toEqual({ duplicate: true });
    expect((await deliverGithub("pull_request", body, { delivery: null })).status).toBe(400);
    expect(await jobs(p)).toHaveLength(1);
  });

  it("acknowledges and ignores a repo no project is attached to, ping and other events", async () => {
    const before = gh.calls.length;
    const agents = fake.agents.size;
    expect(await (await deliverGithub("pull_request", prEvent({ repo: `nobody/${rand()}`, number: 1, sha: sha(), action: "opened" }))).json()).toEqual({ ignored: "no project for this repo" });
    expect((await deliverGithub("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).status).toBe(200);
    expect((await deliverGithub("issues", { action: "opened", repository: { full_name: "o/r" } })).status).toBe(200);
    expect(gh.calls.length).toBe(before);
    expect(fake.agents.size).toBe(agents);
  });
});

describe("a PR's review", () => {
  it("creates the check in progress at the head, and starts a labelled reviewer with a sandbox and its brief", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p, 3, { base: "develop" });
    const [check] = gh.runsOf(p.repo, s);
    expect(check).toMatchObject({ name: CHECK_NAME, head_sha: s, status: "in_progress" });
    const a = fake.agents.get(reviewer)!;
    expect(a.template).toBe("projects/reviewer");
    expect(a.labels).toMatchObject({ project: p.id, role: "reviewer", pr: "3", sha: s });
    expect(a.sandbox).toMatch(/^sbx_/);
    // It reads the repo and pushes to none.
    expect(a.overrides).toEqual({ read_repos: [p.repo.toLowerCase()] });
    const brief = fake.inbox.find((x) => x.agent === reviewer)!.text;
    for (const part of [p.repo.toLowerCase(), "#3", s, "develop", "submit_review"]) expect(brief).toContain(part);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.role === "reviewer" && c.body.labels.project === p.id);
    expect(creates.map((c) => c.idempotencyKey)).toEqual([`${p.id}/review/3/${s}/1/agent`]);
    // The check's token: checks only.
    const made = fake.github.callsTo("POST", new RegExp(`^/repos/${p.repo.toLowerCase()}/check-runs$`));
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) expect(c.permissions).toEqual({ checks: "write" });
    const r = toolOk(await callTool("review", await reviewerToken(p, reviewer, 3, s), "review_get"));
    expect(r).toMatchObject({ repo: p.repo.toLowerCase(), pr: 3, sha: s, base: "develop", title: "PR 3" });
  });

  it("a new head supersedes the old one: the old reviewer is stopped, its check cancelled, the new head reviewed", async () => {
    const p = await newProject();
    const first = await opened(p, 1);
    const s2 = sha();
    expect((await push(p, 1, s2)).status).toBe(200);
    await run(p);
    expect(fake.agents.get(first.reviewer)!.ended).toBe(true);
    const stop = fake.calls.find((c) => c.path === `/v1/agents/${first.reviewer}/stop`)!;
    expect(stop.body).toMatchObject({ end: true, destroy_sandbox: true });
    expect(gh.runsOf(p.repo, first.sha)[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(gh.runsOf(p.repo, s2)[0]).toMatchObject({ status: "in_progress" });
    expect(live(p, 1).map((a) => a.labels.sha)).toEqual([s2]);
    expect((await job(p, 1, first.sha)).state).toBe("superseded");
    // A late delivery of the old head (an older updated_at) moves nothing back.
    expect((await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: first.sha, action: "synchronize", updated_at: "2020-01-01T00:00:00Z" }))).status).toBe(200);
    await run(p);
    expect((await job(p, 1, s2)).state).toBe("running");
  });

  it("a new head replaces a job still queued", async () => {
    const p = await newProject({ max_concurrent_reviews: 0 });
    const s1 = sha();
    const s2 = sha();
    await push(p, 1, s1, "opened");
    await push(p, 1, s2);
    await run(p);
    expect((await job(p, 1, s1)).state).toBe("superseded");
    expect((await job(p, 1, s2)).state).toBe("queued");
    expect(gh.runsOf(p.repo, s1)).toEqual([]);
  });

  it("with no max_concurrent_reviews, runs every PR's review at once", async () => {
    const p = await newProject();
    for (const n of [1, 2, 3]) await push(p, n, sha(), "opened");
    await run(p);
    expect((await jobs(p)).map((j) => j.state)).toEqual(["running", "running", "running"]);
    expect(live(p)).toHaveLength(3);
  });

  it("with max_concurrent_reviews 1, runs one and queues the rest, the next as one finishes", async () => {
    const p = await newProject();
    const s = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_concurrent_reviews: 1 });
    expect(s.body.max_concurrent_reviews).toBe(1);
    const heads = [sha(), sha(), sha()];
    for (const [i, h] of heads.entries()) await push(p, i + 1, h, "opened");
    await run(p);
    expect((await jobs(p)).sort((a, b) => a.pr - b.pr).map((j) => j.state)).toEqual(["running", "queued", "queued"]);
    expect(live(p)).toHaveLength(1);
    const first = live(p)[0]!;
    toolOk(await callTool("review", await reviewerToken(p, first.agent, 1, heads[0]!), "submit_review", verdict("pass", "pass", "pass")));
    await run(p);
    expect((await jobs(p)).sort((a, b) => a.pr - b.pr).map((j) => j.state)).toEqual(["done", "running", "queued"]);
    expect(live(p).map((a) => a.labels.pr)).toEqual(["2"]);
    // Unset again: no cap.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { max_concurrent_reviews: null });
    await run(p);
    expect((await jobs(p)).every((j) => j.state !== "queued")).toBe(true);
  });

  it("retries a check run whose create failed, without a second one when its answer was lost", async () => {
    const p = await newProject();
    gh.lost.push({ match: /^POST \/repos\/.*\/check-runs$/, times: 1 });
    const s = sha();
    await push(p, 1, s, "opened");
    await run(p);
    expect((await job(p, 1, s)).error).toMatch(/502/);
    expect(live(p)).toHaveLength(0);
    await dueNow(p);
    await run(p);
    expect(gh.runsOf(p.repo, s)).toHaveLength(1);
    expect((await job(p, 1, s)).check_run).toBe(gh.runsOf(p.repo, s)[0]!.id);
    expect(live(p)).toHaveLength(1);
  });
});

describe("the verdict", () => {
  it("all three pass: the check succeeds with the reviewer's output, and the reviewer is ended", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    const out = toolOk(await callTool("review", await reviewerToken(p, reviewer, 1, s), "submit_review", verdict("pass", "pass", "pass")));
    expect(out.conclusion).toBe("success");
    await run(p);
    const check = gh.runsOf(p.repo, s)[0]!;
    expect(check).toMatchObject({ status: "completed", conclusion: "success" });
    expect(check.output).toMatchObject({ title: "Review passed", summary: "the summary" });
    expect(check.output!.text).toContain("## Correctness: pass\n\npass because");
    expect(check.output!.text).toContain("Tainted: no");
    expect(fake.agents.get(reviewer)!.ended).toBe(true);
    expect((await job(p, 1, s))).toMatchObject({ state: "done", tainted: false, verdict: verdict("pass", "pass", "pass") });
  });

  it("any one failing fails the check, naming it; a tainted session's verdict says so", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    toolOk(await callTool("review", await reviewerToken(p, reviewer, 1, s, { tainted: true }), "submit_review", verdict("pass", "fail", "pass")));
    await run(p);
    const check = gh.runsOf(p.repo, s)[0]!;
    expect(check.conclusion).toBe("failure");
    expect(check.output!.title).toBe("Review failed: quality");
    expect(check.output!.text).toMatch(/Tainted: yes/);
    expect((await job(p, 1, s)).tainted).toBe(true);
  });

  it("is refused for another PR or commit, from another agent, and a second time; a retried call gets its first answer", async () => {
    const p = await newProject();
    const one = await opened(p, 1);
    const two = await opened(p, 2);
    // Its own labels name its job: another PR's or commit's labels aren't its own job.
    expect(toolError(await callTool("review", await reviewerToken(p, one.reviewer, 2, two.sha), "submit_review", verdict("pass", "pass", "pass")))).toMatch(/aren't this review's reviewer/);
    expect(toolError(await callTool("review", await reviewerToken(p, one.reviewer, 1, two.sha), "submit_review", verdict("pass", "pass", "pass")))).toMatch(/no review/);
    expect(toolError(await callTool("review", await reviewerToken(p, "agt_stranger1", 1, one.sha), "submit_review", verdict("pass", "pass", "pass")))).toMatch(/aren't this review's reviewer/);
    // Another project's reviewer.
    const other = await newProject();
    expect(toolError(await callTool("review", await nest.sign(agentClaims("review", one.reviewer, { project: other.id, role: "reviewer", pr: "1", sha: one.sha })), "submit_review", verdict("pass", "pass", "pass")))).toMatch(/no review|unknown project/);
    const t = await reviewerToken(p, one.reviewer, 1, one.sha);
    const key = `${one.reviewer}/1/call-${rand()}`;
    const first = toolOk(await callTool("review", t, "submit_review", verdict("fail", "pass", "pass"), { "nest/call": key }));
    expect(toolOk(await callTool("review", t, "submit_review", verdict("fail", "pass", "pass"), { "nest/call": key }))).toEqual(first);
    expect(toolError(await callTool("review", t, "submit_review", verdict("pass", "pass", "pass")))).toMatch(/already has its verdict/);
    await run(p);
    expect(gh.runsOf(p.repo, one.sha)[0]!.conclusion).toBe("failure");
    expect(gh.runsOf(p.repo, two.sha)[0]!.status).toBe("in_progress");
    expect(toolError(await callTool("review", t, "submit_review", { ...verdict("pass", "pass", "pass"), correctness: { verdict: "maybe", notes: "" } }))).toMatch(/one of pass, fail/);
  });

  it("a reviewer that exits without one is started again, then the check completes without passing", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    let agent = reviewer;
    for (let i = 1; i <= MAX_RETRIES; i++) {
      expect((await deliver({ id: eid(), type: "agent.exited", agent, reason: "exited" })).status).toBe(200);
      await dueNow(p);
      await run(p);
      expect(fake.agents.get(agent)!.ended).toBe(true);
      const next = live(p, 1);
      expect(next, `retry ${i}`).toHaveLength(1);
      expect(next[0]!.agent).not.toBe(agent);
      agent = next[0]!.agent;
      expect(gh.runsOf(p.repo, s)[0]!.status).toBe("in_progress");
    }
    await deliver({ id: eid(), type: "agent.exited", agent, reason: "exited" });
    await run(p);
    expect(live(p, 1)).toHaveLength(0);
    const runs = gh.runsOf(p.repo, s);
    expect(runs).toHaveLength(1);
    // Not success, skipped or neutral, which a required check accepts.
    expect(runs[0]).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(runs[0]!.output!.title).toBe("No verdict");
    expect((await job(p, 1, s)).state).toBe("failed");
    // Each start had keys of its own.
    const keys = fake.calls.filter((c) => c.path === "/v1/agents" && c.method === "POST" && c.body.labels.sha === s).map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(MAX_RETRIES + 1);

    // Re-running the check queues the job again, with a new check run.
    const rerun = { action: "rerequested", check_run: { id: runs[0]!.id, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } };
    expect((await deliverGithub("check_run", rerun)).status).toBe(200);
    await run(p);
    expect((await job(p, 1, s)).state).toBe("running");
    expect(gh.runsOf(p.repo, s).map((r) => r.status)).toEqual(["completed", "in_progress"]);
    expect(live(p, 1)).toHaveLength(1);
  });

  it("a rerequest of another app's check, or of a head that moved on, queues nothing", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    toolOk(await callTool("review", await reviewerToken(p, reviewer, 1, s), "submit_review", verdict("fail", "fail", "fail")));
    await run(p);
    const id = gh.runsOf(p.repo, s)[0]!.id;
    const rerun = (name: string) => ({ action: "rerequested", check_run: { id, name, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } });
    await deliverGithub("check_run", rerun("ci/build"));
    await run(p);
    expect((await job(p, 1, s)).state).toBe("done");
    await push(p, 1, sha());
    await deliverGithub("check_run", rerun(CHECK_NAME));
    await run(p);
    expect((await job(p, 1, s)).state).toBe("done");
  });

  it("closing the PR ends its review", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    await push(p, 1, s, "closed");
    await run(p);
    expect(fake.agents.get(reviewer)!.ended).toBe(true);
    expect(gh.runsOf(p.repo, s)[0]!.conclusion).toBe("cancelled");
    expect((await job(p, 1, s)).state).toBe("closed");
  });
});

describe("tasks and their PRs", () => {
  async function taskWithWorker(p: P) {
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
    expect(a.state).toBe("in_progress");
    return { task: t.id as string, worker: a.assignee as string };
  }
  const task = async (p: P, id: string) => (await api(token, "GET", `/api/projects/${p.id}/tasks/${id}`)).body;

  it("a PR from the task's branch links to it, and its merge makes the task done and ends its worker", async () => {
    const p = await newProject();
    const w = await taskWithWorker(p);
    const s = sha();
    await push(p, 9, s, "opened", { ref: `task/${w.task}` });
    expect(await task(p, w.task)).toMatchObject({ state: "in_review", pr: 9 });
    // Every PR is reviewed, a task's too.
    await run(p);
    expect(live(p, 9)).toHaveLength(1);
    await push(p, 9, s, "closed", { ref: `task/${w.task}`, merged: true });
    const t = await task(p, w.task);
    expect(t.state).toBe("done");
    expect(t.history.at(-1)).toMatchObject({ action: "merged", actor: "app:github" });
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    expect(fake.agents.get(w.worker)!.ended).toBe(true);
  });

  it("a merge the worker reported first is done too; one closed without merging only notes it", async () => {
    const p = await newProject();
    const a = await taskWithWorker(p);
    const b = await taskWithWorker(p);
    const s = sha();
    // The worker reported PR 4; GitHub's opened came later and changes nothing.
    await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => {
      st.storage.sql.exec("UPDATE tasks SET state = 'in_review', pr = 4 WHERE id = ?", a.task);
      st.storage.sql.exec("INSERT INTO task_prs (pr, task, state, attached_by, attached_ms) VALUES (4, ?, 'open', ?, 0)", a.task, a.worker);
    });
    await push(p, 4, s, "opened", { ref: `task/${a.task}` });
    await push(p, 4, s, "closed", { ref: `task/${a.task}`, merged: true });
    expect((await task(p, a.task)).state).toBe("done");
    await push(p, 5, sha(), "opened", { ref: `task/${b.task}` });
    await push(p, 5, sha(), "closed", { ref: `task/${b.task}`, merged: false });
    const tb = await task(p, b.task);
    // Its worker still runs: back in progress, to open another.
    expect(tb.state).toBe("in_progress");
    expect(tb.history.slice(-2)).toMatchObject([{ action: "pr_closed", actor: "app:github" }, { action: "review_ended", actor: "app:github" }]);
    expect(fake.agents.get(b.worker)!.ended).toBe(false);
  });

  it("a fork's branch named like a task's doesn't link to it", async () => {
    const p = await newProject();
    const w = await taskWithWorker(p);
    await push(p, 11, sha(), "opened", { ref: `task/${w.task}`, headRepo: `stranger/${rand()}` });
    await push(p, 11, sha(), "closed", { ref: `task/${w.task}`, headRepo: `stranger/${rand()}`, merged: true });
    expect((await task(p, w.task)).state).toBe("in_progress");
  });
});
