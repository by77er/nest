// What the chat re-renders (README.md#the-manager-chat): typing re-renders the composer only, a poll's new
// message renders that message only, and the manager's stream re-renders the turn in progress only, never
// the log's other messages nor their Markdown, and never parses a finished turn's tool input again.
// Counted at the layout's `MessageRow` (one per message rendered) and react-markdown (one per parse).
import { act, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const counts = vi.hoisted(() => ({ rows: 0, markdown: 0 }));

vi.mock("../../layout", async (importOriginal) => {
  const layout = await importOriginal<typeof import("../../layout")>();
  const MessageRow = (props: Parameters<typeof layout.MessageRow>[0]) => {
    if (props["data-sender"] !== "stream") counts.rows += 1;
    return layout.MessageRow(props);
  };
  return { ...layout, MessageRow };
});
vi.mock("react-markdown", async (importOriginal) => {
  const md = await importOriginal<typeof import("react-markdown")>();
  const Original = md.default;
  return {
    ...md,
    default: (props: Parameters<typeof Original>[0]) => {
      counts.markdown += 1;
      return Original(props) as ReactNode;
    },
  };
});

const chat = () => screen.findByRole("tabpanel", { name: "Chat" });

/** A trace socket the test drives: each push is one render. */
function drivenTraceSocket() {
  let socket: { listeners: Record<string, ((e: { data?: string }) => void)[]> } | null = null;
  class Socket {
    listeners: Record<string, ((e: { data?: string }) => void)[]> = {};
    constructor(readonly url: string) {
      socket = this;
      setTimeout(() => this.emit("open", {}), 0);
    }
    emit(type: string, e: { data?: string }) {
      for (const l of this.listeners[type] ?? []) l(e);
    }
    addEventListener(type: string, l: (e: { data?: string }) => void) {
      (this.listeners[type] ??= []).push(l);
    }
    removeEventListener() {}
    send() {}
    close() {}
  }
  const push = async (...events: object[]) => {
    await waitFor(() => expect(socket?.listeners.message?.length).toBeGreaterThan(0));
    act(() => {
      for (const e of events) for (const l of socket!.listeners.message ?? []) l({ data: JSON.stringify(e) });
    });
  };
  return { Socket, push };
}

const T0 = Date.now() - 3_600_000;
/** `n` messages, alternating the owner's and the manager's (the manager's in Markdown), a minute apart. */
const msgs = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, k) => ({ seq: k + 1, at_ms: T0 + k * 30_000, sender: k % 2 ? "manager" : "owner", text: k % 2 ? `Reply **${k + 1}**` : `Message ${k + 1}`, delivered: true, status: "done" as const, error: null }));

/** A FakeApi whose chat answers every message at once (the page shows them all, as after Load older). */
function apiWith(messages: ChatMessage[]) {
  const api = new FakeApi();
  api.chat = messages;
  const inner = api.fetch;
  Object.defineProperty(api, "fetch", {
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
      if ((init?.method ?? "GET") === "GET" && /\/api\/projects\/[^/]+\/chat$/.test(url.pathname) && !url.searchParams.has("before")) {
        return new Response(JSON.stringify(api.chat), { headers: { "content-type": "application/json" } });
      }
      return inner(input, init);
    },
  });
  return api;
}

const reset = () => {
  counts.rows = 0;
  counts.markdown = 0;
};

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => window.localStorage.clear());

