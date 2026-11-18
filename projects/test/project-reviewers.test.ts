// A project's own reviewers (README.md#reviewers): ReviewDO keeps them behind the owner's API, seeded once
// with the built-in "Code review"; a job freezes the enabled ones when it starts and runs them one after
// another (README.md#running-the-reviewers), under the one check. Against a fake GitHub and nest.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHECK_NAME } from "../src/github";
import { MAX_RETRIES, MIGRATIONS } from "../src/do/review";
import { CODE_REVIEW, MAX_REVIEWERS } from "../src/reviewers";
import { migrate } from "../src/sql";
import { AccessTeam, agentClaims, api, callTool, deliver, deliverGithub, FakeNest, installFetch, prEvent, Signer, submitArgs } from "./fake-nest";

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
let clock = Date.parse("2026-11-18T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

interface P { id: string; repo: string; manager: string }
async function newProject(o: Record<string, unknown> = {}): Promise<P> {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo, manager: p.body.settings.manager };
}
const reviews = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const run = (p: P) => reviews(p).drain();
const job = async (p: P, pr: number, s: string) => ((await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[]).find((j) => j.pr === pr && j.sha === s);
const agentsOf = (p: P, pr: number) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer" && a.labels.pr === String(pr));
const live = (p: P, pr: number) => agentsOf(p, pr).filter((a) => !a.ended);
const push = (p: P, number: number, s: string, action = "opened") => deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action, updated_at: later() }));
const dueNow = (p: P) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE jobs SET next_ms = 0 WHERE next_ms IS NOT NULL"); });
const checkOf = (p: P, s: string) => gh.runsOf(p.repo, s).at(-1) as any;
const briefOf = (agent: string) => fake.inbox.find((x) => x.agent === agent && x.request_id?.endsWith("/brief"))!;

