// An agent's asks, shown above the board until answered: an approval is answered approve (green) or
// deny (red), words nest reads as such (docs/agents/tools/#taint-and-sinks); a question in words.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const panel = () => screen.findByRole("alert", { name: /waiting for you/ });

describe("asks", () => {
  it("an approval: approve is green and sends approve; the ask then leaves", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "github.create_pr", tool: "brokered" }, question: "Open the PR?" });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one", api);

    const p = await panel();
    expect(p.getAttribute("style")).toContain("--mantine-color-warning-");
    expect(p).toHaveTextContent("github.create_pr");
    expect(p).toHaveTextContent("Open the PR?");
    const approve = within(p).getByRole("button", { name: "Approve" });
    expect(approve.getAttribute("style")).toContain("--mantine-color-success-");
    expect(within(p).getByRole("button", { name: "Deny" }).getAttribute("style")).toContain("--mantine-color-danger-");

    await user.click(approve);
    await waitFor(() => expect(screen.queryByRole("alert", { name: /waiting for you/ })).toBeNull());
    expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "approve" } }]);
  });

  it("an approval denied sends deny", async () => {
    const api = new FakeApi();
    const a = ask({ approval: { name: "email.send", tool: "brokered" } });
    api.asks = [a];
    const { user } = renderApp("/projects/prj_one", api);
    await user.click(within(await panel()).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: `/api/projects/prj_one/asks/${a.ask}/answer`, body: { answer: "deny" } }]));
  });

  it("a question is answered in words; one nest refuses keeps the ask and what was typed", async () => {
    const api = new FakeApi();
    const a = ask({ question: "Which branch should I base on?", role: "manager", agent: "agt_manager" });
    api.asks = [a, ask({ question: "already answered", answered_ms: 5 })];
    api.fail(/\/answer$/, 502, "nest is unavailable");
    const { user } = renderApp("/projects/prj_one", api);

    const p = await panel();
    expect(p).not.toHaveTextContent("already answered");
    expect(within(p).queryByRole("button", { name: "Approve" })).toBeNull();
    const send = within(p).getByRole("button", { name: "Answer" });
    expect(send).toBeDisabled();
    await user.type(within(p).getByLabelText("Your answer"), "main");
    await user.click(send);

    expect(await screen.findByText("nest is unavailable")).toBeInTheDocument();
    expect(within(await panel()).getByLabelText("Your answer")).toHaveValue("main");
    await user.click(within(await panel()).getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(screen.queryByRole("alert", { name: /waiting for you/ })).toBeNull());
    expect(api.writes.map((w) => w.body)).toEqual([{ answer: "main" }, { answer: "main" }]);
  });
});
