// The chat's pure parts: grouping by author and day, the turn in progress read from a trace as steps, the
// steps found again for each reply, the turn placed in the log by time, and the quote a reply starts from.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { finishedTurns, GROUP_GAP_MS, groupLog, liveTurn, type LogItem, quote, type Step, stepsBySeq, timeline, type ToolStep } from "./model";

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
const msg = (seq: number, sender: string, at_ms: number): ChatMessage => ({ seq, at_ms, sender, text: `m${seq}`, delivered: true, status: "done" as const, error: null });

describe("groupLog", () => {
  it("groups an author's messages within five minutes, and starts a new group past that or for another author", () => {
    const items = groupLog([msg(1, "owner", NOW - 60_000), msg(2, "owner", NOW - 30_000), msg(3, "manager", NOW - 20_000), msg(4, "manager", NOW - 20_000 + GROUP_GAP_MS + 1)], NOW);
    const groups = items.filter((i) => i.kind === "group").map((g) => (g.kind === "group" ? g.messages.map((m) => m.seq) : []));
    expect(groups).toEqual([[1, 2], [3], [4]]);
  });

  it("puts a day separator before each new day, labelled Today, Yesterday or the date", () => {
    const yesterday = NOW - 86_400_000;
    const items = groupLog([msg(1, "owner", yesterday - 86_400_000), msg(2, "owner", yesterday), msg(3, "owner", NOW)], NOW);
    const days = items.filter((i) => i.kind === "day").map((d) => (d.kind === "day" ? d.label : ""));
    expect(days).toHaveLength(3);
    expect(days.slice(1)).toEqual(["Yesterday", "Today"]);
    // A new day ends a group, even the same author's within five minutes.
    expect(items.map((i) => i.kind)).toEqual(["day", "group", "day", "group", "day", "group"]);
  });

  it("never groups the app's notes", () => {
    const items = groupLog([msg(1, "app", NOW - 2_000), msg(2, "app", NOW - 1_000)], NOW);
    expect(items.filter((i) => i.kind === "group")).toHaveLength(2);
  });
});

describe("liveTurn", () => {
  let seq = 0;
  const ev = (type: string, more: Record<string, unknown> = {}, turn = "trn_1") => ({ seq: ++seq, ts_ms: NOW, type, turn, ...more }) as unknown as TraceEvent;

  it("is the running turn's steps in order: what it said, and each tool call with its name, main argument and input", () => {
    const t = liveTurn([ev("turn_started"), ev("assistant_text", { text: "Looking." }), ev("tool_call", { call_id: "c1", name: "mcp__projects-board__write_spec", input: JSON.stringify({ task: "tsk_1", spec: "Do it", criteria: ["a", "b"], limits: { n: 1 } }) })]);
    expect(t?.turn).toBe("trn_1");
    expect(t?.steps.map((s) => s.kind)).toEqual(["text", "tool"]);
    const tool = t!.steps[1]!;
    expect(tool).toMatchObject({ kind: "tool", name: "write_spec", summary: "tsk_1", result: null, status: "running" });
    // Each field as text: a string as it is, a list of strings a line each, anything else compact JSON.
    expect(tool.kind === "tool" && tool.input).toEqual([{ key: "task", value: "tsk_1" }, { key: "spec", value: "Do it" }, { key: "criteria", value: "a\nb" }, { key: "limits", value: '{"n":1}' }]);
  });

  it("marks a call done or failed by its result, and is nothing once the turn completes", () => {
    const started = [
      ev("turn_started"),
      ev("tool_call", { call_id: "c1", name: "Bash", input: { command: "ls" } }),
      ev("tool_result", { call_id: "c1", is_error: false, summary: "a\nb" }),
      ev("tool_call", { call_id: "c2", name: "Bash", input: { command: "git push" } }),
      ev("tool_result", { call_id: "c2", is_error: true, summary: "403" }),
    ];
    expect(liveTurn(started)?.steps.map((s) => s.kind === "tool" && [s.status, s.result])).toEqual([["done", "a\nb"], ["error", "403"]]);
    expect(liveTurn([...started, ev("turn_completed", { stop_reason: "end_turn" })])).toBeNull();
    expect(liveTurn([])).toBeNull();
  });
});

