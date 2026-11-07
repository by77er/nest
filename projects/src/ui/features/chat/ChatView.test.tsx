// The chat with the manager, on its own page (/projects/:id/manager): the log as the Worker keeps it,
// undelivered messages flagged with why, and the composer posting the owner's words.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exact } from "../../common/time";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const chat = () => screen.findByRole("tabpanel", { name: "Chat" });

/** A trace socket that replays `events` once it's listened to, as the Worker's backlog does. */
function traceSocket(events: object[]) {
  return class {
    private listeners: Record<string, ((e: { data?: string }) => void)[]> = {};
    constructor(readonly url: string) {
      setTimeout(() => {
        this.emit("open", {});
        for (const e of [...events, { type: "live" }]) this.emit("message", { data: JSON.stringify(e) });
      }, 0);
    }
    private emit(type: string, e: { data?: string }) {
      for (const l of this.listeners[type] ?? []) l(e);
    }
    addEventListener(type: string, l: (e: { data?: string }) => void) {
      (this.listeners[type] ??= []).push(l);
    }
    removeEventListener() {}
    send() {}
    close() {}
  };
}
/** The same, but each message in a tick of its own (React renders between them), as a real socket's backlog. */
function slowTraceSocket(events: object[], gapMs = 15) {
  return class {
    private listeners: Record<string, ((e: { data?: string }) => void)[]> = {};
    constructor(readonly url: string) {
      const all = [...events, { type: "live" }];
      setTimeout(() => this.emit("open", {}), 0);
      all.forEach((e, i) => setTimeout(() => this.emit("message", { data: JSON.stringify(e) }), (i + 1) * gapMs));
    }
    private emit(type: string, e: { data?: string }) {
      for (const l of this.listeners[type] ?? []) l(e);
    }
    addEventListener(type: string, l: (e: { data?: string }) => void) {
      (this.listeners[type] ??= []).push(l);
    }
    removeEventListener() {}
    send() {}
    close() {}
  };
}
let seq = 0;
const ev = (type: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: Date.now(), type, turn: "trn_9", ...more });
const msgs = (n: number, from = 1) => Array.from({ length: n }, (_, k) => ({ seq: from + k, at_ms: Date.now() - (n - k) * 1000, sender: k % 2 ? "manager" : "owner", text: `Message ${from + k}`, delivered: true, error: null }));

afterEach(() => vi.unstubAllGlobals());
// Drafts are kept per project in the browser: each test starts with none.
beforeEach(() => window.localStorage.clear());

