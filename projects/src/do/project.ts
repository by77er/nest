// ProjectDO, one per project (README.md#pieces): its settings and manager, the board (tasks, specs,
// assignments and each task's history, with the taint of every write), the chat with the manager, the
// approvals waiting for the owner, and the work it owes nest (agents to start, stop, messages to send).
//
// Every decision is one synchronous step on SQLite that also arms the alarm; the calls to nest happen
// after, from `drain` (run by the request that made the work, and by the alarm until it's done), and
// re-read the row before acting on an answer, since other requests run while one awaits nest.

import { DurableObject } from "cloudflare:workers";
import { TEMPLATE } from "../catalog";
import { directory, type Env, review } from "../env";
import { GRAPHQL_METHOD, type MergeMethod, type RepoAutoMerge, repoAutoMerge, type Seen, type TaskAutoMerge } from "../automerge";
import { type AttachChange, GitHubError, githubFor, PERMISSIONS, requireReviewCheck } from "../github";
import type { AgentCaller } from "../identity";
import { backoff, clientIdOf, NestError, nestFrom, type Nest, type SandboxExtras } from "../nest";
import { envName, nestSecretName, SECRET_NAME, secretFeeds, type SecretLocation, type SecretMeta, type SecretRole, secretsBrief } from "../secrets";
import { invalid } from "../schema";
import { fail, migrate, ok, type Result } from "../sql";
import { canBlock, canUnblock, dependencyError, pickForAssignment, type PrState, prsDone, waitingOn, type Spec, taskBranch, type TaskEvent, type TaskState, TERMINAL, transition, WORKER_STATES } from "../tasks";
import { type Server, toolOf } from "../tools";
import type { NestEvent } from "../webhook";
import { asBinding, type ClientLayer, clientLayerFor, type EgressRule, egressWithinGrant, LAYER_ROLES, type LayerRole, NETWORK_ROLES, type NetworkRole, NO_RULES, normalizeRules, type RoleRules, shrinkLayer } from "../network";
import { MAX_WAITS, type PrUntil, prVerdict, taskVerdict, timeoutProblem, type Wait, type WaitKind, waitKey, waitMessage, type WaitOutcome } from "../waits";
import { randomId } from "./directory";

export interface Settings {
  id: string;
  name: string;
  repo: string;
  auto_assign: boolean;
  max_workers: number;
  manager: string | null;
  manager_error: string | null;
  /** Whether the repo is attached: the review check required on its default branch (README.md#flows). */
  attached: boolean;
  /** Why the last attach failed; `POST /api/projects/:id/attach` tries again. */
  attach_error: string | null;
  /** What the last attach that succeeded did. */
  attach: AttachDetail | null;
  /** Whether task PRs get GitHub's auto-merge, which the repo is set to allow (README.md#auto-merge). */
  auto_merge: boolean;
  merge_method: MergeMethod;
  /** The repo's "Allow auto-merge", as the app writes it back from `auto_merge`. */
  repo_auto_merge: RepoAutoMerge;
  /** Whether workers' push tokens may change `.github/workflows/` (README.md#secrets); off by default. */
  workers_edit_workflows: boolean;
  created_ms: number;
}

export interface AttachDetail {
  branch: string;
  change: AttachChange;
  /** The GitHub App the check is required from; null: from any source, until the App's id is known. */
  app_id: number | null;
  at_ms: number;
}

export interface Task {
  id: string;
  title: string;
  body: string;
  spec: Spec | null;
  state: TaskState;
  ord: number;
  assignee: string | null;
  pr: number | null;
  start_error: string | null;
  /** Whether any write to it came from a tainted session (README.md#the-mcp-server-agents-see-only-their-own-work). */
  tainted: boolean;
  /** Its attached PRs, first attached first (README.md#prs); `pr` is the first of them. */
  prs: TaskPr[];
  /** The tasks it waits on (README.md#dependencies), and those that wait on it. */
  blocked_by: TaskRef[];
  blocks: TaskRef[];
  /** Of `blocked_by`, the ones not done yet: while any is, it can't be assigned. */
  waiting_on: string[];
  /** Set while an agent has the task waiting on the owner (README.md#blocked). */
  blocked: Blocked | null;
  created_ms: number;
  updated_ms: number;
}

/** A PR attached to a task: open or merged (a closed one is detached). */
export interface TaskPr {
  number: number;
  state: "open" | "merged";
  title: string | null;
  /** From a fork (never auto-merged); null until GitHub has said. */
  fork: boolean | null;
  attached_by: string;
  attached_ms: number;
  /** GitHub's auto-merge on it, while the project's `auto_merge` is on; null when never asked. */
  auto_merge: TaskAutoMerge | null;
}

/** Another task, as a dependency names it. */
export interface TaskRef {
  id: string;
  title: string;
  state: TaskState;
}

/** Who blocked a task, when, why, and what they ask the owner. */
export interface Blocked {
  at_ms: number;
  by: string;
  role: "manager" | "worker";
  reason: string;
  question: string | null;
  tainted: boolean;
}

/** One thing waiting on the owner: an agent's ask (nest's), or a blocked task. Oldest first. */
export type Attention = ({ kind: "ask" } & Ask) | ({ kind: "blocked"; task: string; title: string; state: TaskState } & Blocked) | ({ kind: "secret" } & SecretRequest);

/** An agent asking the owner for a secret (README.md#secrets): one to inject, or one CI needs. */
export interface SecretRequest {
  id: string;
  type: "injected" | "ci";
  name: string;
  purpose: string;
  hosts: string[] | null;
  agent: string;
  role: string;
  task: string | null;
  tainted: boolean;
  at_ms: number;
}

/** A secret as the board lists it: its metadata, and the live agents that have it. */
export type SecretView = SecretMeta & { holders: { agent: string; role: string }[] };

export interface HistoryRow {
  at_ms: number;
  actor: string;
  action: string;
  detail: string | null;
  tainted: boolean;
}

export interface ChatMessage {
  seq: number;
  at_ms: number;
  /** `owner`, `manager` or `app`. */
  sender: string;
  text: string;
  delivered: boolean;
  error: string | null;
}

/** An agent's ask (nest's `agent.ask`), open until `answered_ms`. */
export interface Ask {
  ask: string;
  agent: string;
  role: string | null;
  task: string | null;
  question: string | null;
  /** nest's `{name, tool}` for a held sink call; null for a plain question. */
  approval: unknown;
  at_ms: number;
  answered_ms: number | null;
}

/** Who did something: the owner (from the board), the app itself, or an agent over MCP (with its taint). */
export type Actor = { kind: "owner" } | { kind: "app"; what: string } | { kind: "agent"; agent: string; tainted: boolean };

const MAX_WORKERS_LIMIT = 20;
/** How long a deduplicated MCP call's answer is kept (nest retries a lost answer within minutes). */
const CALLS_KEEP_MS = 24 * 3600 * 1000;

