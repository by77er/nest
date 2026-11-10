// ReviewDO's queues on the outbox machine (README.md#outboxes): a check run's update, a reviewer's stop, a
// finished review's word to the project and a held job's check each back off through `outboxStep`, give up
// by their queue's policy, and say so on the job.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { OUTBOX } from "../src/outbox";
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
beforeEach(() => {
  fake.failures = [];
  gh.failures = [];
});

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
let clock = Date.now();
const later = () => new Date((clock += 1000)).toISOString();
interface P { id: string; repo: string; owner: string }

async function newProject(): Promise<P> {
  const owner = `o-${rand()}`;
  const repo = `${owner}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo, owner };
}
const reviews = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const run = (p: P) => reviews(p).drain();
const job = async (p: P, pr: number, s: string) => ((await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[]).find((j) => j.pr === pr && j.sha === s);
const sql = <T>(p: P, q: string, ...args: unknown[]) => runInDurableObject(reviews(p), (_o, st) => st.storage.sql.exec(q, ...args).toArray() as T[]);
const push = (p: P, number: number, s: string, o: Record<string, unknown> = {}) => deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action: "opened", updated_at: later(), ...o }));

/** A PR whose review is running: its check in progress, its reviewer briefed. */
async function opened(p: P, number = 1) {
  const s = sha();
  await push(p, number, s);
  await run(p);
  const reviewer = [...fake.agents.values()].find((a) => a.labels.project === p.id && a.labels.role === "reviewer" && a.labels.sha === s)!;
  expect(reviewer).toBeDefined();
  return { sha: s, reviewer: reviewer.agent };
}
const dim = { verdict: "pass", notes: "fine" };
/** The reviewer's verdict: the job ends, owing its check's completion, its reviewer's stop and its word to the project. */
async function submitted(p: P, o: { sha: string; reviewer: string }, pr = 1) {
  const t = await nest.sign(agentClaims("review", o.reviewer, { project: p.id, role: "reviewer", pr: String(pr), sha: o.sha, start: "1" }));
  const r = await callTool("review", t, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
}
const patches = (p: P) => gh.callsTo("PATCH", new RegExp(`^/repos/${p.repo}/check-runs/`, "i")).length;
const stops = (agent: string) => fake.callsTo("POST", new RegExp(`^/v1/agents/${agent}/stop$`)).length;

describe("a check run's update", () => {
  it("that GitHub can't take is backed off, not tried at every drain, and sent once it can", async () => {
    const p = await newProject();
    const o = await opened(p);
    gh.fail(/^PATCH \/repos\/.*\/check-runs\//, 502, { times: 1000 });
    await submitted(p, o);
    await run(p);
    const tried = patches(p);
    expect(tried).toBeGreaterThan(0);
    const [row] = await sql<{ next_ms: number; attempts: number; error: string }>(p, "SELECT next_ms, attempts, error FROM check_updates");
    expect(row).toMatchObject({ attempts: 1, error: expect.stringContaining("502") });
    expect(row!.next_ms).toBeGreaterThan(Date.now());
    await run(p);
    await run(p);
    expect(patches(p)).toBe(tried);
    gh.failures = [];
    await sql(p, "UPDATE check_updates SET next_ms = 0");
    await run(p);
    expect(await sql(p, "SELECT 1 FROM check_updates")).toEqual([]);
    expect(gh.runsOf(p.repo, o.sha)[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect((await job(p, 1, o.sha)).error ?? null).toBeNull();
  });

  it("is given up after its attempts run out, or at once when GitHub refuses it, and the job says which", async () => {
    const p = await newProject();
    const a = await opened(p, 1);
    gh.fail(/^PATCH \/repos\/.*\/check-runs\//, 502, { times: 1000 });
    await submitted(p, a, 1);
    await run(p);
    await sql(p, "UPDATE check_updates SET next_ms = 0, attempts = ?", OUTBOX.review_checks.maxAttempts! - 2);
    await run(p);
    // One short of the limit: still owed.
    expect(await sql(p, "SELECT attempts FROM check_updates")).toEqual([{ attempts: OUTBOX.review_checks.maxAttempts! - 1 }]);
    await sql(p, "UPDATE check_updates SET next_ms = 0");
    await run(p);
    expect(await sql(p, "SELECT 1 FROM check_updates")).toEqual([]);
    expect((await job(p, 1, a.sha)).error).toMatch(new RegExp(`couldn't be sent, after ${OUTBOX.review_checks.maxAttempts} tries: .*502`));

    gh.failures = [];
    const b = await opened(p, 2);
    gh.fail(/^PATCH \/repos\/.*\/check-runs\//, 422, { times: 1000 });
    const before = patches(p);
    await submitted(p, b, 2);
    await run(p);
    await run(p);
    expect(patches(p)).toBe(before + 1);
    expect(await sql(p, "SELECT 1 FROM check_updates")).toEqual([]);
    expect((await job(p, 2, b.sha)).error).toMatch(/was refused: .*422/);
  });
});

