// Templates and capabilities as data (CatalogDO, the admin routes) and agents spawned from them: what
// an agent is offered, may call, is started with and escalates to comes from its expanded spec, and
// nothing decides on a role or a template's name.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { adminJson, connectHost, nextCommands, uniqueCell, Ws } from "./helpers";

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
  const burst = await connectHost(cell);
  const controller = await connectHost(cell, "controller");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "templates" } }, 201);
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(burst.ws, (c) => c.type === "sandbox_create");
  return { cell, burst, controller, workstream: workstream as string, sandbox: sbx.sandbox as string };
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
    const [start] = await nextCommands(s.burst.ws, isStartOf(a.agent));
    expect(start).toMatchObject({
      oauth_token: "sk-reviewer",
      launch: { builtin_tools: ["TodoWrite"], system_prompt: { mode: "append", text: "You review.\n\nReview carefully." } },
      hands: { sandbox: s.sandbox },
      role: "worker", // deprecated, for runners of the previous release
    });

    const ws = await runner(a.agent, s.burst.host, s.burst.host_token);
    const tools = await toolNames(ws);
    expect(tools.map((t) => t.name)).toEqual(["notify", "read_transcript"]);
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
    const [start] = await nextCommands(s.controller.ws, isStartOf(a.agent));
    expect(start).toMatchObject({ oauth_token: "sk-default", role: "captain" });
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

    await nextCommands(s.burst.ws, isStartOf(a.agent));
    const ws = await runner(a.agent, s.burst.host, s.burst.host_token);
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
    await nextCommands(s.controller.ws, isStartOf(c.agent));
    const ws = await runner(c.agent, s.controller.host, s.controller.host_token);
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
    await nextCommands(s.burst.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.burst.host, s.burst.host_token);
    ws.send({ type: "tool_call", seq: 1, call: "cal_ws-1", turn: "trn_x", name: "notify", arguments: { to: "captain", message: "done" } });
    expect((await ws.next("tool_result", (m) => m.call === "cal_ws-1")).outcome.status).toBe("ok");
    const turns = await agentStub(c.agent).turns();
    expect(turns.map((t) => t.input.text).join("\n")).toContain("done");

    expect((await adminJson(`/v1/workstreams/${s.workstream}/subscriber`, { method: "PUT", body: { subscriber: "agt_nobody00000000000000000000" } }, 404))
      .error.code).toBe("unknown_agent");
    await adminJson(`/v1/workstreams/${s.workstream}/captain`, { method: "PUT", body: { captain: null } });
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
    for (const k of ["role", "grants", "captain"]) expect(stored).not.toHaveProperty(k);

    await nextCommands(s.burst.ws, isStartOf(w.agent));
    const ws = await runner(w.agent, s.burst.host, s.burst.host_token);
    expect((await toolNames(ws)).map((t) => t.name)).toEqual(["notify", "emit"]);
  });
});
