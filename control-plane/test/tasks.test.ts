// The task ledger end to end: TaskLedgerDO behind the real platform-tool path (a runner's tool_call
// to AgentDO, checked against the agent's expanded spec and its `ledger` param), the operator API,
// notices delivered from the ledger's alarm into inboxes, and the catalog's seed migration.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CatalogDO } from "../src/do/catalog";
import { ledgerStub, TaskLedgerDO } from "../src/do/tasks";
import { SEED_CATALOG, SEED_CATALOG_V1, SEED_VERSION } from "../src/lib/spec";
import { TASK_ADMIN_TOOLS, TASK_TOOLS } from "../src/lib/tasks";
import { adminJson, connectHost, nextCommands, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;
const uniqueLedger = (p = "lg") => `${p}-${crypto.randomUUID().slice(0, 8)}`;

async function cell() {
  const c = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-default" } });
  const sandboxHost = await connectHost(c);
  const brain = await connectHost(c, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "tasks" } }, 201);
  const sandbox = async () => {
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell: c } }, 201);
    await nextCommands(sandboxHost.ws, (x) => x.type === "sandbox_create");
    return sbx.sandbox as string;
  };
  return { cell: c, brain, workstream: workstream as string, sandbox };
}
type Cell = Awaited<ReturnType<typeof cell>>;

/** An agent from a seed template with ledger `ledger` (or none), and its runner connected. */
async function spawn(s: Cell, template: "worker" | "captain", ledger: string | null) {
  const where = template === "worker" ? { sandbox: await s.sandbox() } : { workstream: s.workstream, cell: s.cell };
  const a = await adminJson("/v1/agents", { body: { template, ...where, ...(ledger ? { overrides: { params: { ledger } } } : {}) } }, 201);
  await nextCommands(s.brain.ws, isStartOf(a.agent));
  const ws = await Ws.connect(`/v1/agents/${a.agent}/session`, s.brain.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent: a.agent, host: s.brain.host, instance_id: "rin_tasks", epoch: 1, session: SESSION });
  await ws.next("hello_ack");
  let seq = 0;
  /** Call platform tool `name` through the session channel; the outcome AgentDO answers. */
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = `cal_${name}-${++seq}`;
    ws.send({ type: "tool_call", seq, call: id, turn: "trn_x", name, arguments: args });
    return (await ws.next("tool_result", (m) => m.call === id)).outcome as { status: string; content?: any[]; error?: { code: string; message: string } };
  };
  const json = (o: { content?: any[] }) => o.content!.find((c) => c.type === "json").value;
  return { agent: a.agent as string, info: a, ws, call, json };
}

/** Wait until some inbox post to `agent` mentions `text`. */
async function inboxHas(agent: string, text: string, ms = 5_000): Promise<string[]> {
  const t0 = Date.now();
  for (;;) {
    // Every inbox post, whether it became a turn or went to the running turn.
    const texts = await runInDurableObject(agentStub(agent), (_i: unknown, st: DurableObjectState) =>
      st.storage.sql.exec<{ message: string }>("SELECT message FROM inbox ORDER BY rowid").toArray()
        .map((r) => { const m = JSON.parse(r.message) as { from: string; text: string }; return `Message from ${m.from}: ${m.text}`; }));
    if (texts.some((x) => x.includes(text)) || Date.now() - t0 > ms) return texts;
    await sleep(25);
  }
}