const path = (p: P, rest = "") => `/api/projects/${p.id}/reviewers${rest}`;
const listed = async (p: P) => (await api(token, "GET", path(p))).body as any[];
const SECURITY = { name: "Security", instructions: "Look for injection and leaked secrets.", dimensions: ["Injection", "Secrets"], enabled: true };
async function add(p: P, body: Record<string, unknown> = SECURITY) {
  const r = await api(token, "POST", path(p), body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}

const reviewerToken = (p: P, agent: string, pr: number, s: string, over: Record<string, unknown> = {}) =>
  nest.sign(agentClaims("review", agent, { project: p.id, role: "reviewer", pr: String(pr), sha: s, start: "1" }, over));
const submit = async (p: P, agent: string, pr: number, s: string, args: unknown, meta?: Record<string, unknown>) =>
  callTool("review", await reviewerToken(p, agent, pr, s), "submit_review", args, meta);
const security = (i: "pass" | "fail" = "pass", sec: "pass" | "fail" = "pass") => ({
  verdicts: [{ dimension: "Injection", verdict: i, notes: `injection ${i}` }, { dimension: "Secrets", verdict: sec, notes: `secrets ${sec}` }], summary: "sec summary",
});
const toolOk = (r: { status: number; result?: any }) => {
  expect(r.status).toBe(200);
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  return r.result.structuredContent;
};
const toolError = (r: { status: number; result?: any }) => {
  expect(r.result?.isError, JSON.stringify(r.result)).toBe(true);
  return r.result.content[0].text as string;
};

/** A PR opened and its first reviewer at work. */
async function opened(p: P, pr = 1) {
  const s = sha();
  expect((await push(p, pr, s)).status).toBe(200);
  await run(p);
  return s;
}
/** The one live reviewer agent of a PR: never two at once. */
function one(p: P, pr: number) {
  const l = live(p, pr);
  expect(l.map((a) => a.agent)).toHaveLength(1);
  return l[0]!.agent;
}

describe("the project's reviewers", () => {
  it("a new project has exactly the built-in Code review, enabled, written by the owner", async () => {
    const p = await newProject();
    const rs = await listed(p);
    expect(rs).toEqual([{
      id: CODE_REVIEW.id, name: CODE_REVIEW.name, instructions: CODE_REVIEW.instructions, dimensions: CODE_REVIEW.dimensions, enabled: true,
      source: "owner", tainted: false, created_ms: expect.any(Number), updated_ms: expect.any(Number),
    }]);
    expect((await api(token, "GET", path(p, `/${CODE_REVIEW.id}`))).body).toEqual(rs[0]);
  });

  it("a ReviewDO of the release before (jobs, no reviewers) is seeded at its first use, once: one deleted stays deleted", async () => {
    const stub = env.REVIEW.get(env.REVIEW.idFromName(`old-${rand()}`));
    const got = await runInDurableObject(stub, (_o: unknown, st: DurableObjectState) => {
      const sql = st.storage.sql;
      // Back to the previous release's shape: its schema version, no reviewers table, none of the jobs' new columns.
      sql.exec("DROP TABLE reviewers");
      for (const c of ["reviewers", "step", "reviews", "frozen_check"]) sql.exec(`ALTER TABLE jobs DROP COLUMN ${c}`);
      sql.exec("UPDATE schema_version SET v = ?", MIGRATIONS.length - 1);
      sql.exec("INSERT INTO jobs (pr, sha, state, created_ms, updated_ms) VALUES (1, 'a', 'done', 1, 1)");
      migrate(st.storage, MIGRATIONS);
      const seeded = sql.exec("SELECT id, name, enabled, source, tainted, dimensions FROM reviewers").toArray();
      const old = sql.exec("SELECT reviewers, step, reviews, frozen_check FROM jobs").toArray();
      sql.exec("DELETE FROM reviewers");
      migrate(st.storage, MIGRATIONS);
      return { seeded, old, after: sql.exec("SELECT COUNT(*) AS n FROM reviewers").one().n };
    });
    expect(got.seeded).toEqual([{ id: CODE_REVIEW.id, name: CODE_REVIEW.name, enabled: 1, source: "owner", tainted: 0, dimensions: JSON.stringify(CODE_REVIEW.dimensions) }]);
    expect(got.old).toEqual([{ reviewers: null, step: 0, reviews: null, frozen_check: null }]);
    expect(got.after).toBe(0);
  });

  it("deleted, the built-in stays gone; the preset adds it back once", async () => {
    const p = await newProject();
    expect((await api(token, "DELETE", path(p, `/${CODE_REVIEW.id}`))).body).toEqual({ deleted: CODE_REVIEW.id });
    await reviews(p).drain();
    expect(await listed(p)).toEqual([]);
    expect((await api(token, "DELETE", path(p, `/${CODE_REVIEW.id}`))).status).toBe(404);
    const back = await add(p, { preset: "code" });
    expect(back).toMatchObject({ id: CODE_REVIEW.id, name: CODE_REVIEW.name, enabled: true, source: "owner", tainted: false });
    const again = await api(token, "POST", path(p), { preset: "code" });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already/);
    expect((await listed(p)).map((r) => r.id)).toEqual([CODE_REVIEW.id]);
  });

  it("create, change and delete, in creation order; a write is the owner's, and clears a taint only by writing all the text", async () => {
    const p = await newProject();
    const sec = await add(p);
    expect(sec).toMatchObject({ ...SECURITY, id: expect.stringMatching(/^rvw_[a-z0-9]+$/), source: "owner", tainted: false });
    // As the manager's tainted session would have left it (its tools come later): the owner's write is theirs, but
    // its text stays tainted until they write all of it.
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE reviewers SET source = 'manager', tainted = 1 WHERE id = ?", sec.id); });
    const patched = await api(token, "PATCH", path(p, `/${sec.id}`), { enabled: false, dimensions: [" Injection ", "Secrets", "Auth"] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body).toMatchObject({ name: "Security", enabled: false, dimensions: ["Injection", "Secrets", "Auth"], source: "owner", tainted: true });
    expect((await api(token, "PATCH", path(p, `/${sec.id}`), {})).body).toMatchObject({ source: "owner", tainted: true });
    const rewritten = await api(token, "PATCH", path(p, `/${sec.id}`), { name: "Security", instructions: SECURITY.instructions, dimensions: ["Injection", "Secrets", "Auth"] });
    expect(rewritten.body).toMatchObject({ source: "owner", tainted: false, enabled: false });
    const third = await add(p, { ...SECURITY, name: "Docs" });
    expect((await listed(p)).map((r) => r.name)).toEqual(["Code review", "Security", "Docs"]);
    expect((await api(token, "DELETE", path(p, `/${sec.id}`))).status).toBe(200);
    expect((await listed(p)).map((r) => r.id)).toEqual([CODE_REVIEW.id, third.id]);
    for (const [m, b] of [["GET", undefined], ["PATCH", { enabled: true }], ["DELETE", undefined]] as const) {
      const r = await api(token, m, path(p, `/${sec.id}`), b);
      expect(r.status, m).toBe(404);
      expect(r.body.error).toBe("unknown reviewer");
    }
  });

  it(`at most ${MAX_REVIEWERS} per project`, async () => {
    const p = await newProject();
    for (let i = 1; i < MAX_REVIEWERS; i++) await add(p, { ...SECURITY, name: `R${i}` });
    const over = await api(token, "POST", path(p), { ...SECURITY, name: "one too many" });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe(`a project holds at most ${MAX_REVIEWERS} reviewers`);
    expect(await listed(p)).toHaveLength(MAX_REVIEWERS);
  });

  it("each field's bounds, and dimension names unique without case, refused with the reason", async () => {
    const p = await newProject();
    const x = (n: number) => "x".repeat(n);
    const bad: [string, Record<string, unknown>, RegExp][] = [
      ["no name", { ...SECURITY, name: "" }, /name/],
      ["name of spaces", { ...SECURITY, name: "   " }, /name/],
      ["name too long", { ...SECURITY, name: x(81) }, /name/],
      ["no instructions", { ...SECURITY, instructions: "" }, /instructions/],
      ["instructions too long", { ...SECURITY, instructions: x(8001) }, /instructions/],
      ["no dimensions", { ...SECURITY, dimensions: [] }, /dimensions/],
      ["seven dimensions", { ...SECURITY, dimensions: ["a", "b", "c", "d", "e", "f", "g"] }, /dimensions/],
      ["an empty dimension", { ...SECURITY, dimensions: ["a", " "] }, /dimensions/],
      ["a dimension too long", { ...SECURITY, dimensions: [x(61)] }, /dimensions/],
      ["the same dimension twice, case aside", { ...SECURITY, dimensions: ["Auth", " auth"] }, /dimension names must differ/],
      ["enabled missing", { name: "a", instructions: "b", dimensions: ["c"] }, /enabled/],
      ["an unknown field", { ...SECURITY, model: "x" }, /model|unrecognized/i],
      ["an unknown preset", { preset: "lint" }, /preset|body/],
      ["a preset with fields", { preset: "code", name: "x" }, /./],
    ];
    for (const [what, body, why] of bad) {
      const r = await api(token, "POST", path(p), body);
      expect(r.status, what).toBe(400);
      expect(r.body.error, what).toMatch(why);
    }
    const patch = await api(token, "PATCH", path(p, `/${CODE_REVIEW.id}`), { dimensions: ["A", "a"] });
    expect(patch.status).toBe(400);
    // At the bounds: taken.
    const edge = await add(p, { name: x(80), instructions: x(8000), dimensions: ["a", "b", "c", "d", "e", x(60)], enabled: true });
    expect(edge).toMatchObject({ name: x(80), dimensions: ["a", "b", "c", "d", "e", x(60)] });
    expect((await listed(p)).map((r) => r.id)).toEqual([CODE_REVIEW.id, edge.id]);
  });
});

describe("a job runs its reviewers one after another", () => {
  it("the built-in alone: its brief, check and verdict as before", async () => {
    const p = await newProject();
    const s = await opened(p);
    const a = one(p, 1);
    expect(checkOf(p, s).output).toEqual({ title: "Reviewing", summary: `A reviewer agent is reviewing ${s}: correctness, quality and architectural cohesiveness.` });
    expect(briefOf(a).from).toBeUndefined();
    expect(toolOk(await submit(p, a, 1, s, submitArgs("pass", "fail", "pass", "n", "sum")))).toEqual({ recorded: true, passed: false, conclusion: "failure" });
    await run(p);
    const c = checkOf(p, s);
    expect(c).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(c.output).toEqual({
      title: "Review failed: quality", summary: "sum",
      text: `## Correctness: pass\n\nn\n\n## Quality: fail\n\nn\n\n## Architectural cohesiveness: pass\n\nn\n\n---\n\nReviewer: ${a}. Tainted: no.`,
    });
    expect(await job(p, 1, s)).toMatchObject({ state: "done", step: 0, reviewers: [{ id: CODE_REVIEW.id, tainted: false }], reviews: [{ reviewer: { id: CODE_REVIEW.id } }] });
  });

  it("two: in creation order, one agent at a time, the first stopped on its verdict; the second runs though the first failed; the check names the failures", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    const first = one(p, 1);
    expect(briefOf(first).text).toContain(`"${CODE_REVIEW.name}"`);
    expect(checkOf(p, s).output.title).toBe("Reviewing: Code review (1 of 2)");
    toolOk(await callTool("review", await reviewerToken(p, first, 1, s), "review_get"));
    expect(toolOk(await submit(p, first, 1, s, submitArgs("pass", "fail", "pass")))).toEqual({ recorded: true, passed: false, conclusion: null, next: "reviewer 2 of 2" });
    expect(checkOf(p, s).status).toBe("in_progress");
    await run(p);
    expect(fake.agents.get(first)!.ended).toBe(true);
    const second = one(p, 1);
    expect(second).not.toBe(first);
    // The first's stop (with its sandbox) went before the second's create.
    const stopAt = fake.calls.findIndex((c) => c.path === `/v1/agents/${first}/stop`);
    const createAt = fake.calls.findIndex((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.pr === "1" && c.body.labels.project === p.id && c.body.labels.start === "2");
    expect(fake.calls[stopAt]!.body).toMatchObject({ end: true, destroy_sandbox: true });
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(createAt);
    expect(fake.calls[createAt]!.idempotencyKey).toBe(`${p.id}/review/1/${s}/2/agent`);
    // Its brief: its reviewer, dimensions and instructions.
    const brief = briefOf(second).text;
    for (const part of [`"Security"`, `"Injection"`, `"Secrets"`, SECURITY.instructions]) expect(brief).toContain(part);
    expect(brief).not.toContain(CODE_REVIEW.instructions);
    expect(checkOf(p, s).output).toMatchObject({ title: "Reviewing: Security (2 of 2)", summary: expect.stringContaining(`Reviewer 2 of 2, Security, is reviewing ${s}: injection and secrets.`) });
    // The tools are the current agent's: the stopped first one's are refused.
    expect(toolError(await callTool("review", await reviewerToken(p, first, 1, s), "review_get"))).toMatch(/current reviewer/);
    expect(toolError(await submit(p, first, 1, s, submitArgs()))).toMatch(/aren't this review's reviewer/);
    // The Code review's dimensions aren't the second's.
    expect(toolError(await submit(p, second, 1, s, submitArgs()))).toMatch(/Security's dimensions/);
    expect(toolOk(await callTool("review", await reviewerToken(p, second, 1, s), "review_get")).reviewer).toEqual({ name: "Security", dimensions: SECURITY.dimensions, instructions: SECURITY.instructions });
    expect(toolOk(await submit(p, second, 1, s, security("pass", "fail")))).toEqual({ recorded: true, passed: false, conclusion: "failure" });
    await run(p);
    expect(live(p, 1)).toEqual([]);
    const c = checkOf(p, s);
    expect(c).toMatchObject({ status: "completed", conclusion: "failure" });
    expect(c.output.title).toBe("Review failed: Code review (quality); Security (secrets)");
    expect(c.output.text).toContain(`# Code review: failed`);
    expect(c.output.text).toContain(`Reviewer: ${first}. Tainted: no.`);
    expect(c.output.text).toContain(`# Security: failed\n\n## Injection: pass\n\ninjection pass\n\n## Secrets: fail\n\nsecrets fail\n\nReviewer: ${second}. Tainted: no.`);
    expect(gh.runsOf(p.repo, s)).toHaveLength(1);
    const j = await job(p, 1, s);
    expect(j).toMatchObject({ state: "done", step: 1 });
    expect(j.verdict.reviews.map((r: any) => [r.reviewer.name, r.agent])).toEqual([["Code review", first], ["Security", second]]);
  });

  it("passes only when both pass", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    toolOk(await submit(p, one(p, 1), 1, s, submitArgs()));
    await run(p);
    toolOk(await submit(p, one(p, 1), 1, s, security()));
    await run(p);
    expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "success", output: { title: "Review passed" } });
    // The worker's PR read finds a passed verdict at that head.
    expect(Object.keys(await reviews(p).verdictsAt([{ pr: 1, sha: s }]))).toEqual([`1/${s}`]);
  });

  it("a stopped earlier reviewer's retried submit gets its first answer by its call key; a new one is refused", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    const first = one(p, 1);
    const key = { "nest/call": `${first}/call-1` };
    const answer = toolOk(await submit(p, first, 1, s, submitArgs(), key));
    await run(p);
    expect(fake.agents.get(first)!.ended).toBe(true);
    expect(toolOk(await submit(p, first, 1, s, submitArgs(), key))).toEqual(answer);
    expect(toolError(await submit(p, first, 1, s, submitArgs(), { "nest/call": `${first}/call-2` }))).toMatch(/aren't this review's reviewer/);
    expect((await job(p, 1, s)).reviews).toHaveLength(1);
  });

  it("a tainted reviewer's brief is relayed text; an untainted one's isn't", async () => {
    const p = await newProject();
    const sec = await add(p);
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE reviewers SET tainted = 1 WHERE id = ?", sec.id); });
    const s = await opened(p);
    const first = one(p, 1);
    expect(briefOf(first).from).toBeUndefined();
    toolOk(await submit(p, first, 1, s, submitArgs()));
    await run(p);
    const second = one(p, 1);
    expect(briefOf(second)).toMatchObject({ from: "projects/board", text: expect.stringContaining(SECURITY.instructions) });
    expect((await job(p, 1, s)).reviewers.map((r: any) => r.tainted)).toEqual([false, true]);
  });

  it("each reviewer has its own retries: the first's two don't use up the second's; the second's three exits fail the job with the first's review shown", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    const exit = async (agent: string) => {
      expect((await deliver({ id: eid(), type: "agent.exited", agent, reason: "exited" })).status).toBe(200);
      await dueNow(p);
      await run(p);
    };
    for (let i = 0; i < MAX_RETRIES; i++) await exit(one(p, 1));
    const first = one(p, 1);
    toolOk(await submit(p, first, 1, s, submitArgs()));
    await run(p);
    const seconds: string[] = [];
    for (let i = 0; i <= MAX_RETRIES; i++) {
      const a = one(p, 1);
      seconds.push(a);
      expect(briefOf(a).text).toContain(`"Security"`);
      await exit(a);
    }
    expect(new Set(seconds).size).toBe(MAX_RETRIES + 1);
    expect(live(p, 1)).toEqual([]);
    const c = checkOf(p, s);
    expect(c).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(c.output.title).toBe("No verdict");
    expect(c.output.summary).toMatch(/^Security \(reviewer 2 of 2\): 3 reviewers ended without submitting a verdict/);
    expect(c.output.text).toContain(`# Code review: passed`);
    expect(c.output.text).toContain(`Reviewer: ${first}.`);
    const j = await job(p, 1, s);
    expect(j).toMatchObject({ state: "failed", verdict: null, step: 1, reviews: [{ reviewer: { name: "Code review" }, agent: first }] });
    // Every start had keys of its own: 3 + 1 for the first reviewer, 3 for the second.
    const keys = fake.calls.filter((c) => c.method === "POST" && c.path === "/v1/agents" && c.body.labels.project === p.id && c.body.labels.sha === s).map((c) => c.idempotencyKey);
    expect(new Set(keys).size).toBe(2 * (MAX_RETRIES + 1));
  });

  it("a job runs the reviewers it froze: edits, deletes and new ones reach the next job and a re-run", async () => {
    const p = await newProject();
    const sec = await add(p);
    const s = await opened(p);
    // While the first reviewer works: the second's instructions change, then it's deleted; a new one; the built-in disabled.
    await api(token, "PATCH", path(p, `/${sec.id}`), { instructions: "Changed instructions." });
    await api(token, "DELETE", path(p, `/${sec.id}`));
    const docs = await add(p, { name: "Docs", instructions: "Docs up to date?", dimensions: ["Docs"], enabled: true });
    await api(token, "PATCH", path(p, `/${CODE_REVIEW.id}`), { enabled: false });
    toolOk(await submit(p, one(p, 1), 1, s, submitArgs()));
    await run(p);
    const second = one(p, 1);
    expect(briefOf(second).text).toContain(SECURITY.instructions);
    expect(briefOf(second).text).not.toContain("Changed instructions.");
    toolOk(await submit(p, second, 1, s, security()));
    await run(p);
    expect(checkOf(p, s).conclusion).toBe("success");
    expect((await job(p, 1, s)).reviewers.map((r: any) => r.name)).toEqual(["Code review", "Security"]);
    // The next job: the set as it is now.
    const s2 = await opened(p, 2);
    expect((await job(p, 2, s2)).reviewers.map((r: any) => r.id)).toEqual([docs.id]);
    expect(briefOf(one(p, 2)).text).toContain("Docs up to date?");
    // GitHub's Re-run of the first: starts over with the set as it is now.
    const rerun = { action: "rerequested", check_run: { id: checkOf(p, s).id, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } };
    expect((await deliverGithub("check_run", rerun)).status).toBe(200);
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 0, reviews: [], reviewers: [{ id: docs.id }] });
    expect(briefOf(one(p, 1)).text).toContain("Docs up to date?");
  });

  it("a run the release before made of a job (it leaves the reviewers columns as they were) is never taken for this release's", async () => {
    const p = await newProject();
    const sec = await add(p);
    const s = await opened(p);
    toolOk(await submit(p, one(p, 1), 1, s, submitArgs()));
    await run(p);
    const second = one(p, 1);
    toolOk(await submit(p, second, 1, s, security()));
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "done", step: 1 });
    // That release runs the job again (a Re-run): its own check run, the job running, nothing of these columns touched.
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'running', check_run = check_run + 1000, verdict = NULL, agent = 'agt_old', briefed = 1, next_ms = NULL, deadline_ms = ?", Date.now() + 3_600_000);
    });
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 0, reviews: [], reviewers: [{ id: CODE_REVIEW.id }] });
    expect(toolError(await submit(p, second, 1, s, security()))).toMatch(/aren't this review's reviewer/);
    toolOk(await submit(p, "agt_old", 1, s, submitArgs()));
    expect((await job(p, 1, s)).verdict.reviews.map((x: any) => x.agent)).toEqual(["agt_old"]);
    // Started there, its check run's create failing (none named yet): still not this release's.
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'running', check_run = NULL, verdict = NULL, agent = 'agt_old2', step = 1");
    });
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 0, reviews: [], reviewers: [{ id: CODE_REVIEW.id }] });
    // And requeued there (its reset clears the check, not these columns): this release's start freezes afresh.
    await api(token, "PATCH", path(p, `/${sec.id}`), { enabled: false });
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'queued', check_run = NULL, verdict = NULL, agent = NULL, briefed = 0, next_ms = 0, deadline_ms = NULL");
    });
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 0, reviews: [], reviewers: [{ id: CODE_REVIEW.id }] });
  });

  it("the earlier agent's exit after its verdict spends nothing of the next reviewer's; the next one's deadline is its own", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    const first = one(p, 1);
    toolOk(await submit(p, first, 1, s, submitArgs()));
    // Its exit lands before the next agent is named, and again after.
    await deliver({ id: eid(), type: "agent.exited", agent: first, reason: "exited" });
    await run(p);
    const second = one(p, 1);
    await deliver({ id: eid(), type: "agent.exited", agent: first, reason: "exited" });
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 1, attempts: 0, agent: second });
    expect(fake.agents.get(second)!.ended).toBe(false);
    // The second's 60 minutes pass: an attempt of its own spent, a new agent for the same reviewer.
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => { st.storage.sql.exec("UPDATE jobs SET deadline_ms = 0 WHERE state = 'running'"); });
    await run(p);
    await dueNow(p);
    await run(p);
    expect(fake.agents.get(second)!.ended).toBe(true);
    const third = one(p, 1);
    expect(briefOf(third).text).toContain(`"Security"`);
    expect(await job(p, 1, s)).toMatchObject({ state: "running", step: 1, attempts: 1 });
  });

  it("a head superseded between a reviewer's verdict and the next one's start: no next agent, the check cancelled", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    const first = one(p, 1);
    toolOk(await submit(p, first, 1, s, submitArgs()));
    const s2 = sha();
    await push(p, 1, s2, "synchronize");
    await run(p);
    expect(agentsOf(p, 1).filter((a) => a.labels.sha === s).map((a) => [a.agent, a.ended])).toEqual([[first, true]]);
    expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect(await job(p, 1, s)).toMatchObject({ state: "superseded", reviews: [{ agent: first }] });
  });

  it("a head superseded during the second reviewer: that agent stopped, the check cancelled", async () => {
    const p = await newProject();
    await add(p);
    const s = await opened(p);
    toolOk(await submit(p, one(p, 1), 1, s, submitArgs()));
    await run(p);
    const second = one(p, 1);
    const s2 = sha();
    await push(p, 1, s2, "synchronize");
    await run(p);
    expect(fake.agents.get(second)!.ended).toBe(true);
    expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect((await job(p, 1, s)).state).toBe("superseded");
    expect(live(p, 1).map((a) => a.labels.sha)).toEqual([s2]);
  });
});

