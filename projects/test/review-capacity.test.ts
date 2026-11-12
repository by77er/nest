// A review nest won't start for capacity (README.md#built-the-review-pipeline): when nest refuses the
// reviewer because the app is at its grant's max_agents or max_sandboxes, the job waits, queued, and starts
// once there's room (as one over max_concurrent_reviews does), never `action_required` for it. A refusal for
// any other reason still fails the job, and the review gate's held jobs stay held. Against a fake nest that
// admits creates as nest's ClientDO does, in its words.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { atCapacity, NestError } from "../src/nest";
import { ROOM_TELL_AFTER_MS } from "../src/do/review";
import { AccessTeam, agentClaims, api, callTool, CLIENT, deliverGithub, FakeNest, installFetch, prEvent, Signer } from "./fake-nest";

describe("a capacity refusal, told apart", () => {
  it("is nest's 403 forbidden in ClientDO's words, for agents or sandboxes; nothing else is", () => {
    const err = (status: number, code: string, message: string, retryable = false) => new NestError(status, code, message, retryable);
    const cases: [string, unknown, boolean][] = [
      // nest from nest#248 on: its own code, whatever the words.
      ["at_capacity (nest#248)", err(429, "at_capacity", "max_sandboxes: cli_x has 20 live sandboxes", true), true],
      ["at_capacity, a spawner's children", err(429, "at_capacity", "max_live_children: 8 live", true), true],
      ["another 429", err(429, "rate_limited", "cli_x has 20 live sandboxes, its grant's max_sandboxes", true), false],
      // A nest from before it: ClientDO's words under 403 forbidden.
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

  it("a reviewer's exit (agent.exited) wakes the waiting job", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1);
    await run(p);
    fake.maxAgents = liveAgents();
    try {
      const s2 = sha();
      await push(p, 2, s2);
      await run(p);
      expect((await job(p, 2, s2)).state).toBe("queued");
      expect(await nextIn(p, 2, s2)).toBeGreaterThan(1_000);
      const reviewer = live(p, 1)[0]!;
      reviewer.ended = true;
      await reviews(p).onAgentExited(reviewer.agent, "exited");
      expect(await nextIn(p, 2, s2)).toBeLessThanOrEqual(0);
    } finally {
      fake.maxAgents = null;
    }
  });

  it("one place frees: only the oldest waiting job tries, so one sandbox is made for it, not one per waiting job", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1);
    await run(p);
    fake.maxAgents = liveAgents();
    try {
      const shas = [sha(), sha(), sha()];
      for (const [k, s] of shas.entries()) await push(p, 10 + k, s);
      await run(p);
      for (const [k, s] of shas.entries()) expect((await job(p, 10 + k, s)).state).toBe("queued");
      const made = () => [...fake.sandboxes.values()].filter((x) => x.labels.project === p.id && x.labels.role === "reviewer").length;
      const before = made();
      // The first review's verdict stops its reviewer: one place. A worker takes it at once (still full).
      const reviewer = live(p, 1)[0]!;
      const id = await nest.sign(agentClaims("review", reviewer.agent, { project: p.id, role: "reviewer", pr: "1", sha: s1, start: reviewer.labels.start! }));
      await callTool("review", id, "submit_review", { correctness: dim, quality: dim, architecture: dim, summary: "ok" });
      fake.maxAgents = liveAgents();
      await run(p);
      expect(made() - before).toBe(1);
      // The oldest it was; the others still wait out their backoff.
      expect(await nextIn(p, 11, shas[1]!)).toBeGreaterThan(1_000);
      expect(await nextIn(p, 12, shas[2]!)).toBeGreaterThan(1_000);
    } finally {
      fake.maxAgents = null;
    }
  });

  it("a long wait is among the project's errors, once, saying what the owner can do; cleared when the review starts", async () => {
    const p = await newProject();
    fake.maxSandboxes = liveSandboxes();
    const errors = async () => ((await api(token, "GET", `/api/projects/${p.id}/errors`)).body as any[]).filter((e) => e.code === "review_waiting_for_room");
    const waitedFor = (ms: number) => runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET capacity_ms = ?, next_ms = 0 WHERE capacity_ms IS NOT NULL", Date.now() - ms);
    });
    try {
      const s = sha();
      await push(p, 1, s);
      await run(p);
      // Not yet.
      await waitedFor(ROOM_TELL_AFTER_MS - 60_000);
      await run(p);
      expect(await errors()).toEqual([]);
      await waitedFor(ROOM_TELL_AFTER_MS + 60_000);
      await run(p);
      const [e] = await errors();
      expect(e.message).toMatch(/PR #1 .* has waited 4[0-9] minutes for room in nest/);
      expect(e.message).toMatch(/max_sandboxes/);
      expect(e.message).toMatch(/Raise the grant's max_agents or max_sandboxes, or free a place/);
      // Told once, however long it goes on.
      await waitedFor(ROOM_TELL_AFTER_MS + 120_000);
      await run(p);
      expect(await errors()).toHaveLength(1);
      // Room: it starts, and the error goes.
      fake.maxSandboxes = null;
      await dueNow(p);
      await run(p);
      expect((await job(p, 1, s)).state).toBe("running");
      expect(await errors()).toEqual([]);
    } finally {
      fake.maxSandboxes = null;
    }
  });

  it("a long wait's error goes when the job ends otherwise (a newer head), and the newer head's wait is its own", async () => {
    const p = await newProject();
    fake.maxSandboxes = liveSandboxes();
    const errors = async () => ((await api(token, "GET", `/api/projects/${p.id}/errors`)).body as any[]).filter((e) => e.code === "review_waiting_for_room");
    try {
      const s1 = sha();
      await push(p, 1, s1);
      await run(p);
      await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
        st.storage.sql.exec("UPDATE jobs SET capacity_ms = ?, next_ms = 0 WHERE capacity_ms IS NOT NULL", Date.now() - ROOM_TELL_AFTER_MS - 60_000);
      });
      await run(p);
      expect(await errors()).toHaveLength(1);
      const s2 = sha();
      await push(p, 1, s2, { action: "synchronize" });
      await run(p);
      expect((await job(p, 1, s1)).state).toBe("superseded");
      expect((await job(p, 1, s2)).state).toBe("queued");
      expect(await errors()).toEqual([]);
    } finally {
      fake.maxSandboxes = null;
    }
  });

  it("a job that never waited isn't told 'Reviewing' again: its check has its create's output, then its completion", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    expect(live(p, 1)).toHaveLength(1);
    expect(checkOf(p, s).updates).toEqual([]);
  });

  it("the wait's tries count apart: once started, the job's own step backs off from scratch", async () => {
    const p = await newProject();
    fake.maxSandboxes = liveSandboxes();
    try {
      const s = sha();
      await push(p, 1, s);
      await run(p);
      for (let k = 0; k < 4; k++) {
        await dueNow(p);
        await run(p);
      }
      fake.maxSandboxes = null;
      // Room, but the brief fails once: its retry is the first (5 s), not the sixth.
      fake.fail(new RegExp(`^POST /v1/agents/agt_[A-Za-z0-9]+/inbox$`), 503, { retryable: true, times: 3 });
      await dueNow(p);
      await run(p);
      const j = await job(p, 1, s);
      expect(j.state).toBe("running");
      expect(await nextIn(p, 1, s)).toBeLessThanOrEqual(5_000);
    } finally {
      fake.maxSandboxes = null;
    }
  });

  it("a second wait of the same job (its reviewer exited, no room again) is its own: the check told again, the long-wait clock from it", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s);
    await run(p);
    const first = live(p, 1)[0]!;
    const waitingTold = () => checkOf(p, s).updates.filter((u: any) => u.output?.title === "Waiting for room to start a reviewer").length;
    expect(waitingTold()).toBe(0);
    // Full now; its reviewer exits without a verdict: the retry finds no room.
    fake.maxSandboxes = liveSandboxes();
    try {
      first.ended = true;
      await reviews(p).onAgentExited(first.agent, "exited");
      await dueNow(p);
      await run(p);
      expect((await job(p, 1, s)).state).toBe("queued");
      expect(waitingTold()).toBe(1);
      const since = await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT capacity_ms FROM jobs WHERE pr = 1").one().capacity_ms as number);
      // Room, it starts; full again, its reviewer exits again: a second wait, told again, timed from now.
      fake.maxSandboxes = null;
      await dueNow(p);
      await run(p);
      const second = live(p, 1)[0]!;
      fake.maxSandboxes = liveSandboxes();
      second.ended = true;
      await reviews(p).onAgentExited(second.agent, "exited");
      await dueNow(p);
      await run(p);
      expect((await job(p, 1, s)).state).toBe("queued");
      expect(waitingTold()).toBe(2);
      const again = await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => st.storage.sql.exec("SELECT capacity_ms FROM jobs WHERE pr = 1").one().capacity_ms as number);
      expect(again).toBeGreaterThan(since);
      // Its tries count afresh: the first wait's don't carry over (5 s, not 10 s or more).
      expect(await nextIn(p, 1, s)).toBeLessThanOrEqual(5_000);
    } finally {
      fake.maxSandboxes = null;
    }
  });

  it("superseded while waiting, then the head back: requeued from scratch, its new check told it waits", async () => {
    const p = await newProject();
    fake.maxSandboxes = liveSandboxes();
    try {
      const s1 = sha();
      await push(p, 1, s1);
      await run(p);
      expect((await job(p, 1, s1)).state).toBe("queued");
      const s2 = sha();
      await push(p, 1, s2, { action: "synchronize" });
      await run(p);
      expect((await job(p, 1, s1)).state).toBe("superseded");
      expect(checkOf(p, s1)).toMatchObject({ status: "completed", conclusion: "cancelled" });
      expect(checkOf(p, s1).updates.filter((u: any) => u.status === "completed")).toHaveLength(1);
      await push(p, 1, s1, { action: "synchronize" });
      await run(p);
      expect((await job(p, 1, s1)).state).toBe("queued");
      const runs = gh.runsOf(p.repo, s1) as any[];
      expect(runs).toHaveLength(2);
      expect(runs.at(-1).updates.at(-1)?.output?.title).toBe("Waiting for room to start a reviewer");
    } finally {
      fake.maxSandboxes = null;
    }
  });

  describe("the project's word on a long wait, when the project can't be reached", () => {
    const errorsOf = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/errors`)).body as any[]).filter((e) => e.code === "review_waiting_for_room");
    /** A job waiting for room past ROOM_TELL_AFTER_MS, its own next try `nextMs` from now. */
    async function longWait(nextMs: number) {
      const p = await newProject();
      fake.maxSandboxes = liveSandboxes();
      const s = sha();
      await push(p, 1, s);
      await run(p);
      expect((await job(p, 1, s)).state).toBe("queued");
      await runInDurableObject(reviews(p), (_o: unknown, st: DurableObjectState) => {
        st.storage.sql.exec("UPDATE jobs SET capacity_ms = ?, next_ms = ? WHERE pr = 1", Date.now() - ROOM_TELL_AFTER_MS - 60_000, Date.now() + nextMs);
      });
      return { p, s };
    }
    const unreachable = async () => { throw new Error("the project's object is unreachable"); };
    const within = <T>(p: P, f: (o: any, st: DurableObjectState) => Promise<T>) => runInDurableObject(reviews(p), f as any) as Promise<T>;
    const roomRow = (p: P, s?: string) => within(p, async (_o, st) => st.storage.sql.exec("SELECT room_told_ms, room_ok, room_next_ms, room_attempts, state FROM jobs WHERE pr = 1 AND (? IS NULL OR sha = ?) ORDER BY created_ms LIMIT 1", s ?? null, s ?? null).one());

    it("is due at once, past the job's own backoff (the alarm's term)", async () => {
      const { p } = await longWait(10 * 60_000);
      try {
        // In one step (no alarm can run between): nothing armed, the long wait as it is, then arm.
        const alarm = await within(p, async (o, st) => {
          await st.storage.deleteAlarm();
          st.storage.sql.exec("UPDATE jobs SET capacity_ms = ?, next_ms = ?, room_ok = 0, room_next_ms = NULL WHERE pr = 1", Date.now() - ROOM_TELL_AFTER_MS - 60_000, Date.now() + 10 * 60_000);
          await o.arm();
          return st.storage.getAlarm();
        });
        expect(alarm).not.toBeNull();
        expect(alarm! - Date.now()).toBeLessThan(2_000);
      } finally {
        fake.maxSandboxes = null;
      }
    });

    it("a tell that fails backs off (no alarm due at once), and is tried again", async () => {
      const { p } = await longWait(60_000);
      try {
        await within(p, async (o) => { o.tellRoom = unreachable; await o.drain(); });
        let r = await roomRow(p);
        expect(r.room_attempts).toBe(1);
        expect((r.room_next_ms as number) - Date.now()).toBeGreaterThan(4_000);
        expect(await errorsOf(p)).toEqual([]);
        const alarm = await within(p, async (_o, st) => st.storage.getAlarm());
        expect(alarm! - Date.now()).toBeGreaterThan(4_000);
        // Fails again: backed off further.
        await within(p, async (o, st) => { st.storage.sql.exec("UPDATE jobs SET room_next_ms = 0"); await o.drain(); });
        r = await roomRow(p);
        expect(r.room_attempts).toBe(2);
        expect((r.room_next_ms as number) - Date.now()).toBeGreaterThan(9_000);
        // Reachable again: told.
        await within(p, async (o, st) => { delete o.tellRoom; st.storage.sql.exec("UPDATE jobs SET room_next_ms = 0"); await o.drain(); });
        expect(await errorsOf(p)).toHaveLength(1);
        expect((await roomRow(p)).room_attempts).toBe(0);
      } finally {
        fake.maxSandboxes = null;
      }
    });

    it("a tell whose answer was lost is still cleared when the wait ends", async () => {
      const { p, s } = await longWait(60_000);
      try {
        await within(p, async (o) => {
          const real = o.tellRoom.bind(o);
          o.tellRoom = async (...a: unknown[]) => { await real(...a); throw new Error("the answer was lost"); };
          await o.drain();
          delete o.tellRoom;
        });
        expect(await errorsOf(p)).toHaveLength(1);
        fake.maxSandboxes = null;
        await dueNow(p);
        // (Its clear waits out the failed tell's backoff, as time passing would.)
        await within(p, async (_o, st) => { st.storage.sql.exec("UPDATE jobs SET room_next_ms = 0 WHERE room_next_ms IS NOT NULL"); });
        await run(p);
        expect((await job(p, 1, s)).state).toBe("running");
        expect(await errorsOf(p)).toEqual([]);
      } finally {
        fake.maxSandboxes = null;
      }
    });

    it("told once: the project isn't asked again while the wait goes on", async () => {
      const { p } = await longWait(60_000);
      try {
        await run(p);
        expect(await errorsOf(p)).toHaveLength(1);
        // Gone from the project (say, pruned): a later drain doesn't put it back.
        await runInDurableObject(env.PROJECT.get(env.PROJECT.idFromName(p.id)), (_o, st) => { st.storage.sql.exec("DELETE FROM errors WHERE code = 'review_waiting_for_room'"); });
        await dueNow(p);
        await run(p);
        expect(await errorsOf(p)).toEqual([]);
      } finally {
        fake.maxSandboxes = null;
      }
    });

    it("a clear that fails is retried, backed off, and its job isn't pruned meanwhile", async () => {
      const { p, s } = await longWait(60_000);
      try {
        await run(p);
        expect(await errorsOf(p)).toHaveLength(1);
        await push(p, 1, sha(), { action: "synchronize" });
        await within(p, async (o) => { o.clearRoom = unreachable; await o.drain(); });
        expect((await job(p, 1, s)).state).toBe("superseded");
        const r = await roomRow(p, s);
        expect(r.room_attempts).toBe(1);
        expect((r.room_next_ms as number) - Date.now()).toBeGreaterThan(4_000);
        // Long past the jobs' keep: still kept while its word is owed.
        await within(p, async (o, st) => { st.storage.sql.exec("UPDATE jobs SET updated_ms = 0 WHERE pr = 1 AND sha = ?", s); o.prune(Date.now()); });
        expect(await within(p, async (_o, st) => st.storage.sql.exec("SELECT COUNT(*) AS n FROM jobs WHERE pr = 1 AND sha = ?", s).one().n)).toBe(1);
        await within(p, async (o, st) => { delete o.clearRoom; st.storage.sql.exec("UPDATE jobs SET room_next_ms = 0"); await o.drain(); });
        expect(await errorsOf(p)).toEqual([]);
      } finally {
        fake.maxSandboxes = null;
      }
    });
  });

  describe("nest#248's own code (429 at_capacity, retryable)", () => {
    it("a review waits the same, and the sandbox made for it goes", async () => {
      const p = await newProject();
      fake.capacityCode = true;
      fake.maxAgents = liveAgents();
      try {
        const s = sha();
        await push(p, 1, s);
        await run(p);
        expect(await job(p, 1, s)).toMatchObject({ state: "queued", error: expect.stringMatching(/at_capacity/) });
        expect(liveSandboxesOf(p, 1)).toEqual([]);
        expect(checkOf(p, s).output.title).toBe("Waiting for room to start a reviewer");
        fake.maxAgents = null;
        await dueNow(p);
        await run(p);
        expect((await job(p, 1, s)).state).toBe("running");
      } finally {
        fake.maxAgents = null;
        fake.capacityCode = false;
      }
    });

    it("a worker's start, retried under the same keys, keeps its sandbox and starts in it once there's room", async () => {
      const repo = `o-${rand()}/r-${rand()}`;
      const proj = (await api(token, "POST", "/api/projects", { name: repo, repo })).body;
      const t = (await api(token, "POST", `/api/projects/${proj.id}/tasks`, { title: "t" })).body;
      await api(token, "PUT", `/api/projects/${proj.id}/tasks/${t.id}/spec`, { goal: "g", acceptance_criteria: [], files: [], test_plan: "p" });
      fake.capacityCode = true;
      fake.maxAgents = liveAgents();
      try {
        await api(token, "POST", `/api/projects/${proj.id}/tasks/${t.id}/assign`, {});
        const project = env.PROJECT.get(env.PROJECT.idFromName(proj.id));
        await project.drain();
        const sandboxes = () => [...fake.sandboxes.values()].filter((x) => x.labels.project === proj.id && x.labels.task === t.id);
        expect(sandboxes()).toHaveLength(1);
        expect(sandboxes()[0]!.ended).toBe(false);
        fake.maxAgents = null;
        await runInDurableObject(project, (_o, st) => { st.storage.sql.exec("UPDATE tasks SET start_next_ms = 0 WHERE start_next_ms IS NOT NULL"); });
        await project.drain();
        const worker = [...fake.agents.values()].find((a) => a.labels.project === proj.id && a.labels.task === t.id);
        expect(worker?.sandbox).toBe(sandboxes()[0]!.sandbox);
        expect(sandboxes()).toHaveLength(1);
      } finally {
        fake.maxAgents = null;
        fake.capacityCode = false;
      }
    });
  });
});
