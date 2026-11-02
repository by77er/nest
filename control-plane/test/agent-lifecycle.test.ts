// Agent and sandbox lifetimes (docs/agents/#lifetimes, docs/control-plane/durable-objects/sandbox/#lifetime):
// `agent_spawn` makes a child its caller owns; `agent_stop` ends an agent the caller owns (through the
// agents it owns too), from a current epoch only; `exit` ends the caller once its turn is done; an
// ephemeral agent ends itself; an end cascades, drops queued turns, refuses input and may destroy the
// sandbox made for the agent; a dormant sandbox is destroyed after its idle TTL, with a day's notice;
// an ended agent's records go after the retention. The pure rules are checked directly first.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import type { SandboxDO } from "../src/do/sandbox";
import type { FleetDO } from "../src/do/fleet";
import {
  AGENT_RECORD_RETENTION_MS, dormant, EXPIRY_NOTICE_MS, ephemeralDone, expiryStep, MAX_LIVE_CHILDREN, MAX_SPAWN_DEPTH, ownsVia, spawnRefusal,
} from "../src/lib/lifetimes";
import { expandSpec, SEED_CATALOG, type Catalog } from "../src/lib/spec";
import { PLATFORM_TOOL_NAMES } from "../src/lib/registry";
import { adminJson, connectHost, nextCommands, runDue, sendEvents, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_0b7e7a52-3c1d-4e8f-9a6b-1d2c3e4f5a6b";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const DAY = 86_400_000;

/** Poll until `fn` gives something truthy (real alarms run in the pool; their timing is theirs). */
async function until<T>(fn: () => Promise<T>, what: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A runner session: tool calls and event batches share one inbound sequence. */
class Session {
  private seq = 0;
  private evSeq = 0;
  constructor(readonly ws: Ws, readonly agent: string, readonly epoch: number) {}

  call(name: string, args: unknown): string {
    const id = `cal_${rand()}`;
    this.ws.send({ type: "tool_call", seq: ++this.seq, call: id, turn: "trn_x", name, arguments: args });
    return id;
  }

  async run(name: string, args: unknown): Promise<any> {
    const id = this.call(name, args);
    return (await this.ws.next("tool_result", (m) => m.call === id, 8000)).outcome;
  }

  async events(evs: Record<string, unknown>[]): Promise<void> {
    const seq = ++this.seq;
    this.ws.send({ type: "events", seq, events: evs.map((e) => ({ agent: this.agent, epoch: this.epoch, seq: ++this.evSeq, ts_ms: Date.now(), ...e })) });
    await this.ws.next("ack", (m) => m.up_to >= seq);
  }
}

/** A cell with a brain host and a sandbox host, and templates whose spawning capability spawns `kid` (hands optional). */
async function world() {
  const id = rand();
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const sbxHost = await connectHost(cell);
  const brain = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "lifecycle" } }, 201);
  const kid = `kid-${id}`;
  const cap = `sp-${id}`;
  await adminJson(`/v1/admin/capabilities/${cap}`, { method: "PUT", body: { tools: ["agent_spawn", "agent_stop"], spawn: [kid] } });
  const tpl = (hands: string, extra: Record<string, unknown> = {}) => ({
    capabilities: ["nest", cap], launch: { builtin_tools: [], system_prompt: { mode: "append", text: "" } },
    hands, credential: "claude_oauth_token", escalate_to: "user", ...extra,
  });
  await adminJson(`/v1/admin/templates/${kid}`, { method: "PUT", body: tpl("optional", { share_sandbox: true }) });
  await adminJson(`/v1/admin/templates/par-${id}`, { method: "PUT", body: tpl("forbidden") });
  return { id, cell, sbxHost, brain, workstream: workstream as string, kid, par: `par-${id}` };
}
type World = Awaited<ReturnType<typeof world>>;

/** The brain host's `agent_start` for `agent`, and its runner session at that epoch. */
async function session(w: World, agent: string): Promise<Session> {
  const [start] = (await nextCommands(w.brain.ws, (c) => c.type === "agent_start" && c.agent === agent)).filter((c) => c.agent === agent);
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, w.brain.host_token);
  ws.send({ type: "hello", protocol_version: 1, agent, host: w.brain.host, instance_id: `rin_${rand()}`, epoch: start.epoch, session: SESSION });
  await ws.next("hello_ack");
  return new Session(ws, agent, start.epoch);
}

/** An operator's agent from `template`, with its session. */
async function operatorAgent(w: World, template: string, sandbox?: string): Promise<Session> {
  const a = await adminJson("/v1/agents", { body: { template, workstream: w.workstream, cell: w.cell, ...(sandbox ? { sandbox } : {}) } }, 201);
  return session(w, a.agent);
}

/** `agent_spawn` from `s`; the result's json part. */
async function spawn(s: Session, args: Record<string, unknown>): Promise<{ agent: string; sandbox?: string; ephemeral?: boolean }> {
  const out = await s.run("agent_spawn", { task: "do the thing", ...args });
  expect(out.status, JSON.stringify(out)).toBe("ok");
  return out.content.find((c: any) => c.type === "json").value;
}

