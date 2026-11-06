// Grants (docs/agents/tools/#grants): read_transcript on agents named by id or label selector, conferred
// by the operator, an API client over its own subtree, or an agent attenuating one it holds; checked
// online at every call down the chain. The pure rules first, then each through the Worker and AgentDO.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import {
  attenuates, type ChainLookups, covers, entryWithin, expiresWithin, formatResource, type HeldGrant, inScope, intersectLimits, limitsWithin, narrows,
  parseGrantRequests, parseResource, reaches, type Resource, resolveChain, storedGrant,
} from "../src/lib/grants";
import { adminJson, BASE, connectHost, nextCommands, Ws } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

// --- Pure ------------------------------------------------------------------------------------------------

const res = (s: string): Resource => {
  const r = parseResource(s);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};
const held = (over: Partial<HeldGrant> = {}): HeldGrant => ({
  id: "grt_a", action: "read_transcript", resource: "agent{project=p}", scope: "cli_a", parent: { kind: "client", client: "cli_a" }, conferred_ms: 0, ...over,
});
/** Lookups over a fixed set of agents' grants and live clients. */
const lookups = (agents: Record<string, { grants: HeldGrant[]; ended?: boolean; client: string | null }>, clients: string[] = ["cli_a"]): ChainLookups => ({
  agentGrant: async (agent, grant) => {
    const a = agents[agent];
    return a ? { grant: a.grants.find((g) => g.id === grant) ?? null, ended: !!a.ended, client: a.client } : null;
  },
  clientLive: async (c) => clients.includes(c),
});