describe("the tasks capability through the tool path", { timeout: 20_000 }, () => {
  it("a worker with a ledger creates, lists, reads, updates its own and comments; it can't assign or update another's task", async () => {
    const s = await cell();
    const L = uniqueLedger();
    const w = await spawn(s, "worker", L);
    expect(w.info.params).toEqual({ ledger: L });
    expect((await w.ws.next("tools_list", () => true, 10).catch(() => null))).toBeNull();
    w.ws.send({ type: "tools_list_request", request: "req_t" });
    const names = (await w.ws.next("tools_list")).tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining([...TASK_TOOLS]));
    for (const t of TASK_ADMIN_TOOLS) expect(names).not.toContain(t);

    const created = await w.call("task_create", { title: "Fix login", description: "OAuth breaks", labels: ["auth"] });
    expect(created.status).toBe("ok");
    expect(w.json(created)).toMatchObject({ key: "T-1", status: "backlog", created_by: w.agent, version: 1 });
    await w.call("task_create", { title: "Write docs", status: "todo" });
    expect((await w.call("task_create", { title: "x", status: "in_progress" })).status).toBe("error");

    const list = w.json(await w.call("task_list", { label: "auth" }));
    expect(list.tasks.map((t: { key: string }) => t.key)).toEqual(["T-1"]);
    expect(w.json(await w.call("task_list", { status: "todo" })).tasks.map((t: { key: string }) => t.key)).toEqual(["T-2"]);
    expect(w.json(await w.call("task_list", { text: "OAUTH" })).tasks.length).toBe(1);
    const page = w.json(await w.call("task_list", { limit: 1 }));
    expect([page.tasks.length, page.next_cursor]).toEqual([1, 1]);
    expect(w.json(await w.call("task_list", { cursor: page.next_cursor })).tasks.map((t: { key: string }) => t.key)).toEqual(["T-2"]);

    const upd = await w.call("task_update", { task: "T-1", status: "in_progress", expected_version: 1 });
    expect(w.json(upd)).toMatchObject({ status: "in_progress", version: 2 });
    expect((await w.call("task_comment", { task: "T-1", body: "on it" })).status).toBe("ok");
    const detail = w.json(await w.call("task_get", { task: "T-1" }));
    expect(detail.comments.map((c: { body: string }) => c.body)).toEqual(["on it"]);
    expect(detail.history.map((h: { field: string }) => h.field)).toEqual(["created", "status"]);

    // Not granted: task_assign isn't in a worker's spec (AgentDO's per-call check).
    const assign = await w.call("task_assign", { task: "T-1", assignee: w.agent });
    expect(assign.error).toMatchObject({ code: "forbidden", message: "task_assign is not granted to this agent" });

    // Another agent's task: a second worker on the same ledger may read and comment, not update.
    const w2 = await spawn(s, "worker", L);
    const other = await w2.call("task_update", { task: "T-1", title: "mine now" });
    expect(other.error!.code).toBe("forbidden");
    expect(other.error!.message).toContain("neither assigned to nor created by");
    expect((await w2.call("task_comment", { task: "T-1", body: "+1" })).status).toBe("ok");
    // A stale version is a conflict.
    const stale = await w.call("task_update", { task: "T-1", title: "late", expected_version: 1 });
    expect(stale.error!.code).toBe("conflict");
    expect(w.json(await w.call("task_get", { task: "T-1" })).task).toMatchObject({ title: "Fix login", version: 2 });
  });

  it("a captain with tasks-admin assigns: the assignee hears in its inbox; done reaches the creator and the watcher", async () => {
    const s = await cell();
    const L = uniqueLedger();
    const c = await spawn(s, "captain", L);
    const w = await spawn(s, "worker", L);
    const created = c.json(await c.call("task_create", { title: "Ship it" }));
    expect((await c.call("task_set_watcher", { watcher: c.agent })).status).toBe("ok");
    const a = await c.call("task_assign", { task: created.key, assignee: w.agent, expected_version: 1 });
    expect(c.json(a)).toMatchObject({ assignee: w.agent, version: 2 });
    expect((await inboxHas(w.agent, "assigned T-1")).join("\n")).toContain(`Message from tasks:${L}: assigned T-1 (ledger ${L}, by ${c.agent}): Ship it`);

    // The assignee moves it along; reaching in_review tells the creator (the captain, also the watcher) once.
    expect((await w.call("task_update", { task: "T-1", status: "in_progress" })).status).toBe("ok");
    expect((await w.call("task_update", { task: "T-1", status: "in_review" })).status).toBe("ok");
    const texts = await inboxHas(c.agent, "T-1 is in_review");
    expect(texts.filter((t) => t.includes("T-1 is in_review")).length).toBe(1);
    // The worker may not finish what an admin canceled, nor cancel; the admin may.
    expect((await w.call("task_cancel", { task: "T-1" })).error!.code).toBe("forbidden");
    expect(c.json(await c.call("task_cancel", { task: "T-1", reason: "superseded" }))).toMatchObject({ status: "canceled" });
    expect((await inboxHas(w.agent, "T-1 is canceled")).some((t) => t.includes("T-1 is canceled"))).toBe(true);
    expect((await w.call("task_update", { task: "T-1", status: "done" })).error!.code).toBe("forbidden");
    // update_any: priority and any status.
    expect(c.json(await c.call("task_update_any", { task: "T-1", status: "todo", priority: "high" }))).toMatchObject({ status: "todo", priority: "high" });
  });

  it("assignment and watching need an agent whose spec grants the same ledger", async () => {
    const s = await cell();
    const L = uniqueLedger();
    const c = await spawn(s, "captain", L);
    const elsewhere = await spawn(s, "worker", uniqueLedger());
    const none = await spawn(s, "worker", null);
    await c.call("task_create", { title: "t" });
    for (const agent of [elsewhere.agent, none.agent]) {
      const r = await c.call("task_assign", { task: "T-1", assignee: agent });
      expect(r.error, agent).toMatchObject({ code: "forbidden" });
      expect(r.error!.message).toContain(`has no access to ledger ${L}`);
      expect((await c.call("task_set_watcher", { watcher: agent })).error!.code).toBe("forbidden");
    }
    expect((await c.call("task_assign", { task: "T-1", assignee: "agt_nobody00000000000000000000" })).error!.code).toBe("unknown_agent");
  });

  it("another ledger is refused: by argument, without a ledger param, and at the ledger itself", async () => {
    const s = await cell();
    const A = uniqueLedger("a");
    const B = uniqueLedger("b");
    const wa = await spawn(s, "worker", A);
    const wb = await spawn(s, "worker", B);
    await wb.call("task_create", { title: "B's secret" });
    for (const [name, args] of [
      ["task_list", {}], ["task_get", { task: "T-1" }], ["task_create", { title: "x" }], ["task_update", { task: "T-1", title: "x" }],
      ["task_comment", { task: "T-1", body: "x" }],
    ] as const) {
      const r = await wa.call(name, { ledger: B, ...args });
      expect(r.error, name).toMatchObject({ code: "forbidden", message: `this agent may use only ledger ${A}, not ${B}` });
    }
    expect((await wb.call("task_get", { task: "T-1" })).status).toBe("ok");
    expect(wb.json(await wb.call("task_get", { task: "T-1" })).comments).toEqual([]);
    // Its own ledger has no T-1; B's task id doesn't resolve in A either.
    const bTask = wb.json(await wb.call("task_list", {})).tasks[0];
    expect((await wa.call("task_get", { task: bTask.id })).error!.code).toBe("invalid_message");
    expect((await wa.call("task_list", { ledger: A })).status).toBe("ok");

    const none = await spawn(s, "captain", null);
    const r = await none.call("task_list", {});
    expect(r.error).toMatchObject({ code: "forbidden" });
    expect(r.error!.message).toContain("no task ledger");

    // The ledger checks the actor's ledger itself, whoever calls it.
    const actor = { kind: "agent" as const, agent: wa.agent, ledger: A, admin: true };
    await expect(Promise.resolve().then(() => ledgerStub(env, B).list(B, actor, {}))).rejects.toThrow(/ledger is .* not /);
    await expect(Promise.resolve().then(() => ledgerStub(env, B).apply(B, actor, { kind: "cancel", task: "T-1" }))).rejects.toThrow(/forbidden/);
  });
});

