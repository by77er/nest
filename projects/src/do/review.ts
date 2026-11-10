// ReviewDO, one per project (README.md#built-the-review-pipeline): the review queue, one job per PR head, with its check
// run, its reviewer agent and its verdict. An asynchronous process of its own: GitHub's events and the
// reviewer's tools only record what happened (one synchronous step on SQLite that arms the alarm); the
// alarm does the calls to GitHub and nest, retried from 5 s doubling to 5 min, and re-reads the job
// after each, since other requests run while one awaits.
//
// A job's states (the table in src/review-job.ts, through which every change of state goes): `queued`
// (waiting for its turn, under `max_concurrent_reviews`), `running` (its check run, reviewer and brief are
// made in turn, then it waits for the verdict, until its deadline), and how it ended: `done` (a verdict),
// `failed` (no verdict after retries, or refused for good), `superseded` (a newer head) or `closed` (the PR
// closed). Each end owes GitHub its check's completion, once, and nest the reviewer's stop.
//
// A PR the project doesn't trust (src/review-trust.ts) starts `held` instead: its check says the owner
// must approve the review, and nothing else happens (no agent, no sandbox, none of its text to anyone)
// until the owner approves that head commit, or dismisses it (`dismissed`).

import { DurableObject } from "cloudflare:workers";
import { TEMPLATE } from "../catalog";
import { directory, type Env, project as projectStub } from "../env";
import { type CheckOutput, type CheckRunUpdate, type Conclusion, type GitHub, GitHubError, githubFor, PERMISSIONS, type Verdict, verdictCheck } from "../github";
import type { AgentCaller } from "../identity";
import { backoff, NestError, nestFrom, type Nest, stopRefused } from "../nest";
import { OUTBOX, type OutboxPolicy, type OutboxRow, outboxStep } from "../outbox";
import { invalid } from "../schema";
import { fail, migrate, ok, type Result } from "../sql";
import { toolOf } from "../tools";
import { EARLY_EXITS_KEEP_MS, PRUNE_EVERY_MS, REVIEW_JOBS_KEEP_MS } from "../retention";
import { type JobEvent, type JobState, jobTransition, REVIEW_DEADLINE_MS } from "../review-job";
import { HELD_CHECK_INTERVAL_MS, MAX_HELD, MAX_OVERFLOW, type PrOrigin, reviewDecision, type TrustedIds, trustedAuthor, type UntrustedPolicy } from "../review-trust";

export type { JobState };

/** How many times a reviewer that exits without a verdict is started again before the job fails. */
export const MAX_RETRIES = 2;
/**
 * A job that ends without a verdict completes its check as `action_required`: required checks accept
 * `success`, `skipped` and `neutral` (GitHub's "About protected branches"), so this one blocks merging
 * until the check is re-run, as `neutral` would not.
 */
export const NO_VERDICT: Conclusion = "action_required";
/** A superseded or closed job's check: `cancelled`, which isn't passing either. */
export const ENDED: Conclusion = "cancelled";
const CALLS_KEEP_MS = 24 * 3600 * 1000;


export interface Job {
  pr: number;
  sha: string;
  state: JobState;
  title: string | null;
  base: string | null;
  agent: string | null;
  check_run: number | null;
  verdict: Verdict | null;
  /** Whether the session that submitted the verdict was tainted. */
  tainted: boolean | null;
  /** Reviewers that exited without a verdict since the job was last queued. */
  attempts: number;
  /** Reviewers started for the job, ever: each start's idempotency keys carry it. */
  runs: number;
  error: string | null;
  /** While running: when the current reviewer's time is up (an attempt spent, like an exit without a verdict). */
  deadline_ms: number | null;
  /** The PR's author as the event named it (a login anyone chose: shown as text only), and whether its head is a fork's. */
  author: string | null;
  fork: boolean;
  /** When the owner approved this head commit's review; null for one that needed no approval, or has none. */
  approved_ms: number | null;
  created_ms: number;
  updated_ms: number;
}

/** A PR head as `pull_request` names it, with where it comes from. */
export interface HeadEvent extends PrOrigin {
  pr: number;
  sha: string;
  base: string;
  title: string;
  updated_at: string;
  author: string | null;
}

/** What a project's ReviewDO needs to know of it. */
export interface ReviewOf {
  project: string;
  repo: string;
}

