// The task ledger's decisions (docs/control-plane/durable-objects/tasks/): a pure, synchronous core.
// `applyTaskOp(ledger, actor, op, ctx)` validates an operation, checks who may do it and which status
// transitions are allowed, and returns the change to persist (the task, its history entries, a
// comment, the watcher) and the inbox notices to deliver, or a refusal. It reads the ledger only
// through `LedgerView` (synchronous lookups), takes the time and the new task's id as inputs, awaits
// nothing and throws nothing: TaskLedgerDO is the I/O shell (load, apply, persist in one synchronous
// step, deliver notices from its alarm).
import { z } from "zod";

/** A ledger's name: a label value (letters, digits, `_`, `.`, `-`; at most 64). */
export const LedgerName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, "a ledger name is letters, digits, '_', '.' and '-' (at most 64)");

export const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
export const TaskStatus = z.enum(TASK_STATUSES);
export type TaskStatus = z.output<typeof TaskStatus>;
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export const TaskPriority = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.output<typeof TaskPriority>;

/** The `tasks` capability's tools (read and write within the rules below) and `tasks-admin`'s. */
export const TASK_TOOLS = ["task_list", "task_get", "task_create", "task_update", "task_comment"] as const;
export const TASK_ADMIN_TOOLS = ["task_assign", "task_update_any", "task_cancel", "task_set_watcher"] as const;
export const ALL_TASK_TOOLS: readonly string[] = [...TASK_TOOLS, ...TASK_ADMIN_TOOLS];

// Bounds (docs/data/#retention): every field and every per-task list is bounded.
export const LIMITS = {
  title: 200,
  description: 20_000,
  labels: 10,
  comment: 10_000,
  /** Tasks per ledger: a create beyond it is refused. */
  tasks: 10_000,
  /** Comments per task: a comment beyond it is refused (none is ever dropped silently). */
  comments: 1_000,
} as const;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,39}$/;

/**
 * The statuses a non-admin `update` may move a task to. Done and canceled are final for it (an admin
 * reopens), and only an admin cancels.
 */
export const WORKER_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  backlog: ["todo", "in_progress"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review", "done"],
  in_review: ["in_progress", "done"],
  done: [],
  canceled: [],
};
/** Statuses whose arrival notifies the task's creator, its assignee and the ledger's watcher. */
export const NOTIFY_STATUSES: readonly TaskStatus[] = ["in_review", "done", "canceled"];
/** What a non-admin create may start a task in. */
export const CREATE_STATUSES: readonly TaskStatus[] = ["backlog", "todo"];

export interface Task {
  id: string;
  /** Per-ledger sequence number: the human key is `T-<number>`. */
  number: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  labels: string[];
  /** The parent task's id (sub-issues: same ledger, never a cycle). */
  parent: string | null;
  /** An agent id, or `operator`. */
  created_by: string;
  created_ms: number;
  updated_ms: number;
  /** Bumped by every change; an update may name the version it read (`expected_version`). */
  version: number;
}

export const taskKey = (t: Pick<Task, "number">) => `T-${t.number}`;

export interface Comment {
  task: string;
  author: string;
  body: string;
  ms: number;
}

/** A history entry's old or new value: a string field, null, or the label list. */
export type HistoryValue = string | null | string[];

/** One changed field. */
export interface HistoryEntry {
  task: string;
  actor: string;
  field: string;
  from: HistoryValue;
  to: HistoryValue;
  ms: number;
}

/** An inbox post to deliver (TaskLedgerDO's outbox, from its alarm). */
export interface Notice {
  agent: string;
  text: string;
}

/**
 * Who acts. An agent acts on the one ledger its spec grants (`ledger`), as an admin only through a
 * `tasks-admin` tool (AgentDO checked the tool against the agent's spec); the operator holds the root.
 */
export type Actor = { kind: "agent"; agent: string; ledger: string; admin: boolean } | { kind: "operator" };
export const actorLabel = (a: Actor) => (a.kind === "operator" ? "operator" : a.agent);
const isAdmin = (a: Actor) => a.kind === "operator" || a.admin;

/**
 * What an agent's spec says about a ledger, as the shell read it: its `ledger` param and its tools.
 * An agent may be assigned a task, or watch a ledger, only if its spec grants that ledger.
 */
