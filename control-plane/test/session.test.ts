import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytesToB64 } from "../src/lib/util";
import type { AgentDO } from "../src/do/agent";
import { admin, adminJson, connectHost, eventually, nextCommands, received, sessionGone, sleep, uniqueCell, Ws } from "./helpers";

const SESSION = "ses_5f0c1a2e-8b7d-4c3e-9a10-2f6d4b8e1c73";
const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));

async function setup(opts: { captain?: boolean } = {}) {
  const cell = uniqueCell();
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-test" } });
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "ship it" } }, 201);
  let captain: string | undefined;
  if (opts.captain) {
    captain = (await adminJson("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent;
  }
  const sbx = await adminJson("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell, ...(captain ? { captain } : {}) } }, 201);
  const [start] = await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { cell, host, sbxHost, workstream, sandbox: sbx.sandbox, agent: worker.agent as string, start, captain };
}

async function connectRunner(agent: string, hostId: string, token: string, epoch = 1, extra: Record<string, unknown> = {}) {
  const ws = await Ws.connect(`/v1/agents/${agent}/session`, token);
  ws.send({ type: "hello", protocol_version: 1, agent, host: hostId, instance_id: "rin_test", epoch, session: SESSION, ...extra });
  const ack = await ws.next("hello_ack");
  return { ws, ack };
}

const seg = (offset: number, text: string, base = false) => ({
  type: "segment", session: SESSION, offset, base, data_b64: bytesToB64(new TextEncoder().encode(text)),
});

let runnerSeq = 0;
const toolCall = (call: string, name: string, args: unknown, seq = ++runnerSeq) => ({ type: "tool_call", seq, call, turn: "trn_x", name, arguments: args });

/** The ask a sent `ask` call posted, once its `needs_input` event is in (a call lands when workerd delivers it). */
async function askPosted(workstream: string): Promise<string> {
  for (let i = 0; i < 250; i++) {
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(workstream)).events();
    const needs = events.find((e) => e.type === "needs_input") as { ask: string } | undefined;
    if (needs) return needs.ask;
    await sleep(20);
  }
  throw new Error("timed out waiting for the ask's needs_input event");
}

/** Lapse the sync window of the agent's open ask: wait for its deadline, make it due, run the alarm. */
async function lapseAskWindow(agent: string): Promise<void> {
  const due = () => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
    st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key LIKE 'ask:%'").rowsWritten);
  for (let i = 0; i < 250 && (await due()) === 0; i++) await sleep(20);
  await runDurableObjectAlarm(agentStub(agent));
}

describe("agent start", () => {
  it("sends agent_start to a brain host (never the sandbox's) with the setup token, hands and session URL", async () => {
    const s = await setup();
    expect(s.start).toMatchObject({
      agent: s.agent, workstream: s.workstream, epoch: 1, hands: { sandbox: s.sandbox },
      oauth_token: "sk-ant-oat01-test", launch: { system_prompt: { mode: "append" } },
    });
    expect(s.start.session_ws_url).toMatch(new RegExp(`/v1/agents/${s.agent}/session$`));
    // Nothing for the previous release's runners: no role, and the epoch only once.
    expect(s.start).not.toHaveProperty("role");
    expect(s.start.hands).toEqual({ sandbox: s.sandbox });
  });
});

describe("session channel", () => {
  it("delivers turns one at a time and pushes the hook cache on hello", async () => {
    const s = await setup();
    const { ws, ack } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    expect(ack).toMatchObject({ durable_bytes: 0 });
    const cache = await ws.next("cache_update");
    // A seeded worker's rules: its nest tools without a prompt (it launches without `Agent`, so no subagent rule).
    expect(cache.cache.rules).toEqual([{ pattern: "mcp__nest__*", decision: "allow" }]);

    const t1 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "first" } }, 201)).turn;
    const t2 = (await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "second" } }, 201)).turn;
    const run1 = await ws.next("run_turn");
    expect(run1).toMatchObject({ turn: t1, input: { kind: "user", text: "first" } });
    expect(await ws.none("run_turn")).toBe(true);
    ws.send({ type: "ack", up_to: run1.seq });

    ws.send({ type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), turn: t1, type: "turn_started", input_kind: "user" },
      { agent: s.agent, epoch: 1, seq: 2, ts_ms: Date.now(), turn: t1, type: "turn_completed", stop_reason: "end_turn" },
    ] });
    expect((await ws.next("ack")).up_to).toBe(1);
    const run2 = await ws.next("run_turn");
    expect(run2.turn).toBe(t2);
    expect((await agentStub(s.agent).turns()).map((t) => t.status)).toEqual(["done", "active"]);

    // Inbox during a turn is delivered over stdin and mirrored in the cache for the Stop hook.
    await adminJson(`/v1/agents/${s.agent}/inbox`, { body: { text: "rebase first", interrupt: true } }, 201);
    const inbox = await ws.next("inbox");
    expect(inbox.message).toMatchObject({ from: "user", text: "rebase first", interrupt: true });
    const mirror = await ws.next("cache_update", (m) => m.cache.inbox.length === 1);
    expect(mirror.cache.inbox[0].text).toBe("rebase first");
    await adminJson(`/v1/agents/${s.agent}/interrupt`, { body: {} });
    expect((await ws.next("interrupt")).turn).toBe(t2);
  });

  it("acks session bytes only after they're durable in R2, dedups, rejects gaps, and resets on base", async () => {
    const s = await setup();
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    const a = '{"type":"user"}\n';
    const b = '{"type":"assistant"}\n';
    ws.send(seg(0, a));
    ws.send(seg(a.length, b));
    expect(await ws.none("segment_ack", 200)).toBe(true); // buffered, not durable yet
    await agentStub(s.agent).flush();
    expect((await ws.next("segment_ack")).durable_bytes).toBe(a.length + b.length);
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe(a + b);

    ws.send(seg(a.length, b)); // duplicate
    expect((await ws.next("segment_ack")).durable_bytes).toBe(a.length + b.length);
    ws.send(seg(a.length + b.length + 10, "x\n")); // gap: rejected, and the runner must reconnect
    expect((await ws.next("error")).error.code).toBe("invalid_message");
    expect((await ws.whenClosed())?.code).toBe(4500);
    const r2 = await connectRunner(s.agent, s.host.host, s.host.host_token);
    expect(r2.ack.durable_bytes).toBe(a.length + b.length);

    const c = '{"type":"summary"}\n';
    const oldBase = (await agentStub(s.agent).info()).recv_base;
    r2.ws.send(seg(0, c, true)); // file rewritten (compaction): new base
    await received(s.agent, c.length, oldBase + 1);
    // Until the new base is durable, the old one stays what resume and transcripts read.
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe(a + b);
    await agentStub(s.agent).flush();
    expect((await r2.ws.next("segment_ack", (m) => m.durable_bytes === c.length)).durable_bytes).toBe(c.length);
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe(c);

    // A reconnecting runner learns where to resume from.
    r2.ws.close();
    const again = await connectRunner(s.agent, s.host.host, s.host.host_token, 1, { local_bytes: 500 });
    expect(again.ack.durable_bytes).toBe(c.length);

    // Restarting the brain (once it's gone) rebuilds the session file from signed segment URLs.
    again.ws.close();
    await sessionGone(s.agent);
    await agentStub(s.agent).onExited(s.host.host, "idle", 1); // gone: its exit released it
    const { cmd } = await agentStub(s.agent).start();
    const [restart] = await nextCommands(s.host.ws, (x) => x.cmd === cmd);
    expect(restart.resume).toMatchObject({ session: SESSION, total_bytes: c.length });
    const url = new URL(restart.resume.segments[0].url);
    const blob = await (await import("cloudflare:test")).SELF.fetch(`http://cp.test${url.pathname}${url.search}`);
    expect(await blob.text()).toBe(c);
    const forged = await (await import("cloudflare:test")).SELF.fetch(`http://cp.test${url.pathname}?exp=${url.searchParams.get("exp")}&sig=AAAA`);
    expect(forged.status).toBe(403);
  });

  it("a flush that crosses the size threshold during a slow flush loses none of the acked bytes from R2", async () => {
    const s = await setup();
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    const a = '{"type":"user"}\n';
    const big = `${"x".repeat(1024 * 1024)}\n`;
    ws.send(seg(0, a));
    await received(s.agent, a.length);
    // The first flush is held just before its R2 put.
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      inst.testHooks["flush:beforePut"] = async () => {
        delete inst.testHooks["flush:beforePut"];
        (inst as any).testHeld = true;
        while (!(inst as any).testGo) await sleep(5);
      };
    });
    const first = agentStub(s.agent).flush();
    await eventually("the first flush to be held", () => runInDurableObject(agentStub(s.agent), (inst: AgentDO) => (inst as any).testHeld));
    ws.send(seg(a.length, big)); // past 1 MiB: flushes at once
    await received(s.agent, a.length + big.length);
    await sleep(100); // room for the threshold flush to reach R2, were it not waiting for the first
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO) => {
      (inst as any).testGo = true;
    });
    await first;
    await ws.next("segment_ack", (m) => m.durable_bytes === a.length + big.length);
    expect(await agentStub(s.agent).transcript()).toBe(a + big);
  });

  it("routes a stale-epoch connection's segments to the orphan branch and nothing else", async () => {
    const s = await setup();
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token, 0);
    expect((await ws.next("error")).error.code).toBe("stale_epoch");
    ws.send(seg(0, "orphan\n"));
    await ws.next("segment_ack");
    const listed = await env.BUCKET.list({ prefix: `sessions/${s.agent}/orphan/e0/` });
    expect(listed.objects.length).toBe(1);
    expect(await (await admin(`/v1/agents/${s.agent}/transcript`)).text()).toBe("");
    await adminJson(`/v1/agents/${s.agent}/turns`, { body: { text: "x" } }, 201);
    expect(await ws.none("run_turn")).toBe(true);
  });
});