describe("what the chat re-renders", () => {
  it("typing 20 characters with 100 messages shown renders no message and no Markdown", async () => {
    const api = apiWith(msgs(100));
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Message 99");
    await waitFor(() => expect(within(c).getAllByRole("button", { name: "Message actions" })).toHaveLength(100));
    const box = within(c).getByLabelText("Message to the manager");
    // The counters count: the log's first render drew every message and parsed the manager's Markdown.
    expect(counts.rows).toBeGreaterThanOrEqual(100);
    expect(counts.markdown).toBeGreaterThanOrEqual(50);
    reset();
    const t = performance.now();
    await user.type(box, "abcdefghijklmnopqrst");
    const ms = performance.now() - t;
    expect(box).toHaveValue("abcdefghijklmnopqrst");
    console.info(`[render] typing 20 chars, 100 messages: Message ${counts.rows}, Markdown ${counts.markdown}, ${ms.toFixed(0)} ms`);
    expect(counts.rows).toBe(0);
    expect(counts.markdown).toBe(0);
  });

  it("one new message appended to 100, into the last group, renders that message only", async () => {
    const api = apiWith(msgs(100));
    const { queryClient } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Message 99");
    reset();
    // The manager's, 30 s after its last: it joins that message's group, which is drawn again around it.
    api.chat = [...api.chat, { seq: 101, at_ms: T0 + 100 * 30_000, sender: "manager", text: "Message 101", delivered: true, status: "done", error: null }];
    const t = performance.now();
    await act(() => queryClient.refetchQueries());
    await within(c).findByText("Message 101");
    // Whatever follows the arrival (its announcement, the scroll) settles first.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    const ms = performance.now() - t;
    console.info(`[render] 1 new message after 100: Message ${counts.rows}, Markdown ${counts.markdown}, ${ms.toFixed(0)} ms`);
    expect(counts.rows).toBe(1);
    // Its own Markdown only.
    expect(counts.markdown).toBe(1);
  });

  it("50 trace events of a turn, with 100 messages and 30 finished turns held, render no message, no Markdown of the log, and parse no finished turn's input", async () => {
    let seq = 0;
    const ev = (turn: string, type: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: T0 + seq, type, turn, ...more });
    // 30 finished turns, each a tool call (its input a string, as nest sends it) and its reply: the
    // manager's messages 2, 4, …, 60.
    const finished: object[] = [];
    for (let k = 0; k < 30; k++) {
      const turn = `trn_${k}`;
      finished.push(
        ev(turn, "turn_started"),
        ev(turn, "tool_call", { call_id: `c${k}`, name: "Bash", input: JSON.stringify({ command: `finished-input ${k}`, description: "x".repeat(2000) }) }),
        ev(turn, "tool_result", { call_id: `c${k}`, is_error: false, summary: "ok" }),
        ev(turn, "assistant_text", { text: `Reply **${2 * (k + 1)}**` }),
        ev(turn, "turn_completed", { stop_reason: "end_turn" }),
      );
    }
    const trace = drivenTraceSocket();
    vi.stubGlobal("WebSocket", trace.Socket);
    const api = apiWith(msgs(100));
    renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Message 99");
    await trace.push(...finished, { type: "live" }, ev("trn_live", "turn_started"));
    await waitFor(() => expect(within(c).getAllByRole("button", { name: /^Used 1 tool$/ })).toHaveLength(30));
    await within(c).findByText("Working…");
    reset();
    const parse = vi.spyOn(JSON, "parse");
    try {
      const t = performance.now();
      for (let i = 0; i < 50; i++) {
        const k = Math.floor(i / 2);
        await trace.push(i % 2 === 0 ? ev("trn_live", "tool_call", { call_id: `l${k}`, name: "Read", input: JSON.stringify({ file_path: `live-${k}.ts` }) }) : ev("trn_live", "tool_result", { call_id: `l${k}`, is_error: false, summary: "ok" }));
      }
      await within(c).findByRole("button", { name: "Read live-24.ts, done" });
      const ms = performance.now() - t;
      const finishedParses = parse.mock.calls.filter(([s]) => typeof s === "string" && s.startsWith("{") && s.includes("finished-input")).length;
      console.info(`[render] 50 trace events, 100 messages, 30 finished turns: Message ${counts.rows}, Markdown ${counts.markdown}, finished inputs parsed ${finishedParses}, ${ms.toFixed(0)} ms`);
      expect(counts.rows).toBe(0);
      expect(counts.markdown).toBe(0);
      expect(finishedParses).toBe(0);
    } finally {
      parse.mockRestore();
    }
  });
});