export const MIGRATIONS = [
  [
    `CREATE TABLE settings (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo TEXT NOT NULL, auto_assign INTEGER NOT NULL, max_workers INTEGER NOT NULL,
      manager TEXT, manager_starts INTEGER NOT NULL DEFAULT 0, manager_next_ms INTEGER, manager_attempts INTEGER NOT NULL DEFAULT 0,
      manager_error TEXT, created_ms INTEGER NOT NULL)`,
    `CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, spec TEXT, state TEXT NOT NULL, ord REAL NOT NULL,
      assignee TEXT, assignments INTEGER NOT NULL DEFAULT 0, worker_live INTEGER NOT NULL DEFAULT 0, pr INTEGER,
      start_next_ms INTEGER, start_attempts INTEGER NOT NULL DEFAULT 0, start_error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
    "CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, at_ms INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT, tainted INTEGER NOT NULL)",
    "CREATE INDEX history_task ON history (task, seq)",
    `CREATE TABLE chat (seq INTEGER PRIMARY KEY AUTOINCREMENT, at_ms INTEGER NOT NULL, sender TEXT NOT NULL, text TEXT NOT NULL, event_id TEXT UNIQUE,
      to_agent TEXT, next_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    `CREATE TABLE asks (ask TEXT PRIMARY KEY, agent TEXT NOT NULL, role TEXT, task TEXT, question TEXT, approval TEXT, at_ms INTEGER NOT NULL,
      answered_ms INTEGER, answer TEXT)`,
    "CREATE TABLE errors (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, at_ms INTEGER NOT NULL, agent TEXT NOT NULL, role TEXT, task TEXT, code TEXT, message TEXT)",
    "CREATE TABLE stops (agent TEXT PRIMARY KEY, task TEXT, reason TEXT NOT NULL, next_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)",
    "CREATE TABLE mcp_calls (key TEXT PRIMARY KEY, result TEXT NOT NULL, at_ms INTEGER NOT NULL)",
  ],
  [
    // Attaching the repo on GitHub (README.md#flows), which the manager's start waits for.
    "ALTER TABLE settings ADD COLUMN attached_ms INTEGER",
    "ALTER TABLE settings ADD COLUMN attach_next_ms INTEGER",
    "ALTER TABLE settings ADD COLUMN attach_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE settings ADD COLUMN attach_error TEXT",
    "ALTER TABLE settings ADD COLUMN attach_detail TEXT",
    // A project made before attaching existed attaches at its next alarm.
    "UPDATE settings SET attach_next_ms = 0",
  ],
  [
    // Auto-merge (README.md#auto-merge): the setting, the repo's "Allow auto-merge" written back from it
    // (`am_write_*`) and read again (`am_read_*`, `am_observed`), and each task PR's auto-merge (`am_*`).
    "ALTER TABLE settings ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE settings ADD COLUMN merge_method TEXT NOT NULL DEFAULT 'squash'",
    "ALTER TABLE settings ADD COLUMN am_write_next_ms INTEGER",
    "ALTER TABLE settings ADD COLUMN am_write_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE settings ADD COLUMN am_write_error TEXT",
    "ALTER TABLE settings ADD COLUMN am_applied TEXT",
    "ALTER TABLE settings ADD COLUMN am_observed TEXT",
    "ALTER TABLE settings ADD COLUMN am_read_next_ms INTEGER",
    "ALTER TABLE settings ADD COLUMN am_read_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN pr_node TEXT",
    "ALTER TABLE tasks ADD COLUMN am_owed TEXT",
    "ALTER TABLE tasks ADD COLUMN am_next_ms INTEGER",
    "ALTER TABLE tasks ADD COLUMN am_attempts INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN am_status TEXT",
  ],
  [
    // Blocked (README.md#blocked): a flag on a task, with who set it, why and what they ask the owner;
    // and the messages owed to agents' inboxes besides the manager's chat.
    "ALTER TABLE tasks ADD COLUMN blocked_ms INTEGER",
    "ALTER TABLE tasks ADD COLUMN blocked_by TEXT",
    "ALTER TABLE tasks ADD COLUMN blocked_role TEXT",
    "ALTER TABLE tasks ADD COLUMN blocked_reason TEXT",
    "ALTER TABLE tasks ADD COLUMN blocked_question TEXT",
    "ALTER TABLE tasks ADD COLUMN blocked_tainted INTEGER",
    `CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, to_agent TEXT NOT NULL, text TEXT NOT NULL, relayed INTEGER NOT NULL,
      at_ms INTEGER NOT NULL, next_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  ],
  [
    // Task changes owed to its live worker (README.md#task-changes): each change, coalesced into one
    // message per window; `notify_upto` freezes a set once its first post is tried, so a retry is the same post.
    `CREATE TABLE task_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, agent TEXT NOT NULL, field TEXT NOT NULL,
      before TEXT, after TEXT, actor TEXT NOT NULL, tainted INTEGER NOT NULL, at_ms INTEGER NOT NULL)`,
    "CREATE INDEX task_changes_task ON task_changes (task, seq)",
    "ALTER TABLE tasks ADD COLUMN notify_next_ms INTEGER",
    "ALTER TABLE tasks ADD COLUMN notify_upto INTEGER",
    "ALTER TABLE tasks ADD COLUMN notify_attempts INTEGER NOT NULL DEFAULT 0",
  ],
  [
    // A task's PRs (README.md#prs): a relation, a PR attached to one task at a time; `detached` keeps a
    // PR's auto-merge to undo. The single `pr` becomes the first attached, its auto-merge with it.
    `CREATE TABLE task_prs (pr INTEGER PRIMARY KEY, task TEXT NOT NULL, state TEXT NOT NULL, node TEXT, fork INTEGER, title TEXT,
      attached_by TEXT NOT NULL, attached_ms INTEGER NOT NULL, ended_ms INTEGER,
      am_owed TEXT, am_next_ms INTEGER, am_attempts INTEGER NOT NULL DEFAULT 0, am_status TEXT)`,
    "CREATE INDEX task_prs_task ON task_prs (task, attached_ms)",
    `INSERT OR IGNORE INTO task_prs (pr, task, state, node, fork, attached_by, attached_ms, am_owed, am_next_ms, am_attempts, am_status)
      SELECT pr, id, CASE WHEN state = 'done' THEN 'merged' ELSE 'open' END, pr_node, CASE WHEN pr_node IS NULL THEN NULL ELSE 0 END,
        'app:migration', updated_ms, am_owed, am_next_ms, am_attempts, am_status FROM tasks WHERE pr IS NOT NULL`,
    // Dependencies (README.md#dependencies): `task` waits on `blocker`.
    "CREATE TABLE task_deps (task TEXT NOT NULL, blocker TEXT NOT NULL, by TEXT NOT NULL, at_ms INTEGER NOT NULL, PRIMARY KEY (task, blocker))",
    "CREATE INDEX task_deps_blocker ON task_deps (blocker)",
  ],
  [
    // The manager's waits (README.md#waiting): each the app's whole, with its deadline; one pending per key.
    `CREATE TABLE waits (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT, want TEXT, key TEXT NOT NULL, created_ms INTEGER NOT NULL,
      deadline_ms INTEGER NOT NULL, resolved_ms INTEGER, outcome TEXT, detail TEXT)`,
    "CREATE UNIQUE INDEX waits_pending ON waits (key) WHERE resolved_ms IS NULL",
    // The network rules per role (README.md#network), their revision, each live agent's client layer as
    // applied, and the rules a start attempt was made with (its sandbox's Idempotency-Key binds them).
    "ALTER TABLE settings ADD COLUMN network TEXT",
    "ALTER TABLE settings ADD COLUMN network_rev INTEGER NOT NULL DEFAULT 0",
    `CREATE TABLE layers (agent TEXT PRIMARY KEY, role TEXT NOT NULL, sandbox TEXT, rev INTEGER, want_rev INTEGER NOT NULL,
      next_ms INTEGER, attempts INTEGER NOT NULL DEFAULT 0, error TEXT, at_ms INTEGER)`,
    "CREATE TABLE frozen_egress (key TEXT PRIMARY KEY, rev INTEGER NOT NULL, egress TEXT NOT NULL)",
  ],
  [
    // Secrets (README.md#secrets): what the app keeps of each (never a value), agents' requests for
    // them, which live agent got which (so a delete names them), each start attempt's sandbox spec
    // (frozen, so a retry sends the request its idempotency key was bound to), and the workflows setting.
    `CREATE TABLE secrets (name TEXT PRIMARY KEY, description TEXT NOT NULL, hosts TEXT NOT NULL, locations TEXT NOT NULL, roles TEXT NOT NULL,
      env TEXT NOT NULL DEFAULT '', nest_name TEXT NOT NULL DEFAULT '', size INTEGER, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL)`,
    `CREATE TABLE secret_requests (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, purpose TEXT NOT NULL, hosts TEXT,
      agent TEXT NOT NULL, role TEXT NOT NULL, task TEXT, tainted INTEGER NOT NULL, at_ms INTEGER NOT NULL, done_ms INTEGER)`,
    `CREATE TABLE agent_secrets (agent TEXT PRIMARY KEY, role TEXT NOT NULL, names TEXT NOT NULL, workflows INTEGER NOT NULL DEFAULT 0,
      at_ms INTEGER NOT NULL)`,
    "CREATE TABLE start_specs (key TEXT PRIMARY KEY, spec TEXT NOT NULL, at_ms INTEGER NOT NULL)",
    "ALTER TABLE settings ADD COLUMN workers_edit_workflows INTEGER NOT NULL DEFAULT 0",
    // nest names minted for a value write and not yet recorded (each is used once), the grant as last
    // seen (a change owes every layer), and when the secrets' upkeep runs next.
    "CREATE TABLE minted (nest_name TEXT PRIMARY KEY, at_ms INTEGER NOT NULL)",
    "ALTER TABLE settings ADD COLUMN grant_seen TEXT",
    "ALTER TABLE settings ADD COLUMN secrets_next_ms INTEGER",
  ],
] as const;

type Row = Record<string, SqlStorageValue>;

/** A task's row with `tainted`: whether any write in its history came from a tainted session. */
const TASK_SELECT = "SELECT t.*, EXISTS (SELECT 1 FROM history h WHERE h.task = t.id AND h.tainted = 1) AS tainted FROM tasks t";

export class ProjectDO extends DurableObject<Env> {
  private draining: Promise<void> | null = null;
  private again = false;
  /** Whether this drain already went round again for a changed grant (`grantSeen`). */
  private reowed = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    migrate(ctx.storage, MIGRATIONS);
  }

  private get sql() {
    return this.ctx.storage.sql;
  }

  // --- settings --------------------------------------------------------------------------------------

  /** Set the project up (once; a repeat with the same id is a no-op) and owe nest its manager. */
  async init(p: { id: string; name: string; repo: string; auto_assign?: boolean; max_workers?: number; auto_merge?: boolean; merge_method?: MergeMethod }): Promise<Settings> {
    if (!this.settingsRow()) {
      this.sql.exec(
        `INSERT INTO settings (id, name, repo, auto_assign, max_workers, attach_next_ms, manager_next_ms, auto_merge, merge_method, am_write_next_ms, created_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        p.id, p.name, p.repo, p.auto_assign ? 1 : 0, clampWorkers(p.max_workers ?? 2), Date.now(), Date.now(),
        p.auto_merge ? 1 : 0, p.merge_method ?? "squash", p.auto_merge ? Date.now() : null, Date.now(),
      );
      await this.arm();
    }
    return this.settings()!;
  }

  private settingsRow(): Row | undefined {
    return this.sql.exec("SELECT * FROM settings").toArray()[0];
  }

  settings(): Settings | null {
    const r = this.settingsRow();
    if (!r) return null;
    return {
      id: r.id as string, name: r.name as string, repo: r.repo as string, auto_assign: r.auto_assign === 1, max_workers: r.max_workers as number,
      manager: (r.manager as string | null) ?? null, manager_error: (r.manager_error as string | null) ?? null,
      attached: r.attached_ms !== null, attach_error: (r.attach_error as string | null) ?? null,
      attach: r.attach_detail ? (JSON.parse(r.attach_detail as string) as AttachDetail) : null,
      auto_merge: r.auto_merge === 1, merge_method: r.merge_method as MergeMethod, workers_edit_workflows: r.workers_edit_workflows === 1,
      repo_auto_merge: repoAutoMerge({
        want: r.auto_merge === 1, owed: r.am_write_next_ms !== null, error: (r.am_write_error as string | null) ?? null,
        applied: r.am_applied ? (JSON.parse(r.am_applied as string) as Seen) : null, observed: r.am_observed ? (JSON.parse(r.am_observed as string) as Seen) : null,
      }),
      created_ms: r.created_ms as number,
    };
  }

  async getSettings(): Promise<Result<Settings>> {
    const s = this.settings();
    return s ? ok(s) : fail(404, "unknown project");
  }

  async updateSettings(u: { auto_assign?: boolean; max_workers?: number; auto_merge?: boolean; merge_method?: MergeMethod; workers_edit_workflows?: boolean }): Promise<Result<Settings>> {
    const before = this.settings();
    if (!before) return fail(404, "unknown project");
    if (u.auto_assign !== undefined) this.sql.exec("UPDATE settings SET auto_assign = ?", u.auto_assign ? 1 : 0);
    if (u.max_workers !== undefined) this.sql.exec("UPDATE settings SET max_workers = ?", clampWorkers(u.max_workers));
    if (u.merge_method !== undefined) this.sql.exec("UPDATE settings SET merge_method = ?", u.merge_method);
    if (u.workers_edit_workflows !== undefined) this.sql.exec("UPDATE settings SET workers_edit_workflows = ?", u.workers_edit_workflows ? 1 : 0);
    if (u.workers_edit_workflows === false && before.workers_edit_workflows) {
      // Off for starts in flight too: their frozen specs lose it. A retry of a create whose answer was
      // lost then differs from its first try, which nest refuses (409) for good: that start fails,
      // rather than a worker starting with it after the owner turned it off.
      for (const r of this.sql.exec<{ key: string; spec: string }>("SELECT key, spec FROM start_specs").toArray()) {
        const spec = JSON.parse(r.spec) as StartSpec;
        if (!spec.extras.github_push) continue;
        delete spec.extras.github_push;
        this.sql.exec("UPDATE start_specs SET spec = ? WHERE key = ?", JSON.stringify(spec), r.key);
      }
    }
    if (u.auto_merge !== undefined && u.auto_merge !== before.auto_merge) this.setAutoMerge(u.auto_merge);
    this.autoAssign();
    await this.arm();
    await this.drain();
    return ok(this.settings()!);
  }

  // --- the board -------------------------------------------------------------------------------------

  private taskRow(id: string): Row | undefined {
    return this.sql.exec(`${TASK_SELECT} WHERE t.id = ?`, id).toArray()[0];
  }

  private toTask(r: Row): Task {
    return {
      id: r.id as string, title: r.title as string, body: r.body as string, spec: r.spec ? (JSON.parse(r.spec as string) as Spec) : null,
      state: r.state as TaskState, ord: r.ord as number, assignee: (r.assignee as string | null) ?? null,
      start_error: (r.start_error as string | null) ?? null, tainted: r.tainted === 1, blocked: blockedOf(r),
      ...this.relations(r.id as string),
      created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
    };
  }

  /** A task's PRs and dependencies, as Task carries them. */
  private relations(id: string): Pick<Task, "pr" | "prs" | "blocked_by" | "blocks" | "waiting_on"> {
    const prs = this.sql.exec("SELECT * FROM task_prs WHERE task = ? AND state != 'detached' ORDER BY attached_ms, pr", id).toArray().map((p): TaskPr => ({
      number: p.pr as number, state: p.state as "open" | "merged", title: (p.title as string | null) ?? null, fork: p.fork === null ? null : p.fork === 1,
      attached_by: p.attached_by as string, attached_ms: p.attached_ms as number, auto_merge: prAutoMerge(p),
    }));
    const ref = (r: Row): TaskRef => ({ id: r.id as string, title: r.title as string, state: r.state as TaskState });
    const blocked_by = this.sql.exec("SELECT t.id, t.title, t.state FROM task_deps d JOIN tasks t ON t.id = d.blocker WHERE d.task = ? ORDER BY d.at_ms", id).toArray().map(ref);
    const blocks = this.sql.exec("SELECT t.id, t.title, t.state FROM task_deps d JOIN tasks t ON t.id = d.task WHERE d.blocker = ? ORDER BY d.at_ms", id).toArray().map(ref);
    return { pr: prs[0]?.number ?? null, prs, blocked_by, blocks, waiting_on: waitingOn(blocked_by) };
  }

  async listTasks(): Promise<Result<Task[]>> {
    if (!this.settings()) return fail(404, "unknown project");
    return ok(this.sql.exec(`${TASK_SELECT} ORDER BY t.ord, t.created_ms`).toArray().map((r) => this.toTask(r)));
  }

  async getTask(id: string): Promise<Result<Task & { history: HistoryRow[] }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    const history = this.sql.exec("SELECT at_ms, actor, action, detail, tainted FROM history WHERE task = ? ORDER BY seq", id).toArray()
      .map((h) => ({ at_ms: h.at_ms as number, actor: h.actor as string, action: h.action as string, detail: (h.detail as string | null) ?? null, tainted: h.tainted === 1 }));
    return ok({ ...this.toTask(r), history });
  }

  private record(task: string, actor: Actor, action: string, detail?: unknown): void {
    const who = actor.kind === "owner" ? "owner" : actor.kind === "app" ? `app:${actor.what}` : actor.agent;
    const tainted = actor.kind === "agent" && actor.tainted ? 1 : 0;
    this.sql.exec("INSERT INTO history (task, at_ms, actor, action, detail, tainted) VALUES (?, ?, ?, ?, ?, ?)",
      task, Date.now(), who, action, detail === undefined ? null : typeof detail === "string" ? detail : JSON.stringify(detail), tainted);
  }

  async createTask(t: { title: string; body?: string }, actor: Actor = { kind: "owner" }): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const id = `tsk_${randomId()}`;
    const now = Date.now();
    const last = this.sql.exec<{ m: number | null }>("SELECT MAX(ord) AS m FROM tasks").one().m ?? 0;
    this.sql.exec("INSERT INTO tasks (id, title, body, state, ord, created_ms, updated_ms) VALUES (?, ?, ?, 'draft', ?, ?, ?)", id, t.title, t.body ?? "", last + 1, now, now);
    this.record(id, actor, "created", { title: t.title });
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** Change a task's title, body or board position; its spec through `writeSpec`. */
  async updateTask(id: string, u: { title?: string; body?: string; ord?: number }, actor: Actor = { kind: "owner" }): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    if (TERMINAL.has(r.state as TaskState) && (u.title !== undefined || u.body !== undefined)) return fail(409, `a ${r.state} task can't change`);
    // Its live worker is told of a new title or body; a reorder isn't its concern (README.md#task-changes).
    if (u.title !== undefined && u.title !== r.title) this.noteChange(id, "title", r.title as string, u.title, actor);
    if (u.body !== undefined && u.body !== r.body) this.noteChange(id, "body", r.body as string, u.body, actor);
    if (u.title !== undefined) this.sql.exec("UPDATE tasks SET title = ? WHERE id = ?", u.title, id);
    if (u.body !== undefined) this.sql.exec("UPDATE tasks SET body = ? WHERE id = ?", u.body, id);
    if (u.ord !== undefined) this.sql.exec("UPDATE tasks SET ord = ? WHERE id = ?", u.ord, id);
    this.sql.exec("UPDATE tasks SET updated_ms = ? WHERE id = ?", Date.now(), id);
    this.record(id, actor, "updated", u);
    if (u.ord !== undefined) this.autoAssign();
    await this.arm();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** Delete a draft (anything further along is cancelled instead, so its history stays). */
  async deleteTask(id: string): Promise<Result<{ deleted: string }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    if (r.state !== "draft") return fail(409, "only a draft is deleted; cancel it instead");
    this.sql.exec("DELETE FROM tasks WHERE id = ?", id);
    this.sql.exec("DELETE FROM history WHERE task = ?", id);
    for (const w of this.pendingWaits("task", id)) this.resolveWait(w.id, "ended", "deleted");
    await this.arm();
    return ok({ deleted: id });
  }

  /** Move a task by `event`, or answer why it can't move. The caller adds the side effects. */
  private move(id: string, event: TaskEvent, actor: Actor, detail?: unknown): Result<{ from: TaskState; to: TaskState }> {
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    const from = r.state as TaskState;
    const t = transition(from, event);
    if (!t.ok) return fail(409, t.error);
    this.sql.exec("UPDATE tasks SET state = ?, updated_ms = ? WHERE id = ?", t.to, Date.now(), id);
    this.record(id, actor, event, detail);
    // The manager's waits on this task see the move in this step.
    this.taskWaitsOn(id, t.to);
    // Tasks waiting on it hear it's done; their live workers are told (README.md#task-changes).
    if (t.to === "done") {
      for (const d of this.sql.exec("SELECT task FROM task_deps WHERE blocker = ?", id).toArray()) {
        this.record(d.task as string, { kind: "app", what: "board" }, "dependency_done", { blocker: id, title: r.title as string });
        this.noteChange(d.task as string, "dependencies", `${id} (${from.replace("_", " ")})`, `${id} (done)`, { kind: "app", what: "board" });
      }
    }
    // A task that ends has nothing left to wait on the owner for.
    if (TERMINAL.has(t.to) && r.blocked_ms !== null) {
      this.clearBlock(id);
      this.record(id, { kind: "app", what: "board" }, "unblocked", { why: t.to });
    }
    return ok({ from, to: t.to });
  }

  async writeSpec(id: string, spec: Spec, actor: Actor = { kind: "owner" }): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const before = this.taskRow(id)?.spec as string | null | undefined;
    const m = this.move(id, "spec", actor, spec);
    if (!m.ok) return m;
    this.sql.exec("UPDATE tasks SET spec = ? WHERE id = ?", JSON.stringify(spec), id);
    if (before !== JSON.stringify(spec)) this.noteChange(id, "spec", before ?? null, JSON.stringify(spec), actor);
    this.autoAssign();
    await this.arm();
    return ok(this.toTask(this.taskRow(id)!));
  }

  private liveWorkers(): number {
    return this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE worker_live = 1").one().n;
  }

  /** Assign in one step: the task moves, a worker is owed (started by `drain`), and it counts as live. */
  private assignNow(id: string, actor: Actor): Result<Task> {
    const m = this.move(id, "assign", actor);
    if (!m.ok) return m;
    this.sql.exec(
      "UPDATE tasks SET assignee = NULL, assignments = assignments + 1, worker_live = 1, start_next_ms = ?, start_attempts = 0, start_error = NULL WHERE id = ?",
      Date.now(), id,
    );
    return ok(this.toTask(this.taskRow(id)!));
  }

  /**
   * Assign by hand. The owner's isn't capped; an agent's (the manager's) is held to `max_workers`, as
   * auto-assign is, so a manager can't start workers past the owner's limit.
   */
  async assign(id: string, actor: Actor = { kind: "owner" }, o: { wait?: boolean } = { wait: true }): Promise<Result<Task>> {
    const s = this.settings();
    if (!s) return fail(404, "unknown project");
    if (actor.kind === "agent" && this.liveWorkers() >= s.max_workers) return fail(409, `the project already has ${s.max_workers} live workers (max_workers)`);
    // Its dependencies first, whoever assigns it: there is no override (remove the dependency instead).
    const waiting = this.taskRow(id) ? this.relations(id).blocked_by.filter((b) => b.state !== "done") : [];
    if (waiting.length) return fail(409, `it waits on ${waiting.map((b) => `${b.id} (${b.state.replace("_", " ")})`).join(", ")}: they must be done first`);
    const r = this.assignNow(id, actor);
    if (!r.ok) return r;
    await this.arm();
    if (o.wait) await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** Auto-assign (README.md#flows): `ready` tasks in board order while live workers < max_workers. */
  private autoAssign(): void {
    const s = this.settings();
    if (!s?.auto_assign) return;
    const tasks = this.sql.exec("SELECT id, state, ord, blocked_ms FROM tasks WHERE state = 'ready'").toArray()
      .map((r) => ({ id: r.id as string, state: r.state as TaskState, ord: r.ord as number, blocked: r.blocked_ms !== null, waiting: this.relations(r.id as string).waiting_on.length > 0 }));
    for (const id of pickForAssignment(tasks, this.liveWorkers(), s.max_workers)) this.assignNow(id, { kind: "app", what: "auto-assign" });
  }

  /** Owe nest a stop of the task's worker, if it has one. */
  private stopWorkerOf(id: string, reason: string): void {
    const r = this.taskRow(id)!;
    const agent = r.assignee as string | null;
    if (agent) this.sql.exec("INSERT OR IGNORE INTO stops (agent, task, reason, next_ms) VALUES (?, ?, ?, ?)", agent, id, reason, Date.now());
    else this.sql.exec("UPDATE tasks SET worker_live = 0, start_next_ms = NULL WHERE id = ?", id);
  }

  async cancel(id: string, actor: Actor = { kind: "owner" }, reason?: string): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const m = this.move(id, "cancel", actor, reason);
    if (!m.ok) return m;
    this.stopWorkerOf(id, "cancelled");
    this.autoAssign();
    await this.arm();
    if (actor.kind === "owner") await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /**
   * The owner marks a task done: one with no PR and no live worker (src/tasks.ts). A stalled task's
   * stopped worker is ended for good, if it isn't already.
   */
  async markDone(id: string): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const m = this.move(id, "done", { kind: "owner" });
    if (!m.ok) return m;
    this.stopWorkerOf(id, "done");
    this.autoAssign();
    await this.arm();
    await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  // --- the repo on GitHub ----------------------------------------------------------------------------

  /** Attach the repo again now (the board's retry after a failure; harmless when attached). */
  async retryAttach(): Promise<Result<Settings>> {
    if (!this.settings()) return fail(404, "unknown project");
    this.sql.exec("UPDATE settings SET attach_next_ms = ?, attach_attempts = 0", Date.now());
    await this.arm();
    await this.drain();
    return ok(this.settings()!);
  }

  /** The App's id is known (from a check run it made): attach again to require the check from it. */
  async appIdLearned(appId: number): Promise<void> {
    const s = this.settings();
    if (!s?.attached || s.attach?.app_id === appId) return;
    this.sql.exec("UPDATE settings SET attach_next_ms = ?, attach_attempts = 0", Date.now());
    await this.arm();
  }

  /**
   * A PR on the repo opened, reopened or closed (GitHub's `pull_request`, routed here by the Worker).
   * `task` is the task its branch names (`task/<id>`, from the repo itself, not a fork), when it does:
   * - opened: a PR not attached anywhere is attached to that task (README.md#prs); an attached one's
   *   facts (node id, fork, title) are learned. A branch never moves a PR attached to another task;
   * - merged: the PR is marked merged, and its task done once all its PRs are;
   * - closed without merging: detached from its task, noted in its history.
   */
  async onPullRequest(e: { pr: number; task: string | null; action: "opened" | "closed"; merged: boolean; node?: string | null; fork?: boolean; title?: string | null }): Promise<void> {
    if (!this.settings()) return;
    // Any PR of the repo, a task's or not: the manager's waits on it.
    if (e.action === "closed") {
      for (const w of this.pendingWaits("pr", String(e.pr))) this.prWaitOn(w, e.merged ? { kind: "merged" } : { kind: "closed" });
    }
    const github: Actor = { kind: "app", what: "github" };
    const had = this.prRow(e.pr);
    if (e.action === "opened") {
      if (had && had.state !== "detached") {
        this.sql.exec("UPDATE task_prs SET state = 'open', node = COALESCE(?, node), fork = COALESCE(?, fork), title = COALESCE(?, title) WHERE pr = ?",
          e.node ?? null, e.fork === undefined ? null : e.fork ? 1 : 0, e.title ?? null, e.pr);
        this.oweEnableIfDue(e.pr);
      } else if (e.task && this.taskRow(e.task)) {
        const r = this.attachPr(e.task, { pr: e.pr, node: e.node ?? null, fork: e.fork ?? null, title: e.title ?? null }, github);
        if (!r.ok) this.record(e.task, github, "pr_seen", { pr: e.pr, why: r.error });
      }
    } else if (had && had.state !== "detached") {
      const id = had.task as string;
      // A closed PR's auto-merge is GitHub's to drop: nothing more is owed for it.
      this.sql.exec("UPDATE task_prs SET am_owed = NULL, am_next_ms = NULL WHERE pr = ?", e.pr);
      if (e.merged) {
        this.sql.exec("UPDATE task_prs SET state = 'merged', ended_ms = ? WHERE pr = ?", Date.now(), e.pr);
        this.record(id, github, "pr_merged", { pr: e.pr });
        this.finishIfMerged(id, github);
      } else {
        this.detach(id, e.pr, github, "pr_closed", { pr: e.pr, detached: true });
      }
    }
    await this.arm();
  }

  // --- PRs (README.md#prs) ----------------------------------------------------------------------------

  private prRow(pr: number): Row | undefined {
    return this.sql.exec("SELECT * FROM task_prs WHERE pr = ?", pr).toArray()[0];
  }

  private prList(id: string): string {
    return this.relations(id).prs.map((p) => `#${p.number}${p.state === "merged" ? " (merged)" : ""}`).join(", ") || "none";
  }

  /**
   * Attach a PR to a task (one step): refused when it's attached to another task (detach it there
   * first), or the task is over. A task in progress goes to review; its live worker is told; the PR gets
   * auto-merge when it's due.
   */
  private attachPr(id: string, p: { pr: number; node: string | null; fork: boolean | null; title: string | null }, actor: Actor): Result<Task> {
    const t = this.taskRow(id);
    if (!t) return fail(404, "unknown task");
    if (TERMINAL.has(t.state as TaskState)) return fail(409, `a ${t.state} task takes no PR`);
    const had = this.prRow(p.pr);
    if (had && had.state !== "detached") {
      if (had.task === id) return ok(this.toTask(t));
      return fail(409, `PR #${p.pr} is attached to ${had.task as string}: detach it there first`);
    }
    const before = this.prList(id);
    const who = actor.kind === "owner" ? "owner" : actor.kind === "app" ? `app:${actor.what}` : actor.agent;
    this.sql.exec(
      `INSERT INTO task_prs (pr, task, state, node, fork, title, attached_by, attached_ms) VALUES (?, ?, 'open', ?, ?, ?, ?, ?)
        ON CONFLICT (pr) DO UPDATE SET task = excluded.task, state = 'open', node = COALESCE(excluded.node, node), fork = COALESCE(excluded.fork, fork),
          title = COALESCE(excluded.title, title), attached_by = excluded.attached_by, attached_ms = excluded.attached_ms, ended_ms = NULL`,
      p.pr, id, p.node, p.fork === null ? null : p.fork ? 1 : 0, p.title, who, Date.now(),
    );
    if (t.state === "in_progress") this.move(id, "pr_opened", actor, { pr: p.pr });
    else this.record(id, actor, "pr_attached", { pr: p.pr });
    this.syncPr(id);
    this.noteChange(id, "prs", before, this.prList(id), actor);
    this.oweEnableIfDue(p.pr);
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** Detach a PR from its task: its auto-merge is undone if it had one; the task is done if the rest merged. */
  private detach(id: string, pr: number, actor: Actor, action: string, detail: unknown): void {
    const before = this.prList(id);
    const row = this.prRow(pr)!;
    this.sql.exec("UPDATE task_prs SET state = 'detached', ended_ms = ? WHERE pr = ?", Date.now(), pr);
    const am = row.am_status ? (JSON.parse(row.am_status as string) as TaskAutoMerge) : null;
    if (action !== "pr_closed" && (am?.state === "enabled" || row.am_owed === "enable")) this.owePrAutoMerge(pr, "disable");
    this.record(id, actor, action, detail);
    this.syncPr(id);
    this.noteChange(id, "prs", before, this.prList(id), actor);
    this.finishIfMerged(id, actor);
  }

  /** The task's `pr` column (kept for older readers): its first attached PR. */
  private syncPr(id: string): void {
    this.sql.exec("UPDATE tasks SET pr = ? WHERE id = ?", this.relations(id).pr, id);
  }

  /** A task whose attached PRs have all merged is done, and its worker ended. */
  private finishIfMerged(id: string, actor: Actor): void {
    const t = this.taskRow(id);
    if (!t || TERMINAL.has(t.state as TaskState)) return;
    const prs = this.sql.exec("SELECT state FROM task_prs WHERE task = ?", id).toArray().map((p) => ({ state: p.state as PrState }));
    if (!prsDone(prs)) return;
    if (this.move(id, "merged", actor).ok) {
      this.stopWorkerOf(id, "merged");
      this.autoAssign();
    }
  }

  /** The owner or the manager attaches a PR by its number, checked on GitHub: in the repo, and open. */
  async attachPrByNumber(id: string, pr: number, actor: Actor): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    if (!this.taskRow(id)) return fail(404, "unknown task");
    const s = this.settings()!;
    const nest = nestFrom(this.env);
    if (!nest) return fail(503, "NEST_CLIENT_TOKEN is not set");
    let p;
    try {
      p = await (await githubFor(nest, s.repo, PERMISSIONS.pullsRead)).pull(s.repo, pr);
    } catch (e) {
      return fail(e instanceof GitHubError && e.status === 404 ? 404 : 502, e instanceof GitHubError && e.status === 404 ? `no PR #${pr} on ${s.repo}` : message(e));
    }
    if (p.state !== "open") return fail(409, `PR #${pr} is ${p.merged ? "merged" : "closed"}: attach an open one`);
    const r = this.attachPr(id, { pr, node: p.node_id, fork: p.fork, title: p.title }, actor);
    await this.arm();
    if (actor.kind === "owner") await this.drain();
    return r;
  }

  async detachPr(id: string, pr: number, actor: Actor): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    if (!this.taskRow(id)) return fail(404, "unknown task");
    const row = this.prRow(pr);
    if (!row || row.task !== id || row.state === "detached") return fail(404, `PR #${pr} isn't attached to ${id}`);
    if (row.state === "merged") return fail(409, `PR #${pr} has merged: it stays attached`);
    this.detach(id, pr, actor, "pr_detached", { pr });
    await this.arm();
    if (actor.kind === "owner") await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** The repo's open PRs, for the owner's picker, each with the task it's attached to, if any. */
  async openPrs(): Promise<Result<{ number: number; title: string; head: string; fork: boolean; task: string | null }[]>> {
    const s = this.settings();
    if (!s) return fail(404, "unknown project");
    const nest = nestFrom(this.env);
    if (!nest) return fail(503, "NEST_CLIENT_TOKEN is not set");
    try {
      const list = await (await githubFor(nest, s.repo, PERMISSIONS.pullsRead)).openPulls(s.repo);
      return ok(list.map((p) => {
        const row = this.prRow(p.number);
        return { number: p.number, title: p.title, head: p.head_ref, fork: p.fork, task: row && row.state !== "detached" ? (row.task as string) : null };
      }));
    } catch (e) {
      return fail(502, message(e));
    }
  }

  // --- dependencies (README.md#dependencies) --------------------------------------------------------------

  async addDependency(id: string, blocker: string, actor: Actor): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const states = new Map(this.sql.exec("SELECT id, state FROM tasks").toArray().map((r) => [r.id as string, r.state as TaskState]));
    const edges = this.sql.exec("SELECT task, blocker FROM task_deps").toArray().map((r) => [r.task as string, r.blocker as string] as const);
    const err = dependencyError(id, blocker, edges, states);
    if (err) return fail(err.startsWith("unknown task") ? 404 : 409, err);
    const before = this.depList(id);
    const who = actor.kind === "owner" ? "owner" : actor.kind === "app" ? `app:${actor.what}` : actor.agent;
    this.sql.exec("INSERT INTO task_deps (task, blocker, by, at_ms) VALUES (?, ?, ?, ?)", id, blocker, who, Date.now());
    this.record(id, actor, "dependency_added", { blocked_by: blocker, title: this.taskRow(blocker)!.title as string });
    this.noteChange(id, "dependencies", before, this.depList(id), actor);
    await this.arm();
    return ok(this.toTask(this.taskRow(id)!));
  }

  async removeDependency(id: string, blocker: string, actor: Actor): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    if (!this.taskRow(id)) return fail(404, "unknown task");
    const before = this.depList(id);
    const gone = this.sql.exec("DELETE FROM task_deps WHERE task = ? AND blocker = ? RETURNING task", id, blocker).toArray().length;
    if (!gone) return fail(404, `${id} doesn't wait on ${blocker}`);
    this.record(id, actor, "dependency_removed", { blocked_by: blocker, title: (this.taskRow(blocker)?.title as string | undefined) ?? null });
    this.noteChange(id, "dependencies", before, this.depList(id), actor);
    // It may be assignable now.
    this.autoAssign();
    await this.arm();
    if (actor.kind === "owner") await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  private depList(id: string): string {
    return this.relations(id).blocked_by.map((b) => `${b.id} (${b.state.replace("_", " ")})`).join(", ") || "none";
  }

  // --- auto-merge ------------------------------------------------------------------------------------

  /** Turn auto-merge on or off: the repo's setting is owed its write, and each open task PR its change. */
  private setAutoMerge(on: boolean): void {
    this.sql.exec("UPDATE settings SET auto_merge = ?, am_write_next_ms = ?, am_write_attempts = 0, am_write_error = NULL", on ? 1 : 0, Date.now());
    for (const p of this.sql.exec("SELECT pr, am_status, am_owed FROM task_prs WHERE state = 'open'").toArray()) {
      const status = p.am_status ? (JSON.parse(p.am_status as string) as TaskAutoMerge) : null;
      if (on) this.oweEnableIfDue(p.pr as number);
      else if (status?.state === "enabled" || p.am_owed === "enable") this.owePrAutoMerge(p.pr as number, "disable");
    }
  }

  /**
   * Owe auto-merge on an attached PR when it's due: the setting on, the PR open, its task not over, and
   * known to be from the repo itself (never a fork's) with its node id, and not already on.
   */
  private oweEnableIfDue(pr: number): void {
    const p = this.prRow(pr);
    if (!p || p.state !== "open" || p.fork !== 0 || !p.node || !this.settings()!.auto_merge) return;
    const t = this.taskRow(p.task as string);
    if (!t || TERMINAL.has(t.state as TaskState)) return;
    const status = p.am_status ? (JSON.parse(p.am_status as string) as TaskAutoMerge) : null;
    if (status?.state === "enabled" && !p.am_owed) return;
    this.owePrAutoMerge(pr, "enable");
  }

  private owePrAutoMerge(pr: number, what: "enable" | "disable"): void {
    this.sql.exec("UPDATE task_prs SET am_owed = ?, am_next_ms = ?, am_attempts = 0 WHERE pr = ?", what, Date.now(), pr);
  }

  /** Write the repo's setting again now: after a refusal, or to undo a drift. */
  async retryRepoAutoMerge(): Promise<Result<Settings>> {
    if (!this.settings()) return fail(404, "unknown project");
    this.sql.exec("UPDATE settings SET am_write_next_ms = ?, am_write_attempts = 0, am_write_error = NULL", Date.now());
    await this.arm();
    await this.drain();
    return ok(this.settings()!);
  }

  /**
   * The project is being looked at: read the repo's setting again, at most once a minute, if the app
   * has written it, so a change by hand shows as drifted. The read is the alarm's; this answers at once.
   */
  async refreshRepoAutoMerge(): Promise<void> {
    const r = this.settingsRow();
    if (!r?.am_applied || r.am_write_next_ms !== null || r.am_read_next_ms !== null) return;
    const seen = [r.am_applied, r.am_observed].filter(Boolean).map((x) => (JSON.parse(x as string) as Seen).at_ms);
    if (Date.now() - Math.max(...seen) < REPO_READ_EVERY_MS) return;
    this.sql.exec("UPDATE settings SET am_read_next_ms = ?, am_read_attempts = 0", Date.now());
    await this.arm();
  }

  // --- telling a task's worker what changed ---------------------------------------------------------

  /**
   * Note a change to a task for its live worker (`assigned`, `in_progress`, or `in_review` while it
   * lives): told within NOTIFY_WINDOW_MS, coalesced with the changes after it. A task without one has
   * nobody to tell; a worker started later gets the current task in its brief.
   */
  private noteChange(id: string, field: "title" | "body" | "spec" | "blocked" | "prs" | "dependencies", before: string | null, after: string | null, actor: Actor): void {
    const r = this.taskRow(id);
    if (!r || !r.assignee || r.worker_live !== 1 || !WORKER_STATES.has(r.state as TaskState)) return;
    const who = actor.kind === "owner" ? "owner" : actor.kind === "app" ? `app:${actor.what}` : actor.agent;
    if (actor.kind === "agent" && actor.agent === r.assignee) return; // its own change
    this.sql.exec(
      "INSERT INTO task_changes (task, agent, field, before, after, actor, tainted, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      id, r.assignee, field, before, after, who, actor.kind === "agent" && actor.tainted ? 1 : 0, Date.now(),
    );
    this.sql.exec("UPDATE tasks SET notify_next_ms = COALESCE(notify_next_ms, ?) WHERE id = ?", Date.now() + NOTIFY_WINDOW_MS, id);
  }

  /** Tell a task's worker its changes, one message per set, posted once (its request id names the set). */
  private async notifyWorker(nest: Nest, id: string): Promise<void> {
    const r = this.taskRow(id);
    if (!r) return;
    // Freeze the set on its first try, so a retry posts exactly what the first did.
    let upto = r.notify_upto as number | null;
    if (upto === null) {
      upto = this.sql.exec<{ m: number | null }>("SELECT MAX(seq) AS m FROM task_changes WHERE task = ?", id).one().m;
      if (upto === null) {
        this.sql.exec("UPDATE tasks SET notify_next_ms = NULL WHERE id = ?", id);
        return;
      }
      this.sql.exec("UPDATE tasks SET notify_upto = ? WHERE id = ?", upto, id);
    }
    const changes = this.sql.exec("SELECT * FROM task_changes WHERE task = ? AND seq <= ? ORDER BY seq", id, upto).toArray();
    const agent = changes.at(-1)!.agent as string;
    const done = (detail: Record<string, unknown>, action: string) => {
      this.sql.exec("DELETE FROM task_changes WHERE task = ? AND seq <= ?", id, upto);
      const more = this.sql.exec("SELECT MIN(at_ms) AS t FROM task_changes WHERE task = ?", id).one().t as number | null;
      this.sql.exec("UPDATE tasks SET notify_upto = NULL, notify_attempts = 0, notify_next_ms = ? WHERE id = ?", more === null ? null : more + NOTIFY_WINDOW_MS, id);
      this.record(id, { kind: "app", what: "board" }, action, detail);
    };
    // The worker ended, or the task moved on to another: nobody to tell.
    if (agent !== r.assignee || r.worker_live !== 1 || !WORKER_STATES.has(r.state as TaskState)) {
      done({ agent, dropped: changes.length }, "worker_not_notified");
      return;
    }
    const tainted = changes.some((c) => c.tainted === 1);
    try {
      await nest.postInbox(agent, changeMessage(this.toTask(r), changes), { requestId: `${id}/changes/${upto}`, ...(tainted ? { from: "projects/board" } : {}) });
      done({ agent, fields: [...new Set(changes.map((c) => c.field as string))], changes: changes.length }, "worker_notified");
    } catch (e) {
      const attempts = (r.notify_attempts as number) + 1;
      if (e instanceof NestError && e.permanent) {
        done({ agent, error: message(e) }, "worker_not_notified");
        return;
      }
      this.sql.exec("UPDATE tasks SET notify_attempts = ?, notify_next_ms = ? WHERE id = ?", attempts, Date.now() + backoff(attempts), id);
    }
  }

  // --- secrets (README.md#secrets) ---------------------------------------------------------------------

  private secretRows(): SecretMeta[] {
    return this.sql.exec("SELECT * FROM secrets ORDER BY name").toArray().map((r) => ({
      name: r.name as string, description: r.description as string, hosts: JSON.parse(r.hosts as string) as string[],
      locations: JSON.parse(r.locations as string) as SecretLocation[], roles: JSON.parse(r.roles as string) as SecretRole[],
      env: (r.env as string) || envName(r.name as string), nest_name: r.nest_name as string,
      size: (r.size as number | null) ?? null, created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
    }));
  }

  /**
   * A role's secrets as its sandboxes' bindings and variables, inside the grant's `inject_hosts`
   * (README.md#secrets); `null`, the grant unknown: all of them (only ever the target a removal is cut from).
   */
  private secretFeeds(role: SecretRole, injectHosts: readonly string[] | null): ReturnType<typeof secretFeeds> {
    return secretFeeds(this.clientId(), this.secretRows().filter((m) => m.roles.includes(role)), injectHosts);
  }

  /**
   * The nest name a secret's value goes under: its own (a replacement takes no new place in the grant's
   * `max_count`), or for a new secret a new generation, minted here and usable once (`saveSecretMeta`
   * takes it). So a write racing a delete can't record the deleted generation's name again: the row it
   * expected is gone, and that name was never minted for a new one.
   */
  async nestNameFor(name: string, value: boolean): Promise<string | null> {
    const had = this.secretRows().find((x) => x.name === name)?.nest_name;
    if (had || !value) return had ?? null;
    const minted = nestSecretName(this.settings()!.id, name, randomId().slice(0, 6).toLowerCase());
    this.sql.exec("INSERT INTO minted (nest_name, at_ms) VALUES (?, ?)", minted, Date.now());
    return minted;
  }

  private clientId(): string {
    return clientIdOf(this.env.NEST_CLIENT_TOKEN) ?? "cli_unknown";
  }

  /** The live agents holding a secret: in their sandbox's layer as last applied, until they exit or are stopped. */
  private holdersOf(name: string): { agent: string; role: string }[] {
    return this.sql.exec("SELECT agent, role, names FROM agent_secrets ORDER BY at_ms").toArray()
      .filter((r) => (JSON.parse(r.names as string) as string[]).includes(name)).map((r) => ({ agent: r.agent as string, role: r.role as string }));
  }

  async secrets(): Promise<Result<SecretView[]>> {
    if (!this.settings()) return fail(404, "unknown project");
    return ok(this.secretRows().map((m) => ({ ...m, holders: this.holdersOf(m.name) })));
  }

  /**
   * Record a secret's metadata, after the Worker stored its value in nest (when it set one): the value
   * never reaches this object. Open requests to inject one by that name are done, and their agents told.
   */
  async saveSecretMeta(
    m: Pick<SecretMeta, "name" | "description" | "hosts" | "locations" | "roles" | "env" | "nest_name">, size: number | null,
  ): Promise<Result<SecretView>> {
    if (!this.settings()) return fail(404, "unknown project");
    const before = this.secretRows().find((x) => x.name === m.name);
    if (!before && size === null) return fail(400, "a new secret needs a value");
    if (before) {
      // Its own name, as read when the write began; deleted (and perhaps made again) since: refused.
      if (before.nest_name !== m.nest_name) return fail(409, `${m.name} changed meanwhile: save it again`);
    } else {
      // A new one: under a name minted for it and not used yet, never a retired generation's.
      const fresh = this.sql.exec("DELETE FROM minted WHERE nest_name = ? RETURNING nest_name", m.nest_name).toArray().length;
      if (!fresh) return fail(409, `${m.name} changed meanwhile: save it again`);
    }
    const clash = this.secretRows().find((x) => x.name !== m.name && x.env === m.env);
    if (clash) return fail(409, `${clash.name} uses ${m.env} already`);
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO secrets (name, description, hosts, locations, roles, env, nest_name, size, created_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (name) DO UPDATE SET description = excluded.description, hosts = excluded.hosts, locations = excluded.locations, roles = excluded.roles,
          env = excluded.env, size = COALESCE(excluded.size, size), updated_ms = excluded.updated_ms`,
      m.name, m.description, JSON.stringify(m.hosts), JSON.stringify(m.locations), JSON.stringify(m.roles), m.env, m.nest_name, size, now, now,
    );
    // A binding or variable changed: owed to the live agents of each role it was or is for. A new value
    // alone changes no layer (nest pushes it to the proxies).
    const after = this.secretRows().find((x) => x.name === m.name)!;
    const shape = (x: SecretMeta | undefined) => x && JSON.stringify([x.hosts, x.locations, x.env]);
    const roles = new Set<SecretRole>([...(before?.roles ?? []), ...after.roles]);
    await this.oweLayers(LAYER_ROLES.filter((r) => roles.has(r) && (shape(before) !== shape(after) || before?.roles.includes(r) !== after.roles.includes(r))));
    for (const r of this.sql.exec("SELECT * FROM secret_requests WHERE done_ms IS NULL AND kind = 'injected' AND name = ?", m.name).toArray()) {
      this.finishRequest(r);
    }
    this.upkeepSoon();
    await this.arm();
    return ok({ ...after, holders: this.holdersOf(m.name) });
  }

  /** Forget a secret's metadata (the Worker deleted its value in nest first), and take it out of live layers. */
  async deleteSecretMeta(name: string): Promise<Result<{ deleted: string; holders: { agent: string; role: string }[] }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const holders = this.holdersOf(name);
    const gone = this.sql.exec<{ roles: string }>("DELETE FROM secrets WHERE name = ? RETURNING roles", name).toArray()[0];
    if (!gone) return fail(404, `no secret ${name}`);
    const roles = JSON.parse(gone.roles) as SecretRole[];
    this.upkeepSoon();
    await this.oweLayers(LAYER_ROLES.filter((r) => roles.includes(r)));
    return ok({ deleted: name, holders });
  }

  /**
   * A start attempt's sandbox spec: its role's bindings and variables, and `workflows: write` for a worker
   * when the setting is on. Frozen per attempt (`key`), so a retry after a lost answer sends the same
   * request its Idempotency-Key is bound to, however the secrets changed since: a change after the
   * attempt's first try is owed to the agent's layer once it's live (`trackLayer`). The brief names the
   * variables.
   */
  private async sandboxSpec(nest: Nest, role: SecretRole, key: string): Promise<StartSpec> {
    const had = this.frozenSpec(key);
    let frozen: StartSpec;
    if (had) frozen = had;
    else {
      // Inside the grant as it is now, or not at all: a binding nest would refuse fails the start (its read failing retries it).
      const injectHosts = (await nest.self()).grant?.inject_hosts ?? [];
      const again = this.frozenSpec(key);
      if (again) return again;
      // Everything else as it is now, after the await: a setting changed meanwhile (workflows turned
      // off, when nothing was frozen yet for that change to act on) must not freeze as it was before.
      const s = this.settings()!;
      const { inject, env, secrets: mine } = this.secretFeeds(role, injectHosts);
      const extras: SandboxExtras = {
        ...(inject.length ? { inject, env } : {}),
        ...(role === "worker" && s.workers_edit_workflows ? { github_push: { workflows: true } } : {}),
      };
      frozen = { extras, names: mine.map((m) => m.name), brief: secretsBrief(mine), rev: this.rules().rev };
      this.sql.exec("INSERT INTO start_specs (key, spec, at_ms) VALUES (?, ?, ?)", key, JSON.stringify(frozen), Date.now());
      this.sql.exec("DELETE FROM start_specs WHERE at_ms < ?", Date.now() - 7 * 24 * 3600 * 1000);
    }
    return frozen;
  }

  /** A start attempt's spec as first frozen, if it was. */
  private frozenSpec(key: string): StartSpec | null {
    const had = this.sql.exec<{ spec: string }>("SELECT spec FROM start_specs WHERE key = ?", key).toArray()[0];
    return had ? (JSON.parse(had.spec) as StartSpec) : null;
  }

  /** A reviewer's sandbox spec (ReviewDO starts reviewers): as a worker's, without workflows. */
  async reviewerSpec(key: string): Promise<StartSpec> {
    const nest = nestFrom(this.env);
    if (!this.settings() || !nest) return { extras: {}, names: [], brief: "", rev: 0 };
    return this.sandboxSpec(nest, "reviewer", key);
  }

  /**
   * A reviewer ReviewDO started: what it holds, and its layer, owed again if the secrets moved on since
   * its spec was frozen. Reviewers have a live layer as workers do (secrets only: no rules of their own).
   */
  async reviewerStarted(agent: string, key: string): Promise<void> {
    const spec = this.frozenSpec(key);
    if (!this.settings() || !spec) return;
    this.recordHolder(agent, "reviewer", spec.names);
    this.trackLayer(agent, "reviewer", spec.rev ?? 0);
    await this.arm();
  }

  /** An agent that's gone (a reviewer stopped): no layer to keep up, nothing it holds. */
  async agentEnded(agent: string): Promise<void> {
    this.sql.exec("DELETE FROM layers WHERE agent = ?", agent);
    this.sql.exec("DELETE FROM agent_secrets WHERE agent = ?", agent);
  }

  /** Which secrets an agent's sandbox has (so deleting one names it), and for a worker, whether its push token may change workflows. */
  private recordHolder(agent: string, role: string, names: string[], workflows = false): void {
    this.sql.exec(
      `INSERT INTO agent_secrets (agent, role, names, workflows, at_ms) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (agent) DO UPDATE SET names = excluded.names, at_ms = excluded.at_ms`,
      agent, role, JSON.stringify(names), workflows ? 1 : 0, Date.now(),
    );
  }

  /** The live workers whose push token may change workflows: kept until they end, whatever the setting says now. */
  workflowWorkers(): string[] {
    const live = new Set(this.liveAgents().filter((a) => a.role === "worker").map((a) => a.agent));
    return this.sql.exec<{ agent: string }>("SELECT agent FROM agent_secrets WHERE workflows = 1 ORDER BY at_ms").toArray().map((r) => r.agent).filter((a) => live.has(a));
  }

  /**
   * An agent asks the owner for a secret (`request_secret`): `injected`, one its sandbox should get
   * injected, or `ci`, one GitHub Actions needs. It's a "Needs you" item; never a value.
   */
  private requestSecret(caller: AgentCaller, a: Record<string, unknown>, task: string | null): Result<SecretRequest> {
    const kind = a.kind as "injected" | "ci";
    const name = (a.name as string).trim();
    if (kind === "injected" && !SECRET_NAME.test(name)) return fail(400, "an injected secret's name is lowercase letters, digits and _, starting with a letter, at most 31");
    if (kind === "ci" && (!/^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(name) || /^GITHUB_/i.test(name))) return fail(400, "an Actions secret's name is letters, digits and _, not starting with a digit or GITHUB_");
    const open = this.sql.exec("SELECT * FROM secret_requests WHERE done_ms IS NULL AND kind = ? AND name = ?", kind, name).toArray()[0];
    if (open) return ok(requestOf(open));
    if (kind === "injected" && this.sql.exec("SELECT 1 FROM secrets WHERE name = ?", name).toArray().length) {
      const m = this.secretRows().find((x) => x.name === name)!;
      // Only what this agent needs: whether it has it, and as what; nothing of the roles it isn't given to.
      return m.roles.includes(caller.role as SecretRole)
        ? fail(409, `${name} exists already: your sandbox has it as $${m.env} (in a moment, if it was added just now)`)
        : fail(409, `${name} exists already, but isn't given to your role: tell the owner why you need it`);
    }
    const id = `srq_${randomId()}`;
    const hosts = Array.isArray(a.hosts) ? (a.hosts as string[]) : null;
    this.sql.exec(
      "INSERT INTO secret_requests (id, kind, name, purpose, hosts, agent, role, task, tainted, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, kind, name, a.purpose as string, hosts ? JSON.stringify(hosts) : null, caller.agent, caller.role, task, caller.tainted ? 1 : 0, Date.now(),
    );
    if (task) this.record(task, { kind: "agent", agent: caller.agent, tainted: caller.tainted }, "secret_requested", { kind, name });
    return ok(requestOf(this.sql.exec("SELECT * FROM secret_requests WHERE id = ?", id).one()));
  }

  /** The owner marks a request done (a CI secret added on GitHub, or an injected one set up). */
  async secretRequestDone(id: string): Promise<Result<{ done: string }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const r = this.sql.exec("SELECT * FROM secret_requests WHERE id = ?", id).toArray()[0];
    if (!r) return fail(404, "unknown request");
    if (r.done_ms !== null) return fail(409, "already done");
    this.finishRequest(r);
    await this.arm();
    await this.drain();
    return ok({ done: id });
  }

  private finishRequest(r: Row): void {
    this.sql.exec("UPDATE secret_requests SET done_ms = ? WHERE id = ?", Date.now(), r.id);
    // Names only, the owner's act: nothing an agent wrote, so nothing relayed.
    const m = r.kind === "injected" ? this.secretRows().find((x) => x.name === r.name) : undefined;
    const text = r.kind === "ci"
      ? `The owner added the GitHub Actions secret ${r.name as string} you asked for.`
      : !m?.roles.includes(r.role as SecretRole)
        ? `The owner set up the secret ${r.name as string} you asked for, but not for your role (${r.role as string}): say so if you still need it.`
        : `The owner set up the secret ${r.name as string} you asked for. Your sandbox gets it as $${m.env} in a moment, in the commands you start from then on.`;
    this.oweMessage(r.agent as string, text, false);
  }

  // --- blocked --------------------------------------------------------------------------------------

  private clearBlock(id: string): void {
    this.sql.exec("UPDATE tasks SET blocked_ms = NULL, blocked_by = NULL, blocked_role = NULL, blocked_reason = NULL, blocked_question = NULL, blocked_tainted = NULL WHERE id = ?", id);
  }

  /** Owe an agent's inbox a message; `relayed` when its text came from a tainted session (nest's rule). */
  private oweMessage(agent: string, text: string, relayed: boolean): void {
    this.sql.exec("INSERT INTO messages (to_agent, text, relayed, at_ms, next_ms) VALUES (?, ?, ?, ?, ?)", agent, text, relayed ? 1 : 0, Date.now(), Date.now());
  }

  /**
   * An agent marks a task blocked (README.md#blocked): the manager any task, a worker its own (the
   * caller passes its labels' task). A worker's block is told to the manager.
   */
  private async block(id: string, caller: AgentCaller, by: "manager" | "worker", reason: string, question: string | null): Promise<Result<Task>> {
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    if (by === "worker" && r.assignee !== caller.agent) return fail(403, "only the task's own worker may block it");
    const may = canBlock(r.state as TaskState, r.blocked_ms !== null, by);
    if (!may.ok) return fail(409, may.error);
    this.sql.exec(
      "UPDATE tasks SET blocked_ms = ?, blocked_by = ?, blocked_role = ?, blocked_reason = ?, blocked_question = ?, blocked_tainted = ?, updated_ms = ? WHERE id = ?",
      Date.now(), caller.agent, by, reason, question, caller.tainted ? 1 : 0, Date.now(), id,
    );
    this.record(id, { kind: "agent", agent: caller.agent, tainted: caller.tainted }, "blocked", { reason, ...(question ? { question } : {}) });
    const manager = this.settings()!.manager;
    if (by === "worker" && manager) {
      this.oweMessage(manager, [
        `Worker ${caller.agent} blocked task ${id} ("${r.title as string}"). The owner sees it on the board.`,
        `Reason: ${reason}`, ...(question ? [`Question for the owner: ${question}`] : []),
      ].join("\n"), caller.tainted);
    }
    await this.arm();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** The manager, or the task's own worker, clears its block. */
  private async unblock(id: string, caller: AgentCaller, note: string | null): Promise<Result<Task>> {
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    if (caller.role === "worker" && r.assignee !== caller.agent) return fail(403, "only the task's own worker may clear its block");
    const may = canUnblock(r.blocked_ms !== null);
    if (!may.ok) return fail(409, may.error);
    this.clearBlock(id);
    this.record(id, { kind: "agent", agent: caller.agent, tainted: caller.tainted }, "unblocked", note ? { note } : undefined);
    // Its worker hears of a block it didn't clear itself (noteChange skips the worker's own).
    this.noteChange(id, "blocked", r.blocked_reason as string, null, { kind: "agent", agent: caller.agent, tainted: caller.tainted });
    await this.arm();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /**
   * The owner answers a blocked task: the block clears, and the answer goes to the agent that blocked
   * it, and to the manager too when a worker did.
   */
  async answerBlocked(id: string, answer: string): Promise<Result<Task>> {
    const s = this.settings();
    if (!s) return fail(404, "unknown project");
    const r = this.taskRow(id);
    if (!r) return fail(404, "unknown task");
    const may = canUnblock(r.blocked_ms !== null);
    if (!may.ok) return fail(409, may.error);
    const by = r.blocked_by as string;
    // The owner's words and the task's id only: nothing an agent wrote, so nothing relayed.
    this.oweMessage(by, `The owner answered your block on task ${id}:\n${answer}`, false);
    if (r.blocked_role === "worker" && s.manager && s.manager !== by) {
      this.oweMessage(s.manager, `The owner answered the block worker ${by} raised on task ${id}:\n${answer}`, false);
    }
    this.clearBlock(id);
    this.record(id, { kind: "owner" }, "block_answered", { answer, to: by });
    this.replyWaits(`answered the block on task ${id}`);
    // The worker that blocked it has the answer already; another live worker on it hears it's clear.
    if (by !== r.assignee) this.noteChange(id, "blocked", r.blocked_reason as string, null, { kind: "owner" });
    await this.arm();
    await this.drain();
    return ok(this.toTask(this.taskRow(id)!));
  }

  /** What's waiting on the owner: open asks and blocked tasks, together, oldest first. */
  async attention(): Promise<Result<Attention[]>> {
    const asks = await this.asks();
    if (!asks.ok) return asks;
    const blocked = this.sql.exec(`${TASK_SELECT} WHERE t.blocked_ms IS NOT NULL`).toArray().map((r): Attention => ({
      kind: "blocked", task: r.id as string, title: r.title as string, state: r.state as TaskState, ...blockedOf(r)!,
    }));
    const open = asks.value.filter((a) => a.answered_ms === null).map((a): Attention => ({ kind: "ask", ...a }));
    const secrets = this.sql.exec("SELECT * FROM secret_requests WHERE done_ms IS NULL").toArray().map((r): Attention => ({ kind: "secret", ...requestOf(r) }));
    return ok([...open, ...blocked, ...secrets].sort((a, b) => a.at_ms - b.at_ms));
  }

  /** How many things wait on the owner (the projects list's count). */
  async attentionCount(): Promise<number> {
    if (!this.settings()) return 0;
    return this.sql.exec<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM asks WHERE answered_ms IS NULL) + (SELECT COUNT(*) FROM tasks WHERE blocked_ms IS NOT NULL) + (SELECT COUNT(*) FROM secret_requests WHERE done_ms IS NULL) AS n",
    ).one().n;
  }

  // --- chat and approvals ----------------------------------------------------------------------------

  async chat(limit = 200): Promise<Result<ChatMessage[]>> {
    if (!this.settings()) return fail(404, "unknown project");
    const rows = this.sql.exec("SELECT seq, at_ms, sender, text, next_ms, error FROM chat ORDER BY seq DESC LIMIT ?", limit).toArray().reverse();
    return ok(rows.map((r) => ({
      seq: r.seq as number, at_ms: r.at_ms as number, sender: r.sender as string, text: r.text as string,
      delivered: r.next_ms === null && r.error === null, error: (r.error as string | null) ?? null,
    })));
  }

  /** The owner says something to the manager: logged, and owed to its inbox. */
  async postChat(text: string): Promise<Result<{ seq: number; delivered: boolean }>> {
    const s = this.settings();
    if (!s) return fail(404, "unknown project");
    const seq = this.sql.exec<{ seq: number }>("INSERT INTO chat (at_ms, sender, text, next_ms) VALUES (?, 'owner', ?, ?) RETURNING seq", Date.now(), text, Date.now()).one().seq;
    this.replyWaits("replied in chat");
    await this.arm();
    await this.drain();
    const r = this.sql.exec("SELECT next_ms, error FROM chat WHERE seq = ?", seq).one();
    return ok({ seq, delivered: r.next_ms === null && r.error === null });
  }

  async asks(): Promise<Result<Ask[]>> {
    if (!this.settings()) return fail(404, "unknown project");
    return ok(this.sql.exec("SELECT * FROM asks ORDER BY at_ms").toArray().map((r) => ({
      ask: r.ask as string, agent: r.agent as string, role: (r.role as string | null) ?? null, task: (r.task as string | null) ?? null,
      question: (r.question as string | null) ?? null, approval: r.approval ? JSON.parse(r.approval as string) : null,
      at_ms: r.at_ms as number, answered_ms: (r.answered_ms as number | null) ?? null,
    })));
  }

  async answerAsk(ask: string, answer: string): Promise<Result<{ delivered: unknown }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const r = this.sql.exec("SELECT agent, answered_ms FROM asks WHERE ask = ?", ask).toArray()[0];
    if (!r) return fail(404, "unknown ask");
    if (r.answered_ms !== null) return fail(409, "already answered");
    const nest = nestFrom(this.env);
    if (!nest) return fail(503, "NEST_CLIENT_TOKEN is not set");
    try {
      const out = await nest.answerAsk(r.agent as string, ask, answer);
      this.sql.exec("UPDATE asks SET answered_ms = ?, answer = ? WHERE ask = ?", Date.now(), answer, ask);
      this.replyWaits(`answered ask ${ask}`);
      await this.arm();
      return ok(out);
    } catch (e) {
      return e instanceof NestError ? fail(e.status === 404 ? 404 : 502, e.message) : fail(502, String(e));
    }
  }

  // --- nest's events ---------------------------------------------------------------------------------

  /** An event about one of this project's agents (the Worker verified and routed it). Idempotent. */
  async onEvent(e: NestEvent, route: { role: string | null; task: string | null }): Promise<void> {
    const s = this.settings();
    if (!s) return;
    switch (e.type) {
      case "agent.turn_completed":
        if (route.role === "manager" && e.text) {
          this.sql.exec("INSERT OR IGNORE INTO chat (at_ms, sender, text, event_id) VALUES (?, 'manager', ?, ?)", Date.now(), e.text, e.id);
        }
        break;
      case "agent.exited":
        if (route.role === "manager" && s.manager === e.agent) {
          this.sql.exec("INSERT OR IGNORE INTO chat (at_ms, sender, text, event_id) VALUES (?, 'app', ?, ?)", Date.now(), `The manager ended (${e.reason ?? "exited"}).`, e.id);
        }
        if (route.role === "worker") this.workerExited(e.agent, e.reason, e.text);
        this.sql.exec("DELETE FROM agent_secrets WHERE agent = ?", e.agent);
        break;
      case "agent.ask":
        this.sql.exec(
          "INSERT OR IGNORE INTO asks (ask, agent, role, task, question, approval, at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
          e.ask, e.agent, route.role, route.task, e.question ?? null, e.approval === undefined ? null : JSON.stringify(e.approval), Date.now(),
        );
        break;
      case "agent.error":
        this.sql.exec("INSERT OR IGNORE INTO errors (event_id, at_ms, agent, role, task, code, message) VALUES (?, ?, ?, ?, ?, ?, ?)",
          e.id, Date.now(), e.agent, route.role, route.task, e.code ?? null, e.message ?? null);
        break;
    }
    await this.arm();
  }

  /** A worker ended: its task stalls unless its PR is open or it's over; its place frees. */
  private workerExited(agent: string, reason?: string, text?: string): void {
    this.sql.exec("DELETE FROM stops WHERE agent = ?", agent);
    this.sql.exec("DELETE FROM layers WHERE agent = ?", agent);
    const r = this.sql.exec("SELECT id, state FROM tasks WHERE assignee = ?", agent).toArray()[0];
    if (!r) return;
    const id = r.id as string;
    this.sql.exec("UPDATE tasks SET worker_live = 0 WHERE id = ?", id);
    if (r.state === "assigned" || r.state === "in_progress") {
      this.move(id, "worker_exited", { kind: "app", what: "nest" }, { agent, reason: reason ?? null, text: text?.slice(0, 2000) ?? null });
    }
    this.autoAssign();
  }

  async errors(): Promise<Result<unknown[]>> {
    if (!this.settings()) return fail(404, "unknown project");
    return ok(this.sql.exec("SELECT at_ms, agent, role, task, code, message FROM errors ORDER BY seq DESC LIMIT 100").toArray());
  }

  // --- waits (README.md#waiting) ------------------------------------------------------------------------

  private waitRow(id: string): Wait | undefined {
    const r = this.sql.exec("SELECT * FROM waits WHERE id = ?", id).toArray()[0];
    return r ? toWait(r) : undefined;
  }

  /** Pending waits, oldest first; of one kind and target when given. */
  private pendingWaits(kind?: WaitKind, target?: string): Wait[] {
    const rows = kind
      ? this.sql.exec("SELECT * FROM waits WHERE resolved_ms IS NULL AND kind = ? AND target IS ? ORDER BY created_ms", kind, target ?? null).toArray()
      : this.sql.exec("SELECT * FROM waits WHERE resolved_ms IS NULL ORDER BY created_ms").toArray();
    return rows.map(toWait);
  }

  /** The Manager page's view: what's pending, and the last few that ended. */
  async waits(): Promise<Result<{ pending: Wait[]; recent: Wait[] }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const recent = this.sql.exec("SELECT * FROM waits WHERE resolved_ms IS NOT NULL ORDER BY resolved_ms DESC LIMIT 10").toArray().map(toWait);
    return ok({ pending: this.pendingWaits(), recent });
  }

  /**
   * Resolve a pending wait, once: the row changes only while it's pending, in one step, and only then is
   * the manager told (`notify`). A condition and a deadline racing each other resolve it exactly once.
   */
  private resolveWait(id: string, outcome: WaitOutcome, detail: string, notify = true): boolean {
    const w = this.waitRow(id);
    if (!w || w.resolved_ms !== null) return false;
    const now = Date.now();
    const done = this.sql.exec("UPDATE waits SET resolved_ms = ?, outcome = ?, detail = ? WHERE id = ? AND resolved_ms IS NULL", now, outcome, detail, id).rowsWritten;
    if (!done) return false;
    const manager = this.settings()?.manager;
    if (notify && manager) this.oweMessage(manager, waitMessage(w, outcome, detail, now), false);
    return true;
  }

  /**
   * The manager waits (`await_task`, `await_pr`, `await_reply`): the same condition pending already is
   * the same wait. A condition that holds already answers at once, with no wait left behind. Otherwise
   * the wait is recorded with its deadline and the manager is told when it resolves.
   */
  private async registerWait(kind: WaitKind, target: string | null, want: Wait["want"], timeout: unknown): Promise<Result<unknown>> {
    const bad = timeoutProblem(timeout);
    if (bad) return fail(400, bad);
    if (kind === "task") {
      const t = this.taskRow(target!);
      if (!t) return fail(404, "unknown task");
      const v = taskVerdict(want as TaskState[], t.state as TaskState, TERMINAL);
      if (v) return ok({ status: v.outcome, detail: `task ${target}: ${v.detail}` });
    }
    const key = waitKey(kind, target, want);
    const prior = this.sql.exec("SELECT * FROM waits WHERE key = ? AND resolved_ms IS NULL", key).toArray()[0];
    if (prior) return ok({ status: "waiting", wait: toWait(prior), note: "already waiting for this: the same wait" });
    if (this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM waits WHERE resolved_ms IS NULL").one().n >= MAX_WAITS) {
      return fail(409, `at most ${MAX_WAITS} waits at once: cancel one with cancel_wait`);
    }
    const id = `aw_${randomId()}`;
    const now = Date.now();
    this.sql.exec("INSERT INTO waits (id, kind, target, want, key, created_ms, deadline_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, kind, target, want === null ? null : JSON.stringify(want), key, now, now + (timeout as number) * 1000);
    await this.arm();
    // A PR's state is the review queue's: read after the wait is recorded, so an end that lands meanwhile
    // resolves it either way (each resolves it at most once).
    if (kind === "pr") {
      const pr = Number(target);
      const jobs = (await review(this.env, this.settings()!.id).jobs()).filter((j) => j.pr === pr);
      // A PR attached to a task is recorded merged once it is (README.md#prs).
      const merged = this.sql.exec("SELECT 1 FROM task_prs WHERE pr = ? AND state = 'merged'", pr).toArray().length > 0;
      const latest = jobs[0];
      if (merged) this.prWaitOn(this.waitRow(id)!, { kind: "merged" });
      // Closed before its review finished, merged or not (the queue doesn't say): a wait to merge stays.
      else if (latest?.state === "closed" && want !== "merged") this.prWaitOn(this.waitRow(id)!, { kind: "closed" });
      else if (latest && (latest.state === "done" || latest.state === "failed")) this.prWaitOn(this.waitRow(id)!, { kind: "review", conclusion: reviewConclusion(latest) });
      const w = this.waitRow(id)!;
      if (w.resolved_ms !== null) return ok({ status: w.outcome, detail: `PR #${pr}: ${w.detail}` });
    }
    return ok({ status: "waiting", wait: this.waitRow(id), note: "end your turn: a message in your inbox says when it resolves or times out" });
  }

  /** A task's waits on its new state. */
  private taskWaitsOn(id: string, state: TaskState): void {
    for (const w of this.pendingWaits("task", id)) {
      const v = taskVerdict(w.want as TaskState[], state, TERMINAL);
      if (v) this.resolveWait(w.id, v.outcome, v.detail);
    }
  }

  private prWaitOn(w: Wait, e: Parameters<typeof prVerdict>[1]): void {
    const v = prVerdict(w.want as PrUntil, e);
    if (v) this.resolveWait(w.id, v.outcome, v.detail);
  }

  /** The owner replied (in chat, or to something in "Needs you"): every reply wait is met. */
  private replyWaits(how: string): void {
    for (const w of this.pendingWaits("reply")) this.resolveWait(w.id, "met", how);
  }

  /** The review queue ended a PR's review (ReviewDO's outbox): `done` with a verdict, or `failed`. */
  async onReviewEnded(e: { pr: number; sha: string; state: string; conclusion: string | null }): Promise<void> {
    if (!this.settings()) return;
    for (const w of this.pendingWaits("pr", String(e.pr))) this.prWaitOn(w, { kind: "review", conclusion: e.conclusion ?? e.state });
    await this.arm();
  }

  // --- network (README.md#network) ----------------------------------------------------------------------

  /** The rules per role, as stored (normalized), and their revision. */
  private rules(): { rules: RoleRules; rev: number } {
    const r = this.settingsRow();
    return { rules: r?.network ? { ...NO_RULES, ...(JSON.parse(r.network as string) as RoleRules) } : NO_RULES, rev: (r?.network_rev as number | undefined) ?? 0 };
  }

  /** The app's live agents with a client layer: the manager, each live worker, and each reviewer ReviewDO hasn't stopped. */
  private liveAgents(): { agent: string; role: LayerRole }[] {
    const s = this.settings();
    const workers = this.sql.exec<{ assignee: string }>("SELECT assignee FROM tasks WHERE worker_live = 1 AND assignee IS NOT NULL").toArray();
    const reviewers = this.sql.exec<{ agent: string }>("SELECT agent FROM layers WHERE role = 'reviewer'").toArray();
    return [
      ...(s?.manager ? [{ agent: s.manager, role: "manager" as const }] : []), ...workers.map((w) => ({ agent: w.assignee, role: "worker" as const })),
      ...reviewers.map((r) => ({ agent: r.agent, role: "reviewer" as const })),
    ];
  }

  /** The page's view: the rules, and each live agent's layer (applied, pending or failed). */
  async network(): Promise<Result<{ rules: RoleRules; rev: number; agents: LayerStatus[] }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const { rules, rev } = this.rules();
    const live = new Set(this.liveAgents().map((a) => a.agent));
    const agents = this.sql.exec("SELECT * FROM layers ORDER BY role, agent").toArray().filter((r) => live.has(r.agent as string)).map((r): LayerStatus => ({
      agent: r.agent as string, role: r.role as LayerRole, sandbox: (r.sandbox as string | null) ?? null,
      state: r.error !== null && r.next_ms === null ? "failed" : r.rev === r.want_rev && r.next_ms === null ? "applied" : "pending",
      error: (r.error as string | null) ?? null, rev: (r.rev as number | null) ?? null, at_ms: (r.at_ms as number | null) ?? null,
    }));
    return ok({ rules, rev, agents });
  }

  /** The manager's sandbox, if known (the operator's base policy is read from it). */
  async managerSandbox(): Promise<string | null> {
    const m = this.settings()?.manager;
    if (!m) return null;
    return (this.sql.exec<{ sandbox: string | null }>("SELECT sandbox FROM layers WHERE agent = ?", m).toArray()[0]?.sandbox) ?? null;
  }

  /**
   * New rules (the caller checked them against the grant): stored with a new revision, and owed to
   * every live agent of a role whose rules changed, through its sandbox's client layer.
   */
  async setNetwork(next: RoleRules): Promise<Result<{ rules: RoleRules; rev: number; agents: LayerStatus[] }>> {
    if (!this.settings()) return fail(404, "unknown project");
    const before = this.rules();
    const rules: RoleRules = { worker: normalizeRules(next.worker), manager: normalizeRules(next.manager) };
    const changed = NETWORK_ROLES.filter((r) => JSON.stringify(rules[r]) !== JSON.stringify(before.rules[r]));
    if (changed.length) {
      this.sql.exec("UPDATE settings SET network = ?", JSON.stringify(rules));
      await this.oweLayers(changed);
      await this.drain();
    }
    return this.network();
  }

  /**
   * Something a client layer is built from changed for `roles` (their rules, or their secrets): a new
   * revision, owed to each live agent of those roles. One revision for both, so each agent has one status.
   */
  private async oweLayers(roles: readonly LayerRole[]): Promise<void> {
    if (!roles.length) return;
    const rev = this.rules().rev + 1;
    this.sql.exec("UPDATE settings SET network_rev = ?", rev);
    for (const a of this.liveAgents()) {
      if (!roles.includes(a.role)) continue;
      this.sql.exec(
        `INSERT INTO layers (agent, role, want_rev, next_ms) VALUES (?, ?, ?, ?)
          ON CONFLICT (agent) DO UPDATE SET want_rev = excluded.want_rev, next_ms = excluded.next_ms, attempts = 0, error = NULL`,
        a.agent, a.role, rev, Date.now(),
      );
    }
    await this.arm();
  }

  /** The rules a start attempt uses, fixed at its first try: its sandbox's Idempotency-Key binds the request. */
  private frozenEgress(key: string, role: NetworkRole): { rev: number; egress: EgressRule[] } {
    const r = this.sql.exec<{ rev: number; egress: string }>("SELECT rev, egress FROM frozen_egress WHERE key = ?", key).toArray()[0];
    if (r) return { rev: r.rev, egress: JSON.parse(r.egress) as EgressRule[] };
    const { rules, rev } = this.rules();
    this.sql.exec("INSERT INTO frozen_egress (key, rev, egress) VALUES (?, ?, ?)", key, rev, JSON.stringify(rules[role]));
    return { rev, egress: rules[role] };
  }

  /** A new agent's layer: applied as of its start's rules; owed again if the rules moved on since. */
  private trackLayer(agent: string, role: LayerRole, rev: number): void {
    const want = this.rules().rev;
    this.sql.exec(
      `INSERT INTO layers (agent, role, rev, want_rev, next_ms, at_ms) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (agent) DO NOTHING`,
      agent, role, rev, want, rev === want ? null : Date.now(), Date.now(),
    );
  }

  /**
   * Bring a live agent's sandbox's client layer to the current rules and secrets: read the layer (so
   * the parts other pages own stay as they are), build it with `clientLayerFor` from what's inside the
   * grant as it is now, and replace it. A refusal that will repeat is shown, not retried; anything else
   * is retried from the alarm. Either way, or when the grant can't be read, what the change removes is
   * applied first (`shrinkLayer`): a revocation never waits on something nest refuses.
   */
  private async applyLayer(nest: Nest, agent: string): Promise<void> {
    const row = this.sql.exec("SELECT * FROM layers WHERE agent = ?", agent).toArray()[0];
    if (!row) return;
    const role = row.role as LayerRole;
    const want = row.want_rev as number;
    let sandbox = (row.sandbox as string | null) ?? null;
    let current: Awaited<ReturnType<Nest["getClientPolicy"]>> | null = null;
    let desired: ClientLayer | null = null;
    // The layer for a grant: inside it; for none (unread), everything, as the target a removal is cut from.
    const build = (g: Grant | null) => {
      const feeds = this.secretFeeds(role, g ? (g.inject_hosts ?? []) : null);
      const layer = egressWithinGrant(clientLayerFor(this.rules().rules, role, { inject: feeds.inject, env: feeds.env }, current), g ? (g.egress_hosts ?? null) : null);
      return { layer, names: feeds.secrets.map((m) => m.name) };
    };
    try {
      if (!sandbox) {
        const view = await nest.getAgent(agent);
        sandbox = (view.hands as { sandbox?: string } | null | undefined)?.sandbox ?? null;
        if (!sandbox) throw new NestError(409, "no_sandbox", "the agent has no sandbox", false);
        this.sql.exec("UPDATE layers SET sandbox = ? WHERE agent = ?", sandbox, agent);
      }
      current = await nest.getClientPolicy(sandbox);
      let grant = await this.readGrant(nest);
      let built = build(grant);
      desired = built.layer;
      if (grant === null) throw new NestError(503, "grant_unread", "the grant couldn't be read: removals applied, the rest retried", false);
      try {
        await nest.putClientPolicy(sandbox, desired);
      } catch (e) {
        // Refused: perhaps the grant narrowed since it was read. Read it again and rebuild, once.
        if (!(e instanceof NestError && e.status === 403)) throw e;
        grant = await this.readGrant(nest);
        if (grant === null) throw e;
        built = build(grant);
        desired = built.layer;
        await nest.putClientPolicy(sandbox, desired);
      }
      this.recordHolder(agent, role, built.names);
      // Applied as of `want`; a newer change meanwhile stays owed.
      this.sql.exec(
        "UPDATE layers SET rev = ?, attempts = 0, error = NULL, at_ms = ?, next_ms = CASE WHEN want_rev = ? THEN NULL ELSE ? END WHERE agent = ?",
        want, Date.now(), want, Date.now(), agent,
      );
    } catch (e) {
      const attempts = (row.attempts as number) + 1;
      if (e instanceof NestError && e.status === 404) {
        this.sql.exec("DELETE FROM layers WHERE agent = ?", agent);
        return;
      }
      let note = "";
      if (sandbox && current && desired) {
        const safe = shrinkLayer(current, desired);
        const asIs: ClientLayer = { egress: { allow: normalizeRules(current.egress.allow) }, inject: current.inject.map(asBinding), env: current.env };
        if (JSON.stringify(safe) !== JSON.stringify(asIs)) {
          try {
            await nest.putClientPolicy(sandbox, safe);
            const kept = new Set(safe.inject.map((b) => b.name));
            const held = this.sql.exec<{ names: string }>("SELECT names FROM agent_secrets WHERE agent = ?", agent).toArray()[0];
            if (held) this.recordHolder(agent, role, (JSON.parse(held.names) as string[]).filter((n) => kept.has(n)));
            note = " (what it removes is applied)";
          } catch (e2) {
            note = ` (its removals failed too: ${message(e2)})`;
          }
        }
      }
      const permanent = e instanceof NestError && e.permanent;
      this.sql.exec("UPDATE layers SET attempts = ?, error = ?, next_ms = ? WHERE agent = ? AND want_rev = ?",
        attempts, message(e) + note, permanent ? null : Date.now() + backoff(attempts), agent, want);
    }
  }

  /** The grant, or null when it can't be read; a change from the one last seen owes every live layer. */
  private async readGrant(nest: Nest): Promise<Grant | null> {
    const g = await nest.self().then((x) => x.grant ?? {}, () => null);
    if (g) await this.grantSeen(g);
    return g;
  }

  /**
   * The grant as read (here, or by the Worker): when its hosts changed since last seen, every live layer
   * is owed again, so a secret left out for a narrowed grant comes back once it's widened, and goes
   * once it's narrowed, without anyone saving anything.
   */
  async grantSeen(g: Grant): Promise<void> {
    const seen = JSON.stringify({ inject: [...(g.inject_hosts ?? [])].sort(), egress: g.egress_hosts ? [...g.egress_hosts].sort() : null });
    const before = this.settingsRow()?.grant_seen as string | null | undefined;
    if (before === undefined || before === seen) return;
    this.sql.exec("UPDATE settings SET grant_seen = ?", seen);
    if (before !== null) {
      await this.oweLayers(LAYER_ROLES);
      // Applied in this drain, not the next alarm's; once per drain, so a flapping grant can't loop it.
      if (this.draining && !this.reowed) {
        this.reowed = true;
        this.again = true;
      }
    }
  }

  /** The secrets' upkeep is due soon: after a write, once the grace for retired names has passed. */
  private upkeepSoon(): void {
    const at = Date.now() + SWEEP_GRACE_MS;
    this.sql.exec("UPDATE settings SET secrets_next_ms = MIN(COALESCE(secrets_next_ms, ?), ?)", at, at);
  }

  /**
   * The secrets' upkeep, every few minutes while the project has secrets: the grant read (a change owes
   * every layer, `grantSeen`), and the sweep. A nest secret of this project's that no row names, and no
   * write in flight is about to (`minted`, recent), is an orphan (a retired generation, or a write that
   * failed before its cleanup): it's never injected, but counts against the grant's `max_count`. Deleted
   * once older than the grace, so a layer still naming a retired one has moved on first.
   */
  private async secretsUpkeep(nest: Nest): Promise<void> {
    const s = this.settings()!;
    const now = Date.now();
    this.sql.exec("DELETE FROM minted WHERE at_ms < ?", now - MINTED_TTL_MS);
    try {
      await this.readGrant(nest);
      const named = new Set([
        ...this.secretRows().map((m) => m.nest_name),
        ...this.sql.exec<{ nest_name: string }>("SELECT nest_name FROM minted").toArray().map((r) => r.nest_name),
      ]);
      for (const x of await nest.listSecrets()) {
        if (!x.name.startsWith(`${s.id}-`) || named.has(x.name)) continue;
        // Of unknown age (a listing without times): never swept, rather than taken as new-made-long-ago.
        const at = x.updated_ms ?? x.created_ms;
        if (typeof at !== "number" || now - at < SWEEP_GRACE_MS) continue;
        try {
          await nest.deleteSecret(x.name);
        } catch (e) {
          if (!(e instanceof NestError && e.status === 404)) console.error(`secrets sweep: ${x.name} wasn't deleted: ${message(e)}`);
        }
      }
    } catch (e) {
      console.error(`secrets upkeep: ${message(e)}`);
    }
    const more = this.secretRows().length > 0 || this.sql.exec("SELECT 1 FROM minted").toArray().length > 0;
    this.sql.exec("UPDATE settings SET secrets_next_ms = ?", more ? now + UPKEEP_EVERY_MS : null);
  }

  // --- the MCP tools ---------------------------------------------------------------------------------

  /**
   * One `tools/call` from an agent of this project (src/mcp.ts checked its identity and role). Its scope
   * is its labels: the manager this project's board, a worker its own task only. A write with a call key
   * of the caller's own is answered once: a retry gets the first answer.
   */
  async mcpCall(server: Server, caller: AgentCaller, tool: string, args: Record<string, unknown>, callKey: string | null): Promise<{ result: string | null; error: string | null }> {
    const def = toolOf(server, tool);
    if (!def) return { result: null, error: `unknown tool ${tool}` };
    const bad = invalid(def.inputSchema, args);
    if (bad) return { result: null, error: bad };
    const s = this.settings();
    if (!s || caller.labels.project !== s.id) return { result: null, error: "unknown project" };
    const key = !def.readOnly && callKey && callKey.startsWith(`${caller.agent}/`) ? callKey : null;
    if (key) {
      const prior = this.sql.exec<{ result: string }>("SELECT result FROM mcp_calls WHERE key = ?", key).toArray()[0];
      if (prior) return JSON.parse(prior.result) as { result: string | null; error: string | null };
    }
    const r = await this.runTool(server, caller, tool, args);
    const out = r.ok ? { result: JSON.stringify(r.value), error: null } : { result: null, error: r.error };
    if (key) {
      this.sql.exec("INSERT OR REPLACE INTO mcp_calls (key, result, at_ms) VALUES (?, ?, ?)", key, JSON.stringify(out), Date.now());
      this.sql.exec("DELETE FROM mcp_calls WHERE at_ms < ?", Date.now() - CALLS_KEEP_MS);
    }
    return out;
  }

  private async runTool(server: Server, caller: AgentCaller, tool: string, a: Record<string, unknown>): Promise<Result<unknown>> {
    const actor: Actor = { kind: "agent", agent: caller.agent, tainted: caller.tainted };
    if (server === "board") {
      switch (tool) {
        case "list_tasks": {
          const tasks = (await this.listTasks());
          if (!tasks.ok) return tasks;
          return ok({ project: this.settings(), tasks: tasks.value.map(({ body: _b, spec, ...t }) => ({ ...t, specced: spec !== null })) });
        }
        case "get_task":
          return this.getTask(a.task as string);
        case "create_task":
          return this.createTask({ title: a.title as string, body: (a.body as string | undefined) ?? "" }, actor);
        case "write_spec":
          return this.writeSpec(a.task as string, {
            goal: a.goal as string, acceptance_criteria: a.acceptance_criteria as string[], files: a.files as string[], test_plan: a.test_plan as string,
          }, actor);
        case "update_task":
          return this.updateTask(a.task as string, { ...(a.title !== undefined ? { title: a.title as string } : {}), ...(a.body !== undefined ? { body: a.body as string } : {}) }, actor);
        case "assign_task":
          return this.assign(a.task as string, actor, { wait: false });
        case "cancel_task":
          return this.cancel(a.task as string, actor, a.reason as string | undefined);
        case "attach_pr":
          return this.attachPrByNumber(a.task as string, a.pr as number, actor);
        case "detach_pr":
          return this.detachPr(a.task as string, a.pr as number, actor);
        case "add_dependency":
          return this.addDependency(a.task as string, a.blocked_by as string, actor);
        case "remove_dependency":
          return this.removeDependency(a.task as string, a.blocked_by as string, actor);
        case "request_secret":
          return this.requestSecret(caller, a, null);
        case "block_task":
          return this.block(a.task as string, caller, "manager", a.reason as string, (a.question as string | undefined) ?? null);
        case "unblock_task":
          return this.unblock(a.task as string, caller, (a.note as string | undefined) ?? null);
        case "await_task":
          return this.registerWait("task", a.task as string, a.states as TaskState[], a.timeout_s);
        case "await_pr":
          return this.registerWait("pr", String(a.pr), a.until as PrUntil, a.timeout_s);
        case "await_reply":
          return this.registerWait("reply", null, null, a.timeout_s);
        case "cancel_wait": {
          const w = this.waitRow(a.wait as string);
          if (!w) return fail(404, "unknown wait");
          if (w.resolved_ms !== null) return ok({ wait: w.id, outcome: w.outcome, detail: w.detail });
          this.resolveWait(w.id, "cancelled", "by the manager", false);
          await this.arm();
          return ok({ wait: w.id, outcome: "cancelled" });
        }
        case "list_waits":
          return ok({ waits: this.pendingWaits() });
      }
    }
    if (server === "task") {
      // A worker's whole scope is the task its labels name: no tool takes another task's id.
      const id = caller.labels.task!;
      const r = this.taskRow(id);
      if (!r) return fail(404, "unknown task");
      switch (tool) {
        case "get_task": {
          const t = this.toTask(r);
          return ok({
            id: t.id, title: t.title, body: t.body, spec: t.spec, state: t.state, pr: t.pr, prs: t.prs.map((p) => ({ number: p.number, state: p.state })),
            // What it waits on, and each one's state: it shouldn't build on a dependency that isn't done.
            dependencies: t.blocked_by, repo: this.settings()!.repo, branch: taskBranch(t.id),
          });
        }
        case "report_progress":
          if (TERMINAL.has(r.state as TaskState)) return fail(409, `the task is ${r.state}`);
          this.record(id, actor, "progress", a.text as string);
          return ok({ recorded: true });
        // Only its own task: the id is its labels', never an argument.
        case "request_secret":
          return this.requestSecret(caller, a, id);
        case "report_blocked":
          return this.block(id, caller, "worker", a.reason as string, (a.question as string | undefined) ?? null);
        case "clear_blocked":
          return this.unblock(id, caller, (a.note as string | undefined) ?? null);
        case "report_pr": {
          const may = transition(r.state as TaskState, "pr_opened");
          if (!may.ok) return fail(409, may.error);
          const at = this.attachPr(id, { pr: a.number as number, node: null, fork: null, title: null }, actor);
          if (!at.ok) return at;
          await this.arm();
          return ok({ task: id, state: at.value.state, pr: a.number, prs: at.value.prs.map((p) => p.number) });
        }
      }
    }
    return fail(400, `unknown tool ${tool}`);
  }

  // --- work owed to nest -----------------------------------------------------------------------------

  /** Arm the alarm for the earliest work owed (in the step that owed it). */
  private async arm(): Promise<void> {
    // Separate queries: the platform's SQLite caps the terms of one compound SELECT.
    const min = (q: string) => this.sql.exec<{ t: number | null }>(q).one().t;
    const times = [
      min(`SELECT MIN(t) AS t FROM (
        SELECT manager_next_ms AS t FROM settings WHERE manager_next_ms IS NOT NULL AND attached_ms IS NOT NULL
        UNION ALL SELECT attach_next_ms FROM settings WHERE attach_next_ms IS NOT NULL
        UNION ALL SELECT start_next_ms FROM tasks WHERE state = 'assigned' AND start_next_ms IS NOT NULL
        UNION ALL SELECT next_ms FROM stops
        UNION ALL SELECT next_ms FROM chat WHERE next_ms IS NOT NULL)`),
      // The manager's waits' deadlines, and client layers owed to live sandboxes.
      min(`SELECT MIN(t) AS t FROM (
        SELECT deadline_ms AS t FROM waits WHERE resolved_ms IS NULL
        UNION ALL SELECT next_ms FROM layers WHERE next_ms IS NOT NULL
        UNION ALL SELECT secrets_next_ms FROM settings WHERE secrets_next_ms IS NOT NULL)`),
      // Auto-merge: the repo's setting to write or read, and each task PR's change (an enable only once
      // the repo allows it).
      min(`SELECT MIN(t) AS t FROM (
        SELECT am_write_next_ms AS t FROM settings WHERE am_write_next_ms IS NOT NULL
        UNION ALL SELECT am_read_next_ms FROM settings WHERE am_read_next_ms IS NOT NULL
        UNION ALL SELECT next_ms FROM messages WHERE next_ms IS NOT NULL
        UNION ALL SELECT notify_next_ms FROM tasks WHERE notify_next_ms IS NOT NULL
        UNION ALL SELECT p.am_next_ms FROM task_prs p, settings s WHERE p.am_next_ms IS NOT NULL
          AND (p.am_owed = 'disable' OR (s.am_write_next_ms IS NULL AND s.am_write_error IS NULL)))`),
    ].filter((t): t is number => t !== null);
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
    this.reowed = false;
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
    const s = this.settingsRow();
    if (!s) return;
    // A wait whose deadline passed times out here, in one step, unless its condition resolved it first.
    for (const r of this.sql.exec("SELECT id FROM waits WHERE resolved_ms IS NULL AND deadline_ms <= ?", Date.now()).toArray()) {
      this.resolveWait(r.id as string, "timed_out", "timed out");
    }
    const nest = nestFrom(this.env);
    if (!nest) return;
    const now = Date.now();
    if (s.attach_next_ms !== null && (s.attach_next_ms as number) <= now) await this.attachRepo(nest);
    if (s.secrets_next_ms !== null && (s.secrets_next_ms as number) <= now) await this.secretsUpkeep(nest);
    if (s.am_write_next_ms !== null && (s.am_write_next_ms as number) <= now) await this.writeRepoAutoMerge(nest);
    if (s.am_read_next_ms !== null && (s.am_read_next_ms as number) <= now) await this.readRepoAutoMerge(nest);
    // A PR's auto-merge is enabled only once the repo allows it; disabling needn't wait.
    const w = this.settingsRow()!;
    const repoReady = w.am_write_next_ms === null && w.am_write_error === null;
    for (const r of this.sql.exec("SELECT pr, am_owed FROM task_prs WHERE am_next_ms IS NOT NULL AND am_next_ms <= ?", now).toArray()) {
      if (r.am_owed === "disable" || repoReady) await this.prAutoMerge(nest, r.pr as number);
    }
    // The manager starts once the repo is attached (README.md#flows).
    const a = this.settingsRow()!;
    if (a.attached_ms !== null && a.manager_next_ms !== null && (a.manager_next_ms as number) <= now) await this.startManager(nest);
    for (const r of this.sql.exec("SELECT id FROM tasks WHERE state = 'assigned' AND start_next_ms IS NOT NULL AND start_next_ms <= ? ORDER BY ord", now).toArray()) {
      await this.startWorker(nest, r.id as string);
    }
    for (const r of this.sql.exec("SELECT agent FROM stops WHERE next_ms <= ?", now).toArray()) await this.stop(nest, r.agent as string);
    for (const r of this.sql.exec("SELECT seq FROM chat WHERE next_ms IS NOT NULL AND next_ms <= ? ORDER BY seq", now).toArray()) await this.deliverChat(nest, r.seq as number);
    for (const r of this.sql.exec("SELECT seq FROM messages WHERE next_ms IS NOT NULL AND next_ms <= ? ORDER BY seq", now).toArray()) await this.deliverMessage(nest, r.seq as number);
    for (const r of this.sql.exec("SELECT id FROM tasks WHERE notify_next_ms IS NOT NULL AND notify_next_ms <= ?", now).toArray()) await this.notifyWorker(nest, r.id as string);
    for (const r of this.sql.exec("SELECT agent FROM layers WHERE next_ms IS NOT NULL AND next_ms <= ?", now).toArray()) await this.applyLayer(nest, r.agent as string);
    await this.arm();
  }

  /** Write the repo's "Allow auto-merge" to the setting's value (`PATCH /repos/{o}/{r}`). */
  private async writeRepoAutoMerge(nest: Nest): Promise<void> {
    const s = this.settings()!;
    const want = s.auto_merge;
    try {
      const gh = await githubFor(nest, s.repo, PERMISSIONS.repoSettings);
      const after = await gh.setAllowAutoMerge(s.repo, want);
      const now = Date.now();
      const seen = JSON.stringify({ value: want, at_ms: now } satisfies Seen);
      const observed = typeof after === "boolean" ? JSON.stringify({ value: after, at_ms: now } satisfies Seen) : null;
      // Done, unless the setting changed meanwhile: then the write owed for the new value stays.
      this.sql.exec(
        `UPDATE settings SET am_applied = ?, am_observed = COALESCE(?, am_observed), am_write_attempts = 0, am_write_error = NULL,
          am_write_next_ms = CASE WHEN auto_merge = ? THEN NULL ELSE am_write_next_ms END`,
        seen, observed, want ? 1 : 0,
      );
    } catch (e) {
      const attempts = (this.settingsRow()!.am_write_attempts as number) + 1;
      const permanent = (e instanceof NestError || e instanceof GitHubError) && e.permanent;
      // Refused for good: the setting stays as asked, the error shown, until the owner retries.
      this.sql.exec("UPDATE settings SET am_write_attempts = ?, am_write_next_ms = ?, am_write_error = ?", attempts, permanent ? null : Date.now() + backoff(attempts), message(e));
    }
  }

  /** Read the repo's "Allow auto-merge" (`GET /repos/{o}/{r}`), to show a change made by hand. */
  private async readRepoAutoMerge(nest: Nest): Promise<void> {
    const s = this.settings()!;
    try {
      const gh = await githubFor(nest, s.repo, PERMISSIONS.repoRead);
      const value = await gh.allowAutoMerge(s.repo);
      this.sql.exec("UPDATE settings SET am_observed = ?, am_read_next_ms = NULL, am_read_attempts = 0", JSON.stringify({ value, at_ms: Date.now() } satisfies Seen));
    } catch (e) {
      const attempts = (this.settingsRow()!.am_read_attempts as number) + 1;
      const permanent = (e instanceof NestError || e instanceof GitHubError) && e.permanent;
      this.sql.exec("UPDATE settings SET am_read_attempts = ?, am_read_next_ms = ?", attempts, permanent || attempts >= 5 ? null : Date.now() + backoff(attempts));
    }
  }

  /** Enable or disable GitHub's auto-merge on a PR, as owed, recording the result on its task. */
  private async prAutoMerge(nest: Nest, pr: number): Promise<void> {
    const before = this.prRow(pr);
    if (!before?.am_owed || !before.node) return;
    const id = before.task as string;
    const what = before.am_owed as "enable" | "disable";
    const s = this.settings()!;
    const method = s.merge_method;
    const github: Actor = { kind: "app", what: "github" };
    const still = () => this.prRow(pr)?.am_owed === what;
    try {
      const gh = await githubFor(nest, s.repo, PERMISSIONS.autoMerge);
      if (what === "enable") await gh.enableAutoMerge(before.node as string, GRAPHQL_METHOD[method]);
      else await gh.disableAutoMerge(before.node as string);
      const status: TaskAutoMerge = { state: what === "enable" ? "enabled" : "disabled", method: what === "enable" ? method : null, error: null, at_ms: Date.now() };
      this.sql.exec("UPDATE task_prs SET am_status = ? WHERE pr = ?", JSON.stringify(status), pr);
      this.record(id, github, what === "enable" ? "auto_merge_enabled" : "auto_merge_disabled", { pr, ...(what === "enable" ? { method } : {}) });
      if (still()) this.sql.exec("UPDATE task_prs SET am_owed = NULL, am_next_ms = NULL, am_attempts = 0 WHERE pr = ?", pr);
    } catch (e) {
      if (!still()) return;
      const attempts = (before.am_attempts as number) + 1;
      if ((e instanceof NestError || e instanceof GitHubError) && e.permanent) {
        const status: TaskAutoMerge = { state: "failed", method: what === "enable" ? method : null, error: message(e), at_ms: Date.now() };
        this.sql.exec("UPDATE task_prs SET am_status = ?, am_owed = NULL, am_next_ms = NULL, am_attempts = ? WHERE pr = ?", JSON.stringify(status), attempts, pr);
        this.record(id, github, "auto_merge_failed", { pr, action: what, error: message(e) });
        return;
      }
      const prior = before.am_status ? (JSON.parse(before.am_status as string) as TaskAutoMerge) : null;
      const status: TaskAutoMerge = { state: "pending", method: prior?.method ?? null, error: message(e), at_ms: Date.now() };
      this.sql.exec("UPDATE task_prs SET am_status = ?, am_attempts = ?, am_next_ms = ? WHERE pr = ?", JSON.stringify(status), attempts, Date.now() + backoff(attempts), pr);
    }
  }

  /**
   * Require the review check on the repo's default branch, keeping the rest of its protection
   * (src/github.ts `requireReviewCheck`). A refusal that will repeat (the App not installed, the repo
   * outside the grant, no admin) waits for the owner's retry; anything else is retried from the alarm.
   */
  private async attachRepo(nest: Nest): Promise<void> {
    const s = this.settings()!;
    try {
      const gh = await githubFor(nest, s.repo, PERMISSIONS.attach);
      // The App's id from nest's token answer; else one a check run told, if any has yet.
      const appId = gh.appId ?? (await directory(this.env).githubAppId());
      if (gh.appId !== null) await directory(this.env).recordGithubAppId(gh.appId);
      const r = await requireReviewCheck(gh, s.repo, appId);
      const detail: AttachDetail = { ...r, at_ms: Date.now() };
      this.sql.exec(
        "UPDATE settings SET attached_ms = COALESCE(attached_ms, ?), attach_next_ms = NULL, attach_attempts = 0, attach_error = NULL, attach_detail = ?",
        Date.now(), JSON.stringify(detail),
      );
    } catch (e) {
      const attempts = (this.settingsRow()!.attach_attempts as number) + 1;
      const permanent = (e instanceof NestError || e instanceof GitHubError) && e.permanent;
      this.sql.exec("UPDATE settings SET attach_attempts = ?, attach_next_ms = ?, attach_error = ?", attempts, permanent ? null : Date.now() + backoff(attempts), message(e));
    }
  }

  private async startManager(nest: Nest): Promise<void> {
    const s = this.settings()!;
    const n = (this.settingsRow()!.manager_starts as number) + 1;
    const labels = { project: s.id, role: "manager", start: String(n) };
    try {
      const key = `${s.id}/manager/${n}`;
      const frozen = this.frozenEgress(key, "manager");
      // Its bindings, env and workflows, frozen with the same key (README.md#secrets).
      const spec = await this.sandboxSpec(nest, "manager", key);
      const agent = s.manager ?? (await nest.startAgent(TEMPLATE.manager, labels, { read: s.repo }, key, { ...egressExtras(frozen.egress), ...spec.extras }));
      await directory(this.env).recordAgent({ agent, project: s.id, role: "manager", task: null, pr: null });
      this.sql.exec("UPDATE settings SET manager = ?", agent);
      this.trackLayer(agent, "manager", frozen.rev);
      this.recordHolder(agent, "manager", spec.names);
      await nest.postInbox(agent, managerBrief(s) + spec.brief, { requestId: `${s.id}/manager/${n}/brief` });
      this.sql.exec("UPDATE settings SET manager_next_ms = NULL, manager_attempts = 0, manager_error = NULL, manager_starts = ?", n);
    } catch (e) {
      // The manager is the project's only way in: always retried, the error shown meanwhile.
      const attempts = (this.settingsRow()!.manager_attempts as number) + 1;
      this.sql.exec("UPDATE settings SET manager_attempts = ?, manager_next_ms = ?, manager_error = ?", attempts, Date.now() + backoff(attempts), message(e));
    }
  }

  private async startWorker(nest: Nest, id: string): Promise<void> {
    const before = this.taskRow(id);
    if (!before || before.state !== "assigned") return;
    const n = before.assignments as number;
    const s = this.settings()!;
    const labels = { project: s.id, role: "worker", task: id, start: String(n) };
    const current = () => {
      const r = this.taskRow(id);
      return r && r.state === "assigned" && r.assignments === n ? r : null;
    };
    try {
      let agent = before.assignee as string | null;
      if (!agent) {
        const key = `${s.id}/${id}/${n}`;
        const frozen = this.frozenEgress(key, "worker");
        const spec = await this.sandboxSpec(nest, "worker", key);
        agent = await nest.startAgent(TEMPLATE.worker, labels, { push: s.repo }, key, { ...egressExtras(frozen.egress), ...spec.extras });
        await directory(this.env).recordAgent({ agent, project: s.id, role: "worker", task: id, pr: null });
        if (!current()) {
          // Cancelled (or reassigned, or abandoned) while it was being made: it goes, with no layer or holdings kept for it.
          this.sql.exec("INSERT OR IGNORE INTO stops (agent, task, reason, next_ms) VALUES (?, ?, 'cancelled', ?)", agent, id, Date.now());
          return;
        }
        this.trackLayer(agent, "worker", frozen.rev);
        this.recordHolder(agent, "worker", spec.names, spec.extras.github_push?.workflows === true);
        this.sql.exec("UPDATE tasks SET assignee = ? WHERE id = ?", agent, id);
        this.record(id, { kind: "app", what: "assign" }, "worker", { agent });
      }
      const t = this.toTask(this.taskRow(id)!);
      // A spec a tainted session wrote reaches the worker as relayed text, so its session is tainted too.
      await nest.postInbox(agent, workerBrief(s, t) + (this.frozenSpec(`${s.id}/${id}/${n}`)?.brief ?? ""), { requestId: `${id}/${n}/brief`, ...(t.tainted ? { from: "projects/board" } : {}) });
      if (!current()) return;
      this.move(id, "started", { kind: "app", what: "assign" }, { agent });
      this.sql.exec("UPDATE tasks SET start_next_ms = NULL, start_error = NULL WHERE id = ?", id);
    } catch (e) {
      const r = current();
      if (!r) return;
      if (e instanceof NestError && e.permanent) {
        // nest refused it for good (the grant, the template): the task stalls with the reason shown.
        this.move(id, "start_failed", { kind: "app", what: "assign" }, message(e));
        this.sql.exec("UPDATE tasks SET worker_live = 0, start_next_ms = NULL, start_error = ? WHERE id = ?", message(e), id);
        if (r.assignee) this.sql.exec("INSERT OR IGNORE INTO stops (agent, task, reason, next_ms) VALUES (?, ?, 'start failed', ?)", r.assignee, id, Date.now());
        this.autoAssign();
        return;
      }
      const attempts = (r.start_attempts as number) + 1;
      this.sql.exec("UPDATE tasks SET start_attempts = ?, start_next_ms = ?, start_error = ? WHERE id = ?", attempts, Date.now() + backoff(attempts), message(e), id);
    }
  }

  private async stop(nest: Nest, agent: string): Promise<void> {
    const row = this.sql.exec("SELECT task, reason, attempts FROM stops WHERE agent = ?", agent).toArray()[0];
    if (!row) return;
    try {
      await nest.stopAgent(agent, { end: true, destroySandbox: true, reason: row.reason as string });
    } catch (e) {
      if (!(e instanceof NestError && e.status === 404)) {
        const attempts = (row.attempts as number) + 1;
        this.sql.exec("UPDATE stops SET attempts = ?, next_ms = ?, error = ? WHERE agent = ?", attempts, Date.now() + backoff(attempts), message(e), agent);
        return;
      }
    }
    this.sql.exec("DELETE FROM stops WHERE agent = ?", agent);
    // Its sandbox goes with it: nothing more is owed to its client layer.
    this.sql.exec("DELETE FROM layers WHERE agent = ?", agent);
    this.sql.exec("UPDATE tasks SET worker_live = 0 WHERE assignee = ? AND state NOT IN ('assigned', 'in_progress', 'in_review')", agent);
    this.autoAssign();
  }

  /** One message owed to an agent's inbox, posted once (its request id), retried until nest refuses it for good. */
  private async deliverMessage(nest: Nest, seq: number): Promise<void> {
    const row = this.sql.exec("SELECT to_agent, text, relayed, attempts FROM messages WHERE seq = ? AND next_ms IS NOT NULL", seq).toArray()[0];
    if (!row) return;
    try {
      await nest.postInbox(row.to_agent as string, row.text as string, { requestId: `${this.settings()!.id}/message/${seq}`, ...(row.relayed === 1 ? { from: "projects/board" } : {}) });
      this.sql.exec("UPDATE messages SET next_ms = NULL, error = NULL WHERE seq = ?", seq);
    } catch (e) {
      const attempts = (row.attempts as number) + 1;
      const next = e instanceof NestError && e.permanent ? null : Date.now() + backoff(attempts);
      this.sql.exec("UPDATE messages SET attempts = ?, next_ms = ?, error = ? WHERE seq = ?", attempts, next, message(e), seq);
    }
  }

  private async deliverChat(nest: Nest, seq: number): Promise<void> {
    const s = this.settings()!;
    const row = this.sql.exec("SELECT text, attempts FROM chat WHERE seq = ? AND next_ms IS NOT NULL", seq).toArray()[0];
    if (!row) return;
    if (!s.manager) {
      this.sql.exec("UPDATE chat SET next_ms = ?, error = 'the manager isn''t started yet' WHERE seq = ?", Date.now() + backoff(1), seq);
      return;
    }
    try {
      await nest.postInbox(s.manager, row.text as string, { requestId: `${s.id}/chat/${seq}` });
      this.sql.exec("UPDATE chat SET next_ms = NULL, error = NULL, to_agent = ? WHERE seq = ?", s.manager, seq);
    } catch (e) {
      // Refused for good (the manager ended): kept in the log, undelivered, with the reason.
      const attempts = (row.attempts as number) + 1;
      const next = e instanceof NestError && e.permanent ? null : Date.now() + backoff(attempts);
      this.sql.exec("UPDATE chat SET attempts = ?, next_ms = ?, error = ? WHERE seq = ?", attempts, next, message(e), seq);
    }
  }
}

