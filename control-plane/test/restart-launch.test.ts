// An owner restarts its agent's brain on another model or effort (`POST /v1/agents/<id>/start {restart:
// true, launch}`; docs/control-plane/api/#restarting-on-another-model): the launch is checked as a spawn's
// is, stored with the restart's intent in one step, and the next brain resumes the same session with it.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AgentDO } from "../src/do/agent";
import { changedLaunch } from "../src/lib/spec";
import { bytesToB64 } from "../src/lib/util";
import { admin, adminJson, BASE, connectHost, nextCommands, received, runDue, sendEvents, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const isStartOf = (agent: string) => (c: any) => c.type === "agent_start" && c.agent === agent;
const isKillOf = (agent: string) => (c: any) => c.type === "agent_stop" && c.agent === agent && c.mode === "kill";
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const seg = (offset: number, text: string) => ({ type: "segment", session: SESSION, offset, base: false, data_b64: bytesToB64(new TextEncoder().encode(text)) });

async function setup() {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-restart" } });
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", sandbox: sbx.sandbox, cell } }, 201);
  const [start] = await nextCommands(host.ws, isStartOf(worker.agent));
  return { cell, host, agent: worker.agent as string, start };
}

async function runner(agent: string, host: string, token: string, epoch: number) {
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, token);
  ws.send({ type: "hello", protocol_version: 1, agent, host, instance_id: `rin_${epoch}`, epoch, session: SESSION });
  await ws.next("hello_ack");
  return ws;
}

const restart = (agent: string, body: unknown) => admin(`/v1/agents/${agent}/start`, { method: "POST", body });
const stored = async (agent: string) => {
  const l = ((await agentStub(agent).info()) as unknown as { launch: { model?: string; effort?: string } }).launch;
  return { model: l.model ?? null, effort: l.effort ?? null };
};
/** Nothing was asked of the brain host: no kill, no start. */
const quiet = (s: Awaited<ReturnType<typeof setup>>) =>
  s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some((c) => isStartOf(s.agent)(c) || isKillOf(s.agent)(c)));

describe("a launch change (pure)", () => {
  it("a value given replaces, null clears, one left out stays; nothing else changes", () => {
    const cur = { model: "opus", effort: "high", builtin_tools: ["Bash"], system_prompt: { mode: "append" as const, text: "x" } };
    expect(changedLaunch(cur, {})).toEqual(cur);
    expect(changedLaunch(cur, { model: "sonnet" })).toEqual({ ...cur, model: "sonnet" });
    expect(changedLaunch(cur, { effort: null })).toEqual({ model: "opus", builtin_tools: ["Bash"], system_prompt: cur.system_prompt });
    expect(changedLaunch(cur, { model: null, effort: "low" })).toEqual({ effort: "low", builtin_tools: ["Bash"], system_prompt: cur.system_prompt });
    // The stored launch itself is never written in place.
    expect(cur.model).toBe("opus");
  });
});

