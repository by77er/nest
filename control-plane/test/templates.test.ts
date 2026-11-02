// Templates and capabilities as data (CatalogDO, the admin routes) and agents spawned from them: what
// an agent is offered, may call, is started with and escalates to comes from its expanded spec, and
// nothing decides on a role or a template's name.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { CatalogDO } from "../src/do/catalog";
import { CHANNEL_ALARM_MS, type ChannelDO } from "../src/do/channel";
import { LEDGER_ALARM_MS, type TaskLedgerDO } from "../src/do/tasks";
import { SEED_CATALOG, SEED_VERSION, SPAWNING_PROMPT_V5 } from "../src/lib/spec";
import { adminJson, connectHost, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const wsStub = (id: string) => env.WORKSTREAM.get(env.WORKSTREAM.idFromName(id));
const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;
const uniqueName = (p: string) => `${p}-${crypto.randomUUID().slice(0, 8)}`;

async function runner(agent: string, host: string, token: string, epoch = 1) {
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, token);
  ws.send({ type: "hello", protocol_version: 1, agent, host, instance_id: "rin_tpl", epoch, session: SESSION });
  await ws.next("hello_ack");
  return ws;
}

async function toolNames(ws: Ws): Promise<{ name: string; roles?: unknown }[]> {
  ws.send({ type: "tools_list_request", request: "req_tpl" });
  return (await ws.next("tools_list")).tools;
}

async function cellWithSandbox() {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-default" } });
  const sandboxHost = await connectHost(cell);
  // Every brain, with hands or without, runs on a brain host.
  const brain = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "templates" } }, 201);
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(sandboxHost.ws, (c) => c.type === "sandbox_create");
  return { cell, brain, workstream: workstream as string, sandbox: sbx.sandbox as string };
}

/** Edit AgentInfo in place (a record as an earlier release, or a bad edit, left it). */
async function editAgent(agent: string, fn: (info: Record<string, any>) => void) {
  await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
    fn(info);
    st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
  });
}

describe("the catalog is data the operator edits", () => {
  it("is seeded with worker and captain, and refuses entries that don't hold together", async () => {
    const cat = await adminJson("/v1/admin/catalog");
    expect(Object.keys(cat.templates)).toEqual(expect.arrayContaining(["worker", "captain"]));
    expect(cat.templates.captain).toMatchObject({ hands: "forbidden", credential: "claude_oauth_token:captain", escalate_to: "user" });

    const name = uniqueName("cap");
    expect((await adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { tools: ["no_such_tool"] } }, 400)).error.message)
      .toContain("unknown platform tool no_such_tool");
    await adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { tools: ["notify"] } });
    const tpl = { capabilities: [name], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "optional", escalate_to: "user" };
    // A credential is a Claude setup token's name and nothing else (it is sent to a brain host).
    expect((await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: { ...tpl, credential: "binding_key:use1" } }, 400)).error.code)
      .toBe("invalid_message");
    expect((await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: { ...tpl, capabilities: ["nope"], credential: "claude_oauth_token" } }, 400))
      .error.message).toContain("unknown capability nope");
    await adminJson(`/v1/admin/templates/${name}`, { method: "PUT", body: { ...tpl, credential: "claude_oauth_token" } });
    expect((await adminJson(`/v1/admin/capabilities/${name}`, { method: "DELETE" }, 409)).error.message).toContain(`listed by ${name}`);
    await adminJson(`/v1/admin/templates/${name}`, { method: "DELETE" });
    await adminJson(`/v1/admin/capabilities/${name}`, { method: "DELETE" });
    expect((await adminJson("/v1/admin/capabilities/Bad_Name", { method: "PUT", body: { tools: [] } }, 400)).error.code).toBe("invalid_message");
  });
});

