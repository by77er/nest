// The task ledger's pure core (lib/tasks.ts), checked directly: unit tests of each rule, then seeded
// random operation sequences (a small PRNG, not fast-check: it isn't a dependency) against the
// invariants: status moves only by allowed transitions, versions strictly increase, history records
// every change, an agent's `tasks` operation never changes another's task, its assignment (beyond
// claiming an unassigned one) or its priority, parents never form a cycle, and a refusal changes
// nothing. The oracles are written out here, independently of the tables in the code.
import { describe, expect, it } from "vitest";
import {
  type Actor, ADMIN_OPS, type Applied, applyTaskOp, type ApplyResult, type HistoryEntry, inboxChannel, inboxOwner, LIMITS, type LedgerView, matches,
  type Notice, type SpecGrant, type Task, TASK_ADMIN_TOOLS, TASK_FIELDS, TASK_PRIORITIES, TASK_STATUSES, TASK_TOOLS, type TaskOp, type TaskStatus,
  taskKey, TOOL_OPS,
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
  get openCount() {
    return [...this.tasks.values()].filter((t) => t.status !== "done" && t.status !== "canceled").length;
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

const agent = (id: string, ledger = L): Actor => ({ kind: "agent", agent: id, ledger });
const operator: Actor = { kind: "operator" };
const grant = (id: string, ledger: string | null = L, tools: readonly string[] = TASK_TOOLS): SpecGrant => ({ agent: id, ledger, tools });
const W1 = "agt_w1";
const W2 = "agt_w2";
const CAP = "agt_cap";
const to = (n: Notice) => inboxOwner(n.channel);

function ok(r: ApplyResult): Applied {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const code = (r: ApplyResult) => (r.ok ? "ok" : r.error.code);

function create(m: Mem, actor: Actor = agent(W1), extra: Partial<Extract<TaskOp, { kind: "create" }>> = {}): Task {
  return ok(m.run(actor, { kind: "create", title: "Fix the build", ...extra })).task!;
}

/**
 * What an agent's `update` may do to a status, written out (not read from WORKER_TRANSITIONS):
 * forward along the board, back one step, never out of done or canceled, never into canceled.
 */
const EXPECTED_WORKER_MOVES: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["todo", "in_progress"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review", "done"],
  in_review: ["in_progress", "done"],
  done: [],
  canceled: [],
};

describe("privilege is the tool", () => {
  it("each tasks tool asks for a non-admin operation, each tasks-admin tool for an admin one", () => {
    expect(TOOL_OPS).toEqual({
      task_list: "read", task_get: "read", task_create: "create", task_update: "update", task_claim: "claim", task_comment: "comment",
      task_assign: "assign", task_update_any: "update_any", task_cancel: "cancel", task_set_watcher: "set_watcher",
    });
    for (const t of TASK_TOOLS) expect(ADMIN_OPS, t).not.toContain(TOOL_OPS[t]);
    for (const t of TASK_ADMIN_TOOLS) expect(ADMIN_OPS, t).toContain(TOOL_OPS[t]);
  });
});

describe("create", () => {
  it("numbers tasks T-1, T-2, …; starts at version 1 in backlog, unassigned, with a `created` history entry", () => {
    const m = new Mem();
    const t = create(m);
    expect(t).toMatchObject({ number: 1, status: "backlog", priority: "none", assignee: null, created_by: W1, version: 1, parent: null });
    expect(taskKey(t)).toBe("T-1");
    expect(create(m).number).toBe(2);
    expect(m.history[0]).toMatchObject({ task: t.id, actor: W1, field: "created", from: null, to: "T-1" });
  });

  it("an agent creates in backlog or todo only, unassigned and without priority; the operator may set them", () => {
    const m = new Mem();
    const allowed: TaskStatus[] = ["backlog", "todo"];
    for (const s of TASK_STATUSES) expect(code(m.run(agent(W1), { kind: "create", title: "x", status: s })), s).toBe(allowed.includes(s) ? "ok" : "forbidden");
    expect(code(m.run(agent(W1), { kind: "create", title: "x", priority: "high" }))).toBe("forbidden");
    expect(code(m.run(agent(W1), { kind: "create", title: "x", assignee: grant(W1) }))).toBe("forbidden");
    expect(code(m.run(operator, { kind: "create", title: "x", status: "in_progress", priority: "urgent", assignee: grant(W2) }))).toBe("ok");
    expect(m.notices).toEqual([{
      channel: "agt_w2/inbox",
      post: { kind: "task_assigned", text: expect.stringMatching(/^assigned T-\d+ \(ledger proj-a, by operator\); task_get reads it$/), data: { ledger: L, key: "T-3", status: "in_progress", assignee: W2 } },
    }]);
  });

  it("validates bounds: title, description, labels", () => {
    const m = new Mem();
    const c = (op: Partial<Extract<TaskOp, { kind: "create" }>>) => code(m.run(agent(W1), { kind: "create", title: "x", ...op }));
    expect(c({ title: "  " })).toBe("invalid_message");
    expect(c({ title: "x".repeat(LIMITS.title + 1) })).toBe("invalid_message");
    expect(c({ title: "x".repeat(LIMITS.title) })).toBe("ok");
    expect(c({ description: "d".repeat(LIMITS.description + 1) })).toBe("invalid_message");
    expect(c({ labels: Array.from({ length: LIMITS.labels + 1 }, (_, i) => `l${i}`) })).toBe("invalid_message");
    expect(c({ labels: ["ok", "ok"] })).toBe("invalid_message");
    expect(c({ labels: ["has space"] })).toBe("invalid_message");
    expect(c({ labels: ["area:ui", "p/1"] })).toBe("ok");
  });

  it("the size limit counts open tasks only: closing one makes room, reopening needs it", () => {
    const m = new Mem();
    const full = (n: number) => Object.defineProperty(m, "openCount", { get: () => n, configurable: true });
    create(m, operator, { status: "done" });
    full(LIMITS.openTasks);
    expect(code(m.run(agent(W1), { kind: "create", title: "x" }))).toBe("invalid_message");
    // A closed create, a comment, a cancel still go through at the limit; a reopen doesn't.
    expect(code(m.run(operator, { kind: "create", title: "x", status: "canceled" }))).toBe("ok");
    expect(code(m.run(operator, { kind: "update_any", task: "T-1", status: "todo" }))).toBe("invalid_message");
    full(LIMITS.openTasks - 1);
    expect(code(m.run(agent(W1), { kind: "create", title: "x" }))).toBe("ok");
  });

  it("a parent must exist in the ledger", () => {
    const m = new Mem();
    const p = create(m);
    expect(create(m, agent(W1), { parent: "T-1" }).parent).toBe(p.id);
    expect(create(m, agent(W1), { parent: p.id }).parent).toBe(p.id);
    expect(code(m.run(agent(W1), { kind: "create", title: "x", parent: "T-99" }))).toBe("not_found");
  });
});

describe("update (the tasks capability)", () => {
  it("the creator and the assignee may update; anyone else is refused", () => {
    const m = new Mem();
    const t = create(m, agent(W1));
    ok(m.run(operator, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    expect(code(m.run(agent(W1), { kind: "update", task: "T-1", title: "by creator" }))).toBe("ok");
    expect(code(m.run(agent(W2), { kind: "update", task: t.id, title: "by assignee" }))).toBe("ok");
    expect(code(m.run(agent("agt_other"), { kind: "update", task: "T-1", title: "nope" }))).toBe("forbidden");
    expect(m.get("T-1")!.title).toBe("by assignee");
  });

  it("status moves only as EXPECTED_WORKER_MOVES says; done and canceled are final", () => {
    for (const from of TASK_STATUSES) {
      for (const dest of TASK_STATUSES) {
        if (from === dest) continue;
        const m = new Mem();
        create(m, operator, { status: from, assignee: grant(W1) });
        const r = m.run(agent(W1), { kind: "update", task: "T-1", status: dest });
        expect(code(r), `${from} -> ${dest}`).toBe(EXPECTED_WORKER_MOVES[from].includes(dest) ? "ok" : "forbidden");
      }
    }
    for (const final of ["done", "canceled"] as const) {
      for (const dest of TASK_STATUSES.filter((s) => s !== final)) {
        const m = new Mem();
        create(m, agent(W1), { status: "todo" });
        ok(m.run(operator, { kind: "update_any", task: "T-1", status: final }));
        expect(code(m.run(agent(W1), { kind: "update", task: "T-1", status: dest })), `${final} -> ${dest}`).toBe("forbidden");
      }
    }
  });

  it("can't change priority, parent or assignment, whatever the op object carries", () => {
    const m = new Mem();
    create(m);
    create(m);
    for (const extra of [{ priority: "high" }, { parent: "T-2" }, { assignee: W1 }]) {
      expect(code(m.run(agent(W1), { kind: "update", task: "T-1", ...extra } as TaskOp)), JSON.stringify(extra)).toBe("forbidden");
    }
    expect(m.get("T-1")).toMatchObject({ priority: "none", parent: null, assignee: null, version: 1 });
  });

  it("an unchanged update is a no-op: same version, no history", () => {
    const m = new Mem();
    const t = create(m);
    const before = m.history.length;
    const a = ok(m.run(agent(W1), { kind: "update", task: "T-1", title: t.title, labels: [] }));
    expect(a.put).toBeUndefined();
    expect(a.task!.version).toBe(1);
    expect(m.history.length).toBe(before);
  });

  it("expected_version: a stale one is a conflict and changes nothing", () => {
    const m = new Mem();
    create(m);
    ok(m.run(agent(W1), { kind: "update", task: "T-1", title: "v2", expected_version: 1 }));
    const r = m.run(agent(W1), { kind: "update", task: "T-1", title: "lost", expected_version: 1 });
    expect(r).toEqual({ ok: false, error: { code: "conflict", message: "T-1 is at version 2, not 1: read it again and retry" } });
    expect(m.get("T-1")).toMatchObject({ title: "v2", version: 2 });
  });

  it("a stored status or priority outside its enum is refused cleanly, and update_any repairs it", () => {
    const m = new Mem();
    const t = create(m);
    m.tasks.set(t.id, { ...t, status: "weird" as TaskStatus });
    const r = m.run(agent(W1), { kind: "update", task: "T-1", status: "todo" });
    expect(r.ok ? null : r.error).toMatchObject({ code: "invalid_message", message: expect.stringContaining("outside its enum") });
    expect(code(m.run(agent(W1), { kind: "claim", task: "T-1" }))).toBe("invalid_message");
    expect(code(m.run(agent(W1), { kind: "update", task: "T-1", title: "renamed" }))).toBe("ok");
    expect(code(m.run(operator, { kind: "update_any", task: "T-1", status: "todo" }))).toBe("ok");
    m.tasks.set(t.id, { ...m.get("T-1")!, priority: "huge" as never });
    expect(code(m.run(agent(W1), { kind: "update", task: "T-1", status: "in_progress" }))).toBe("invalid_message");
  });
});

describe("claim (the tasks capability)", () => {
  it("takes an unassigned open task; backlog and todo move to in_progress; a held task is a conflict", () => {
    const m = new Mem();
    create(m, CAP_ACTOR, { status: "todo" });
    const a = ok(m.run(agent(W1), { kind: "claim", task: "T-1", expected_version: 1 }));
    expect(a.task).toMatchObject({ assignee: W1, status: "in_progress", version: 2 });
    expect(a.history.map((h) => h.field).sort()).toEqual(["assignee", "status"]);
    expect(a.notices).toEqual([]); // to itself: nobody else held it
    const lost = m.run(agent(W2), { kind: "claim", task: "T-1" });
    expect(lost.ok ? null : lost.error).toEqual({ code: "conflict", message: `T-1 is assigned to ${W1}` });
    expect(code(m.run(agent(W1), { kind: "claim", task: "T-1" }))).toBe("conflict");
  });

  it("is compare-and-set with expected_version; keeps in_review; refuses closed tasks and the operator", () => {
    const m = new Mem();
    create(m);
    ok(m.run(agent(W1), { kind: "update", task: "T-1", title: "edited" }));
    expect(code(m.run(agent(W2), { kind: "claim", task: "T-1", expected_version: 1 }))).toBe("conflict");
    create(m, operator, { status: "in_review" });
    expect(ok(m.run(agent(W2), { kind: "claim", task: "T-2" })).task).toMatchObject({ assignee: W2, status: "in_review" });
    for (const s of ["done", "canceled"] as const) {
      create(m, operator, { status: s });
      expect(code(m.run(agent(W2), { kind: "claim", task: `T-${m.next - 1}` })), s).toBe("invalid_message");
    }
    create(m);
    expect(code(m.run(operator, { kind: "claim", task: `T-${m.next - 1}` }))).toBe("invalid_message");
  });
});
const CAP_ACTOR = agent(CAP);

describe("the tasks-admin operations", () => {
  it("assign: the assignee's spec must grant this ledger; the assignee (and a previous one) is told, never the actor", () => {
    const m = new Mem();
    create(m);
    expect(code(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W1, "other") }))).toBe("forbidden");
    expect(code(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W1, null) }))).toBe("forbidden");
    expect(code(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W1, L, ["notify"]) }))).toBe("forbidden");
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W1) }));
    expect(m.notices.map((n) => [to(n), n.post.kind, n.post.text])).toEqual([[W1, "task_assigned", "assigned T-1 (ledger proj-a, by agt_cap); task_get reads it"]]);
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    expect(m.notices.slice(1).map(to)).toEqual([W2, W1]);
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(CAP, L, ["task_assign"]) }));
    expect(m.notices.slice(3).map(to)).toEqual([W2]);
    expect(m.history.filter((h) => h.field === "assignee").map((h) => [h.from, h.to])).toEqual([[null, W1], [W1, W2], [W2, CAP]]);
  });

  it("update_any: any status, priority and parent; a parent can't form a cycle", () => {
    const m = new Mem();
    create(m); // T-1
    create(m, agent(W1), { parent: "T-1" }); // T-2
    create(m, agent(W1), { parent: "T-2" }); // T-3
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-1", parent: "T-3" }))).toBe("invalid_message");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-1", parent: "T-1" }))).toBe("invalid_message");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-3", parent: "T-1" }))).toBe("ok");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-2", parent: null }))).toBe("ok");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-1", parent: "T-2" }))).toBe("ok");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-1", status: "done", priority: "urgent" }))).toBe("ok");
    expect(code(m.run(CAP_ACTOR, { kind: "update_any", task: "T-1", status: "backlog" }))).toBe("ok");
    expect(m.get("T-1")).toMatchObject({ status: "backlog", priority: "urgent" });
  });

  it("cancel: once; the reason becomes a comment, or the cancel is refused at the comment limit; creator, assignee and watcher are told", () => {
    const m = new Mem();
    create(m, agent(W1));
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    ok(m.run(CAP_ACTOR, { kind: "set_watcher", watcher: grant("agt_watch") }));
    m.notices = [];
    m.comments.set(m.get("T-1")!.id, LIMITS.comments);
    expect(code(m.run(CAP_ACTOR, { kind: "cancel", task: "T-1", reason: "dup of T-9" }))).toBe("invalid_message");
    expect(m.get("T-1")!.status).toBe("backlog");
    m.comments.set(m.get("T-1")!.id, 0);
    const a = ok(m.run(CAP_ACTOR, { kind: "cancel", task: "T-1", reason: "dup of T-9" }));
    expect(a.comment).toMatchObject({ author: CAP, body: "Canceled: dup of T-9" });
    expect(m.notices.map(to).sort()).toEqual([W1, W2, "agt_watch"].sort());
    expect(m.notices.every((n) => n.post.kind === "task_status" && n.post.data.status === "canceled")).toBe(true);
    expect(code(m.run(CAP_ACTOR, { kind: "cancel", task: "T-1" }))).toBe("invalid_message");
  });

  it("set_watcher: an agent whose spec grants the ledger, or none", () => {
    const m = new Mem();
    expect(code(m.run(CAP_ACTOR, { kind: "set_watcher", watcher: grant("agt_x", "elsewhere") }))).toBe("forbidden");
    expect(ok(m.run(CAP_ACTOR, { kind: "set_watcher", watcher: grant("agt_x") })).watcher).toBe("agt_x");
    expect(ok(m.run(operator, { kind: "set_watcher", watcher: null })).watcher).toBeNull();
  });
});