describe("TaskLedgerDO", () => {
  const op = { kind: "operator" } as const;

  it("applies a keyed write once (a tool call re-run after an eviction)", async () => {
    const L = uniqueLedger();
    const l = ledgerStub(env, L);
    const first = await l.apply(L, op, { kind: "create", title: "once" }, "agt_x/1/cal_1");
    const again = await l.apply(L, op, { kind: "create", title: "once" }, "agt_x/1/cal_1");
    expect(again).toEqual(first);
    expect((await l.list(L, op, {})).tasks.length).toBe(1);
  });

  it("a ledger is the one it was first written as", async () => {
    const L = uniqueLedger();
    await ledgerStub(env, L).apply(L, op, { kind: "create", title: "x" });
    const wrong = env.TASKS.get(env.TASKS.idFromName(`ledger/${L}`));
    await expect(Promise.resolve().then(() => wrong.list("other", op, {}))).rejects.toThrow(/this is ledger/);
  });

  it("prunes comments and history of tasks done or canceled 30 days ago, keeps the task", async () => {
    const L = uniqueLedger();
    const l = ledgerStub(env, L);
    await l.apply(L, op, { kind: "create", title: "old" });
    await l.apply(L, op, { kind: "create", title: "live" });
    await l.apply(L, op, { kind: "comment", task: "T-1", body: "c" });
    await l.apply(L, op, { kind: "comment", task: "T-2", body: "c" });
    await l.apply(L, op, { kind: "cancel", task: "T-1" });
    await runInDurableObject(l, async (i: TaskLedgerDO, st) => {
      const longAgo = Date.now() - 31 * 86_400_000;
      st.storage.sql.exec("UPDATE tasks SET updated_ms = ?", longAgo);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'last_prune'", String(longAgo));
      await i.alarm();
    });
    const old = await l.get(L, op, "T-1");
    expect([old.task.status, old.comments.length, old.history.length]).toEqual(["canceled", 0, 0]);
    const live = await l.get(L, op, "T-2");
    expect([live.comments.length, live.history.length]).toEqual([1, 1]);
  });

  it("keeps each task's latest 500 history rows, whatever other tasks write", async () => {
    const L = uniqueLedger();
    const l = ledgerStub(env, L);
    const a = (await l.apply(L, op, { kind: "create", title: "busy" })).task!;
    const b = (await l.apply(L, op, { kind: "create", title: "quiet" })).task!;
    await runInDurableObject(l, (_i: TaskLedgerDO, st) => {
      // Interleaved: 600 rows for the busy task, 300 more for the quiet one between them.
      for (let i = 0; i < 600; i++) {
        st.storage.sql.exec("INSERT INTO history (task, actor, field, from_v, to_v, ms) VALUES (?, 'operator', 'title', '\"x\"', '\"y\"', 0)", a.id);
        if (i % 2) st.storage.sql.exec("INSERT INTO history (task, actor, field, from_v, to_v, ms) VALUES (?, 'operator', 'title', '\"x\"', '\"y\"', 0)", b.id);
      }
    });
    await l.apply(L, op, { kind: "update_any", task: b.key, title: "quiet, renamed" });
    await l.apply(L, op, { kind: "update_any", task: a.key, title: "busy, renamed" });
    const counts = await runInDurableObject(l, (_i: TaskLedgerDO, st) =>
      st.storage.sql.exec<{ task: string; n: number }>("SELECT task, COUNT(*) AS n FROM history GROUP BY task").toArray());
    expect(Object.fromEntries(counts.map((c) => [c.task, c.n]))).toEqual({ [a.id]: 500, [b.id]: 302 });
    expect((await l.get(L, op, a.key)).history.at(-1)).toMatchObject({ field: "title", to: "busy, renamed" });
  });

  it("drops a notice to an agent that doesn't exist (it can never be delivered)", async () => {
    const L = uniqueLedger();
    const l = ledgerStub(env, L);
    await l.apply(L, op, { kind: "create", title: "t" });
    await runInDurableObject(l, async (i: TaskLedgerDO, st) => {
      st.storage.sql.exec("INSERT INTO outbox (agent, text, next_ms) VALUES ('agt_ghost0000000000000000000000', 'hello', 0)");
      await i.alarm();
      expect(st.storage.sql.exec("SELECT COUNT(*) AS n FROM outbox").one().n).toBe(0);
    });
  });
});