const MIGRATIONS = [
  [
    `CREATE TABLE jobs (pr INTEGER NOT NULL, sha TEXT NOT NULL, state TEXT NOT NULL, agent TEXT, check_run INTEGER, verdict TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL, PRIMARY KEY (pr, sha))`,
    "CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  ],
  [
    "ALTER TABLE jobs ADD COLUMN title TEXT",
    "ALTER TABLE jobs ADD COLUMN base TEXT",
    "ALTER TABLE jobs ADD COLUMN runs INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN briefed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN errors INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN error TEXT",
    "ALTER TABLE jobs ADD COLUMN tainted INTEGER",
    "CREATE INDEX jobs_agent ON jobs (agent)",
    "CREATE INDEX jobs_check ON jobs (check_run)",
    // Each PR's head as the app last heard it: an event older than that (`updated_at`) moves nothing.
    "CREATE TABLE prs (pr INTEGER PRIMARY KEY, sha TEXT NOT NULL, base TEXT NOT NULL, title TEXT NOT NULL, updated_at TEXT NOT NULL, open INTEGER NOT NULL)",
    "CREATE TABLE check_updates (check_run INTEGER PRIMARY KEY, body TEXT NOT NULL, next_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)",
    "CREATE TABLE stops (agent TEXT PRIMARY KEY, reason TEXT NOT NULL, next_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)",
    "CREATE TABLE mcp_calls (key TEXT PRIMARY KEY, result TEXT NOT NULL, at_ms INTEGER NOT NULL)",
  ],
  [
    // Reviews that ended (a verdict, or failed), owed to ProjectDO for the manager's waits on them
    // (README.md#waiting): each told once, retried from the alarm until it's taken.
    "CREATE TABLE ended (pr INTEGER NOT NULL, sha TEXT NOT NULL, state TEXT NOT NULL, conclusion TEXT, next_ms INTEGER NOT NULL, PRIMARY KEY (pr, sha))",
  ],
  [
    // A running job's deadline (src/review-job.ts): a reviewer that neither submits nor exits by then is an
    // attempt spent. Jobs running before this step get one at the next drain.
    "ALTER TABLE jobs ADD COLUMN deadline_ms INTEGER",
  ],
  [
    // The review gate (src/review-trust.ts): who opened the PR and from where, and the owner's approval of this commit.
    "ALTER TABLE jobs ADD COLUMN author TEXT",
    "ALTER TABLE jobs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN approved_ms INTEGER",
    // The author's GitHub id (what trust is decided by), and that this head needs the owner's approval:
    // set when it was decided, whatever state the job is in later. Such a job is never queued unapproved.
    "ALTER TABLE jobs ADD COLUMN author_id INTEGER",
    "ALTER TABLE jobs ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0",
    // When the PR's last held check run was made (HELD_CHECK_INTERVAL_MS).
    "ALTER TABLE prs ADD COLUMN held_check_ms INTEGER",
    // An untrusted head that got no job (past MAX_OVERFLOW): who and from where, kept with the PR so it
    // gets its job once there is room. `skipped_ms` is when; null for a PR whose head has its job.
    "ALTER TABLE prs ADD COLUMN skipped_ms INTEGER",
    "ALTER TABLE prs ADD COLUMN author TEXT",
    "ALTER TABLE prs ADD COLUMN author_id INTEGER",
    "ALTER TABLE prs ADD COLUMN fork INTEGER NOT NULL DEFAULT 0",
  ],
  [
    // A reviewer's exit that came before its job named it (the exit overtook the create's answer):
    // matched by its id once the job learns it (pruned after a day).
    "CREATE TABLE early_exits (agent TEXT PRIMARY KEY, reason TEXT, at_ms INTEGER NOT NULL)",
  ],
  [
    // The queues as outbox rows (README.md#outboxes): a finished review's word to the project counts its
    // tries, and a reviewer's stop nest refused for good is kept, not retried (`failed_ms`).
    "ALTER TABLE ended ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE ended ADD COLUMN error TEXT",
    "ALTER TABLE stops ADD COLUMN failed_ms INTEGER",
  ],
] as const;

/** `next_ms` for a row that's kept but never due (its column can't be null): a failed stop. */
const NOT_DUE_MS = 253_402_300_799_000;

/** A queue row's columns as the outbox's (`attempts` is `errors` on a job's own step). */
const outboxRow = (r: Row, attempts: "attempts" | "errors" = "attempts"): OutboxRow =>
  ({ next_ms: (r.next_ms as number | null) ?? Date.now(), attempts: (r[attempts] as number | null) ?? 0, error: (r.error as string | null) ?? null });

/** Whether a call's failure will repeat (nest's or GitHub's refusal), not an outage or a timeout. */
const refused = (e: unknown) => (e instanceof NestError || e instanceof GitHubError) && e.permanent;

type Row = Record<string, SqlStorageValue>;

export class ReviewDO extends DurableObject<Env> {
  private draining: Promise<void> | null = null;
  private again = false;
  /** When this instance last pruned (in memory: a restart prunes at its first drain). */
  private prunedMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, MIGRATIONS);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // --- settings --------------------------------------------------------------------------------------

  private setting(k: string): string | null {
    return this.sql.exec<{ v: string }>("SELECT v FROM settings WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private setSetting(k: string, v: string | null): void {
    if (v === null) this.sql.exec("DELETE FROM settings WHERE k = ?", k);
    else this.sql.exec("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** Learn which project this is (from the Worker, which routed the call here by it). */
  private bind(p: ReviewOf): void {
    if (this.setting("project") === null) {
      this.setSetting("project", p.project);
      this.setSetting("repo", p.repo);
    }
  }

  async init(p: ReviewOf, o: { max_concurrent_reviews?: number | null } = {}): Promise<void> {
    this.bind(p);
    if (o.max_concurrent_reviews !== undefined) await this.setMaxConcurrent(o.max_concurrent_reviews);
  }

  /** The repo was renamed or transferred (README.md#the-repos-binding): its check runs are made under `name` from now on. */
  async repoRenamed(name: string): Promise<void> {
    if (this.setting("project") !== null) this.setSetting("repo", name.toLowerCase());
  }

  /** The cap on running reviews: null (the default) for none. */
  async maxConcurrent(): Promise<number | null> {
    return this.cap();
  }

  private cap(): number | null {
    const v = this.setting("max_concurrent_reviews");
    return v === null ? null : Number(v);
  }

  async setMaxConcurrent(n: number | null): Promise<number | null> {
    this.setSetting("max_concurrent_reviews", n === null ? null : String(Math.max(0, Math.floor(n))));
    await this.arm();
    return this.cap();
  }

  /** What happens to a PR the project doesn't trust: held for the owner (the default), or reviewed like any other. */
  async untrustedPolicy(): Promise<UntrustedPolicy> {
    return this.policy();
  }

  private policy(): UntrustedPolicy {
    return this.setting("untrusted_reviews") === "review" ? "review" : "hold";
  }

  async setUntrustedPolicy(p: UntrustedPolicy): Promise<UntrustedPolicy> {
    this.setSetting("untrusted_reviews", p === "review" ? "review" : null);
    return this.policy();
  }

  // --- the queue -------------------------------------------------------------------------------------

  private jobRow(pr: number, sha: string): Row | undefined {
    return this.sql.exec("SELECT * FROM jobs WHERE pr = ? AND sha = ?", pr, sha).toArray()[0];
  }

  private toJob(r: Row): Job {
    return {
      pr: r.pr as number, sha: r.sha as string, state: r.state as JobState, title: (r.title as string | null) ?? null, base: (r.base as string | null) ?? null,
      agent: (r.agent as string | null) ?? null, check_run: (r.check_run as number | null) ?? null,
      verdict: r.verdict ? (JSON.parse(r.verdict as string) as Verdict) : null, tainted: r.tainted === null ? null : r.tainted === 1,
      attempts: r.attempts as number, runs: r.runs as number, error: (r.error as string | null) ?? null,
      deadline_ms: r.state === "running" ? ((r.deadline_ms as number | null) ?? null) : null,
      author: (r.author as string | null) ?? null, fork: r.fork === 1, approved_ms: (r.approved_ms as number | null) ?? null,
      created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
    };
  }

  /** The queue's jobs, newest first. */
  async jobs(): Promise<Job[]> {
    return this.sql.exec("SELECT * FROM jobs ORDER BY created_ms DESC, pr DESC LIMIT 100").toArray().map((r) => this.toJob(r));
  }

  /** The jobs held for the owner's approval, oldest first. */
  async held(): Promise<Job[]> {
    return this.sql.exec("SELECT * FROM jobs WHERE state = 'held' ORDER BY created_ms, pr").toArray().map((r) => this.toJob(r));
  }

  /**
   * A PR's head, from `pull_request` `opened`, `reopened` or `synchronize`: its job is queued, and the
   * jobs of the PR's older heads end (superseded), their reviewers stopped and their checks cancelled.
   * An event older than the last one heard for the PR is ignored, since GitHub doesn't order deliveries.
   *
   * A head the project doesn't trust (`reviewDecision`, by the ids `trust` carries) is held instead: per
   * commit, so a push to a PR whose earlier head was approved is held again. Past MAX_HELD held jobs it
   * waits as `overflow` until a slot frees. Jobs waiting for an author the project now trusts start.
   */
  async onHead(p: ReviewOf, e: HeadEvent, trust: TrustedIds): Promise<{ queued: boolean; held: boolean }> {
    this.bind(p);
    const hold = reviewDecision(e, trust, this.policy()) === "hold";
    const prev = this.sql.exec("SELECT updated_at FROM prs WHERE pr = ?", e.pr).toArray()[0];
    if (prev && e.updated_at < (prev.updated_at as string)) return { queued: false, held: false };
    this.sql.exec(
      `INSERT INTO prs (pr, sha, base, title, updated_at, open, author, author_id, fork) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT (pr) DO UPDATE SET sha = excluded.sha, base = excluded.base, title = excluded.title, updated_at = excluded.updated_at, open = 1,
          author = excluded.author, author_id = excluded.author_id, fork = excluded.fork, skipped_ms = NULL`,
      e.pr, e.sha, e.base, e.title, e.updated_at, e.author, e.author_id, e.fork ? 1 : 0,
    );
    for (const old of this.sql.exec("SELECT * FROM jobs WHERE pr = ? AND sha != ? AND state IN ('held', 'overflow', 'queued', 'running')", e.pr, e.sha).toArray()) {
      this.end(old, "superseded", ENDED, { title: "Superseded", summary: `A newer commit, ${e.sha}, was pushed to the PR; it gets its own review.` });
    }
    const now = Date.now();
    const j = this.jobRow(e.pr, e.sha);
    let queued = false;
    let held = false;
    if (!j) {
      // Its first state: queued, or for an untrusted head held, or overflow past the cap on held jobs.
      const state: JobState | null = !hold ? "queued" : this.heldRoom() ? "held" : this.count("overflow") < MAX_OVERFLOW ? "overflow" : null;
      if (state) {
        this.sql.exec(
          "INSERT INTO jobs (pr, sha, state, title, base, author, author_id, fork, needs_approval, next_ms, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          e.pr, e.sha, state, e.title, e.base, e.author, e.author_id, e.fork ? 1 : 0, hold ? 1 : 0, now, now, now,
        );
        queued = state === "queued";
        held = state === "held";
      } else {
        // No job yet: the head is marked on its PR, counted for the owner, and gets its job when there is room.
        this.sql.exec("UPDATE prs SET skipped_ms = ? WHERE pr = ?", now, e.pr);
        console.warn(`review: ${MAX_HELD} reviews are held and ${MAX_OVERFLOW} more wait; PR #${e.pr} at ${e.sha} gets no job until there is room`);
      }
    } else {
      // Decided again for this event: a head that needs approval keeps needing it until it has it.
      this.sql.exec(
        "UPDATE jobs SET title = ?, base = ?, author = ?, author_id = ?, fork = ?, needs_approval = ? WHERE pr = ? AND sha = ?",
        e.title, e.base, e.author, e.author_id, e.fork ? 1 : 0, hold && (j.approved_ms === null || j.state === "superseded" || j.state === "closed") ? 1 : 0, e.pr, e.sha,
      );
      // An ended job's approval is spent.
      if (hold && (j.state === "superseded" || j.state === "closed")) this.sql.exec("UPDATE jobs SET approved_ms = NULL WHERE pr = ? AND sha = ?", e.pr, e.sha);
      // The head moved back to a commit whose job ended, or the PR was reopened: reviewed again, or, for
      // an untrusted head, held again (overflow with no slot free). An approval is for one run of the
      // review: an author who closes and reopens, or pushes away and back, waits for the owner again.
      if (j.state === "superseded" || j.state === "closed") {
        if (!hold) {
          queued = this.requeue(e.pr, e.sha);
        } else if (this.move(e.pr, e.sha, j.state as JobState, this.heldRoom() ? "hold" : "park")) {
          this.reset(e.pr, e.sha);
          held = this.jobRow(e.pr, e.sha)!.state === "held";
        }
      }
    }
    this.redecide(trust);
    this.fillHeld();
    await this.arm();
    return { queued, held };
  }

  private count(state: JobState): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = ?", state).one().n;
  }

  private heldRoom(): boolean {
    return this.count("held") < MAX_HELD;
  }

  /** Untrusted heads that got no job (past the cap on waiting ones), still their open PR's head: how many, and since when. */
  async skipped(): Promise<{ count: number; at_ms: number | null }> {
    const r = this.sql.exec<{ n: number; at: number | null }>("SELECT COUNT(*) AS n, MIN(skipped_ms) AS at FROM prs WHERE skipped_ms IS NOT NULL AND open = 1").one();
    return { count: r.n, at_ms: r.at };
  }

  /**
   * Room freed: the oldest overflow jobs become held (their checks say so, and they show in "Needs you"),
   * and the oldest heads that got no job take the overflow's room.
   */
  private fillHeld(): void {
    this.promote();
    const room = MAX_OVERFLOW - this.count("overflow");
    if (room <= 0) return;
    const now = Date.now();
    for (const p of this.sql.exec("SELECT * FROM prs WHERE skipped_ms IS NOT NULL AND open = 1 ORDER BY skipped_ms, pr LIMIT ?", room).toArray()) {
      this.sql.exec(
        "INSERT OR IGNORE INTO jobs (pr, sha, state, title, base, author, author_id, fork, needs_approval, next_ms, created_ms, updated_ms) VALUES (?, ?, 'overflow', ?, ?, ?, ?, ?, 1, ?, ?, ?)",
        p.pr, p.sha, p.title, p.base, p.author, p.author_id, p.fork, now, p.skipped_ms, now,
      );
      this.sql.exec("UPDATE prs SET skipped_ms = NULL WHERE pr = ?", p.pr);
    }
    this.promote();
  }

  private promote(): void {
    const room = MAX_HELD - this.count("held");
    if (room <= 0) return;
    for (const j of this.sql.exec("SELECT pr, sha FROM jobs WHERE state = 'overflow' ORDER BY created_ms, pr LIMIT ?", room).toArray()) {
      if (!this.move(j.pr as number, j.sha as string, "overflow", "hold")) continue;
      // Its check, if it has one, now says it waits for the owner (no new check run); else one is made.
      const r = this.jobRow(j.pr as number, j.sha as string)!;
      if (r.check_run !== null) this.oweCheck(r.check_run as number, { status: "completed", conclusion: NO_VERDICT, completed_at: new Date().toISOString(), output: HELD_OUTPUT });
      else this.sql.exec("UPDATE jobs SET next_ms = ? WHERE pr = ? AND sha = ?", Date.now(), j.pr, j.sha);
    }
  }

  /**
   * Jobs waiting for approval whose author the project trusts by now (the App's bot's id learned since,
   * a comments user set) and whose head is the repo's own: they start, as they would have. Never a fork's.
   */
  private redecide(trust: TrustedIds): void {
    if (this.policy() !== "hold") return;
    for (const j of this.sql.exec("SELECT pr, sha, state, fork, author_id FROM jobs WHERE state IN ('held', 'overflow') AND approved_ms IS NULL").toArray()) {
      if (!trustedAuthor({ fork: j.fork === 1, author_id: (j.author_id as number | null) ?? null }, trust)) continue;
      if (!this.move(j.pr as number, j.sha as string, j.state as JobState, "trust")) continue;
      this.reset(j.pr as number, j.sha as string);
      this.sql.exec("UPDATE jobs SET needs_approval = 0 WHERE pr = ? AND sha = ?", j.pr, j.sha);
    }
  }

  /**
   * The owner approves a held (or dismissed) review of this head commit: queued like any other, if the
   * commit is still its open PR's head. Only this commit: the PR's next head is decided afresh.
   */
  async approve(pr: number, sha: string): Promise<Result<Job>> {
    const j = this.jobRow(pr, sha);
    if (!j) return fail(404, "no review for that PR and commit");
    if (j.state !== "held" && j.state !== "overflow" && j.state !== "dismissed") return fail(409, `this review is ${j.state as string}, not waiting for approval`);
    const head = this.sql.exec("SELECT sha, open FROM prs WHERE pr = ?", pr).toArray()[0];
    if (!head || head.open !== 1 || head.sha !== sha) return fail(409, "that commit is no longer the open PR's head");
    if (!this.move(pr, sha, j.state as JobState, "approve")) return fail(409, "the review moved meanwhile");
    this.reset(pr, sha);
    this.sql.exec("UPDATE jobs SET approved_ms = ?, needs_approval = 0 WHERE pr = ? AND sha = ?", Date.now(), pr, sha);
    this.fillHeld();
    await this.arm();
    return ok(this.toJob(this.jobRow(pr, sha)!));
  }

  /** The owner dismisses a held review: no review of this commit; its check stays unpassed. */
  async dismiss(pr: number, sha: string): Promise<Result<Job>> {
    const j = this.jobRow(pr, sha);
    if (!j) return fail(404, "no review for that PR and commit");
    if (j.state !== "held") return fail(409, `this review is ${j.state as string}, not waiting for approval`);
    this.end(j, "dismiss", NO_VERDICT, { title: "Review dismissed", summary: "The project's owner dismissed this review; the commit isn't reviewed." });
    this.fillHeld();
    await this.arm();
    return ok(this.toJob(this.jobRow(pr, sha)!));
  }

  /** `pull_request` `closed`: the PR's running and queued jobs end. */
  async onClosed(p: ReviewOf, e: { pr: number; updated_at: string }): Promise<void> {
    this.bind(p);
    const prev = this.sql.exec("SELECT updated_at FROM prs WHERE pr = ?", e.pr).toArray()[0];
    if (prev && e.updated_at < (prev.updated_at as string)) return;
    this.sql.exec("UPDATE prs SET open = 0, skipped_ms = NULL, updated_at = ? WHERE pr = ?", e.updated_at, e.pr);
    for (const j of this.sql.exec("SELECT * FROM jobs WHERE pr = ? AND state IN ('held', 'overflow', 'queued', 'running')", e.pr).toArray()) {
      this.end(j, "closed", ENDED, { title: "PR closed", summary: "The PR was closed before its review finished." });
    }
    this.fillHeld();
    await this.arm();
  }

  /**
   * `check_run` `rerequested` for the app's check: the job of that check is queued again, with a new
   * check run, when its commit is still its open PR's head. A job still queued or running is left as is.
   */
  async onRerequest(p: ReviewOf, e: { check_run: number; sha: string; prs: number[] }): Promise<{ queued: boolean }> {
    this.bind(p);
    const j = this.sql.exec("SELECT * FROM jobs WHERE check_run = ?", e.check_run).toArray()[0]
      ?? (e.prs.length
        ? this.sql.exec(`SELECT * FROM jobs WHERE sha = ? AND pr IN (${e.prs.map(() => "?").join(",")}) ORDER BY updated_ms DESC`, e.sha, ...e.prs).toArray()[0]
        : undefined);
    if (!j) return { queued: false };
    const head = this.sql.exec("SELECT sha, open FROM prs WHERE pr = ?", j.pr).toArray()[0];
    if (!head || head.open !== 1 || head.sha !== j.sha) return { queued: false };
    // Waiting for approval, or dismissed: only the owner's approval starts it (`requeue` isn't in their
    // rows of the table, and refuses any job whose head needs approval it never got).
    if (j.state === "queued" || j.state === "running") return { queued: false };
    const queued = this.requeue(j.pr as number, j.sha as string);
    await this.arm();
    return { queued };
  }

  /**
   * Move a job by `event` (src/review-job.ts), from the state its row had when read: written only if the
   * table allows it and the row is still in that state (another step may have moved it meanwhile).
   * Every change of a job's state goes through here. Answers the new state, or null for no move.
   */
  private move(pr: number, sha: string, from: JobState, event: JobEvent): JobState | null {
    const t = jobTransition(from, event);
    if (!t.ok) return null;
    const moved = this.sql.exec("UPDATE jobs SET state = ?, updated_ms = ? WHERE pr = ? AND sha = ? AND state = ?", t.to, Date.now(), pr, sha, from).rowsWritten;
    return moved ? t.to : null;
  }

  /** Queue an ended job again from scratch: a new check run, new reviewers, no verdict. */
  private requeue(pr: number, sha: string): boolean {
    const j = this.jobRow(pr, sha);
    // Never a head that needs the owner's approval and hasn't had it, whatever state its job is in.
    if (!j || (j.needs_approval === 1 && j.approved_ms === null)) return false;
    if (!this.move(pr, sha, j.state as JobState, "requeue")) return false;
    this.reset(pr, sha);
    return true;
  }

  /** A job starting over (queued, or held): a new check run, new reviewers, no verdict, due now. */
  private reset(pr: number, sha: string): void {
    this.sql.exec(
      `UPDATE jobs SET next_ms = ?, agent = NULL, check_run = NULL, briefed = 0, verdict = NULL, tainted = NULL,
        attempts = 0, errors = 0, error = NULL, deadline_ms = NULL WHERE pr = ? AND sha = ?`,
      Date.now(), pr, sha,
    );
  }

  /**
   * End a job in one step, by `event` (verdict, give_up, refused, superseded, closed): its check's
   * completion and its reviewer's stop are owed, once, only if the job moved (an ended job doesn't end again).
   */
  private end(j: Row, event: Extract<JobEvent, "verdict" | "give_up" | "refused" | "superseded" | "closed" | "dismiss">, conclusion: Conclusion, output: CheckOutput, error?: string): void {
    const state = this.move(j.pr as number, j.sha as string, j.state as JobState, event);
    if (!state) return;
    this.sql.exec("UPDATE jobs SET next_ms = NULL, deadline_ms = NULL, error = COALESCE(?, error) WHERE pr = ? AND sha = ?", error ?? null, j.pr, j.sha);
    // A held job's check is complete already ("waiting for approval"): only the owner's dismissal rewrites
    // it, so a stranger's pushes and closes cost no calls to GitHub beyond the one check per interval.
    if (j.check_run !== null && ((j.state !== "held" && j.state !== "overflow") || event === "dismiss")) this.oweCheck(j.check_run as number, { status: "completed", conclusion, completed_at: new Date().toISOString(), output });
    if (j.agent !== null) this.oweStop(j.agent as string, state);
    // A review that finished (or failed for good) is owed to the project's waits; superseded and closed aren't ends of the PR's review.
    if (state === "done" || state === "failed") {
      this.sql.exec("INSERT OR REPLACE INTO ended (pr, sha, state, conclusion, next_ms) VALUES (?, ?, ?, ?, ?)", j.pr, j.sha, state, conclusion, Date.now());
    }
  }

  private oweCheck(checkRun: number, body: CheckRunUpdate): void {
    this.sql.exec(
      "INSERT INTO check_updates (check_run, body, next_ms) VALUES (?, ?, ?) ON CONFLICT (check_run) DO UPDATE SET body = excluded.body, next_ms = excluded.next_ms, attempts = 0, error = NULL",
      checkRun, JSON.stringify(body), Date.now(),
    );
  }

  private oweStop(agent: string, reason: string): void {
    this.sql.exec("INSERT OR IGNORE INTO stops (agent, reason, next_ms) VALUES (?, ?, ?)", agent, reason, Date.now());
  }

  /** nest's `agent.exited` for a reviewer: without a verdict, it's started again, up to MAX_RETRIES times. */
  async onAgentExited(agent: string, reason?: string): Promise<void> {
    // Gone, by nest's word: a stop of it that nest refused has nothing left to stop.
    this.sql.exec("DELETE FROM stops WHERE agent = ? AND failed_ms IS NOT NULL", agent);
    const j = this.sql.exec("SELECT * FROM jobs WHERE agent = ?", agent).toArray()[0];
    // No job names it yet: kept for the job's start, which learns it from the create's answer.
    if (!j) this.sql.exec("INSERT OR IGNORE INTO early_exits (agent, reason, at_ms) VALUES (?, ?, ?)", agent, reason ?? null, Date.now());
    if (!j || j.state !== "running" || j.verdict !== null) return;
    this.spendAttempt(j, `the reviewer exited without a verdict (${(reason ?? "exited").slice(0, 100)})`, "exited");
    await this.arm();
  }

  /**
   * A running job's reviewer ended without a verdict (it exited, or its deadline passed): its agent is
   * stopped with its sandbox, and a new reviewer starts, up to MAX_RETRIES times; then the job fails, its
   * check completed as `action_required` with the reason. The slot frees either way.
   */
  private spendAttempt(j: Row, why: string, what: "exited" | "timed out"): void {
    if (j.agent !== null) this.oweStop(j.agent as string, what);
    const attempts = (j.attempts as number) + 1;
    if (attempts <= MAX_RETRIES) {
      if (!this.move(j.pr as number, j.sha as string, "running", "retry")) return;
      const next = Date.now() + backoff(attempts);
      this.sql.exec(
        "UPDATE jobs SET attempts = ?, agent = NULL, briefed = 0, runs = runs + 1, next_ms = ?, deadline_ms = ?, error = ? WHERE pr = ? AND sha = ?",
        attempts, next, next + REVIEW_DEADLINE_MS, why, j.pr, j.sha,
      );
    } else {
      this.sql.exec("UPDATE jobs SET attempts = ? WHERE pr = ? AND sha = ?", attempts, j.pr, j.sha);
      this.end({ ...j, agent: null }, "give_up", NO_VERDICT, {
        title: "No verdict",
        summary: `${attempts} reviewers ended without submitting a verdict (the last: ${why}). Re-run this check to review the commit again.`,
      }, why);
    }
  }

  // --- the reviewer's tools --------------------------------------------------------------------------

  /**
   * One `tools/call` on /mcp/review (src/mcp.ts checked the identity and the role). The scope is the
   * caller's labels: its `project`, `pr` and `sha` name its job, and only the job's current reviewer
   * may submit, once. A retried write with the caller's own call key gets the first answer.
   */
  async mcpCall(caller: AgentCaller, tool: string, args: Record<string, unknown>, callKey: string | null): Promise<{ result: string | null; error: string | null }> {
    const def = toolOf("review", tool);
    if (!def) return { result: null, error: `unknown tool ${tool}` };
    const bad = invalid(def.inputSchema, args);
    if (bad) return { result: null, error: bad };
    if (this.setting("project") === null || caller.labels.project !== this.setting("project")) return { result: null, error: "unknown project" };
    const key = !def.readOnly && callKey && callKey.startsWith(`${caller.agent}/`) ? callKey : null;
    if (key) {
      const prior = this.sql.exec<{ result: string }>("SELECT result FROM mcp_calls WHERE key = ?", key).toArray()[0];
      if (prior) return JSON.parse(prior.result) as { result: string | null; error: string | null };
    }
    const r = await this.runTool(caller, tool, args);
    const out = r.ok ? { result: JSON.stringify(r.value), error: null } : { result: null, error: r.error };
    if (key) {
      this.sql.exec("INSERT OR REPLACE INTO mcp_calls (key, result, at_ms) VALUES (?, ?, ?)", key, JSON.stringify(out), Date.now());
      this.sql.exec("DELETE FROM mcp_calls WHERE at_ms < ?", Date.now() - CALLS_KEEP_MS);
    }
    return out;
  }

  private async runTool(caller: AgentCaller, tool: string, a: Record<string, unknown>): Promise<Result<unknown>> {
    const { pr, sha } = caller.labels;
    const r = pr && /^[1-9][0-9]{0,9}$/.test(pr) && sha ? this.jobRow(Number(pr), sha) : undefined;
    if (!r) return fail(404, "no review for your PR and commit");
    switch (tool) {
      case "review_get":
        return ok({ repo: this.setting("repo"), pr: r.pr, sha: r.sha, base: r.base, title: r.title, state: r.state });
      case "submit_review": {
        if (r.agent !== caller.agent) return fail(403, "you aren't this review's reviewer");
        if (r.verdict !== null) return fail(409, "this review already has its verdict");
        if (r.state !== "running") return fail(409, `this review is ${r.state}`);
        const v = a as unknown as Verdict;
        const verdict: Verdict = {
          correctness: { verdict: v.correctness.verdict, notes: v.correctness.notes },
          quality: { verdict: v.quality.verdict, notes: v.quality.notes },
          architecture: { verdict: v.architecture.verdict, notes: v.architecture.notes },
          summary: v.summary,
        };
        const check = verdictCheck(verdict, { agent: caller.agent, tainted: caller.tainted });
        this.sql.exec("UPDATE jobs SET verdict = ?, tainted = ? WHERE pr = ? AND sha = ?", JSON.stringify(verdict), caller.tainted ? 1 : 0, r.pr, r.sha);
        this.end(r, "verdict", check.conclusion, check.output);
        await this.arm();
        return ok({ recorded: true, conclusion: check.conclusion });
      }
    }
    return fail(400, `unknown tool ${tool}`);
  }

  // --- work owed to GitHub and nest ------------------------------------------------------------------

  private underCap(): boolean {
    const cap = this.cap();
    return cap === null || this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE state = 'running'").one().n < cap;
  }

  /** Arm the alarm for the earliest work owed. Queued jobs count only while there's room for one. */
  private async arm(): Promise<void> {
    // Two queries: the platform's SQLite caps the terms of one compound SELECT.
    const first = this.sql.exec<{ t: number | null }>(
      `SELECT MIN(t) AS t FROM (
        SELECT next_ms AS t FROM jobs WHERE state IN ('running', 'held', 'overflow') AND next_ms IS NOT NULL
        UNION ALL SELECT next_ms FROM jobs WHERE state = 'queued' AND next_ms IS NOT NULL AND ? = 1
        UNION ALL SELECT next_ms FROM check_updates
        UNION ALL SELECT next_ms FROM stops WHERE failed_ms IS NULL
        UNION ALL SELECT next_ms FROM ended)`,
      this.underCap() ? 1 : 0,
    ).one().t;
    // A running job's deadline (src/review-job.ts).
    const deadline = this.sql.exec<{ t: number | null }>("SELECT MIN(deadline_ms) AS t FROM jobs WHERE state = 'running' AND deadline_ms IS NOT NULL").one().t;
    const times = [first, deadline].filter((t): t is number => t !== null);
    const next = times.length ? Math.min(...times) : null;
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || next < cur) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  override async alarm(): Promise<void> {
    await this.drain();
    await this.arm();
  }

  /** Do the work that is due; one run at a time (a call while one runs makes it go round once more). */
  async drain(): Promise<void> {
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = (async () => {
      try {
        do {
          this.again = false;
          await this.drainOnce();
        } while (this.again);
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  /**
   * Ended jobs older than REVIEW_JOBS_KEEP_MS (a dismissed one among them; never one still waiting for
   * approval), except an open PR's current head's (a re-run of its check, or the owner's change of mind,
   * needs it), and early exits no start claimed (src/retention.ts).
   */
  prune(now: number): void {
    this.prunedMs = now;
    this.sql.exec(
      `DELETE FROM jobs WHERE state IN ('done', 'failed', 'superseded', 'closed', 'dismissed') AND updated_ms < ?
        AND NOT EXISTS (SELECT 1 FROM prs WHERE prs.pr = jobs.pr AND prs.sha = jobs.sha AND prs.open = 1)
        AND NOT EXISTS (SELECT 1 FROM check_updates c WHERE c.check_run = jobs.check_run)`,
      now - REVIEW_JOBS_KEEP_MS,
    );
    this.sql.exec("DELETE FROM early_exits WHERE at_ms < ?", now - EARLY_EXITS_KEEP_MS);
  }

  private async drainOnce(): Promise<void> {
    if (Date.now() - this.prunedMs >= PRUNE_EVERY_MS) this.prune(Date.now());
    // Ended reviews to the project (nothing of nest's or GitHub's needed): each until ProjectDO took it.
    const project = this.setting("project");
    for (const e of project ? this.sql.exec("SELECT * FROM ended WHERE next_ms <= ?", Date.now()).toArray() : []) {
      try {
        await projectStub(this.env, project!).onReviewEnded({ pr: e.pr as number, sha: e.sha as string, state: e.state as string, conclusion: (e.conclusion as string | null) ?? null });
        this.sql.exec("DELETE FROM ended WHERE pr = ? AND sha = ? AND state = ?", e.pr, e.sha, e.state);
      } catch (err) {
        const st = this.failedStep(e, err, false, OUTBOX.review_ended);
        if (st && st.next_ms !== null) {
          this.sql.exec("UPDATE ended SET next_ms = ?, attempts = ?, error = ? WHERE pr = ? AND sha = ? AND state = ?", st.next_ms, st.attempts, st.error, e.pr, e.sha, e.state);
        } else if (st) {
          // Given up: said on the job. A manager's wait on this review ends by its own timeout.
          this.sql.exec("DELETE FROM ended WHERE pr = ? AND sha = ? AND state = ?", e.pr, e.sha, e.state);
          this.sql.exec("UPDATE jobs SET error = ? WHERE pr = ? AND sha = ?", `the project wasn't told this review ended, after ${st.attempts} tries: ${st.error}`, e.pr, e.sha);
        }
      }
    }
    // A running job always has a deadline (one running from before deadlines gets one now); past it, the
    // reviewer's attempt is spent, in one step.
    this.sql.exec("UPDATE jobs SET deadline_ms = ? WHERE state = 'running' AND deadline_ms IS NULL", Date.now() + REVIEW_DEADLINE_MS);
    for (const j of this.sql.exec("SELECT * FROM jobs WHERE state = 'running' AND deadline_ms <= ?", Date.now()).toArray()) {
      this.spendAttempt(j, `no verdict within ${REVIEW_DEADLINE_MS / 60_000} minutes`, "timed out");
    }
    const nest = nestFrom(this.env);
    const repo = this.setting("repo");
    if (!nest || !repo) return;
    // One token per run, minted when first needed (nest caches it besides).
    let gh: Promise<GitHub> | null = null;
    const github = () => (gh ??= githubFor(nest, repo, PERMISSIONS.checks));
    const now = Date.now();
    for (const r of this.sql.exec("SELECT check_run FROM check_updates WHERE next_ms <= ?", now).toArray()) await this.sendCheck(github, repo, r.check_run as number);
    for (const r of this.sql.exec("SELECT agent FROM stops WHERE failed_ms IS NULL AND next_ms <= ?", now).toArray()) await this.stop(nest, r.agent as string);
    // A held job's check: made once, completed at once as needing the owner's approval. Nothing else of it runs.
    for (const h of this.sql.exec("SELECT pr, sha FROM jobs WHERE state IN ('held', 'overflow') AND next_ms IS NOT NULL AND next_ms <= ? ORDER BY created_ms, pr", now).toArray()) {
      await this.heldCheck(github, repo, h.pr as number, h.sha as string);
    }
    // Queued jobs start in order while there's room.
    for (const q of this.sql.exec("SELECT pr, sha FROM jobs WHERE state = 'queued' AND next_ms <= ? ORDER BY created_ms, pr", now).toArray()) {
      if (!this.underCap()) break;
      if (!this.move(q.pr as number, q.sha as string, "queued", "start")) continue;
      this.sql.exec("UPDATE jobs SET runs = runs + 1, agent = NULL, briefed = 0, next_ms = ?, deadline_ms = ? WHERE pr = ? AND sha = ?", now, now + REVIEW_DEADLINE_MS, q.pr, q.sha);
    }
    for (const r of this.sql.exec("SELECT pr, sha FROM jobs WHERE state = 'running' AND next_ms IS NOT NULL AND next_ms <= ? ORDER BY created_ms, pr", now).toArray()) {
      await this.advance(nest, github, repo, r.pr as number, r.sha as string);
    }
    await this.arm();
  }

  /** A running job's next step: its check run, then its reviewer, then the reviewer's brief. */
  private async advance(nest: Nest, github: () => Promise<GitHub>, repo: string, pr: number, sha: string): Promise<void> {
    const before = this.jobRow(pr, sha);
    if (!before || before.state !== "running") return;
    const runs = before.runs as number;
    const project = this.setting("project")!;
    const current = () => {
      const r = this.jobRow(pr, sha);
      return r && r.state === "running" && r.runs === runs ? r : null;
    };
    try {
      if (before.check_run === null) {
        const gh = await github();
        const external = `${project}/${pr}/${sha}/${runs}`;
        // A create whose answer was lost made a check run all the same: found by its external id.
        const found = (before.errors as number) > 0 ? (await gh.checkRunsAt(repo, sha)).find((c) => c.external_id === external) : undefined;
        const made = found ?? (await gh.createCheckRun(repo, {
          head_sha: sha, external_id: external, details_url: `${this.env.PUBLIC_BASE_URL}/projects/${project}`,
          output: { title: "Reviewing", summary: `A reviewer agent is reviewing ${sha}: correctness, quality and architectural cohesiveness.` },
        }))!;
        const appId = made.app?.id;
        if (typeof appId === "number" && this.setting("github_app_id") !== String(appId)) {
          // The App's id, if nest's token answer didn't name it: the project pins its required check to it.
          await directory(this.env).recordGithubAppId(appId);
          await projectStub(this.env, project).appIdLearned(appId);
          this.setSetting("github_app_id", String(appId));
        }
        const after = this.jobRow(pr, sha);
        if (!after || after.state !== "running") {
          // Superseded or closed while the check was being made: it ends at once.
          this.oweCheck(made.id, { status: "completed", conclusion: ENDED, completed_at: new Date().toISOString(), output: { title: "Superseded", summary: "The PR moved on before its review started." } });
          return;
        }
        this.sql.exec("UPDATE jobs SET check_run = ? WHERE pr = ? AND sha = ?", made.id, pr, sha);
      }
      const j0 = current();
      if (!j0) return;
      let agent = (j0.agent as string | null) ?? null;
      if (!agent) {
        const labels = { project, role: "reviewer", pr: String(pr), sha, start: String(runs) };
        const key = `${project}/review/${pr}/${sha}/${runs}`;
        // The project's secrets for reviewers, frozen per attempt (ProjectDO keeps them).
        const spec = await projectStub(this.env, project).reviewerSpec(key);
        agent = await nest.startAgent(TEMPLATE.reviewer, labels, { read: repo }, key, spec.extras);
        if (!current()) {
          this.oweStop(agent, "superseded");
          return;
        }
        // Named on the job in the step the create's answer came, before any other await, so its exit finds it.
        this.sql.exec("UPDATE jobs SET agent = ? WHERE pr = ? AND sha = ?", agent, pr, sha);
        await directory(this.env).recordAgent({ agent, project, role: "reviewer", task: null, pr });
        // Its holdings and live layer: a secret changed or removed later reaches it too.
        await projectStub(this.env, project).reviewerStarted(agent, key);
        // It exited before the job named it: an attempt spent now, as any exit without a verdict.
        const early = this.sql.exec("DELETE FROM early_exits WHERE agent = ? RETURNING reason", agent).toArray()[0];
        if (early) {
          const j = current();
          if (j) this.spendAttempt(j, `the reviewer exited without a verdict (${((early.reason as string | null) ?? "exited").slice(0, 100)})`, "exited");
          return;
        }
        if (!current()) return;
      }
      const j = current()!;
      if (j.briefed !== 1) {
        const spec = await projectStub(this.env, project).reviewerSpec(`${project}/review/${pr}/${sha}/${runs}`);
        await nest.postInbox(agent, reviewerBrief(repo, pr, sha, j.base as string | null) + spec.brief, { requestId: `${project}/review/${pr}/${sha}/${runs}/brief` });
        if (!current()) return;
      }
      this.sql.exec("UPDATE jobs SET briefed = 1, next_ms = NULL, errors = 0, error = NULL, updated_ms = ? WHERE pr = ? AND sha = ?", Date.now(), pr, sha);
    } catch (e) {
      const r = current();
      if (!r) return;
      const st = this.failedStep(r, e, refused(e), OUTBOX.review_steps, "errors");
      if (!st) return;
      if (st.next_ms === null) {
        // Refused for good (the App, the grant, the template): the job fails with the reason shown.
        this.end(r, "refused", NO_VERDICT, { title: "The review couldn't run", summary: message(e) }, message(e));
        return;
      }
      this.sql.exec("UPDATE jobs SET errors = ?, next_ms = ?, error = ? WHERE pr = ? AND sha = ?", st.attempts, st.next_ms, st.error, pr, sha);
    }
  }

  /**
   * A queue row's failed try as the outbox steps it (README.md#outboxes): due again with backoff, or
   * failed (`next_ms` null: refused for good, or out of the queue's attempts). Null for a row that
   * wasn't being sent.
   */
  private failedStep(r: Row, e: unknown, permanent: boolean, policy: OutboxPolicy, attempts: "attempts" | "errors" = "attempts"): OutboxRow | null {
    const st = outboxStep(outboxRow(r, attempts), { kind: "failed", error: message(e), permanent }, Date.now(), policy);
    return st.ok ? st.row : null;
  }

  /**
   * A held (or overflow) job's check run, saying why no review runs: retried with backoff; a refusal for
   * good is shown on the job. Made before the job can start: drains run one at a time, and a job approved
   * while this one's call is out starts (and makes the review's own check) only after it returns, so the
   * commit's latest check is always the review's.
   */
  private async heldCheck(github: () => Promise<GitHub>, repo: string, pr: number, sha: string): Promise<void> {
    const before = this.jobRow(pr, sha);
    if (!before || (before.state !== "held" && before.state !== "overflow")) return;
    const waiting = "state IN ('held', 'overflow')";
    const output = before.state === "held" ? HELD_OUTPUT : OVERFLOW_OUTPUT;
    const project = this.setting("project")!;
    // At most one held check per PR per interval: a head pushed sooner waits its turn (or is superseded first).
    const last = (this.sql.exec("SELECT held_check_ms FROM prs WHERE pr = ?", pr).toArray()[0]?.held_check_ms as number | null | undefined) ?? null;
    if (before.check_run === null && last !== null && Date.now() < last + HELD_CHECK_INTERVAL_MS) {
      this.sql.exec(`UPDATE jobs SET next_ms = ? WHERE pr = ? AND sha = ? AND ${waiting}`, last + HELD_CHECK_INTERVAL_MS, pr, sha);
      return;
    }
    try {
      if (before.check_run === null) {
        this.sql.exec("UPDATE prs SET held_check_ms = ? WHERE pr = ?", Date.now(), pr);
        const made = (await (await github()).createCheckRun(repo, {
          head_sha: sha, external_id: `${project}/${pr}/${sha}/held`, details_url: `${this.env.PUBLIC_BASE_URL}/projects/${project}/reviews`,
          output,
        }))!;
        const after = this.jobRow(pr, sha);
        if (after && (after.state === "held" || after.state === "overflow") && after.check_run === null) {
          // Still waiting: the check is its job's, saying what it waits for now.
          this.oweCheck(made.id, { status: "completed", conclusion: NO_VERDICT, completed_at: new Date().toISOString(), output: after.state === "held" ? HELD_OUTPUT : OVERFLOW_OUTPUT });
          this.sql.exec(`UPDATE jobs SET check_run = ? WHERE pr = ? AND sha = ? AND ${waiting} AND check_run IS NULL`, made.id, pr, sha);
        } else {
          // Approved, dismissed or ended while the call was out: this check is done with, never a passing one.
          this.oweCheck(made.id, { status: "completed", conclusion: ENDED, completed_at: new Date().toISOString(), output: { title: "No longer waiting", summary: "This commit's review moved on while this check was being made." } });
        }
      }
      this.sql.exec(`UPDATE jobs SET next_ms = NULL, errors = 0, error = NULL WHERE pr = ? AND sha = ? AND ${waiting}`, pr, sha);
    } catch (e) {
      // Failed for good (refused, or out of tries): shown on the job, which waits for the owner all the same.
      const st = this.failedStep(before, e, refused(e), OUTBOX.review_held, "errors");
      if (st) this.sql.exec(`UPDATE jobs SET errors = ?, next_ms = ?, error = ? WHERE pr = ? AND sha = ? AND ${waiting}`, st.attempts, st.next_ms, st.error, pr, sha);
    }
  }

  private async sendCheck(github: () => Promise<GitHub>, repo: string, checkRun: number): Promise<void> {
    const row = this.sql.exec("SELECT body, next_ms, attempts, error FROM check_updates WHERE check_run = ?", checkRun).toArray()[0];
    if (!row) return;
    try {
      await (await github()).updateCheckRun(repo, checkRun, JSON.parse(row.body as string) as CheckRunUpdate);
    } catch (e) {
      const st = this.failedStep(row, e, refused(e), OUTBOX.review_checks);
      if (!st) return;
      if (st.next_ms !== null) {
        // Only the body that was tried: one owed since starts afresh.
        this.sql.exec("UPDATE check_updates SET attempts = ?, next_ms = ?, error = ? WHERE check_run = ? AND body = ?", st.attempts, st.next_ms, st.error, checkRun, row.body);
        return;
      }
      // Failed for good: said on the job, and not tried again.
      this.sql.exec("UPDATE jobs SET error = ? WHERE check_run = ?",
        refused(e) ? `the check's update was refused: ${message(e)}` : `the check's update couldn't be sent, after ${st.attempts} tries: ${message(e)}`, checkRun);
    }
    // Only if it wasn't owed again meanwhile (a newer body replaced this one).
    this.sql.exec("DELETE FROM check_updates WHERE check_run = ? AND body = ?", checkRun, row.body);
  }

  private async stop(nest: Nest, agent: string): Promise<void> {
    const row = this.sql.exec("SELECT reason, next_ms, attempts, error FROM stops WHERE agent = ? AND failed_ms IS NULL", agent).toArray()[0];
    if (!row) return;
    try {
      await nest.stopAgent(agent, { end: true, destroySandbox: true, reason: `review ${row.reason as string}` });
    } catch (e) {
      // Gone already (404): as good as stopped.
      if (!(e instanceof NestError && e.status === 404)) {
        const st = this.failedStep(row, e, stopRefused(e), OUTBOX.review_stops);
        if (!st) return;
        if (st.next_ms !== null) {
          this.sql.exec("UPDATE stops SET attempts = ?, next_ms = ?, error = ? WHERE agent = ?", st.attempts, st.next_ms, st.error, agent);
          return;
        }
        // nest's own refusal: kept, not tried again (until nest says the agent is gone), and said on its job.
        this.sql.exec("UPDATE stops SET attempts = ?, next_ms = ?, error = ?, failed_ms = ? WHERE agent = ?", st.attempts, NOT_DUE_MS, st.error, Date.now(), agent);
        this.sql.exec("UPDATE jobs SET error = ? WHERE agent = ?", `nest refused to stop its reviewer ${agent}, which may still be running: ${st.error}`, agent);
        console.error(`review: nest refused to stop reviewer ${agent} (${row.reason as string}): ${st.error}`);
        return;
      }
    }
    this.sql.exec("DELETE FROM stops WHERE agent = ?", agent);
    // Stopped with its sandbox: no layer left to keep up.
    const project = this.setting("project");
    if (project) await projectStub(this.env, project).agentEnded(agent);
  }
}

const HELD_OUTPUT: CheckOutput = {
  title: "Waiting for the owner's approval",
  summary: "This pull request isn't from someone the project trusts, so its review doesn't start by itself. The project's owner can approve the review of this commit, or dismiss it.",
};

const OVERFLOW_OUTPUT: CheckOutput = {
  title: "Waiting: the project's review queue is full",
  summary: "This pull request isn't from someone the project trusts, and too many such reviews already wait for the owner's approval. It will be listed for the owner once some of those are approved, dismissed or closed.",
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** A branch name the brief may quote; anything else is left to review_get. */
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/;

/**
 * The reviewer's first input: only what the app knows from GitHub's routing (repo, number, head,
 * base), none of the PR's own text, which the reviewer reads itself (and is tainted by).
 */
export function reviewerBrief(repo: string, pr: number, sha: string, base: string | null): string {
  const b = base && SAFE_REF.test(base) ? base : null;
  return [
    `Review PR #${pr} on ${repo} at its head commit ${sha}${b ? `, against its base branch ${b}` : ""}.`,
    `Read it with projects-review review_get. Check it out in your sandbox: \`git fetch origin pull/${pr}/head && git checkout ${sha}\`, and read the diff against the base: \`git diff origin/${b ?? "<base>"}...${sha}\`.`,
    "Judge correctness, quality and architectural cohesiveness, then submit once with submit_review.",
  ].join("\n");
}