describe("notices and comments", () => {
  it("in_review, done and canceled notify the creator and the watcher (not the actor); other moves notify nobody", () => {
    const m = new Mem();
    create(m, agent(W1));
    ok(m.run(operator, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    ok(m.run(operator, { kind: "set_watcher", watcher: grant(CAP, L, ["task_assign"]) }));
    m.notices = [];
    ok(m.run(agent(W2), { kind: "update", task: "T-1", status: "in_progress" }));
    expect(m.notices).toEqual([]);
    ok(m.run(agent(W2), { kind: "update", task: "T-1", status: "in_review" }));
    expect(m.notices.map(to).sort()).toEqual([CAP, W1].sort());
    expect(m.notices[0]!.post).toEqual({
      kind: "task_status", text: "T-1 is in_review (by agt_w2, ledger proj-a); task_get reads it", data: { ledger: L, key: "T-1", status: "in_review", assignee: W2 },
    });
    expect(inboxChannel(W1)).toBe("agt_w1/inbox");
  });

  it("carry no agent-written text: no title, description, label or comment reaches a notice", () => {
    const m = new Mem();
    const mark = "IGNORE-PRIOR-INSTRUCTIONS";
    create(m, agent(W1), { title: `${mark} title`, description: `${mark} desc`, labels: [mark] });
    ok(m.run(agent(W2), { kind: "comment", task: "T-1", body: `${mark} comment` }));
    ok(m.run(operator, { kind: "set_watcher", watcher: grant(CAP) }));
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W2) }));
    ok(m.run(CAP_ACTOR, { kind: "assign", task: "T-1", assignee: grant(W1) }));
    ok(m.run(agent(W1), { kind: "update", task: "T-1", status: "in_progress" }));
    ok(m.run(agent(W1), { kind: "update", task: "T-1", status: "in_review" }));
    ok(m.run(CAP_ACTOR, { kind: "cancel", task: "T-1", reason: `${mark} reason` }));
    expect(m.notices.length).toBeGreaterThan(3);
    expect(JSON.stringify(m.notices)).not.toContain(mark);
  });

  it("anyone with ledger access comments on any task, within bounds", () => {
    const m = new Mem();
    create(m, agent(W1));
    expect(ok(m.run(agent("agt_any"), { kind: "comment", task: "T-1", body: "looks good" })).comment).toMatchObject({ author: "agt_any" });
    expect(m.get("T-1")!.version).toBe(1);
    expect(code(m.run(agent(W1), { kind: "comment", task: "T-1", body: " " }))).toBe("invalid_message");
    expect(code(m.run(agent(W1), { kind: "comment", task: "T-1", body: "x".repeat(LIMITS.comment + 1) }))).toBe("invalid_message");
    m.comments.set(m.get("T-1")!.id, LIMITS.comments);
    expect(code(m.run(agent(W1), { kind: "comment", task: "T-1", body: "one more" }))).toBe("invalid_message");
  });
});

