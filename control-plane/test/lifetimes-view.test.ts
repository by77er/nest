// The operator's lifetimes view (`GET /v1/admin/lifetimes`, docs/control-plane/dashboard/#abandoned):
// what is left lying around. The pure classifications first (lib/abandoned.ts, and `destroyAtMs`
// against the lifetime check it predicts), then the route over real DOs: a dormant sandbox with its
// destroy time, a sandbox held by an agent nobody uses (never dormant, so no TTL takes it), what an
// end leaves, a pruned agent still attached, an unreadable sandbox or agent, pages and caps.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { FleetDO } from "../src/do/fleet";
import type { SandboxDO } from "../src/do/sandbox";
import { type AgentFacts, type AgentRead, classifyAgent, classifySandbox, DEFAULT_QUIET_MS, ENDING_STUCK_MS, type SandboxFacts } from "../src/lib/abandoned";
import { DEFAULT_SANDBOX_IDLE_TTL_MS, destroyAtMs, EXPIRY_GAP_MS, EXPIRY_NOTICE_MS, expiryStep } from "../src/lib/lifetimes";
import type { LifetimesView } from "../../protocol/admin/view";
import { admin, adminJson, connectHost, eventually, nextCommands, runDue, sendEvents, sleep, uniqueCell } from "./helpers";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));

const facts = (f: Partial<AgentFacts> = {}): AgentRead => ({
  facts: {
    agent: "agt_a", template: "worker", owner: null, sandbox: null, brain: false, starting: false, current_turn: false, queued: 0,
    last_turn_ms: null, stopped_by_operator: false, live_children: [], subscriptions: 0, ended: null, ...f,
  },
});

describe("an agent's kind", () => {
  const kind = (f: Partial<AgentFacts>, quiet = DAY) => classifyAgent(facts(f), NOW, quiet);

  it("anything running or wanted is active, whatever its age", () => {
    expect(kind({})).toBe("quiet");
    expect(kind({ brain: true })).toBe("active");
    expect(kind({ starting: true })).toBe("active");
    expect(kind({ current_turn: true })).toBe("active");
    expect(kind({ queued: 1 })).toBe("active");
  });

  it("quiet once its last turn is `quiet_ms` old; never having had one is quiet", () => {
    expect(kind({ last_turn_ms: NOW - DAY + 1 })).toBe("recent");
    expect(kind({ last_turn_ms: NOW - DAY })).toBe("quiet");
    expect(kind({ last_turn_ms: NOW - 1 }, 0)).toBe("quiet");
    expect(kind({ last_turn_ms: null })).toBe("quiet");
  });

  it("an ended agent is counted, unless its end has been unfinished for over an hour", () => {
    expect(kind({ ended: { ms: NOW - 2 * DAY, reason: "stopped", done_ms: NOW - 2 * DAY } })).toBe("ended");
    expect(kind({ ended: { ms: NOW - ENDING_STUCK_MS, reason: "exited", done_ms: null } })).toBe("ended");
    expect(kind({ ended: { ms: NOW - ENDING_STUCK_MS - 1, reason: "exited", done_ms: null } })).toBe("ending");
    // Ended wins over a brain still finishing its turn.
    expect(kind({ brain: true, ended: { ms: NOW - 2 * HOUR, reason: "exited", done_ms: null } })).toBe("ending");
  });

  it("pruned and unreadable", () => {
    expect(classifyAgent({ gone: true }, NOW, DAY)).toBe("gone");
    expect(classifyAgent({ error: "boom" }, NOW, DAY)).toBe("unreadable");
  });
});