const ended = async (agent: string) => (await agentStub(agent).info()).ended;
const exited = (w: World, s: Session) => {
  const seq = sendEvents(w.brain.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: s.epoch }]);
  return w.brain.ws.next("ack", (m) => m.up_to >= seq);
};
const isStop = (agent: string, mode: string) => (c: any) => c.type === "agent_stop" && c.agent === agent && c.mode === mode;

// --- Pure rules ---------------------------------------------------------------------------------------

describe("lifetime rules (pure)", () => {
  it("ownership is the owner chain: an owner, its owner, and so on; nobody else", () => {
    expect(ownsVia("agt_p", ["agt_p"])).toBe(true);
    expect(ownsVia("agt_p", ["agt_c", "agt_p"])).toBe(true);
    expect(ownsVia("agt_q", ["agt_c", "agt_p", null])).toBe(false);
    expect(ownsVia("agt_p", [null])).toBe(false);
  });

  it("spawns stop at the depth and live-children caps", () => {
    expect(spawnRefusal(0, 0)).toBeNull();
    expect(spawnRefusal(MAX_SPAWN_DEPTH - 1, MAX_LIVE_CHILDREN - 1)).toBeNull();
    expect(spawnRefusal(MAX_SPAWN_DEPTH, 0)).toContain("depth");
    expect(spawnRefusal(0, MAX_LIVE_CHILDREN)).toContain("haven't ended");
  });

  it("an ephemeral agent is done only with no turn current or queued, no open ask, and no child that hasn't ended", () => {
    const f = { ephemeral: true, ended: false, current: false, queued: false, openAsks: 0, liveChildren: 0 };
    expect(ephemeralDone(f)).toBe(true);
    for (const k of [{ ephemeral: false }, { ended: true }, { current: true }, { queued: true }, { openAsks: 1 }, { liveChildren: 1 }]) {
      expect(ephemeralDone({ ...f, ...k }), JSON.stringify(k)).toBe(false);
    }
  });

  it("dormant: no agent attached, no placement in flight, no VM up; never once destroyed", () => {
    const s = { state: "suspended" as const, host: "hst_a", placing: null, attached: [] as string[] };
    expect(dormant(s)).toBe(true);
    expect(dormant({ ...s, attached: ["agt_x"] })).toBe(false);
    expect(dormant({ ...s, placing: 3 })).toBe(false);
    for (const state of ["creating", "restoring", "running", "suspending"] as const) expect(dormant({ ...s, state }), state).toBe(false);
    // Unplaced (no host) or failed is dormant whatever the last report said.
    expect(dormant({ ...s, host: null, state: "running" })).toBe(true);
    expect(dormant({ ...s, state: "failed" })).toBe(true);
    expect(dormant({ ...s, host: null, state: "destroyed" })).toBe(false);
  });

  it("expiry: destroyed a TTL after it became dormant; a day's notice first for a TTL over a day, never skipped by a late check", () => {
    const t0 = Date.UTC(2026, 10, 1);
    // Short TTL: no notice; checked at the due time at the latest.
    const short = { dormant: true, since: t0, ttl: 10 * 60_000 };
    expect(expiryStep({ ...short, now: t0 + 60_000 })).toEqual({ kind: "wait", since: t0, at: t0 + 60_000 + 60_000 });
    expect(expiryStep({ ...short, now: t0 + 10 * 60_000 })).toEqual({ kind: "destroy", since: t0 });
    // Awake: nothing, checked again within the hour.
    expect(expiryStep({ dormant: false, ttl: 30 * DAY, now: t0 })).toEqual({ kind: "awake", at: t0 + 3_600_000 });
    // 30 days: wait, notice a day before, destroy at the due time.
    const long = { dormant: true, since: t0, ttl: 30 * DAY };
    expect(expiryStep({ ...long, now: t0 + DAY }).kind).toBe("wait");
    expect(expiryStep({ ...long, now: t0 + 29 * DAY })).toEqual({ kind: "notice", since: t0, destroy_at: t0 + 30 * DAY, at: t0 + 29 * DAY + 3_600_000 });
    expect(expiryStep({ ...long, noticed: t0 + 29 * DAY, now: t0 + 30 * DAY - 1 }).kind).toBe("wait");
    expect(expiryStep({ ...long, noticed: t0 + 29 * DAY, now: t0 + 30 * DAY })).toEqual({ kind: "destroy", since: t0 });
    // A check that comes late (past the due time, no notice yet) posts the notice and waits a full day.
    const late = t0 + 31 * DAY;
    expect(expiryStep({ ...long, now: late })).toEqual({ kind: "notice", since: t0, destroy_at: late + EXPIRY_NOTICE_MS, at: late + 3_600_000 });
    expect(expiryStep({ ...long, noticed: late, now: late + EXPIRY_NOTICE_MS - 1 }).kind).toBe("wait");
    expect(expiryStep({ ...long, noticed: late, now: late + EXPIRY_NOTICE_MS }).kind).toBe("destroy");
    // First seen dormant now: the clock starts now.
    expect(expiryStep({ dormant: true, ttl: 30 * DAY, now: t0 })).toMatchObject({ kind: "wait", since: t0 });
  });

  it("a spawner's lifetimes only shorten: ephemeral can be set, never cleared; the idle TTL never exceeds the template's or the cell's", () => {
    const cat: Catalog = {
      ...SEED_CATALOG,
      templates: {
        ...SEED_CATALOG.templates,
        eph: { ...SEED_CATALOG.templates.worker!, ephemeral: true, sandbox_idle_ttl_ms: 3_600_000 },
        long: { ...SEED_CATALOG.templates.worker!, sandbox_idle_ttl_ms: 90 * DAY, share_sandbox: true },
      },
    };
    const spawned = (template: string, overrides: Record<string, unknown> = {}, share = false) => {
      const r = expandSpec(cat, PLATFORM_TOOL_NAMES, { template, hands: true, by: "spawner", share, cell_idle_ttl_ms: 30 * DAY, overrides });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    expect(spawned("eph").ephemeral).toBe(true);
    expect(expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "eph", hands: true, by: "spawner", overrides: { ephemeral: false } as never }).ok).toBe(false);
    expect(spawned("worker", { ephemeral: true }).ephemeral).toBe(true);
    expect(spawned("worker")).not.toHaveProperty("ephemeral");
    expect(spawned("eph", { sandbox_idle_ttl_ms: 60_000 }).sandbox_idle_ttl_ms).toBe(60_000);
    expect(spawned("eph", { sandbox_idle_ttl_ms: DAY }).sandbox_idle_ttl_ms).toBe(3_600_000);
    // No TTL in the template: the cell default bounds the spawn's; the template's own (the operator's) may be longer.
    expect(spawned("worker", { sandbox_idle_ttl_ms: 365 * DAY }).sandbox_idle_ttl_ms).toBe(30 * DAY);
    expect(spawned("worker")).not.toHaveProperty("sandbox_idle_ttl_ms");
    expect(spawned("long").sandbox_idle_ttl_ms).toBe(90 * DAY);
    // Sharing the spawner's sandbox only from a template that allows it.
    expect(spawned("long", {}, true).template).toBe("long");
    expect(expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "worker", hands: true, by: "spawner", share: true })).toEqual({
      ok: false, error: "template worker doesn't share its spawner's sandbox",
    });
    // The operator replaces it either way.
    const op = expandSpec(cat, PLATFORM_TOOL_NAMES, { template: "eph", hands: true, by: "operator", overrides: { ephemeral: false } });
    expect(op.ok && op.value).not.toHaveProperty("ephemeral");
  });
});

