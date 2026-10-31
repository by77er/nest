// TaskLedgerDO: one named task ledger (docs/control-plane/durable-objects/tasks/), keyed
// `ledger/<name>`. A thin shell over the pure core (lib/tasks.ts): each write loads what the core
// asks for through synchronous lookups, applies the operation, and persists the result (task,
// history, comment, watcher, notices, idempotency record) in one synchronous step with the alarm
// that delivers the notices. Notices go out only from that alarm, through `deliverNotice`, never
// while a caller (an AgentDO) is mid-call into this object: its input gate is open at that await,
// so a callback would interleave with the call that caused it.
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { withTimeout } from "../lib/reliable";
import { sqlIn, storedEnum } from "../lib/stored";
import {
  type Actor, type Applied, applyTaskOp, checkLedgerAccess, CLOSED_STATUSES, type HistoryEntry, type HistoryValue, inboxOwner, LedgerName,
  type LedgerView, type Notice, type Refusal, type Task, type TaskFilter, type TaskOp, TaskPriority, TaskStatus, taskKey,
} from "../lib/tasks";
import { asNestError, NestError, newId } from "../lib/util";
import { ErrorCodes } from "../protocol/model";

/** A task as the API and the tools show it: with its key and its parent's. */
export type TaskView = Task & { key: string; parent_key: string | null; tainted: boolean };
export type CommentView = { id: number; author: string; body: string; ms: number; tainted: boolean };
export type HistoryView = Omit<HistoryEntry, "task">;
/**
 * Every result carries `tainted`: whether it holds text a tainted session wrote. The caller (AgentDO)
 * taints the reading session when it is true.
 */
export interface ApplyOutcome {
  task: TaskView | null;
  comment?: CommentView;
  watcher?: string | null;
  tainted: boolean;
}
export interface TaskPage {
  tasks: TaskView[];
  /** Pass as `cursor` for the next page; null on the last. */
  next_cursor: number | null;
  tainted: boolean;
}
export interface TaskDetail {
  task: TaskView;
  /** The latest comments, oldest first. */
  comments: CommentView[];
  comment_count: number;
  /** The latest changes, oldest first. */
  history: HistoryView[];
  tainted: boolean;
}
export interface LedgerInfo {
  ledger: string;
  watcher: string | null;
  tasks: number;
}

// Retention (docs/data/#retention).
const DAY_MS = 86_400_000;
/** Comments and history of a done or canceled task go this long after its last change. */
const CLOSED_TASK_DETAIL_MS = 30 * DAY_MS;
/** History rows kept per task (the latest). */
const HISTORY_PER_TASK = 500;
/** Idempotency records of applied writes (a tool call re-run after an eviction; an API retry). */
const APPLIED_RETENTION_MS = 7 * DAY_MS;
const PRUNE_EVERY_MS = DAY_MS;
/** What `get` shows. */
const GET_COMMENTS = 100;
const GET_HISTORY = 50;
/** Undelivered notices are retried after 1 s doubling to 5 min; delivered ones are deleted. */
const NOTICE_RETRY_MAX_MS = 5 * 60_000;
/** When a notice that failed `attempts` times before (0 for the first) is tried again, from now. */
export const noticeRetryMs = (attempts: number) => Math.min(1_000 * 2 ** Math.max(0, attempts), NOTICE_RETRY_MAX_MS);
const NOTICES_PER_ALARM = 50;
/** One notice's call is abandoned (and retried later, under the same idempotency key) after this long. */
export const NOTICE_TIMEOUT_MS = 5_000;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 200;

/** Ledger `name`'s object. */
export const ledgerStub = (env: Env, name: string) => env.TASKS.get(env.TASKS.idFromName(`ledger/${name}`));

/** An `outbox` row: a post owed to a channel, the shape a channel outbox keeps (`idem` keys its delivery). */
export interface OutboxRow {
  id: number;
  channel: string;
  body: Notice["post"];
  idem: string;
}

/**
 * Deliver one notice: the only place that knows where a channel's post goes. Today `<agt>/inbox` is
 * AgentDO's inbox (`postInbox`, keyed by `idem`, so a retry is applied once); when inboxes are
 * channels this becomes that channel's post. `delivered`: the receiver took it; `gone`: it never
 * can (no such agent, or not an inbox); a throw: try again later.
 */
export async function deliverNotice(env: Env, ledger: string, row: OutboxRow): Promise<"delivered" | "gone"> {
  const agent = inboxOwner(row.channel);
  if (!agent) return "gone";
  try {
    // Bounded: `postInbox` may wait on the agent's wake, and one slow agent mustn't hold the rest.
    await withTimeout(env.AGENT.get(env.AGENT.idFromName(agent)).postInbox(`tasks:${ledger}`, row.body.text, false, row.idem), NOTICE_TIMEOUT_MS, "notice");
    return "delivered";
  } catch (e) {
    if (asNestError(e)?.code === ErrorCodes.UNKNOWN_AGENT) return "gone";
    throw e;
  }
}

