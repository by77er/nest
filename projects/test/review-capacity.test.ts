// A review nest won't start for capacity (README.md#built-the-review-pipeline): when nest refuses the
// reviewer because the app is at its grant's max_agents or max_sandboxes, the job waits, queued, and starts
// once there's room (as one over max_concurrent_reviews does), never `action_required` for it. A refusal for
// any other reason still fails the job, and the review gate's held jobs stay held. Against a fake nest that
// admits creates as nest's ClientDO does, in its words.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { atCapacity, NestError } from "../src/nest";
import { AccessTeam, agentClaims, api, callTool, CLIENT, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

describe("a capacity refusal, told apart", () => {
  it("is nest's 403 forbidden in ClientDO's words, for agents or sandboxes; nothing else is", () => {
    const err = (status: number, code: string, message: string, retryable = false) => new NestError(status, code, message, retryable);
    const cases: [string, unknown, boolean][] = [
      ["max_sandboxes", err(403, "forbidden", "cli_x has 20 live sandboxes, its grant's max_sandboxes"), true],
      ["max_agents", err(403, "forbidden", "cli_x has 4 live agents, its grant's max_agents"), true],
      ["another refusal of the grant", err(403, "forbidden", "outside cli_x's grant: cell local"), false],
      ["a deleted client", err(403, "forbidden", "the client was deleted"), false],
      ["the words under another code", err(403, "refused", "cli_x has 20 live sandboxes, its grant's max_sandboxes"), false],
      ["the words under another status", err(409, "forbidden", "cli_x has 20 live sandboxes, its grant's max_sandboxes"), false],
      ["not nest's", new Error("cli_x has 20 live sandboxes, its grant's max_sandboxes"), false],
    ];
    for (const [name, e, want] of cases) expect(atCapacity(e), name).toBe(want);
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
let clock = Date.parse("2026-11-12T00:00:00Z");
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
const reviewersOf = (p: P, pr: number) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer" && a.labels.pr === String(pr));
const live = (p: P, pr: number) => reviewersOf(p, pr).filter((a) => !a.ended);
const liveSandboxesOf = (p: P, pr: number) => [...fake.sandboxes.values()].filter((x) => !x.ended && x.labels.project === p.id && x.labels.role === "reviewer" && x.labels.pr === String(pr));
const push = (p: P, number: number, s: string, o: Record<string, unknown> = {}) => deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action: "opened", updated_at: later(), ...o }));
/** Every backed-off step due now, as if time went by. */
const dueNow = (p: P) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
  st.storage.sql.exec("UPDATE jobs SET next_ms = 0 WHERE next_ms IS NOT NULL");
});
const nextIn = async (p: P, pr: number, s: string) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) =>
  (st.storage.sql.exec("SELECT next_ms FROM jobs WHERE pr = ? AND sha = ?", pr, s).one().next_ms as number) - Date.now());
const liveAgents = () => [...fake.agents.values()].filter((a) => !a.ended && a.client === CLIENT).length;
const liveSandboxes = () => [...fake.sandboxes.values()].filter((x) => !x.ended).length;
const checkOf = (p: P, s: string) => gh.runsOf(p.repo, s)[0] as any;
const dim = { verdict: "pass", notes: "fine" };