describe("a sandbox's kind", () => {
  const base: SandboxFacts = { state: "suspended", host: "hst_a", placing: null, attached: [] };
  const kinds: Record<string, ReturnType<typeof classifyAgent>> = { agt_q: "quiet", agt_a: "active", agt_r: "recent", agt_e: "ended", agt_g: "gone", agt_s: "ending", agt_u: "unreadable" };
  const cls = (s: Partial<SandboxFacts>) => classifySandbox({ ...base, ...s }, (a) => kinds[a], NOW, DAY);

  it("dormant by SandboxDO's own rule, with the TTL that applies and when it goes", () => {
    expect(cls({ dormant_since_ms: NOW - HOUR })).toEqual({ kind: "dormant", ttl: DAY, destroy_at: NOW - HOUR + DAY });
    expect(cls({ dormant_since_ms: NOW - HOUR, idle_ttl_ms: 600_000 })).toEqual({ kind: "dormant", ttl: 600_000, destroy_at: NOW - HOUR + 600_000 });
    // Its clock hasn't started: the next check starts it.
    expect(cls({})).toEqual({ kind: "dormant", ttl: DAY, destroy_at: null });
    // A VM up, or a placement in flight, is not dormant.
    expect(cls({ state: "running" }).kind).toBe("in_use");
    expect(cls({ state: "creating", host: null, placing: 1 }).kind).toBe("in_use");
    expect(cls({ state: "destroyed" }).kind).toBe("destroyed");
  });

  it("held when every attached agent is one nobody will use it through", () => {
    expect(cls({ attached: ["agt_q"] }).kind).toBe("held");
    expect(cls({ attached: ["agt_q", "agt_e", "agt_g", "agt_s"] }).kind).toBe("held");
    // Held is about agents, not the VM: a running one held by a quiet agent suspends on idle and stays.
    expect(cls({ state: "running", attached: ["agt_q"] }).kind).toBe("held");
  });

  it("in use while any attached agent is active or recent; unknown when one couldn't be read", () => {
    expect(cls({ attached: ["agt_q", "agt_a"] }).kind).toBe("in_use");
    expect(cls({ attached: ["agt_r"] }).kind).toBe("in_use");
    expect(cls({ attached: ["agt_q", "agt_u"] }).kind).toBe("unknown");
    // Not read (over the cap) is not proof of anything.
    expect(cls({ attached: ["agt_q", "agt_unread"] }).kind).toBe("unknown");
    expect(cls({ attached: ["agt_u", "agt_a"] }).kind).toBe("in_use");
  });
});