// --- agent_spawn ---------------------------------------------------------------------------------------

describe("agent_spawn", () => {
  it("the child is the caller's (owner, depth, taint), takes the task as its first turn and owns a new sandbox; a re-run of the call makes nothing twice", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    // A tainted spawner's child starts tainted.
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).kvPut("read_tainted", true));
    const id = p.call("agent_spawn", { template: w.kid, task: "build the parser; done when its tests pass", sandbox: "new", ephemeral: true });
    const out = (await p.ws.next("tool_result", (m) => m.call === id, 8000)).outcome;
    expect(out.status, JSON.stringify(out)).toBe("ok");
    const v = out.content.find((c: any) => c.type === "json").value;
    expect(v).toMatchObject({ template: w.kid, ephemeral: true });
    const child = await agentStub(v.agent).info();
    expect(child).toMatchObject({ owner: p.agent, depth: 1, ephemeral: true, hands: { sandbox: v.sandbox }, workstream: w.workstream, cell: w.cell });
    expect(await runInDurableObject(agentStub(v.agent), (inst: AgentDO) => (inst as any).tainted((inst as any).load()))).toBe(true);
    const sbx = await sandboxStub(v.sandbox).info();
    expect(sbx).toMatchObject({ owner: v.agent, attached: [v.agent], cell: w.cell });
    const turns = await agentStub(v.agent).turns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.input.text).toContain("build the parser; done when its tests pass");
    expect(await agentStub(p.agent).children()).toEqual([{ agent: v.agent, ended: false }]);

    // The same call redelivered to a fresh run (its first outcome lost): the same child, sandbox and turn.
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).dispatch(p.epoch, id, "agent_spawn",
      { template: w.kid, task: "build the parser; done when its tests pass", sandbox: "new", ephemeral: true }));
    expect(await agentStub(v.agent).turns()).toHaveLength(1);
    expect(await agentStub(p.agent).children()).toHaveLength(1);
  });

  it("refuses a template its capabilities don't name, a share it has no sandbox for, overrides that widen, and spawns past the caps", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    expect(await p.run("agent_spawn", { template: "worker", task: "x" })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await p.run("agent_spawn", { template: w.kid, task: "x", sandbox: "share" })).toMatchObject({ status: "error", error: { code: "invalid_message" } });
    expect(await p.run("agent_spawn", { template: w.kid, task: "x", tools: ["notify", "merge"] })).toMatchObject({ status: "error" });
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).update((i: any) => { i.depth = MAX_SPAWN_DEPTH; }));
    expect((await p.run("agent_spawn", { template: w.kid, task: "x" })).error.message).toContain("depth");
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO, st) => {
      (inst as any).update((i: any) => { delete i.depth; });
      for (let n = 0; n < MAX_LIVE_CHILDREN; n++) st.storage.sql.exec("INSERT INTO children (agent, created_ms) VALUES (?, ?)", `agt_planted${n}`, Date.now());
    });
    expect((await p.run("agent_spawn", { template: w.kid, task: "x" })).error.message).toContain("haven't ended");
    // From inside a sandbox, never.
    const outcome = await runInDurableObject(agentStub(p.agent), (inst: AgentDO) =>
      (inst as any).dispatch(p.epoch, "cal_guest", "exit", {}, 1).catch((e: any) => e.code));
    expect(outcome).toBe("forbidden");
  });

  it("a spawn whose caller stopped being current before its first write makes nothing and indexes nothing", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        (inst as any).update((i: any) => {
          i.agent_epoch += 1;
          i.brain.epoch = i.agent_epoch;
        });
      };
    });
    const id = p.call("agent_spawn", { template: w.kid, task: "x", sandbox: "new" });
    const outcome = await until(() => runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).calls.call(id)?.outcome), "the call's outcome");
    expect(outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    expect(await agentStub(p.agent).children()).toEqual([]);
  });

  it("a spawner that ends while its child is being made ends the child too, before it gets its task", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        // Its end lands between the fence and the child's creation (its brain left to finish, so the fence passes).
        (inst as any).update((i: any) => { i.ended = { ms: Date.now(), by: "user", reason: "stopped", kill: false, destroy_sandbox: false }; });
      };
    });
    const out = await p.run("agent_spawn", { template: w.kid, task: "never seen" });
    expect(out).toMatchObject({ status: "error", error: { code: "forbidden" } });
    const [row] = await agentStub(p.agent).children();
    expect(row).toBeDefined();
    await until(async () => (await ended(row!.agent))?.reason === "owner_ended", "the child ended");
    expect(await agentStub(row!.agent).turns()).toEqual([]);
  });
});

