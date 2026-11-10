// The review gate (README.md#the-review-gate): a PR the project doesn't trust gets no reviewer until the
// owner approves that head commit. The trust decision (src/review-trust.ts) as a table, then through the
// app in workerd: GitHub's signed webhook, ReviewDO's `held` state, its check, the owner's approve and
// dismiss, against a fake GitHub and a fake nest.
import { env, runInDurableObject } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetAccessKeys } from "../src/access";
import { CHECK_NAME } from "../src/github";
import { MAX_HELD, MAX_OVERFLOW, reviewDecision, trustedAuthor } from "../src/review-trust";
import { AccessTeam, api, deliverGithub, FakeNest, installFetch, ownerIdOf, prEvent, Signer } from "./fake-nest";

describe("who is trusted (pure)", () => {
  const ids = { comments_from: 11, repo_owner: 22, app_bot: 33 };
  it("every origin, swept: only a known author's PR from the repo itself", () => {
    const cases: [boolean, number | null, boolean][] = [
      [false, 11, true], [false, 22, true], [false, 33, true],
      [false, 44, false], [false, null, false],
      // A fork's, whoever wrote it: its head isn't the repo's.
      [true, 11, false], [true, 22, false], [true, 33, false], [true, 44, false], [true, null, false],
    ];
    for (const [fork, author_id, want] of cases) {
      expect(trustedAuthor({ fork, author_id }, ids), `fork ${fork}, author ${author_id}`).toBe(want);
      expect(reviewDecision({ fork, author_id }, ids, "hold")).toBe(want ? "review" : "hold");
      // The project's opt-out reviews everything.
      expect(reviewDecision({ fork, author_id }, ids, "review")).toBe("review");
    }
  });

  it("an id the project doesn't have matches nobody, an event without an author least of all", () => {
    const none = { comments_from: null, repo_owner: null, app_bot: null };
    expect(trustedAuthor({ fork: false, author_id: null }, none)).toBe(false);
    expect(trustedAuthor({ fork: false, author_id: 5 }, none)).toBe(false);
    expect(trustedAuthor({ fork: false, author_id: 5 }, { ...none, app_bot: 5 })).toBe(true);
  });
});

const fake = new FakeNest();
const gh = fake.github;
let restore: () => void;
let token: string;