describe("the chat", () => {
  it("streams the manager's turn as it runs: what it said, each tool call a row that opens and closes, and Stop interrupts it", async () => {
    vi.stubGlobal("WebSocket", traceSocket([ev("turn_started"), ev("assistant_text", { text: "Checking the migration first." }), ev("tool_call", { call_id: "c1", name: "Bash", input: JSON.stringify({ command: "rg sslmode", description: "Find it" }) })]));
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    const said = await within(c).findByText("Checking the migration first.");
    const stream = said.closest("[data-sender=stream]") as HTMLElement;
    expect(stream).not.toBeNull();
    // The call: its name, its main argument and that it's running, closed until asked.
    const row = within(stream).getByRole("button", { name: "Bash rg sslmode, running" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    const detail = document.getElementById(row.getAttribute("aria-controls")!)!;
    expect(detail).not.toBeVisible();
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(detail).toBeVisible());
    // Its input as fields, not JSON, and no result yet.
    expect(detail).toHaveTextContent("commandrg sslmode");
    expect(detail).toHaveTextContent("descriptionFind it");
    expect(detail).not.toHaveTextContent("{");
    expect(detail).toHaveTextContent("ResultRunning…");
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(detail).not.toBeVisible());
    // A tool running shows itself: no separate working line.
    expect(within(stream).queryByText("Working…")).toBeNull();
    await user.click(within(c).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.interrupted).toBe(1));
  });

  it("between steps, a running turn says it's working", async () => {
    vi.stubGlobal("WebSocket", traceSocket([ev("turn_started"), ev("tool_call", { call_id: "c1", name: "Read", input: { file_path: "a.ts" } }), ev("tool_result", { call_id: "c1", is_error: false, summary: "ok" })]));
    renderApp("/projects/prj_one/manager", new FakeApi());
    const c = await chat();
    const row = await within(c).findByRole("button", { name: "Read a.ts, done" });
    expect(within(row.closest("[data-sender=stream]") as HTMLElement).getByText("Working…")).toBeInTheDocument();
  });

  it("a reply keeps the steps behind it while the trace holds its turn: closed as \"Used n tools\", opening onto the rows", async () => {
    vi.stubGlobal("WebSocket", traceSocket([
      ev("turn_started", { turn: "trn_1" }),
      ev("tool_call", { turn: "trn_1", call_id: "c1", name: "mcp__projects-board__list_tasks", input: {} }),
      ev("tool_result", { turn: "trn_1", call_id: "c1", is_error: false, summary: "3 tasks" }),
      ev("tool_call", { turn: "trn_1", call_id: "c2", name: "Bash", input: { command: "git push" } }),
      ev("tool_result", { turn: "trn_1", call_id: "c2", is_error: true, summary: "403" }),
      ev("assistant_text", { turn: "trn_1", text: "Three tasks; the push was refused." }),
      ev("turn_completed", { turn: "trn_1", stop_reason: "end_turn" }),
    ]));
    const api = new FakeApi();
    api.chat = [
      { seq: 1, at_ms: Date.now() - 2000, sender: "manager", text: "An older reply, its turn long gone.", delivered: true, error: null },
      { seq: 2, at_ms: Date.now(), sender: "manager", text: "Three tasks; the push was refused.", delivered: true, error: null },
    ];
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    const toggle = await within(c).findByRole("button", { name: "Used 2 tools" });
    const reply = toggle.closest("[data-sender=manager]") as HTMLElement;
    expect(reply).toHaveAttribute("data-seq", "2");
    expect(within(c).getAllByRole("button", { name: /^Used/ })).toHaveLength(1);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    const failed = await within(reply).findByRole("button", { name: "Bash git push, failed" });
    expect(failed).toBeVisible();
    expect(within(reply).getByRole("button", { name: "list_tasks, done" })).toBeVisible();
    await user.click(failed);
    expect(document.getElementById(failed.getAttribute("aria-controls")!)).toHaveTextContent("Result403");
    // The turn is over: no stream, no Stop.
    expect(c.querySelector("[data-sender=stream]")).toBeNull();
  });

  it("while the manager waits for the owner's reply, the composer says so, with the time left; otherwise it gives the keys", async () => {
    const api = new FakeApi();
    const { unmount } = renderApp("/projects/prj_one/manager", api);
    let c = await chat();
    expect(within(c).getByText("Enter to send · Shift+Enter for a new line")).toBeInTheDocument();
    unmount();
    api.waits = { pending: [{ id: "aw_1", kind: "reply", target: null, want: null, created_ms: Date.now(), deadline_ms: Date.now() + 2 * 3_600_000 + 60_000, resolved_ms: null, outcome: null, detail: null }], recent: [] };
    renderApp("/projects/prj_one/manager", api);
    c = await chat();
    expect(await within(c).findByText(/^Waiting for your reply · 2 h/)).toBeInTheDocument();
  });

  it("a turn that ends without a reply (stopped) leaves no stream behind, its calls never left spinning", async () => {
    vi.stubGlobal("WebSocket", slowTraceSocket([ev("turn_started", { turn: "trn_s" }), ev("tool_call", { turn: "trn_s", call_id: "c1", name: "Bash", input: { command: "sleep 100" } }), ev("turn_completed", { turn: "trn_s", stop_reason: "interrupted" })], 60));
    renderApp("/projects/prj_one/manager", new FakeApi());
    const c = await chat();
    // Seen running first (its own tick), then gone once the turn ends with nothing to say.
    expect(await within(c).findByRole("button", { name: "Bash sleep 100, running" })).toBeInTheDocument();
    await waitFor(() => expect(c.querySelector("[data-sender=stream]")).toBeNull());
  });

  it("reopening the chat, a replayed backlog doesn't leave the last turn's stream under its own reply", async () => {
    vi.stubGlobal("WebSocket", slowTraceSocket([
      ev("turn_started", { turn: "trn_r" }),
      ev("tool_call", { turn: "trn_r", call_id: "c1", name: "Read", input: { file_path: "a.ts" } }),
      ev("tool_result", { turn: "trn_r", call_id: "c1", is_error: false, summary: "ok" }),
      ev("assistant_text", { turn: "trn_r", text: "Read it." }),
      ev("turn_completed", { turn: "trn_r", stop_reason: "end_turn" }),
    ], 60));
    const api = new FakeApi();
    api.chat = [{ seq: 1, at_ms: Date.now(), sender: "manager", text: "Read it.", delivered: true, error: null }];
    renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Read it.");
    // The replay looks live for a moment (its own ticks)…
    await waitFor(() => expect(c.querySelector("[data-sender=stream]")).not.toBeNull());
    // …then the turn is the reply's, behind it, once.
    expect(await within(c).findByRole("button", { name: "Used 1 tool" })).toBeInTheDocument();
    await waitFor(() => expect(c.querySelector("[data-sender=stream]")).toBeNull());
    expect(within(c).getAllByText("Read it.")).toHaveLength(1);
  });

  it("opening a reply's steps at the end stops following: what opened isn't scrolled away", async () => {
    vi.stubGlobal("WebSocket", traceSocket([
      ev("turn_started", { turn: "trn_o" }),
      ev("tool_call", { turn: "trn_o", call_id: "c1", name: "Read", input: { file_path: "a.ts" } }),
      ev("tool_result", { turn: "trn_o", call_id: "c1", is_error: false, summary: "ok" }),
      ev("assistant_text", { turn: "trn_o", text: "Message 4" }),
      ev("turn_completed", { turn: "trn_o", stop_reason: "end_turn" }),
    ]));
    let total = 1000;
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => total);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    try {
      const api = new FakeApi();
      api.chat = msgs(4);
      const { user, queryClient } = renderApp("/projects/prj_one/manager", api);
      const c = await chat();
      const toggle = await within(c).findByRole("button", { name: "Used 1 tool" });
      const log = within(c).getByRole("log", { name: "Conversation with the manager" });
      expect(log.scrollTop).toBe(1000);
      await user.click(toggle);
      // The steps grow the log; a message arriving now doesn't pull the reader to the end.
      total = 1400;
      api.chat = msgs(5);
      await queryClient.refetchQueries();
      await within(c).findByText("Message 5");
      expect(log.scrollTop).toBe(1000);
      expect(await within(c).findByRole("button", { name: "Jump to latest · 1 new" })).toBeInTheDocument();
    } finally {
      height.mockRestore();
      client.mockRestore();
    }
  });

  it("a running turn shows its last four steps, the earlier calls folded above them, opening on asking", async () => {
    // In seq order, as nest sends them.
    const head = [ev("turn_started", { turn: "trn_b" }), ev("assistant_text", { turn: "trn_b", text: "Reading them all." })];
    const calls = Array.from({ length: 7 }, (_, i) => [
      ev("tool_call", { turn: "trn_b", call_id: `b${i}`, name: "Read", input: { file_path: `f${i}.ts` } }),
      ev("tool_result", { turn: "trn_b", call_id: `b${i}`, is_error: false, summary: "ok" }),
    ]).flat();
    vi.stubGlobal("WebSocket", traceSocket([...head, ...calls]));
    const { user } = renderApp("/projects/prj_one/manager", new FakeApi());
    const c = await chat();
    // Its text stays out of the fold (what it last said), so three calls are behind it.
    const fold = await within(c).findByRole("button", { name: "+3 earlier steps" });
    const stream = fold.closest("[data-sender=stream]") as HTMLElement;
    // The last four calls show; the first three are behind the fold.
    const shown = () => within(stream).queryAllByRole("button", { name: /^Read f\d\.ts, done$/ }).map((b) => /^Read (\S+),/.exec(b.getAttribute("aria-label")!)![1]);
    expect(shown()).toEqual(["f3.ts", "f4.ts", "f5.ts", "f6.ts"]);
    expect(fold).toHaveAttribute("aria-expanded", "false");
    await user.click(fold);
    expect(await within(stream).findByRole("button", { name: "Read f0.ts, done" })).toBeVisible();
    expect(within(stream).getByText("Reading them all.")).toBeVisible();
    expect(within(stream).getAllByText("Reading them all.")).toHaveLength(1);
  });

  it("folding a running turn keeps what it last said in view, and names a failure behind the fold", async () => {
    const head = [ev("turn_started", { turn: "trn_f" }), ev("tool_call", { turn: "trn_f", call_id: "f0", name: "Bash", input: { command: "git push" } }), ev("tool_result", { turn: "trn_f", call_id: "f0", is_error: true, summary: "403" }), ev("assistant_text", { turn: "trn_f", text: "The push was refused; checking the grant." })];
    const calls = Array.from({ length: 5 }, (_, i) => [
      ev("tool_call", { turn: "trn_f", call_id: `g${i}`, name: "Read", input: { file_path: `g${i}.ts` } }),
      ev("tool_result", { turn: "trn_f", call_id: `g${i}`, is_error: false, summary: "ok" }),
    ]).flat();
    vi.stubGlobal("WebSocket", traceSocket([...head, ...calls]));
    const { user } = renderApp("/projects/prj_one/manager", new FakeApi());
    const c = await chat();
    // Six steps behind four shown would fold the text too; it stays out, above the fold, and the fold says what failed.
    const fold = await within(c).findByRole("button", { name: "+2 earlier steps · 1 failed" });
    const stream = fold.closest("[data-sender=stream]") as HTMLElement;
    const said = within(stream).getByText("The push was refused; checking the grant.");
    expect(said).toBeVisible();
    expect(said.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The failed call is behind the fold (not shown, or not mounted, until it opens).
    const failedRow = within(stream).queryByRole("button", { name: "Bash git push, failed", hidden: true });
    if (failedRow) expect(failedRow).not.toBeVisible();
    await user.click(fold);
    expect(await within(stream).findByRole("button", { name: "Bash git push, failed" })).toBeVisible();
  });

  it("an empty chat opens at its top, not following an end there's nothing at", async () => {
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    try {
      renderApp("/projects/prj_one/manager", new FakeApi());
      const c = await chat();
      await within(c).findByRole("button", { name: "What's blocked right now?" });
      const log = within(c).getByRole("log", { name: "Conversation with the manager" });
      await new Promise((r) => setTimeout(r, 50));
      expect(log.scrollTop).toBe(0);
    } finally {
      height.mockRestore();
      client.mockRestore();
    }
  });

  it("on a desktop, Enter sends and Shift+Enter is a new line", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    const box = within(c).getByLabelText("Message to the manager");
    await user.type(box, "First line{Shift>}{Enter}{/Shift}second line");
    expect(box).toHaveValue("First line\nsecond line");
    expect(api.writes).toEqual([]);
    await user.type(box, "{Enter}");
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/chat", body: { text: "First line\nsecond line" } }]));
    expect(box).toHaveValue("");
    // Enter on an empty composer sends nothing.
    await user.type(box, "{Enter}");
    expect(api.writes).toHaveLength(1);
  });

  it("follows new messages at the bottom; scrolled up, it stays put and offers the way back with a count", async () => {
    // jsdom has no layout: the log is 1,000 px of content in a 200 px window.
    const height = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
    try {
      const api = new FakeApi();
      api.chat = msgs(4);
      const { queryClient } = renderApp("/projects/prj_one/manager", api);
      const c = await chat();
      await within(c).findByText("Message 4");
      const log = within(c).getByRole("log", { name: "Conversation with the manager" });
      // Opened at the end.
      expect(log.scrollTop).toBe(1000);
      expect(within(c).queryByRole("button", { name: /Jump to latest/ })).toBeNull();
      // At the end, a new message is followed.
      api.chat = msgs(5);
      await queryClient.refetchQueries();
      await within(c).findByText("Message 5");
      expect(log.scrollTop).toBe(1000);
      // Scrolled up: the pill offers the way back, and a new message doesn't move the log.
      // (The browser reports the chat's own scroll to the end as a scroll, then the reader's up.)
      fireEvent.scroll(log);
      log.scrollTop = 300;
      fireEvent.scroll(log);
      expect(await within(c).findByRole("button", { name: "Jump to latest" })).toBeInTheDocument();
      api.chat = msgs(6);
      await queryClient.refetchQueries();
      await within(c).findByText("Message 6");
      expect(log.scrollTop).toBe(300);
      const pill = await within(c).findByRole("button", { name: "Jump to latest · 1 new" });
      fireEvent.click(pill);
      expect(log.scrollTop).toBe(1000);
      await waitFor(() => expect(within(c).queryByRole("button", { name: /Jump to latest/ })).toBeNull());
    } finally {
      height.mockRestore();
      client.mockRestore();
    }
  });

  it("with no turn running there's no stream and no Stop", async () => {
    vi.stubGlobal("WebSocket", traceSocket([ev("turn_started"), ev("assistant_text", { text: "Done." }), ev("turn_completed", { stop_reason: "end_turn" })]));
    renderApp("/projects/prj_one/manager", new FakeApi());
    const c = await chat();
    await waitFor(() => expect(within(c).getByLabelText("Message to the manager")).toBeInTheDocument());
    expect(within(c).queryByRole("button", { name: "Stop" })).toBeNull();
    expect(c.querySelector("[data-sender=stream]")).toBeNull();
  });

  it("a message's exact time is in its actions (hover shows it too), so the keyboard and touch reach it", async () => {
    const api = new FakeApi();
    const at = new Date(2026, 10, 2, 9, 30).getTime();
    api.chat = [{ seq: 1, at_ms: at, sender: "manager", text: "Hello", delivered: true, error: null }];
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Hello");
    // The time line isn't a tab stop of its own.
    expect(c.querySelector("time")).not.toHaveAttribute("tabindex");
    await user.click(within(c).getByRole("button", { name: "Message actions" }));
    expect(await screen.findByText(exact(at))).toBeInTheDocument();
  });

  it("\"Quote in a reply\" quotes into the composer and puts focus there, the caret at the end", async () => {
    const api = new FakeApi();
    api.chat = [{ seq: 1, at_ms: Date.now(), sender: "manager", text: "Line one\nLine two", delivered: true, error: null }];
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText(/Line one/);
    await user.click(within(c).getByRole("button", { name: "Message actions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Quote in a reply/ }));
    const box = within(c).getByLabelText("Message to the manager") as HTMLTextAreaElement;
    await waitFor(() => expect(box).toHaveFocus());
    expect(box.value).toBe("> Line one\n> Line two\n\n");
    expect(box.selectionStart).toBe(box.value.length);
  });

  it("on touch, Enter is a new line and Send sends; the Enter hint isn't shown", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)", media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    const box = within(c).getByLabelText("Message to the manager");
    await user.type(box, "First line{Enter}second line");
    expect(box).toHaveValue("First line\nsecond line");
    expect(api.writes).toEqual([]);
    expect(within(c).queryByText(/Enter to send/)).toBeNull();
    await user.click(within(c).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/chat", body: { text: "First line\nsecond line" } }]));
  });

  it("a chat that can't be loaded shows why, and no turn streaming under it", async () => {
    vi.stubGlobal("WebSocket", traceSocket([ev("turn_started"), ev("assistant_text", { text: "Still going." })]));
    const api = new FakeApi();
    // Every answer fails (a poll asks again).
    for (let i = 0; i < 10; i++) api.fail(/^GET .*\/chat$/, 500, "ProjectDO is unavailable");
    renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    expect(await within(c).findByText("The chat couldn't be loaded")).toBeInTheDocument();
    expect(c.querySelector("[data-sender=stream]")).toBeNull();
  });

  it("an empty chat offers starters that fill the composer, never send", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await user.click(await within(c).findByRole("button", { name: "What's blocked right now?" }));
    expect(within(c).getByLabelText("Message to the manager")).toHaveValue("What's blocked right now?");
    expect(api.writes).toEqual([]);
  });

  it("scrolled to the top, loads the 50 before the oldest shown, once, and keeps them in order", async () => {
    const api = new FakeApi();
    api.chat = msgs(80);
    renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    await within(c).findByText("Message 80");
    expect(within(c).queryByText("Message 30")).toBeNull();
    const log = within(c).getByRole("log", { name: "Conversation with the manager" });
    log.scrollTop = 0;
    fireEvent.scroll(log);
    await within(c).findByText("Message 30");
    const shown = [...c.querySelectorAll("[data-seq]")].map((m) => Number(m.getAttribute("data-seq")));
    expect(shown[0]).toBe(1);
    expect(shown).toEqual([...shown].sort((x, y) => x - y));
    expect(new Set(shown).size).toBe(shown.length);
  });

  it("the Manager row shows unread replies elsewhere, and reading the chat clears them", async () => {
    window.localStorage.clear();
    const api = new FakeApi();
    api.chat = msgs(4);
    const { user } = renderApp("/projects/prj_one/board", api);
    const dot = await screen.findByLabelText("2 unread messages");
    expect(dot.closest("a")).toHaveTextContent("Manager");
    await user.click(screen.getByRole("link", { name: /Manager/ }));
    await chat();
    await waitFor(() => expect(screen.queryByLabelText(/unread message/)).toBeNull());
  });

  it("shows the manager's replies and flags only the owner's undelivered messages, with the reason", async () => {
    const api = new FakeApi();
    api.chat = [
      { seq: 1, at_ms: 1, sender: "owner", text: "Plan the widgets", delivered: true, error: null },
      { seq: 2, at_ms: 2, sender: "manager", text: "Three tasks, coming up", delivered: true, error: null },
      { seq: 3, at_ms: 3, sender: "owner", text: "And a fourth", delivered: false, error: "the manager isn't started yet" },
      { seq: 4, at_ms: 4, sender: "app", text: "The manager ended (exited).", delivered: true, error: null },
    ];
    renderApp("/projects/prj_one/manager", api);
    const c = await chat();

    await within(c).findByText("Three tasks, coming up");
    const flagged = c.querySelectorAll('[data-marker="undelivered"]');
    expect(flagged).toHaveLength(1);
    const msg = flagged[0]!.closest("[data-sender]")!;
    expect(msg).toHaveTextContent("And a fourth");
    expect(msg).toHaveTextContent("the manager isn't started yet");
    expect(flagged[0]!.getAttribute("style")).toContain("--mantine-color-warning-");
  });

  it("sends what the owner wrote, trimmed, and clears the composer", async () => {
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();

    const box = within(c).getByLabelText("Message to the manager");
    expect(within(c).getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "  Spec the first task  ");
    await user.click(within(c).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/chat", body: { text: "Spec the first task" } }]));
    expect(box).toHaveValue("");
    expect(await within(c).findByText("Spec the first task")).toBeInTheDocument();
  });

  it("a message that isn't taken stays in the log, not delivered, with Retry; the composer is free", async () => {
    const api = new FakeApi();
    api.fail(/^POST .*\/chat$/, 503, "ProjectDO is unavailable");
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();

    const box = within(c).getByLabelText("Message to the manager");
    await user.type(box, "Hello{Control>}{Enter}{/Control}");
    expect(await screen.findByText("ProjectDO is unavailable")).toBeInTheDocument();
    // Kept where it was written, marked, and the composer is cleared for the next one.
    const row = (await within(c).findByText("Hello")).closest("[data-sender=owner]") as HTMLElement;
    expect(row).toHaveTextContent(/not delivered/i);
    // Said there, once: no toast besides.
    expect(screen.queryByText("That didn't work")).toBeNull();
    expect(screen.queryByText("The message wasn't sent")).toBeNull();
    expect(box).toHaveValue("");
    // Retry sends it again (the failure was once); taken, it's an ordinary message.
    await user.click(within(row).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(api.writes.filter((w) => w.method === "POST" && w.path.endsWith("/chat"))).toHaveLength(2));
    await waitFor(() => expect(within(c).queryByText(/not delivered/i)).toBeNull());
    expect(within(c).getByText("Hello")).toBeInTheDocument();
  });
});