describe("restarting on another model", () => {
  it("mid-turn: the brain is killed, the next one starts on the new launch, resuming the same session, and redoes the cut turn", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, 1);
    const turn = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "the work in progress" } }, 201)).turn;
    await r1.next("run_turn", (m) => m.turn === turn);
    r1.send(seg(0, "l1\nl2\n"));
    await received(s.agent, 6);
    const res = await restart(s.agent, { restart: true, launch: { model: "claude-opus-5-5", effort: "high" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "waiting", waiting_for: s.host.host, launch: { model: "claude-opus-5-5", effort: "high" } });
    expect(await stored(s.agent)).toEqual({ model: "claude-opus-5-5", effort: "high" });
    // The restart is the existing one: the live brain is killed, in the middle of its turn.
    const [kill] = await nextCommands(s.host.ws, isKillOf(s.agent));
    expect(kill).toMatchObject({ epoch: 1 });
    r1.close();
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    const start = (await nextCommands(s.host.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start).toMatchObject({ epoch: 2, launch: { model: "claude-opus-5-5", effort: "high" }, resume: { session: SESSION, total_bytes: 6 } });
    // Its tools and prompt are the agent's, as before.
    expect(start.launch.builtin_tools).toEqual(s.start.launch.builtin_tools);
    // The new brain redoes the turn it cut, from its text.
    const r2 = await runner(s.agent, s.host.host, s.host.host_token, 2);
    const redo = await r2.next("run_turn");
    expect(JSON.stringify(redo)).toContain("the work in progress");
    r2.close();
  });

  it("is refused without restart: true, with nothing stored and nothing asked of the brain", async () => {
    const s = await setup();
    for (const body of [{ launch: { model: "sonnet" } }, { restart: false, launch: { model: "sonnet" } }]) {
      const res = await restart(s.agent, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("restart: true");
    }
    expect(await stored(s.agent)).toEqual({ model: null, effort: null });
    expect(await quiet(s)).toBe(true);
  });

  it("is checked as a spawn's launch is: an option, a space or an unknown field is refused, nothing stored", async () => {
    const s = await setup();
    const bad: unknown[] = [
      { restart: true, launch: { model: "--dangerously-skip-permissions" } },
      { restart: true, launch: { effort: "high low" } },
      { restart: true, launch: { model: "" } },
      { restart: true, launch: { builtin_tools: ["Bash"] } },
      { restart: true, launch: { model: "sonnet" }, extra: 1 },
    ];
    for (const body of bad) expect((await restart(s.agent, body)).status, JSON.stringify(body)).toBe(400);
    expect(await stored(s.agent)).toEqual({ model: null, effort: null });
    expect(await quiet(s)).toBe(true);
  });

  it("the launch is checked whole: a change that leaves a stored value no brain can start with is refused, the brain left running", async () => {
    const s = await setup();
    await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      info.launch.effort = "-x"; // as a release before the rule could have stored it
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
    });
    const res = await restart(s.agent, { restart: true, launch: { model: "sonnet" } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("launch.effort");
    expect(await stored(s.agent)).toEqual({ model: null, effort: "-x" });
    const info = (await agentStub(s.agent).info()) as unknown as { intent: unknown; brain: { phase: string } };
    expect(info.intent ?? null).toBeNull();
    expect(info.brain.phase).not.toBe("condemned");
    expect(await quiet(s)).toBe(true);
    // Fixing the stored value in the same change is taken.
    expect((await restart(s.agent, { restart: true, launch: { model: "sonnet", effort: null } })).status).toBe(200);
    expect(await stored(s.agent)).toEqual({ model: "sonnet", effort: null });
  });

  it("several changes end on the last stored: the brain that starts has it, an effort cleared included", async () => {
    const s = await setup();
    expect((await restart(s.agent, { restart: true, launch: { model: "opus", effort: "high" } })).status).toBe(200);
    await nextCommands(s.host.ws, isKillOf(s.agent));
    // A second while the first waits for the condemned brain's exit.
    const again = await restart(s.agent, { restart: true, launch: { model: "sonnet", effort: null } });
    expect(await again.json()).toMatchObject({ kind: "waiting", launch: { model: "sonnet", effort: null } });
    const seq = sendEvents(s.host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent: s.agent, reason: "stopped", epoch: 1 }]);
    await s.host.ws.next("ack", (m) => m.up_to >= seq);
    const start = (await nextCommands(s.host.ws, isStartOf(s.agent))).find(isStartOf(s.agent));
    expect(start.epoch).toBe(2);
    expect(start.launch.model).toBe("sonnet");
    expect(start.launch).not.toHaveProperty("effort");
    // One restart for both: the next is only after a change asked for afterwards.
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
  });

  it("an agent that has ended is refused, as any start is, with nothing stored", async () => {
    const s = await setup();
    await adminJson(`/v1/agents/${s.agent}/stop`, { body: { end: true } });
    const res = await restart(s.agent, { restart: true, launch: { model: "sonnet" } });
    expect(res.status).toBe(409);
    expect(await stored(s.agent)).toEqual({ model: null, effort: null });
  });
});

