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
import { canBlock, canUnblock, pickForAssignment, type Spec, taskBranch, type TaskEvent, type TaskState, TERMINAL, transition } from "../tasks";
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
  /** GitHub's auto-merge on its PR, while the project's `auto_merge` is on; null when never asked. */
  auto_merge: TaskAutoMerge | null;
  /** Set while an agent has the task waiting on the owner (README.md#blocked). */
  blocked: Blocked | null;
  created_ms: number;
  updated_ms: number;
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

const MIGRATIONS = [
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
      state: r.state as TaskState, ord: r.ord as number, assignee: (r.assignee as string | null) ?? null, pr: (r.pr as number | null) ?? null,
      start_error: (r.start_error as string | null) ?? null, tainted: r.tainted === 1, auto_merge: taskAutoMerge(r), blocked: blockedOf(r),
      created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
    };
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
    if (u.title !== undefined) this.sql.exec("UPDATE tasks SET title = ? WHERE id = ?", u.title, id);
    if (u.body !== undefined) this.sql.exec("UPDATE tasks SET body = ? WHERE id = ?", u.body, id);
    if (u.ord !== undefined) this.sql.exec("UPDATE tasks SET ord = ? WHERE id = ?", u.ord, id);
    this.sql.exec("UPDATE tasks SET updated_ms = ? WHERE id = ?", Date.now(), id);
    this.record(id, actor, "updated", u);
    if (u.ord !== undefined) {
      this.autoAssign();
      await this.arm();
    }
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
    // A task that ends has nothing left to wait on the owner for.
    if (TERMINAL.has(t.to) && r.blocked_ms !== null) {
      this.clearBlock(id);
      this.record(id, { kind: "app", what: "board" }, "unblocked", { why: t.to });
    }
    return ok({ from, to: t.to });
  }

  async writeSpec(id: string, spec: Spec, actor: Actor = { kind: "owner" }): Promise<Result<Task>> {
    if (!this.settings()) return fail(404, "unknown project");
    const m = this.move(id, "spec", actor, spec);
    if (!m.ok) return m;
    this.sql.exec("UPDATE tasks SET spec = ? WHERE id = ?", JSON.stringify(spec), id);
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
      .map((r) => ({ id: r.id as string, state: r.state as TaskState, ord: r.ord as number, blocked: r.blocked_ms !== null }));
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
   * A PR on the repo opened or closed (GitHub's `pull_request`, routed here by the Worker). `task` is the
   * task its branch names (`task/<id>`, from the repo itself, not a fork), when it does:
   * - opened: the PR is linked to its task (`pr_opened`), if the worker hadn't reported it;
   * - merged: its task is done, and its worker ended;
   * - closed without merging: noted in the task's history; the task stays as it is.
   */
  async onPullRequest(e: { pr: number; task: string | null; action: "opened" | "closed"; merged: boolean; node?: string | null }): Promise<void> {
    if (!this.settings()) return;
    const byBranch = e.task ? this.taskRow(e.task) : undefined;
    const r = byBranch ?? this.sql.exec("SELECT id FROM tasks WHERE pr = ?", e.pr).toArray()[0];
    if (!r) return;
    const id = r.id as string;
    const github: Actor = { kind: "app", what: "github" };
    const link = () => {
      const t = this.taskRow(id)!;
      if (t.pr === e.pr && t.state === "in_review") return;
      if (this.move(id, "pr_opened", github, { pr: e.pr }).ok) this.sql.exec("UPDATE tasks SET pr = ? WHERE id = ?", e.pr, id);
      else this.record(id, github, "pr_seen", { pr: e.pr, state: t.state });
    };
    if (e.action === "opened") {
      link();
      // A task's own PR (its branch, from the repo itself) gets auto-merge while the setting is on.
      const t = this.taskRow(id)!;
      if (e.task === id && t.pr === e.pr && t.state === "in_review" && e.node) {
        this.sql.exec("UPDATE tasks SET pr_node = ? WHERE id = ?", e.node, id);
        if (this.settings()!.auto_merge) this.oweTaskAutoMerge(id, "enable");
      }
    } else if (e.merged) {
      if (this.taskRow(id)!.state === "in_progress") link();
      if (this.move(id, "merged", github, { pr: e.pr }).ok) {
        this.stopWorkerOf(id, "merged");
        this.autoAssign();
      } else {
        this.record(id, github, "pr_merged", { pr: e.pr, state: this.taskRow(id)!.state });
      }
    } else {
      this.record(id, github, "pr_closed", { pr: e.pr });
    }
    // A closed PR's auto-merge is GitHub's to drop: nothing more is owed for it.
    if (e.action === "closed") this.sql.exec("UPDATE tasks SET am_owed = NULL, am_next_ms = NULL WHERE id = ? AND pr = ?", id, e.pr);
    await this.arm();
  }

  // --- auto-merge ------------------------------------------------------------------------------------

  /** Turn auto-merge on or off: the repo's setting is owed its write, and each open task PR its change. */
  private setAutoMerge(on: boolean): void {
    this.sql.exec("UPDATE settings SET auto_merge = ?, am_write_next_ms = ?, am_write_attempts = 0, am_write_error = NULL", on ? 1 : 0, Date.now());
    for (const t of this.sql.exec("SELECT id, am_status, am_owed FROM tasks WHERE state = 'in_review' AND pr_node IS NOT NULL").toArray()) {
      const status = t.am_status ? (JSON.parse(t.am_status as string) as TaskAutoMerge) : null;
      if (on) this.oweTaskAutoMerge(t.id as string, "enable");
      else if (status?.state === "enabled" || t.am_owed === "enable") this.oweTaskAutoMerge(t.id as string, "disable");
    }
  }

  private oweTaskAutoMerge(id: string, what: "enable" | "disable"): void {
    this.sql.exec("UPDATE tasks SET am_owed = ?, am_next_ms = ?, am_attempts = 0 WHERE id = ?", what, Date.now(), id);
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
          return ok({ id: t.id, title: t.title, body: t.body, spec: t.spec, state: t.state, pr: t.pr, repo: this.settings()!.repo, branch: taskBranch(t.id) });
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
          const m = this.move(id, "pr_opened", actor, { pr: a.number });
          if (!m.ok) return m;
          this.sql.exec("UPDATE tasks SET pr = ? WHERE id = ?", a.number as number, id);
          return ok({ task: id, state: m.value.to, pr: a.number });
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
        UNION ALL SELECT t.am_next_ms FROM tasks t, settings s WHERE t.am_next_ms IS NOT NULL
          AND (t.am_owed = 'disable' OR (s.am_write_next_ms IS NULL AND s.am_write_error IS NULL)))`),
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
    for (const r of this.sql.exec("SELECT id, am_owed FROM tasks WHERE am_next_ms IS NOT NULL AND am_next_ms <= ?", now).toArray()) {
      if (r.am_owed === "disable" || repoReady) await this.taskAutoMerge(nest, r.id as string);
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

  /** Enable or disable GitHub's auto-merge on a task's PR, as owed, recording the result on the task. */
  private async taskAutoMerge(nest: Nest, id: string): Promise<void> {
    const before = this.taskRow(id);
    if (!before?.am_owed || !before.pr_node) return;
    const what = before.am_owed as "enable" | "disable";
    const s = this.settings()!;
    const method = s.merge_method;
    const github: Actor = { kind: "app", what: "github" };
    const still = () => this.taskRow(id)?.am_owed === what;
    try {
      const gh = await githubFor(nest, s.repo, PERMISSIONS.autoMerge);
      if (what === "enable") await gh.enableAutoMerge(before.pr_node as string, GRAPHQL_METHOD[method]);
      else await gh.disableAutoMerge(before.pr_node as string);
      const status: TaskAutoMerge = { state: what === "enable" ? "enabled" : "disabled", method: what === "enable" ? method : null, error: null, at_ms: Date.now() };
      this.sql.exec("UPDATE tasks SET am_status = ? WHERE id = ?", JSON.stringify(status), id);
      this.record(id, github, what === "enable" ? "auto_merge_enabled" : "auto_merge_disabled", { pr: before.pr, ...(what === "enable" ? { method } : {}) });
      if (still()) this.sql.exec("UPDATE tasks SET am_owed = NULL, am_next_ms = NULL, am_attempts = 0 WHERE id = ?", id);
    } catch (e) {
      if (!still()) return;
      const attempts = (before.am_attempts as number) + 1;
      if ((e instanceof NestError || e instanceof GitHubError) && e.permanent) {
        const status: TaskAutoMerge = { state: "failed", method: what === "enable" ? method : null, error: message(e), at_ms: Date.now() };
        this.sql.exec("UPDATE tasks SET am_status = ?, am_owed = NULL, am_next_ms = NULL, am_attempts = ? WHERE id = ?", JSON.stringify(status), attempts, id);
        this.record(id, github, "auto_merge_failed", { pr: before.pr, action: what, error: message(e) });
        return;
      }
      const prior = before.am_status ? (JSON.parse(before.am_status as string) as TaskAutoMerge) : null;
      const status: TaskAutoMerge = { state: "pending", method: prior?.method ?? null, error: message(e), at_ms: Date.now() };
      this.sql.exec("UPDATE tasks SET am_status = ?, am_attempts = ?, am_next_ms = ? WHERE id = ?", JSON.stringify(status), attempts, Date.now() + backoff(attempts), id);
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

/** A task's auto-merge for the board: pending while owed, else the last result. */
function taskAutoMerge(r: Row): TaskAutoMerge | null {
  const status = r.am_status ? (JSON.parse(r.am_status as string) as TaskAutoMerge) : null;
  if (r.am_owed) return { state: "pending", method: status?.method ?? null, error: status?.error ?? null, at_ms: status?.at_ms ?? (r.updated_ms as number) };
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
