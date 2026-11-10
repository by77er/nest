// DirectoryDO, one instance (README.md#pieces): the projects, repo → project, agent → {project, role,
// task, pr}, the nest events and GitHub deliveries already handled (deduplicated by id), the catalog
// sync's state, and the GitHub App's id once nest's token answer or a check run has told it.

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { CreateProject, REPO } from "../requests";
import { fail, migrate, ok, type Result } from "../sql";
import { type OutboxPolicy, outboxStep, verdict } from "../outbox";
import { type CreateSpec, finishProject } from "../creation";
import type { Role } from "../tools";

export interface ProjectRow {
  id: string;
  name: string;
  repo: string;
  created_ms: number;
  /** `pending` until creating it is finished (README.md#creating-a-project): its routes answer 503 until then. */
  state: "pending" | "ready";
}

/** The last catalog sync that succeeded: what it wrote, for which repos, and when. */
export interface SyncState {
  written: string[];
  repos: string[];
  at_ms: number;
}

/** Where an agent's events go. `project` null: an agent nest told us about that isn't the app's. */
export interface AgentRoute {
  agent: string;
  project: string | null;
  role: Role | null;
  task: string | null;
  pr: number | null;
}

/** How long a handled event's id is kept for deduplication (nest retries for far less). */
const SEEN_KEEP_MS = 7 * 24 * 3600 * 1000;