describe("only the agent's owner", () => {
  async function asClient(token: string, path: string, body: unknown) {
    const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  }
  async function client(cell: string) {
    const name = `rl-${rand()}`;
    const c = await adminJson("/v1/admin/clients", { body: { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 5, max_sandboxes: 5 } } }, 201);
    const tpl = { capabilities: ["nest"], launch: { model: "opus", builtin_tools: [], system_prompt: { mode: "append", text: "" } }, hands: "forbidden", credential: "claude_oauth_token" };
    expect((await SELF.fetch(`${BASE}/v1/catalog/templates/${name}/t`, { method: "PUT", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" }, body: JSON.stringify(tpl) })).status).toBe(200);
    return { name, token: c.token as string };
  }

  it("a client restarts its own agent on another model; another client can't touch it", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-restart" } });
    const host = await connectHost(cell, "brain");
    const owner = await client(cell);
    const other = await client(cell);
    const made = await asClient(owner.token, "/v1/agents", { template: `${owner.name}/t`, cell });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const agent = made.body.agent as string;
    expect((await nextCommands(host.ws, isStartOf(agent))).find(isStartOf(agent)).launch.model).toBe("opus");
    const refused = await asClient(other.token, `/v1/agents/${agent}/start`, { restart: true, launch: { model: "sonnet" } });
    expect([403, 404]).toContain(refused.status);
    expect(await stored(agent)).toEqual({ model: "opus", effort: null });
    const ok = await asClient(owner.token, `/v1/agents/${agent}/start`, { restart: true, launch: { model: "sonnet" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.launch).toEqual({ model: "sonnet", effort: null });
    await nextCommands(host.ws, isKillOf(agent));
    const seq = sendEvents(host.ws, [{ ts_ms: Date.now(), type: "agent_exited", agent, reason: "stopped", epoch: 1 }]);
    await host.ws.next("ack", (m) => m.up_to >= seq);
    const deadline = async () => {
      await runInDurableObject(agentStub(agent), (_i: AgentDO, st) => st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'intent'"));
      await runDue(agentStub(agent));
    };
    await deadline();
    expect((await nextCommands(host.ws, isStartOf(agent))).find(isStartOf(agent)).launch.model).toBe("sonnet");
  });
});

describe("restarting only between turns (when: idle)", () => {
  const busy = async (res: Response) => {
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error).toMatchObject({ code: "busy", retryable: true });
    return body.error.message;
  };

  it("is refused while a turn runs, naming it, with nothing stored and the brain left running", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, 1);
    const turn = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "working" } }, 201)).turn;
    await r1.next("run_turn", (m) => m.turn === turn);
    expect(await busy(await restart(s.agent, { restart: true, when: "idle", launch: { model: "sonnet" } }))).toContain(turn);
    expect(await stored(s.agent)).toEqual({ model: null, effort: null });
    const info = (await agentStub(s.agent).info()) as unknown as { intent: unknown; brain: { phase: string } };
    expect(info.intent ?? null).toBeNull();
    expect(info.brain.phase).not.toBe("condemned");
    expect(await quiet(s)).toBe(true);
    r1.close();
  });

  it("is refused while a turn is queued to start", async () => {
    const s = await setup();
    // No runner yet: the turn waits for the brain's session.
    const turn = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "next" } }, 201)).turn;
    expect(await busy(await restart(s.agent, { restart: true, when: "idle" }))).toContain(turn);
    expect(await quiet(s)).toBe(true);
  });

  it("a turn admitted while the restart awaits (before its step) is seen there: refused, nothing stored", async () => {
    const s = await setup();
    await runner(s.agent, s.host.host, s.host.host_token, 1);
    // The operator's host hint awaits FleetDO before the restart's step; a turn arrives meanwhile.
    let turn = "";
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      const self = inst as unknown as { requireBrainHost: (cell: string, host: string) => Promise<void> };
      const real = self.requireBrainHost.bind(inst);
      self.requireBrainHost = async (cell: string, host: string) => {
        await real(cell, host);
        turn = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "just in time" } }, 201)).turn;
      };
    });
    expect(await busy(await restart(s.agent, { restart: true, when: "idle", host: s.host.host, launch: { model: "sonnet" } }))).toContain(turn);
    expect(await stored(s.agent)).toEqual({ model: null, effort: null });
    expect(await s.host.ws.none("commands", 150, (m) => (m.commands as any[]).some(isKillOf(s.agent)))).toBe(true);
  });

  it("idle: the restart goes ahead, on the new launch", async () => {
    const s = await setup();
    const r1 = await runner(s.agent, s.host.host, s.host.host_token, 1);
    const turn = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "done soon" } }, 201)).turn;
    await r1.next("run_turn", (m) => m.turn === turn);
    r1.send({ type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: 1, turn, type: "turn_started", input_kind: "user" },
      { agent: s.agent, epoch: 1, seq: 2, ts_ms: 2, turn, type: "turn_completed", stop_reason: "end_turn" },
    ] });
    await r1.next("ack", (m) => m.up_to === 1);
    expect(((await agentStub(s.agent).info()) as unknown as { current_turn: string | null }).current_turn).toBeNull();
    const res = await restart(s.agent, { restart: true, when: "idle", launch: { model: "sonnet" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: "waiting", launch: { model: "sonnet", effort: null } });
    expect((await nextCommands(s.host.ws, isKillOf(s.agent))).find(isKillOf(s.agent))).toMatchObject({ epoch: 1 });
    r1.close();
  });

  it("is only for a restart; without it nothing changes from before", async () => {
    const s = await setup();
    for (const body of [{ when: "idle" }, { restart: false, when: "idle" }]) {
      const res = await restart(s.agent, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("restart: true");
    }
    expect((await restart(s.agent, { restart: true, when: "now" })).status).toBe(400);
    expect(await quiet(s)).toBe(true);
  });
});