describe("no reviewer enabled", () => {
  it("no agent and no sandbox: the job is done, its check neutral saying so; no failed review for the worker; the manager's wait and a routine see it", async () => {
    const p = await newProject();
    await api(token, "PATCH", path(p, `/${CODE_REVIEW.id}`), { enabled: false });
    const board = async (args: Record<string, unknown>) =>
      toolOk(await callTool("board", await nest.sign(agentClaims("board", p.manager, { project: p.id, role: "manager", start: "1" })), "await_pr", args));
    // A wait made before the review ends is told by ReviewDO's word, one made after answers at once: the same words.
    const pending = await board({ pr: 1, until: "review_done", timeout_s: 600 });
    expect(pending.status).toBe("waiting");
    const sandboxes = fake.sandboxes.size;
    const s = await opened(p);
    await run(p);
    expect(agentsOf(p, 1)).toEqual([]);
    expect(fake.sandboxes.size).toBe(sandboxes);
    const c = checkOf(p, s);
    expect(c).toMatchObject({ name: CHECK_NAME, status: "completed", conclusion: "neutral", output: { title: "No reviewer enabled" } });
    expect(await job(p, 1, s)).toMatchObject({ state: "done", verdict: null, reviewers: [], reviews: [] });
    // PR upkeep reads no verdict at that head: nothing failed to tell its worker of.
    expect(await reviews(p).verdictsAt([{ pr: 1, sha: s }])).toEqual({});
    // What a routine's recent_activity answers (ProjectDO's own, read in it).
    const inProject = runInDurableObject as unknown as (s: unknown, f: (o: { recentActivity(days: number): Promise<any> }) => Promise<any>) => Promise<any>;
    const activity = await inProject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (o) => o.recentActivity(7));
    expect(activity.reviews).toEqual([expect.objectContaining({ pr: 1, sha: s, state: "done", verdict: null, conclusion: "no reviewer enabled" })]);
    expect(await board({ pr: 1, until: "review_done", timeout_s: 600 })).toMatchObject({ status: "met", detail: "PR #1: its review is done (no reviewer enabled)" });
    await env.PROJECT.get(env.PROJECT.idFromName(p.id)).drain();
    expect(fake.inbox.filter((m) => m.agent === p.manager && m.text.startsWith("await ")).map((m) => m.text)).toEqual([`await ${pending.wait.id}: PR #1: its review is done (no reviewer enabled).`]);
    // Enabled again: a re-run reviews it.
    await api(token, "PATCH", path(p, `/${CODE_REVIEW.id}`), { enabled: true });
    await deliverGithub("check_run", { action: "rerequested", check_run: { id: c.id, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } });
    await run(p);
    expect(live(p, 1)).toHaveLength(1);
  });
});

