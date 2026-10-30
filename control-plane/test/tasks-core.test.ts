// The task ledger's pure core (lib/tasks.ts), checked directly: unit tests of each rule, then seeded
// random operation sequences (a small PRNG, not fast-check: it isn't a dependency) against the
// invariants: status moves only by allowed transitions, versions strictly increase, history records
// every change, a non-admin never changes assignment or priority or another's task, parents never
// form a cycle, and a refusal changes nothing.
import { describe, expect, it } from "vitest";
import {
  type Actor, type Applied, applyTaskOp, type ApplyResult, CREATE_STATUSES, type HistoryEntry, LIMITS, type LedgerView, matches, type Notice,
  NOTIFY_STATUSES, type SpecGrant, type Task, TASK_PRIORITIES, TASK_STATUSES, TASK_TOOLS, type TaskOp, type TaskStatus, taskKey, WORKER_TRANSITIONS,
} from "../src/lib/tasks";

const L = "proj-a";

/** An in-memory ledger: the core's view, and the state a persisted `Applied` gives. */
class Mem implements LedgerView {
  name = L;
  next = 1;
  watcher: string | null = null;
  tasks = new Map<string, Task>();
  comments = new Map<string, number>();
  history: HistoryEntry[] = [];
  notices: Notice[] = [];
  private ids = 0;
  get taskCount() {
    return this.tasks.size;
  }
  get(ref: string) {
    const m = /^T-(\d+)$/.exec(ref);
    if (m) return [...this.tasks.values()].find((t) => t.number === Number(m[1]));
    return this.tasks.get(ref);
  }
  commentCount(task: string) {
    return this.comments.get(task) ?? 0;
  }
  commit(a: Applied) {
    if (a.put) this.tasks.set(a.put.id, structuredClone(a.put));
    this.next = a.next;
    this.history.push(...a.history);
    if (a.comment) this.comments.set(a.comment.task, this.commentCount(a.comment.task) + 1);
    if (a.watcher !== undefined) this.watcher = a.watcher;
    this.notices.push(...a.notices);
  }
  /** Apply and, when accepted, commit. */
  run(actor: Actor, op: TaskOp, now = 1_000): ApplyResult {
    const r = applyTaskOp(this, actor, op, { now, newId: `tsk_${++this.ids}` });
    if (r.ok) this.commit(r.value);
    return r;
  }
}

const worker = (agent: string, ledger = L): Actor => ({ kind: "agent", agent, ledger, admin: false });
const admin = (agent: string, ledger = L): Actor => ({ kind: "agent", agent, ledger, admin: true });
const operator: Actor = { kind: "operator" };
const grant = (agent: string, ledger: string | null = L, tools: readonly string[] = TASK_TOOLS): SpecGrant => ({ agent, ledger, tools });
const W1 = "agt_w1";
const W2 = "agt_w2";
const CAP = "agt_cap";