export interface SpecGrant {
  agent: string;
  ledger: string | null;
  tools: readonly string[];
}
export const grantsLedger = (g: SpecGrant, ledger: string) => g.ledger === ledger && g.tools.some((t) => ALL_TASK_TOOLS.includes(t));

/** Edits a task may carry; `undefined` leaves a field alone. */
export interface TaskEdits {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  labels?: string[];
  /** A task reference (`T-<n>` or an id), or null to clear. */
  parent?: string | null;
}

export type TaskOp =
  | ({ kind: "create"; assignee?: SpecGrant | null } & TaskEdits & { title: string })
  /** The caller's own task (assigned to or created by it): title, description, labels, status within WORKER_TRANSITIONS. */
  | ({ kind: "update"; task: string; expected_version?: number } & Pick<TaskEdits, "title" | "description" | "status" | "labels">)
  /** Admin: any field of any task (assignment goes through `assign`). */
  | ({ kind: "update_any"; task: string; expected_version?: number } & TaskEdits)
  | { kind: "assign"; task: string; expected_version?: number; assignee: SpecGrant | null }
  | { kind: "cancel"; task: string; expected_version?: number; reason?: string }
  | { kind: "comment"; task: string; body: string }
  | { kind: "set_watcher"; watcher: SpecGrant | null };

/** The ledger as the core reads it: synchronous lookups over the shell's storage (or a Map in tests). */
export interface LedgerView {
  name: string;
  /** The number the next task gets. */
  next: number;
  taskCount: number;
  watcher: string | null;
  /** A task by id (`tsk_…`) or key (`T-<n>`). */
  get(ref: string): Task | undefined;
  commentCount(task: string): number;
}

/** What the shell persists, in one synchronous step, and then delivers. */
export interface Applied {
  /** The task the op touched, as it now is (unchanged for a no-op, a comment or a watcher change). */
  task: Task | null;
  /** The task row to write (absent: nothing changed). */
  put?: Task;
  /** The ledger's next number after the op. */
  next: number;
  history: HistoryEntry[];
  comment?: Comment;
  /** The ledger's watcher after the op (absent: unchanged). */
  watcher?: string | null;
  notices: Notice[];
}

export type RefusalCode = "forbidden" | "invalid_message" | "not_found" | "conflict";
export interface Refusal {
  code: RefusalCode;
  message: string;
}
export type ApplyResult = { ok: true; value: Applied } | { ok: false; error: Refusal };

/** The inputs a pure core can't make itself: the time, and the id a created task gets. */
export interface ApplyContext {
  now: number;
  newId: string;
}

const refuse = (code: RefusalCode, message: string): ApplyResult => ({ ok: false, error: { code, message } });

/** Whether `actor` may act on ledger `name` at all (reads included). */
export function checkLedgerAccess(name: string, actor: Actor): Refusal | null {
  if (actor.kind === "agent" && actor.ledger !== name) {
    return { code: "forbidden", message: `this agent's ledger is ${actor.ledger}, not ${name}` };
  }
  return null;
}

function checkEdits(e: TaskEdits): Refusal | null {
  const bad = (message: string): Refusal => ({ code: "invalid_message", message });
  if (e.title !== undefined) {
    if (e.title.trim().length === 0) return bad("title is empty");
    if (e.title.length > LIMITS.title) return bad(`title is longer than ${LIMITS.title}`);
  }
  if (e.description !== undefined && e.description.length > LIMITS.description) return bad(`description is longer than ${LIMITS.description}`);
  if (e.status !== undefined && !TaskStatus.safeParse(e.status).success) return bad(`unknown status ${String(e.status)}`);
  if (e.priority !== undefined && !TaskPriority.safeParse(e.priority).success) return bad(`unknown priority ${String(e.priority)}`);
  if (e.labels !== undefined) {
    if (e.labels.length > LIMITS.labels) return bad(`at most ${LIMITS.labels} labels`);
    for (const l of e.labels) if (typeof l !== "string" || !LABEL.test(l)) return bad(`bad label ${JSON.stringify(l)}`);
    if (new Set(e.labels).size !== e.labels.length) return bad("a label is listed twice");
  }
  return null;
}

