// Templates and capabilities as data (CatalogDO, the admin routes) and agents spawned from them: what
// an agent is offered, may call and is started with comes from its expanded spec, and
// nothing decides on a role or a template's name.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { CatalogDO } from "../src/do/catalog";
import { MESSAGING_TOOLS_REMOVED, RETIRED_TOOLS, SEED_CATALOG, SEED_CATALOG_V1, SEED_VERSION, SPAWNING_PROMPT_V5 } from "../src/lib/spec";
import { adminJson, connectHost, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
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
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  await nextCommands(sandboxHost.ws, (c) => c.type === "sandbox_create");
  return { cell, brain, sandbox: sbx.sandbox as string };
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
    expect(cat.templates.captain).toMatchObject({ hands: "forbidden", credential: "claude_oauth_token:captain" });

    const name = uniqueName("cap");
    expect((await adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { tools: ["no_such_tool"] } }, 400)).error.message)
      .toContain("unknown platform tool no_such_tool");
    // `notify` left the registry with workstreams: refused like any unknown tool.
    expect((await adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { tools: ["notify"] } }, 400)).error.message)
      .toContain("unknown platform tool notify");
    await adminJson(`/v1/admin/capabilities/${name}`, { method: "PUT", body: { tools: ["read_transcript"] } });
    const tpl = { capabilities: [name], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "optional" };
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
      method: "PUT", body: { tools: ["checkpoint", "read_transcript"], rules: [{ pattern: "Bash", decision: "ask" }], prompt: "Review carefully." },
    });
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT",
      body: {
        capabilities: ["nest", name], launch: { builtin_tools: ["TodoWrite"], system_prompt: { mode: "append", text: "You review." } },
        hands: "optional", credential: `claude_oauth_token:${name}`,
      },
    });
    await adminJson(`/v1/admin/secrets/claude_oauth_token:${name}`, { method: "PUT", body: { value: "sk-reviewer" } });
    const a = await adminJson("/v1/agents", { body: { template: name, sandbox: s.sandbox } }, 201);
    expect(a).toMatchObject({ template: name, tools: ["read_transcript", "checkpoint"], credential: `claude_oauth_token:${name}`, owner: null });
    for (const gone of ["role", "escalate_to", "subscribe", "workstream"]) expect(a).not.toHaveProperty(gone);

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
    expect(tools.map((t) => t.name)).toEqual(["exit", "read_transcript", "checkpoint"]);
    // `roles: []` on every definition, for runners of the previous release (they require the field).
    expect(tools.every((t) => Array.isArray(t.roles) && (t.roles as unknown[]).length === 0)).toBe(true);
    ws.send({ type: "tool_call", seq: 1, call: "cal_tpl-1", turn: "trn_x", name: "fork_sandbox", arguments: { sandbox: s.sandbox } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_tpl-1")).outcome.error.code).toBe("forbidden");
    expect((await adminJson(`/v1/agents/${a.agent}`)).rules).toEqual([{ pattern: "mcp__nest__*", decision: "allow" }, { pattern: "Bash", decision: "ask" }]);
  });

  it("an agent without hands starts where hand-less agents go, whatever its template is called", async () => {
    const s = await cellWithSandbox();
    const name = uniqueName("solo");
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT",
      body: { capabilities: ["nest", "transcripts"], launch: { builtin_tools: [], system_prompt: { mode: "replace", text: "Solo." } },
        hands: "optional", credential: "claude_oauth_token" },
    });
    const a = await adminJson("/v1/agents", { body: { template: name, cell: s.cell } }, 201);
    const [start] = await nextCommands(s.brain.ws, isStartOf(a.agent));
    expect(start).toMatchObject({ oauth_token: "sk-default" });
    expect(start).not.toHaveProperty("hands");
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

  it("overrides narrow the tools; a role is the same-named template; a `workstream` is accepted and ignored for one release", async () => {
    const s = await cellWithSandbox();
    const a = await adminJson("/v1/agents", {
      body: { role: "worker", sandbox: s.sandbox, overrides: { tools: ["checkpoint", "read_transcript"] }, start: false },
    }, 201);
    expect(a).toMatchObject({ template: "worker", tools: ["read_transcript", "checkpoint"] });
    expect((await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, overrides: { tools: ["merge"] } } }, 400)).error.message)
      .toContain("doesn't give merge");
    expect((await adminJson("/v1/agents", { body: { template: "captain", role: "worker", sandbox: s.sandbox } }, 400)).error.message)
      .toContain("template and role differ");
    expect((await adminJson("/v1/agents", { body: { template: "worker", cell: s.cell } }, 400)).error.message)
      .toContain("needs a sandbox");
    // Old clients (the nest CLI, scripts) still send a workstream: neither route requires or keeps one.
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream: "ws_legacy", cell: s.cell } });
    expect(await adminJson(`/v1/sandboxes/${sbx.sandbox}`)).not.toHaveProperty("workstream");
    const c = await adminJson("/v1/agents", { body: { template: "captain", workstream: "ws_legacy", cell: s.cell, start: false } }, 201);
    expect(c).not.toHaveProperty("workstream");
  });
});