describe("an agent is its expanded spec", () => {
  it("offers and allows exactly its capabilities' tools, with their prompts, rules and its template's credential", async () => {
    const s = await cellWithSandbox();
    const name = uniqueName("rv");
    await adminJson(`/v1/admin/capabilities/${name}`, {
      method: "PUT", body: { tools: ["read_transcript", "notify"], rules: [{ pattern: "Bash", decision: "ask" }], prompt: "Review carefully." },
    });
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT",
      body: {
        capabilities: ["nest", name], launch: { builtin_tools: ["TodoWrite"], system_prompt: { mode: "append", text: "You review." } },
        hands: "optional", credential: `claude_oauth_token:${name}`, escalate_to: "user",
      },
    });
    await adminJson(`/v1/admin/secrets/claude_oauth_token:${name}`, { method: "PUT", body: { value: "sk-reviewer" } });
    const a = await adminJson("/v1/agents", { body: { template: name, sandbox: s.sandbox } }, 201);
    expect(a).toMatchObject({ template: name, tools: ["notify", "read_transcript"], credential: `claude_oauth_token:${name}`, escalate_to: "user", owner: null });
    expect(a).not.toHaveProperty("role");

    // An agent with hands starts where its sandbox is, whatever its template is called.
    const [start] = await nextCommands(s.brain.ws, isStartOf(a.agent));
    expect(start).toMatchObject({
      oauth_token: "sk-reviewer",
      launch: { builtin_tools: ["TodoWrite"], system_prompt: { mode: "append", text: "You review.\n\nReview carefully." } },
      hands: { sandbox: s.sandbox },
    });
    expect(start).not.toHaveProperty("role");

    const ws = await runner(a.agent, s.brain.host, s.brain.host_token);
    const tools = await toolNames(ws);
    // Its capabilities' tools, and `exit`, which every agent has (docs/agents/#lifetimes).
    expect(tools.map((t) => t.name)).toEqual(["notify", "exit", "read_transcript"]);
    // `roles: []` on every definition, for runners of the previous release (they require the field).
    expect(tools.every((t) => Array.isArray(t.roles) && (t.roles as unknown[]).length === 0)).toBe(true);
    ws.send({ type: "tool_call", seq: 1, call: "cal_tpl-1", turn: "trn_x", name: "emit", arguments: { event: "progress", summary: "x" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_tpl-1")).outcome.error.code).toBe("forbidden");
    expect((await adminJson(`/v1/agents/${a.agent}`)).rules).toEqual([{ pattern: "mcp__nest__*", decision: "allow" }, { pattern: "Bash", decision: "ask" }]);
  });

  it("an agent without hands starts where hand-less agents go, whatever its template is called", async () => {
    const s = await cellWithSandbox();
    const name = uniqueName("solo");
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT",
      body: { capabilities: ["nest", "messaging"], launch: { builtin_tools: [], system_prompt: { mode: "replace", text: "Solo." } },
        hands: "optional", credential: "claude_oauth_token", escalate_to: "user" },
    });
    const a = await adminJson("/v1/agents", { body: { template: name, workstream: s.workstream, cell: s.cell } }, 201);
    const [start] = await nextCommands(s.brain.ws, isStartOf(a.agent));
    expect(start).toMatchObject({ oauth_token: "sk-default" });
    expect(start).not.toHaveProperty("hands");
    expect(start).not.toHaveProperty("hands");
    // Nothing subscribed it to the workstream: only a template that says so does (the captain's).
    expect((await wsStub(s.workstream).info()).subscriber).toBeNull();
  });

  it("a stored credential naming any other secret is refused at start, never resolved", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false } }, 201);
    await editAgent(a.agent, (i) => {
      i.credential = `binding_key:${s.cell}`;
    });
    await expect(Promise.resolve().then(async () => {
      await agentStub(a.agent).start();
    })).rejects.toThrow(/not a Claude setup token credential/);
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await expect(Promise.resolve().then(() => broker.credentialRef("access:gateway"))).rejects.toThrow(/not a Claude setup token/);
  });

  it("overrides narrow the tools and may send questions to the user; a role is the same-named template", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", {
      body: { role: "worker", sandbox: s.sandbox, overrides: { tools: ["ask", "notify"], escalate_to: "user" } },
    }, 201);
    expect(a).toMatchObject({ template: "worker", tools: ["notify", "ask"], escalate_to: "user" });
    expect((await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, overrides: { tools: ["merge"] } } }, 400)).error.message)
      .toContain("doesn't give merge");
    expect((await adminJson("/v1/agents", { body: { template: "captain", role: "worker", sandbox: s.sandbox } }, 400)).error.message)
      .toContain("template and role differ");
    expect((await adminJson("/v1/agents", { body: { template: "worker", workstream: s.workstream, cell: s.cell } }, 400)).error.message)
      .toContain("needs a sandbox");

    await nextCommands(s.brain.ws, isStartOf(a.agent));
    const ws = await runner(a.agent, s.brain.host, s.brain.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_esc-1", turn: "trn_x", name: "ask", arguments: { question: "Which colour?" } });
    for (let i = 0; i < 50 && !(await wsStub(s.workstream).userNotifications()).some((n) => n.text.includes("Which colour?")); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await wsStub(s.workstream).userNotifications()).some((n) => n.text.includes("Which colour?"))).toBe(true);
    expect((await wsStub(s.workstream).events()).some((e) => e.type === "needs_input")).toBe(false);
  });
});