// --- agent_stop ------------------------------------------------------------------------------------------

describe("agent_stop", () => {
  it("only an owner may stop an agent, directly or through the agents it owns; nobody else, and not upward", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const q = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    const cs = await session(w, c.agent);
    const g = await spawn(cs, { template: w.kid });
    expect((await agentStub(g.agent).info())).toMatchObject({ owner: c.agent, depth: 2 });
    // Another agent's, and upward: refused, and nothing ends.
    expect(await q.run("agent_stop", { agent: c.agent })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await cs.run("agent_stop", { agent: p.agent })).toMatchObject({ status: "error", error: { code: "forbidden" } });
    expect(await ended(c.agent)).toBeUndefined();
    expect(await ended(p.agent)).toBeUndefined();
    // Through the agent it owns: the grandchild.
    expect(await p.run("agent_stop", { agent: g.agent })).toMatchObject({ status: "ok" });
    expect(await ended(g.agent)).toMatchObject({ by: p.agent, reason: "stopped", kill: true });
    expect(await ended(c.agent)).toBeUndefined();
    // An id naming nobody.
    expect(await p.run("agent_stop", { agent: "agt_nobody0000" })).toMatchObject({ status: "error", error: { code: "unknown_agent" } });
  });

  it("a stop from a stale epoch is refused: nothing ends", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    await runInDurableObject(agentStub(p.agent), (inst: AgentDO) => {
      inst.testHooks["dispatch:beforeWrite"] = async () => {
        delete inst.testHooks["dispatch:beforeWrite"];
        // A newer start superseded the brain that made the call while it was being checked.
        (inst as any).update((i: any) => {
          i.agent_epoch += 1;
          i.brain.epoch = i.agent_epoch;
        });
      };
    });
    const id = p.call("agent_stop", { agent: c.agent });
    await p.ws.next("ack", (m) => m.up_to >= 1, 5000).catch(() => undefined);
    const outcome = await until(() => runInDurableObject(agentStub(p.agent), (inst: AgentDO) => (inst as any).calls.call(id)?.outcome), "the call's outcome");
    expect(outcome).toMatchObject({ status: "error", error: { code: "stale_epoch" } });
    expect(await ended(c.agent)).toBeUndefined();
  });

  it("ends the target for good: its brain killed, its queued turns dropped, no more turns, messages or deliveries; idempotent", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    const cs = await session(w, c.agent);
    const running = (await cs.ws.next("run_turn")).turn as string;
    await adminJson(`/v1/agents/${c.agent}/turns`, { body: { text: "next" } }, 201);
    expect(await p.run("agent_stop", { agent: c.agent, reason: "not needed" })).toMatchObject({ status: "ok" });
    // The kill goes out for its brain at its epoch (the condemn path), and its session is fenced.
    const [kill] = (await nextCommands(w.brain.ws, isStop(c.agent, "kill"))).filter(isStop(c.agent, "kill"));
    expect(kill).toMatchObject({ epoch: cs.epoch });
    expect((await agentStub(c.agent).info()).brain).toMatchObject({ phase: "condemned" });
    const statuses = async () => Object.fromEntries((await agentStub(c.agent).turns()).map((t) => [t.input.text, t.status]));
    expect(Object.values(await statuses())).toEqual(["active", "dropped"]);
    // Nothing more comes in: as a recipient it is gone (what every sender reads as "drop it"), though its record stays.
    expect((await adminJson(`/v1/agents/${c.agent}/turns`, { body: { text: "more" } }, 404)).error.message).toContain("has ended");
    expect((await adminJson(`/v1/agents/${c.agent}/inbox`, { body: { text: "hi", from: "user" } }, 404)).error.code).toBe("unknown_agent");
    await expect(Promise.resolve().then(async () => { await agentStub(c.agent).deliverChannel({ channel: "x", subscription: "sub_x", batch: {} } as never); }))
      .rejects.toThrow("has ended");
    await expect(Promise.resolve().then(async () => { await agentStub(c.agent).start(); })).rejects.toThrow("has ended");
    // Again: already ended, nothing new.
    expect((await p.run("agent_stop", { agent: c.agent })).content[0].text).toContain("had already ended");
    // Its exit releases it; the turn it was in goes too, and nothing restarts it.
    await exited(w, cs);
    await until(async () => (await agentStub(c.agent).info()).brain === null, "the release");
    expect((await agentStub(c.agent).turns()).find((t) => t.turn === running)?.status).toBe("dropped");
    expect((await agentStub(c.agent).info())).toMatchObject({ intent: null, current_turn: null });
    expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some((x) => x.type === "agent_start" && x.agent === c.agent))).toBe(true);
    // Its owner is told once the end is done.
    await until(async () => (await agentStub(p.agent).children()).every((x) => x.ended), "the owner told");
  });

  it("ending cascades: the agents it owns end, and theirs, each killed", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    const cs = await session(w, c.agent);
    const g = await spawn(cs, { template: w.kid });
    // The operator ends the root for good.
    expect(await adminJson(`/v1/agents/${p.agent}/stop`, { body: { end: true } })).toMatchObject({ status: "stopped", ended: { by: "user" } });
    await until(async () => !!(await ended(c.agent)) && !!(await ended(g.agent)), "the cascade");
    expect(await ended(c.agent)).toMatchObject({ by: p.agent, reason: "owner_ended", kill: true });
    expect(await ended(g.agent)).toMatchObject({ by: c.agent, reason: "owner_ended" });
    // The operator's plain stop is unchanged: no end.
    const o = await operatorAgent(w, w.par);
    await adminJson(`/v1/agents/${o.agent}/stop`, { method: "POST" });
    expect(await ended(o.agent)).toBeUndefined();
  });

  it("destroy_sandbox destroys the sandbox made for it only when no other agent is attached; the GC registry drops it", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const registered = (sbx: string) => runInDurableObject(fleetStub(w.cell), (_i: FleetDO, st) =>
      st.storage.sql.exec<{ destroyed_ms: number | null }>("SELECT destroyed_ms FROM sandboxes WHERE sandbox = ?", sbx).one());
    // GC's roots come from the registry's live rows (`gcStatus().sandboxes` counts them).
    const live = () => runInDurableObject(fleetStub(w.cell), async (inst: FleetDO) => (await inst.gcStatus()).sandboxes);
    // Shared with an operator's agent: detached, kept.
    const c1 = await spawn(p, { template: w.kid, sandbox: "new" });
    const c1s = await session(w, c1.agent);
    const other = await adminJson("/v1/agents", { body: { template: w.kid, sandbox: c1.sandbox, start: false } }, 201);
    await p.run("agent_stop", { agent: c1.agent, destroy_sandbox: true });
    await exited(w, c1s);
    await until(async () => (await ended(c1.agent))?.sandbox, "c1's sandbox step");
    expect(await ended(c1.agent)).toMatchObject({ sandbox: "detached" });
    expect(await sandboxStub(c1.sandbox!).info()).toMatchObject({ attached: [other.agent] });
    expect((await sandboxStub(c1.sandbox!).info()).state).not.toBe("destroyed");
    // Alone in it: destroyed, through SandboxDO's destroy (FleetDO's registry marks it, so its roots drop).
    const before = (await live());
    const c2 = await spawn(p, { template: w.kid, sandbox: "new" });
    const c2s = await session(w, c2.agent);
    expect((await live())).toBe(before + 1);
    await p.run("agent_stop", { agent: c2.agent, destroy_sandbox: true });
    // Not before its brain is gone.
    expect((await sandboxStub(c2.sandbox!).info()).state).not.toBe("destroyed");
    await exited(w, c2s);
    // AgentDO records the step once SandboxDO's release returns, so wait on that later write.
    await until(async () => (await ended(c2.agent))?.sandbox, "c2's sandbox step");
    expect(await ended(c2.agent)).toMatchObject({ sandbox: "destroyed" });
    expect((await sandboxStub(c2.sandbox!).info()).state).toBe("destroyed");
    expect((await registered(c2.sandbox!)).destroyed_ms).toBeGreaterThan(0);
    expect((await live())).toBe(before);
    expect(await sandboxStub(c2.sandbox!).gcRoots()).toEqual([]);
    // A sandbox it didn't make (the operator's) is never destroyed by its end.
    const shared = await adminJson("/v1/sandboxes", { body: { workstream: w.workstream, cell: w.cell } }, 201);
    const o = await operatorAgent(w, w.kid, shared.sandbox);
    await adminJson(`/v1/agents/${o.agent}/stop`, { body: { end: true, destroy_sandbox: true } });
    await exited(w, o);
    await until(async () => (await ended(o.agent))?.sandbox, "o's sandbox step");
    expect(await ended(o.agent)).toMatchObject({ sandbox: "detached" });
    expect((await sandboxStub(shared.sandbox).info()).state).not.toBe("destroyed");
  });
});