describe("finishedTurns and stepsBySeq", () => {
  let seq = 100;
  const ev = (type: string, turn: string | undefined, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: NOW, type, turn, ...more }) as unknown as TraceEvent;
  const reply = (s: number, text: string): ChatMessage => ({ seq: s, at_ms: NOW, sender: "manager", text, delivered: true, status: "done" as const, error: null });

  it("pairs a finished turn with the message saying its reply (its last text); everything else it did is behind it, a call it never answered stopped", () => {
    const turns = finishedTurns([
      ev("turn_started", "t1"),
      ev("assistant_text", "t1", { text: "Checking." }),
      ev("tool_call", "t1", { call_id: "c1", name: "Read", input: { file_path: "a.ts" } }),
      // A timer set mid-turn has no turn: it doesn't split the turn, and the result still finds its call.
      ev("timer_set", undefined, { timer: "tm_1" }),
      ev("tool_call", "t1", { call_id: "c2", name: "Bash", input: { command: "npm test" } }),
      ev("tool_result", "t1", { call_id: "c1", is_error: false, summary: "ok" }),
      ev("assistant_text", "t1", { text: "  All good.  " }),
      // A call after the reply is still one of its steps.
      ev("tool_call", "t1", { call_id: "c3", name: "mcp__projects-board__list_waits", input: {} }),
      ev("tool_result", "t1", { call_id: "c3", is_error: false, summary: "none" }),
      ev("turn_completed", "t1"),
      // A turn that called no tool has nothing to show behind its reply.
      ev("turn_started", "t2"),
      ev("assistant_text", "t2", { text: "Hello." }),
      ev("turn_completed", "t2"),
      // A turn still running isn't finished.
      ev("turn_started", "t3"),
      ev("tool_call", "t3", { call_id: "c4", name: "Bash", input: { command: "ls" } }),
    ]);
    expect(turns.map((t) => [t.turn, t.reply])).toEqual([["t1", "All good."], ["t2", "Hello."]]);
    const steps = stepsBySeq([reply(1, "Hello."), reply(2, "All good.")], turns);
    expect([...steps.keys()]).toEqual([2]);
    expect(steps.get(2)!.map((x) => (x.kind === "tool" ? `${x.name}:${x.status}` : x.text))).toEqual(["Checking.", "Read:done", "Bash:stopped", "list_waits:done"]);
  });

  it("gives a repeated reply's steps only to the newest message saying it, the turn's own", () => {
    const turn = (id: string, cmd: string) => [ev("turn_started", id), ev("tool_call", id, { call_id: `c_${id}`, name: "Bash", input: { command: cmd } }), ev("assistant_text", id, { text: "Done." }), ev("turn_completed", id)];
    const turns = finishedTurns([...turn("a", "first"), ...turn("b", "second")]);
    const steps = stepsBySeq([reply(1, "Done."), reply(5, "Something else"), reply(7, "Done."), reply(9, "Done.")], turns);
    // Two turns said it: the newest to the newest message, the older to the one before; the oldest has none.
    expect([...steps.entries()].map(([k, v]) => [k, v[0]!.kind === "tool" && v[0]!.summary])).toEqual([[9, "second"], [7, "first"]]);
  });

  it("shows an input nest cut short (mid-JSON) as it came, marked, with its main argument read from its start", () => {
    const cut = '{"file_path":"src/search/tags.ts","content":"export function indexTags(gadgets) {\\n  const index = new Map();';
    const t = liveTurn([ev("turn_started", "t9"), ev("tool_call", "t9", { call_id: "c1", name: "Write", input: cut })]);
    const tool = t!.steps[0]!;
    expect(tool).toMatchObject({ kind: "tool", name: "Write", summary: "src/search/tags.ts" });
    expect(tool.kind === "tool" && tool.input).toEqual([{ key: "input (cut short)", value: cut }]);
  });
});