function ok(r: ApplyResult): Applied {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const code = (r: ApplyResult) => (r.ok ? "ok" : r.error.code);

function create(m: Mem, actor: Actor = worker(W1), extra: Partial<Extract<TaskOp, { kind: "create" }>> = {}): Task {
  return ok(m.run(actor, { kind: "create", title: "Fix the build", ...extra })).task!;
}

describe("create", () => {
  it("numbers tasks T-1, T-2, …; starts at version 1 in backlog, unassigned, with a `created` history entry", () => {
    const m = new Mem();
    const t = create(m);
    expect(t).toMatchObject({ number: 1, status: "backlog", priority: "none", assignee: null, created_by: W1, version: 1, parent: null });
    expect(taskKey(t)).toBe("T-1");
    expect(create(m).number).toBe(2);
    expect(m.history[0]).toMatchObject({ task: t.id, actor: W1, field: "created", from: null, to: "T-1" });
  });

  it("a non-admin creates in backlog or todo only, unassigned and without priority", () => {
    const m = new Mem();
    for (const s of TASK_STATUSES) {
      expect(code(m.run(worker(W1), { kind: "create", title: "x", status: s })), s).toBe(CREATE_STATUSES.includes(s) ? "ok" : "forbidden");
    }
    expect(code(m.run(worker(W1), { kind: "create", title: "x", priority: "high" }))).toBe("forbidden");
    expect(code(m.run(worker(W1), { kind: "create", title: "x", assignee: grant(W1) }))).toBe("forbidden");
    // tasks-admin doesn't widen create either: task_create is a `tasks` tool, called as a non-admin.
    expect(code(m.run(operator, { kind: "create", title: "x", status: "in_progress", priority: "urgent", assignee: grant(W2) }))).toBe("ok");
    expect(m.notices).toEqual([{ agent: W2, text: expect.stringMatching(/^assigned T-\d+ \(ledger proj-a, by operator\): x$/) }]);
  });

  it("validates bounds: title, description, labels; and the ledger's size", () => {
    const m = new Mem();
    const c = (op: Partial<Extract<TaskOp, { kind: "create" }>>) => code(m.run(worker(W1), { kind: "create", title: "x", ...op }));
    expect(c({ title: "  " })).toBe("invalid_message");
    expect(c({ title: "x".repeat(LIMITS.title + 1) })).toBe("invalid_message");
    expect(c({ title: "x".repeat(LIMITS.title) })).toBe("ok");
    expect(c({ description: "d".repeat(LIMITS.description + 1) })).toBe("invalid_message");
    expect(c({ labels: Array.from({ length: LIMITS.labels + 1 }, (_, i) => `l${i}`) })).toBe("invalid_message");
    expect(c({ labels: ["ok", "ok"] })).toBe("invalid_message");
    expect(c({ labels: ["has space"] })).toBe("invalid_message");
    expect(c({ labels: ["area:ui", "p/1"] })).toBe("ok");
    const full = Object.assign(new Mem(), {});
    Object.defineProperty(full, "taskCount", { get: () => LIMITS.tasks });
    expect(code(applyTaskOp(full, worker(W1), { kind: "create", title: "x" }, { now: 1, newId: "tsk_x" }))).toBe("invalid_message");
  });

  it("a parent must exist in the ledger", () => {
    const m = new Mem();
    const p = create(m);
    expect(create(m, worker(W1), { parent: "T-1" }).parent).toBe(p.id);
    expect(create(m, worker(W1), { parent: p.id }).parent).toBe(p.id);
    expect(code(m.run(worker(W1), { kind: "create", title: "x", parent: "T-99" }))).toBe("not_found");
  });
});

describe("update (the tasks capability)", () => {
  it("the creator and the assignee may update; anyone else is refused", () => {
    const m = new Mem();
    const t = create(m, worker(W1));
    ok(m.run(operator, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    expect(code(m.run(worker(W1), { kind: "update", task: "T-1", title: "by creator" }))).toBe("ok");
    expect(code(m.run(worker(W2), { kind: "update", task: t.id, title: "by assignee" }))).toBe("ok");
    expect(code(m.run(worker("agt_other"), { kind: "update", task: "T-1", title: "nope" }))).toBe("forbidden");
    expect(m.get("T-1")!.title).toBe("by assignee");
  });

  it("status moves only along WORKER_TRANSITIONS; canceled never", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (from === to) continue;
        const m = new Mem();
        create(m, operator, { status: from });
        ok(m.run(operator, { kind: "assign", task: "T-1", assignee: grant(W1) }));
        const r = m.run(worker(W1), { kind: "update", task: "T-1", status: to });
        expect(code(r), `${from} -> ${to}`).toBe(WORKER_TRANSITIONS[from].includes(to) ? "ok" : "forbidden");
      }
    }
    expect(Object.values(WORKER_TRANSITIONS).flat()).not.toContain("canceled");
  });

  it("can't change priority, parent or assignment, whatever the op object carries", () => {
    const m = new Mem();
    create(m);
    create(m);
    for (const extra of [{ priority: "high" }, { parent: "T-2" }, { assignee: W1 }]) {
      expect(code(m.run(worker(W1), { kind: "update", task: "T-1", ...extra } as TaskOp)), JSON.stringify(extra)).toBe("forbidden");
    }
    expect(m.get("T-1")).toMatchObject({ priority: "none", parent: null, assignee: null, version: 1 });
  });

  it("an unchanged update is a no-op: same version, no history", () => {
    const m = new Mem();
    const t = create(m);
    const before = m.history.length;
    const a = ok(m.run(worker(W1), { kind: "update", task: "T-1", title: t.title, labels: [] }));
    expect(a.put).toBeUndefined();
    expect(a.task!.version).toBe(1);
    expect(m.history.length).toBe(before);
  });

  it("expected_version: a stale one is a conflict and changes nothing", () => {
    const m = new Mem();
    create(m);
    ok(m.run(worker(W1), { kind: "update", task: "T-1", title: "v2", expected_version: 1 }));
    const r = m.run(worker(W1), { kind: "update", task: "T-1", title: "lost", expected_version: 1 });
    expect(r).toEqual({ ok: false, error: { code: "conflict", message: "T-1 is at version 2, not 1: read it again and retry" } });
    expect(m.get("T-1")).toMatchObject({ title: "v2", version: 2 });
  });
});

