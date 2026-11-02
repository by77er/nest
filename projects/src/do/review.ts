// ReviewDO, one per project (README.md#built-the-review-pipeline): the review queue, one job per PR head, with its check
// run, its reviewer agent and its verdict. An asynchronous process of its own: GitHub's events and the
// reviewer's tools only record what happened (one synchronous step on SQLite that arms the alarm); the
// alarm does the calls to GitHub and nest, retried from 5 s doubling to 5 min, and re-reads the job
// after each, since other requests run while one awaits.
//
// A job's states: `queued` (waiting for its turn, under `max_concurrent_reviews`), `running` (its check
// run, reviewer and brief are made in turn, then it waits for the verdict), and how it ended: `done`
// (a verdict), `failed` (no verdict after retries, or refused for good), `superseded` (a newer head) or
// `closed` (the PR closed). Each end owes GitHub its check's completion and nest the reviewer's stop.

import { DurableObject } from "cloudflare:workers";
import { TEMPLATE } from "../catalog";
import { directory, type Env, project as projectStub } from "../env";
import { type CheckOutput, type CheckRunUpdate, type Conclusion, type GitHub, GitHubError, githubFor, PERMISSIONS, type Verdict, verdictCheck } from "../github";
import type { AgentCaller } from "../identity";
import { backoff, NestError, nestFrom, type Nest } from "../nest";
import { invalid } from "../schema";
import { fail, migrate, ok, type Result } from "../sql";
import { toolOf } from "../tools";

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

export type JobState = "queued" | "running" | "done" | "failed" | "superseded" | "closed";

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
  created_ms: number;
  updated_ms: number;
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
] as const;

type Row = Record<string, SqlStorageValue>;

