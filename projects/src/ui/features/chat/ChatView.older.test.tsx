// Loading older messages (README.md#performance): each reach of the top asks for one page, however many
// scroll events come before the page shows it's loading, and the next reach asks for the page before it.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../api/types";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";
import { RecordingSocket } from "../../test/sockets";

const T0 = Date.now() - 3_600_000;
const msgs = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, k) => ({ seq: k + 1, at_ms: T0 + k * 30_000, sender: k % 2 ? "manager" : "owner", text: `Message ${k + 1}`, delivered: true, status: "done" as const, error: null }));

afterEach(() => vi.unstubAllGlobals());

describe("the chat's older messages", () => {
  it("a burst of scroll events at the top asks for one page; the next reach for the page before it", async () => {
    vi.stubGlobal("WebSocket", RecordingSocket);
    const api = new FakeApi();
    api.chat = msgs(160);
    const older: string[] = [];
    const inner = api.fetch;
    Object.defineProperty(api, "fetch", {
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input), "http://localhost");
        if (/\/chat$/.test(url.pathname) && url.searchParams.has("before")) older.push(url.searchParams.get("before")!);
        return inner(input, init);
      },
    });
    renderApp("/projects/prj_one/manager", api);
    const log = await screen.findByRole("log", { name: "Conversation with the manager" });
    await within(log).findByText("Message 160");
    // At the top (jsdom has no layout: scrollTop is 0): five scroll events in one task, as a wheel gives.
    for (let i = 0; i < 5; i++) fireEvent.scroll(log);
    await within(log).findByText("Message 61");
    await waitFor(() => expect(screen.queryByText("Loading older messages")).toBeNull());
    expect(older).toEqual(["111"]);
    // Reaching the top again: the page before it, once.
    for (let i = 0; i < 5; i++) fireEvent.scroll(log);
    await within(log).findByText("Message 11");
    await waitFor(() => expect(screen.queryByText("Loading older messages")).toBeNull());
    expect(older).toEqual(["111", "61"]);
  });
});
