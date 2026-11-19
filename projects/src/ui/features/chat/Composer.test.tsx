// The composer's draft (README.md#the-manager-chat: "the draft is kept per project in the browser"): saved
// a moment after typing stops rather than on every keystroke, and never lost: saved at once on sending,
// on leaving (unmount, another project), and when the page is hidden or left.
import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../../api/queryClient";
import { FakeApi } from "../../test/fakeApi";
import { theme } from "../../theme";
import { ChatView } from "./ChatView";
import { DRAFT_SAVE_MS } from "./Composer";

const draft = (projectId: string) => window.localStorage.getItem(`nest-projects:chat-draft:${projectId}`);

function renderChat(projectId = "prj_one") {
  const api = new FakeApi();
  vi.stubGlobal("fetch", api.fetch);
  const client = createQueryClient();
  const ui = (id: string) => (
    <MantineProvider theme={theme} env="test">
      <QueryClientProvider client={client}>
        <ChatView projectId={id} agent={null} />
      </QueryClientProvider>
    </MantineProvider>
  );
  const view = render(ui(projectId));
  const box = () => screen.getByLabelText("Message to the manager") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
  return { ...view, api, box, type, switchTo: (id: string) => view.rerender(ui(id)) };
}

beforeEach(() => {
  window.localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the composer's draft", () => {
  it(`is saved ${DRAFT_SAVE_MS} ms after the last keystroke, not on each one, and goes once the composer is emptied`, () => {
    const { type } = renderChat();
    type("H");
    type("He");
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS - 1));
    type("Hello");
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS - 1));
    expect(draft("prj_one")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(draft("prj_one")).toBe("Hello");
    expect(DRAFT_SAVE_MS).toBeLessThanOrEqual(500);
    type("");
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS));
    expect(draft("prj_one")).toBeNull();
  });

  it("comes back when the chat opens again", () => {
    window.localStorage.setItem("nest-projects:chat-draft:prj_one", "Half a thought");
    const { box } = renderChat();
    expect(box()).toHaveValue("Half a thought");
  });

  it("goes at once when the message is sent, and isn't written back by the save that was waiting", () => {
    window.localStorage.setItem("nest-projects:chat-draft:prj_one", "Spec");
    const { type, box } = renderChat();
    type("Spec a task");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box()).toHaveValue("");
    expect(draft("prj_one")).toBeNull();
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS * 2));
    expect(draft("prj_one")).toBeNull();
  });

  it("is saved at once when the chat goes away", () => {
    const { type, unmount } = renderChat();
    type("Unfinished");
    unmount();
    expect(draft("prj_one")).toBe("Unfinished");
  });

  it("is saved at once on switching project, and the other project's own draft shows", () => {
    window.localStorage.setItem("nest-projects:chat-draft:prj_two", "Two's draft");
    const { type, box, switchTo } = renderChat();
    type("One's draft");
    switchTo("prj_two");
    expect(draft("prj_one")).toBe("One's draft");
    expect(box()).toHaveValue("Two's draft");
    act(() => vi.advanceTimersByTime(DRAFT_SAVE_MS * 2));
    expect(draft("prj_two")).toBe("Two's draft");
    expect(draft("prj_one")).toBe("One's draft");
  });

  it("is saved at once when the page is hidden, or left", () => {
    const { type } = renderChat();
    type("Before the tab hides");
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(draft("prj_one")).toBe("Before the tab hides");
    state.mockReturnValue("visible");
    type("Before the page goes");
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(draft("prj_one")).toBe("Before the page goes");
    // Shown again, nothing is saved for it.
    type("Back again");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(draft("prj_one")).toBe("Before the page goes");
  });
});