describe("timeline", () => {
  const T0 = NOW - 60_000;
  const said = (key: string, ts_ms: number): Step => ({ kind: "text", key, ts_ms, text: key });
  const call = (key: string, ts_ms: number, status: ToolStep["status"] = "done"): Step => ({ kind: "tool", key, ts_ms, name: "Read", summary: key, input: [], result: null, status });
  const turn = (steps: Step[], running = true) => ({ turn: "trn_1", steps, running });
  // The log as it reads: an author group by its seqs, a stream part by its steps (+ its working line).
  const shape = (items: LogItem[]) =>
    items.flatMap((i) => (i.kind === "day" ? [] : i.kind === "group" ? [`${i.sender} ${i.messages.map((m) => m.seq).join(",")}`] : [`stream ${[...i.steps.map((s) => s.key), ...(i.working ? ["working"] : [])].join(",")}`]));
  // The message that started the turn, from before it.
  const asked = msg(1, "owner", T0 - 1_000);

  it("is the log as groupLog gives it while no turn is in progress", () => {
    const messages = [asked, msg(2, "manager", T0 + 5_000), msg(3, "owner", T0 + 9_000)];
    expect(timeline(messages, null, NOW)).toEqual(groupLog(messages, NOW));
  });

  it("puts the turn after every message when none was sent during it, as one live part", () => {
    expect(shape(timeline([msg(0, "manager", T0 - 9_000), asked], turn([said("a", T0 + 1_000), call("b", T0 + 2_000)]), NOW))).toEqual(["manager 0", "owner 1", "stream a,b,working"]);
  });

  it("splits the turn at a message sent during it: the steps up to its time above it, the later ones and the working line below", () => {
    // A step at the message's very time was already shown: above it.
    const items = timeline([asked, msg(2, "owner", T0 + 2_000)], turn([said("a", T0 + 1_000), call("b", T0 + 2_000), call("c", T0 + 3_000)]), NOW);
    expect(shape(items)).toEqual(["owner 1", "stream a,b", "owner 2", "stream c,working"]);
  });

  it("after the last step, the message is followed by the working line alone; a call still running keeps its place above, with nothing empty below", () => {
    expect(shape(timeline([asked, msg(2, "owner", T0 + 5_000)], turn([said("a", T0 + 1_000), call("b", T0 + 2_000)]), NOW))).toEqual(["owner 1", "stream a,b", "owner 2", "stream working"]);
    expect(shape(timeline([asked, msg(2, "owner", T0 + 5_000)], turn([said("a", T0 + 1_000), call("b", T0 + 2_000, "running")]), NOW))).toEqual(["owner 1", "stream a,b", "owner 2"]);
  });

  it("splits at each of several messages; one straight after another is the same group, with no empty part between", () => {
    const steps = [call("a", T0 + 1_000), call("b", T0 + 3_000), call("c", T0 + 5_000)];
    expect(shape(timeline([asked, msg(2, "owner", T0 + 2_000), msg(3, "owner", T0 + 4_000)], turn(steps), NOW))).toEqual(["owner 1", "stream a", "owner 2", "stream b", "owner 3", "stream c,working"]);
    expect(shape(timeline([asked, msg(2, "owner", T0 + 2_000), msg(3, "owner", T0 + 2_500)], turn(steps), NOW))).toEqual(["owner 1", "stream a", "owner 2,3", "stream b,c,working"]);
  });

  it("keeps a message from before the turn's first step above the whole stream, the one that started it too", () => {
    // `asked` is from before the start, the second from its start with nothing shown yet.
    expect(shape(timeline([asked, msg(2, "owner", T0)], turn([call("a", T0 + 1_000)]), NOW))).toEqual(["owner 1,2", "stream a,working"]);
  });

  it("never splits the turn at a manager's message: an earlier turn's reply nest reported late stays above it all", () => {
    expect(shape(timeline([asked, msg(2, "manager", T0 + 1_500)], turn([call("a", T0 + 1_000), call("b", T0 + 2_000)]), NOW))).toEqual(["owner 1", "manager 2", "stream a,b,working"]);
  });

  it("puts a message in flight after every step shown, and one never taken (Retry) last, after the stream", () => {
    const inFlight: ChatMessage = { ...msg(-20, "owner", T0), delivered: false, status: "owed" };
    const refused: ChatMessage = { ...msg(-10, "owner", T0 - 30_000), delivered: false, status: "failed", error: "offline" };
    expect(shape(timeline([asked, inFlight, refused], turn([call("a", T0 + 1_000), call("b", T0 + 2_000)]), NOW))).toEqual(["owner 1", "stream a,b", "owner -20", "stream working", "owner -10"]);
  });

  it("keeps the split once the turn has ended and is held for its reply, with no working line", () => {
    expect(shape(timeline([asked, msg(2, "owner", T0 + 2_000)], turn([call("a", T0 + 1_000), said("b", T0 + 3_000)], false), NOW))).toEqual(["owner 1", "stream a", "owner 2", "stream b"]);
    expect(shape(timeline([asked, msg(2, "owner", T0 + 5_000)], turn([call("a", T0 + 1_000)], false), NOW))).toEqual(["owner 1", "stream a", "owner 2"]);
  });
});

describe("quote", () => {
  it("puts each line behind \"> \" and leaves a blank line to write under", () => {
    expect(quote("a\nb")).toBe("> a\n> b\n\n");
  });
});