describe("ends that wait for what they own", () => {
  it("an end with destroy_sandbox waits for the agents it owns that share its sandbox to finish ending, then destroys it", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid, sandbox: "new" });
    const cs = await session(w, c.agent);
    const g = await spawn(cs, { template: w.kid, sandbox: "share" });
    const gs = await session(w, g.agent);
    expect((await sandboxStub(c.sandbox!).info()).attached.sort()).toEqual([c.agent, g.agent].sort());
    await p.run("agent_stop", { agent: c.agent, destroy_sandbox: true });
    await until(async () => !!(await ended(g.agent)), "the cascade");
    await exited(w, cs);
    // C's brain is gone, but G (in its sandbox) hasn't finished ending: nothing is decided about the sandbox yet.
    await sleep(300);
    expect((await ended(c.agent))?.sandbox).toBeUndefined();
    expect((await sandboxStub(c.sandbox!).info()).state).not.toBe("destroyed");
    await exited(w, gs);
    await until(async () => (await ended(c.agent))?.sandbox, "C's sandbox step");
    expect(await ended(c.agent)).toMatchObject({ sandbox: "destroyed" });
    expect((await sandboxStub(c.sandbox!).info()).state).toBe("destroyed");
    expect(await ended(g.agent)).toMatchObject({ sandbox: "detached" });
  });

  it("an ephemeral agent that spawned doesn't end while its child lives", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid, ephemeral: true });
    const cs = await session(w, c.agent);
    const first = (await cs.ws.next("run_turn")).turn as string;
    const g = await spawn(cs, { template: w.kid });
    await cs.events([{ type: "turn_completed", turn: first, stop_reason: "end_turn" }]);
    expect(await ended(c.agent)).toBeUndefined();
    expect(await ended(g.agent)).toBeUndefined();
  });

  it("an end whose deadline a rolled-back release dropped is picked up again by the next alarm", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    await adminJson(`/v1/agents/${p.agent}/stop`, { body: { end: true } });
    // The brain hasn't exited, so the end isn't done; the previous release dropped its `end` key.
    await runInDurableObject(agentStub(p.agent), (_i: AgentDO, st) => {
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'end'");
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(agentStub(p.agent));
    // Armed again, before anything else (here, its brain's exit) would.
    expect(await runInDurableObject(agentStub(p.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'end'").toArray().length)).toBe(1);
    await exited(w, p);
    await until(async () => (await ended(p.agent))?.done_ms, "the end done");
  });
});

// --- exit and ephemeral agents ----------------------------------------------------------------------------

describe("exit and ephemeral agents", () => {
  it("exit: the turn in progress finishes first, then a graceful stop; never gated", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    const cs = await session(w, c.agent);
    const turn = (await cs.ws.next("run_turn")).turn as string;
    // `exit` isn't in its spec's tools, and needs no grant.
    expect((await agentStub(c.agent).info()).tools).not.toContain("exit");
    expect(await cs.run("exit", { reason: "done" })).toMatchObject({ status: "ok" });
    expect(await ended(c.agent)).toMatchObject({ by: c.agent, reason: "exited", kill: false, note: "done" });
    expect(await w.brain.ws.none("commands", 300, (m) => (m.commands as any[]).some(isStop(c.agent, "graceful")))).toBe(true);
    await cs.events([{ type: "turn_completed", turn, stop_reason: "end_turn" }]);
    const [stop] = (await nextCommands(w.brain.ws, isStop(c.agent, "graceful"))).filter(isStop(c.agent, "graceful"));
    expect(stop).toMatchObject({ epoch: cs.epoch });
    expect((await agentStub(c.agent).turns()).find((t) => t.turn === turn)?.status).toBe("done");
  });

  it("an ephemeral agent ends itself when a turn completes with nothing waiting, and not before; its sandbox goes with it", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid, sandbox: "new", ephemeral: true });
    const cs = await session(w, c.agent);
    const first = (await cs.ws.next("run_turn")).turn as string;
    await adminJson(`/v1/agents/${c.agent}/turns`, { body: { text: "and then this" } }, 201);
    await cs.events([{ type: "turn_completed", turn: first, stop_reason: "end_turn" }]);
    // A turn was waiting: it runs, and the agent lives on.
    const second = (await cs.ws.next("run_turn")).turn as string;
    expect(await ended(c.agent)).toBeUndefined();
    await cs.events([{ type: "turn_completed", turn: second, stop_reason: "end_turn" }]);
    expect(await ended(c.agent)).toMatchObject({ by: c.agent, reason: "done", kill: false, destroy_sandbox: true });
    await nextCommands(w.brain.ws, isStop(c.agent, "graceful"));
    await exited(w, cs);
    await until(async () => (await sandboxStub(c.sandbox!).info()).state === "destroyed", "its sandbox destroyed");
  });
});

