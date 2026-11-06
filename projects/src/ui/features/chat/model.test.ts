// The chat's pure parts: grouping by author and day, the turn in progress read from a trace as steps, the
// steps found again for each reply, and the quote a reply starts from.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { GROUP_GAP_MS, groupLog, liveTurn, quote, stepsByReply } from "./model";

const NOW = new Date(2026, 10, 2, 15, 0).getTime();
const msg = (seq: number, sender: string, at_ms: number): ChatMessage => ({ seq, at_ms, sender, text: `m${seq}`, delivered: true, error: null });

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

describe("stepsByReply", () => {
  let seq = 100;
  const ev = (type: string, turn: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: NOW, type, turn, ...more }) as unknown as TraceEvent;

  it("finds a finished turn's steps by its reply (its last text), and a call the turn never answered reads stopped", () => {
    const steps = stepsByReply([
      ev("turn_started", "t1"),
      ev("assistant_text", "t1", { text: "Checking." }),
      ev("tool_call", "t1", { call_id: "c1", name: "Read", input: { file_path: "a.ts" } }),
      ev("tool_call", "t1", { call_id: "c2", name: "Bash", input: { command: "npm test" } }),
      ev("tool_result", "t1", { call_id: "c1", is_error: false, summary: "ok" }),
      ev("assistant_text", "t1", { text: "  All good.  " }),
      ev("turn_completed", "t1"),
      // A turn that called no tool has nothing to show behind its reply.
      ev("turn_started", "t2"),
      ev("assistant_text", "t2", { text: "Hello." }),
      ev("turn_completed", "t2"),
      // A turn still running isn't a reply yet.
      ev("turn_started", "t3"),
      ev("tool_call", "t3", { call_id: "c3", name: "Bash", input: { command: "ls" } }),
      ev("assistant_text", "t3", { text: "Partial." }),
    ]);
    expect([...steps.keys()]).toEqual(["All good."]);
    const s = steps.get("All good.")!;
    expect(s.map((x) => (x.kind === "tool" ? `${x.name}:${x.status}` : x.text))).toEqual(["Checking.", "Read:done", "Bash:stopped"]);
  });
});

describe("quote", () => {
  it("puts each line behind \"> \" and leaves a blank line to write under", () => {
    expect(quote("a\nb")).toBe("> a\n> b\n\n");
  });
});
