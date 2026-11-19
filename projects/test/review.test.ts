// The review pipeline (README.md#built-the-review-pipeline) end to end in workerd: GitHub's webhook to /hooks/github, the
// project's ReviewDO queue and its alarm, the reviewer's tools on /mcp/review, and the check runs and
// agents it makes, against a fake GitHub and a fake nest (test/fake-nest.ts).
import { env, runInDurableObject } from "cloudflare:test";
import { githubGuards } from "../src/github-access";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHECK_NAME, signGithub } from "../src/github";
import { MAX_RETRIES } from "../src/do/review";
import { roleTemplate } from "../src/catalog";
import { CODE_REVIEW } from "../src/reviewers";
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

type P2 = "pass" | "fail";
/** `submit_review`'s arguments for the built-in reviewer, each dimension's notes saying its verdict. */
const verdict = (c: P2, q: P2, a: P2) => ({
  verdicts: ([["Correctness", c], ["Quality", q], ["Architectural cohesiveness", a]] as const).map(([dimension, v]) => ({ dimension, verdict: v, notes: `${v} because` })),
  summary: "the summary",
});
/** The review those arguments make, as the API answers it. */
const review = (agent: string, tainted: boolean, c: P2, q: P2, a: P2) => ({
  reviewer: { id: CODE_REVIEW.id, name: CODE_REVIEW.name }, agent, tainted,
  dimensions: verdict(c, q, a).verdicts.map((d) => ({ name: d.dimension, verdict: d.verdict, notes: d.notes })), summary: "the summary",
});

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
    // Whether the app acts for an event's account is read once per isolate (GET /app): an earlier test may
    // have read it already or not, so it's read here first.
    expect((await deliverGithub("pull_request", prEvent({ repo: `nobody/${rand()}`, number: 1, sha: sha(), action: "opened" }))).status).toBe(200);
    const before = gh.calls.length;
    const agents = fake.agents.size;
    const nobody = `nobody/${rand()}`;
    expect(await (await deliverGithub("pull_request", prEvent({ repo: nobody, number: 1, sha: sha(), action: "opened" }))).json()).toEqual({ ignored: "no project for this repo" });
    expect((await deliverGithub("ping", { zen: "Keep it logically awesome.", hook_id: 1 })).status).toBe(200);
    expect((await deliverGithub("issues", { action: "opened", repository: { full_name: "o/r" } })).status).toBe(200);
    expect(gh.callsBesideUpkeep(before, [nobody, "o/r"])).toEqual([]);
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
    // No model chosen: the project's own template on the default (README.md#models).
    const t = roleTemplate("reviewer", p.id, "claude-opus-5-5");
    expect(a.template).toBe(t.name);
    expect(fake.catalog.get(`templates/${t.name}`)).toEqual(t.body);
    expect(a.labels).toMatchObject({ project: p.id, role: "reviewer", pr: "3", sha: s });
    expect(a.sandbox).toMatch(/^sbx_/);
    // It reads the repo and pushes to none.
    expect(a.overrides).toEqual({ repos: [], read_repos: [] });
    expect(fake.sandboxes.get(a.sandbox!)!.layer.guards).toEqual(githubGuards(p.repo, "read"));
    const brief = fake.inbox.find((x) => x.agent === reviewer)!.text;
    for (const part of [p.repo.toLowerCase(), "#3", s, "develop", "submit_review"]) expect(brief).toContain(part);
    // The reviewer it reviews as: its name, its dimensions and its instructions; none of the PR's own text.
    for (const part of [`"${CODE_REVIEW.name}"`, ...CODE_REVIEW.dimensions.map((d) => `"${d}"`), CODE_REVIEW.instructions]) expect(brief).toContain(part);
    expect(brief).not.toContain("PR 3");
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.role === "reviewer" && c.body.labels.project === p.id);
    expect(creates.map((c) => c.idempotencyKey)).toEqual([`${p.id}/review/3/${s}/1/agent`]);
    // The check's token: checks only.
    const made = fake.github.callsTo("POST", new RegExp(`^/repos/${p.repo.toLowerCase()}/check-runs$`));
    expect(made.length).toBeGreaterThan(0);
    for (const c of made) expect(c.permissions).toEqual({ checks: "write" });
    const r = toolOk(await callTool("review", await reviewerToken(p, reviewer, 3, s), "review_get"));
    expect(r).toMatchObject({ repo: p.repo.toLowerCase(), pr: 3, sha: s, base: "develop", title: "PR 3" });
    expect(r.reviewer).toEqual({ name: "Code review", dimensions: ["Correctness", "Quality", "Architectural cohesiveness"], instructions: CODE_REVIEW.instructions });
  });

  it("on the project's reviewers' model: the project's own template, written before the start names it", async () => {
    const p = await newProject();
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { reviewer_model: "claude-haiku-5-5" });
    const { reviewer } = await opened(p, 4);
    const t = roleTemplate("reviewer", p.id, "claude-haiku-5-5");
    expect(fake.agents.get(reviewer)!.template).toBe(t.name);
    expect(fake.catalog.get(`templates/${t.name}`)).toEqual(t.body);
    const put = fake.calls.findIndex((c) => c.method === "PUT" && c.path === `/v1/catalog/templates/${t.name}`);
    const create = fake.calls.findIndex((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.role === "reviewer" && c.body.labels.project === p.id);
    expect(put).toBeGreaterThanOrEqual(0);
    expect(put).toBeLessThan(create);
    // Back to the default: the next review's reviewer starts on it.
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { reviewer_model: "claude-opus-5-5" });
    const next = await opened(p, 5);
    expect(fake.agents.get(next.reviewer)!.template).toBe(roleTemplate("reviewer", p.id, "claude-opus-5-5").name);
    // The running one isn't switched.
    expect(fake.agents.get(reviewer)!.ended).toBe(false);
  });

  it("nest refusing its template's write for good fails the job at once, the project's own template or the shared one", async () => {
    for (const shared of [false, true]) {
      const p = await newProject();
      await api(token, "PATCH", `/api/projects/${p.id}/settings`, { reviewer_model: "claude-haiku-5-5" });
      const s = sha();
      let name = roleTemplate("reviewer", p.id, "claude-haiku-5-5").name;
      if (shared) {
        // An attempt frozen before models were chosen (no model in its spec) starts from the shared template.
        fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
        expect((await push(p, 7, s, "opened")).status).toBe(200);
        await run(p);
        fake.failures = [];
        await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("UPDATE start_specs SET spec = json_remove(spec, '$.model')"); });
        name = "projects/reviewer";
      }
      fake.fail(new RegExp(`^PUT /v1/catalog/templates/${name}$`), 403, { times: 1000 });
      if (shared) await dueNow(p);
      else expect((await push(p, 7, s, "opened")).status).toBe(200);
      await run(p);
      fake.failures = [];
      expect(await job(p, 7, s), name).toMatchObject({ state: "failed" });
      expect(live(p, 7)).toEqual([]);
      expect(fake.calls.filter((c) => c.method === "PUT" && c.path === `/v1/catalog/templates/${name}`).length, name).toBeGreaterThan(0);
    }
  });

  it("an attempt keeps the model it froze when its start is retried after the setting changed, under the same key", async () => {
    const p = await newProject();
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { reviewer_model: "claude-haiku-5-5" });
    fake.fail(/^POST \/v1\/agents$/, 503, { retryable: true, times: 1000 });
    const s = sha();
    expect((await push(p, 6, s, "opened")).status).toBe(200);
    await run(p);
    expect(live(p, 6)).toEqual([]);
    await api(token, "PATCH", `/api/projects/${p.id}/settings`, { reviewer_model: "claude-sonnet-5-5" });
    fake.failures = [];
    await dueNow(p);
    await run(p);
    const [a] = live(p, 6);
    expect(a!.template).toBe(roleTemplate("reviewer", p.id, "claude-haiku-5-5").name);
    const creates = fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.role === "reviewer" && c.body.labels.project === p.id);
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const c of creates) {
      expect(c.idempotencyKey).toBe(`${p.id}/review/6/${s}/1/agent`);
      expect(c.body).toEqual(creates[0]!.body);
    }
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

  it("a draft isn't reviewed: no job, check or reviewer for its pushes, and its head is reviewed once it's marked ready", async () => {
    const p = await newProject();
    const s1 = sha();
    const s2 = sha();
    expect((await push(p, 1, s1, "opened", { draft: true })).status).toBe(200);
    expect((await push(p, 1, s2, "synchronize", { draft: true })).status).toBe(200);
    await run(p);
    expect((await jobs(p)).filter((j) => j.pr === 1)).toEqual([]);
    expect(gh.runsOf(p.repo, s1)).toEqual([]);
    expect(gh.runsOf(p.repo, s2)).toEqual([]);
    expect(reviewers(p, 1)).toEqual([]);

    expect((await push(p, 1, s2, "ready_for_review")).status).toBe(200);
    await run(p);
    expect((await job(p, 1, s2)).state).toBe("running");
    expect(gh.runsOf(p.repo, s2)[0]).toMatchObject({ status: "in_progress" });
    expect(live(p, 1).map((a) => a.labels.sha)).toEqual([s2]);
  });

  it("a PR turned back into a draft ends its review: the reviewer stopped, the check cancelled; an older event delivered late starts nothing", async () => {
    const p = await newProject();
    const first = await opened(p, 1);
    expect((await push(p, 1, first.sha, "converted_to_draft", { draft: true })).status).toBe(200);
    await run(p);
    expect(fake.agents.get(first.reviewer)!.ended).toBe(true);
    expect(gh.runsOf(p.repo, first.sha)[0]).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect((await job(p, 1, first.sha)).state).toBe("superseded");
    // The `opened` (not a draft then) delivered again late: older than the draft, so ignored.
    expect((await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: first.sha, action: "opened", updated_at: "2020-01-01T00:00:00Z" }))).status).toBe(200);
    await run(p);
    expect((await job(p, 1, first.sha)).state).toBe("superseded");
    expect(live(p, 1)).toEqual([]);
    // Its cancelled check re-run from GitHub while it's a draft: nothing starts.
    const cancelled = gh.runsOf(p.repo, first.sha)[0] as any;
    expect((await deliverGithub("check_run", { action: "rerequested", check_run: { id: cancelled.id, name: CHECK_NAME, head_sha: first.sha, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } })).status).toBe(200);
    await run(p);
    expect((await job(p, 1, first.sha)).state).toBe("superseded");
    expect(live(p, 1)).toEqual([]);
    // Marked ready again: the same head is reviewed again, with a new check.
    expect((await push(p, 1, first.sha, "ready_for_review")).status).toBe(200);
    await run(p);
    expect((await job(p, 1, first.sha)).state).toBe("running");
    expect(live(p, 1).map((a) => a.labels.sha)).toEqual([first.sha]);
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
    expect((await job(p, 1, s))).toMatchObject({ state: "done", tainted: false, verdict: { reviews: [review(reviewer, false, "pass", "pass", "pass")] } });
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
    const maybe = verdict("pass", "pass", "pass");
    maybe.verdicts[0] = { ...maybe.verdicts[0]!, verdict: "maybe" as P2 };
    expect(toolError(await callTool("review", t, "submit_review", maybe))).toMatch(/one of pass, fail/);
  });

  it("is refused, recording nothing, unless it names each of its reviewer's dimensions once; then accepted", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    const t = await reviewerToken(p, reviewer, 1, s);
    const all = verdict("pass", "fail", "pass").verdicts;
    const missing = toolError(await callTool("review", t, "submit_review", { verdicts: all.slice(0, 2), summary: "s" }));
    expect(missing).toMatch(/Missing: "Architectural cohesiveness"\./);
    expect(missing).toContain(`"Correctness", "Quality", "Architectural cohesiveness"`);
    expect(toolError(await callTool("review", t, "submit_review", { verdicts: [...all, { dimension: "Style", verdict: "pass", notes: "" }], summary: "s" }))).toMatch(/Not its dimensions: "Style"\./);
    expect(toolError(await callTool("review", t, "submit_review", { verdicts: [...all, all[1]!], summary: "s" }))).toMatch(/Named more than once: "Quality"\./);
    expect(toolError(await callTool("review", t, "submit_review", { verdicts: [], summary: "s" }))).toMatch(/Missing: "Correctness", "Quality", "Architectural cohesiveness"\./);
    // Nothing was recorded: the job still runs, its check in progress.
    expect(await job(p, 1, s)).toMatchObject({ state: "running", verdict: null });
    await run(p);
    expect(gh.runsOf(p.repo, s)[0]!.status).toBe("in_progress");
    // Names as the reviewer wrote them, case and spaces aside, in any order: recorded in the reviewer's own.
    const loose = [{ ...all[2]!, dimension: " architectural Cohesiveness" }, { ...all[0]!, dimension: "correctness" }, all[1]!];
    expect(toolOk(await callTool("review", t, "submit_review", { verdicts: loose, summary: "the summary" })).conclusion).toBe("failure");
    await run(p);
    expect(gh.runsOf(p.repo, s)[0]!.output!.title).toBe("Review failed: quality");
    expect((await job(p, 1, s)).verdict.reviews).toEqual([review(reviewer, false, "pass", "fail", "pass")]);
  });

  it("a reviewer started by the release before submits in its form: accepted as the built-in reviewer's review", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    const t = await reviewerToken(p, reviewer, 1, s, { tainted: true });
    const dim = (v: P2) => ({ verdict: v, notes: `${v} because` });
    // That form gone wrong is refused as it was.
    expect(toolError(await callTool("review", t, "submit_review", { correctness: dim("pass"), quality: dim("pass"), summary: "s" }))).toMatch(/architecture is required/);
    toolOk(await callTool("review", t, "submit_review", { correctness: dim("fail"), quality: dim("pass"), architecture: dim("pass"), summary: "the summary" }));
    await run(p);
    expect(gh.runsOf(p.repo, s)[0]!.output!.title).toBe("Review failed: correctness");
    expect((await job(p, 1, s)).verdict.reviews).toEqual([review(reviewer, true, "fail", "pass", "pass")]);
    // Stored with the release before's keys too, which is all it reads after a rollback.
    const stored = await runInDurableObject(reviews(p), (_o, st) => JSON.parse(st.storage.sql.exec("SELECT verdict FROM jobs WHERE sha = ?", s).one().verdict as string));
    expect(stored).toMatchObject({ correctness: dim("fail"), quality: dim("pass"), architecture: dim("pass"), summary: "the summary" });
  });

  it("a verdict the release before stored reads as one Code review review, through the API and verdictsAt", async () => {
    const p = await newProject();
    const { sha: s, reviewer } = await opened(p);
    const dim = (v: P2) => ({ verdict: v, notes: `${v} because` });
    const old = { correctness: dim("pass"), quality: dim("fail"), architecture: dim("pass"), summary: "the summary" };
    await runInDurableObject(reviews(p), (_o, st) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'done', verdict = ?, tainted = 1 WHERE sha = ?", JSON.stringify(old), s);
    });
    const want = { reviews: [review(reviewer, true, "pass", "fail", "pass")] };
    // The API answers the release before's keys besides, for a page still running its bundle.
    expect((await job(p, 1, s)).verdict).toEqual({ ...want, ...old });
    expect((await reviews(p).jobs()).find((j) => j.sha === s)!.verdict).toEqual(want);
    expect(await reviews(p).verdictsAt([{ pr: 1, sha: s }])).toEqual({ [`1/${s}`]: want });
  });

  it("a routine's recent_activity gives each review by its reviewer, with its dimensions, from either release's rows", async () => {
    const p = await newProject();
    const one = await opened(p, 1);
    const two = await opened(p, 2);
    toolOk(await callTool("review", await reviewerToken(p, one.reviewer, 1, one.sha), "submit_review", { ...verdict("pass", "fail", "pass"), summary: "x".repeat(3000) }));
    const dim = (v: P2) => ({ verdict: v, notes: "n".repeat(1500) });
    await runInDurableObject(reviews(p), (_o, st) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'done', verdict = ?, tainted = 0 WHERE sha = ?", JSON.stringify({ correctness: dim("pass"), quality: dim("pass"), architecture: dim("pass"), summary: "old" }), two.sha);
    });
    const project = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    const activity = await runInDurableObject(project, (o) => (o as unknown as { recentActivity(d: number): Promise<{ reviews: any[] }> }).recentActivity(7));
    const of = (sha: string) => activity.reviews.find((r) => r.sha === sha)!.verdict;
    expect(of(one.sha)).toEqual({
      passed: false,
      reviews: [{
        reviewer: "Code review", passed: false, summary: "x".repeat(2000),
        dimensions: [{ name: "Correctness", verdict: "pass", notes: "pass because" }, { name: "Quality", verdict: "fail", notes: "fail because" }, { name: "Architectural cohesiveness", verdict: "pass", notes: "pass because" }],
      }],
    });
    expect(of(two.sha)).toMatchObject({ passed: true, reviews: [{ reviewer: "Code review", passed: true, summary: "old" }] });
    expect(of(two.sha).reviews[0].dimensions.map((d: { name: string; notes: string }) => [d.name, d.notes.length])).toEqual([["Correctness", 1000], ["Quality", 1000], ["Architectural cohesiveness", 1000]]);
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

describe("the reads the project's pages ask for in one call", () => {
  it("needsYou: the held jobs, oldest first, and the open PRs' heads that got no job (how many, since when)", async () => {
    const p = await newProject();
    await runInDurableObject(reviews(p), async (_o, state) => {
      const sql = state.storage.sql;
      const job = (pr: number, s: string, st: string, at: number) => sql.exec(
        "INSERT INTO jobs (pr, sha, state, title, base, author, author_id, fork, needs_approval, next_ms, created_ms, updated_ms) VALUES (?, ?, ?, 't', 'main', 'a', 1, 1, 1, NULL, ?, ?)",
        pr, s, st, at, at,
      );
      job(8, sha(), "held", 2000);
      job(7, sha(), "held", 1000);
      job(6, sha(), "queued", 500);
      const pr = (n: number, open: number, skipped: number | null) => sql.exec(
        "INSERT INTO prs (pr, sha, base, title, updated_at, open, author, author_id, fork, skipped_ms) VALUES (?, ?, 'main', 't', '2026-01-01T00:00:00Z', ?, 'a', 1, 1, ?)",
        n, sha(), open, skipped,
      );
      pr(20, 1, 1800);
      pr(21, 1, 1700);
      pr(22, 0, 100); // closed: not counted
      pr(23, 1, null);
    });
    const r = await reviews(p).needsYou();
    expect(r.held.map((j) => [j.pr, j.state, j.created_ms])).toEqual([[7, "held", 1000], [8, "held", 2000]]);
    expect(r.skipped).toEqual({ count: 2, at_ms: 1700 });
    expect(r).toEqual({ held: await reviews(p).held(), skipped: await reviews(p).skipped() });
    expect(await reviews(await newProject()).needsYou()).toEqual({ held: [], skipped: { count: 0, at_ms: null } });
  });

  it("reviewSettings: the cap and the untrusted policy as set, defaults none and hold", async () => {
    const p = await newProject();
    expect(await reviews(p).reviewSettings()).toEqual({ max_concurrent_reviews: null, untrusted_reviews: "hold" });
    await reviews(p).setMaxConcurrent(2);
    await reviews(p).setUntrustedPolicy("review");
    expect(await reviews(p).reviewSettings()).toEqual({ max_concurrent_reviews: 2, untrusted_reviews: "review" });
    const s = (await api(token, "GET", `/api/projects/${p.id}/settings`)).body;
    expect([s.max_concurrent_reviews, s.untrusted_reviews]).toEqual([2, "review"]);
  });
});
