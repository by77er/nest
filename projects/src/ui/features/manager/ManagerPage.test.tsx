// The Manager page: its status in the header, as nest's record says (src/manager.ts), with a retry when
// the repo couldn't be attached; and the Trace tab beside Chat, kept in the URL for the trace viewer.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

describe("the Manager page", () => {
  it("shows the manager running, what it's doing and where, in the header", async () => {
    const api = new FakeApi();
    api.manager = { phase: "running", agent: "agt_manager", state: "waiting_input", host: "bh_7", error: null };
    renderApp("/projects/prj_one/manager", api);
    expect(await screen.findByRole("heading", { level: 1, name: "Manager" })).toBeInTheDocument();
    const badge = await screen.findByText("Running");
    expect(badge.closest("[data-phase]")!.getAttribute("style")).toContain("--mantine-color-success-");
    expect(screen.getByText("waiting for input")).toBeInTheDocument();
    expect(screen.getByText("bh_7")).toBeInTheDocument();
  });

  it("a failed attach shows why, and retrying it posts the attach", async () => {
    const api = new FakeApi();
    api.manager = { phase: "attach_failed", agent: null, state: null, host: null, error: "GitHub answered 403: the App lacks administration" };
    const { user } = renderApp("/projects/prj_one/manager", api);
    const problem = await screen.findByRole("alert", { name: /couldn't be attached/ });
    expect(problem).toHaveTextContent("the App lacks administration");
    await user.click(within(problem).getByRole("button", { name: "Retry attach" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects/prj_one/attach", body: undefined }]));
    expect(await screen.findByText("Starting")).toBeInTheDocument();
  });

  it("waiting for a host is a warning, not an error", async () => {
    const api = new FakeApi();
    api.manager = { phase: "waiting_for_host", agent: "agt_manager", state: "starting", host: null, error: null };
    renderApp("/projects/prj_one/manager", api);
    const badge = await screen.findByText("Waiting for a host");
    expect(badge.closest("[data-phase]")!.getAttribute("style")).toContain("--mantine-color-warning-");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("has a Trace tab beside Chat, kept in the URL", async () => {
    const { user, router } = renderApp("/projects/prj_one/manager");
    await screen.findByRole("tabpanel", { name: "Chat" });
    await user.click(screen.getByRole("tab", { name: "Trace" }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: "trace" }));
    expect(await screen.findByRole("tabpanel", { name: "Trace" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Message to the manager")).toBeNull();
  });
});
