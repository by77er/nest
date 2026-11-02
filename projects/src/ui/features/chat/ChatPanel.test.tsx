// The chat with the manager: the log as the Worker keeps it, undelivered messages flagged with why, and
// the composer posting the owner's words.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const chat = () => screen.findByRole("region", { name: "Manager" });

describe("the chat", () => {
  it("shows the manager's replies and flags only the owner's undelivered messages, with the reason", async () => {
    const api = new FakeApi();
    api.chat = [
      { seq: 1, at_ms: 1, sender: "owner", text: "Plan the widgets", delivered: true, error: null },
      { seq: 2, at_ms: 2, sender: "manager", text: "Three tasks, coming up", delivered: true, error: null },
      { seq: 3, at_ms: 3, sender: "owner", text: "And a fourth", delivered: false, error: "the manager isn't started yet" },
      { seq: 4, at_ms: 4, sender: "app", text: "The manager ended (exited).", delivered: true, error: null },
    ];
    renderApp("/projects/prj_one", api);
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
    const { user } = renderApp("/projects/prj_one", api);
    const c = await chat();

    const box = within(c).getByLabelText("Message to the manager");
    expect(within(c).getByRole("button", { name: "Send" })).toBeDisabled();
    await user.type(box, "  Spec the first task  ");
    await user.click(within(c).getByRole("button", { name: "Send" }));

    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/chat", body: { text: "Spec the first task" } }]));
    expect(box).toHaveValue("");
    expect(await within(c).findByText("Spec the first task")).toBeInTheDocument();
  });

  it("gives the text back to the composer when the message isn't taken", async () => {
    const api = new FakeApi();
    api.fail(/^POST .*\/chat$/, 503, "ProjectDO is unavailable");
    const { user } = renderApp("/projects/prj_one", api);
    const c = await chat();

    const box = within(c).getByLabelText("Message to the manager");
    await user.type(box, "Hello{Control>}{Enter}{/Control}");
    expect(await screen.findByText("ProjectDO is unavailable")).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveValue("Hello"));
    expect(within(c).queryByText("Hello", { selector: "p" })).toBeNull();
  });
});