describe("grants (pure)", () => {
  it("parses ids and selectors into one canonical form, and refuses anything else", () => {
    expect(res("agt_abc1")).toEqual({ kind: "agent", id: "agt_abc1" });
    expect(formatResource(res("agent{role=dev,project=p=1}"))).toBe("agent{project=p=1,role=dev}");
    expect(formatResource(res("agent{}"))).toBe("agent{}");
    for (const bad of ["sandbox{project=p}", "agent{project}", "agent{Project=p}", "agent{a=1,a=2}", "agent{a=x}y}", "agt_ABC", "own", "agent{a=\n}"]) {
      expect(parseResource(bad).ok, bad).toBe(false);
    }
  });

  it("a selector covers an agent with all its labels; an id only that agent; scope is the client, exactly", () => {
    const t = { agent: "agt_x", client: "cli_a", labels: { project: "p", role: "dev" } };
    expect(covers(res("agent{project=p}"), t)).toBe(true);
    expect(covers(res("agent{}"), t)).toBe(true);
    expect(covers(res("agent{project=q}"), t)).toBe(false);
    expect(covers(res("agent{project=p,team=x}"), t)).toBe(false);
    expect(covers(res("agt_x"), t)).toBe(true);
    expect(covers(res("agt_y"), t)).toBe(false);
    expect(inScope("cli_a", { client: "cli_a" })).toBe(true);
    expect(inScope("cli_a", { client: "cli_b" })).toBe(false);
    expect(inScope("cli_a", { client: null })).toBe(false);
    expect(inScope(null, { client: "cli_a" })).toBe(false);
    expect(inScope(null, { client: null })).toBe(true);
  });

  it("narrowing: more labels or the same id; an id under a selector needs its target", () => {
    expect(narrows(res("agent{project=p,role=dev}"), res("agent{project=p}"))).toBe(true);
    expect(narrows(res("agent{project=p}"), res("agent{project=p}"))).toBe(true);
    expect(narrows(res("agent{}"), res("agent{project=p}"))).toBe(false);
    expect(narrows(res("agent{project=q}"), res("agent{project=p}"))).toBe(false);
    expect(narrows(res("agt_x"), res("agt_x"))).toBe(true);
    expect(narrows(res("agt_y"), res("agt_x"))).toBe(false);
    expect(narrows(res("agent{project=p}"), res("agt_x"))).toBe(false);
    expect(narrows(res("agt_x"), res("agent{project=p}"))).toBe("lookup");
  });

  it("limits and expiry only tighten", () => {
    expect(limitsWithin({ max_entries: 10 }, { max_entries: 20 })).toBe(true);
    expect(limitsWithin({ max_entries: 30 }, { max_entries: 20 })).toBe(false);
    expect(limitsWithin({}, { max_age_ms: 1000 })).toBe(false);
    expect(limitsWithin({ max_age_ms: 5 }, undefined)).toBe(true);
    expect(intersectLimits({ max_entries: 5, max_age_ms: 100 }, { max_entries: 3 })).toEqual({ max_entries: 3, max_age_ms: 100 });
    expect(expiresWithin(5, 10)).toBe(true);
    expect(expiresWithin(11, 10)).toBe(false);
    expect(expiresWithin(undefined, 10)).toBe(false);
    expect(expiresWithin(undefined, undefined)).toBe(true);
  });

  it("a stored grant this release can't read in full authorizes nothing", () => {
    expect(storedGrant(JSON.stringify(held()))).toEqual(held());
    expect(storedGrant(JSON.stringify(held({ limits: { max_entries: 5, max_bytes: 1 } as never })))).toBeNull();
    expect(storedGrant(JSON.stringify(held({ action: "post_inbox" as never })))).toBeNull();
    expect(storedGrant(JSON.stringify(held({ resource: "sandbox{x=y}" })))).toBeNull();
    expect(storedGrant("not json")).toBeNull();
  });

  it("parses a spawn's grants: legacy tool names, unknown fields and past expiries are refused", () => {
    expect(parseGrantRequests(undefined, 0)).toEqual({ ok: true, value: [] });
    expect(parseGrantRequests(["read_transcript"], 0)).toMatchObject({ ok: false, error: expect.stringContaining("no longer a list of tool names") });
    expect(parseGrantRequests([{ action: "read_transcript", resource: "agent{}", principal: "agt_x" }], 0).ok).toBe(false);
    expect(parseGrantRequests([{ action: "read_transcript", resource: "agent{}", limits: { max_bytes: 1 } }], 0).ok).toBe(false);
    expect(parseGrantRequests([{ action: "read_transcript", resource: "agent{}", expires_ms: 5 }], 10).ok).toBe(false);
    const ok = parseGrantRequests([{ action: "read_transcript", resource: "agent{b=2,a=1}" }], 0);
    expect(ok.ok && ok.value[0]!.req.resource).toBe("agent{a=1,b=2}");
  });

  it("a chain holds while every link does, intersecting limits and expiry, within one subtree", async () => {
    const root = held({ id: "grt_root", limits: { max_entries: 50 }, expires_ms: 1000 });
    const child = held({ id: "grt_child", resource: "agent{project=p,role=dev}", limits: { max_age_ms: 10 }, parent: { kind: "agent", agent: "agt_d", grant: "grt_root" } });
    const io = lookups({ agt_d: { grants: [root], client: "cli_a" } });
    const r = await resolveChain(child, "cli_a", 500, io);
    expect(r).toMatchObject({ scope: "cli_a", limits: { max_entries: 50, max_age_ms: 10 }, expires_ms: 1000 });
    expect(r!.resources.map(formatResource)).toEqual(["agent{project=p,role=dev}", "agent{project=p}"]);
    // An expired ancestor, an ended conferrer, a revoked parent grant, a deleted client: nothing holds.
    expect(await resolveChain(child, "cli_a", 1000, io)).toBeNull();
    expect(await resolveChain(child, "cli_a", 500, lookups({ agt_d: { grants: [root], client: "cli_a", ended: true } }))).toBeNull();
    expect(await resolveChain(child, "cli_a", 500, lookups({ agt_d: { grants: [], client: "cli_a" } }))).toBeNull();
    expect(await resolveChain(child, "cli_a", 500, lookups({}))).toBeNull();
    expect(await resolveChain(child, "cli_a", 500, lookups({ agt_d: { grants: [root], client: "cli_a" } }, []))).toBeNull();
    // Another subtree anywhere in the chain: the holder's, the conferrer's, or the client root's.
    expect(await resolveChain(child, "cli_b", 500, io)).toBeNull();
    expect(await resolveChain(child, "cli_a", 500, lookups({ agt_d: { grants: [root], client: "cli_b" } }))).toBeNull();
    expect(await resolveChain(held({ parent: { kind: "client", client: "cli_b" } }), "cli_a", 0, lookups({}, ["cli_a", "cli_b"]))).toBeNull();
    // A grant of another action up the chain doesn't carry this one.
    expect(await resolveChain(child, "cli_a", 500, lookups({ agt_d: { grants: [{ ...root, action: "other" as never }], client: "cli_a" } }))).toBeNull();
    // A cycle ends.
    const loop = held({ id: "grt_l", parent: { kind: "agent", agent: "agt_l", grant: "grt_l" } });
    expect(await resolveChain(loop, "cli_a", 0, lookups({ agt_l: { grants: [loop], client: "cli_a" } }))).toBeNull();
    // A grant's own subtree must be its holder's, even from the operator's root.
    expect(await resolveChain(held({ scope: "cli_a", parent: { kind: "operator" } }), null, 0, lookups({}))).toBeNull();
    expect(await resolveChain(held({ scope: null, parent: { kind: "operator" } }), "cli_a", 0, lookups({}))).toBeNull();
    // The operator's root holds in the operator's subtree.
    expect(await resolveChain(held({ scope: null, parent: { kind: "operator" } }), null, 0, lookups({}))).toMatchObject({ scope: null });
  });

  it("reaching a target takes its subtree and every link's resource", async () => {
    const r = (await resolveChain(held({ resource: "agent{project=p}" }), "cli_a", 0, lookups({})))!;
    expect(reaches(r, { agent: "agt_x", client: "cli_a", labels: { project: "p" } })).toBe(true);
    // The same labels in another client's subtree, or the operator's: never.
    expect(reaches(r, { agent: "agt_x", client: "cli_b", labels: { project: "p" } })).toBe(false);
    expect(reaches(r, { agent: "agt_x", client: null, labels: { project: "p" } })).toBe(false);
    expect(reaches({ ...r, resources: [...r.resources, res("agent{role=dev}")] }, { agent: "agt_x", client: "cli_a", labels: { project: "p" } })).toBe(false);
  });

  it("attenuation: same action, a resource within each link, limits and expiry no wider", async () => {
    const parent = (await resolveChain(held({ limits: { max_entries: 20 }, expires_ms: 100 }), "cli_a", 0, lookups({})))!;
    const req = (resource: string, extra: Record<string, unknown> = {}) => ({ action: "read_transcript" as const, resource, limits: { max_entries: 20 }, expires_ms: 100, ...extra });
    const t = { agent: "agt_x", client: "cli_a", labels: { project: "p" } };
    expect(attenuates(req("agent{project=p,role=dev}"), res("agent{project=p,role=dev}"), parent, null)).toBe(true);
    expect(attenuates(req("agent{}"), res("agent{}"), parent, null)).toBe(false);
    expect(attenuates(req("agent{project=p}", { limits: { max_entries: 21 } }), res("agent{project=p}"), parent, null)).toBe(false);
    expect(attenuates(req("agent{project=p}", { limits: {} }), res("agent{project=p}"), parent, null)).toBe(false);
    expect(attenuates(req("agent{project=p}", { expires_ms: 101 }), res("agent{project=p}"), parent, null)).toBe(false);
    expect(attenuates(req("agent{project=p}", { expires_ms: undefined }), res("agent{project=p}"), parent, null)).toBe(false);
    // An id under the selector: by its target, in the subtree.
    expect(attenuates(req("agt_x"), res("agt_x"), parent, t)).toBe(true);
    expect(attenuates(req("agt_x"), res("agt_x"), parent, { ...t, labels: { project: "q" } })).toBe(false);
    expect(attenuates(req("agt_x"), res("agt_x"), parent, { ...t, client: "cli_b" })).toBe(false);
    expect(attenuates(req("agt_x"), res("agt_x"), parent, null)).toBe(false);
  });

  it("a time window keeps entries at or after it, and withholds entries with no time", () => {
    const at = (ms: number) => JSON.stringify({ type: "user", timestamp: new Date(ms).toISOString() });
    expect(entryWithin(at(1000), 1000)).toBe(true);
    expect(entryWithin(at(999), 1000)).toBe(false);
    expect(entryWithin(JSON.stringify({ type: "summary" }), 1000)).toBe(false);
    expect(entryWithin("not json", 1000)).toBe(false);
    expect(entryWithin("not json", undefined)).toBe(true);
  });
});

