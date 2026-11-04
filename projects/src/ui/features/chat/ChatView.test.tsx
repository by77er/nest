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
let seq = 0;
const ev = (type: string, more: Record<string, unknown> = {}) => ({ seq: ++seq, ts_ms: Date.now(), type, turn: "trn_9", ...more });
const msgs = (n: number, from = 1) => Array.from({ length: n }, (_, k) => ({ seq: from + k, at_ms: Date.now() - (n - k) * 1000, sender: k % 2 ? "manager" : "owner", text: `Message ${from + k}`, delivered: true, error: null }));

afterEach(() => vi.unstubAllGlobals());
// Drafts are kept per project in the browser: each test starts with none.
beforeEach(() => window.localStorage.clear());

describe("the chat", () => {
  it("streams the manager's turn as it runs, with what it's doing, and Stop interrupts it", async () => {
    vi.stubGlobal("WebSocket", traceSocket([ev("turn_started"), ev("assistant_text", { text: "Checking the migration first." }), ev("tool_call", { call_id: "c1", name: "Bash", input: JSON.stringify({ command: "rg sslmode" }) })]));
    const api = new FakeApi();
    const { user } = renderApp("/projects/prj_one/manager", api);
    const c = await chat();
    // The cursor is inline: the paragraph's last character, right after the last word.
    const stream = await within(c).findByText("Checking the migration first.\u258C");
    expect(stream.closest("[data-sender=stream]")).not.toBeNull();
    expect(within(c).getByText("Running rg sslmode")).toBeInTheDocument();
    await user.click(within(c).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(api.interrupted).toBe(1));
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