describe("records stored with a role (the previous release)", () => {
  it("load as the role's expanded spec: grants narrow the tools, the captain is the owner, and the role is gone", async () => {
    const s = await cellWithSandbox();
    const c = await adminJson("/v1/agents", { body: { template: "captain", cell: s.cell, start: false } }, 201);
    const w = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox } }, 201);
    await editAgent(w.agent, (i) => {
      for (const k of ["template", "tools", "credential", "owner"]) delete i[k];
      Object.assign(i, { role: "worker", grants: ["checkpoint", "notify", "read_transcript", "merge"], captain: c.agent, escalate_to: "workstream" });
    });
    const info = await agentStub(w.agent).info();
    expect(info).toMatchObject({ template: "worker", tools: ["read_transcript", "checkpoint"], credential: "claude_oauth_token:worker", owner: c.agent });
    const stored = await runInDurableObject(agentStub(w.agent), (_i: AgentDO, st) =>
      JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value));
    expect(stored).toMatchObject({ tools: ["read_transcript", "checkpoint"], owner: c.agent });
    // Migrated: neither the record read nor the one stored has the previous release's fields.
    for (const k of ["role", "grants", "captain"]) {
      expect(info).not.toHaveProperty(k);
      expect(stored).not.toHaveProperty(k);
    }

    await nextCommands(s.brain.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.brain.host, s.brain.host_token);
    expect((await toolNames(ws)).map((t) => t.name)).toEqual(["exit", "read_transcript", "checkpoint"]);
  });
});