const clampWorkers = (n: number) => Math.max(0, Math.min(MAX_WORKERS_LIMIT, Math.floor(n)));
/** How long a task's changes gather before its worker is told of them, in one message. */
export const NOTIFY_WINDOW_MS = 10_000;
/** How much of a title or body before and after goes in that message. */
const CHANGE_CLIP = 600;

const clipText = (s: string | null) => (s === null ? "(none)" : s.length > CHANGE_CLIP ? `${s.slice(0, CHANGE_CLIP)}… (${s.length} characters)` : s);

/**
 * The message telling a worker its task changed: which fields, and for each the first before and the
 * last after of the set (bounded), the whole new spec, and to re-read the task.
 */
export function changeMessage(t: Task, changes: Record<string, SqlStorageValue>[]): string {
  const by = [...new Set(changes.map((c) => (c.actor === "owner" ? "the owner" : String(c.actor).startsWith("app:") ? "the app" : "the manager")))].join(" and ");
  const fields = [...new Set(changes.map((c) => c.field as string))];
  const first = (f: string) => changes.find((c) => c.field === f)!;
  const last = (f: string) => changes.filter((c) => c.field === f).at(-1)!;
  const lines = [`Your task ${t.id} was changed by ${by}: ${fields.join(", ")}. Re-read it with projects-task get_task and adjust your work.`];
  if (fields.includes("title")) lines.push("", `Title, before: ${clipText(first("title").before as string)}`, `Title, now: ${clipText(last("title").after as string)}`);
  if (fields.includes("body")) lines.push("", "Body, before:", clipText(first("body").before as string), "", "Body, now:", clipText(last("body").after as string));
  if (fields.includes("spec") && t.spec) {
    lines.push("", "The spec, now:", `Goal: ${t.spec.goal}`, "Acceptance criteria:", ...t.spec.acceptance_criteria.map((c) => `- ${c}`),
      `Files likely touched: ${t.spec.files.join(", ") || "(not given)"}`, `Test plan: ${t.spec.test_plan}`);
  }
  if (fields.includes("blocked")) lines.push("", "Its block was cleared: carry on.");
  if (fields.includes("prs")) lines.push("", `Attached PRs, before: ${first("prs").before as string}`, `Attached PRs, now: ${last("prs").after as string}`);
  if (fields.includes("dependencies")) {
    lines.push("", `It waits on, before: ${first("dependencies").before as string}`, `It waits on, now: ${last("dependencies").after as string}`);
    if (t.waiting_on.length === 0) lines.push("Nothing it waits on is unfinished now.");
  }
  return lines.join("\n");
}