describe("ledger access", () => {
  it("an agent whose ledger is another is refused every operation", () => {
    const m = new Mem();
    create(m);
    for (const op of [
      { kind: "create", title: "x" }, { kind: "update", task: "T-1", title: "y" }, { kind: "comment", task: "T-1", body: "z" },
      { kind: "claim", task: "T-1" }, { kind: "assign", task: "T-1", assignee: null }, { kind: "update_any", task: "T-1", title: "y" },
      { kind: "cancel", task: "T-1" }, { kind: "set_watcher", watcher: null },
    ] as TaskOp[]) expect(code(m.run(agent(W1, "proj-b"), op)), op.kind).toBe("forbidden");
  });
});

describe("filters", () => {
  it("match status, assignee (or null: unassigned), label, text (case-insensitive) and parent", () => {
    const t: Task = {
      id: "tsk_1", number: 1, title: "Fix Login", description: "the OAuth flow", status: "todo", priority: "none", assignee: W1,
      labels: ["auth"], parent: "tsk_0", created_by: W1, created_ms: 0, updated_ms: 0, version: 1,
    };
    expect(matches(t, {})).toBe(true);
    expect(matches(t, { status: "todo", assignee: W1, label: "auth", text: "oauth", parent: "T-0" }, "tsk_0")).toBe(true);
    expect(matches(t, { status: "done" })).toBe(false);
    expect(matches(t, { assignee: null })).toBe(false);
    expect(matches({ ...t, assignee: null }, { assignee: null })).toBe(true);
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
/** Who may ask for what: agents with only `tasks` ask for its kinds; an admin agent and the operator for any. */
const ACTORS: { actor: Actor; admin: boolean }[] = [
  ...AGENTS.map((a) => ({ actor: agent(a), admin: false })), { actor: agent("agt_boss"), admin: true }, { actor: operator, admin: true },
  { actor: agent("agt_out", "proj-b"), admin: false }, { actor: agent("agt_outboss", "proj-b"), admin: true },
];

function genOp(r: () => number, m: Mem, admin: boolean): TaskOp {
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
  const kinds = admin
    ? (["create", "create", "update", "claim", "update_any", "assign", "cancel", "comment", "set_watcher"] as const)
    : (["create", "create", "update", "update", "claim", "comment"] as const);
  switch (pick(kinds)) {
    case "create":
      return { kind: "create", title: pick(["t1", "t2", ""]), status: maybe(0.4, () => pick(TASK_STATUSES)), priority: maybe(0.2, () => pick(TASK_PRIORITIES)),
        parent: maybe(0.3, ref), ...(r() < 0.2 ? { assignee: grantee() } : {}), labels: maybe(0.2, () => ["x"]) };
    case "update": {
      const task = ref();
      const op: TaskOp = { kind: "update", task, expected_version: version(task), ...edits() };
      // Now and then an op object carrying more than `update` takes (as a hostile caller might build).
      if (r() < 0.1) Object.assign(op, pick([{ priority: "urgent" }, { assignee: pick(AGENTS) }, { parent: null }]));
      return op;
    }
    case "claim": {
      const task = ref();
      return { kind: "claim", task, expected_version: version(task) };
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
    const seenKinds = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const m = new Mem();
      const created = new Map<string, Task>();
      for (let step = 0; step < 80; step++) {
        const { actor, admin } = ACTORS[Math.floor(r() * ACTORS.length)]!;
        const op = genOp(r, m, admin);
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
        seenKinds.add(op.kind);
        const a = res.value;
        const who = actor.kind === "operator" ? "operator" : actor.agent;
        const tasksOp = actor.kind === "agent" && !ADMIN_OPS.includes(op.kind);
        // Notices go to inboxes, never to the actor itself.
        expect(a.notices.every((n) => to(n) !== null && to(n) !== who), ctx).toBe(true);
        if (a.put) {
          const prev = before.find(([id]) => id === a.put!.id)?.[1];
          if (!prev) {
            expect(op.kind, ctx).toBe("create");
            expect(a.put.version, ctx).toBe(1);
            expect(a.put.number, ctx).toBe(beforeNext);
            created.set(a.put.id, structuredClone(a.put));
            if (tasksOp) expect([a.put.assignee, a.put.priority, ["backlog", "todo"].includes(a.put.status)], ctx).toEqual([null, "none", true]);
          } else {
            // Versions strictly increase; history names every changed field, from its old value to its new.
            expect(a.put.version, ctx).toBe(prev.version + 1);
            const changed = TASK_FIELDS.filter((f) => JSON.stringify(prev[f]) !== JSON.stringify(a.put![f]));
            expect(a.history.map((h) => h.field).sort(), ctx).toEqual([...changed].sort());
            for (const h of a.history) {
              expect([h.task, h.actor, h.from, h.to], ctx).toEqual([prev.id, who, prev[h.field as keyof Task], a.put[h.field as keyof Task]]);
            }
            expect([a.put.id, a.put.number, a.put.created_by, a.put.created_ms], ctx).toEqual([prev.id, prev.number, prev.created_by, prev.created_ms]);
            if (tasksOp) {
              // An agent's `tasks` operation: priority and parent never; assignment only claiming an unassigned task for itself;
              // status only along the written-out table (or a claim's start); another's task only by claiming it.
              expect([a.put.priority, a.put.parent], ctx).toEqual([prev.priority, prev.parent]);
              if (a.put.assignee !== prev.assignee) expect([op.kind, prev.assignee, a.put.assignee], ctx).toEqual(["claim", null, who]);
              if (op.kind === "update") {
                expect(prev.assignee === who || prev.created_by === who, ctx).toBe(true);
                if (a.put.status !== prev.status) expect(EXPECTED_WORKER_MOVES[prev.status], ctx).toContain(a.put.status);
              }
              if (op.kind === "claim" && a.put.status !== prev.status) expect([prev.status === "backlog" || prev.status === "todo", a.put.status], ctx).toEqual([true, "in_progress"]);
            }
            if (a.put.status !== prev.status) expect(["update", "update_any", "cancel", "claim"], ctx).toContain(op.kind);
            if (a.put.assignee !== prev.assignee) expect(["assign", "claim"], ctx).toContain(op.kind);
          }
        } else {
          expect(a.history, ctx).toEqual([]);
        }
        if (a.watcher !== undefined) expect(op.kind, ctx).toBe("set_watcher");
        if (op.kind === "assign" && a.put?.assignee) expect(a.notices.some((n) => to(n) === a.put!.assignee) || a.put.assignee === who, ctx).toBe(true);
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
        for (const f of TASK_FIELDS) expect(replay[f], `seed ${seed} ${id} ${f}`).toEqual(now[f]);
      }
      // Keys are unique and dense.
      expect([...m.tasks.values()].map((t) => t.number).sort((x, y) => x - y)).toEqual(Array.from({ length: m.tasks.size }, (_, i) => i + 1));
    }
    // The generator reaches both outcomes, every op kind and every refusal kind (the run isn't vacuous).
    expect(accepted).toBeGreaterThan(5_000);
    expect([...seenKinds].sort()).toEqual(["assign", "cancel", "claim", "comment", "create", "set_watcher", "update", "update_any"]);
    expect([...seenRefusals].sort()).toEqual(["conflict", "forbidden", "invalid_message", "not_found"]);
  });
});
