// A review job's state machine (src/review-job.ts) and its invariants in ReviewDO: a running job always has
// a timed way out (the state-machine sweep's B1: a reviewer that neither submits nor exits held its job,
// its required check, a review slot, its agent and its sandbox for good); each run's check completes
// exactly once; at most one live reviewer per job. Also the sandbox a refused agent create leaves (B5).
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { MAX_RETRIES } from "../src/do/review";
import { JOB_EVENTS, JOB_STATES, type JobEvent, type JobState, jobTransition, REVIEW_DEADLINE_MS } from "../src/review-job";
import { catalogFor, NAMESPACE } from "../src/catalog";
import { AccessTeam, agentClaims, api, callTool, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

describe("the job table (pure)", () => {
  // The oracle: what the README's review pipeline says, written out here, not read from the code.
  const want: Record<JobState, Partial<Record<JobEvent, JobState>>> = {
    queued: { start: "running", superseded: "superseded", closed: "closed" },
    running: { verdict: "done", retry: "running", give_up: "failed", refused: "failed", superseded: "superseded", closed: "closed" },
    done: { requeue: "queued" },
    failed: { requeue: "queued" },
    superseded: { requeue: "queued" },
    closed: { requeue: "queued" },
  };
  it("every state and event, swept", () => {
    for (const s of JOB_STATES) {
      for (const e of JOB_EVENTS) {
        const t = jobTransition(s, e);
        expect(t.ok ? t.to : null, `${s} --${e}-->`).toBe(want[s][e] ?? null);
      }
    }
  });

  it("the reviewer ends itself once its turn is done (ephemeral)", () => {
    const t = catalogFor("https://projects.test", ["acme/app"]).templates[`${NAMESPACE}/reviewer`] as { ephemeral?: boolean };
    expect(t.ephemeral).toBe(true);
  });
});

// --- Through the app ------------------------------------------------------------------------------------

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
let clock = Date.parse("2026-11-07T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

interface P { id: string; repo: string }
async function newProject(o: Record<string, unknown> = {}): Promise<P> {
  const repo = `o-${rand()}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo };
}
const reviews = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const run = (p: P) => reviews(p).drain();
const job = async (p: P, pr: number, s: string) => ((await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[]).find((j) => j.pr === pr && j.sha === s);
const reviewersOf = (p: P, pr: number, s: string) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer" && a.labels.pr === String(pr) && a.labels.sha === s);
const liveReviewers = (p: P, pr: number, s: string) => reviewersOf(p, pr, s).filter((a) => !a.ended);
const push = (p: P, number: number, s: string, action = "opened") => deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action, updated_at: later() }));
/** Every running job's deadline passed, and its backed-off next step due: as if time went by. */
const timePasses = (p: P) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
  st.storage.sql.exec("UPDATE jobs SET deadline_ms = 0 WHERE state = 'running'");
});
const dueNow = (p: P) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
  st.storage.sql.exec("UPDATE jobs SET next_ms = 0 WHERE next_ms IS NOT NULL");
});
/** The check's completions GitHub got, per check run of the PR's head. */
const completions = (p: P, s: string) => gh.runsOf(p.repo, s).map((c: any) => c.updates.filter((u: any) => u.status === "completed").length);

describe("a running job always has a timed way out (B1)", () => {
  it("a reviewer that neither submits nor exits: its run times out, it's stopped, another starts; after the retries the job fails, its check action_required with the reason, the slot freed", async () => {
    const p = await newProject({ max_concurrent_reviews: 1 });
    const s = sha();
    await push(p, 1, s);
    await run(p);
    const j0 = await job(p, 1, s);
    expect(j0.state).toBe("running");
    expect(j0.deadline_ms).toBeGreaterThan(Date.now() + REVIEW_DEADLINE_MS - 60_000);
    // A second PR waits for the one slot.
    const s2 = sha();
    await push(p, 2, s2);
    await run(p);
    expect((await job(p, 2, s2)).state).toBe("queued");
    for (let k = 0; k <= MAX_RETRIES; k++) {
      expect(liveReviewers(p, 1, s)).toHaveLength(1);
      await timePasses(p);
      await run(p);
      await dueNow(p);
      await run(p);
    }
    const j = await job(p, 1, s);
    expect(j).toMatchObject({ state: "failed", attempts: MAX_RETRIES + 1, error: expect.stringMatching(/no verdict within 60 minutes/) });
    expect(reviewersOf(p, 1, s)).toHaveLength(MAX_RETRIES + 1);
    expect(liveReviewers(p, 1, s)).toEqual([]);
    const [check] = gh.runsOf(p.repo, s) as any[];
    expect(check).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(check.output.summary).toMatch(/no verdict within 60 minutes/);
    expect(completions(p, s)).toEqual([1]);
    // The slot is free: the queued PR's review starts.
    await run(p);
    expect((await job(p, 2, s2)).state).toBe("running");
  });

  it("a running job from before deadlines gets one at the next drain", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET deadline_ms = NULL");
    });
    await run(p);
    expect((await job(p, 1, s)).deadline_ms).toBeGreaterThan(Date.now());
  });
});

describe("each run's check completes exactly once", () => {
  it("a verdict, then the reviewer's late exit and a passed deadline: one completion, success", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    const [reviewer] = liveReviewers(p, 1, s);
    const tok = await nest.sign(agentClaims("review", reviewer!.agent, { project: p.id, role: "reviewer", pr: "1", sha: s, start: "1" }));
    const dim = { verdict: "pass", notes: "n" };
    const r = await callTool("review", tok, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
    expect(r.result?.isError).toBeFalsy();
    await reviews(p).onAgentExited(reviewer!.agent, "done");
    await timePasses(p);
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "done", attempts: 0 });
    expect(completions(p, s)).toEqual([1]);
    expect((gh.runsOf(p.repo, s)[0] as any).conclusion).toBe("success");
  });

  it("a timed-out reviewer's late exit spends no second attempt; one reviewer stopped, one started, never two live", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    const [reviewer] = liveReviewers(p, 1, s);
    await timePasses(p);
    await run(p);
    expect((await job(p, 1, s)).attempts).toBe(1);
    // The stopped reviewer's exit comes after: it's no longer the job's.
    await reviews(p).onAgentExited(reviewer!.agent, "stopped");
    expect((await job(p, 1, s)).attempts).toBe(1);
    await dueNow(p);
    await run(p);
    expect(reviewersOf(p, 1, s)).toHaveLength(2);
    expect(liveReviewers(p, 1, s)).toHaveLength(1);
    expect(completions(p, s)).toEqual([0]);
  });
});

describe("every change of state goes through the table, once", () => {
  it("a move the table refuses writes nothing; ending an ended job owes no second completion", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    await runInDurableObject(reviews(p), (inst: any, st: DurableObjectState) => {
      const row = () => st.storage.sql.exec("SELECT * FROM jobs WHERE pr = 1").one();
      const stale = row();
      inst.end(stale, "closed", "cancelled", { title: "PR closed", summary: "s" });
      // The same (stale) row ended again, as an interleaved step holding it would: nothing more is owed.
      inst.end(stale, "superseded", "cancelled", { title: "Superseded", summary: "s" });
      expect(row().state).toBe("closed");
      expect(st.storage.sql.exec("SELECT COUNT(*) AS n FROM check_updates").one().n).toBe(1);
      expect(JSON.parse(st.storage.sql.exec("SELECT body FROM check_updates").one().body as string).output.title).toBe("PR closed");
      // A move the table has no arrow for: refused, nothing written.
      expect(inst.move(1, s, "closed", "verdict")).toBeNull();
      expect(inst.move(1, s, "closed", "start")).toBeNull();
      expect(row().state).toBe("closed");
    });
    await run(p);
    expect(completions(p, s)).toEqual([1]);
  });
});

describe("a refused agent create leaves no sandbox (B5)", () => {
  it("a worker, a reviewer and a routine run whose agent nest refuses for good: their sandboxes are destroyed", async () => {
    const p = await newProject();
    const sandboxesOf = (f: (l: Record<string, string>) => boolean) => [...fake.sandboxes.values()].filter((sb) => sb.labels.project === p.id && f(sb.labels));
    // A worker.
    const t = (await api(token, "POST", `/api/projects/${p.id}/tasks`, { title: "t" })).body;
    await api(token, "PUT", `/api/projects/${p.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
    fake.fail(/^POST \/v1\/agents$/, 403);
    const a = (await api(token, "POST", `/api/projects/${p.id}/tasks/${t.id}/assign`)).body;
    expect(a.state).toBe("stalled");
    const workerBoxes = sandboxesOf((l) => l.task === t.id);
    expect(workerBoxes).toHaveLength(1);
    expect(workerBoxes.filter((sb) => !sb.ended)).toEqual([]);
    // A reviewer.
    const s = sha();
    fake.fail(/^POST \/v1\/agents$/, 403);
    await push(p, 7, s);
    await run(p);
    expect((await job(p, 7, s)).state).toBe("failed");
    const reviewBoxes = sandboxesOf((l) => l.role === "reviewer" && l.sha === s);
    expect(reviewBoxes).toHaveLength(1);
    expect(reviewBoxes.filter((sb) => !sb.ended)).toEqual([]);
    // A routine run.
    const r = (await api(token, "POST", `/api/projects/${p.id}/routines`, {
      name: "R", kind: "review", prompt: "p", enabled: true, triggers: { timer: null, tasks_done: null, prs_merged: null },
      cooldown_min: 0, max_minutes: 30, max_turns: 3, proposals: "triage",
    })).body;
    fake.fail(/^POST \/v1\/agents$/, 403);
    await api(token, "POST", `/api/projects/${p.id}/routines/${r.id}/run`);
    const runBoxes = sandboxesOf((l) => l.routine === r.id);
    expect(runBoxes).toHaveLength(1);
    expect(runBoxes.filter((sb) => !sb.ended)).toEqual([]);
  });
});
