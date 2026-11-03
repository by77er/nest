// The chat's pure parts: grouping by author and day, the turn in progress read from a trace, how a tool
// call reads as an activity, and the quote a reply starts from.
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../api/types";
import type { TraceEvent } from "../trace/model";
import { describeTool, GROUP_GAP_MS, groupLog, liveTurn, quote } from "./model";

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
  const ev = (type: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: NOW, type, turn: "trn_1", ...more }) as unknown as TraceEvent;

  it("is the running turn's text so far and the tool it's in", () => {
    const t = liveTurn([ev("turn_started"), ev("assistant_text", { text: "Looking." }), ev("tool_call", { call_id: "c1", name: "Read", input: JSON.stringify({ file_path: "src/a.ts" }) })]);
    expect(t).toEqual({ turn: "trn_1", text: "Looking.", activity: "Reading src/a.ts" });
  });

  it("drops the activity once the tool answers, and is nothing once the turn completes", () => {
    const started = [ev("turn_started"), ev("tool_call", { call_id: "c1", name: "Bash", input: { command: "ls" } }), ev("tool_result", { call_id: "c1", is_error: false })];
    expect(liveTurn(started)?.activity).toBeNull();
    expect(liveTurn([...started, ev("turn_completed", { stop_reason: "end_turn" })])).toBeNull();
    expect(liveTurn([])).toBeNull();
  });
});

describe("describeTool", () => {
  it("reads a call as what it does, and an MCP tool by its own name", () => {
    expect(describeTool("Bash", { command: "npm test" })).toBe("Running npm test");
    expect(describeTool("Edit", JSON.stringify({ file_path: "src/x.ts" }))).toBe("Editing src/x.ts");
    expect(describeTool("Grep", { pattern: "TODO" })).toBe("Searching for TODO");
    expect(describeTool("mcp__projects-board__write_spec", {})).toBe("Write spec");
    expect(describeTool("Read", "not json")).toBe("Reading");
  });
});

describe("quote", () => {
  it("puts each line behind \"> \" and leaves a blank line to write under", () => {
    expect(quote("a\nb")).toBe("> a\n> b\n\n");
  });
});