describe("a review nest has no room for", () => {
  it("max_sandboxes: waits queued, its check in progress saying so, tried again and again (backed off), and starts once there's room", async () => {
    const p = await newProject();
    fake.maxSandboxes = liveSandboxes();
    try {
      const s = sha();
      await push(p, 1, s);
      await run(p);
      let j = await job(p, 1, s);
      expect(j).toMatchObject({ state: "queued", error: expect.stringMatching(/waiting for room in nest to start a reviewer: .*max_sandboxes/) });
      expect(live(p, 1)).toEqual([]);
      const check = checkOf(p, s);
      expect(check.status).toBe("in_progress");
      expect(check.output.title).toBe("Waiting for room to start a reviewer");
      expect(check.updates.filter((u: any) => u.status === "completed")).toEqual([]);
      // Refused again, twice: still waiting, never failed, each wait longer; its check isn't told again.
      const waits = [await nextIn(p, 1, s)];
      for (let k = 0; k < 2; k++) {
        await dueNow(p);
        await run(p);
        j = await job(p, 1, s);
        expect(j.state).toBe("queued");
        waits.push(await nextIn(p, 1, s));
      }
      // nest's backoff: 5 s, then 10 s, then 20 s (src/nest.ts `backoff`).
      expect(waits[0]!).toBeLessThanOrEqual(5_000);
      expect(waits[1]!).toBeGreaterThan(9_000);
      expect(waits[2]!).toBeGreaterThan(19_000);
      expect(checkOf(p, s).updates.filter((u: any) => u.output?.title === "Waiting for room to start a reviewer")).toHaveLength(1);
      // Room: it starts, and its check says it's reviewing again.
      fake.maxSandboxes = null;
      await dueNow(p);
      await run(p);
      j = await job(p, 1, s);
      expect(j).toMatchObject({ state: "running" });
      expect(live(p, 1)).toHaveLength(1);
      expect(checkOf(p, s).updates.at(-1)).toMatchObject({ status: "in_progress", output: { title: "Reviewing" } });
      // Its verdict completes the check once, as any review's.
      const reviewer = live(p, 1)[0]!;
      const id = await nest.sign(agentClaims("review", reviewer.agent, { project: p.id, role: "reviewer", pr: "1", sha: s, start: reviewer.labels.start! }));
      const r = await callTool("review", id, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
      expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
      await run(p);
      expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "success" });
      expect(checkOf(p, s).updates.filter((u: any) => u.status === "completed")).toHaveLength(1);
    } finally {
      fake.maxSandboxes = null;
    }
  });

  it("max_agents: the sandbox made for it goes, and it waits the same", async () => {
    const p = await newProject();
    fake.maxAgents = liveAgents();
    try {
      const s = sha();
      await push(p, 1, s);
      await run(p);
      expect(await job(p, 1, s)).toMatchObject({ state: "queued", error: expect.stringMatching(/max_agents/) });
      expect(liveSandboxesOf(p, 1)).toEqual([]);
      expect(checkOf(p, s).status).toBe("in_progress");
    } finally {
      fake.maxAgents = null;
    }
  });

  it("starts as soon as one of the project's reviewers ends, without waiting out its backoff", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1);
    await run(p);
    expect(live(p, 1)).toHaveLength(1);
    // Full now: the second review waits.
    fake.maxAgents = liveAgents();
    try {
      const s2 = sha();
      await push(p, 2, s2);
      await run(p);
      expect((await job(p, 2, s2)).state).toBe("queued");
      expect(await nextIn(p, 2, s2)).toBeGreaterThan(1_000);
      // The first one's verdict: its reviewer is stopped, which frees its place, and the second starts in that drain.
      const reviewer = live(p, 1)[0]!;
      const id = await nest.sign(agentClaims("review", reviewer.agent, { project: p.id, role: "reviewer", pr: "1", sha: s1, start: reviewer.labels.start! }));
      await callTool("review", id, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
      await run(p);
      expect((await job(p, 2, s2)).state).toBe("running");
      expect(live(p, 2)).toHaveLength(1);
    } finally {
      fake.maxAgents = null;
    }
  });

  it("a refusal for another reason still fails the job, its check action_required", async () => {
    const p = await newProject();
    fake.fail(/^POST \/v1\/agents$/, 403);
    const s = sha();
    await push(p, 1, s);
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "failed" });
    expect(checkOf(p, s)).toMatchObject({ status: "completed", conclusion: "action_required", output: { title: "The review couldn't run" } });
  });

  it("the review gate holds: an untrusted PR's job stays held while others wait for room and room frees", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1);
    await run(p);
    fake.maxAgents = liveAgents();
    try {
      const s2 = sha();
      await push(p, 2, s2);
      const s3 = sha();
      await push(p, 3, s3, { user: { id: 999_001, login: "stranger", type: "User" }, headRepo: "stranger/fork" });
      await run(p);
      expect((await job(p, 2, s2)).state).toBe("queued");
      expect((await job(p, 3, s3)).state).toBe("held");
      fake.maxAgents = null;
      const reviewer = live(p, 1)[0]!;
      const id = await nest.sign(agentClaims("review", reviewer.agent, { project: p.id, role: "reviewer", pr: "1", sha: s1, start: reviewer.labels.start! }));
      await callTool("review", id, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
      await run(p);
      await dueNow(p);
      await run(p);
      expect((await job(p, 2, s2)).state).toBe("running");
      expect((await job(p, 3, s3)).state).toBe("held");
      expect(reviewersOf(p, 3)).toEqual([]);
    } finally {
      fake.maxAgents = null;
    }
  });
});