// --- Through the Worker and AgentDO ------------------------------------------------------------------------

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
async function asJson<T = any>(token: string, path: string, init: { method?: string; body?: unknown } = {}, status?: number): Promise<T> {
  const r = await as(token, path, init);
  const text = await r.text();
  if (status !== undefined) expect(r.status, `${path}: ${text}`).toBe(status);
  else expect(r.ok, `${path}: ${r.status} ${text}`).toBe(true);
  return JSON.parse(text) as T;
}

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const basic = (extra: Record<string, unknown> = {}) => ({ capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token", ...extra });

/** A client on a fresh cell with a brain host, a `basic` template (no read_transcript of its own) and a `dreamer` that spawns `basic`. */
async function world() {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const cell = `t-${rand()}`;
  const mk = async () => {
    const name = `g-${rand()}`;
    const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 20 } } }, 201);
    await asJson(c.token, `/v1/catalog/templates/${name}/basic`, { method: "PUT", body: basic() });
    await asJson(c.token, `/v1/catalog/capabilities/${name}/spawning`, { method: "PUT", body: { tools: ["agent_spawn"], spawn: [`${name}/basic`] } });
    await asJson(c.token, `/v1/catalog/templates/${name}/dreamer`, { method: "PUT", body: basic({ capabilities: ["nest", `${name}/spawning`] }) });
    return { id: c.client as string, name, token: c.token as string, tpl: `${name}/basic`, dreamer: `${name}/dreamer` };
  };
  const brain = await connectHost(cell, "brain");
  return { cell, brain, mk };
}
type World = Awaited<ReturnType<typeof world>>;
type Client = Awaited<ReturnType<World["mk"]>>;