// --- Sandbox idle TTL ----------------------------------------------------------------------------------------

describe("a dormant sandbox's idle TTL", () => {
  /** An operator's sandbox, placed, then reported suspended by its host (dormant: no agent attached). */
  async function suspended(idleTtlMs?: number) {
    const cell = uniqueCell();
    const host = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "ttl" } }, 201);
    const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell, ...(idleTtlMs ? { idle_ttl_ms: idleTtlMs } : {}) } }, 201);
    await nextCommands(host.ws, (c) => c.type === "sandbox_create");
    expect((await sandboxStub(sbx.sandbox).info()).dormant_since_ms).toBeUndefined();
    const seq = sendEvents(host.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: sbx.sandbox, epoch: 1, state: "suspended" }]);
    await host.ws.next("ack", (m) => m.up_to >= seq);
    await until(async () => (await sandboxStub(sbx.sandbox).info()).dormant_since_ms, "dormancy recorded");
    return { cell, host, workstream: workstream as string, sandbox: sbx.sandbox as string };
  }
  /** Move the sandbox's dormancy (and notice) back in time, then run its expiry check now. */
  async function age(sandbox: string, edit: (i: any) => void) {
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      edit(info);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('expiry', 0)");
    });
    await runDue(sandboxStub(sandbox));
  }
  /** The `user` channel's expiry notices for `sandbox` (the channel is every test's: paged from the start). */
  const userNotices = async (sandbox: string) => {
    const found: any[] = [];
    for (let since = 0, more = true; more;) {
      const page = await adminJson(`/v1/admin/channels/user/messages?since=${since}&limit=500`);
      found.push(...(page.messages as any[]).filter((m) => m.kind === "sandbox_expiring" && m.data?.sandbox === sandbox));
      more = page.more;
      since = page.next_seq;
    }
    return found.length ? found : null;
  };

  it("a short TTL: destroyed once dormant that long, through destroy (the GC registry drops it); not a moment before", async () => {
    const s = await suspended(10 * 60_000);
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 9 * 60_000; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("suspended");
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 10 * 60_000 - 1; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("destroyed");
    const row = await runInDurableObject(fleetStub(s.cell), (_i: FleetDO, st) =>
      st.storage.sql.exec<{ destroyed_ms: number | null }>("SELECT destroyed_ms FROM sandboxes WHERE sandbox = ?", s.sandbox).one());
    expect(row.destroyed_ms).toBeGreaterThan(0);
    expect(await userNotices(s.sandbox)).toBeNull();
  });

  it("the cell default (a day): no notice, destroyed a day after it became dormant", async () => {
    const s = await suspended();
    expect((await sandboxStub(s.sandbox).info()).idle_ttl_ms).toBeUndefined();
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - DAY + 60_000; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("suspended");
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - DAY - 1; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("destroyed");
    expect(await userNotices(s.sandbox)).toBeNull();
  });

  it("a TTL over a day (30 days): a notice on `user` a day before, then destroyed no sooner than a day after it", async () => {
    const s = await suspended(30 * DAY);
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 29 * DAY + 60_000; });
    expect(await userNotices(s.sandbox)).toBeNull();
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 29 * DAY - 60_000; });
    const [notice] = (await until(() => userNotices(s.sandbox), "the notice"))!;
    expect(notice.text).toContain(`Sandbox ${s.sandbox}`);
    expect(notice.data).toMatchObject({ idle_ttl_ms: 30 * DAY });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("suspended");
    // Past the TTL but within a day of the notice: kept.
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 31 * DAY; i.expiry_notice_ms = Date.now() - DAY + 60_000; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("suspended");
    await age(s.sandbox, (i) => { i.expiry_notice_ms = Date.now() - DAY - 1; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("destroyed");
    expect(await userNotices(s.sandbox)).toHaveLength(1);
  });

  it("an attach ends dormancy at once (the clock starts again), and an operator's longer TTL keeps it", async () => {
    const s = await suspended(10 * 60_000);
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 9 * 60_000; });
    await sandboxStub(s.sandbox).attach("agt_attachedone");
    expect((await sandboxStub(s.sandbox).info()).dormant_since_ms).toBeUndefined();
    await sandboxStub(s.sandbox).detach("agt_attachedone");
    const since = (await sandboxStub(s.sandbox).info()).dormant_since_ms!;
    expect(since).toBeGreaterThan(Date.now() - 5000);
    await adminJson(`/v1/sandboxes/${s.sandbox}/lifetime`, { method: "PUT", body: { idle_ttl_ms: 365 * DAY } });
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 31 * DAY; });
    expect((await sandboxStub(s.sandbox).info()).state).toBe("suspended");
  });

  it("after missed checks (a rolled-back release ran meanwhile) the clock starts again: a stale dormancy never destroys", async () => {
    const s = await suspended(10 * 60_000);
    await age(s.sandbox, (i) => { i.dormant_since_ms = Date.now() - 31 * DAY; i.expiry_checked_ms = Date.now() - 7 * 3_600_000; });
    const info = await sandboxStub(s.sandbox).info();
    expect(info.state).toBe("suspended");
    expect(info.dormant_since_ms).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a sandbox from before lifetimes gets its check armed by FleetDO's daily backfill", async () => {
    const s = await suspended();
    const armed = () => runInDurableObject(sandboxStub(s.sandbox), (_i: SandboxDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'expiry'").toArray().length > 0);
    // As the previous release left it: no check armed, no dormancy recorded, and FleetDO's row never confirmed.
    await runInDurableObject(sandboxStub(s.sandbox), (_i: SandboxDO, st) => {
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'expiry'");
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      delete info.dormant_since_ms;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    expect(await armed()).toBe(false);
    await runInDurableObject(fleetStub(s.cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE sandboxes SET lifetime_ms = NULL");
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(fleetStub(s.cell));
    expect(await armed()).toBe(true);
    const row = await runInDurableObject(fleetStub(s.cell), (_i: FleetDO, st) =>
      st.storage.sql.exec<{ lifetime_ms: number | null }>("SELECT lifetime_ms FROM sandboxes WHERE sandbox = ?", s.sandbox).one());
    expect(row.lifetime_ms).toBeGreaterThan(0);
    // Its first check starts its clock, durably (a later check counts from it, not from itself).
    await runDue(sandboxStub(s.sandbox));
    const since = await until(async () => (await sandboxStub(s.sandbox).info()).dormant_since_ms, "its clock started");
    await runInDurableObject(sandboxStub(s.sandbox), (_i: SandboxDO, st) => { st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'expiry'"); });
    await runDue(sandboxStub(s.sandbox));
    expect((await sandboxStub(s.sandbox).info()).dormant_since_ms).toBe(since);
  });
});

// --- Records -------------------------------------------------------------------------------------------------

describe("an ended agent's records", () => {
  it("are pruned after the retention, its R2 session segments first; then it is unknown", async () => {
    const w = await world();
    const p = await operatorAgent(w, w.par);
    const c = await spawn(p, { template: w.kid });
    const cs = await session(w, c.agent);
    await env.BUCKET.put(`sessions/${c.agent}/b0/0`, "segment");
    await adminJson(`/v1/agents/${c.agent}/stop`, { body: { end: true } });
    await exited(w, cs);
    await until(async () => (await ended(c.agent))?.done_ms, "the end done");
    // Not before the retention.
    await runInDurableObject(agentStub(c.agent), (_i: AgentDO, st) => { st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'reap'"); });
    await runDue(agentStub(c.agent));
    expect(await env.BUCKET.get(`sessions/${c.agent}/b0/0`)).not.toBeNull();
    await runInDurableObject(agentStub(c.agent), (inst: AgentDO, st) => {
      (inst as any).update((i: any) => { i.ended.ms = Date.now() - AGENT_RECORD_RETENTION_MS - 1; });
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'reap'");
    });
    await runDue(agentStub(c.agent));
    expect(await env.BUCKET.get(`sessions/${c.agent}/b0/0`)).toBeNull();
    await expect(Promise.resolve().then(() => agentStub(c.agent).info())).rejects.toThrow("unknown agent");
    // Its owner's stop now finds nobody (and its index row says it ended).
    expect(await agentStub(p.agent).children()).toEqual([{ agent: c.agent, ended: true }]);
  });
});