function nestError(r: Refusal): NestError {
  switch (r.code) {
    case "forbidden": return new NestError(ErrorCodes.FORBIDDEN, r.message, 403);
    case "conflict": return new NestError(ErrorCodes.CONFLICT, r.message, 409);
    case "not_found": return new NestError(ErrorCodes.NOT_FOUND, r.message, 404);
    case "invalid_message": return new NestError(ErrorCodes.INVALID_MESSAGE, r.message, 400);
  }
}

export class TaskLedgerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.TASKS)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // `body` is the task (JSON); the other columns are copies of its fields, for filtering.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, status TEXT NOT NULL,
      assignee TEXT, parent TEXT, labels TEXT NOT NULL, search TEXT NOT NULL, updated_ms INTEGER NOT NULL, body TEXT NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS tasks_status ON tasks (status, number)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee, number)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent, number)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, author TEXT NOT NULL,
      body TEXT NOT NULL, ms INTEGER NOT NULL, tainted INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS comments_task ON comments (task, id)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, actor TEXT NOT NULL,
      field TEXT NOT NULL, from_v TEXT NOT NULL, to_v TEXT NOT NULL, ms INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS history_task ON history (task, id)");
    // Notices not yet taken by their channel (`body`: the post, JSON).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, body TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS applied (key TEXT PRIMARY KEY, outcome TEXT NOT NULL, ts_ms INTEGER NOT NULL)");
  }

  // --- Storage -----------------------------------------------------------------------------------------

  private kv(key: string): string | undefined {
    return this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value;
  }

  private setKv(key: string, value: string | null): void {
    if (value === null) this.sql.exec("DELETE FROM kv WHERE key = ?", key);
    else this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** The ledger's name: recorded by its first write; every call names it, and must name the same. */
  private checkName(name: string, write: boolean): boolean {
    if (!LedgerName.safeParse(name).success) throw new NestError(ErrorCodes.INVALID_MESSAGE, `bad ledger name ${JSON.stringify(name)}`);
    const stored = this.kv("name");
    if (stored !== undefined && stored !== name) throw new NestError(ErrorCodes.INTERNAL, `this is ledger ${stored}, not ${name}`, 500);
    if (stored === undefined && write) {
      this.setKv("name", name);
      this.setKv("last_prune", String(Date.now()));
    }
    return stored !== undefined || write;
  }

  /** A stored task. A status or priority outside its enum is logged and returned as read: the core refuses the rules that need it. */
  private parseTask(body: string): Task {
    const t = JSON.parse(body) as Task;
    storedEnum(TaskStatus, t.status, "tasks.body.status");
    storedEnum(TaskPriority, t.priority, "tasks.body.priority");
    return t;
  }

  private task(ref: string): Task | undefined {
    const m = /^T-(\d+)$/.exec(ref);
    const row = m
      ? this.sql.exec<{ body: string }>("SELECT body FROM tasks WHERE number = ?", Number(m[1])).toArray()[0]
      : this.sql.exec<{ body: string }>("SELECT body FROM tasks WHERE id = ?", ref).toArray()[0];
    return row ? this.parseTask(row.body) : undefined;
  }

  private ledgerView(name: string): LedgerView {
    return {
      name,
      next: Number(this.kv("next") ?? "1"),
      openCount: this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN (${sqlIn(CLOSED_STATUSES)})`).one().n,
      watcher: this.kv("watcher") ?? null,
      get: (ref) => this.task(ref),
      commentCount: (task) => this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE task = ?", task).one().n,
    };
  }

  private view(t: Task): TaskView {
    const parent = t.parent === null ? undefined : this.task(t.parent);
    return { ...t, key: taskKey(t), parent_key: parent ? taskKey(parent) : null, tainted: t.tainted === true };
  }

  /** Persist what the core decided: all of it, synchronously. Returns the comment's id. */
  private persist(a: Applied, now: number): number | undefined {
    if (a.put) {
      const t = a.put;
      this.sql.exec(`INSERT INTO tasks (id, number, status, assignee, parent, labels, search, updated_ms, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, assignee = excluded.assignee, parent = excluded.parent, labels = excluded.labels,
        search = excluded.search, updated_ms = excluded.updated_ms, body = excluded.body`,
      t.id, t.number, t.status, t.assignee, t.parent, JSON.stringify(t.labels), `${t.title}\n${t.description}`.toLowerCase(), t.updated_ms, JSON.stringify(t));
    }
    this.setKv("next", String(a.next));
    for (const h of a.history) {
      this.sql.exec("INSERT INTO history (task, actor, field, from_v, to_v, ms) VALUES (?, ?, ?, ?, ?, ?)",
        h.task, h.actor, h.field, JSON.stringify(h.from), JSON.stringify(h.to), h.ms);
    }
    if (a.history.length) {
      const task = a.history[0]!.task;
      // Ids are shared by every task's rows: keep this task's latest HISTORY_PER_TASK by rank, not by id range.
      this.sql.exec("DELETE FROM history WHERE task = ? AND id < (SELECT id FROM history WHERE task = ? ORDER BY id DESC LIMIT 1 OFFSET ?)",
        task, task, HISTORY_PER_TASK - 1);
    }
    let comment: number | undefined;
    if (a.comment) {
      comment = this.sql.exec<{ id: number }>("INSERT INTO comments (task, author, body, ms, tainted) VALUES (?, ?, ?, ?, ?) RETURNING id",
        a.comment.task, a.comment.author, a.comment.body, a.comment.ms, a.comment.tainted ? 1 : 0).one().id;
    }
    if (a.watcher !== undefined) this.setKv("watcher", a.watcher);
    for (const n of a.notices) this.sql.exec("INSERT INTO outbox (channel, body, next_ms) VALUES (?, ?, ?)", n.channel, JSON.stringify(n.post), now);
    return comment;
  }

  /** Arm the alarm for the next undelivered notice or prune. Called right after the writes it covers. */
  private async arm(): Promise<void> {
    const notice = this.sql.exec<{ at: number | null }>("SELECT MIN(next_ms) AS at FROM outbox").one().at;
    const lastPrune = this.kv("last_prune");
    const prune = lastPrune === undefined ? null : Number(lastPrune) + PRUNE_EVERY_MS;
    const at = Math.min(notice ?? Infinity, prune ?? Infinity);
    if (at === Infinity) return;
    // The call is made before any await, so the alarm is armed in the same step as the rows it covers.
    await this.ctx.storage.setAlarm(Math.max(at, 1));
  }

  // --- RPC ---------------------------------------------------------------------------------------------

  /**
   * Apply `op` by `actor` to ledger `name`. With a `key` (`<agent>/<epoch>/<call>`, or an API request
   * id) it is applied once: a repeat of the same kind of operation gets the first outcome (the key is
   * kept per kind, so a request id reused on another route is a new request). Refusals throw (403,
   * 404, 409, 400).
   */
  async apply(name: string, actor: Actor, op: TaskOp, requestKey?: string): Promise<ApplyOutcome> {
    this.checkName(name, false);
    const key = requestKey && `${op.kind}/${requestKey}`;
    if (key) {
      const prior = this.sql.exec<{ outcome: string }>("SELECT outcome FROM applied WHERE key = ?", key).toArray()[0];
      if (prior) return JSON.parse(prior.outcome) as ApplyOutcome;
    }
    const now = Date.now();
    const r = applyTaskOp(this.ledgerView(name), actor, op, { now, newId: newId("tsk_", now) });
    if (!r.ok) throw nestError(r.error);
    // From here to the alarm call: one synchronous step.
    this.checkName(name, true);
    const commentId = this.persist(r.value, now);
    const task = r.value.task && this.view(r.value.put ?? r.value.task);
    const c = r.value.comment;
    const outcome: ApplyOutcome = {
      task,
      ...(c && commentId !== undefined ? { comment: { id: commentId, author: c.author, body: c.body, ms: c.ms, tainted: c.tainted } } : {}),
      ...(r.value.watcher !== undefined ? { watcher: r.value.watcher } : {}),
      // The task comes back whole (others' text too); a comment is the caller's own.
      tainted: task?.tainted === true,
    };
    if (key) this.sql.exec("INSERT INTO applied (key, outcome, ts_ms) VALUES (?, ?, ?)", key, JSON.stringify(outcome), now);
    await this.arm();
    return outcome;
  }

  async info(name: string, actor: Actor): Promise<LedgerInfo> {
    this.read(name, actor);
    return { ledger: name, watcher: this.kv("watcher") ?? null, tasks: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM tasks").one().n };
  }

  private read(name: string, actor: Actor): boolean {
    const denied = checkLedgerAccess(name, actor);
    if (denied) throw nestError(denied);
    return this.checkName(name, false);
  }

  /** Tasks matching `filter` (the same rule as the core's `matches`), by key, after `cursor`. */
  async list(name: string, actor: Actor, filter: TaskFilter, cursor = 0, limit = LIST_DEFAULT_LIMIT): Promise<TaskPage> {
    if (!this.read(name, actor)) return { tasks: [], next_cursor: null, tainted: false };
    const n = Math.min(Math.max(1, Math.floor(limit)), LIST_MAX_LIMIT);
    const where = ["number > ?"];
    const args: (string | number)[] = [Math.max(0, Math.floor(cursor))];
    if (filter.status !== undefined) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.assignee === null) where.push("assignee IS NULL");
    else if (filter.assignee !== undefined) {
      where.push("assignee = ?");
      args.push(filter.assignee);
    }
    if (filter.parent !== undefined) {
      const p = this.task(filter.parent);
      if (!p) throw new NestError(ErrorCodes.NOT_FOUND, `no task ${filter.parent} in ledger ${name}`, 404);
      where.push("parent = ?");
      args.push(p.id);
    }
    if (filter.label !== undefined) {
      where.push("EXISTS (SELECT 1 FROM json_each(tasks.labels) WHERE json_each.value = ?)");
      args.push(filter.label);
    }
    if (filter.text !== undefined) {
      where.push("instr(search, ?) > 0");
      args.push(filter.text.toLowerCase());
    }
    const rows = this.sql.exec<{ body: string }>(`SELECT body FROM tasks WHERE ${where.join(" AND ")} ORDER BY number LIMIT ?`, ...args, n + 1).toArray();
    const tasks = rows.slice(0, n).map((r) => this.view(this.parseTask(r.body)));
    return { tasks, next_cursor: rows.length > n ? tasks[tasks.length - 1]!.number : null, tainted: tasks.some((t) => t.tainted) };
  }

  async get(name: string, actor: Actor, ref: string): Promise<TaskDetail> {
    const t = this.read(name, actor) ? this.task(ref) : undefined;
    if (!t) throw new NestError(ErrorCodes.NOT_FOUND, `no task ${ref} in ledger ${name}`, 404);
    const comments = this.sql.exec<Omit<CommentView, "tainted"> & { tainted: number }>(
      "SELECT id, author, body, ms, tainted FROM comments WHERE task = ? ORDER BY id DESC LIMIT ?", t.id, GET_COMMENTS)
      .toArray().reverse().map((c) => ({ ...c, tainted: c.tainted === 1 }));
    const history = this.sql.exec<{ actor: string; field: HistoryEntry["field"]; from_v: string; to_v: string; ms: number }>(
      "SELECT actor, field, from_v, to_v, ms FROM history WHERE task = ? ORDER BY id DESC LIMIT ?", t.id, GET_HISTORY).toArray().reverse()
      .map((h) => ({ actor: h.actor, field: h.field, from: JSON.parse(h.from_v) as HistoryValue, to: JSON.parse(h.to_v) as HistoryValue, ms: h.ms }));
    const comment_count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM comments WHERE task = ?", t.id).one().n;
    const task = this.view(t);
    // History holds old text too, but a tainted text write made the task tainted for good.
    return { task, comments, comment_count, history, tainted: task.tainted || comments.some((c) => c.tainted) };
  }

  /** Deliver due notices (each deleted only once its channel took it, or never can), and prune daily. */
  override async alarm(): Promise<void> {
    const name = this.kv("name");
    if (name === undefined) return;
    const now = Date.now();
    const due = this.sql.exec<{ id: number; channel: string; body: string; attempts: number }>(
      "SELECT id, channel, body, attempts FROM outbox WHERE next_ms <= ? ORDER BY id LIMIT ?", now, NOTICES_PER_ALARM).toArray();
    for (const n of due) {
      const row: OutboxRow = { id: n.id, channel: n.channel, body: JSON.parse(n.body) as Notice["post"], idem: `ledger/${name}/${n.id}` };
      try {
        // An agent that doesn't exist was checked when assigned; an agent is never deleted today.
        if ((await deliverNotice(this.env, name, row)) === "gone") console.error(`ledger ${name}: ${n.channel} doesn't exist; notice dropped`);
        this.sql.exec("DELETE FROM outbox WHERE id = ?", n.id);
      } catch (e) {
        console.error(`ledger ${name}: notice to ${n.channel} failed; retrying`, e);
        this.sql.exec("UPDATE outbox SET attempts = attempts + 1, next_ms = ? WHERE id = ?", Date.now() + noticeRetryMs(n.attempts), n.id);
      }
    }
    if (Number(this.kv("last_prune") ?? "0") + PRUNE_EVERY_MS <= now) this.prune(now);
    await this.arm();
  }

  private prune(now: number): void {
    const closed = `SELECT id FROM tasks WHERE status IN (${sqlIn(CLOSED_STATUSES)}) AND updated_ms < ?`;
    this.sql.exec(`DELETE FROM comments WHERE task IN (${closed})`, now - CLOSED_TASK_DETAIL_MS);
    this.sql.exec(`DELETE FROM history WHERE task IN (${closed})`, now - CLOSED_TASK_DETAIL_MS);
    this.sql.exec("DELETE FROM applied WHERE ts_ms < ?", now - APPLIED_RETENTION_MS);
    this.setKv("last_prune", String(now));
  }
}