const MIGRATIONS = [
  [
    "CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL UNIQUE, created_ms INTEGER NOT NULL)",
    "CREATE TABLE agents (agent TEXT PRIMARY KEY, project TEXT, role TEXT, task TEXT, pr INTEGER, recorded_ms INTEGER NOT NULL)",
    "CREATE TABLE seen (id TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)",
    "CREATE INDEX seen_at ON seen (at_ms)",
    "CREATE TABLE sync (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  ],
  [
    // A delivery claimed before it's handled (`claim`) and not yet confirmed done (`markSeen`): a claim
    // whose handler died lapses after CLAIM_LAPSE_MS, so a redelivery is handled.
    "ALTER TABLE seen ADD COLUMN pending INTEGER NOT NULL DEFAULT 0",
  ],
  [
    // A project being created (README.md#creating-a-project): its create's body while pending (null once
    // ready), and when the alarm resumes it, as an outbox row (src/outbox.ts).
    "ALTER TABLE projects ADD COLUMN pending TEXT",
    "ALTER TABLE projects ADD COLUMN next_ms INTEGER",
    "ALTER TABLE projects ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE projects ADD COLUMN error TEXT",
  ],
  [
    // The repo's GitHub id (README.md#built-the-review-pipeline), learned from its first event: events are routed by
    // it, so a repo renamed or transferred keeps its project, and its old name names no project of ours.
    "ALTER TABLE projects ADD COLUMN repo_id INTEGER",
    "CREATE UNIQUE INDEX projects_repo_id ON projects (repo_id) WHERE repo_id IS NOT NULL",
  ],
] as const;

/** How long the Worker has to finish a create before the alarm takes it over. */
export const CREATE_GRACE_MS = 60_000;
/** A create is resumed this many times before the project is removed (its repo free again). */
export const CREATE_POLICY: OutboxPolicy = { maxAttempts: 8 };

const COLUMNS = "id, name, repo, created_ms, CASE WHEN pending IS NULL THEN 'ready' ELSE 'pending' END AS state";

/** How long a claim stays taken without its handler confirming it (`markSeen`). */
export const CLAIM_LAPSE_MS = 5 * 60_000;

export class DirectoryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, MIGRATIONS);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  /**
   * Record a project for `repo` (one project per repo, compared without case), pending until its create is
   * finished (`creationDone`); the alarm takes the create over if the Worker doesn't finish it. The same
   * repo asked for again while pending is that project: its create is resumed, not refused.
   */
  async createProject(r: { name: string; repo: string }, spec?: CreateSpec): Promise<Result<ProjectRow>> {
    if (!REPO.test(r.repo) || /\.git$/i.test(r.repo)) return fail(400, "repo is owner/name");
    const repo = r.repo.toLowerCase();
    const taken = this.sql.exec<ProjectRow & Record<string, SqlStorageValue>>(`SELECT ${COLUMNS} FROM projects WHERE repo = ?`, repo).toArray()[0];
    if (taken?.state === "pending") return ok(taken);
    if (taken) return fail(409, `${repo} is already project ${taken.id}`);
    const row: ProjectRow = { id: `prj_${randomId()}`, name: r.name, repo, created_ms: Date.now(), state: "pending" };
    const due = Date.now() + CREATE_GRACE_MS;
    this.sql.exec("INSERT INTO projects (id, name, repo, created_ms, pending, next_ms) VALUES (?, ?, ?, ?, ?, ?)",
      row.id, row.name, row.repo, row.created_ms, JSON.stringify(spec ?? { name: r.name, repo }), due);
    await this.armCreates();
    return ok(row);
  }

  /** The create is finished: the project is ready. */
  async creationDone(id: string): Promise<void> {
    this.sql.exec("UPDATE projects SET pending = NULL, next_ms = NULL, error = NULL WHERE id = ?", id);
  }

  /**
   * A step of the create failed (the Worker's or the alarm's run): resumed later with backoff; one that
   * will fail again, or past CREATE_POLICY's attempts, removes the project, so its repo is free again.
   * Answers whether it's still pending.
   */
  async creationFailed(id: string, e: { error: string; permanent: boolean }): Promise<boolean> {
    const r = this.sql.exec("SELECT next_ms, attempts, error FROM projects WHERE id = ? AND pending IS NOT NULL", id).toArray()[0];
    if (!r) return false;
    const st = outboxStep({ next_ms: (r.next_ms as number | null) ?? Date.now(), attempts: r.attempts as number, error: (r.error as string | null) ?? null }, { kind: "failed", ...e }, Date.now(), CREATE_POLICY);
    if (!st.ok || st.state === "failed") {
      console.error(`project ${id}: its create couldn't be finished, removed: ${e.error}`);
      this.sql.exec("DELETE FROM projects WHERE id = ? AND pending IS NOT NULL", id);
      return false;
    }
    this.sql.exec("UPDATE projects SET next_ms = ?, attempts = ?, error = ? WHERE id = ?", st.row.next_ms, st.row.attempts, st.row.error, id);
    await this.armCreates();
    return true;
  }

  private async armCreates(): Promise<void> {
    const next = this.sql.exec<{ t: number | null }>("SELECT MIN(next_ms) AS t FROM projects WHERE pending IS NOT NULL").one().t;
    if (next === null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || next < cur) await this.ctx.storage.setAlarm(Math.max(next, Date.now()));
  }

  /** Resume each create that's due: the Worker's request failed, or died, before finishing it. */
  override async alarm(): Promise<void> {
    for (const r of this.sql.exec("SELECT id, name, repo, created_ms, pending FROM projects WHERE pending IS NOT NULL AND next_ms <= ?", Date.now()).toArray()) {
      const row: ProjectRow = { id: r.id as string, name: r.name as string, repo: r.repo as string, created_ms: r.created_ms as number, state: "pending" };
      let spec: CreateSpec;
      try {
        spec = CreateProject.parse(JSON.parse(r.pending as string));
      } catch (e) {
        await this.creationFailed(row.id, { error: `its create can't be read: ${verdict(e).error}`, permanent: true });
        continue;
      }
      try {
        await finishProject(this.env, row, spec);
      } catch (e) {
        await this.creationFailed(row.id, verdict(e));
      }
    }
    await this.armCreates();
  }

  async projects(): Promise<ProjectRow[]> {
    return this.sql.exec<ProjectRow & Record<string, SqlStorageValue>>(`SELECT ${COLUMNS} FROM projects ORDER BY created_ms`).toArray();
  }

  async getProject(id: string): Promise<ProjectRow | null> {
    return this.sql.exec<ProjectRow & Record<string, SqlStorageValue>>(`SELECT ${COLUMNS} FROM projects WHERE id = ?`, id).toArray()[0] ?? null;
  }

  /**
   * The project a GitHub event's repo belongs to (README.md#built-the-review-pipeline): by the repo's id, whatever it's
   * named now. A project with no id yet is found by the name it was created with, and takes the event's
   * id from then on. A name whose project has another id is another repo's now (ours was renamed, and the
   * name taken): no project.
   */
  async projectForRepo(repoId: number | null, name: string | null): Promise<ProjectRow | null> {
    const one = (where: string, v: SqlStorageValue) =>
      this.sql.exec<ProjectRow & Record<string, SqlStorageValue>>(`SELECT ${COLUMNS} FROM projects WHERE ${where}`, v).toArray()[0] ?? null;
    if (repoId !== null) {
      const byId = one("repo_id = ?", repoId);
      if (byId) return byId;
    }
    const byName = name ? one("repo = ? AND repo_id IS NULL", name.toLowerCase()) : null;
    if (byName && repoId !== null) this.sql.exec("UPDATE projects SET repo_id = ? WHERE id = ? AND repo_id IS NULL", repoId, byName.id);
    return byName;
  }

  /** nest's GitHub App's id, as nest's token answer (`app_id`) or a check run it made (`app.id`) last told it; null until one has. */
  async githubAppId(): Promise<number | null> {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM sync WHERE k = 'github_app_id'").toArray()[0];
    return row ? Number(row.v) : null;
  }

  async recordGithubAppId(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    this.sql.exec("INSERT INTO sync (k, v) VALUES ('github_app_id', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(id));
  }

  /** The GitHub id of nest's App's bot account (`<slug>[bot]`), the author of workers' PRs; null until looked up (src/github.ts `appBotId`). */
  async githubAppBotId(): Promise<number | null> {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM sync WHERE k = 'github_app_bot_id'").toArray()[0];
    return row ? Number(row.v) : null;
  }

  async recordGithubAppBotId(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) return;
    this.sql.exec("INSERT INTO sync (k, v) VALUES ('github_app_bot_id', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", String(id));
  }

  /** Every project's repo: what the role templates may push to. */
  async repos(): Promise<string[]> {
    return this.sql.exec<{ repo: string }>("SELECT repo FROM projects ORDER BY repo").toArray().map((r) => r.repo);
  }

  /** An agent the app created, or (project null) one it learned isn't its own. */
  async recordAgent(r: AgentRoute): Promise<void> {
    this.sql.exec(
      "INSERT INTO agents (agent, project, role, task, pr, recorded_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent) DO UPDATE SET project = excluded.project, role = excluded.role, task = excluded.task, pr = excluded.pr",
      r.agent, r.project, r.role, r.task, r.pr, Date.now(),
    );
  }

  /** Where an agent's events go; undefined when the app has never heard of it. */
  async route(agent: string): Promise<AgentRoute | undefined> {
    return this.sql.exec<AgentRoute & Record<string, SqlStorageValue>>("SELECT agent, project, role, task, pr FROM agents WHERE agent = ?", agent).toArray()[0];
  }

  async seen(id: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM seen WHERE id = ?", id).toArray().length > 0;
  }

  /**
   * Claim an event before handling it, in one step: true the first time, false for a copy (so two
   * concurrent deliveries of one id never both act). `release` undoes a claim whose handling failed.
   */
  async claim(id: string): Promise<boolean> {
    const now = Date.now();
    this.sql.exec("DELETE FROM seen WHERE at_ms < ?", now - SEEN_KEEP_MS);
    // New, or a claim that lapsed (its handler never confirmed it): taken now.
    return this.sql.exec(
      `INSERT INTO seen (id, at_ms, pending) VALUES (?, ?, 1)
        ON CONFLICT (id) DO UPDATE SET at_ms = excluded.at_ms WHERE pending = 1 AND at_ms < ? RETURNING id`,
      id, now, now - CLAIM_LAPSE_MS,
    ).toArray().length > 0;
  }

  async release(id: string): Promise<void> {
    this.sql.exec("DELETE FROM seen WHERE id = ?", id);
  }

  /** Mark an event handled (after it was), and forget the ones older than the window. */
  async markSeen(id: string): Promise<void> {
    const now = Date.now();
    this.sql.exec("INSERT INTO seen (id, at_ms) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET pending = 0", id, now);
    this.sql.exec("DELETE FROM seen WHERE at_ms < ?", now - SEEN_KEEP_MS);
  }

  async recordSync(v: { written: string[]; repos: string[] }): Promise<void> {
    this.sql.exec("INSERT INTO sync (k, v) VALUES ('last', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", JSON.stringify({ ...v, at_ms: Date.now() }));
  }

  async lastSync(): Promise<SyncState | null> {
    const row = this.sql.exec<{ v: string }>("SELECT v FROM sync WHERE k = 'last'").toArray()[0];
    return row ? JSON.parse(row.v) : null;
  }
}

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 16);
}