export class ReviewDO extends DurableObject<Env> {
  private draining: Promise<void> | null = null;
  private again = false;

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
      created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
    };
  }

  /** The queue's jobs, newest first. */
  async jobs(): Promise<Job[]> {
    return this.sql.exec("SELECT * FROM jobs ORDER BY created_ms DESC, pr DESC LIMIT 100").toArray().map((r) => this.toJob(r));
  }

  /**
   * A PR's head, from `pull_request` `opened`, `reopened` or `synchronize`: its job is queued, and the
   * jobs of the PR's older heads end (superseded), their reviewers stopped and their checks cancelled.
   * An event older than the last one heard for the PR is ignored, since GitHub doesn't order deliveries.
   */
  async onHead(p: ReviewOf, e: { pr: number; sha: string; base: string; title: string; updated_at: string }): Promise<{ queued: boolean }> {
    this.bind(p);
    const prev = this.sql.exec("SELECT updated_at FROM prs WHERE pr = ?", e.pr).toArray()[0];
    if (prev && e.updated_at < (prev.updated_at as string)) return { queued: false };
    this.sql.exec(
      "INSERT INTO prs (pr, sha, base, title, updated_at, open) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (pr) DO UPDATE SET sha = excluded.sha, base = excluded.base, title = excluded.title, updated_at = excluded.updated_at, open = 1",
      e.pr, e.sha, e.base, e.title, e.updated_at,
    );
    for (const old of this.sql.exec("SELECT * FROM jobs WHERE pr = ? AND sha != ? AND state IN ('queued', 'running')", e.pr, e.sha).toArray()) {
      this.end(old, "superseded", ENDED, { title: "Superseded", summary: `A newer commit, ${e.sha}, was pushed to the PR; it gets its own review.` });
    }
    const now = Date.now();
    const j = this.jobRow(e.pr, e.sha);
    let queued = false;
    if (!j) {
      this.sql.exec("INSERT INTO jobs (pr, sha, state, title, base, next_ms, created_ms, updated_ms) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)", e.pr, e.sha, e.title, e.base, now, now, now);
      queued = true;
    } else {
      this.sql.exec("UPDATE jobs SET title = ?, base = ? WHERE pr = ? AND sha = ?", e.title, e.base, e.pr, e.sha);
      // The head moved back to a commit whose job ended, or the PR was reopened: reviewed again.
      if (j.state === "superseded" || j.state === "closed") {
        this.requeue(e.pr, e.sha);
        queued = true;
      }
    }
    await this.arm();
    return { queued };
  }

  /** `pull_request` `closed`: the PR's running and queued jobs end. */
  async onClosed(p: ReviewOf, e: { pr: number; updated_at: string }): Promise<void> {
    this.bind(p);
    const prev = this.sql.exec("SELECT updated_at FROM prs WHERE pr = ?", e.pr).toArray()[0];
    if (prev && e.updated_at < (prev.updated_at as string)) return;
    this.sql.exec("UPDATE prs SET open = 0, updated_at = ? WHERE pr = ?", e.updated_at, e.pr);
    for (const j of this.sql.exec("SELECT * FROM jobs WHERE pr = ? AND state IN ('queued', 'running')", e.pr).toArray()) {
      this.end(j, "closed", ENDED, { title: "PR closed", summary: "The PR was closed before its review finished." });
    }
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
    if (j.state === "queued" || j.state === "running") return { queued: false };
    this.requeue(j.pr as number, j.sha as string);
    await this.arm();
    return { queued: true };
  }

  /** Queue an ended job again from scratch: a new check run, new reviewers, no verdict. */
  private requeue(pr: number, sha: string): void {
    this.sql.exec(
      `UPDATE jobs SET state = 'queued', next_ms = ?, agent = NULL, check_run = NULL, briefed = 0, verdict = NULL, tainted = NULL,
        attempts = 0, errors = 0, error = NULL, updated_ms = ? WHERE pr = ? AND sha = ?`,
      Date.now(), Date.now(), pr, sha,
    );
  }

  /** End a job in one step: its check's completion and its reviewer's stop are owed. */
  private end(j: Row, state: Exclude<JobState, "queued" | "running">, conclusion: Conclusion, output: CheckOutput, error?: string): void {
    this.sql.exec("UPDATE jobs SET state = ?, next_ms = NULL, error = COALESCE(?, error), updated_ms = ? WHERE pr = ? AND sha = ?", state, error ?? null, Date.now(), j.pr, j.sha);
    if (j.check_run !== null) this.oweCheck(j.check_run as number, { status: "completed", conclusion, completed_at: new Date().toISOString(), output });
    if (j.agent !== null) this.oweStop(j.agent as string, state);
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
    const j = this.sql.exec("SELECT * FROM jobs WHERE agent = ?", agent).toArray()[0];
    if (!j || j.state !== "running" || j.verdict !== null) return;
    // Its sandbox goes with it.
    this.oweStop(agent, "exited");
    const attempts = (j.attempts as number) + 1;
    const why = `the reviewer exited without a verdict (${(reason ?? "exited").slice(0, 100)})`;
    if (attempts <= MAX_RETRIES) {
      this.sql.exec(
        "UPDATE jobs SET attempts = ?, agent = NULL, briefed = 0, runs = runs + 1, next_ms = ?, error = ?, updated_ms = ? WHERE pr = ? AND sha = ?",
        attempts, Date.now() + backoff(attempts), why, Date.now(), j.pr, j.sha,
      );
    } else {
      this.sql.exec("UPDATE jobs SET attempts = ? WHERE pr = ? AND sha = ?", attempts, j.pr, j.sha);
      this.end({ ...j, agent: null }, "failed", NO_VERDICT, {
        title: "No verdict",
        summary: `The reviewer exited ${attempts} times without submitting a verdict. Re-run this check to review the commit again.`,
      }, why);
    }
    await this.arm();
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
        this.end(r, "done", check.conclusion, check.output);
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
    const next = this.sql.exec<{ t: number | null }>(
      `SELECT MIN(t) AS t FROM (
        SELECT next_ms AS t FROM jobs WHERE state = 'running' AND next_ms IS NOT NULL
        UNION ALL SELECT next_ms FROM jobs WHERE state = 'queued' AND next_ms IS NOT NULL AND ? = 1
        UNION ALL SELECT next_ms FROM check_updates
        UNION ALL SELECT next_ms FROM stops)`,
      this.underCap() ? 1 : 0,
    ).one().t;
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

  private async drainOnce(): Promise<void> {
    const nest = nestFrom(this.env);
    const repo = this.setting("repo");
    if (!nest || !repo) return;
    // One token per run, minted when first needed (nest caches it besides).
    let gh: Promise<GitHub> | null = null;
    const github = () => (gh ??= githubFor(nest, repo, PERMISSIONS.checks));
    const now = Date.now();
    for (const r of this.sql.exec("SELECT check_run FROM check_updates WHERE next_ms <= ?", now).toArray()) await this.sendCheck(github, repo, r.check_run as number);
    for (const r of this.sql.exec("SELECT agent FROM stops WHERE next_ms <= ?", now).toArray()) await this.stop(nest, r.agent as string);
    // Queued jobs start in order while there's room.
    for (const q of this.sql.exec("SELECT pr, sha FROM jobs WHERE state = 'queued' AND next_ms <= ? ORDER BY created_ms, pr", now).toArray()) {
      if (!this.underCap()) break;
      this.sql.exec("UPDATE jobs SET state = 'running', runs = runs + 1, agent = NULL, briefed = 0, next_ms = ?, updated_ms = ? WHERE pr = ? AND sha = ?", now, now, q.pr, q.sha);
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
        agent = await nest.startAgent(TEMPLATE.reviewer, labels, { read: repo }, `${project}/review/${pr}/${sha}/${runs}`);
        await directory(this.env).recordAgent({ agent, project, role: "reviewer", task: null, pr });
        if (!current()) {
          this.oweStop(agent, "superseded");
          return;
        }
        this.sql.exec("UPDATE jobs SET agent = ? WHERE pr = ? AND sha = ?", agent, pr, sha);
      }
      const j = current()!;
      if (j.briefed !== 1) {
        await nest.postInbox(agent, reviewerBrief(repo, pr, sha, j.base as string | null), { requestId: `${project}/review/${pr}/${sha}/${runs}/brief` });
        if (!current()) return;
      }
      this.sql.exec("UPDATE jobs SET briefed = 1, next_ms = NULL, errors = 0, error = NULL, updated_ms = ? WHERE pr = ? AND sha = ?", Date.now(), pr, sha);
    } catch (e) {
      const r = current();
      if (!r) return;
      if ((e instanceof NestError || e instanceof GitHubError) && e.permanent) {
        // Refused for good (the App, the grant, the template): the job fails with the reason shown.
        this.end(r, "failed", NO_VERDICT, { title: "The review couldn't run", summary: message(e) }, message(e));
        return;
      }
      const errors = (r.errors as number) + 1;
      this.sql.exec("UPDATE jobs SET errors = ?, next_ms = ?, error = ? WHERE pr = ? AND sha = ?", errors, Date.now() + backoff(errors), message(e), pr, sha);
    }
  }

  private async sendCheck(github: () => Promise<GitHub>, repo: string, checkRun: number): Promise<void> {
    const row = this.sql.exec("SELECT body, attempts FROM check_updates WHERE check_run = ?", checkRun).toArray()[0];
    if (!row) return;
    try {
      await (await github()).updateCheckRun(repo, checkRun, JSON.parse(row.body as string) as CheckRunUpdate);
    } catch (e) {
      if (!((e instanceof NestError || e instanceof GitHubError) && e.permanent)) {
        const attempts = (row.attempts as number) + 1;
        this.sql.exec("UPDATE check_updates SET attempts = ?, next_ms = ?, error = ? WHERE check_run = ?", attempts, Date.now() + backoff(attempts), message(e), checkRun);
        return;
      }
      this.sql.exec("UPDATE jobs SET error = ? WHERE check_run = ?", `the check's update was refused: ${message(e)}`, checkRun);
    }
    // Only if it wasn't owed again meanwhile (a newer body replaced this one).
    this.sql.exec("DELETE FROM check_updates WHERE check_run = ? AND body = ?", checkRun, row.body);
  }

  private async stop(nest: Nest, agent: string): Promise<void> {
    const row = this.sql.exec("SELECT reason, attempts FROM stops WHERE agent = ?", agent).toArray()[0];
    if (!row) return;
    try {
      await nest.stopAgent(agent, { end: true, destroySandbox: true, reason: `review ${row.reason as string}` });
    } catch (e) {
      if (!(e instanceof NestError && e.status === 404)) {
        const attempts = (row.attempts as number) + 1;
        this.sql.exec("UPDATE stops SET attempts = ?, next_ms = ?, error = ? WHERE agent = ?", attempts, Date.now() + backoff(attempts), message(e), agent);
        return;
      }
    }
    this.sql.exec("DELETE FROM stops WHERE agent = ?", agent);
  }
}

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