describe("escalation and the workstream channel's subscriber", () => {
  it("a captain escalates to the user, not to the workstream channel it reads", async () => {
    const s = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: s.workstream, cell: s.cell } }, 201);
    expect((await wsStub(s.workstream).info()).subscriber).toBe(c.agent);
    await nextCommands(s.brain.ws, isStartOf(c.agent));
    const ws = await runner(c.agent, s.brain.host, s.brain.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_cq-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "to whom?" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_cq-1")).outcome.status).toBe("ok");
    expect((await wsStub(s.workstream).userNotifications()).map((n) => n.text)).toContain("to whom?");
    // Not its own inbox (the previous release delivered a captain's `captain` notify to itself).
    expect(await agentStub(c.agent).turns()).toEqual([]);
  });

  it("a worker without an owner reaches the subscriber; subscribers must be agents; a stored `captain` is the subscriber", async () => {
    const s = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: s.workstream, cell: s.cell, start: false } }, 201);
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox } }, 201);
    expect(w.owner).toBeNull();
    await nextCommands(s.brain.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.brain.host, s.brain.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_ws-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "done" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_ws-1")).outcome.status).toBe("ok");
    const turns = await agentStub(c.agent).turns();
    expect(turns.map((t) => t.input.text).join("\n")).toContain("done");

    expect((await adminJson(`/v1/workstreams/${s.workstream}/subscriber`, { method: "PUT", body: { subscriber: "agt_nobody00000000000000000000" } }, 404))
      .error.code).toBe("unknown_agent");
    await adminJson(`/v1/workstreams/${s.workstream}/subscriber`, { method: "PUT", body: { subscriber: null } });
    expect((await wsStub(s.workstream).info()).subscriber).toBeNull();

    await runInDurableObject(wsStub(s.workstream), (_i, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      delete info.subscriber;
      info.captain = c.agent;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    expect(await wsStub(s.workstream).info()).toMatchObject({ subscriber: c.agent });
    expect(await wsStub(s.workstream).info()).not.toHaveProperty("captain");
  });
});

describe("records stored with a role (the previous release)", () => {
  it("load as the role's expanded spec: grants narrow the tools, the captain is the owner, and the role is gone", async () => {
    const s = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: s.workstream, cell: s.cell, start: false } }, 201);
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox } }, 201);
    await editAgent(w.agent, (i) => {
      for (const k of ["template", "tools", "credential", "escalate_to", "owner"]) delete i[k];
      Object.assign(i, { role: "worker", grants: ["notify", "emit", "merge"], captain: c.agent });
    });
    const info = await agentStub(w.agent).info();
    expect(info).toMatchObject({ template: "worker", tools: ["notify", "emit"], credential: "claude_oauth_token:worker", escalate_to: "workstream", owner: c.agent });
    const stored = await runInDurableObject(agentStub(w.agent), (_i: AgentDO, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value));
    expect(stored).toMatchObject({ tools: ["notify", "emit"], owner: c.agent });
    // Migrated: neither the record read nor the one stored has the previous release's fields.
    for (const k of ["role", "grants", "captain"]) {
      expect(info).not.toHaveProperty(k);
      expect(stored).not.toHaveProperty(k);
    }

    await nextCommands(s.brain.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.brain.host, s.brain.host_token);
    expect((await toolNames(ws)).map((t) => t.name)).toEqual(["notify", "emit", "exit"]);
  });
});