describe("one release of compatibility, and the review's edge cases", () => {
  it("the previous release's grants field is refused, never ignored (that would widen the tools)", async () => {
    const s = await cellWithSandbox();
    const r = await adminJson("/v1/agents", { body: { template: "worker", sandbox: s.sandbox, grants: ["notify"], start: false } }, 400);
    expect(r.error.message).toContain("overrides.tools");
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
    expect(names).toEqual(expect.arrayContaining(["read_transcript", "checkpoint"]));
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
    const mineAfter = { tools: ["checkpoint"], rules: [{ pattern: "mcp__nest__*", decision: "allow" }], prompt: "Mine.", later_field: 2 };
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
        mine: { ...mineAfter, tools: ["post", "checkpoint", "read"], grants: [{ action: "read", channel: "team/*" }] },
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
    expect(rows.version).toBe(String(SEED_VERSION));
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
    expect(names).toEqual(expect.arrayContaining(["read_transcript", "checkpoint"]));
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
});

// Workstreams and the messaging tools left the platform (docs/README.md#principles): seed version 8
// takes `messaging` and `events` and the tools that left out of stored catalogs.
describe("the messaging tools' removal", () => {
  const catalogStub = (name: string) => env.CATALOG.get(env.CATALOG.idFromName(name));
  const rawRows = (stub: DurableObjectStub<CatalogDO>, table: "templates" | "capabilities") => runInDurableObject(stub, (_i: CatalogDO, st) =>
    Object.fromEntries(st.storage.sql.exec<{ name: string; body: string }>(`SELECT name, body FROM ${table}`).toArray().map((r) => [r.name, JSON.parse(r.body)])));

  it("a catalog at version 7 loses messaging and events, and the tools that left everywhere; everything else stays", async () => {
    const stub = catalogStub(uniqueName("catalog-v7"));
    const v1 = SEED_CATALOG_V1;
    const mineAfter = { tools: ["read_transcript"], rules: [{ pattern: "mcp__nest__*", decision: "allow" }], prompt: "Mine.", later_field: 3 };
    const rows = await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      // As the previous release left the live catalog: the seed with `messaging`, `events` and the
      // workstream tools of `management`, templates listing them with `escalate_to` and `subscribe`, an
      // operator's capability naming `notify` among others, and an operator's template.
      sql.exec("DELETE FROM capabilities");
      sql.exec("DELETE FROM templates");
      sql.exec("UPDATE kv SET value = '7' WHERE key = 'seed_version'");
      const caps: Record<string, unknown> = {
        ...SEED_CATALOG.capabilities,
        messaging: v1.capabilities.messaging, events: v1.capabilities.events,
        management: { ...v1.capabilities.management!, tools: v1.capabilities.management!.tools.filter((t) => !RETIRED_TOOLS.includes(t)) },
        mine: { ...mineAfter, tools: ["notify", "read_transcript", "emit"] },
      };
      for (const [n, c] of Object.entries(caps)) sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?)", n, JSON.stringify(c));
      const tpl = (name: string, body: unknown) => sql.exec("INSERT INTO templates (name, body) VALUES (?, ?)", name, JSON.stringify(body));
      const worker = SEED_CATALOG.templates.worker!;
      const captain = SEED_CATALOG.templates.captain!;
      tpl("worker", { ...worker, capabilities: v1.templates.worker!.capabilities.filter((c) => c !== "subagents"), escalate_to: "workstream", subscribe: [] });
      tpl("captain", { ...captain, capabilities: [...v1.templates.captain!.capabilities, "spawning"], escalate_to: "user", subscribe: ["workstream"] });
      tpl("solo", { ...captain, capabilities: ["nest", "messaging", "mine"], escalate_to: "user", subscribe: [] });
      new CatalogDO(st, env as never);
      return sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'seed_version'").one().value;
    });
    expect(rows).toBe("8");
    const caps = await rawRows(stub, "capabilities");
    expect(Object.keys(caps).sort()).toEqual([...Object.keys(SEED_CATALOG.capabilities), "mine"].sort());
    // Raw rows: the tools that left gone from each, every other field kept.
    expect(caps.mine).toEqual(mineAfter);
    expect(caps.management.tools).toEqual(SEED_CATALOG.capabilities.management!.tools);
    for (const [n, c] of Object.entries(caps)) expect((c.tools as string[]).filter((t) => MESSAGING_TOOLS_REMOVED.includes(t)), n).toEqual([]);
    const tpls = await rawRows(stub, "templates");
    expect(tpls.worker.capabilities).toEqual(SEED_CATALOG.templates.worker!.capabilities);
    expect(tpls.captain.capabilities).toEqual(SEED_CATALOG.templates.captain!.capabilities);
    expect(tpls.solo.capabilities).toEqual(["nest", "mine"]);
    // The previous release's fields stay in the rows (it requires `escalate_to`, for a rollback).
    expect(tpls.worker).toMatchObject({ escalate_to: "workstream", subscribe: [] });
    for (const [name, hands] of [["worker", true], ["captain", false], ["solo", false]] as const) {
      const spec = await stub.expand({ template: name, hands, by: "operator" });
      expect(spec.tools.filter((t) => MESSAGING_TOOLS_REMOVED.includes(t)), name).toEqual([]);
      expect(spec, name).not.toHaveProperty("escalate_to");
      expect(spec, name).not.toHaveProperty("subscribe");
    }
  });

  it("template rows written now carry the previous release's escalate_to and subscribe; the catalog shows neither", async () => {
    // A fresh seed.
    const fresh = await rawRows(catalogStub(uniqueName("catalog-fresh")), "templates");
    for (const n of ["worker", "captain"]) expect(fresh[n], n).toMatchObject({ escalate_to: "user", subscribe: [] });
    // An operator's write.
    const name = uniqueName("tpl");
    await adminJson(`/v1/admin/templates/${name}`, {
      method: "PUT", body: { capabilities: ["nest"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "optional", credential: "claude_oauth_token" },
    });
    const live = await rawRows(catalogStub("catalog"), "templates");
    expect(live[name]).toMatchObject({ escalate_to: "user", subscribe: [], capabilities: ["nest"] });
    const cat = await adminJson("/v1/admin/catalog");
    for (const n of [name, "worker", "captain"]) {
      expect(cat.templates[n], n).not.toHaveProperty("escalate_to");
      expect(cat.templates[n], n).not.toHaveProperty("subscribe");
    }
    await adminJson(`/v1/admin/templates/${name}`, { method: "DELETE" });
  });
});
