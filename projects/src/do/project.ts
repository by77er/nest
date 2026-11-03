// ProjectDO, one per project (README.md#pieces): its settings and manager, the board (tasks, specs,
// assignments and each task's history, with the taint of every write), the chat with the manager, the
// approvals waiting for the owner, and the work it owes nest (agents to start, stop, messages to send).
//
// Every decision is one synchronous step on SQLite that also arms the alarm; the calls to nest happen
// after, from `drain` (run by the request that made the work, and by the alarm until it's done), and
// re-read the row before acting on an answer, since other requests run while one awaits nest.

import { DurableObject } from "cloudflare:workers";
import { TEMPLATE } from "../catalog";
import { directory, type Env } from "../env";
import { GRAPHQL_METHOD, type MergeMethod, type RepoAutoMerge, repoAutoMerge, type Seen, type TaskAutoMerge } from "../automerge";
import { type AttachChange, GitHubError, githubFor, PERMISSIONS, requireReviewCheck } from "../github";
import type { AgentCaller } from "../identity";
import { backoff, NestError, nestFrom, type Nest } from "../nest";
import { invalid } from "../schema";
import { fail, migrate, ok, type Result } from "../sql";
import { canBlock, canUnblock, dependencyError, pickForAssignment, type PrState, prsDone, waitingOn, type Spec, taskBranch, type TaskEvent, type TaskState, TERMINAL, transition, WORKER_STATES } from "../tasks";
import { type Server, toolOf } from "../tools";
import type { NestEvent } from "../webhook";
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
export type Attention = ({ kind: "ask" } & Ask) | ({ kind: "blocked"; task: string; title: string; state: TaskState } & Blocked);

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
] as const;

type Row = Record<string, SqlStorageValue>;

/** A task's row with `tainted`: whether any write in its history came from a tainted session. */
const TASK_SELECT = "SELECT t.*, EXISTS (SELECT 1 FROM history h WHERE h.task = t.id AND h.tainted = 1) AS tainted FROM tasks t";

export class ProjectDO extends DurableObject<Env> {
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
      auto_merge: r.auto_merge === 1, merge_method: r.merge_method as MergeMethod,
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

  async updateSettings(u: { auto_assign?: boolean; max_workers?: number; auto_merge?: boolean; merge_method?: MergeMethod }): Promise<Result<Settings>> {
    const before = this.settings();
    if (!before) return fail(404, "unknown project");
    if (u.auto_assign !== undefined) this.sql.exec("UPDATE settings SET auto_assign = ?", u.auto_assign ? 1 : 0);
    if (u.max_workers !== undefined) this.sql.exec("UPDATE settings SET max_workers = ?", clampWorkers(u.max_workers));
    if (u.merge_method !== undefined) this.sql.exec("UPDATE settings SET merge_method = ?", u.merge_method);
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
    return ok([...open, ...blocked].sort((a, b) => a.at_ms - b.at_ms));
  }

  /** How many things wait on the owner (the projects list's count). */
  async attentionCount(): Promise<number> {
    if (!this.settings()) return 0;
    return this.sql.exec<{ n: number }>(
      "SELECT (SELECT COUNT(*) FROM asks WHERE answered_ms IS NULL) + (SELECT COUNT(*) FROM tasks WHERE blocked_ms IS NOT NULL) AS n",
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
        case "block_task":
          return this.block(a.task as string, caller, "manager", a.reason as string, (a.question as string | undefined) ?? null);
        case "unblock_task":
          return this.unblock(a.task as string, caller, (a.note as string | undefined) ?? null);
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
    const nest = nestFrom(this.env);
    if (!nest) return;
    const now = Date.now();
    if (s.attach_next_ms !== null && (s.attach_next_ms as number) <= now) await this.attachRepo(nest);
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
      const agent = s.manager ?? (await nest.startAgent(TEMPLATE.manager, labels, { read: s.repo }, `${s.id}/manager/${n}`));
      await directory(this.env).recordAgent({ agent, project: s.id, role: "manager", task: null, pr: null });
      this.sql.exec("UPDATE settings SET manager = ?", agent);
      await nest.postInbox(agent, managerBrief(s), { requestId: `${s.id}/manager/${n}/brief` });
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
        agent = await nest.startAgent(TEMPLATE.worker, labels, { push: s.repo }, `${s.id}/${id}/${n}`);
        await directory(this.env).recordAgent({ agent, project: s.id, role: "worker", task: id, pr: null });
        if (!current()) {
          // Cancelled (or reassigned) while it was being made: it goes.
          this.sql.exec("INSERT OR IGNORE INTO stops (agent, task, reason, next_ms) VALUES (?, ?, 'cancelled', ?)", agent, id, Date.now());
          return;
        }
        this.sql.exec("UPDATE tasks SET assignee = ? WHERE id = ?", agent, id);
        this.record(id, { kind: "app", what: "assign" }, "worker", { agent });
      }
      const t = this.toTask(this.taskRow(id)!);
      // A spec a tainted session wrote reaches the worker as relayed text, so its session is tainted too.
      await nest.postInbox(agent, workerBrief(s, t), { requestId: `${id}/${n}/brief`, ...(t.tainted ? { from: "projects/board" } : {}) });
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
