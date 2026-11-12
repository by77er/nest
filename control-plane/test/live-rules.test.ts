// Live capability rules (docs/control-plane/durable-objects/agent/#rules, catalog/#live-rules): an agent's
// rules are read from its capabilities as they are now, so a capability write reaches running agents,
// after the narrowing it was spawned with; the push moves `rules_version`, so a rule approval checked
// against the old rules gets `conflict`; a nudge an agent misses still arrives; and a client's write
// reaches only its own subtree, within its grant.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDO } from "../src/do/agent";
import { CatalogDO } from "../src/do/catalog";
import { SPAWNING_PROMPT_V5 } from "../src/lib/spec";
import type { ToolRule } from "../src/protocol/control";
import { adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const catalogStub = () => env.CATALOG.get(env.CATALOG.idFromName("catalog"));
const NEST_ALLOW: ToolRule = { pattern: "mcp__nest__*", decision: "allow" };
const ALLOW_WEB: ToolRule = { pattern: "WebFetch", decision: "allow" };
const DENY_WEB: ToolRule = { pattern: "WebFetch", decision: "deny" };
const ALLOW_SEARCH: ToolRule = { pattern: "WebSearch", decision: "allow" };
const LAUNCH = { builtin_tools: ["WebFetch", "WebSearch"], system_prompt: { mode: "append", text: "" } };
const template = (capabilities: string[]) => ({ capabilities, launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" });
const capability = (rules: ToolRule[], extra: Record<string, unknown> = {}) => ({ tools: [], rules, prompt: "", ...extra });

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status = 200): Promise<T> {
  const res = await as(token, path, init);
  const text = await res.text();
  expect(res.status, `${path}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}

/** An operator capability (`lr-<rand>`, with `rules`) and a template listing `nest` and it. */
async function operatorEntries(rules: ToolRule[]) {
  const cap = `lr-${rand()}`;
  const tpl = `lrt-${rand()}`;
  await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: capability(rules) });
  await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: template(["nest", cap]) });
  return { cap, tpl };
}
const putCap = (cap: string, rules: ToolRule[]) => adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: capability(rules) });
const spawn = async (tpl: string, cell = uniqueCell(), extra: Record<string, unknown> = {}) =>
  (await adminJson("/v1/agents", { body: { template: tpl, cell, start: false, ...extra } }, 201)).agent as string;
const rulesOf = async (agent: string) => (await adminJson(`/v1/agents/${agent}`)).rules as ToolRule[];
const rulesBecome = (agent: string, want: ToolRule[]) =>
  eventually(`${agent}'s rules to become ${JSON.stringify(want)}`, async () => JSON.stringify(await rulesOf(agent)) === JSON.stringify(want));
const watched = (agent: string) => runInDurableObject(catalogStub(), (_i: CatalogDO, st) =>
  st.storage.sql.exec<{ capability: string }>("SELECT capability FROM rule_watch WHERE agent = ? ORDER BY capability", agent).toArray().map((r) => r.capability));
/** The agent's `rules` deadline has run (its read of the catalog landed, or it had nothing to read). */
const rulesSettled = (agent: string) => eventually(`${agent}'s rules read`, () => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
  st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'rules'").toArray().length === 0));

describe("live capability rules", () => {
  it("a running agent's rules follow its capability; the push moves rules_version, and an approval checked against the old rules gets conflict", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
    const host = await connectHost(cell, "brain");
    const { cap, tpl } = await operatorEntries([]);
    const agent = (await adminJson("/v1/agents", { body: { template: tpl, cell } }, 201)).agent as string;
    await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === agent);
    await rulesSettled(agent);
    expect(await watched(agent)).toEqual([cap, "nest"].sort());

    const ws = await Ws.connect(`/v1/agents/${agent}/session`, host.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent, host: host.host, instance_id: "rin_test", epoch: 1, session: SESSION });
    await ws.next("hello_ack");
    const first = (await ws.next("cache_update")).cache;
    expect(first.rules).toEqual([NEST_ALLOW]);
    const check = async (request: string, cache_version: number) => {
      ws.send({ type: "approval_check", request, call: `cal_${request}`, tool: "WebFetch", input: { url: "https://x.test" }, cache_version });
      return (await ws.next("approval_checked", (m) => m.request === request)).outcome;
    };
    // No rule matches WebFetch, so the runner asks; the operator approves.
    const held = await check("req_1", first.version);
    expect(held.status).toBe("pending");
    await adminJson(`/v1/agents/${agent}/asks/${held.ask}/answer`, { body: { answer: "approve" } });

    // The capability now allows it: the running agent gets the new rules without a restart.
    await putCap(cap, [ALLOW_WEB]);
    const next = (await ws.next("cache_update", (m) => m.cache.rules.length === 2)).cache;
    expect(next.rules).toEqual([NEST_ALLOW, ALLOW_WEB]);
    const view = await adminJson(`/v1/agents/${agent}`);
    expect(view.rules).toEqual([NEST_ALLOW, ALLOW_WEB]);
    expect(view.rules_version).toBe(next.version);
    expect(view.rule_sources).toEqual([{ capability: "nest" }, { capability: cap }]);
    // A check made against the cache before the change (in flight across it) is refused, and spends nothing.
    expect(await check("req_2", next.version - 1)).toMatchObject({ status: "error", error: { code: "conflict" } });
    const unspent = await runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ used_by: string | null }>("SELECT used_by FROM approvals WHERE ask = ?", held.ask).one().used_by);
    expect(unspent).toBeNull();

    // A write that leaves its rules as they are pushes nothing.
    await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: capability([ALLOW_WEB], { prompt: "edited" }) });
    await eventually("the nudge delivered", () => runInDurableObject(catalogStub(), (_i: CatalogDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM rule_nudges WHERE agent = ?", agent).toArray().length === 0));
    await rulesSettled(agent);
    expect((await adminJson(`/v1/agents/${agent}`)).rules_version).toBe(next.version);
    ws.close();
  });

  it("a nudge the agent didn't take is sent again until it does", async () => {
    const { cap, tpl } = await operatorEntries([]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    const proto = AgentDO.prototype as unknown as { rulesChanged: (this: AgentDO) => Promise<void> };
    const real = proto.rulesChanged;
    let refused = 0;
    proto.rulesChanged = async function (this: AgentDO) {
      if ((this as unknown as { load(): { agent: string } }).load().agent === agent && refused === 0) {
        refused++;
        throw new Error("lost on the way");
      }
      return real.call(this);
    };
    try {
      await putCap(cap, [ALLOW_WEB]);
      // The failed delivery is kept, to be tried again.
      const row = await eventually("the failed nudge recorded", () => runInDurableObject(catalogStub(), (_i: CatalogDO, st) =>
        st.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM rule_nudges WHERE agent = ?", agent).toArray().find((r) => r.attempts > 0)));
      expect(row.attempts).toBe(1);
      expect(await rulesOf(agent)).toEqual([NEST_ALLOW]);
    } finally {
      proto.rulesChanged = real;
    }
    // Its retry made due now (it waits NUDGE_RETRY_MS): it lands, and the agent converges.
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => {
      st.storage.sql.exec("UPDATE rule_nudges SET next_ms = 0 WHERE agent = ?", agent);
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'nudge'");
    });
    await runDue(catalogStub());
    await rulesBecome(agent, [NEST_ALLOW, ALLOW_WEB]);
  });

  it("a change no nudge reached (its watch lost) arrives at the agent's hourly read", async () => {
    const { cap, tpl } = await operatorEntries([]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    // As if the catalog never knew of it (a write a rolled-back release made sends no nudge).
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => st.storage.sql.exec("DELETE FROM rule_watch WHERE agent = ?", agent));
    await putCap(cap, [ALLOW_WEB]);
    expect(await rulesOf(agent)).toEqual([NEST_ALLOW]);
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'"));
    await runDue(agentStub(agent));
    await rulesBecome(agent, [NEST_ALLOW, ALLOW_WEB]);
    expect(await watched(agent)).toEqual([cap, "nest"].sort());
  });

  it("the operator's rules stand over a capability change until cleared; then the capability's are read", async () => {
    const { cap, tpl } = await operatorEntries([]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    await adminJson(`/v1/agents/${agent}/rules`, { method: "PUT", body: [DENY_WEB] });
    await rulesSettled(agent);
    expect(await watched(agent)).toEqual([]);
    await putCap(cap, [ALLOW_WEB]);
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'"));
    await runDue(agentStub(agent));
    expect(await rulesOf(agent)).toEqual([DENY_WEB]);
    expect((await adminJson(`/v1/agents/${agent}`)).rules_set).toBe(true);

    expect(await adminJson(`/v1/agents/${agent}/rules`, { method: "DELETE" })).toEqual({ rule_sources: [{ capability: "nest" }, { capability: cap }] });
    await rulesBecome(agent, [NEST_ALLOW, ALLOW_WEB]);
    expect((await adminJson(`/v1/agents/${agent}`)).rules_set).toBeUndefined();
  });

  it("rules the previous release's operator set after a rollback (no rules_set) stand as the operator's", async () => {
    const { cap, tpl } = await operatorEntries([]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    // The previous release's setRules writes `rules` alone.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.rules = [DENY_WEB];
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    await putCap(cap, [ALLOW_WEB]);
    await eventually("its rules taken as the operator's", async () => (await adminJson(`/v1/agents/${agent}`)).rules_set === true);
    await rulesSettled(agent);
    expect(await rulesOf(agent)).toEqual([DENY_WEB]);
    expect(await watched(agent)).toEqual([]);
  });

  it("an agent stored before rule sources keeps its rules; clearing them reads its template's, after its own deny and ask rules", async () => {
    const { cap, tpl } = await operatorEntries([]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    const ask: ToolRule = { pattern: "Bash", decision: "ask" };
    // The previous release's record: its rules joined at spawn, nothing saying where from.
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      delete info.rule_sources;
      info.rules = [ask, NEST_ALLOW];
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    await putCap(cap, [ALLOW_WEB]);
    await rulesSettled(agent);
    expect(await rulesOf(agent)).toEqual([ask, NEST_ALLOW]);
    await eventually("its watch dropped", async () => (await watched(agent)).length === 0);

    expect((await adminJson(`/v1/agents/${agent}/rules`, { method: "DELETE" })).rule_sources).toEqual([{ rules: [ask] }, { capability: "nest" }, { capability: cap }]);
    await rulesBecome(agent, [ask, NEST_ALLOW, ALLOW_WEB]);
  });

  it("a deleted capability's rules go; an ended agent leaves the watch; a watcher that is gone is dropped", async () => {
    const { cap, tpl } = await operatorEntries([ALLOW_WEB]);
    const agent = await spawn(tpl);
    await rulesSettled(agent);
    expect(await rulesOf(agent)).toEqual([NEST_ALLOW, ALLOW_WEB]);
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "DELETE" });
    await adminJson(`/v1/admin/capabilities/${cap}`, { method: "DELETE" });
    await rulesBecome(agent, [NEST_ALLOW]);

    // A watcher whose record is gone (pruned) answers unknown_agent: the catalog drops it.
    const ghost = `agt_${rand()}${rand()}`;
    const { cap: cap2 } = await operatorEntries([]);
    await runInDurableObject(catalogStub(), (_i: CatalogDO, st) => st.storage.sql.exec("INSERT INTO rule_watch (capability, agent) VALUES (?, ?)", cap2, ghost));
    await putCap(cap2, [ALLOW_WEB]);
    await eventually("the gone watcher dropped", async () => (await watched(ghost)).length === 0);

    await adminJson(`/v1/agents/${agent}/stop`, { body: { end: true } });
    await eventually("its watch left", async () => (await watched(agent)).length === 0);
  });
});

describe("a seed step", () => {
  it("that edits a capability nudges the live agents reading it, and one that leaves it alone nudges nobody", async () => {
    const stub = env.CATALOG.get(env.CATALOG.idFromName(`catalog-lr-${rand()}`));
    const nudged = await runInDurableObject(stub, async (_i: CatalogDO, st) => {
      const sql = st.storage.sql;
      // A catalog at version 6: version 7 replaces `spawning`'s prompt where it is still version 5's.
      sql.exec("UPDATE kv SET value = '6' WHERE key = 'seed_version'");
      const spawning = JSON.parse(sql.exec<{ body: string }>("SELECT body FROM capabilities WHERE name = 'spawning'").one().body);
      sql.exec("UPDATE capabilities SET body = ? WHERE name = 'spawning'", JSON.stringify({ ...spawning, prompt: SPAWNING_PROMPT_V5 }));
      sql.exec("INSERT INTO rule_watch (capability, agent) VALUES ('spawning', 'agt_reader'), ('hands', 'agt_other')");
      new CatalogDO(st, env as never);
      return sql.exec<{ agent: string }>("SELECT agent FROM rule_nudges ORDER BY agent").toArray().map((r) => r.agent);
    });
    expect(nudged).toEqual(["agt_reader"]);
  });
});

describe("a client's capability rules", () => {
  it("reach its own agents after their narrowing, never the operator's agent spawned from them, and a write outside its grant reaches nobody", async () => {
    const cell = uniqueCell();
    const name = `lr-${rand()}`;
    const grant = { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 10, max_sandboxes: 10, mcp_urls: ["https://tools.example.com/mcp"] };
    const c = await adminJson("/v1/admin/clients", { body: { name, grant } }, 201);
    const cap = `${name}/web`;
    await asJson(c.token, `/v1/catalog/capabilities/${cap}`, { method: "PUT", body: capability([]) });
    await asJson(c.token, `/v1/catalog/templates/${name}/t`, { method: "PUT", body: template(["nest", cap]) });
    // The client's agent, narrowed at spawn: WebFetch denied whatever the capability says.
    const own = (await asJson(c.token, "/v1/agents", { body: { template: `${name}/t`, cell, start: false, overrides: { rules: [DENY_WEB] } } }, 201)).agent as string;
    // The operator's agent from the client's template: the client's capability is read as at spawn.
    const operators = await spawn(`${name}/t`, cell);
    await rulesSettled(own);
    await rulesSettled(operators);
    expect((await adminJson(`/v1/agents/${operators}`)).rule_sources).toEqual([{ capability: "nest" }, { rules: [] }]);
    expect(await watched(operators)).toEqual(["nest"]);

    await asJson(c.token, `/v1/catalog/capabilities/${cap}`, { method: "PUT", body: capability([ALLOW_WEB, ALLOW_SEARCH]) });
    // The narrowing still wins: WebFetch stays denied, WebSearch is allowed now.
    await rulesBecome(own, [DENY_WEB, NEST_ALLOW, ALLOW_WEB, ALLOW_SEARCH]);
    await runInDurableObject(agentStub(operators), (_i: AgentDO, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'"));
    await runDue(agentStub(operators));
    expect(await rulesOf(operators)).toEqual([NEST_ALLOW]);

    // A write outside the grant (an mcp server it may not name) is refused, and changes no agent's rules.
    const bad = capability([{ pattern: "Bash", decision: "allow" }], { mcp: { url: "https://evil.example.com/mcp" } });
    const res = await as(c.token, `/v1/catalog/capabilities/${cap}`, { method: "PUT", body: bad });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("outside");
    expect((await asJson(c.token, `/v1/catalog/capabilities/${cap}`)).rules).toEqual([ALLOW_WEB, ALLOW_SEARCH]);
    await runInDurableObject(agentStub(own), (_i: AgentDO, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'"));
    await runDue(agentStub(own));
    expect(await rulesOf(own)).toEqual([DENY_WEB, NEST_ALLOW, ALLOW_WEB, ALLOW_SEARCH]);
  });
});