describe("platform tool relay", () => {
  it("notify reaches the captain's inbox once, even when the call is redelivered", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall("cal_t1-1", "notify", { to: "captain", message: "PR is up" }));
    const r = await ws.next("tool_result");
    expect(r).toMatchObject({ call: "cal_t1-1", outcome: { status: "ok" } });
    ws.send(toolCall("cal_t1-1", "notify", { to: "captain", message: "PR is up" })); // redelivery, new seq
    expect((await ws.next("tool_result")).call).toBe("cal_t1-1");
    const captainTurns = await agentStub(s.captain!).turns();
    expect(captainTurns.length).toBe(1);
    expect(captainTurns[0]!.input).toMatchObject({ kind: "inbox" });
    expect(captainTurns[0]!.input.text).toContain("PR is up");
  });

  it("ask answers within the window synchronously, otherwise returns pending and answers as a turn", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall("cal_t2-1", "ask", { question: "Allow api.openai.com?", options: ["allow 2h", "deny"] }));
    const ask = await askPosted(s.workstream);
    expect(await ws.none("tool_result", 50)).toBe(true);
    expect((await adminJson(`/v1/agents/${s.agent}/asks/${ask}/answer`, { body: { answer: "allow 2h" } })).delivered).toBe("sync");
    const r = await ws.next("tool_result");
    expect(r.outcome).toEqual({ status: "ok", content: [{ type: "text", text: "allow 2h" }] });

    ws.send(toolCall("cal_t2-2", "ask", { question: "Merge?", to: "user" }));
    // The window lapses (its deadline made due, rather than waiting out ASK_SYNC_WINDOW_MS).
    await lapseAskWindow(s.agent);
    const pending = await ws.next("tool_result", (m) => m.call === "cal_t2-2");
    expect(pending.outcome.status).toBe("pending");
    const notes = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).userNotifications();
    expect(notes.at(-1)!.text).toContain("Merge?");
    expect((await adminJson(`/v1/agents/${s.agent}/asks/${pending.outcome.ask}/answer`, { body: { answer: "yes" } })).delivered).toBe("async");
    const turns = await agentStub(s.agent).turns();
    expect(turns.at(-1)!.input).toMatchObject({ kind: "ask_answer" });
  });

  it("an ask answered inside its window after its brain was restarted arrives as a turn (the call's result has no brain to reach)", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send(toolCall("cal_t3-1", "ask", { question: "Merge?" }));
    const ask = await askPosted(s.workstream);
    await agentStub(s.agent).start(undefined, undefined, true); // an operator's restart condemns brain 1
    expect((await adminJson(`/v1/agents/${s.agent}/asks/${ask}/answer`, { body: { answer: "yes" } })).delivered).toBe("async");
    expect((await agentStub(s.agent).turns()).at(-1)!.input).toMatchObject({ kind: "ask_answer", text: expect.stringContaining("yes") });
  });

  it("an ask answered while it is still being routed ends its call `done`, never `waiting` (which is never pruned)", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    await runInDurableObject(agentStub(s.agent), (inst: AgentDO, st) => {
      inst.testHooks["ask:beforeRoute"] = async () => {
        delete inst.testHooks["ask:beforeRoute"];
        await inst.answerAsk(st.storage.sql.exec<{ ask: string }>("SELECT ask FROM asks").one().ask, "yes");
      };
    });
    ws.send(toolCall("cal_t4-1", "ask", { question: "Merge?" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t4-1")).outcome).toEqual({ status: "ok", content: [{ type: "text", text: "yes" }] });
    await ws.next("ack");
    const status = await runInDurableObject(agentStub(s.agent), (_i: AgentDO, st) =>
      st.storage.sql.exec<{ status: string }>("SELECT status FROM tool_calls WHERE call = 'cal_t4-1'").one().status);
    expect(status).toBe("done");
  });

  it("an escalation event becomes an async ask whose answer arrives as a turn", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send({ type: "events", seq: 1, events: [
      { agent: s.agent, epoch: 1, seq: 1, ts_ms: Date.now(), type: "capabilities", capabilities: ["interrupt_receipt_v1"] },
      { agent: s.agent, epoch: 1, seq: 2, ts_ms: Date.now(), type: "escalation", call: "cal_t9-1", tool: "WebFetch", input: { url: "https://x.test" } },
    ] });
    expect((await ws.next("ack")).up_to).toBe(1);
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).events();
    const needs = events.find((e) => e.type === "needs_input") as { ask: string; question: string } | undefined;
    expect(needs?.question).toContain("WebFetch");
    expect(needs?.question).toContain("cal_t9-1");
    expect((await adminJson(`/v1/agents/${s.agent}/asks/${needs!.ask}/answer`, { body: { answer: "allow" } })).delivered).toBe("async");
    expect((await agentStub(s.agent).turns()).at(-1)!.input).toMatchObject({ kind: "ask_answer" });
  });

  it("enforces roles, validates arguments, and reports unimplemented tools", async () => {
    const s = await setup();
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send({ type: "tools_list_request", request: "req_tl" });
    const list = await ws.next("tools_list");
    const names = (list.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("notify");
    expect(names).not.toContain("spawn_workstream");

    ws.send(toolCall("cal_t3-1", "spawn_workstream", { goal: "x", spec: "y" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t3-1")).outcome.error.code).toBe("forbidden");
    ws.send(toolCall("cal_t3-2", "notify", { to: "captain" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t3-2")).outcome.error.code).toBe("invalid_message");
    ws.send(toolCall("cal_t3-3", "fork_sandbox", { sandbox: s.sandbox }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t3-3")).outcome.error.code).toBe("not_implemented");
    ws.send(toolCall("cal_t3-4", "nope", {}));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t3-4")).outcome.error.code).toBe("unknown_tool");
  });

  it("emit, read_transcript and expose_port", async () => {
    const s = await setup({ captain: true });
    const { ws } = await connectRunner(s.agent, s.host.host, s.host.host_token);
    ws.send(seg(0, "line one\nline two\n"));
    // The segment is processed in order on the socket; flush only once it has arrived.
    await received(s.agent, 18);
    await agentStub(s.agent).flush();

    ws.send(toolCall("cal_t4-1", "emit", { event: "pr_opened", summary: "dark mode", url: "https://github.com/x/y/pull/1" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t4-1")).outcome.status).toBe("ok");
    const events = await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(s.workstream)).events();
    expect(events.at(-1)).toMatchObject({ type: "pr_opened", url: "https://github.com/x/y/pull/1", agent: s.agent, sandbox: s.sandbox });

    ws.send(toolCall("cal_t4-2", "read_transcript", { agent: s.agent, since_seq: 1 }));
    const tr = await ws.next("tool_result", (m) => m.call === "cal_t4-2");
    expect(tr.outcome.content[0].text).toBe("line two");
    // Only an agent id names an agent: never another DO instance (`~health`, lib/health.ts).
    ws.send(toolCall("cal_t4-2b", "read_transcript", { agent: "~health" }));
    expect((await ws.next("tool_result", (m) => m.call === "cal_t4-2b")).outcome.error.code).toBe("invalid_message");

    ws.send(toolCall("cal_t4-3", "expose_port", { port: 3000 }));
    const ex = await ws.next("tool_result", (m) => m.call === "cal_t4-3");
    // Named by the hostname rule (a first-level label, kind as suffix, no `_`), without NEST_DOMAIN under `nest.localhost`.
    expect(ex.outcome.content[1].value.url).toBe(`https://3000-${s.sandbox.slice("sbx_".length)}-preview-nest.localhost`);
    const [expose] = await nextCommands(s.sbxHost.ws, (c) => c.type === "port_expose");
    expect(expose).toMatchObject({ sandbox: s.sandbox, epoch: 1, port: 3000, host_header: { mode: "localhost" } });

    // Agents can't mint public share links (they bypass Access); the operator API can.
    ws.send(toolCall("cal_t4-4", "expose_port", { port: 3000, share: true }));
    const denied = await ws.next("tool_result", (m) => m.call === "cal_t4-4");
    expect(denied.outcome.error.code).toBe("forbidden");
    const shared = await adminJson(`/v1/sandboxes/${s.sandbox}/ports`, { body: { port: 3000, share: true } });
    expect(shared.share_url).toMatch(/^https:\/\/3000-[0-9a-z]{26}-share-nest\.localhost\/\?exp=\d+&sig=/);
  });
});