describe("a reviewer's stop", () => {
  it("that nest can't take is retried with backoff until it goes", async () => {
    const p = await newProject();
    const o = await opened(p);
    fake.fail(new RegExp(`^POST /v1/agents/${o.reviewer}/stop$`), 503, { retryable: true, times: 1000 });
    await submitted(p, o);
    await run(p);
    const tried = stops(o.reviewer);
    expect(tried).toBeGreaterThan(0);
    const [row] = await sql<{ next_ms: number; attempts: number; failed_ms: number | null }>(p, "SELECT next_ms, attempts, failed_ms FROM stops WHERE agent = ?", o.reviewer);
    expect(row).toMatchObject({ attempts: 1, failed_ms: null });
    expect(row!.next_ms).toBeGreaterThan(Date.now());
    await run(p);
    expect(stops(o.reviewer)).toBe(tried);
    // However often it has failed, it's still owed: a stop must go.
    await sql(p, "UPDATE stops SET next_ms = 0, attempts = 500");
    await run(p);
    expect(await sql(p, "SELECT attempts, failed_ms FROM stops")).toEqual([{ attempts: 501, failed_ms: null }]);
    fake.failures = [];
    await sql(p, "UPDATE stops SET next_ms = 0");
    await run(p);
    expect(await sql(p, "SELECT 1 FROM stops")).toEqual([]);
    expect(fake.agents.get(o.reviewer)!.ended).toBe(true);
  });

  it("that nest refuses is kept and said on the job, not tried again or waited on; nest's word that the agent ended clears it", async () => {
    const p = await newProject();
    const o = await opened(p);
    fake.fail(new RegExp(`^POST /v1/agents/${o.reviewer}/stop$`), 409, { times: 1000 });
    await submitted(p, o);
    await run(p);
    const tried = stops(o.reviewer);
    expect(tried).toBe(1);
    const [row] = await sql<{ failed_ms: number | null; attempts: number; error: string }>(p, "SELECT failed_ms, attempts, error FROM stops WHERE agent = ?", o.reviewer);
    expect(row!.failed_ms).not.toBeNull();
    expect(row).toMatchObject({ attempts: 1, error: expect.stringContaining("409") });
    expect((await job(p, 1, o.sha)).error).toMatch(new RegExp(`nest refused to stop its reviewer ${o.reviewer}`));
    // Nothing of it is due: more drains don't try it, and the alarm isn't set for it.
    await runInDurableObject(reviews(p), (_o, st) => st.storage.deleteAlarm());
    await run(p);
    await run(p);
    expect(stops(o.reviewer)).toBe(tried);
    expect(await runInDurableObject(reviews(p), (_o, st) => st.storage.getAlarm())).toBeNull();
    await deliver({ id: `evt-${rand()}`, type: "agent.exited", agent: o.reviewer, reason: "exited" });
    expect(await sql(p, "SELECT 1 FROM stops")).toEqual([]);
  });

  it("of an agent nest no longer has is done", async () => {
    const p = await newProject();
    const o = await opened(p);
    fake.fail(new RegExp(`^POST /v1/agents/${o.reviewer}/stop$`), 404, { times: 1000 });
    await submitted(p, o);
    await run(p);
    expect(await sql(p, "SELECT 1 FROM stops")).toEqual([]);
  });
});