describe("one release of compatibility, and the review's edge cases", () => {
  const raw = async (stub: any) => runInDurableObject(stub, (_i: unknown, st: DurableObjectState) =>
    JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value));

  it("a workstream writes the previous release's `captain` beside its subscriber, and reads one the previous release changed", async () => {
    const s = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: s.workstream, cell: s.cell, start: false } }, 201);
    expect(await raw(wsStub(s.workstream))).toMatchObject({ subscriber: c.agent, captain: c.agent });
    // A forward revert's release changes only `captain`: once back, that is the subscriber.
    await runInDurableObject(wsStub(s.workstream), (_i, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.captain = null;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    expect((await wsStub(s.workstream).info()).subscriber).toBeNull();
  });

  it("a subscriber is an agent of the workstream; a new workstream takes none", async () => {
    const s = await cellWithSandbox();
    const other = await cellWithSandbox();
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: other.sandbox, start: false } }, 201);
    expect((await adminJson(`/v1/workstreams/${s.workstream}/subscriber`, { method: "PUT", body: { subscriber: w.agent } }, 409)).error.message)
      .toContain("is in workstream");
    expect((await adminJson("/v1/workstreams", { body: { goal: "g", subscriber: w.agent } }, 400)).error.code).toBe("invalid_message");
  });

  it("the previous release's grants field is refused, never ignored (that would widen the tools)", async () => {
    const s = await cellWithSandbox();
    const r = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, grants: ["notify"], start: false } }, 400);
    expect(r.error.message).toContain("overrides.tools");
  });

  it("a stored owner in another workstream (an older record) still can't be notified", async () => {
    const other = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: other.workstream, cell: other.cell, start: false } }, 201);
    const s = await cellWithSandbox();
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox } }, 201);
    await editAgent(w.agent, (i) => {
      i.owner = c.agent;
    });
    await nextCommands(s.brain.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.brain.host, s.brain.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_own-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "hi" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_own-1")).outcome.error.code).toBe("forbidden");
    expect(await agentStub(c.agent).turns()).toEqual([]);
  });

  it("an ask re-run after its escalation changed is applied once, where it first went", async () => {
    const s = await cellWithSandbox();
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox } }, 201);
    await nextCommands(s.brain.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.brain.host, s.brain.host_token);
    const ask = { type: "tool_call", call: "cal_rr-1", turn: "trn_x", name: "ask", arguments: { question: "Rerouted?" } };
    ws.send({ ...ask, seq: 1 });
    await ws.next("ack", (m) => m.up_to >= 1);
    expect((await wsStub(s.workstream).events()).filter((e) => e.type === "needs_input").length).toBe(1);
    // An eviction mid-call, across a deploy that sends this agent's questions to the user.
    await editAgent(w.agent, (i) => {
      i.escalate_to = "user";
    });
    await runInDurableObject(agentStub(w.agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("UPDATE tool_calls SET status = 'dispatching', outcome = NULL");
    });
    ws.send({ ...ask, seq: 2 });
    await ws.next("ack", (m) => m.up_to >= 2);
    expect((await wsStub(s.workstream).events()).filter((e) => e.type === "needs_input").length).toBe(1);
    expect((await wsStub(s.workstream).userNotifications()).some((n) => n.text.includes("Rerouted?"))).toBe(false);
  });
});

describe("CatalogDO storage", () => {
  const catalogStub = (name: string) => env.CATALOG.get(env.CATALOG.idFromName(name));

  it("an entry deleted from the seed stays deleted when the object starts again", async () => {
    const stub = catalogStub(uniqueName("catalog-restart"));
    await stub.deleteTemplate("captain");
    const after = await runInDurableObject(stub, async (_i: CatalogDO, st) => new CatalogDO(st, env as never).catalog());
    expect(Object.keys(after.templates)).toEqual(["worker"]);
  });

  it("a row that doesn't parse is skipped, not fatal", async () => {
    const stub = catalogStub(uniqueName("catalog-bad"));
    await runInDurableObject(stub, (_i: CatalogDO, st) => {
      st.storage.sql.exec("INSERT INTO templates (name, body) VALUES ('broken', '{\"hands\": \"sometimes\"}')");
      st.storage.sql.exec("INSERT INTO capabilities (name, body) VALUES ('garbled', 'not json')");
    });
    const cat = await stub.catalog();
    expect(Object.keys(cat.templates).sort()).toEqual(["captain", "worker"]);
    expect(cat.capabilities).not.toHaveProperty("garbled");
    expect((await stub.expand({ template: "worker", hands: true, by: "operator" })).template).toBe("worker");
  });
});