const create = (w: World, c: Client, body: Record<string, unknown>, status = 201) =>
  asJson(c.token, "/v1/agents", { body: { template: c.tpl, cell: w.cell, start: false, ...body } }, status);

/** Entries `l1…ln` in an agent's durable transcript, each `ageMs[i]` old (default: now). */
async function plantTranscript(agent: string, n: number, ageMs: (i: number) => number = () => 0): Promise<string[]> {
  const now = Date.now();
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ type: "user", n: i + 1, timestamp: new Date(now - ageMs(i)).toISOString() }));
  const text = lines.map((l) => `${l}\n`).join("");
  const key = `test-transcripts/${agent}/0`;
  await env.BUCKET.put(key, text);
  await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    st.storage.sql.exec("INSERT INTO segments (base, offset, len, key) VALUES (0, 0, ?, ?)", text.length, key);
    const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
    info.durable_bytes = text.length;
    st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
  });
  return lines;
}

/** A runner session for an agent the brain host was told to start: tool calls and the tool list. */
async function session(w: World, agent: string) {
  const [start] = await nextCommands(w.brain.ws, (x) => x.type === "agent_start" && x.agent === agent);
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, w.brain.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent, host: w.brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b" });
  await ws.next("hello_ack");
  let seq = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = `cal_${rand()}`;
    ws.send({ type: "tool_call", seq: ++seq, call: id, turn: "trn_x", name, arguments: args });
    return (await ws.next("tool_result", (m) => m.call === id, 8000)).outcome;
  };
  const tools = async () => {
    ws.send({ type: "tools_list_request", request: `req_${rand()}` });
    return ((await ws.next("tools_list")).tools as { name: string }[]).map((t) => t.name);
  };
  return { ws, call, tools };
}

const tainted = (agent: string) => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
  st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'read_tainted'").toArray()[0]?.value === "true");
const json = (o: any) => o.content.find((x: any) => x.type === "json").value;
const text = (o: any) => o.content.find((x: any) => x.type === "text").text as string;
const readGrant = (resource: string, extra: Record<string, unknown> = {}) => ({ action: "read_transcript", resource, ...extra });

/** Rewrite one of an agent's stored grants (as a bug or a later release might have stored it). */
async function patchGrant(agent: string, patch: (g: any) => void): Promise<void> {
  await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    const row = st.storage.sql.exec<{ id: string; body: string }>("SELECT id, body FROM grants").one();
    const g = JSON.parse(row.body);
    patch(g);
    st.storage.sql.exec("UPDATE grants SET body = ? WHERE id = ?", JSON.stringify(g), row.id);
  });
}