describe("the tasks-admin operations", () => {
  it("are refused to a non-admin", () => {
    const m = new Mem();
    create(m);
    for (const op of [
      { kind: "assign", task: "T-1", assignee: grant(W1) },
      { kind: "update_any", task: "T-1", priority: "high" },
      { kind: "cancel", task: "T-1" },
      { kind: "set_watcher", watcher: grant(W1) },
    ] as TaskOp[]) expect(code(m.run(worker(W1), op)), op.kind).toBe("forbidden");
    expect(m.get("T-1")!.version).toBe(1);
    expect(m.watcher).toBeNull();
  });

  it("assign: the assignee's spec must grant this ledger; the assignee (and a previous one) is told, never the actor", () => {
    const m = new Mem();
    create(m);
    expect(code(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W1, "other") }))).toBe("forbidden");
    expect(code(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W1, null) }))).toBe("forbidden");
    expect(code(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W1, L, ["notify"]) }))).toBe("forbidden");
    ok(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W1) }));
    expect(m.notices).toEqual([{ agent: W1, text: "assigned T-1 (ledger proj-a, by agt_cap): Fix the build" }]);
    ok(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W2) }));
    expect(m.notices.slice(1).map((n) => n.agent)).toEqual([W2, W1]);
    ok(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(CAP, L, ["task_assign"]) }));
    expect(m.notices.slice(3).map((n) => n.agent)).toEqual([W2]);
    expect(m.history.filter((h) => h.field === "assignee").map((h) => [h.from, h.to])).toEqual([[null, W1], [W1, W2], [W2, CAP]]);
  });

  it("update_any: any status, priority and parent; a parent can't form a cycle", () => {
    const m = new Mem();
    create(m); // T-1
    create(m, worker(W1), { parent: "T-1" }); // T-2
    create(m, worker(W1), { parent: "T-2" }); // T-3
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-1", parent: "T-3" }))).toBe("invalid_message");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-1", parent: "T-1" }))).toBe("invalid_message");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-3", parent: "T-1" }))).toBe("ok");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-2", parent: null }))).toBe("ok");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-1", parent: "T-2" }))).toBe("ok");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-1", status: "done", priority: "urgent" }))).toBe("ok");
    expect(code(m.run(admin(CAP), { kind: "update_any", task: "T-1", status: "backlog" }))).toBe("ok");
    expect(m.get("T-1")).toMatchObject({ status: "backlog", priority: "urgent" });
  });

  it("cancel: once; the reason becomes a comment; creator, assignee and watcher are told, the actor isn't", () => {
    const m = new Mem();
    create(m, worker(W1));
    ok(m.run(admin(CAP), { kind: "assign", task: "T-1", assignee: grant(W2) }));
    ok(m.run(admin(CAP), { kind: "set_watcher", watcher: grant("agt_watch") }));
    m.notices = [];
    const a = ok(m.run(admin(CAP), { kind: "cancel", task: "T-1", reason: "dup of T-9" }));
    expect(a.comment).toMatchObject({ author: CAP, body: "Canceled: dup of T-9" });
    expect(m.notices.map((n) => n.agent).sort()).toEqual([W1, W2, "agt_watch"].sort());
    expect(code(m.run(admin(CAP), { kind: "cancel", task: "T-1" }))).toBe("invalid_message");
  });

  it("set_watcher: an agent whose spec grants the ledger, or none", () => {
    const m = new Mem();
    expect(code(m.run(admin(CAP), { kind: "set_watcher", watcher: grant("agt_x", "elsewhere") }))).toBe("forbidden");
    expect(ok(m.run(admin(CAP), { kind: "set_watcher", watcher: grant("agt_x") })).watcher).toBe("agt_x");
    expect(ok(m.run(operator, { kind: "set_watcher", watcher: null })).watcher).toBeNull();
  });
});

