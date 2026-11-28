// Agent timers (docs/agents/capabilities/timers/): `timer_set`, `timer_cancel` and `timer_list` from a
// brain; a fired timer is an inbox message (into the running turn, or a turn of its own that wakes a
// brain); timers live in AgentDO's SQLite with one deadline each, so they survive a restart; the owner
// lists and cancels them. A timer is made due by moving its row and deadline to the past and running
// the alarm (`runDue`), never by waiting out the real 10 s minimum.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AgentDO } from "../src/do/agent";
import { ClientOutbox } from "../src/lib/client-events";
import { everyText, nextFiring, TimerStore, TIMERS_MAX, TIMERS_REPEATING_MAX } from "../src/lib/timers";
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

/** Make timer `name` due now (or at `at`) and run the agent's alarm. */
async function fire(agent: string, name: string, at = Date.now() - 1) {
  await runInDurableObject(agentStub(agent), (_: AgentDO, st) => {
    st.storage.sql.exec("UPDATE timers SET at_ms = ? WHERE name = ?", at, name);
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

  it("a repeating timer fires at each interval, keeping its cadence, until it's cancelled", async () => {
    const s = await setup();
    const set = await call(s.ws, "timer_set", { name: "daily", every_s: 86_400, note: "post the digest" });
    expect(set.content[0].text).toContain("then every 1 day until you cancel it");
    const [t] = await agentStub(s.agent).timers();
    expect(t).toMatchObject({ name: "daily", every_ms: 86_400_000, note: "post the digest" });
    // Without after_s or at_ms, its first firing is one interval from now.
    expect(t!.at_ms - Date.now()).toBeGreaterThan(86_390_000);
    expect((await call(s.ws, "timer_list", {})).content[0].text).toContain("then every 1 day (post the digest)");

    await fire(s.agent, "daily");
    const run = await s.ws.next("run_turn");
    expect(run.input.text).toBe('Message from timer: timer "daily" fired (repeats every 1 day; timer_cancel stops it): post the digest');
    s.ws.send({ type: "ack", up_to: run.seq });
    // Still there, a day on, and armed for it.
    const [after] = await agentStub(s.agent).timers();
    expect(after!.at_ms - Date.now()).toBeGreaterThan(86_390_000);
    const deadline = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'timer:daily'").one().at);
    expect(deadline).toBe(after!.at_ms);
    // Each firing is its own input (not deduplicated as the first): mid-turn, it joins the running turn.
    await fire(s.agent, "daily");
    expect((await s.ws.next("inbox")).message).toMatchObject({ from: "timer", text: 'timer "daily" fired (repeats every 1 day; timer_cancel stops it): post the digest' });
    expect(await traceTypes(s.agent)).toEqual(["timer_set:daily", "timer_fired:daily", "timer_fired:daily"]);

    expect((await call(s.ws, "timer_cancel", { name: "daily" })).content[0].text).toBe("Timer daily cancelled.");
    expect(await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'timer:daily'").toArray().length)).toBe(0);
    await runDue(agentStub(s.agent));
    expect(await s.ws.none("inbox", 300)).toBe(true);
    expect(await agentStub(s.agent).timers()).toEqual([]);
  });

  it("a repeating timer that fires late skips the firings it missed, keeping its cadence", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "hourly", every_s: 3600, after_s: 60 });
    // Due two and a half hours ago (an outage): one firing now, the next on the cadence, not three at once.
    const was = Date.now() - 9_000_000;
    await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => {
      st.storage.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'hourly'", was);
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'timer:hourly'");
    });
    await runDue(agentStub(s.agent));
    await s.ws.next("run_turn");
    expect(await s.ws.none("inbox", 300)).toBe(true);
    const [t] = await agentStub(s.agent).timers();
    expect(t!.at_ms).toBe(was + 3 * 3_600_000);
  });

  it("bounds a repeating timer's interval to 5 minutes through 30 days, and its first firing as any timer's", async () => {
    const s = await setup();
    const err = async (args: unknown) => (await call(s.ws, "timer_set", args)).error?.message as string | undefined;
    expect(await err({ name: "r", every_s: 60 })).toContain("5 minutes");
    expect(await err({ name: "r", every_s: 31 * 86_400 })).toContain("30 days");
    expect(await err({ name: "r", every_s: 3600, after_s: 5 })).toContain("at least 10 s");
    expect(await err({ name: "r", every_s: 3600, after_s: 60, at_ms: Date.now() + 60_000 })).toContain("exactly one");
    expect((await call(s.ws, "timer_set", { name: "r", every_s: 300, at_ms: Date.now() + 120_000 })).status).toBe("ok");
    // Set again without every_s: one-shot from then on.
    await call(s.ws, "timer_set", { name: "r", after_s: 60 });
    expect((await agentStub(s.agent).timers())[0]).not.toHaveProperty("every_ms");
  });

  it("a repeating timer cancelled, or set again, while its firing is being posted stays as that left it", async () => {
    for (const during of ["cancel", "set"] as const) {
      const s = await setup();
      await call(s.ws, "timer_set", { name: "rep", every_s: 3600, note: "old" });
      await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
        const i = inst as any;
        const post = i.postInbox.bind(inst);
        i.postInbox = async (...args: unknown[]) => {
          if (during === "cancel") await i.cancelTimer("rep", "test");
          else await i.setTimer({ name: "rep", at_ms: Date.now() + 7_200_000, note: "new", set_ms: Date.now() }, "k-new");
          return post(...args);
        };
        i.timerStore.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'rep'", Date.now() - 1);
        try {
          await i.timerFired("rep");
        } finally {
          delete i.postInbox;
        }
      });
      const timers = await agentStub(s.agent).timers();
      const deadline = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'timer:rep'").toArray()[0]?.at);
      if (during === "cancel") {
        expect(timers).toEqual([]);
        expect(deadline).toBeUndefined();
      } else {
        expect(timers).toEqual([expect.objectContaining({ name: "rep", note: "new" })]);
        expect(timers[0]).not.toHaveProperty("every_ms");
        // The new timer's time (two hours), not the old one's next firing (one hour).
        expect(timers[0]!.at_ms - Date.now()).toBeGreaterThan(7_000_000);
        expect(deadline).toBe(timers[0]!.at_ms);
      }
    }
  });

  it("a client's agent's repeating firing is a webhook event naming the next one", async () => {
    const c = await setup();
    await runInDurableObject(agentStub(c.agent), (inst: AgentDO) => (inst as any).update((i: any) => { i.client = "cli_timertest"; }));
    await call(c.ws, "timer_set", { name: "tick", every_s: 600, note: "check" });
    const added: any[] = [];
    const real = ClientOutbox.prototype.add;
    ClientOutbox.prototype.add = function (this: ClientOutbox, ...args: Parameters<typeof real>) {
      added.push(args[2]);
      return real.apply(this, args);
    };
    try {
      await fire(c.agent, "tick");
      await c.ws.next("run_turn");
    } finally {
      ClientOutbox.prototype.add = real;
    }
    const [t] = await agentStub(c.agent).timers();
    expect(added).toContainEqual({ type: "agent.timer_fired", agent: c.agent, timer: "tick", note: "check", next_ms: t!.at_ms });
  });

  it("reads a timers table of the previous release: a column added, its rows one-shot", async () => {
    const s = await setup({ start: false });
    const seen = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => {
      st.storage.sql.exec("DROP TABLE timers");
      st.storage.sql.exec("CREATE TABLE timers (name TEXT PRIMARY KEY, id TEXT NOT NULL, at_ms INTEGER NOT NULL, note TEXT NOT NULL, set_ms INTEGER NOT NULL)");
      st.storage.sql.exec("INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES ('old', 'k-old', 123, 'n', 100)");
      const store = new TimerStore(st.storage.sql);
      return { got: store.get("old"), list: store.list() };
    });
    expect(seen.got).toEqual({ name: "old", id: "k-old", at_ms: 123, note: "n", set_ms: 100 });
    expect(seen.list).toEqual([{ name: "old", at_ms: 123, note: "n", set_ms: 100 }]);
  });
});