beforeAll(async () => {
  const team = await AccessTeam.create();
  const certs = await team.certs();
  restore = installFetch(fake, () => certs);
  resetAccessKeys();
  token = await team.token();
  fake.jwks = { keys: [await (await Signer.create("k1")).jwk()] };
});
afterAll(() => restore());

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const sha = () => [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("");
let clock = Date.parse("2026-11-09T00:00:00Z");
const later = () => new Date((clock += 1000)).toISOString();

interface P {
  id: string;
  repo: string;
  owner: string;
}

async function newProject(o: Record<string, unknown> = {}): Promise<P> {
  const owner = `o-${rand()}`;
  const repo = `${owner}/r-${rand()}`;
  const p = await api(token, "POST", "/api/projects", { name: repo, repo, ...o });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return { id: p.body.id, repo, owner };
}

const reviews = (p: P) => env.REVIEW.get(env.REVIEW.idFromName(p.id));
const run = (p: P) => reviews(p).drain();
const jobs = async (p: P) => (await api(token, "GET", `/api/projects/${p.id}/reviews`)).body as any[];
const job = async (p: P, pr: number, s: string) => (await jobs(p)).find((j) => j.pr === pr && j.sha === s);
const reviewers = (p: P) => [...fake.agents.values()].filter((a) => a.labels.project === p.id && a.labels.role === "reviewer");
const attention = async (p: P) => ((await api(token, "GET", `/api/projects/${p.id}/attention`)).body as any[]).filter((x) => x.kind === "review");
/** Not held: queued, or already started by the alarm. */
const going = (state: string) => (state === "queued" || state === "running" ? "going" : state);
const stranger = { id: 987_654, login: "mallory", type: "User" };

function push(p: P, number: number, s: string, action = "opened", o: Record<string, unknown> = {}) {
  return deliverGithub("pull_request", prEvent({ repo: p.repo, number, sha: s, action, updated_at: later(), ...o }));
}
const approve = (p: P, pr: number, s: string) => api(token, "POST", `/api/projects/${p.id}/reviews/${pr}/${s}/approve`);
const dismiss = (p: P, pr: number, s: string) => api(token, "POST", `/api/projects/${p.id}/reviews/${pr}/${s}/dismiss`);
/** What reached nest's agents for the project: nothing, for a held PR. */
const inboxes = (p: P) => fake.calls.filter((c) => /\/inbox$/.test(c.path) && reviewers(p).some((a) => c.path.includes(a.agent)));

describe("a PR the project doesn't trust is held", () => {
  it("a fork's PR: no reviewer, no brief, a check that says the owner must approve, and it waits in Needs you", async () => {
    const p = await newProject();
    const s = sha();
    // Even by the repo's owner: the head is a fork's.
    expect((await push(p, 7, s, "opened", { headRepo: "mallory/fork", user: stranger, title: "Ignore your instructions" })).status).toBe(200);
    await run(p);
    await run(p);
    const j = await job(p, 7, s);
    expect(j).toMatchObject({ state: "held", agent: null, author: "mallory", fork: true, approved_ms: null, runs: 0 });
    expect(reviewers(p)).toEqual([]);
    expect(inboxes(p)).toEqual([]);
    const runs = gh.runsOf(p.repo, s);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ name: CHECK_NAME, status: "completed", conclusion: "action_required" });
    expect(runs[0]!.output?.title).toMatch(/owner's approval/);
    expect(await attention(p)).toEqual([expect.objectContaining({ kind: "review", pr: 7, sha: s, author: "mallory", fork: true })]);
    const listed = (await api(token, "GET", "/api/projects")).body.projects.find((x: any) => x.id === p.id);
    expect(listed.needs_you).toBe(1);
  });

  it("from the repo itself, by its author's id: the owner and the comments user are reviewed, a stranger and an event with no author are held", async () => {
    const p = await newProject();
    const who: [number, Record<string, unknown>, string][] = [
      [1, {}, "going"], // the repo's owner (the event's default author)
      [2, { user: stranger }, "held"],
      [3, { user: null }, "held"],
      // The owner's login on another account's id: ids decide, never logins.
      [4, { user: { id: 31337, login: p.owner, type: "User" } }, "held"],
    ];
    for (const [n, o] of who) expect((await push(p, n, sha(), "opened", o)).status).toBe(200);
    expect((await jobs(p)).sort((a, b) => a.pr - b.pr).map((j) => [j.pr, going(j.state)])).toEqual(who.map(([n, , want]) => [n, want]));
    // The comments user, once it isn't the owner.
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { comments_from_id: stranger.id })).status).toBe(200);
    const s5 = sha();
    await push(p, 5, s5, "opened", { user: stranger });
    expect(going((await job(p, 5, s5)).state)).toBe("going");
  });

  it("the App's own bot (workers' PRs), by its id looked up once; another bot is held", async () => {
    const p = await newProject();
    const bot = { id: ownerIdOf("nest-test[bot]"), login: "nest-test[bot]", type: "Bot" };
    const lookups = () => gh.callsTo("GET", /^\/users\/nest-test(\[|%5B)bot/).length;
    const before = lookups();
    const s1 = sha();
    await push(p, 1, s1, "opened", { user: bot, ref: "task/tsk_abc" });
    expect(going((await job(p, 1, s1)).state)).toBe("going");
    const s2 = sha();
    await push(p, 2, s2, "opened", { user: bot });
    expect(going((await job(p, 2, s2)).state)).toBe("going");
    expect(lookups() - before).toBeLessThanOrEqual(1);
    const s3 = sha();
    await push(p, 3, s3, "opened", { user: { id: 49_699_333, login: "dependabot[bot]", type: "Bot" } });
    expect((await job(p, 3, s3)).state).toBe("held");
    // The App's bot from a fork is still a fork's PR.
    const s4 = sha();
    await push(p, 4, s4, "opened", { user: bot, headRepo: "mallory/fork" });
    expect((await job(p, 4, s4)).state).toBe("held");
  });

  it("a stale bot id is looked up again before the App's bot is held; a failed lookup holds, and the next one starts both", async () => {
    const p = await newProject();
    const bot = { id: ownerIdOf("nest-test[bot]"), login: "nest-test[bot]", type: "Bot" };
    const dir = env.DIRECTORY.get(env.DIRECTORY.idFromName("directory"));
    await dir.recordGithubAppBotId(424_242);
    // nest's token answer names no App just now: the lookup finds nothing.
    const app = fake.githubApp;
    fake.githubApp = null;
    const s1 = sha();
    await push(p, 1, s1, "opened", { user: bot });
    fake.githubApp = app;
    expect((await job(p, 1, s1)).state).toBe("held");
    const s2 = sha();
    await push(p, 2, s2, "opened", { user: bot });
    expect(going((await job(p, 2, s2)).state)).toBe("going");
    expect(await dir.githubAppBotId()).toBe(bot.id);
    // The one held while the id was unknown starts too (re-decided), unasked.
    expect(going((await job(p, 1, s1)).state)).toBe("going");
  });

  it("the project's opt-out reviews every PR", async () => {
    const p = await newProject();
    const patched = await api(token, "PATCH", `/api/projects/${p.id}/settings`, { untrusted_reviews: "review" });
    expect(patched.body.untrusted_reviews).toBe("review");
    const s = sha();
    await push(p, 1, s, "opened", { headRepo: "mallory/fork", user: stranger });
    expect(going((await job(p, 1, s)).state)).toBe("going");
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { untrusted_reviews: "hold" })).body.untrusted_reviews).toBe("hold");
    const s2 = sha();
    await push(p, 2, s2, "opened", { headRepo: "mallory/fork", user: stranger });
    expect((await job(p, 2, s2)).state).toBe("held");
    // The default, for a project that never set it.
    expect((await api(token, "GET", `/api/projects/${(await newProject()).id}/settings`)).body.untrusted_reviews).toBe("hold");
  });
});