describe("the operator API", () => {
  it("creates, lists, reads, patches, assigns, comments and sets the watcher", async () => {
    const s = await cell();
    const L = uniqueLedger();
    const w = await spawn(s, "worker", L);
    const base = `/v1/ledgers/${L}`;
    const t = await adminJson(`${base}/tasks`, { body: { title: "From the operator", priority: "urgent", status: "todo", labels: ["ops"] } }, 201);
    expect(t).toMatchObject({ key: "T-1", priority: "urgent", status: "todo", created_by: "operator" });
    const sub = await adminJson(`${base}/tasks`, { body: { title: "Sub", parent: "T-1", assignee: w.agent, request_id: "r1" } }, 201);
    expect(sub).toMatchObject({ key: "T-2", parent_key: "T-1", assignee: w.agent });
    // A retry with the same request id is applied once.
    expect(await adminJson(`${base}/tasks`, { body: { title: "Sub", parent: "T-1", assignee: w.agent, request_id: "r1" } }, 201)).toEqual(sub);
    expect((await inboxHas(w.agent, "assigned T-2")).some((x) => x.includes("assigned T-2"))).toBe(true);

    expect((await adminJson(`${base}/tasks?parent=T-1`)).tasks.map((x: { key: string }) => x.key)).toEqual(["T-2"]);
    expect((await adminJson(`${base}/tasks?assignee=none`)).tasks.map((x: { key: string }) => x.key)).toEqual(["T-1"]);
    expect((await adminJson(`${base}/tasks?status=bogus`, {}, 400)).error.code).toBe("invalid_message");

    expect(await adminJson(`${base}/tasks/T-1`, { method: "PATCH", body: { status: "in_progress", expected_version: 1 } })).toMatchObject({ version: 2 });
    expect((await adminJson(`${base}/tasks/T-1`, { method: "PATCH", body: { title: "x", expected_version: 1 } }, 409)).error.code).toBe("conflict");
    expect((await adminJson(`${base}/tasks/T-1`, { method: "PATCH", body: { parent: "T-2" } }, 400)).error.message).toContain("cycle");
    expect((await adminJson(`${base}/tasks/T-1`, { method: "PATCH", body: { assignee: w.agent } }, 400)).error.code).toBe("invalid_message");

    expect(await adminJson(`${base}/tasks/T-1/assign`, { body: { assignee: w.agent } })).toMatchObject({ assignee: w.agent });
    expect(await adminJson(`${base}/tasks/T-1/comments`, { body: { body: "ping" } }, 201)).toMatchObject({ author: "operator", body: "ping" });
    expect(await adminJson(`${base}/watcher`, { method: "PUT", body: { watcher: w.agent } })).toMatchObject({ watcher: w.agent });
    expect(await adminJson(base)).toEqual({ ledger: L, watcher: w.agent, tasks: 2 });
    const d = await adminJson(`${base}/tasks/T-1`);
    expect(d.comments.map((c: { body: string }) => c.body)).toEqual(["ping"]);
    expect(d.history.map((h: { field: string }) => h.field)).toEqual(["created", "status", "assignee"]);

    expect((await adminJson(`${base}/tasks/T-9`, {}, 404)).error.code).toBe("invalid_message");
    expect((await adminJson("/v1/ledgers/bad%20name/tasks", {}, 400)).error.code).toBe("invalid_message");
    const otherAgent = await spawn(s, "worker", uniqueLedger());
    expect((await adminJson(`${base}/tasks/T-1/assign`, { body: { assignee: otherAgent.agent } }, 403)).error.code).toBe("forbidden");
  });
});