// The task ledger left the platform (docs/README.md#principles): seed version 6 takes its capabilities
// out of stored catalogs, and an agent spawned with them still starts.
describe("the task ledger's removal", () => {
  const catalogStub = (name: string) => env.CATALOG.get(env.CATALOG.idFromName(name));
  /** The previous release's `tasks` capability, as it stored it. */
  const OLD_TASKS = { tools: ["task_list", "task_get", "task_create"], rules: [], prompt: "Your task ledger.", grants: [], params: ["ledger"] };

  it("a catalog at version 5 loses tasks and tasks-admin, and every template keeps its other capabilities and still expands", async () => {
    const stub = catalogStub(uniqueName("catalog-v5"));
    const untouched = JSON.stringify({ ...SEED_CATALOG.templates.worker!, capabilities: ["nest", "hands"], later_field: 1 });
    const rows = await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      // As the previous release left the live catalog: the seed with the ledger's capabilities in both
      // templates, an operator's edits, an operator's ledger template, and a row that doesn't parse.
      sql.exec("DELETE FROM capabilities");
      sql.exec("DELETE FROM templates");
      sql.exec("UPDATE kv SET value = '5' WHERE key = 'seed_version'");
      const caps: Record<string, unknown> = { ...SEED_CATALOG.capabilities, tasks: OLD_TASKS, "tasks-admin": { ...OLD_TASKS, tools: ["task_assign"] }, mine: { tools: ["notify"] } };
      for (const [n, c] of Object.entries(caps)) sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?)", n, JSON.stringify(c));
      const tpl = (name: string, body: unknown) => sql.exec("INSERT INTO templates (name, body) VALUES (?, ?)", name, typeof body === "string" ? body : JSON.stringify(body));
      const worker = SEED_CATALOG.templates.worker!;
      const captain = SEED_CATALOG.templates.captain!;
      tpl("worker", { ...worker, capabilities: [...worker.capabilities, "tasks"], params: {} });
      tpl("captain", { ...captain, capabilities: ["tasks", ...captain.capabilities, "tasks-admin", "mine"], params: {} });
      tpl("ledger-check", { ...worker, capabilities: ["nest", "hands", "tasks"], params: { ledger: "check-1" } });
      tpl("untouched", untouched);
      tpl("garbled", "not json");
      new CatalogDO(st, env as never);
      const read = () => Object.fromEntries(sql.exec<{ name: string; body: string }>("SELECT name, body FROM templates").toArray().map((r) => [r.name, r.body]));
      const once = read();
      // Applied once: a restart rewrites nothing.
      new CatalogDO(st, env as never);
      expect(read()).toEqual(once);
      return { templates: once, version: sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'seed_version'").one().value };
    });
    expect(rows.version).toBe(String(SEED_VERSION));
    const cat = await stub.catalog();
    expect(Object.keys(cat.capabilities).sort()).toEqual([...Object.keys(SEED_CATALOG.capabilities), "mine"].sort());
    expect(cat.templates.worker!.capabilities).toEqual(SEED_CATALOG.templates.worker!.capabilities);
    expect(cat.templates.captain!.capabilities).toEqual([...SEED_CATALOG.templates.captain!.capabilities, "mine"]);
    expect(cat.templates["ledger-check"]!.capabilities).toEqual(["nest", "hands"]);
    // The ledger default goes with its capability: the previous release, after a rollback, refuses a
    // parameter no listed capability declares.
    expect(JSON.parse(rows.templates["ledger-check"]!).params).toEqual({});
    expect(rows.templates.untouched).toBe(untouched);
    expect(rows.templates.garbled).toBe("not json");
    for (const [name, hands] of [["worker", true], ["captain", false], ["ledger-check", true], ["untouched", true]] as const) {
      const spec = await stub.expand({ template: name, hands, by: "operator" });
      expect(spec.tools.filter((t) => t.startsWith("task_")), name).toEqual([]);
    }
  });

  it("an agent whose stored spec names the task tools and a ledger still starts; its runner isn't offered them, and calling one is an unknown tool", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false } }, 201);
    await editAgent(a.agent, (i) => {
      i.tools = [...i.tools, "task_list", "task_create"];
      i.params = { ledger: "proj-a" };
    });
    await agentStub(a.agent).start();
    await nextCommands(s.brain.ws, isStartOf(a.agent));
    const ws = await runner(a.agent, s.brain.host, s.brain.host_token);
    const names = (await toolNames(ws)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["notify", "checkpoint"]));
    expect(names.filter((n) => n.startsWith("task_"))).toEqual([]);
    ws.send({ type: "tool_call", seq: 1, call: "cal_task", turn: "trn_x", name: "task_list", arguments: {} });
    const outcome = (await ws.next("tool_result", (m) => m.call === "cal_task")).outcome;
    expect(outcome).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    // Its record still reads (the stored `params` is ignored).
    expect((await adminJson(`/v1/agents/${a.agent}`)).agent).toBe(a.agent);
  });

  it("an operator spawn naming a capability parameter is refused, not silently given an agent without it", async () => {
    const s = await cellWithSandbox();
    const r = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false, overrides: { params: { ledger: "proj-a" } } } }, 400);
    expect(r.error.message).toContain("overrides.params is no longer accepted");
  });

  it("the stub ledger leaves the previous release's rows alone and keeps an alarm while it has deadlines, so a rollback's alarm still comes", async () => {
    const ledger = (name: string) => env.TASKS.get(env.TASKS.idFromName(name));
    // A ledger as the previous release left it: an undelivered notice and its due deadline, alarm armed.
    const old = ledger(`ledger/${uniqueName("old")}`);
    await runInDurableObject(old, async (_i: TaskLedgerDO, st) => {
      st.storage.sql.exec("CREATE TABLE deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      st.storage.sql.exec("CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, body TEXT NOT NULL)");
      st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('notices', 1)");
      st.storage.sql.exec("INSERT INTO outbox (channel, body) VALUES ('agt_x/inbox', '{}')");
      await st.storage.setAlarm(Date.now() + 60_000);
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(old)).toBe(true);
    await runInDurableObject(old, async (_i: TaskLedgerDO, st) => {
      expect(await st.storage.getAlarm()).toBeGreaterThanOrEqual(before + LEDGER_ALARM_MS);
      expect(st.storage.sql.exec("SELECT key, at FROM deadlines").toArray()).toEqual([{ key: "notices", at: 1 }]);
      expect(st.storage.sql.exec("SELECT channel FROM outbox").toArray()).toEqual([{ channel: "agt_x/inbox" }]);
    });
    // One with no deadlines (or none stored at all) is left with no alarm.
    const empty = ledger(`ledger/${uniqueName("empty")}`);
    await runInDurableObject(empty, (_i: TaskLedgerDO, st) => st.storage.setAlarm(Date.now() + 60_000));
    expect(await runDurableObjectAlarm(empty)).toBe(true);
    expect(await runInDurableObject(empty, (_i: TaskLedgerDO, st) => st.storage.getAlarm())).toBeNull();
  });
});