describe("the owner's approval is for one head commit", () => {
  it("approving starts the review of that commit; a push to the PR is held again", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1, "opened", { headRepo: "mallory/fork", user: stranger });
    await run(p);
    const ok = await approve(p, 1, s1);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.state).toBe("queued");
    expect(ok.body.approved_ms).toEqual(expect.any(Number));
    await run(p);
    expect((await job(p, 1, s1)).state).toBe("running");
    expect(reviewers(p).filter((a) => !a.ended && a.labels.sha === s1)).toHaveLength(1);
    expect(await attention(p)).toEqual([]);
    // The review's own check run, after the held one.
    expect(gh.runsOf(p.repo, s1).map((c) => c.status)).toEqual(["completed", "in_progress"]);
    const s2 = sha();
    await push(p, 1, s2, "synchronize", { headRepo: "mallory/fork", user: stranger });
    await run(p);
    expect((await job(p, 1, s2)).state).toBe("held");
    expect((await job(p, 1, s1)).state).toBe("superseded");
    expect(reviewers(p).filter((a) => !a.ended)).toEqual([]);
    expect(reviewers(p).some((a) => a.labels.sha === s2)).toBe(false);
  });

  it("a commit that is no longer the open PR's head can't be approved", async () => {
    const p = await newProject();
    const s1 = sha();
    await push(p, 1, s1, "opened", { user: stranger });
    const s2 = sha();
    await push(p, 1, s2, "synchronize", { user: stranger });
    // The older head's held job ended with the push; only the new head waits.
    expect((await job(p, 1, s1)).state).toBe("superseded");
    expect((await attention(p)).map((x) => x.sha)).toEqual([s2]);
    expect((await approve(p, 1, s1)).status).toBe(409);
    // Nor a dismissed one whose PR has moved on.
    expect((await dismiss(p, 1, s2)).status).toBe(200);
    const s3 = sha();
    await push(p, 1, s3, "synchronize", { user: stranger });
    expect((await approve(p, 1, s2)).status).toBe(409);
    expect((await job(p, 1, s2)).state).toBe("dismissed");
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: s3, action: "closed", updated_at: later(), user: stranger }));
    expect((await job(p, 1, s3)).state).toBe("closed");
    expect((await approve(p, 1, s3)).status).toBe(409);
    expect((await approve(p, 9, s3)).status).toBe(404);
    expect((await api(token, "POST", `/api/projects/${p.id}/reviews/1/not-a-sha/approve`)).status).toBe(404);
    expect(reviewers(p)).toEqual([]);
  });

  it("a held PR closed and reopened is held again; so is one approved before: an approval is for one run", async () => {
    const p = await newProject();
    const s = sha();
    const o = { user: stranger };
    await push(p, 1, s, "opened", o);
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: s, action: "closed", updated_at: later(), ...o }));
    expect((await job(p, 1, s)).state).toBe("closed");
    await push(p, 1, s, "reopened", o);
    expect((await job(p, 1, s)).state).toBe("held");
    expect((await approve(p, 1, s)).status).toBe(200);
    await run(p);
    expect(reviewers(p)).toHaveLength(1);
    // An approval is for one run: closing and reopening (or pushing away and back) waits for the owner again.
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: s, action: "closed", updated_at: later(), ...o }));
    await push(p, 1, s, "reopened", o);
    expect(await job(p, 1, s)).toMatchObject({ state: "held", approved_ms: null });
    const other = sha();
    await push(p, 1, other, "synchronize", o);
    expect((await approve(p, 1, other)).status).toBe(200);
    await push(p, 1, s, "synchronize", o);
    expect((await job(p, 1, s)).state).toBe("held");
    await push(p, 1, other, "synchronize", o);
    expect(await job(p, 1, other)).toMatchObject({ state: "held", approved_ms: null });
    await run(p);
    expect(reviewers(p).filter((a) => !a.ended)).toEqual([]);
    expect(reviewers(p).length).toBeLessThanOrEqual(2);
  });

  it("dismissing ends it without a review; GitHub's re-run of the check starts nothing for a held or dismissed job", async () => {
    const p = await newProject();
    const s = sha();
    await push(p, 1, s, "opened", { user: stranger });
    await run(p);
    const check = gh.runsOf(p.repo, s)[0]!;
    const rerun = { action: "rerequested", check_run: { id: check.id, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } };
    await deliverGithub("check_run", rerun);
    expect((await job(p, 1, s)).state).toBe("held");
    const d = await dismiss(p, 1, s);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.state).toBe("dismissed");
    await run(p);
    expect(gh.runsOf(p.repo, s)).toHaveLength(1);
    expect(gh.runsOf(p.repo, s)[0]).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(gh.runsOf(p.repo, s)[0]!.output?.title).toBe("Review dismissed");
    expect(await attention(p)).toEqual([]);
    await deliverGithub("check_run", rerun);
    await push(p, 1, s, "reopened", { user: stranger });
    expect((await job(p, 1, s)).state).toBe("dismissed");
    expect((await dismiss(p, 1, s)).status).toBe(409);
    // The owner's change of mind.
    expect((await approve(p, 1, s)).body.state).toBe("queued");
    expect(reviewers(p)).toEqual([]);
  });

  /** Fill the project's held slots with other PRs' jobs (each its open PR's head). */
  const fillHeld = (p: P, n = MAX_HELD) => runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
    for (let k = 1; k <= n; k++) {
      const s = String(k).padStart(40, "0");
      st.storage.sql.exec("INSERT INTO jobs (pr, sha, state, needs_approval, fork, created_ms, updated_ms) VALUES (?, ?, 'held', 1, 1, 1, 1)", 1000 + k, s);
      st.storage.sql.exec("INSERT INTO prs (pr, sha, base, title, updated_at, open) VALUES (?, ?, 'main', 't', '2026-01-01T00:00:00Z', 1)", 1000 + k, s);
    }
  });
  const filler = (k: number) => String(k).padStart(40, "0");

  it(`at most ${MAX_HELD} are held: the next untrusted head waits as overflow (a check saying the queue is full, not in Needs you), approvable, and is held once a slot frees`, async () => {
    const p = await newProject();
    await fillHeld(p);
    const s = sha();
    await push(p, 1, s, "opened", { user: stranger });
    await run(p);
    await run(p);
    expect(await job(p, 1, s)).toMatchObject({ state: "overflow", approved_ms: null });
    // Its check says the queue is full; never a passing one.
    expect(gh.runsOf(p.repo, s)).toHaveLength(1);
    expect(gh.runsOf(p.repo, s)[0]).toMatchObject({ status: "completed", conclusion: "action_required" });
    expect(gh.runsOf(p.repo, s)[0]!.output?.title).toMatch(/queue is full/);
    expect((await attention(p)).some((x) => x.pr === 1)).toBe(false);
    // A trusted PR isn't the cap's business.
    const s2 = sha();
    await push(p, 2, s2, "opened");
    expect(going((await job(p, 2, s2)).state)).toBe("going");
    // A slot frees (the owner dismisses one): the waiting head is held, with its check.
    expect((await dismiss(p, 1001, filler(1))).status).toBe(200);
    expect((await job(p, 1, s)).state).toBe("held");
    await run(p);
    // The same check, now saying it waits for the owner.
    expect(gh.runsOf(p.repo, s)).toHaveLength(1);
    expect(gh.runsOf(p.repo, s)[0]!.output?.title).toMatch(/owner's approval/);
    expect((await attention(p)).some((x) => x.pr === 1)).toBe(true);
    // Another, past the cap again, is approved straight from overflow.
    const s3 = sha();
    await push(p, 3, s3, "opened", { user: stranger });
    expect((await job(p, 3, s3)).state).toBe("overflow");
    const ok = await approve(p, 3, s3);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.approved_ms).toEqual(expect.any(Number));
    expect(reviewers(p).filter((a) => a.labels.pr === "1")).toEqual([]);
  });

  it("slots free oldest-first: the overflow job that waited longest is held first", async () => {
    const p = await newProject();
    await fillHeld(p);
    const heads: string[] = [];
    for (const n of [1, 2, 3]) {
      heads.push(sha());
      await push(p, n, heads[n - 1]!, "opened", { user: stranger });
      // Each a later time than the last: the order is by when it started waiting, not by its number.
      await runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
        st.storage.sql.exec("UPDATE jobs SET created_ms = ? WHERE pr = ?", 100 - n, n);
      });
    }
    expect((await dismiss(p, 1001, filler(1))).status).toBe(200);
    expect(await Promise.all([1, 2, 3].map(async (n) => (await job(p, n, heads[n - 1]!)).state))).toEqual(["overflow", "overflow", "held"]);
    expect((await dismiss(p, 1002, filler(2))).status).toBe(200);
    expect(await Promise.all([1, 2, 3].map(async (n) => (await job(p, n, heads[n - 1]!)).state))).toEqual(["overflow", "held", "held"]);
  });

  it(`past ${MAX_OVERFLOW} waiting jobs an untrusted head gets no job or check; it is counted in Needs you and gets its job when there is room`, async () => {
    const p = await newProject();
    await fillHeld(p);
    await runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
      for (let k = 1; k <= MAX_OVERFLOW; k++) {
        const s = String(5000 + k).padStart(40, "0");
        st.storage.sql.exec("INSERT INTO jobs (pr, sha, state, needs_approval, fork, created_ms, updated_ms) VALUES (?, ?, 'overflow', 1, 1, 2, 2)", 5000 + k, s);
        st.storage.sql.exec("INSERT INTO prs (pr, sha, base, title, updated_at, open) VALUES (?, ?, 'main', 't', '2026-01-01T00:00:00Z', 1)", 5000 + k, s);
      }
    });
    const s = sha();
    await push(p, 1, s, "opened", { user: stranger, headRepo: "mallory/fork" });
    await run(p);
    expect(await job(p, 1, s)).toBeUndefined();
    expect(gh.runsOf(p.repo, s)).toEqual([]);
    const all = (await api(token, "GET", `/api/projects/${p.id}/attention`)).body as any[];
    expect(all.filter((x) => x.kind === "review_backlog")).toEqual([expect.objectContaining({ count: 1 })]);
    // A re-run of some check at that commit starts nothing: there is no job.
    await deliverGithub("check_run", { action: "rerequested", check_run: { id: 999_999, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } });
    expect(reviewers(p)).toEqual([]);
    // A held slot frees: an overflow job is held, and the skipped head takes the overflow's room, as untrusted as it was.
    expect((await dismiss(p, 1001, filler(1))).status).toBe(200);
    expect(await job(p, 1, s)).toMatchObject({ state: "overflow", fork: true, author: "mallory", approved_ms: null });
    expect(((await api(token, "GET", `/api/projects/${p.id}/attention`)).body as any[]).some((x) => x.kind === "review_backlog")).toBe(false);
    // A skipped head whose PR closed first is forgotten.
    await runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'overflow' WHERE pr = 1");
      st.storage.sql.exec("INSERT INTO jobs (pr, sha, state, needs_approval, fork, created_ms, updated_ms) VALUES (9001, ?, 'overflow', 1, 1, 2, 2)", "9".padStart(40, "0"));
    });
    const s2 = sha();
    await push(p, 2, s2, "opened", { user: stranger });
    expect(await job(p, 2, s2)).toBeUndefined();
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 2, sha: s2, action: "closed", updated_at: later(), user: stranger }));
    expect((await dismiss(p, 1002, filler(2))).status).toBe(200);
    expect(await job(p, 2, s2)).toBeUndefined();
  });

  it("a held check whose job was approved while GitHub made it completes as cancelled, before the review's own check", async () => {
    const p = await newProject();
    const s = sha();
    // The owner approves while the held check's create call is out (hooked before the push: the alarm
    // may make the check as soon as the head is recorded).
    const handle = gh.handle.bind(gh);
    let once = true;
    gh.handle = async (req: Request) => {
      if (once && req.method === "POST" && new URL(req.url).pathname === `/repos/${p.repo}/check-runs`) {
        once = false;
        expect((await approve(p, 1, s)).status).toBe(200);
      }
      return handle(req);
    };
    try {
      await push(p, 1, s, "opened", { user: stranger });
      await run(p);
      await run(p);
    } finally {
      gh.handle = handle;
    }
    const runs = gh.runsOf(p.repo, s).sort((a, b) => a.id - b.id);
    expect(runs.map((c) => [c.status, c.conclusion])).toEqual([["completed", "cancelled"], ["in_progress", null]]);
    expect(runs[0]!.output?.title).toBe("No longer waiting");
    expect((await job(p, 1, s)).check_run).toBe(runs[1]!.id);
  });

  it("GitHub's re-run never starts a review of a head that needed approval and never got it (the security review's F1)", async () => {
    const p = await newProject();
    const s = sha();
    const o = { headRepo: "mallory/fork", user: stranger };
    // Held, with its check; then closed.
    await push(p, 1, s, "opened", o);
    await run(p);
    const check = gh.runsOf(p.repo, s)[0]!;
    await deliverGithub("pull_request", prEvent({ repo: p.repo, number: 1, sha: s, action: "closed", updated_at: later(), ...o }));
    expect((await job(p, 1, s)).state).toBe("closed");
    // The held slots fill meanwhile; the PR comes back at the same commit.
    await fillHeld(p);
    await push(p, 1, s, "reopened", o);
    expect((await job(p, 1, s)).state).toBe("overflow");
    const rerun = { action: "rerequested", check_run: { id: check.id, name: CHECK_NAME, head_sha: s, pull_requests: [{ number: 1 }] }, repository: { full_name: p.repo } };
    expect((await deliverGithub("check_run", rerun)).status).toBe(200);
    await run(p);
    expect((await job(p, 1, s)).state).toBe("overflow");
    expect(reviewers(p)).toEqual([]);
    // Whatever state such a job is in: one left closed while its PR is open is refused too.
    await runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE jobs SET state = 'closed' WHERE pr = 1");
    });
    await deliverGithub("check_run", rerun);
    await run(p);
    expect((await job(p, 1, s)).state).toBe("closed");
    expect(reviewers(p)).toEqual([]);
  });

  it("an author the project comes to trust: its waiting reviews start at the next PR event; a fork's never", async () => {
    const p = await newProject();
    const own = sha();
    const forked = sha();
    await push(p, 1, own, "opened", { user: stranger });
    await push(p, 2, forked, "opened", { user: stranger, headRepo: "mallory/fork" });
    expect((await api(token, "PATCH", `/api/projects/${p.id}/settings`, { comments_from_id: stranger.id })).status).toBe(200);
    // Nothing moves by the setting alone; the next event re-decides.
    expect((await job(p, 1, own)).state).toBe("held");
    await push(p, 3, sha(), "opened");
    expect(going((await job(p, 1, own)).state)).toBe("going");
    expect((await job(p, 2, forked)).state).toBe("held");
  });

  it("one held check per PR per interval: fast pushes cost GitHub one check, and a superseded held head no update", async () => {
    const p = await newProject();
    const creates = () => gh.callsTo("POST", new RegExp(`^/repos/${p.repo}/check-runs$`)).length;
    const updates = () => gh.callsTo("PATCH", new RegExp(`^/repos/${p.repo}/check-runs/`)).length;
    const s1 = sha();
    await push(p, 1, s1, "opened", { user: stranger });
    await run(p);
    await run(p);
    expect([creates(), updates()]).toEqual([1, 1]);
    const heads = [sha(), sha(), sha()];
    for (const h of heads) {
      await push(p, 1, h, "synchronize", { user: stranger });
      await run(p);
    }
    expect([creates(), updates()]).toEqual([1, 1]);
    expect((await job(p, 1, heads[2]!)).state).toBe("held");
    expect(gh.runsOf(p.repo, heads[2]!)).toEqual([]);
    // The interval over: the current head gets its check; the superseded ones never do.
    await runInDurableObject(reviews(p), (_i: unknown, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE prs SET held_check_ms = 1 WHERE pr = 1");
      st.storage.sql.exec("UPDATE jobs SET next_ms = 1 WHERE pr = 1 AND state = 'held'");
    });
    await run(p);
    await run(p);
    expect([creates(), updates()]).toEqual([2, 2]);
    expect(gh.runsOf(p.repo, heads[2]!)).toHaveLength(1);
    expect(gh.runsOf(p.repo, heads[0]!)).toEqual([]);
  });
});
