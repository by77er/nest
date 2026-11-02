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
import type { AgentCaller } from "../identity";
import { NestError, nestFrom, clientIdOf, type Labels, type Nest } from "../nest";
import { invalid } from "../schema";
import { fail, migrate, ok, type Result } from "../sql";
import { pickForAssignment, type Spec, taskBranch, type TaskEvent, type TaskState, TERMINAL, transition } from "../tasks";
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
  created_ms: number;
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
  created_ms: number;
  updated_ms: number;
}

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
/** Retry waits for work owed to nest: from 5 s, doubling, to 5 min. */
const backoff = (attempts: number) => Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
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
  async init(p: { id: string; name: string; repo: string; auto_assign?: boolean; max_workers?: number }): Promise<Settings> {
    if (!this.settingsRow()) {
      this.sql.exec(
        "INSERT INTO settings (id, name, repo, auto_assign, max_workers, manager_next_ms, created_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
        p.id, p.name, p.repo, p.auto_assign ? 1 : 0, clampWorkers(p.max_workers ?? 2), Date.now(), Date.now(),
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
      manager: (r.manager as string | null) ?? null, manager_error: (r.manager_error as string | null) ?? null, created_ms: r.created_ms as number,
    };
  }

  async getSettings(): Promise<Result<Settings>> {
    const s = this.settings();
    return s ? ok(s) : fail(404, "unknown project");
  }

  async updateSettings(u: { auto_assign?: boolean; max_workers?: number }): Promise<Result<Settings>> {
    if (!this.settings()) return fail(404, "unknown project");
    if (u.auto_assign !== undefined) this.sql.exec("UPDATE settings SET auto_assign = ?", u.auto_assign ? 1 : 0);
    if (u.max_workers !== undefined) this.sql.exec("UPDATE settings SET max_workers = ?", clampWorkers(u.max_workers));
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
      start_error: (r.start_error as string | null) ?? null, tainted: r.tainted === 1, created_ms: r.created_ms as number, updated_ms: r.updated_ms as number,
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
    const tasks = this.sql.exec("SELECT id, state, ord FROM tasks WHERE state = 'ready'").toArray()
      .map((r) => ({ id: r.id as string, state: r.state as TaskState, ord: r.ord as number }));
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

  /** The owner marks a task done (one with no PR, or whose PR merged); its worker is ended. */
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
        case "report_blocker":
          if (TERMINAL.has(r.state as TaskState)) return fail(409, `the task is ${r.state}`);
          this.record(id, actor, tool === "report_progress" ? "progress" : "blocker", a.text as string);
          return ok({ recorded: true });
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
    const next = this.sql.exec<{ t: number | null }>(
      `SELECT MIN(t) AS t FROM (
        SELECT manager_next_ms AS t FROM settings WHERE manager_next_ms IS NOT NULL
        UNION ALL SELECT start_next_ms FROM tasks WHERE state = 'assigned' AND start_next_ms IS NOT NULL
        UNION ALL SELECT next_ms FROM stops
        UNION ALL SELECT next_ms FROM chat WHERE next_ms IS NOT NULL)`,
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
    const s = this.settingsRow();
    if (!s) return;
    const nest = nestFrom(this.env);
    const client = clientIdOf(this.env.NEST_CLIENT_TOKEN);
    if (!nest || !client) return;
    const now = Date.now();
    if (s.manager_next_ms !== null && (s.manager_next_ms as number) <= now) await this.startManager(nest, client);
    for (const r of this.sql.exec("SELECT id FROM tasks WHERE state = 'assigned' AND start_next_ms IS NOT NULL AND start_next_ms <= ? ORDER BY ord", now).toArray()) {
      await this.startWorker(nest, client, r.id as string);
    }
    for (const r of this.sql.exec("SELECT agent FROM stops WHERE next_ms <= ?", now).toArray()) await this.stop(nest, r.agent as string);
    for (const r of this.sql.exec("SELECT seq FROM chat WHERE next_ms IS NOT NULL AND next_ms <= ? ORDER BY seq", now).toArray()) await this.deliverChat(nest, r.seq as number);
    await this.arm();
  }

  /** The live agent of the app's carrying exactly these labels, or a new one (with a sandbox of its own). */
  private async agentFor(nest: Nest, client: string, template: string, labels: Labels, repo: string): Promise<string> {
    const mine = (owner: string | null | undefined) => owner === client;
    const found = (await nest.listAgents(labels)).agents.find((a) => mine(a.owner) && a.agent);
    if (found) return found.agent!;
    let sandbox = (await nest.listSandboxes(labels)).sandboxes.find((x) => mine(x.owner) && x.sandbox)?.sandbox;
    if (!sandbox) sandbox = (await nest.createSandbox({ labels })).sandbox;
    return (await nest.createAgent({ template, sandbox, labels, overrides: { repos: [repo] }, start: true })).agent;
  }

  private async startManager(nest: Nest, client: string): Promise<void> {
    const s = this.settings()!;
    const n = (this.settingsRow()!.manager_starts as number) + 1;
    const labels = { project: s.id, role: "manager", start: String(n) };
    try {
      const agent = s.manager ?? (await this.agentFor(nest, client, TEMPLATE.manager, labels, s.repo));
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

  private async startWorker(nest: Nest, client: string, id: string): Promise<void> {
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
        agent = await this.agentFor(nest, client, TEMPLATE.worker, labels, s.repo);
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