describe("the manager's reviewer tools (README.md#reviewers)", () => {
  const managerOf = (p: P, tainted = false, agent = p.manager) => nest.sign(agentClaims("board", agent, { project: p.id, role: "manager", start: "1" }, { tainted }));
  const board = async (p: P, tool: string, args: Record<string, unknown> = {}, o: { tainted?: boolean; key?: string } = {}) =>
    callTool("board", await managerOf(p, o.tainted), tool, args, o.key ? { "nest/call": o.key } : undefined);
  /** A reviewer's row as stored, every column. */
  const row = (p: P, id: string) =>
    runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT * FROM reviewers WHERE id = ?", id).toArray()[0] ?? null);
  const taint = async (p: P, id: string) => {
    const r = (await listed(p)).find((x) => x.id === id);
    return [r.source, r.tainted];
  };

  it("lists as the API does; creates from the preset or every field; changes a field, disables and enables; deletes", async () => {
    const p = await newProject();
    expect(toolOk(await board(p, "list_reviewers"))).toEqual({ reviewers: await listed(p) });
    const made = toolOk(await board(p, "create_reviewer", SECURITY));
    expect(made).toMatchObject({ ...SECURITY, id: expect.stringMatching(/^rvw_[a-z0-9]+$/), source: "manager", tainted: false });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: made.id, dimensions: ["Injection", "Secrets", "Auth"] }))).toMatchObject({ name: "Security", dimensions: ["Injection", "Secrets", "Auth"], enabled: true });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: made.id, enabled: false }))).toMatchObject({ enabled: false, dimensions: ["Injection", "Secrets", "Auth"] });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: made.id, enabled: true })).enabled).toBe(true);
    expect(toolOk(await board(p, "delete_reviewer", { reviewer: CODE_REVIEW.id }))).toEqual({ deleted: CODE_REVIEW.id });
    const preset = toolOk(await board(p, "create_reviewer", { preset: "code" }));
    expect(preset).toMatchObject({ id: CODE_REVIEW.id, name: CODE_REVIEW.name, dimensions: CODE_REVIEW.dimensions, enabled: true, source: "manager", tainted: false });
    expect((await listed(p)).map((r) => r.id)).toEqual([made.id, CODE_REVIEW.id]);
    expect(toolOk(await board(p, "list_reviewers"))).toEqual({ reviewers: await listed(p) });
    expect(toolOk(await board(p, "delete_reviewer", { reviewer: made.id }))).toEqual({ deleted: made.id });
    expect((await api(token, "GET", path(p, `/${made.id}`))).status).toBe(404);
  });

  it("refuses what the API refuses, with the API's reason", async () => {
    const p = await newProject();
    const both = async (tool: string, args: Record<string, unknown>, method: string, rest: string, body?: unknown) => {
      const viaApi = await api(token, method, path(p, rest), body);
      expect(viaApi.status, JSON.stringify(viaApi.body)).toBeGreaterThanOrEqual(400);
      expect(toolError(await board(p, tool, args))).toBe(viaApi.body.error);
      return viaApi.body.error as string;
    };
    // A bad field, every field missing one, a preset with fields.
    const twice = { ...SECURITY, dimensions: ["Auth", " auth"] };
    expect(await both("create_reviewer", twice, "POST", "", twice)).toMatch(/dimension names must differ/);
    expect(await both("create_reviewer", { ...SECURITY, name: "" }, "POST", "", { ...SECURITY, name: "" })).toMatch(/name/);
    expect(await both("create_reviewer", { name: "half" }, "POST", "", { name: "half" })).toMatch(/instructions/);
    expect(await both("create_reviewer", { preset: "code", name: "x" }, "POST", "", { preset: "code", name: "x" })).toBeTruthy();
    expect(await both("update_reviewer", { reviewer: CODE_REVIEW.id, dimensions: ["A", "a"] }, "PATCH", `/${CODE_REVIEW.id}`, { dimensions: ["A", "a"] })).toMatch(/dimension names must differ/);
    // The preset twice.
    expect(await both("create_reviewer", { preset: "code" }, "POST", "", { preset: "code" })).toMatch(/already/);
    // An unknown reviewer.
    expect(await both("update_reviewer", { reviewer: "rvw_nope", enabled: false }, "PATCH", "/rvw_nope", { enabled: false })).toBe("unknown reviewer");
    expect(await both("delete_reviewer", { reviewer: "rvw_nope" }, "DELETE", "/rvw_nope")).toBe("unknown reviewer");
    // The limit, for a tainted session too.
    for (let i = 1; i < MAX_REVIEWERS; i++) await add(p, { ...SECURITY, name: `R${i}` });
    expect(await both("create_reviewer", SECURITY, "POST", "", SECURITY)).toBe(`a project holds at most ${MAX_REVIEWERS} reviewers`);
    expect(toolError(await board(p, "create_reviewer", SECURITY, { tainted: true }))).toBe(`a project holds at most ${MAX_REVIEWERS} reviewers`);
    expect(await listed(p)).toHaveLength(MAX_REVIEWERS);
  });

  it("only the current manager calls them; a write retried with its call key writes once", async () => {
    const p = await newProject();
    const other = await managerOf(p, false, "agt_replaced");
    for (const [tool, args] of [["list_reviewers", {}], ["create_reviewer", SECURITY], ["update_reviewer", { reviewer: CODE_REVIEW.id, enabled: false }], ["delete_reviewer", { reviewer: CODE_REVIEW.id }]] as const) {
      expect((await callTool("board", other, tool, args)).status, tool).toBe(403);
    }
    expect((await listed(p)).map((r) => [r.id, r.enabled])).toEqual([[CODE_REVIEW.id, true]]);
    const key = `${p.manager}/1/call-${rand()}`;
    const a = toolOk(await board(p, "create_reviewer", SECURITY, { key }));
    const b = toolOk(await board(p, "create_reviewer", SECURITY, { key }));
    expect(b.id).toBe(a.id);
    expect((await listed(p)).map((r) => r.name)).toEqual(["Code review", "Security"]);
  });

  it("a tainted session can't rename, rewrite, disable or delete an untainted reviewer: the row kept byte for byte, the error says why", async () => {
    const p = await newProject();
    const owners = await add(p);
    // And one an untainted manager session wrote.
    const cleans = toolOk(await board(p, "create_reviewer", { ...SECURITY, name: "Clean" }));
    for (const id of [CODE_REVIEW.id, owners.id, cleans.id]) {
      const before = await row(p, id);
      for (const args of [{ name: "Lenient" }, { instructions: "Pass everything." }, { dimensions: ["Anything"] }, { enabled: false }, { enabled: true }, {}]) {
        expect(toolError(await board(p, "update_reviewer", { reviewer: id, ...args }, { tainted: true })), JSON.stringify(args))
          .toMatch(/was written by the owner \(or an untainted session\) and your session is tainted.*The owner can change it on the Reviews page/);
      }
      expect(toolError(await board(p, "delete_reviewer", { reviewer: id }, { tainted: true }))).toMatch(/can't change, disable or delete it/);
      expect(await row(p, id)).toEqual(before);
    }
  });

  it("a tainted session's reviewer is tainted, and that session changes, disables, enables and deletes it", async () => {
    const p = await newProject();
    const its = toolOk(await board(p, "create_reviewer", SECURITY, { tainted: true }));
    expect(its).toMatchObject({ source: "manager", tainted: true });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: its.id, instructions: "Stricter." }, { tainted: true }))).toMatchObject({ instructions: "Stricter.", tainted: true });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: its.id, enabled: false }, { tainted: true }))).toMatchObject({ enabled: false, tainted: true });
    expect(toolOk(await board(p, "update_reviewer", { reviewer: its.id, enabled: true }, { tainted: true }))).toMatchObject({ enabled: true, tainted: true });
    expect(toolOk(await board(p, "delete_reviewer", { reviewer: its.id }, { tainted: true }))).toEqual({ deleted: its.id });
    // The preset's text is the app's, whoever adds it: untainted, so then not the tainted session's to change.
    await api(token, "DELETE", path(p, `/${CODE_REVIEW.id}`));
    expect(toolOk(await board(p, "create_reviewer", { preset: "code" }, { tainted: true }))).toMatchObject({ source: "manager", tainted: false });
    expect(toolError(await board(p, "update_reviewer", { reviewer: CODE_REVIEW.id, enabled: false }, { tainted: true }))).toMatch(/your session is tainted/);
  });

  it("an untainted session changes the owner's and it stays untainted; the owner's API changes a tainted one, never refused, and writing its text clears the taint", async () => {
    const p = await newProject();
    expect(toolOk(await board(p, "update_reviewer", { reviewer: CODE_REVIEW.id, name: "Code", enabled: false }))).toMatchObject({ name: "Code", enabled: false, source: "manager", tainted: false });
    expect(await taint(p, CODE_REVIEW.id)).toEqual(["manager", false]);
    expect(toolOk(await board(p, "delete_reviewer", { reviewer: CODE_REVIEW.id }))).toEqual({ deleted: CODE_REVIEW.id });
    const its = toolOk(await board(p, "create_reviewer", SECURITY, { tainted: true }));
    const patched = await api(token, "PATCH", path(p, `/${its.id}`), { enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ enabled: false, source: "owner", tainted: true });
    const saved = await api(token, "PATCH", path(p, `/${its.id}`), { name: SECURITY.name, instructions: SECURITY.instructions, dimensions: SECURITY.dimensions });
    expect(saved.body).toMatchObject({ source: "owner", tainted: false });
    // Now the owner's: a tainted session can't touch it, the owner's API still can.
    expect(toolError(await board(p, "delete_reviewer", { reviewer: its.id }, { tainted: true }))).toMatch(/your session is tainted/);
    expect((await api(token, "DELETE", path(p, `/${its.id}`))).status).toBe(200);
  });

  it("a reviewer a tainted manager added runs on the next PR head with its brief relayed, and its failing verdict fails the check", async () => {
    const p = await newProject();
    toolOk(await board(p, "create_reviewer", SECURITY, { tainted: true }));
    const s = await opened(p);
    const first = one(p, 1);
    expect(briefOf(first).from).toBeUndefined();
    toolOk(await submit(p, first, 1, s, submitArgs()));
    await run(p);
    const second = one(p, 1);
    expect(briefOf(second)).toMatchObject({ from: "projects/board", text: expect.stringContaining(SECURITY.instructions) });
    toolOk(await submit(p, second, 1, s, security("pass", "fail")));
    await run(p);
    expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "failure" });
    expect((await job(p, 1, s)).reviews.map((r: any) => r.reviewer.name)).toEqual(["Code review", "Security"]);
  });
});