describe("a finished review's word to the project", () => {
  /** ProjectDO can't take the call (its waits are unreadable) until `restore` runs. */
  async function breakProject(p: P) {
    const stub = env.PROJECT.get(env.PROJECT.idFromName(p.id));
    await runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("ALTER TABLE waits RENAME TO waits_hidden"); });
    return () => runInDurableObject(stub, (_o, st) => { st.storage.sql.exec("ALTER TABLE waits_hidden RENAME TO waits"); });
  }

  it("is retried with backoff, counted, until the project takes it", async () => {
    const p = await newProject();
    const o = await opened(p);
    const restoreProject = await breakProject(p);
    await submitted(p, o);
    await run(p);
    const [row] = await sql<{ next_ms: number; attempts: number; error: string | null }>(p, "SELECT next_ms, attempts, error FROM ended");
    expect(row!.attempts).toBe(1);
    expect(row!.error).not.toBeNull();
    expect(row!.next_ms).toBeGreaterThan(Date.now());
    await run(p);
    expect(await sql(p, "SELECT attempts FROM ended")).toEqual([{ attempts: 1 }]);
    await restoreProject();
    await sql(p, "UPDATE ended SET next_ms = 0");
    await run(p);
    expect(await sql(p, "SELECT 1 FROM ended")).toEqual([]);
    expect((await job(p, 1, o.sha)).error ?? null).toBeNull();
  });

  it("is given up after its attempts run out, and the job says so", async () => {
    const p = await newProject();
    const o = await opened(p);
    const restoreProject = await breakProject(p);
    try {
      await submitted(p, o);
      await run(p);
      await sql(p, "UPDATE ended SET next_ms = 0, attempts = ?", OUTBOX.review_ended.maxAttempts! - 2);
      await run(p);
      expect(await sql(p, "SELECT attempts FROM ended")).toEqual([{ attempts: OUTBOX.review_ended.maxAttempts! - 1 }]);
      await sql(p, "UPDATE ended SET next_ms = 0");
      await run(p);
      expect(await sql(p, "SELECT 1 FROM ended")).toEqual([]);
      const j = await job(p, 1, o.sha);
      expect(j.state).toBe("done");
      expect(j.error).toMatch(new RegExp(`wasn't told this review ended, after ${OUTBOX.review_ended.maxAttempts} tries`));
    } finally {
      await restoreProject();
    }
  });
});

describe("a held job's check", () => {
  it("that GitHub can't take is retried with backoff, then given up after its attempts; the job still waits for the owner", async () => {
    const p = await newProject();
    const s = sha();
    gh.fail(/^POST \/repos\/.*\/check-runs$/, 502, { times: 1000 });
    await push(p, 7, s, { headRepo: "mallory/fork", user: { id: 987_654, login: "mallory", type: "User" } });
    await run(p);
    const row = async () => (await sql<{ state: string; next_ms: number | null; errors: number; error: string | null }>(p, "SELECT state, next_ms, errors, error FROM jobs WHERE pr = 7"))[0]!;
    expect(await row()).toMatchObject({ state: "held", errors: 1, error: expect.stringContaining("502") });
    expect((await row()).next_ms).toBeGreaterThan(Date.now());
    await sql(p, "UPDATE jobs SET next_ms = 0, errors = ? WHERE pr = 7", OUTBOX.review_held.maxAttempts! - 2);
    await sql(p, "UPDATE prs SET held_check_ms = NULL");
    await run(p);
    expect((await row()).next_ms).not.toBeNull();
    await sql(p, "UPDATE jobs SET next_ms = 0 WHERE pr = 7");
    await sql(p, "UPDATE prs SET held_check_ms = NULL");
    await run(p);
    expect(await row()).toMatchObject({ state: "held", next_ms: null, errors: OUTBOX.review_held.maxAttempts, error: expect.stringContaining("502") });
    const attention = ((await api(token, "GET", `/api/projects/${p.id}/attention`)).body as any[]).filter((x) => x.kind === "review");
    expect(attention).toEqual([expect.objectContaining({ pr: 7, sha: s })]);
  });
});