describe("read_transcript through a grant", () => {
  it("a client confers it at spawn: the holder reads a sibling it doesn't own, is tainted, and lists only what the grant covers", async () => {
    const w = await world();
    const c = await w.mk();
    const other = await w.mk();
    const sib = (await create(w, c, { labels: { project: "p1", role: "dev" } })).agent as string;
    const sib2 = (await create(w, c, { labels: { project: "p1", role: "review" } })).agent as string;
    const elsewhere = (await create(w, c, { labels: { project: "p2", role: "dev" } })).agent as string;
    // The same labels in another client's subtree and in the operator's.
    const foreign = (await create(w, other, { labels: { project: "p1", role: "dev" } })).agent as string;
    const ops = (await adminJson("/v1/agents", { body: { template: "captain", cell: w.cell, start: false, labels: { project: "p1" } } }, 201)).agent as string;
    for (const a of [sib, foreign, ops, elsewhere]) await plantTranscript(a, 3);

    const d = await create(w, c, { start: true, labels: { project: "p1", role: "dreaming" }, grants: [readGrant("agent{project=p1}")] });
    expect(d.grants).toEqual([expect.objectContaining({ action: "read_transcript", resource: "agent{project=p1}", scope: c.id, parent: { kind: "client", client: c.id } })]);
    const s = await session(w, d.agent);
    // The grant offers the tools its template doesn't give.
    expect(await s.tools()).toEqual(expect.arrayContaining(["read_transcript", "list"]));

    expect(await tainted(d.agent)).toBe(false);
    const r = await s.call("read_transcript", { agent: sib });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    expect(json(r)).toMatchObject({ entries: 3, next_seq: 3, more: false });
    expect(await tainted(d.agent)).toBe(true);

    // Outside the selector, another client's agent with the same labels, the operator's: refused.
    for (const a of [elsewhere, foreign, ops]) expect(await s.call("read_transcript", { agent: a }), a).toMatchObject({ status: "error", error: { code: "forbidden" } });

    // Discovery: only what the grant covers (itself included), filtered by labels.
    const all = await s.call("list", { kind: "agent" });
    expect(json(all).agents.map((x: any) => x.agent).sort()).toEqual([sib, sib2, d.agent].sort());
    expect(json(all).agents[0].actions).toEqual(["read_transcript"]);
    expect(json(all).next_cursor).toBeNull();
    const devs = await s.call("list", { kind: "agent", labels: { role: "dev" } });
    expect(json(devs).agents.map((x: any) => x.agent)).toEqual([sib]);
    expect(json(await s.call("list", { kind: "agent", labels: { project: "p2" } })).agents).toEqual([]);
    const paged = await s.call("list", { kind: "agent", limit: 1 });
    expect(json(paged).agents).toHaveLength(1);
    const next = await s.call("list", { kind: "agent", limit: 1, cursor: json(paged).next_cursor });
    expect(json(next).agents).toHaveLength(1);
    expect(json(next).agents[0].agent).not.toBe(json(paged).agents[0].agent);
    s.ws.close();
  });

  it("without a grant: refused, and neither tool is offered", async () => {
    const w = await world();
    const c = await w.mk();
    const sib = (await create(w, c, { labels: { project: "p1" } })).agent as string;
    await plantTranscript(sib, 2);
    const n = await create(w, c, { start: true, labels: { project: "p1" } });
    const s = await session(w, n.agent);
    const tools = await s.tools();
    expect(tools).not.toContain("read_transcript");
    expect(tools).not.toContain("list");
    // Checked again at the call, not only in the list.
    expect(await s.call("read_transcript", { agent: sib })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await s.call("list", { kind: "agent" })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await tainted(n.agent)).toBe(false);
    s.ws.close();
  });

  it("limits: at most max_entries per call, and nothing older than max_age_ms", async () => {
    const w = await world();
    const c = await w.mk();
    const sib = (await create(w, c, { labels: { project: "p1" } })).agent as string;
    // Entries 1-2 a day old, 3-4 fresh.
    await plantTranscript(sib, 4, (i) => (i < 2 ? 86_400_000 : 0));
    const d = await create(w, c, { start: true, grants: [readGrant("agent{project=p1}", { limits: { max_entries: 1, max_age_ms: 3_600_000 } })] });
    const s = await session(w, d.agent);
    const r = await s.call("read_transcript", { agent: sib, limit: 50 });
    expect(r.status, JSON.stringify(r)).toBe("ok");
    expect(JSON.parse(text(r)).n).toBe(3);
    expect(json(r)).toMatchObject({ entries: 1, next_seq: 3, more: true });
    const r2 = await s.call("read_transcript", { agent: sib, since_seq: 3, limit: 50 });
    expect(JSON.parse(text(r2)).n).toBe(4);
    // A since_ms the model asks for narrows further, never widens.
    const r3 = await s.call("read_transcript", { agent: sib, since_ms: Date.now() - 7 * 86_400_000 });
    expect(JSON.parse(text(r3)).n).toBe(3);
    s.ws.close();

    // Several grants reach it: the first conferred decides, every time (one spawn's grants share a time).
    const many = await create(w, c, { start: true, grants: [readGrant("agent{project=p1}", { limits: { max_entries: 1 } }), ...Array.from({ length: 8 }, () => readGrant("agent{}"))] });
    expect(many.grants.map((g: any) => g.resource)).toEqual(["agent{project=p1}", ...Array(8).fill("agent{}")]);
    const m = await session(w, many.agent);
    expect(json(await m.call("read_transcript", { agent: sib, limit: 50 }))).toMatchObject({ entries: 1 });
    m.ws.close();
  });

  it("a selector outside the conferrer's subtree: an id refused at confer time, a planted one refused at call time", async () => {
    const w = await world();
    const c = await w.mk();
    const other = await w.mk();
    const foreign = (await create(w, other, { labels: { project: "p1" } })).agent as string;
    const ops = (await adminJson("/v1/agents", { body: { template: "captain", cell: w.cell, start: false } }, 201)).agent as string;
    await plantTranscript(foreign, 2);
    await plantTranscript(ops, 2);
    // Another client's agent, the operator's, or one that doesn't exist: 404, as any id outside the subtree.
    for (const id of [foreign, ops, "agt_nobody"]) {
      expect((await create(w, c, { grants: [readGrant(id)] }, 404)).error.code).toBe("not_found");
    }
    // The operator confers into its own subtree only, too.
    await adminJson("/v1/agents", { body: { template: "captain", cell: w.cell, start: false, grants: [readGrant(foreign)] } }, 404);
    // Malformed: refused before anything is made.
    expect((await create(w, c, { grants: ["read_transcript"] }, 400)).error.message).toContain("no longer a list of tool names");
    expect((await create(w, c, { grants: [readGrant("sandbox{project=p1}")] }, 400)).error.code).toBe("invalid_message");
    expect((await create(w, c, { grants: [readGrant("agent{}", { principal: "agt_x" })] }, 400)).error.code).toBe("invalid_message");

    // A grant stored naming another subtree's agent (as a bug might): the call-time check refuses it.
    const own = (await create(w, c, {})).agent as string;
    const d = await create(w, c, { start: true, grants: [readGrant(own)] });
    const s = await session(w, d.agent);
    await patchGrant(d.agent, (g) => {
      g.resource = foreign;
    });
    expect(await s.call("read_transcript", { agent: foreign })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(json(await s.call("list", { kind: "agent" })).agents).toEqual([]);
    // Or scoped to the other client outright: the holder's subtree decides, not the grant's word.
    await patchGrant(d.agent, (g) => {
      g.scope = other.id;
      g.parent = { kind: "client", client: other.id };
    });
    expect(await s.call("read_transcript", { agent: foreign })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    s.ws.close();
  });

  it("expiry: a lapsed grant reads nothing and offers no tool", async () => {
    const w = await world();
    const c = await w.mk();
    const sib = (await create(w, c, { labels: { project: "p1" } })).agent as string;
    await plantTranscript(sib, 1);
    // Already past: refused when conferred.
    await create(w, c, { grants: [readGrant("agent{project=p1}", { expires_ms: Date.now() - 1 })] }, 400);
    const d = await create(w, c, { start: true, grants: [readGrant("agent{project=p1}", { expires_ms: Date.now() + 3_600_000 })] });
    const s = await session(w, d.agent);
    expect((await s.call("read_transcript", { agent: sib })).status).toBe("ok");
    await patchGrant(d.agent, (g) => {
      g.expires_ms = Date.now() - 1;
    });
    expect(await s.call("read_transcript", { agent: sib })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    const tools = await s.tools();
    expect(tools).not.toContain("read_transcript");
    expect(tools).not.toContain("list");
    s.ws.close();
  });
});

describe("AgentDO.create", () => {
  it("refuses a grant scoped to another subtree than the agent's, before anything is made", async () => {
    const id = `agt_${rand()}`;
    const spec = { template: "t", tools: [], launch: LAUNCH as never, rules: [], credential: "claude_oauth_token" };
    const g = { action: "read_transcript" as const, resource: "agent{}", scope: "cli_other", parent: { kind: "client" as const, client: "cli_other" } };
    await expect(Promise.resolve().then(() => agentStub(id).create({ agent: id, cell: "c", spec, client: "cli_mine", grants: [g] }))).rejects.toThrow(/confined/);
    await expect(Promise.resolve().then(() => agentStub(id).create({ agent: id, cell: "c", spec, grants: [g] }))).rejects.toThrow(/confined/);
    await expect(Promise.resolve().then(() => agentStub(id).info())).rejects.toThrow();
  });
});

describe("conferring a grant down a spawn", () => {
  it("a child gets only what attenuates its spawner's grant, and loses it when the spawner ends", async () => {
    const w = await world();
    const c = await w.mk();
    const dev = (await create(w, c, { labels: { project: "p1", role: "dev" } })).agent as string;
    const review = (await create(w, c, { labels: { project: "p1", role: "review" } })).agent as string;
    await plantTranscript(dev, 2);
    await plantTranscript(review, 2);
    const expires = Date.now() + 3_600_000;
    const d = await create(w, c, { template: c.dreamer, start: true, grants: [readGrant("agent{project=p1}", { limits: { max_entries: 50 }, expires_ms: expires })] });
    const s = await session(w, d.agent);
    const spawn = (grants: unknown[]) => s.call("agent_spawn", { template: c.tpl, task: "read", grants });
    const narrow = (extra: Record<string, unknown> = {}) => readGrant("agent{project=p1,role=dev}", { limits: { max_entries: 10 }, expires_ms: expires, ...extra });

    // Wider in each way: refused.
    for (const g of [
      readGrant("agent{}", { limits: { max_entries: 10 }, expires_ms: expires }), // a wider selector
      readGrant("agent{project=p2}", { limits: { max_entries: 10 }, expires_ms: expires }), // another one
      narrow({ limits: { max_entries: 51 } }), // a looser limit
      narrow({ limits: {} }), // a limit dropped
      narrow({ expires_ms: expires + 1 }), // a later expiry
      narrow({ expires_ms: undefined }), // none
    ]) {
      expect(await spawn([g]), JSON.stringify(g)).toMatchObject({ status: "error", error: { code: "forbidden" } });
    }
    // An id outside its subtree: refused; one its grant covers: allowed.
    const other = await w.mk();
    const foreign = (await create(w, other, { labels: { project: "p1", role: "dev" } })).agent as string;
    expect(await spawn([readGrant(foreign, { limits: { max_entries: 10 }, expires_ms: expires })])).toMatchObject({ status: "error", error: { code: "forbidden" } });

    const ok = await spawn([narrow()]);
    expect(ok.status, JSON.stringify(ok)).toBe("ok");
    const kid = json(ok).agent as string;
    const info = await agentStub(kid).info();
    const parentGrant = (await agentStub(d.agent).info()).grants![0]!.id;
    expect(info.grants).toEqual([expect.objectContaining({ resource: "agent{project=p1,role=dev}", scope: c.id, parent: { kind: "agent", agent: d.agent, grant: parentGrant } })]);

    const k = await session(w, kid);
    expect((await k.call("read_transcript", { agent: dev })).status).toBe("ok");
    // Its own grant is narrower than its spawner's: the review agent is outside it.
    expect(await k.call("read_transcript", { agent: review })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(json(await k.call("list", { kind: "agent" })).agents.map((x: any) => x.agent)).toEqual([dev]);

    // Its spawner ends (asked; before the end reaches the child): what it conferred lapses at once.
    await runInDurableObject(agentStub(d.agent), (_i: AgentDO, st) => {
      const rec = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      rec.ended = { ms: Date.now(), by: "user", reason: "stopped", kill: true, destroy_sandbox: false };
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(rec));
    });
    expect((await agentStub(kid).info()).ended).toBeUndefined();
    expect(await k.call("read_transcript", { agent: dev })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(json(await k.call("list", { kind: "agent" })).agents).toEqual([]);
    k.ws.close();
    s.ws.close();
  });
});