// Channels left the platform (docs/README.md#principles): seed version 7 takes their capabilities, tools
// and grants out of stored catalogs, and an agent spawned with them still starts.
describe("the channels' removal", () => {
  const catalogStub = (name: string) => env.CATALOG.get(env.CATALOG.idFromName(name));
  /** The previous release's channel capabilities, as it stored them. */
  const OLD_CHANNELS = {
    channels: { tools: ["channel_create", "post", "read", "subscribe", "unsubscribe"], rules: [], prompt: "Channels.", grants: [{ action: "post", channel: "user" }] },
    "messaging-tree": { tools: ["message"], rules: [], prompt: "Message.", grants: [{ action: "post", channel: "{owner}/inbox" }] },
  };

  it("a catalog at version 6 loses them, their tools and grants everywhere, and the spawning prompt that promised events; everything else stays", async () => {
    const stub = catalogStub(uniqueName("catalog-v6"));
    const worker = SEED_CATALOG.templates.worker!;
    const captain = SEED_CATALOG.templates.captain!;
    const untouched = JSON.stringify({ ...worker, capabilities: ["nest", "hands"], later_field: 1 });
    const mineAfter = { tools: ["notify"], rules: [{ pattern: "mcp__nest__*", decision: "allow" }], prompt: "Mine.", later_field: 2 };
    const rows = await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      // As the previous release left the live catalog: the seed with spawning's old prompt, the channel
      // capabilities, an operator's capability mixing channel tools and grants with others, operator
      // templates listing the channel capabilities, and rows that don't parse.
      sql.exec("DELETE FROM capabilities");
      sql.exec("DELETE FROM templates");
      sql.exec("UPDATE kv SET value = '6' WHERE key = 'seed_version'");
      const caps: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(SEED_CATALOG.capabilities).map(([n, c]) => [n, { ...c, grants: [] }])),
        spawning: { ...SEED_CATALOG.capabilities.spawning!, prompt: SPAWNING_PROMPT_V5, grants: [] },
        ...OLD_CHANNELS,
        mine: { ...mineAfter, tools: ["post", "notify", "read"], grants: [{ action: "read", channel: "team/*" }] },
      };
      for (const [n, c] of Object.entries(caps)) sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?)", n, JSON.stringify(c));
      sql.exec("INSERT INTO capabilities (name, body) VALUES ('garbled', 'not json')");
      const tpl = (name: string, body: unknown) => sql.exec("INSERT INTO templates (name, body) VALUES (?, ?)", name, typeof body === "string" ? body : JSON.stringify(body));
      tpl("worker", { ...worker, capabilities: [...worker.capabilities, "channels", "messaging-tree"] });
      tpl("captain", { ...captain, capabilities: ["channels", ...captain.capabilities, "mine"] });
      tpl("untouched", untouched);
      new CatalogDO(st, env as never);
      const read = (table: string) => Object.fromEntries(sql.exec<{ name: string; body: string }>(`SELECT name, body FROM ${table}`).toArray().map((r) => [r.name, r.body]));
      const once = { templates: read("templates"), capabilities: read("capabilities") };
      // Applied once: a restart rewrites nothing.
      new CatalogDO(st, env as never);
      expect({ templates: read("templates"), capabilities: read("capabilities") }).toEqual(once);
      return { ...once, version: sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'seed_version'").one().value };
    });
    expect(rows.version).toBe("7");
    expect(Object.keys(rows.capabilities).sort()).toEqual([...Object.keys(SEED_CATALOG.capabilities), "garbled", "mine"].sort());
    // Raw rows: the channel tools and grants gone from each, every other field kept.
    expect(JSON.parse(rows.capabilities.mine!)).toEqual(mineAfter);
    for (const [n, body] of Object.entries(rows.capabilities)) if (n !== "garbled") expect(JSON.parse(body), n).not.toHaveProperty("grants");
    expect(rows.capabilities.garbled).toBe("not json");
    expect(JSON.parse(rows.capabilities.spawning!).prompt).toBe(SEED_CATALOG.capabilities.spawning!.prompt);
    expect(rows.templates.untouched).toBe(untouched);
    const cat = await stub.catalog();
    expect(cat.templates.worker!.capabilities).toEqual(worker.capabilities);
    expect(cat.templates.captain!.capabilities).toEqual([...captain.capabilities, "mine"]);
    for (const [name, hands] of [["worker", true], ["captain", false], ["untouched", true]] as const) {
      const spec = await stub.expand({ template: name, hands, by: "operator" });
      expect(spec.tools.filter((t) => ["channel_create", "post", "read", "subscribe", "unsubscribe", "message"].includes(t)), name).toEqual([]);
      expect(spec, name).not.toHaveProperty("channel_grants");
    }
  });

  it("an operator's edited spawning prompt is kept", async () => {
    const stub = catalogStub(uniqueName("catalog-v6-edited"));
    const edited = `${SPAWNING_PROMPT_V5} Report back to me.`;
    const prompt = await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      sql.exec("UPDATE kv SET value = '6' WHERE key = 'seed_version'");
      sql.exec("UPDATE capabilities SET body = ? WHERE name = 'spawning'", JSON.stringify({ ...SEED_CATALOG.capabilities.spawning!, prompt: edited }));
      new CatalogDO(st, env as never);
      return (JSON.parse(sql.exec<{ body: string }>("SELECT body FROM capabilities WHERE name = 'spawning'").one().body) as { prompt: string }).prompt;
    });
    expect(prompt).toBe(edited);
  });

  it("an agent whose stored spec names the channel tools and grants still starts; its runner isn't offered them, and calling one is an unknown tool", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false } }, 201);
    const grants = [{ action: "post", channel: "user" }];
    await editAgent(a.agent, (i) => {
      i.tools = [...i.tools, "post", "read", "message"];
      i.channel_grants = grants;
    });
    await agentStub(a.agent).start();
    await nextCommands(s.brain.ws, isStartOf(a.agent));
    const ws = await runner(a.agent, s.brain.host, s.brain.host_token);
    const names = (await toolNames(ws)).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["notify", "checkpoint"]));
    expect(names.filter((n) => ["post", "read", "message"].includes(n))).toEqual([]);
    ws.send({ type: "tool_call", seq: 1, call: "cal_post", turn: "trn_x", name: "post", arguments: { channel: "user", text: "hi" } });
    const outcome = (await ws.next("tool_result", (m) => m.call === "cal_post")).outcome;
    expect(outcome).toMatchObject({ status: "error", error: { code: "unknown_tool" } });
    // The stored grants stay in its record, for a rollback to read.
    const stored = await runInDurableObject(agentStub(a.agent), (_i: AgentDO, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value));
    expect(stored.channel_grants).toEqual(grants);
  });

  it("an agent's queued event posts and its channel subscriptions are left for a rollback; their deadline no longer runs", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, start: false } }, 201);
    // As the previous release left it: an unposted event and a subscription, the outbox's deadline due.
    await runInDurableObject(agentStub(a.agent), (_i: AgentDO, st) => {
      const sql = st.storage.sql;
      sql.exec(`CREATE TABLE chan_out (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, body TEXT NOT NULL, tainted INTEGER NOT NULL,
        agent_owner TEXT, has_owner INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, refusals INTEGER NOT NULL DEFAULT 0)`);
      sql.exec("INSERT INTO chan_out (channel, body, tainted, created_ms) VALUES (?, '{}', 0, 1)", `${a.agent}/events`);
      sql.exec("CREATE TABLE channel_subs (channel TEXT NOT NULL, sub TEXT NOT NULL, hw INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0)");
      sql.exec("INSERT INTO channel_subs (channel, sub, created_ms) VALUES ('team/x', 'sub_1', 1)");
      sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('chan_out', 0)");
    });
    await runDue(agentStub(a.agent));
    const left = await runInDurableObject(agentStub(a.agent), (_i: AgentDO, st) => ({
      deadline: st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'chan_out'").toArray().length,
      out: st.storage.sql.exec("SELECT channel FROM chan_out").toArray().length,
      subs: st.storage.sql.exec("SELECT sub FROM channel_subs").toArray().length,
    }));
    expect(left).toEqual({ deadline: 0, out: 1, subs: 1 });
    expect((await agentStub(a.agent).lifetimeFacts())).not.toHaveProperty("subscriptions");
  });

  it("the stub channel leaves the previous release's rows alone and keeps an alarm while it has deadlines, so a rollback's alarm still comes", async () => {
    const channel = (name: string) => env.CHANNEL.get(env.CHANNEL.idFromName(name));
    // A channel as the previous release left it: an undelivered message, its subscription and the fan-out deadline, alarm armed.
    const old = channel(`team/${uniqueName("old")}`);
    await runInDurableObject(old, async (_i: ChannelDO, st) => {
      st.storage.sql.exec("CREATE TABLE deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
      st.storage.sql.exec("CREATE TABLE subs (id TEXT PRIMARY KEY, agent TEXT NOT NULL, body TEXT NOT NULL)");
      st.storage.sql.exec("INSERT INTO deadlines (key, at) VALUES ('fanout', 1)");
      st.storage.sql.exec("INSERT INTO subs (id, agent, body) VALUES ('sub_1', 'agt_x', '{}')");
      await st.storage.setAlarm(Date.now() + 60_000);
    });
    const before = Date.now();
    expect(await runDurableObjectAlarm(old)).toBe(true);
    await runInDurableObject(old, async (_i: ChannelDO, st) => {
      expect(await st.storage.getAlarm()).toBeGreaterThanOrEqual(before + CHANNEL_ALARM_MS);
      expect(st.storage.sql.exec("SELECT key, at FROM deadlines").toArray()).toEqual([{ key: "fanout", at: 1 }]);
      expect(st.storage.sql.exec("SELECT id FROM subs").toArray()).toEqual([{ id: "sub_1" }]);
    });
    // One with no deadlines left, or none stored at all, is left with no alarm.
    for (const table of [true, false]) {
      const empty = channel(`team/${uniqueName("empty")}`);
      await runInDurableObject(empty, async (_i: ChannelDO, st) => {
        if (table) st.storage.sql.exec("CREATE TABLE deadlines (key TEXT PRIMARY KEY, at INTEGER NOT NULL)");
        await st.storage.setAlarm(Date.now() + 60_000);
      });
      expect(await runDurableObjectAlarm(empty)).toBe(true);
      expect(await runInDurableObject(empty, (_i: ChannelDO, st) => st.storage.getAlarm()), `deadlines table: ${table}`).toBeNull();
    }
  });
});