describe("notices and comments", () => {
  it("in_review, done and canceled notify the creator and the watcher (not the actor); other moves notify nobody", () => {
    const m = new Mem();
    create(m, worker(W1));
    ok(m.run(operator, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    ok(m.run(operator, { kind: "set_watcher", watcher: grant(CAP, L, ["task_assign"]) }));
    m.notices = [];
    ok(m.run(worker(W2), { kind: "update", task: "T-1", status: "in_progress" }));
    expect(m.notices).toEqual([]);
    ok(m.run(worker(W2), { kind: "update", task: "T-1", status: "in_review" }));
    expect(m.notices.map((n) => n.agent).sort()).toEqual([CAP, W1].sort());
    expect(m.notices[0]!.text).toBe("T-1 is in_review (by agt_w2, ledger proj-a): Fix the build");
    expect(NOTIFY_STATUSES).toEqual(["in_review", "done", "canceled"]);
  });

  it("anyone with ledger access comments on any task, within bounds", () => {
    const m = new Mem();
    create(m, worker(W1));
    expect(ok(m.run(worker("agt_any"), { kind: "comment", task: "T-1", body: "looks good" })).comment).toMatchObject({ author: "agt_any" });
    expect(m.get("T-1")!.version).toBe(1);
    expect(code(m.run(worker(W1), { kind: "comment", task: "T-1", body: " " }))).toBe("invalid_message");
    expect(code(m.run(worker(W1), { kind: "comment", task: "T-1", body: "x".repeat(LIMITS.comment + 1) }))).toBe("invalid_message");
    m.comments.set(m.get("T-1")!.id, LIMITS.comments);
    expect(code(m.run(worker(W1), { kind: "comment", task: "T-1", body: "one more" }))).toBe("invalid_message");
  });
});

describe("ledger access", () => {
  it("an agent whose ledger is another is refused every operation", () => {
    const m = new Mem();
    create(m);
    for (const actor of [worker(W1, "proj-b"), admin(CAP, "proj-b")]) {
      for (const op of [
        { kind: "create", title: "x" }, { kind: "update", task: "T-1", title: "y" }, { kind: "comment", task: "T-1", body: "z" },
        { kind: "assign", task: "T-1", assignee: null }, { kind: "update_any", task: "T-1", title: "y" }, { kind: "cancel", task: "T-1" },
        { kind: "set_watcher", watcher: null },
      ] as TaskOp[]) expect(code(m.run(actor, op)), `${JSON.stringify(actor)} ${op.kind}`).toBe("forbidden");
    }
  });
});

describe("filters", () => {
  it("match status, assignee (or none), label, text (case-insensitive) and parent", () => {
    const t: Task = {
      id: "tsk_1", number: 1, title: "Fix Login", description: "the OAuth flow", status: "todo", priority: "none", assignee: W1,
      labels: ["auth"], parent: "tsk_0", created_by: W1, created_ms: 0, updated_ms: 0, version: 1,
    };
    expect(matches(t, {})).toBe(true);
    expect(matches(t, { status: "todo", assignee: W1, label: "auth", text: "oauth", parent: "T-0" }, "tsk_0")).toBe(true);
    expect(matches(t, { status: "done" })).toBe(false);
    expect(matches(t, { assignee: "none" })).toBe(false);
    expect(matches({ ...t, assignee: null }, { assignee: "none" })).toBe(true);
    expect(matches(t, { label: "ui" })).toBe(false);
    expect(matches(t, { text: "LOGIN" })).toBe(true);
    expect(matches(t, { parent: "T-9" }, "tsk_9")).toBe(false);
  });
});

// --- Random operation sequences ------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG, so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTS = ["agt_a", "agt_b", "agt_c"];
const ACTORS: Actor[] = [
  ...AGENTS.map((a) => worker(a)), admin("agt_boss"), operator, worker("agt_out", "proj-b"), admin("agt_outboss", "proj-b"),
];
const FIELDS = ["title", "description", "status", "priority", "labels", "parent", "assignee"] as const;

function genOp(r: () => number, m: Mem): TaskOp {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const maybe = <T>(p: number, v: () => T) => (r() < p ? v() : undefined);
  const ref = () => {
    const ts = [...m.tasks.values()];
    if (!ts.length || r() < 0.08) return pick(["T-999", "tsk_nope"]);
    const t = pick(ts);
    return r() < 0.5 ? taskKey(t) : t.id;
  };
  const version = (task: string) => maybe(0.3, () => (m.get(task)?.version ?? 1) - (r() < 0.3 ? 1 : 0));
  const grantee = () => pick([grant(pick(AGENTS)), grant(pick(AGENTS)), grant("agt_x", "proj-b"), grant("agt_y", L, ["notify"])]);
  const edits = () => ({
    title: maybe(0.3, () => pick(["a", "b", "", "long".repeat(60)])),
    description: maybe(0.2, () => pick(["d1", "d2"])),
    status: maybe(0.5, () => pick(TASK_STATUSES)),
    labels: maybe(0.2, () => pick([[], ["x"], ["x", "y"], ["bad label"]])),
  });
  switch (pick(["create", "create", "update", "update", "update_any", "assign", "cancel", "comment", "set_watcher"] as const)) {
    case "create":
      return { kind: "create", title: pick(["t1", "t2", ""]), status: maybe(0.4, () => pick(TASK_STATUSES)), priority: maybe(0.2, () => pick(TASK_PRIORITIES)),
        parent: maybe(0.3, ref), assignee: maybe(0.2, grantee), labels: maybe(0.2, () => ["x"]) };
    case "update": {
      const task = ref();
      const op: TaskOp = { kind: "update", task, expected_version: version(task), ...edits() };
      // Now and then an op object carrying more than `update` takes (as a hostile caller might build).
      if (r() < 0.1) Object.assign(op, pick([{ priority: "urgent" }, { assignee: pick(AGENTS) }, { parent: null }]));
      return op;
    }
    case "update_any": {
      const task = ref();
      return { kind: "update_any", task, expected_version: version(task), ...edits(), priority: maybe(0.3, () => pick(TASK_PRIORITIES)),
        parent: maybe(0.3, () => (r() < 0.3 ? null : ref())) };
    }
    case "assign": {
      const task = ref();
      return { kind: "assign", task, expected_version: version(task), assignee: r() < 0.2 ? null : grantee() };
    }
    case "cancel": {
      const task = ref();
      return { kind: "cancel", task, expected_version: version(task), reason: maybe(0.5, () => "why") };
    }
    case "comment":
      return { kind: "comment", task: ref(), body: pick(["c", "", "more"]) };
    case "set_watcher":
      return { kind: "set_watcher", watcher: r() < 0.3 ? null : grantee() };
  }
}

/** Walking up from every task ends: no cycle. */
function acyclic(m: Mem): boolean {
  for (const t of m.tasks.values()) {
    const seen = new Set<string>();
    for (let cur: Task | undefined = t; cur; cur = cur.parent ? m.tasks.get(cur.parent) : undefined) {
      if (seen.has(cur.id)) return false;
      seen.add(cur.id);
    }
  }
  return true;
}

describe("random operation sequences (400 seeds x 80 ops)", () => {
  it("never break the ledger's invariants", () => {
    let accepted = 0;
    const seenRefusals = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const m = new Mem();
      const created = new Map<string, Task>();
      for (let step = 0; step < 80; step++) {
        const actor = ACTORS[Math.floor(r() * ACTORS.length)]!;
        const op = genOp(r, m);
        const ctx = `seed ${seed} step ${step} ${JSON.stringify(actor)} ${JSON.stringify(op)}`;
        const before = structuredClone([...m.tasks.entries()]);
        const beforeWatcher = m.watcher;
        const beforeNext = m.next;
        const noticesBefore = m.notices.length;
        const res = applyTaskOp(m, actor, op, { now: 1_000 + step, newId: `tsk_${seed}_${step}` });
        // The core only reads: whatever it decides, the ledger it was given is unchanged (a refusal changes nothing).
        expect([[...m.tasks.entries()], m.watcher, m.next], ctx).toEqual([before, beforeWatcher, beforeNext]);
        if (!res.ok) {
          seenRefusals.add(res.error.code);
          continue;
        }
        expect(actor.kind === "agent" && actor.ledger !== L, ctx).toBe(false);
        accepted++;
        const a = res.value;
        const isAdmin = actor.kind === "operator" || actor.admin;
        const who = actor.kind === "operator" ? "operator" : actor.agent;
        // Notices never go to the actor itself.
        expect(a.notices.every((n) => n.agent !== who), ctx).toBe(true);
        if (a.put) {
          const prev = before.find(([id]) => id === a.put!.id)?.[1];
          if (!prev) {
            expect(op.kind, ctx).toBe("create");
            expect(a.put.version, ctx).toBe(1);
            expect(a.put.number, ctx).toBe(beforeNext);
            created.set(a.put.id, structuredClone(a.put));
            if (!isAdmin) expect([a.put.assignee, a.put.priority, CREATE_STATUSES.includes(a.put.status)], ctx).toEqual([null, "none", true]);
          } else {
            // Versions strictly increase; history names every changed field, from its old value to its new.
            expect(a.put.version, ctx).toBe(prev.version + 1);
            const changed = FIELDS.filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(a.put![f]));
            expect(a.history.map((h) => h.field).sort(), ctx).toEqual([...changed].sort());
            for (const h of a.history) {
              expect([h.task, h.actor, h.from, h.to], ctx).toEqual([prev.id, who, prev[h.field as keyof Task], a.put[h.field as keyof Task]]);
            }
            expect([a.put.id, a.put.number, a.put.created_by, a.put.created_ms], ctx).toEqual([prev.id, prev.number, prev.created_by, prev.created_ms]);
            if (!isAdmin) {
              // A non-admin: only its own task, never assignment or priority, status only along WORKER_TRANSITIONS.
              expect(op.kind === "update" || op.kind === "comment", ctx).toBe(true);
              expect(prev.assignee === who || prev.created_by === who, ctx).toBe(true);
              expect([a.put.assignee, a.put.priority, a.put.parent], ctx).toEqual([prev.assignee, prev.priority, prev.parent]);
              if (a.put.status !== prev.status) expect(WORKER_TRANSITIONS[prev.status].includes(a.put.status), ctx).toBe(true);
            }
            if (a.put.status !== prev.status) expect(["update", "update_any", "cancel"], ctx).toContain(op.kind);
            if (a.put.assignee !== prev.assignee) expect(op.kind, ctx).toBe("assign");
          }
        } else {
          expect(a.history, ctx).toEqual([]);
        }
        if (a.watcher !== undefined) expect([op.kind, isAdmin], ctx).toEqual(["set_watcher", true]);
        if (op.kind === "assign" && a.put?.assignee) expect(a.notices.some((n) => n.agent === a.put!.assignee) || a.put.assignee === who, ctx).toBe(true);
        m.commit(a);
        expect(acyclic(m), ctx).toBe(true);
        expect(m.notices.length - noticesBefore, ctx).toBe(a.notices.length);
        if (op.kind !== "set_watcher") expect(m.watcher, ctx).toBe(beforeWatcher);
      }
      // History records every change: replaying it over each task as created gives the task as it is.
      for (const [id, t0] of created) {
        const replay: Record<string, unknown> = { ...t0 };
        for (const h of m.history.filter((x) => x.task === id && x.field !== "created")) {
          expect(replay[h.field], `seed ${seed} ${id} ${h.field}`).toEqual(h.from);
          replay[h.field] = h.to;
        }
        const now = m.tasks.get(id)!;
        for (const f of FIELDS) expect(replay[f], `seed ${seed} ${id} ${f}`).toEqual(now[f]);
      }
      // Keys are unique and dense.
      expect([...m.tasks.values()].map((t) => t.number).sort((x, y) => x - y)).toEqual(Array.from({ length: m.tasks.size }, (_, i) => i + 1));
    }
    // The generator reaches both outcomes and every refusal kind (the run isn't vacuous).
    expect(accepted).toBeGreaterThan(5_000);
    expect([...seenRefusals].sort()).toEqual(["conflict", "forbidden", "invalid_message", "not_found"]);
  });
});