/** Whether making `parent` the parent of `task` (null: a new task) keeps the tree a tree. */
function checkParent(ledger: LedgerView, task: string | null, parent: string): { ok: true; id: string } | { ok: false; error: Refusal } {
  const p = ledger.get(parent);
  if (!p) return { ok: false, error: { code: "not_found", message: `no task ${parent} in ledger ${ledger.name}` } };
  // Walk up from the new parent: reaching `task` would close a cycle. The walk is bounded by the
  // ledger's size, so a stored cycle (which this check keeps from ever forming) can't loop forever.
  const seen = new Set<string>();
  for (let cur: Task | undefined = p; cur; cur = cur.parent === null ? undefined : ledger.get(cur.parent)) {
    if (cur.id === task) return { ok: false, error: { code: "invalid_message", message: `${parent} is ${task === p.id ? "the task itself" : "a sub-task of it"}: a parent can't form a cycle` } };
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
  }
  return { ok: true, id: p.id };
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Apply `edits` to `before`: the new task (version + 1) and one history entry per changed field, or
 * null when nothing changes. Edits are already validated.
 */
function change(before: Task, edits: Omit<TaskEdits, "parent"> & { parent?: string | null; assignee?: string | null }, actor: string, now: number) {
  const after: Task = { ...before };
  const history: HistoryEntry[] = [];
  type Field = "title" | "description" | "status" | "priority" | "labels" | "parent" | "assignee";
  const set = <K extends Field>(field: K, to: Task[K] | undefined, same = (a: Task[K], b: Task[K]) => a === b) => {
    if (to === undefined || same(before[field], to)) return;
    after[field] = to;
    history.push({ task: before.id, actor, field, from: before[field], to, ms: now });
  };
  set("title", edits.title);
  set("description", edits.description);
  set("status", edits.status);
  set("priority", edits.priority);
  set("labels", edits.labels === undefined ? undefined : [...edits.labels], (a, b) => sameList(a as string[], b as string[]));
  set("parent", edits.parent);
  set("assignee", edits.assignee);
  if (!history.length) return null;
  after.version = before.version + 1;
  after.updated_ms = Math.max(before.updated_ms, now);
  return { after, history };
}

/** The inbox notices a status change brings: the creator, the assignee and the watcher, never the actor, each once. */
function statusNotices(ledger: LedgerView, before: Task, after: Task, actor: string): Notice[] {
  if (before.status === after.status || !NOTIFY_STATUSES.includes(after.status)) return [];
  const to = new Set<string>();
  for (const a of [after.created_by, after.assignee, ledger.watcher]) {
    if (a && a.startsWith("agt_") && a !== actor) to.add(a);
  }
  const text = `${taskKey(after)} is ${after.status} (by ${actor}, ledger ${ledger.name}): ${after.title}`;
  return [...to].map((agent) => ({ agent, text }));
}

function resolve(ledger: LedgerView, ref: string): { ok: true; task: Task } | { ok: false; error: Refusal } {
  const t = ledger.get(ref);
  return t ? { ok: true, task: t } : { ok: false, error: { code: "not_found", message: `no task ${ref} in ledger ${ledger.name}` } };
}

function checkVersion(t: Task, expected: number | undefined): Refusal | null {
  if (expected !== undefined && expected !== t.version) {
    return { code: "conflict", message: `${taskKey(t)} is at version ${t.version}, not ${expected}: read it again and retry` };
  }
  return null;
}

/** The core's one entry point: an operation on `ledger` by `actor`, decided. */
export function applyTaskOp(ledger: LedgerView, actor: Actor, op: TaskOp, ctx: ApplyContext): ApplyResult {
  const denied = checkLedgerAccess(ledger.name, actor);
  if (denied) return { ok: false, error: denied };
  const who = actorLabel(actor);
  const unchanged = (task: Task): ApplyResult => ({ ok: true, value: { task, next: ledger.next, history: [], notices: [] } });

  switch (op.kind) {
    case "create": {
      const bad = checkEdits(op);
      if (bad) return { ok: false, error: bad };
      if (op.title === undefined) return refuse("invalid_message", "title is required");
      if (!isAdmin(actor)) {
        if (op.status !== undefined && !CREATE_STATUSES.includes(op.status)) {
          return refuse("forbidden", `a task is created in ${CREATE_STATUSES.join(" or ")}`);
        }
        if (op.priority !== undefined && op.priority !== "none") return refuse("forbidden", "priority is set with task_update_any");
        if (op.assignee) return refuse("forbidden", "assignment is task_assign's");
      }
      if (ledger.taskCount >= LIMITS.tasks) return refuse("invalid_message", `ledger ${ledger.name} holds ${LIMITS.tasks} tasks, its limit`);
      let parent: string | null = null;
      if (op.parent !== undefined && op.parent !== null) {
        const p = checkParent(ledger, null, op.parent);
        if (!p.ok) return { ok: false, error: p.error };
        parent = p.id;
      }
      let assignee: string | null = null;
      if (op.assignee) {
        if (!grantsLedger(op.assignee, ledger.name)) return refuse("forbidden", `${op.assignee.agent} has no access to ledger ${ledger.name}`);
        assignee = op.assignee.agent;
      }
      if (ledger.get(ctx.newId)) return refuse("conflict", `task id ${ctx.newId} is taken`);
      const task: Task = {
        id: ctx.newId,
        number: ledger.next,
        title: op.title,
        description: op.description ?? "",
        status: op.status ?? "backlog",
        priority: op.priority ?? "none",
        assignee,
        labels: [...(op.labels ?? [])],
        parent,
        created_by: who,
        created_ms: ctx.now,
        updated_ms: ctx.now,
        version: 1,
      };
      const notices: Notice[] = assignee && assignee !== who
        ? [{ agent: assignee, text: `assigned ${taskKey(task)} (ledger ${ledger.name}, by ${who}): ${task.title}` }]
        : [];
      return {
        ok: true,
        value: { task, put: task, next: ledger.next + 1, history: [{ task: task.id, actor: who, field: "created", from: null, to: taskKey(task), ms: ctx.now }], notices },
      };
    }

    case "update":
    case "update_any": {
      if (op.kind === "update_any" && !isAdmin(actor)) return refuse("forbidden", "task_update_any is an admin tool");
      const r = resolve(ledger, op.task);
      if (!r.ok) return r;
      const before = r.task;
      const conflict = checkVersion(before, op.expected_version);
      if (conflict) return { ok: false, error: conflict };
      if (op.kind === "update") {
        // Field by field: a caller's object that names more than `update` takes is refused, whatever its type said.
        const extra = Object.keys(op).filter((k) => !["kind", "task", "expected_version", "title", "description", "status", "labels"].includes(k)
          && (op as Record<string, unknown>)[k] !== undefined);
        if (extra.length) return refuse("forbidden", `task_update can't change ${extra.join(", ")}; that is task_update_any's`);
        if (actor.kind === "agent" && before.assignee !== actor.agent && before.created_by !== actor.agent) {
          return refuse("forbidden", `${taskKey(before)} is neither assigned to nor created by ${actor.agent}`);
        }
      }
      const bad = checkEdits(op);
      if (bad) return { ok: false, error: bad };
      if (op.kind === "update" && op.status !== undefined && op.status !== before.status && !WORKER_TRANSITIONS[before.status].includes(op.status)) {
        return refuse("forbidden", `${taskKey(before)} can't move from ${before.status} to ${op.status} (allowed: ${WORKER_TRANSITIONS[before.status].join(", ") || "none"})`);
      }
      let parent: string | null | undefined;
      if (op.kind === "update_any" && op.parent !== undefined) {
        if (op.parent === null) parent = null;
        else {
          const p = checkParent(ledger, before.id, op.parent);
          if (!p.ok) return { ok: false, error: p.error };
          parent = p.id;
        }
      }
      const c = change(before, {
        title: op.title, description: op.description, status: op.status, labels: op.labels, parent,
        priority: op.kind === "update_any" ? op.priority : undefined,
      }, who, ctx.now);
      if (!c) return unchanged(before);
      return { ok: true, value: { task: c.after, put: c.after, next: ledger.next, history: c.history, notices: statusNotices(ledger, before, c.after, who) } };
    }

    case "assign": {
      if (!isAdmin(actor)) return refuse("forbidden", "task_assign is an admin tool");
      const r = resolve(ledger, op.task);
      if (!r.ok) return r;
      const before = r.task;
      const conflict = checkVersion(before, op.expected_version);
      if (conflict) return { ok: false, error: conflict };
      if (op.assignee && !grantsLedger(op.assignee, ledger.name)) {
        return refuse("forbidden", `${op.assignee.agent} has no access to ledger ${ledger.name}: its spec must grant it`);
      }
      const to = op.assignee?.agent ?? null;
      const c = change(before, { assignee: to }, who, ctx.now);
      if (!c) return unchanged(before);
      const notices: Notice[] = [];
      if (to && to !== who) notices.push({ agent: to, text: `assigned ${taskKey(before)} (ledger ${ledger.name}, by ${who}): ${before.title}` });
      if (before.assignee && before.assignee !== who) {
        notices.push({ agent: before.assignee, text: `${taskKey(before)} is now ${to ? `assigned to ${to}` : "unassigned"} (ledger ${ledger.name}, by ${who}): ${before.title}` });
      }
      return { ok: true, value: { task: c.after, put: c.after, next: ledger.next, history: c.history, notices } };
    }

    case "cancel": {
      if (!isAdmin(actor)) return refuse("forbidden", "task_cancel is an admin tool");
      const r = resolve(ledger, op.task);
      if (!r.ok) return r;
      const before = r.task;
      const conflict = checkVersion(before, op.expected_version);
      if (conflict) return { ok: false, error: conflict };
      if (before.status === "canceled") return refuse("invalid_message", `${taskKey(before)} is already canceled`);
      if (op.reason !== undefined && op.reason.length > LIMITS.comment) return refuse("invalid_message", `reason is longer than ${LIMITS.comment}`);
      const c = change(before, { status: "canceled" }, who, ctx.now)!;
      const reason = op.reason?.trim();
      const withComment = reason && ledger.commentCount(before.id) < LIMITS.comments;
      return {
        ok: true,
        value: {
          task: c.after, put: c.after, next: ledger.next, history: c.history, notices: statusNotices(ledger, before, c.after, who),
          ...(withComment ? { comment: { task: before.id, author: who, body: `Canceled: ${reason}`, ms: ctx.now } } : {}),
        },
      };
    }

    case "comment": {
      const r = resolve(ledger, op.task);
      if (!r.ok) return r;
      if (op.body.trim().length === 0) return refuse("invalid_message", "comment is empty");
      if (op.body.length > LIMITS.comment) return refuse("invalid_message", `comment is longer than ${LIMITS.comment}`);
      if (ledger.commentCount(r.task.id) >= LIMITS.comments) return refuse("invalid_message", `${taskKey(r.task)} has ${LIMITS.comments} comments, its limit`);
      return { ok: true, value: { task: r.task, next: ledger.next, history: [], comment: { task: r.task.id, author: who, body: op.body, ms: ctx.now }, notices: [] } };
    }

    case "set_watcher": {
      if (!isAdmin(actor)) return refuse("forbidden", "task_set_watcher is an admin tool");
      if (op.watcher && !grantsLedger(op.watcher, ledger.name)) {
        return refuse("forbidden", `${op.watcher.agent} has no access to ledger ${ledger.name}: its spec must grant it`);
      }
      return { ok: true, value: { task: null, next: ledger.next, history: [], watcher: op.watcher?.agent ?? null, notices: [] } };
    }
  }
}

// --- Reads ---------------------------------------------------------------------------------------------

/** `task_list`'s filters. `assignee` is an agent id or `none` (the tool's `me` is resolved by the caller). */
export interface TaskFilter {
  status?: TaskStatus;
  assignee?: string;
  label?: string;
  text?: string;
  /** A task reference: its direct sub-tasks. */
  parent?: string;
}

/** Whether `t` passes `f` (`parentId`: the filter's parent, resolved). The shell's SQL applies the same rule. */
export function matches(t: Task, f: TaskFilter, parentId?: string | null): boolean {
  if (f.status !== undefined && t.status !== f.status) return false;
  if (f.assignee !== undefined && (f.assignee === "none" ? t.assignee !== null : t.assignee !== f.assignee)) return false;
  if (f.label !== undefined && !t.labels.includes(f.label)) return false;
  if (f.text !== undefined && !`${t.title}\n${t.description}`.toLowerCase().includes(f.text.toLowerCase())) return false;
  if (f.parent !== undefined && t.parent !== parentId) return false;
  return true;
}
