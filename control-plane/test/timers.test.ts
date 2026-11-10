// Agent timers (docs/agents/capabilities/timers/): `timer_set`, `timer_cancel` and `timer_list` from a
// brain; a fired timer is an inbox message (into the running turn, or a turn of its own that wakes a
// brain); timers live in AgentDO's SQLite with one deadline each, so they survive a restart; the owner
// lists and cancels them. A timer is made due by moving its row and deadline to the past and running
// the alarm (`runDue`), never by waiting out the real 10 s minimum.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDO } from "../src/do/agent";
import { ClientOutbox } from "../src/lib/client-events";
import { TIMERS_MAX } from "../src/lib/timers";
import { adminJson, BASE, connectHost, nextCommands, runDue, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };

/** An agent of a template with `timers`, its brain host, and (unless `start: false`) its runner connected. */
async function setup(o: { start?: boolean } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const tpl = `timed-${rand()}`;
  await adminJson(`/v1/admin/templates/${tpl}`, { method: "PUT", body: { capabilities: ["nest", "timers"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" } });
  const host = await connectHost(cell, "brain");
  const start = o.start ?? true;
  const ag = await adminJson("/v1/agents", { body: { template: tpl, cell, start } }, 201);
  let ws: Ws | null = null;
  if (start) {
    await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === ag.agent);
    ws = await Ws.connect(`/v1/agents/${ag.agent}/session`, host.host_token);
    ws.send({ type: "hello", protocol_version: 1, agent: ag.agent, host: host.host, instance_id: `rin_${rand()}`, epoch: 1, session: SESSION });
    await ws.next("hello_ack");
  }
  return { cell, host, agent: ag.agent as string, ws: ws!, tpl };
}

const seqs = new WeakMap<Ws, number>();
async function call(ws: Ws, name: string, args: unknown) {
  const seq = (seqs.get(ws) ?? 0) + 1;
  seqs.set(ws, seq);
  const id = `cal_${rand()}`;
  ws.send({ type: "tool_call", seq, call: id, turn: "trn_x", name, arguments: args });
  return (await ws.next("tool_result", (m) => m.call === id)).outcome;
}

/** Make timer `name` due now and run the agent's alarm. */
async function fire(agent: string, name: string) {
  await runInDurableObject(agentStub(agent), (_: AgentDO, st) => {
    st.storage.sql.exec("UPDATE timers SET at_ms = ? WHERE name = ?", Date.now() - 1, name);
    st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = ?", `timer:${name}`);
  });
  await runDue(agentStub(agent));
}

const traceTypes = (agent: string) => runInDurableObject(agentStub(agent), (inst: AgentDO) =>
  ((inst as any).traceRing.after(0, Date.now()).events as { type: string; name?: string }[]).filter((e) => e.type.startsWith("timer_")).map((e) => `${e.type}:${e.name}`));

describe("timers", () => {
  it("one set on an idle agent fires as an inbox turn, once, and is gone; set and fired are in the trace", async () => {
    const s = await setup();
    const set = await call(s.ws, "timer_set", { name: "check-ci", after_s: 600, note: "look at CI" });
    expect(set.status).toBe("ok");
    const listed = await call(s.ws, "timer_list", {});
    expect(listed.content[1].value.timers).toEqual([expect.objectContaining({ name: "check-ci", note: "look at CI" })]);
    const at = listed.content[1].value.timers[0].at_ms;
    expect(at - Date.now()).toBeGreaterThan(590_000);
    await fire(s.agent, "check-ci");
    const run = await s.ws.next("run_turn");
    expect(run.input).toEqual({ kind: "inbox", text: 'Message from timer: timer "check-ci" fired: look at CI' });
    expect(await agentStub(s.agent).timers()).toEqual([]);
    // A second run of the alarm posts nothing more.
    await runDue(agentStub(s.agent));
    expect(await s.ws.none("run_turn", 300)).toBe(true);
    expect(await traceTypes(s.agent)).toEqual(["timer_set:check-ci", "timer_fired:check-ci"]);
  });

  it("one that fires mid-turn reaches the running turn as an inbox message does", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "nudge", after_s: 60, note: "time's up" });
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "long work" } }, 201);
    const run = await s.ws.next("run_turn");
    s.ws.send({ type: "ack", up_to: run.seq });
    await fire(s.agent, "nudge");
    const inbox = await s.ws.next("inbox");
    expect(inbox.message).toMatchObject({ from: "timer", text: 'timer "nudge" fired: time\'s up', interrupt: false });
    expect(await s.ws.none("run_turn", 300)).toBe(true);
  });

  it("wakes a detached agent: its brain starts as for an inbox message", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).setTimer({ name: "wake", at_ms: Date.now() + 60_000, note: "", set_ms: Date.now() }, "k1"));
    await fire(s.agent, "wake");
    const [start] = await nextCommands(s.host.ws, (c) => c.type === "agent_start" && c.agent === s.agent);
    expect(start).toMatchObject({ agent: s.agent, epoch: 1 });
    expect((await agentStub(s.agent).turns()).map((t) => t.input.text)).toEqual(['Message from timer: timer "wake" fired: ']);
  });

  it("lives in storage: a fresh instance over the same storage has it, armed", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).setTimer({ name: "later", at_ms: Date.now() + 3_600_000, note: "n", set_ms: Date.now() }, "k2"));
    const seen = await runInDurableObject(agentStub(s.agent), async (_: AgentDO, st) => {
      const fresh = new AgentDO(st, env);
      const deadline = st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'timer:later'").toArray()[0]?.at;
      return { timers: await fresh.timers(), deadline };
    });
    expect(seen.timers).toEqual([expect.objectContaining({ name: "later", note: "n" })]);
    expect(seen.deadline).toBe(seen.timers[0]!.at_ms);
  });

  it("setting a name again replaces it: one timer, the new note and time, fired once", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "x", after_s: 60, note: "old" });
    await call(s.ws, "timer_set", { name: "x", at_ms: Date.now() + 7_200_000, note: "new" });
    const timers = await agentStub(s.agent).timers();
    expect(timers).toEqual([expect.objectContaining({ name: "x", note: "new" })]);
    expect(timers[0]!.at_ms - Date.now()).toBeGreaterThan(7_000_000);
    await fire(s.agent, "x");
    expect((await s.ws.next("run_turn")).input.text).toBe('Message from timer: timer "x" fired: new');
    expect(await s.ws.none("run_turn", 300)).toBe(true);
  });

  it("is bounded: 10 s to 30 days, one of after_s and at_ms, at most 32 live; a replacement takes no place", async () => {
    const s = await setup();
    const err = async (args: unknown) => (await call(s.ws, "timer_set", args)).error?.message as string | undefined;
    expect(await err({ name: "a", after_s: 5 })).toContain("at least 10 s");
    expect(await err({ name: "a", after_s: 31 * 86_400 })).toContain("at most 30 days");
    expect(await err({ name: "a", at_ms: Date.now() - 1000 })).toContain("at least 10 s");
    expect(await err({ name: "a", after_s: 60, at_ms: Date.now() + 60_000 })).toContain("exactly one");
    expect(await err({ name: "a" })).toContain("exactly one");
    expect(await err({ name: "Bad Name", after_s: 60 })).toContain("timer name");
    for (let i = 0; i < TIMERS_MAX; i++) expect((await call(s.ws, "timer_set", { name: `t${i}`, after_s: 60 })).status).toBe("ok");
    expect(await err({ name: "one-more", after_s: 60 })).toContain(`at most ${TIMERS_MAX} timers`);
    expect((await call(s.ws, "timer_set", { name: "t0", after_s: 120 })).status).toBe("ok");
    expect((await agentStub(s.agent).timers()).length).toBe(TIMERS_MAX);
  });

  it("the owner lists and cancels them; a cancelled timer never fires, and the agent can cancel its own", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "a", after_s: 60, note: "first" });
    await call(s.ws, "timer_set", { name: "b", after_s: 120 });
    expect((await adminJson(`/v1/agents/${s.agent}/timers`)).timers.map((t: any) => t.name)).toEqual(["a", "b"]);
    await adminJson(`/v1/agents/${s.agent}/timers/a`, { method: "DELETE" });
    expect((await adminJson(`/v1/agents/${s.agent}/timers/a`, { method: "DELETE" }, 404)).error.code).toBe("not_found");
    await fire(s.agent, "a");
    expect(await s.ws.none("run_turn", 300)).toBe(true);
    expect((await call(s.ws, "timer_cancel", { name: "b" })).content[0].text).toBe("Timer b cancelled.");
    expect((await adminJson(`/v1/agents/${s.agent}/timers`)).timers).toEqual([]);
    expect(await traceTypes(s.agent)).toEqual(["timer_set:a", "timer_set:b", "timer_cancelled:a", "timer_cancelled:b"]);
  });

  it("only its owner sees or cancels an agent's timers; another client's token is answered as for an unknown agent", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "mine", after_s: 60 });
    const c = await adminJson("/v1/admin/clients", { body: { name: `tm-${rand()}`, grant: { cells: [s.cell] } } }, 201);
    const asClient = (method: string, path: string) => SELF.fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${c.token}` } });
    expect((await asClient("GET", `/v1/agents/${s.agent}/timers`)).status).toBe(404);
    expect((await asClient("DELETE", `/v1/agents/${s.agent}/timers/mine`)).status).toBe(404);
    expect((await agentStub(s.agent).timers()).map((t) => t.name)).toEqual(["mine"]);
  });

  it("refuses the timer tools from a sandbox, an ended agent's set, and a note over 1,000 characters", async () => {
    const s = await setup();
    const guest = await runInDurableObject(agentStub(s.agent), (inst: AgentDO) =>
      (inst as any).dispatch(1, "cal_guest", "timer_set", { name: "g", after_s: 60 }, 1).then(() => "ran", (e: Error) => e.message));
    expect(guest).toContain("isn't callable from a sandbox");
    expect((await call(s.ws, "timer_set", { name: "long", after_s: 60, note: "x".repeat(1001) })).error.message).toContain("1,000 characters");
    expect((await call(s.ws, "timer_set", { name: "ok", after_s: 60, note: "x".repeat(1000) })).status).toBe("ok");
    await adminJson(`/v1/agents/${s.agent}/stop`, { body: { end: true } });
    const ended = await runInDurableObject(agentStub(s.agent), (inst: AgentDO) =>
      (inst as any).setTimer({ name: "late", at_ms: Date.now() + 60_000, note: "", set_ms: Date.now() }, "k").then(() => "set", (e: Error) => e.message));
    expect(ended).toContain("no more timers");
    expect(await agentStub(s.agent).timers()).toEqual([]);
  });

  it("a timer set again while its firing is being posted keeps its new row and deadline", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "again", after_s: 60, note: "first" });
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      const i = inst as any;
      const post = i.postInbox.bind(inst);
      i.postInbox = async (...args: unknown[]) => {
        await i.setTimer({ name: "again", at_ms: Date.now() + 3_600_000, note: "second", set_ms: Date.now() }, "k-second");
        return post(...args);
      };
      i.timerStore.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'again'", Date.now() - 1);
      try {
        await i.timerFired("again");
      } finally {
        delete i.postInbox;
      }
    });
    expect((await s.ws.next("run_turn")).input.text).toBe('Message from timer: timer "again" fired: first');
    expect(await agentStub(s.agent).timers()).toEqual([expect.objectContaining({ name: "again", note: "second" })]);
    const armed = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'timer:again'").toArray().length);
    expect(armed).toBe(1);
  });

  it("a timer left without its deadline is armed again when the object starts, before any alarm", async () => {
    const s = await setup({ start: false });
    const at = await runInDurableObject(agentStub(s.agent), async (_: AgentDO, st) => {
      st.storage.sql.exec("INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES ('fresh', 'k-f', ?, '', ?)", Date.now() + 600_000, Date.now());
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'timer:fresh'");
      new AgentDO(st, env);
      await new Promise((r) => setTimeout(r, 0));
      return st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'timer:fresh'").toArray()[0]?.at;
    });
    expect(at).toBeGreaterThan(Date.now() + 500_000);
  });

  it("a timer left without its deadline (a rolled-back release dropped it) is armed again at the next alarm", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO, st) => {
      st.storage.sql.exec("INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES ('orphan', 'k-o', ?, '', ?)", Date.now() + 600_000, Date.now());
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'timer:orphan'");
      // Something due brings an alarm (`runDue`): a bare `runDurableObjectAlarm` does nothing while the
      // new agent's own first alarm (`registry`) is still in flight, and the timer stayed unarmed.
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('prune', 0)");
    });
    await runDue(agentStub(s.agent));
    const at = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) =>
      st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'timer:orphan'").toArray()[0]?.at);
    expect(at).toBeGreaterThan(Date.now() + 500_000);
  });

  it("an ended agent's timers are dropped and never fire; a client's agent's firing is a webhook event", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "z", after_s: 60 });
    await adminJson(`/v1/agents/${s.agent}/stop`, { body: { end: true } });
    expect(await agentStub(s.agent).timers()).toEqual([]);
    expect(await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'timer:z'").toArray().length)).toBe(0);

    const c = await setup();
    await runInDurableObject(agentStub(c.agent), (inst: AgentDO) => (inst as any).update((i: any) => { i.client = "cli_timertest"; }));
    await call(c.ws, "timer_set", { name: "hook", after_s: 60, note: "ping" });
    // What its outbox is handed (the hand-off to ClientDO runs at once and empties it).
    const added: unknown[] = [];
    const real = ClientOutbox.prototype.add;
    ClientOutbox.prototype.add = function (this: ClientOutbox, ...args: Parameters<typeof real>) {
      added.push(args[2]);
      return real.apply(this, args);
    };
    try {
      await fire(c.agent, "hook");
      await c.ws.next("run_turn");
    } finally {
      ClientOutbox.prototype.add = real;
    }
    expect(added).toContainEqual({ type: "agent.timer_fired", agent: c.agent, timer: "hook", note: "ping" });
  });
});