describe("repeating timers, hardened", () => {
  const timerTurns = async (agent: string) => (await agentStub(agent).turns()).filter((t) => t.status === "queued" && t.input.text?.startsWith("Message from timer"));

  it("a name the previous release set again reads as the one-shot timer it set, not the repeating one it replaced", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).setTimer({ name: "report", at_ms: Date.now() + 60_000, note: "daily", set_ms: Date.now(), every_ms: 86_400_000 }, "k-rep"));
    // The previous release's upsert, exactly: it knows neither every_ms nor every_id.
    await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => {
      st.storage.sql.exec(`INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES ('report', 'k-old', ?, 'once', ?)
        ON CONFLICT(name) DO UPDATE SET id = excluded.id, at_ms = excluded.at_ms, note = excluded.note, set_ms = excluded.set_ms`, Date.now() + 3_600_000, Date.now());
    });
    const [t] = await agentStub(s.agent).timers();
    expect(t).toMatchObject({ name: "report", note: "once" });
    expect(t).not.toHaveProperty("every_ms");
    await fire(s.agent, "report");
    expect(await agentStub(s.agent).timers()).toEqual([]);
  });

  it("while its last firing still waits as a queued turn (no brain runs it), a repeating timer moves on without queueing more", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).setTimer({ name: "tick", at_ms: Date.now() + 60_000, note: "", set_ms: Date.now(), every_ms: 600_000 }, "k-tick"));
    // Four firings, each due at its own time (the clock stands still between them here, so `fire` would make
    // them one firing retried).
    for (let i = 0; i < 4; i++) await fire(s.agent, "tick", Date.now() - 1 - i);
    expect((await timerTurns(s.agent)).length).toBe(1);
    // The skipped firings are in neither the trace nor the owner's events: they never happened for the agent.
    expect((await traceTypes(s.agent)).filter((t) => t === "timer_fired:tick")).toHaveLength(1);
    const [t] = await agentStub(s.agent).timers();
    expect(t!.at_ms - Date.now()).toBeGreaterThan(590_000);
    // Once that turn is gone (run, or dropped), the next firing is posted again.
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).queue.dropAll());
    await fire(s.agent, "tick");
    expect((await timerTurns(s.agent)).length).toBe(1);
  });

  it("an alarm retried after the post landed but before the timer moved on posts that firing once", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      const i = inst as any;
      await i.setTimer({ name: "once", at_ms: Date.now() + 60_000, note: "", set_ms: Date.now(), every_ms: 600_000 }, "k-once");
      i.timerStore.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'once'", Date.now() - 1);
      const advance = i.timerStore.advance.bind(i.timerStore);
      i.timerStore.advance = () => {
        throw new Error("reset between the post and the move");
      };
      await expect(i.timerFired("once")).rejects.toThrow("reset");
      i.timerStore.advance = advance;
      // Its turn is taken (as a brain would), so nothing waits: the retry posts again, and only its request id
      // keeps it from making a second turn.
      i.queue.claimNext();
      await i.timerFired("once");
    });
    expect((await agentStub(s.agent).turns()).filter((t) => t.input.text?.startsWith("Message from timer")).length).toBe(1);
    // The retry is the firing that completed: its trace entry is there, once.
    expect((await traceTypes(s.agent)).filter((t) => t === "timer_fired:once")).toEqual(["timer_fired:once"]);
    expect((await agentStub(s.agent).timers())[0]!.at_ms - Date.now()).toBeGreaterThan(590_000);
  });

  it("an alarm retried while its own firing's turn is still queued completes that firing: posted once, traced once", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      const i = inst as any;
      await i.setTimer({ name: "own", at_ms: Date.now() + 60_000, note: "", set_ms: Date.now(), every_ms: 600_000 }, "k-own");
      i.timerStore.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'own'", Date.now() - 1);
      const advance = i.timerStore.advance.bind(i.timerStore);
      i.timerStore.advance = () => {
        throw new Error("reset between the post and the move");
      };
      await expect(i.timerFired("own")).rejects.toThrow("reset");
      i.timerStore.advance = advance;
      await i.timerFired("own");
    });
    expect((await agentStub(s.agent).turns()).filter((t) => t.input.text?.startsWith("Message from timer")).length).toBe(1);
    expect((await traceTypes(s.agent)).filter((t) => t === "timer_fired:own")).toEqual(["timer_fired:own"]);
  });

  it("an agent ended while a repeating firing is posted keeps no timer and no deadline", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "rep", every_s: 3600 });
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO) => {
      const i = inst as any;
      const post = i.postInbox.bind(inst);
      i.postInbox = async (...args: unknown[]) => {
        const r = await post(...args);
        await i.dropTimers();
        return r;
      };
      i.timerStore.sql.exec("UPDATE timers SET at_ms = ? WHERE name = 'rep'", Date.now() - 1);
      try {
        await i.timerFired("rep");
      } finally {
        delete i.postInbox;
      }
    });
    expect(await agentStub(s.agent).timers()).toEqual([]);
    expect(await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'timer:rep'").toArray().length)).toBe(0);
  });

  it("while a firing pushed into a running turn isn't confirmed, later ones aren't pushed", async () => {
    const s = await setup();
    await call(s.ws, "timer_set", { name: "beat", every_s: 300 });
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "a long turn" } }, 201);
    const run = await s.ws.next("run_turn");
    s.ws.send({ type: "ack", up_to: run.seq });
    for (let i = 0; i < 3; i++) await fire(s.agent, "beat", Date.now() - 1 - i);
    expect((await s.ws.next("inbox")).message.text).toContain('timer "beat" fired');
    expect(await s.ws.none("inbox", 300)).toBe(true);
    expect((await agentStub(s.agent).timers())[0]!.at_ms - Date.now()).toBeGreaterThan(290_000);
  });

  it("after a rollback: a repeating timer the previous release fired and deleted comes back on its cadence; one it cancelled or set again doesn't", async () => {
    const s = await setup({ start: false });
    // Not yet due here, so this release's alarm doesn't fire them first: the previous release does, below.
    const at = Date.now() + 60_000;
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO, st) => {
      const i = inst as any;
      for (const name of ["fired", "cancelled", "reset"]) await i.setTimer({ name, at_ms: at, note: name, set_ms: at, every_ms: 600_000 }, `k-${name}`);
      // The previous release, exactly: it fires a due timer as one-shot (`timer/<id>`) and deletes its row...
      await i.postInbox("timer", 'timer "fired" fired: fired', false, "timer/k-fired");
      st.storage.sql.exec("DELETE FROM timers WHERE name = ? AND id = ?", "fired", "k-fired");
      // ...cancels one (its row only)...
      st.storage.sql.exec("DELETE FROM timers WHERE name = ?", "cancelled");
      // ...and sets one again with its upsert, which knows no repeats.
      st.storage.sql.exec(`INSERT INTO timers (name, id, at_ms, note, set_ms) VALUES ('reset', 'k-old', ?, 'once', ?)
        ON CONFLICT(name) DO UPDATE SET id = excluded.id, at_ms = excluded.at_ms, note = excluded.note, set_ms = excluded.set_ms`, Date.now() + 60_000, Date.now());
      // The roll-forward: a fresh object over the same storage.
      new AgentDO(st, env);
      await new Promise((r) => setTimeout(r, 0));
    });
    const timers = await agentStub(s.agent).timers();
    expect(timers.map((t) => t.name).sort()).toEqual(["fired", "reset"]);
    const fired = timers.find((t) => t.name === "fired")!;
    expect(fired).toMatchObject({ every_ms: 600_000, note: "fired" });
    expect(fired.at_ms).toBe(at + 600_000);
    expect(timers.find((t) => t.name === "reset")).not.toHaveProperty("every_ms");
    const left = await runInDurableObject(agentStub(s.agent), (_: AgentDO, st) => st.storage.sql.exec<{ name: string }>("SELECT name FROM timer_repeats ORDER BY name").toArray().map((r) => r.name));
    expect(left).toEqual(["fired"]);
  });

  it("an ended agent's repeats left behind are forgotten, never restored", async () => {
    const s = await setup({ start: false });
    await runInDurableObject(agentStub(s.agent), async (inst: AgentDO, st) => {
      const i = inst as any;
      await i.setTimer({ name: "r", at_ms: Date.now() - 1, note: "", set_ms: Date.now(), every_ms: 600_000 }, "k-r");
      await i.postInbox("timer", 'timer "r" fired: ', false, "timer/k-r");
      st.storage.sql.exec("DELETE FROM timers");
    });
    await adminJson(`/v1/agents/${s.agent}/stop`, { body: { end: true } });
    await runInDurableObject(agentStub(s.agent), async (_: AgentDO, st) => {
      st.storage.sql.exec("INSERT OR REPLACE INTO timer_repeats (name, id, every_ms, note, at_ms) VALUES ('r', 'k-r', 600000, '', ?)", Date.now());
      new AgentDO(st, env);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(await agentStub(s.agent).timers()).toEqual([]);
  });

  it("caps an agent's repeating timers; one-shot ones and a repeating one set again still go", async () => {
    const s = await setup();
    for (let i = 0; i < TIMERS_REPEATING_MAX; i++) expect((await call(s.ws, "timer_set", { name: `r${i}`, every_s: 3600 })).status).toBe("ok");
    expect((await call(s.ws, "timer_set", { name: "r-more", every_s: 3600 })).error.message).toContain(`at most ${TIMERS_REPEATING_MAX} repeating timers`);
    expect((await call(s.ws, "timer_set", { name: "r0", every_s: 7200 })).status).toBe("ok");
    expect((await call(s.ws, "timer_set", { name: "plain", after_s: 60 })).status).toBe("ok");
  });
});

describe("repeating timers' arithmetic", () => {
  it("keeps the cadence, and skips what it missed", () => {
    expect(nextFiring(1000, 300, 1001)).toBe(1300);
    expect(nextFiring(1000, 300, 1300)).toBe(1600);
    expect(nextFiring(1000, 300, 2050)).toBe(2200);
    expect(nextFiring(1000, 300, 999)).toBe(1300);
  });

  it("says an interval as a person would", () => {
    expect(everyText(300_000)).toBe("5 minutes");
    expect(everyText(3_600_000)).toBe("1 hour");
    expect(everyText(5_400_000)).toBe("90 minutes");
    expect(everyText(604_800_000)).toBe("7 days");
    expect(everyText(301_000)).toBe("301 seconds");
  });
});