describe("the catalog's seed migration", () => {
  const catalogStub = () => env.CATALOG.get(env.CATALOG.idFromName(uniqueLedger("catalog")));
  /** Make a fresh catalog look like one seeded by the first release (seed version 1, no seed_version). */
  const asV1 = (st: DurableObjectState) => {
    st.storage.sql.exec("DELETE FROM capabilities");
    st.storage.sql.exec("DELETE FROM templates");
    st.storage.sql.exec("DELETE FROM kv WHERE key = 'seed_version'");
    for (const [n, c] of Object.entries(SEED_CATALOG_V1.capabilities)) {
      const { params: _p, ...v1 } = c; // the first release stored no params field
      st.storage.sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?)", n, JSON.stringify(v1));
    }
    for (const [n, t] of Object.entries(SEED_CATALOG_V1.templates)) {
      const { params: _p, ...v1 } = t;
      st.storage.sql.exec("INSERT INTO templates (name, body) VALUES (?, ?)", n, JSON.stringify(v1));
    }
  };
  const restart = (st: DurableObjectState) => new CatalogDO(st, env as never);

  it("a new catalog is seeded at the current version", async () => {
    const cat = await catalogStub().catalog();
    expect(Object.keys(cat.capabilities).sort()).toEqual(Object.keys(SEED_CATALOG.capabilities).sort());
    expect(cat.templates.captain!.capabilities).toEqual(SEED_CATALOG.templates.captain!.capabilities);
  });

  it("adds the new capabilities once, leaves the templates alone, and never brings back what the operator deleted", async () => {
    const stub = catalogStub();
    await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      asV1(st);
      // The operator had removed `memory` and the `captain` template under the first release.
      st.storage.sql.exec("DELETE FROM capabilities WHERE name = 'memory'");
      st.storage.sql.exec("DELETE FROM templates WHERE name = 'captain'");
      const after = await restart(st).catalog();
      expect(Object.keys(after.capabilities).sort()).toEqual([...Object.keys(SEED_CATALOG_V1.capabilities).filter((n) => n !== "memory"), "tasks", "tasks-admin"].sort());
      expect(after.capabilities.tasks).toEqual(SEED_CATALOG.capabilities.tasks);
      expect(Object.keys(after.templates)).toEqual(["worker"]);
      expect(after.templates.worker!.capabilities).toEqual(SEED_CATALOG_V1.templates.worker!.capabilities);
      expect(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'seed_version'").one().value).toBe(String(SEED_VERSION));
      // Deleted after the migration: stays deleted across restarts.
      st.storage.sql.exec("DELETE FROM capabilities WHERE name = 'tasks-admin'");
      expect(Object.keys((await restart(st).catalog()).capabilities)).not.toContain("tasks-admin");
    });
  });

  it("keeps an operator's own capability of the same name", async () => {
    const stub = catalogStub();
    await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      asV1(st);
      st.storage.sql.exec("INSERT INTO capabilities (name, body) VALUES ('tasks', ?)", JSON.stringify({ tools: ["notify"], rules: [], prompt: "mine" }));
      const after = await restart(st).catalog();
      expect(after.capabilities.tasks).toMatchObject({ tools: ["notify"], prompt: "mine" });
      expect(after.capabilities["tasks-admin"]).toEqual(SEED_CATALOG.capabilities["tasks-admin"]);
    });
  });

  it("after the migration the operator's step gives an existing template the ledger", async () => {
    const tpl = (await adminJson("/v1/admin/catalog")).templates.worker;
    const name = uniqueLedger("w");
    await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: { ...tpl, capabilities: [...tpl.capabilities.filter((c: string) => c !== "tasks"), "tasks"] } });
    const s = await cell();
    const a = await adminJson("/v1/agents", { body: { template: name, sandbox: await s.sandbox(), start: false, overrides: { params: { ledger: "x-1" } } } }, 201);
    expect(a.params).toEqual({ ledger: "x-1" });
    expect(a.tools).toEqual(expect.arrayContaining([...TASK_TOOLS]));
    // A ledger for a template none of whose capabilities takes one is refused.
    expect((await adminJson("/v1/agents", { body: { template: name, sandbox: await s.sandbox(), overrides: { params: { nope: 1 } } } }, 400)).error.code)
      .toBe("invalid_message");
  });
});
