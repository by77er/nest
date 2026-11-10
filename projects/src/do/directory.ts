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
  [
    // The repo's binding (README.md#the-repos-binding): how its id was learned (`github`: read from GitHub
    // at attach, a sync or the operator's re-read; `event`: from the first event, before ids were read) and
    // when; the name GitHub last gave it, when that isn't the name the project calls it by (a rename not
    // yet applied); and the App installation's id, filled once nest's token answer names it.
    "ALTER TABLE projects ADD COLUMN repo_bound TEXT",
    "ALTER TABLE projects ADD COLUMN repo_bound_ms INTEGER",
    "ALTER TABLE projects ADD COLUMN repo_name TEXT",
    "ALTER TABLE projects ADD COLUMN installation_id INTEGER",
    // Why the last read from GitHub didn't bind it (another project's repo, an id that doesn't match), if it didn't.
    "ALTER TABLE projects ADD COLUMN bind_error TEXT",
  ],
] as const;

/** A project's repo binding (README.md#the-repos-binding), as the Admin page shows it. */
export interface RepoBinding {
  project: string;
  name: string;
  /** The name the project calls the repo by (GitHub, nest's grant, its agents). */
  repo: string;
  repo_id: number | null;
  /** The name GitHub last gave the repo, when it isn't `repo`: renamed or transferred, not yet applied. */
  renamed_to: string | null;
  /** The App installation's id: null until nest's token answer names it. */
  installation_id: number | null;
  /** How the id was learned: read from GitHub, or taken from the first event; null while there's none. */
  bound: "github" | "event" | null;
  bound_ms: number | null;
  /** Why the last read from GitHub didn't bind it, if it didn't. */
  error: string | null;
}

/** What `bindRepo` did with what GitHub answered. */
export type BindOutcome =
  | { ok: true; binding: RepoBinding; changed: boolean; previous_id: number | null }
  | { ok: false; error: string; binding: RepoBinding | null };

/** How long the Worker has to finish a create before the alarm takes it over. */
export const CREATE_GRACE_MS = 60_000;
/** A create is resumed this many times before the project is removed (its repo free again). */
export const CREATE_POLICY: OutboxPolicy = { maxAttempts: 8 };

const COLUMNS = "id, name, repo, created_ms, CASE WHEN pending IS NULL THEN 'ready' ELSE 'pending' END AS state";
const BINDING = "id, name, repo, repo_id, repo_name, installation_id, repo_bound, repo_bound_ms, bind_error";

function bindingOf(r: Record<string, SqlStorageValue>): RepoBinding {
  return {
    project: r.id as string, name: r.name as string, repo: r.repo as string, repo_id: (r.repo_id as number | null) ?? null,
    renamed_to: (r.repo_name as string | null) ?? null, installation_id: (r.installation_id as number | null) ?? null,
    bound: (r.repo_bound as "github" | "event" | null) ?? null, bound_ms: (r.repo_bound_ms as number | null) ?? null,
    error: (r.bind_error as string | null) ?? null,
  };
}

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
      if (byId) {
        // The name GitHub gives it now: a rename or transfer is noted (README.md#the-repos-binding).
        if (name) this.noteName(byId.id, name);
        return byId;
      }
    }
    const byName = name ? one("repo = ? AND repo_id IS NULL", name.toLowerCase()) : null;
    if (byName && repoId !== null) {
      this.sql.exec("UPDATE projects SET repo_id = ?, repo_bound = 'event', repo_bound_ms = ? WHERE id = ? AND repo_id IS NULL", repoId, Date.now(), byName.id);
    }
    return byName;
  }

  /**
   * The name GitHub gives the repo now, from an event routed by its id: kept when it isn't the name the
   * project calls it by (renamed or transferred; applied by a sync or the operator's re-read, once nest's
   * grant names it), cleared when it is again.
   */
  private noteName(project: string, name: string): void {
    const n = name.toLowerCase();
    if (!REPO.test(n)) return;
    this.sql.exec("UPDATE projects SET repo_name = CASE WHEN repo = ? THEN NULL ELSE ? END WHERE id = ? AND repo_id IS NOT NULL", n, n, project);
  }

  /** Each project's repo binding, oldest project first. */
  async bindings(): Promise<RepoBinding[]> {
    return this.sql.exec(`SELECT ${BINDING} FROM projects WHERE pending IS NULL ORDER BY created_ms`).toArray().map(bindingOf);
  }

  async binding(project: string): Promise<RepoBinding | null> {
    const r = this.sql.exec(`SELECT ${BINDING} FROM projects WHERE id = ?`, project).toArray()[0];
    return r ? bindingOf(r) : null;
  }

  /**
   * Bind the project to the repo GitHub answered (`id`, and its name now). `fill` (attach, a sync) sets an
   * id only where there's none, and confirms one that matches; `replace` (the operator's re-read) sets it
   * whatever it was. Never an id another project holds. The name is kept as `renamed_to` when it isn't the
   * project's.
   */
  async bindRepo(project: string, gh: { id: number; full_name: string }, mode: "fill" | "replace"): Promise<BindOutcome> {
    const before = await this.binding(project);
    if (!before) return { ok: false, error: "unknown project", binding: null };
    const name = gh.full_name.toLowerCase();
    const refuse = async (error: string): Promise<BindOutcome> => {
      this.sql.exec("UPDATE projects SET bind_error = ? WHERE id = ?", error, project);
      return { ok: false, error, binding: (await this.binding(project))! };
    };
    if (!Number.isSafeInteger(gh.id) || gh.id <= 0 || !REPO.test(name)) return refuse("GitHub's answer names no repo");
    const other = this.sql.exec<{ id: string }>("SELECT id FROM projects WHERE repo_id = ? AND id != ?", gh.id, project).toArray()[0];
    if (other) return refuse(`GitHub's repo ${name} (${gh.id}) is project ${other.id}'s`);
    if (mode === "fill" && before.repo_id !== null && before.repo_id !== gh.id) {
      return refuse(`bound to repo ${before.repo_id}, but GitHub's ${before.renamed_to ?? before.repo} is repo ${gh.id} now: re-read it to bind to that one`);
    }
    this.sql.exec(
      "UPDATE projects SET repo_id = ?, repo_bound = 'github', repo_bound_ms = ?, bind_error = NULL, repo_name = CASE WHEN repo = ? THEN NULL ELSE ? END WHERE id = ?",
      gh.id, Date.now(), name, name, project,
    );
    return { ok: true, binding: (await this.binding(project))!, changed: before.repo_id !== gh.id, previous_id: before.repo_id };
  }

  /** Whether a project other than `except` calls its repo `name`. */
  async projectByName(name: string, except: string): Promise<boolean> {
    return this.sql.exec("SELECT 1 FROM projects WHERE repo = ? AND id != ?", name.toLowerCase(), except).toArray().length > 0;
  }

  /** The repo renamed: the project calls it by `name` from now on (ProjectDO and ReviewDO switched first). */
  async renameRepo(project: string, name: string): Promise<boolean> {
    const n = name.toLowerCase();
    if (this.sql.exec("SELECT 1 FROM projects WHERE repo = ? AND id != ?", n, project).toArray().length) return false;
    return this.sql.exec("UPDATE projects SET repo = ?, repo_name = NULL WHERE id = ? AND repo_name = ?", n, project, n).rowsWritten > 0;
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
