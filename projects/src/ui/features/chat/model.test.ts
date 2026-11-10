// The chat's pure parts: grouping by author and day, the turn in progress read from a trace as steps, the
// steps found again for each reply, and the quote a reply starts from.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { finishedTurns, GROUP_GAP_MS, groupLog, liveTurn, quote, stepsBySeq } from "./model";

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

describe("quote", () => {
  it("puts each line behind \"> \" and leaves a blank line to write under", () => {
    expect(quote("a\nb")).toBe("> a\n> b\n\n");
  });
});