describe("destroyAtMs", () => {
  /** Run the lifetime check at each time it asks for, recording its notice, until it destroys. */
  function simulate(f: { since: number; noticed?: number; ttl: number; now: number }): number {
    let noticed = f.noticed;
    for (let t = f.now, i = 0; i < 10_000; i++) {
      const step = expiryStep({ dormant: true, since: f.since, ttl: f.ttl, now: t, ...(noticed !== undefined ? { noticed } : {}) });
      if (step.kind === "destroy") return t;
      if (step.kind === "notice") noticed = t;
      if (step.kind === "awake") throw new Error("awake");
      t = step.at;
    }
    throw new Error("never destroyed");
  }

  it("is when the lifetime check, run when it asks to be, destroys", () => {
    const ttls = [60_000, 10 * 60_000, DAY, DAY + 1, 2 * DAY, 30 * DAY];
    let n = 0;
    for (const ttl of ttls) {
      for (const ago of [0, HOUR, ttl / 2, ttl - DAY, ttl - DAY + HOUR, ttl - HOUR, ttl, ttl + HOUR, 3 * ttl]) {
        if (ago < 0) continue;
        const since = NOW - ago;
        for (const noticedAgo of [undefined, 0, HOUR, DAY - HOUR, 2 * DAY]) {
          if (noticedAgo !== undefined && (ttl <= EXPIRY_NOTICE_MS || NOW - noticedAgo < since)) continue;
          const f = { since, ttl, now: NOW, ...(noticedAgo !== undefined ? { noticed: NOW - noticedAgo } : {}) };
          // Past due, the next check destroys it at once.
          expect(Math.max(NOW, destroyAtMs(f)!), JSON.stringify({ ttl, ago, noticedAgo })).toBe(simulate(f));
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(80);
  });

  it("is null before the clock starts, and counts from now after missed checks, as the check does", () => {
    expect(destroyAtMs({ ttl: DAY, now: NOW })).toBeNull();
    const ttl = 30 * DAY;
    expect(destroyAtMs({ since: NOW - 20 * DAY, noticed: NOW - HOUR, ttl, now: NOW, checked: NOW - EXPIRY_GAP_MS - 1 })).toBe(NOW + ttl);
    expect(destroyAtMs({ since: NOW - 20 * DAY, ttl, now: NOW, checked: NOW - EXPIRY_GAP_MS })).toBe(NOW - 20 * DAY + ttl);
  });
});

// --- The route, over real DOs ----------------------------------------------------------------------

const page = (cell: string, q = "") => adminJson<LifetimesView>(`/v1/admin/lifetimes?cell=${cell}${q}`);

/** Every page merged, as the dashboard does: sandboxes appended, an agent listed once, counts summed. */
function merge(pages: LifetimesView[]): LifetimesView {
  const v = structuredClone(pages[0]!);
  const listed = new Set(v.agents.map((a) => a.agent));
  for (const p of pages.slice(1)) {
    v.sandboxes.push(...p.sandboxes);
    for (const a of p.agents) if (!listed.has(a.agent)) (listed.add(a.agent), v.agents.push(a));
    for (const [k, n] of Object.entries(p.counts.sandboxes)) v.counts.sandboxes[k as keyof typeof v.counts.sandboxes] += n;
    for (const [k, n] of Object.entries(p.counts.agents)) v.counts.agents[k as keyof typeof v.counts.agents] += n;
    v.agents_omitted += p.agents_omitted;
  }
  v.next_cursor = null;
  return v;
}

async function view(cell: string, q = ""): Promise<LifetimesView> {
  const pages: LifetimesView[] = [];
  for (let cursor: string | null = ""; cursor !== null;) {
    const p = await page(cell, `${q}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    pages.push(p);
    cursor = p.next_cursor;
  }
  return merge(pages);
}

/** Once the agent's cell has it in its agent registry (AgentDO registers from its `registry` deadline). */
const registered = (cell: string, agent: string) => eventually(`${agent} registered`, () =>
  runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => st.storage.sql.exec("SELECT 1 FROM agent_registry WHERE agent = ?", agent).toArray().length > 0));

/** A cell with a sandbox host, a workstream and a credential for `worker`s. */
async function cellWithHost() {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-lifetimes" } });
  const host = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "lifetimes" } }, 201);
  return { cell, host, workstream: workstream as string };
}
type Cell = Awaited<ReturnType<typeof cellWithHost>>;

/**
 * An operator's sandbox, placed (the host takes two; a third stays unplaced, which is dormant too);
 * `suspended`: then reported suspended by its host.
 */
async function sandboxIn(c: Cell, opts: { suspended?: boolean; idle_ttl_ms?: number } = {}): Promise<string> {
  const res = await admin("/v1/sandboxes", { body: { workstream: c.workstream, cell: c.cell, ...(opts.idle_ttl_ms ? { idle_ttl_ms: opts.idle_ttl_ms } : {}) } });
  const { sandbox } = await res.json<{ sandbox: string }>();
  expect([201, 202]).toContain(res.status);
  if (res.status === 202) return sandbox;
  const [create] = (await nextCommands(c.host.ws, (x) => x.type === "sandbox_create" && x.sandbox === sandbox)).filter((x) => x.sandbox === sandbox);
  if (opts.suspended) {
    const seq = sendEvents(c.host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox, epoch: create.epoch, state: "suspended" }]);
    await c.host.ws.next("ack", (m) => m.up_to >= seq);
    for (let i = 0; !(await sandboxStub(sandbox).info()).dormant_since_ms; i++) {
      if (i > 100) throw new Error("dormancy never recorded");
      await sleep(50);
    }
  }
  return sandbox;
}

/** A `worker` bound to `sandbox`, never started (no brain host): no brain, no turn. Registered in its cell before it returns. */
async function workerOn(sandbox: string, owner?: string): Promise<string> {
  const { agent } = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", sandbox, start: false, ...(owner ? { owner } : {}) } }, 201);
  await registered((await sandboxStub(sandbox).info()).cell, agent);
  return agent;
}

const editAgent = (agent: string, fn: (sql: SqlStorage, info: any) => void) =>
  runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
    const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
    fn(st.storage.sql, info);
    st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
  });

describe("GET /v1/admin/lifetimes", () => {
  it("is admin-only", async () => {
    expect((await SELF.fetch("http://cp.test/v1/admin/lifetimes?cell=local")).status).toBe(401);
    expect((await SELF.fetch("http://cp.test/v1/admin/lifetimes?cell=local", { headers: { authorization: "Bearer not-the-admin-token" } })).status).toBe(401);
  });

  it("lists a dormant sandbox with its dormancy, its TTL and when it will be destroyed; one in use is counted", async () => {
    const c = await cellWithHost();
    const running = await sandboxIn(c);
    const parked = await sandboxIn(c, { suspended: true });
    // Unplaced (the host is full): no VM up, so dormant too.
    const kept = await sandboxIn(c, { idle_ttl_ms: 30 * DAY });
    const v = await view(c.cell);
    const since = (await sandboxStub(parked).info()).dormant_since_ms!;
    expect(v.sandboxes.map((s) => s.sandbox).sort()).toEqual([parked, kept].sort());
    expect(v.sandboxes.find((s) => s.sandbox === parked)).toMatchObject({
      kind: "dormant", state: "suspended", attached: [], owner: null, idle_ttl_ms: DEFAULT_SANDBOX_IDLE_TTL_MS, own_ttl: false,
      dormant_since_ms: since, destroy_at_ms: since + DEFAULT_SANDBOX_IDLE_TTL_MS, generations: 0, memory_generations: 0, error: null,
    });
    const k = v.sandboxes.find((s) => s.sandbox === kept)!;
    expect(k).toMatchObject({ kind: "dormant", state: "creating", host: null, idle_ttl_ms: 30 * DAY, own_ttl: true });
    expect(k.destroy_at_ms).toBe(k.dormant_since_ms! + 30 * DAY);
    expect(v.counts.sandboxes).toMatchObject({ dormant: 2, in_use: 1, held: 0 });
    expect(v.sandboxes.some((s) => s.sandbox === running)).toBe(false);
    expect(v).toMatchObject({ cell: c.cell, quiet_ms: DEFAULT_QUIET_MS, cell_idle_ttl_ms: DEFAULT_SANDBOX_IDLE_TTL_MS, next_cursor: null, agents_omitted: 0 });
  });

  it("lists a sandbox held only by an agent nobody uses (never dormant, so its TTL never runs), and the agent with what it holds", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const agent = await workerOn(sandbox);
    // Attached: not dormant, so the TTL won't take it.
    expect((await sandboxStub(sandbox).info()).dormant_since_ms).toBeUndefined();
    // A turn an hour ago: recent by the default (a day), so in use.
    await editAgent(agent, (sql) => sql.exec(
      "INSERT INTO turns (turn, ord, input, status, created_ms, started_ms) VALUES ('trn_old', 1, '{}', 'done', ?, ?)", Date.now() - HOUR, Date.now() - HOUR));
    let v = await view(c.cell);
    expect(v.counts.sandboxes).toMatchObject({ in_use: 1, held: 0 });
    expect(v.counts.agents).toMatchObject({ recent: 1 });
    expect(v.sandboxes).toEqual([]);
    expect(v.agents).toEqual([]);
    // Quiet for over `quiet_ms`: held, and the agent listed.
    v = await view(c.cell, `&quiet_ms=${HOUR / 2}`);
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox, kind: "held", attached: [agent], destroy_at_ms: null, dormant_since_ms: null })]);
    expect(v.agents).toEqual([expect.objectContaining({
      agent, kind: "quiet", template: "worker", sandbox, last_turn_ms: expect.any(Number), live_children: [], subscriptions: 0, found_via: "registry", error: null,
    })]);
    expect(Date.now() - v.agents[0]!.last_turn_ms!).toBeGreaterThanOrEqual(HOUR);
    // The operator's stop says so.
    await adminJson(`/v1/agents/${agent}/stop`, { method: "POST" });
    v = await view(c.cell, "&quiet_ms=0");
    expect(v.agents[0]).toMatchObject({ agent, kind: "quiet", stopped_by_operator: true });
    // A turn queued makes it active again: in use.
    await editAgent(agent, (sql) => sql.exec("INSERT INTO turns (turn, ord, input, status, created_ms) VALUES ('trn_q', 2, '{}', 'queued', 1)"));
    v = await view(c.cell, "&quiet_ms=0");
    expect(v.counts.sandboxes).toMatchObject({ in_use: 1, held: 0 });
    expect(v.counts.agents).toMatchObject({ active: 1 });
  });

  it("an agent with no sandbox, owner or live child is still listed: every agent of the cell is read once, from its registry", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const tpl = `lead-${crypto.randomUUID().slice(0, 8)}`;
    await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: {
      capabilities: ["nest"], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "forbidden", credential: "claude_oauth_token", escalate_to: "user",
    } });
    const captain = (await adminJson<{ agent: string }>("/v1/agents", { body: { template: tpl, workstream: c.workstream, cell: c.cell, start: false } }, 201)).agent;
    await registered(c.cell, captain);
    const worker = await workerOn(sandbox);
    const v = await view(c.cell);
    expect(v.agents.find((a) => a.agent === captain)).toMatchObject({ kind: "quiet", found_via: "registry", sandbox: null, owner: null, live_children: [] });
    expect(v.agents.find((a) => a.agent === worker)).toMatchObject({ kind: "quiet", found_via: "registry", sandbox });
    // Each read once: the worker classifies its sandbox on the sandbox page, and is counted on the agent page only.
    expect(v.counts.agents.quiet).toBe(2);
    expect(v.agents).toHaveLength(2);
  });

  it("an ended agent is counted, not listed; its end detaches it, so its sandbox goes dormant; an unfinished end over an hour old is listed", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const agent = await workerOn(sandbox);
    await adminJson(`/v1/agents/${agent}/stop`, { body: { end: true } });
    for (let i = 0; (await sandboxStub(sandbox).info()).attached.length; i++) {
      if (i > 100) throw new Error("never detached");
      await sleep(50);
    }
    let v = await view(c.cell);
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox, kind: "dormant", destroy_at_ms: expect.any(Number) })]);
    expect(v.agents).toEqual([]);
    // Ended agents still around: one done (counted), one stuck mid-end and attached (listed, its sandbox held).
    const s2 = await sandboxIn(c, { suspended: true });
    const done = await workerOn(s2);
    const stuck = await workerOn(s2);
    await editAgent(done, (_sql, i) => { i.ended = { ms: Date.now() - 3 * DAY, by: "user", reason: "stopped", kill: true, destroy_sandbox: false, done_ms: Date.now() - 3 * DAY }; });
    await editAgent(stuck, (_sql, i) => { i.ended = { ms: Date.now() - 2 * HOUR, by: "user", reason: "stopped", kill: true, destroy_sandbox: false }; });
    v = await view(c.cell);
    // The first agent (its end done, from the registry) and `done` (read: its record says so) are counted.
    expect(v.counts.agents).toMatchObject({ ended: 2, ending: 1 });
    expect(v.agents).toEqual([expect.objectContaining({ agent: stuck, kind: "ending", ended_reason: "stopped", ended_ms: expect.any(Number) })]);
    expect(v.sandboxes.find((s) => s.sandbox === s2)).toMatchObject({ kind: "held", attached: expect.arrayContaining([done, stuck]) });
  });

  it("an attached agent whose records are pruned is listed as gone, and its sandbox held", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const agent = await workerOn(sandbox);
    // Its end long done and past the retention, with the sandbox somehow still attached: the reap runs.
    await editAgent(agent, (sql, i) => {
      i.ended = { ms: Date.now() - 31 * DAY, by: "user", reason: "stopped", kill: true, destroy_sandbox: false, done_ms: Date.now() - 31 * DAY };
      sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('reap', 0)");
    });
    await runDue(agentStub(agent));
    await expect(Promise.resolve().then(async () => { await agentStub(agent).info(); })).rejects.toThrow("unknown agent");
    const v = await view(c.cell);
    expect(v.agents).toEqual([expect.objectContaining({ agent, kind: "gone", template: null, error: null })]);
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox, kind: "held" })]);
  });

  it("a registered agent whose records are gone (its reap could not leave the registry) is counted once and its row dropped", async () => {
    const c = await cellWithHost();
    await fleetStub(c.cell).registerAgent("agt_prunedlongago", null);
    let v = await view(c.cell);
    expect(v.counts.agents.gone).toBe(1);
    expect(v.agents).toEqual([]);
    v = await view(c.cell);
    expect(v.counts.agents.gone).toBe(0);
  });

  it("an agent registers itself (agents from before the registry at their next alarm), its finished end is counted from the registry, and its reap leaves it", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const agent = await workerOn(sandbox);
    const row = () => runInDurableObject(fleetStub(c.cell), (_i: FleetDO, st) =>
      st.storage.sql.exec<{ ended_ms: number | null }>("SELECT ended_ms FROM agent_registry WHERE agent = ?", agent).toArray()[0] ?? null);
    // As a release before the registry left it: unregistered, and its own mark gone.
    await runInDurableObject(fleetStub(c.cell), (_i: FleetDO, st) => { st.storage.sql.exec("DELETE FROM agent_registry WHERE agent = ?", agent); });
    await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("DELETE FROM kv WHERE key = 'registry'");
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'registry'");
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    await runDue(agentStub(agent));
    await eventually("re-registered", async () => (await row()) !== null);
    expect(await row()).toEqual({ ended_ms: null });
    // Its end, once done, is recorded; the view counts it without reading it.
    await adminJson(`/v1/agents/${agent}/stop`, { body: { end: true } });
    await eventually("its end recorded", async () => (await row())?.ended_ms != null);
    const v = await view(c.cell);
    expect(v.counts.agents).toMatchObject({ ended: 1, quiet: 0 });
    // Reaped: out of the registry.
    await editAgent(agent, (sql, i) => {
      i.ended.ms = Date.now() - 31 * DAY;
      sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('reap', 0)");
    });
    await runDue(agentStub(agent));
    expect(await row()).toBeNull();
  });

  it("a sandbox SandboxDO can't answer for is a row with its error; an agent that can't be read makes its sandbox unknown", async () => {
    const c = await cellWithHost();
    // Registered (an operator's backfill) but never created: SandboxDO has no record.
    await adminJson(`/v1/admin/gc/register?cell=${c.cell}`, { body: { sandboxes: ["sbx_nevermade"] } });
    const sandbox = await sandboxIn(c, { suspended: true });
    const agent = await workerOn(sandbox);
    let v = await view(c.cell);
    expect(v.sandboxes.find((s) => s.sandbox === "sbx_nevermade")).toMatchObject({ kind: "unreadable", state: null, error: expect.stringContaining("unknown sandbox") });
    expect(v.counts.sandboxes.unreadable).toBe(1);
    // An agent read that fails (not `unknown_agent`).
    v = await runInDurableObject(fleetStub(c.cell), async (inst: FleetDO) => {
      const real = (inst as any).agentStub.bind(inst);
      (inst as any).agentStub = (id: string) => (id === agent ? { lifetimeFacts: async () => { throw new Error("boom"); } } : real(id));
      try {
        const pages = [await inst.lifetimes()];
        while (pages.at(-1)!.next_cursor) pages.push(await inst.lifetimes({ cursor: pages.at(-1)!.next_cursor! }));
        return merge(pages);
      } finally {
        (inst as any).agentStub = real;
      }
    });
    expect(v.agents).toEqual([expect.objectContaining({ agent, kind: "unreadable", found_via: "registry", error: expect.stringContaining("boom") })]);
    expect(v.counts.agents.unreadable).toBe(1);
    expect(v.sandboxes.find((s) => s.sandbox === sandbox)).toMatchObject({ kind: "unknown" });
  });

  it("pages the registry with a cursor, every sandbox once; bad cursors and limits are refused", async () => {
    const c = await cellWithHost();
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await sandboxIn(c, { suspended: true }));
    const seen: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const v: LifetimesView = await page(c.cell, `&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(v.sandboxes.length).toBeLessThanOrEqual(2);
      seen.push(...v.sandboxes.map((s) => s.sandbox));
      cursor = v.next_cursor;
      pages++;
    }
    expect(pages).toBe(2);
    expect(seen).toEqual(made);
    expect((await admin(`/v1/admin/lifetimes?cell=${c.cell}&cursor=nope`)).status).toBe(400);
    expect((await admin(`/v1/admin/lifetimes?cell=${c.cell}&cursor=a.12.sbx_x`)).status).toBe(400);
    // The agent pages, after the sandboxes: none here.
    expect(await page(c.cell, "&cursor=a")).toMatchObject({ sandboxes: [], agents: [], next_cursor: null });
    expect((await admin(`/v1/admin/lifetimes?cell=${c.cell}&limit=0`)).status).toBe(400);
    expect((await admin(`/v1/admin/lifetimes?cell=${c.cell}&quiet_ms=-1`)).status).toBe(400);
    // Over the most a page holds: capped, not refused.
    expect((await page(c.cell, "&limit=100000")).next_cursor).toBeNull();
  });

  it("reads at most 200 attached agents a sandbox page, 8 at a time, and says how many it left out", async () => {
    const c = await cellWithHost();
    const sandbox = await sandboxIn(c, { suspended: true });
    const many = Array.from({ length: 301 }, (_, i) => `agt_kid${i}`);
    const r = await runInDurableObject(fleetStub(c.cell), async (inst: FleetDO) => {
      const realAgent = (inst as any).agentStub.bind(inst);
      const realSandbox = (inst as any).sandbox.bind(inst);
      let inFlight = 0;
      let most = 0;
      let calls = 0;
      (inst as any).sandbox = (id: string) => {
        const s = realSandbox(id);
        return id === sandbox ? { info: async () => ({ ...(await s.info()), attached: many }), generations: () => s.generations() } : s;
      };
      (inst as any).agentStub = (id: string) => ({
        lifetimeFacts: async () => {
          calls++;
          most = Math.max(most, ++inFlight);
          await sleep(1);
          inFlight--;
          return (facts({ agent: id }) as { facts: AgentFacts }).facts;
        },
      });
      try {
        return { v: await inst.lifetimes(), most, calls };
      } finally {
        (inst as any).agentStub = realAgent;
        (inst as any).sandbox = realSandbox;
      }
    });
    expect(r.calls).toBe(200);
    expect(r.most).toBeLessThanOrEqual(8);
    expect(r.most).toBeGreaterThan(1);
    expect(r.v.agents_omitted).toBe(101);
    // Read to classify the sandbox (an agent left unread makes it unknown); counted on the agent pages, not here.
    expect(r.v.sandboxes).toEqual([expect.objectContaining({ sandbox, kind: "unknown" })]);
    expect(r.v.counts.agents.quiet).toBe(0);
  });
});