/** How often looking at a project reads its repo's auto-merge setting again, at most. */
const REPO_READ_EVERY_MS = 60_000;

function requestOf(r: Row): SecretRequest {
  return {
    id: r.id as string, type: r.kind as "injected" | "ci", name: r.name as string, purpose: r.purpose as string,
    hosts: r.hosts ? (JSON.parse(r.hosts as string) as string[]) : null, agent: r.agent as string, role: r.role as string,
    task: (r.task as string | null) ?? null, tainted: r.tainted === 1, at_ms: r.at_ms as number,
  };
}

/** A task's block, from its row. */
function blockedOf(r: Row): Blocked | null {
  if (r.blocked_ms === null || r.blocked_ms === undefined) return null;
  return {
    at_ms: r.blocked_ms as number, by: r.blocked_by as string, role: r.blocked_role as "manager" | "worker", reason: r.blocked_reason as string,
    question: (r.blocked_question as string | null) ?? null, tainted: r.blocked_tainted === 1,
  };
}

/** A PR's auto-merge for the board: pending while owed, else the last result. */
function prAutoMerge(r: Row): TaskAutoMerge | null {
  const status = r.am_status ? (JSON.parse(r.am_status as string) as TaskAutoMerge) : null;
  if (r.am_owed) return { state: "pending", method: status?.method ?? null, error: status?.error ?? null, at_ms: status?.at_ms ?? (r.attached_ms as number) };
  return status;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

function managerBrief(s: Settings): string {
  return [
    `You manage project "${s.name}" (${s.id}) for the GitHub repo ${s.repo}.`,
    `Clone it in your sandbox to read it (\`gh repo clone ${s.repo}\` or git over https), then list the board with projects-board list_tasks and spec any task that has no spec yet.`,
    "The owner's messages come next, in your inbox.",
  ].join("\n");
}

function workerBrief(s: Settings, t: Task): string {
  const spec = t.spec;
  return [
    `Your task: ${t.id}, "${t.title}", on the GitHub repo ${s.repo}. Push the branch ${taskBranch(t.id)} and open one PR from it.`,
    "",
    t.body,
    ...(spec ? [
      "",
      `Goal: ${spec.goal}`,
      "Acceptance criteria:",
      ...spec.acceptance_criteria.map((c) => `- ${c}`),
      `Files likely touched: ${spec.files.join(", ") || "(not given)"}`,
      `Test plan: ${spec.test_plan}`,
    ] : []),
  ].join("\n");
}

/** The client's grant, as `GET /v1/clients/self` answers it. */
type Grant = NonNullable<Awaited<ReturnType<Nest["self"]>>["grant"]>;
/** How long a retired or orphaned nest secret is kept, so layers naming it have moved on first. */
const SWEEP_GRACE_MS = 5 * 60_000;
/** How often the secrets' upkeep (the grant read, the sweep) runs while the project has secrets. */
const UPKEEP_EVERY_MS = 10 * 60_000;
/** A minted name not used in this long is the Worker's write that never came back: no longer reserved. */
const MINTED_TTL_MS = 15 * 60_000;

/** A start attempt's sandbox spec, frozen at its first try, with the layer revision it was built at. */
export interface StartSpec {
  extras: SandboxExtras;
  names: string[];
  brief: string;
  rev: number;
}

/** A live agent's client layer, as the Network page shows it. */
export interface LayerStatus {
  agent: string;
  role: LayerRole;
  sandbox: string | null;
  state: "applied" | "pending" | "failed";
  error: string | null;
  rev: number | null;
  at_ms: number | null;
}

function toWait(r: Row): Wait {
  return {
    id: r.id as string, kind: r.kind as WaitKind, target: (r.target as string | null) ?? null,
    want: r.want === null ? null : (JSON.parse(r.want as string) as Wait["want"]),
    created_ms: r.created_ms as number, deadline_ms: r.deadline_ms as number, resolved_ms: (r.resolved_ms as number | null) ?? null,
    outcome: (r.outcome as WaitOutcome | null) ?? null, detail: (r.detail as string | null) ?? null,
  };
}

/** A start's sandbox extras for its frozen rules: none when there are none (the request as before). */
const egressExtras = (egress: EgressRule[]) => (egress.length ? { egress: { allow: egress } } : {});

/** A review job's end, in a word: its verdict's conclusion, or that it failed. */
function reviewConclusion(j: { state: string; verdict: unknown }): string {
  if (j.state === "failed") return "failed without a verdict";
  const v = j.verdict as { correctness?: { verdict: string }; quality?: { verdict: string }; architecture?: { verdict: string } } | null;
  const all = v && [v.correctness, v.quality, v.architecture].every((d) => d?.verdict === "pass");
  return all ? "passed" : "failed";
}
