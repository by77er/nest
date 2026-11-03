// The projects list and creating one: the repo is checked by the Worker's own rule before it's sent,
// and the new project's page opens.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

describe("projects", () => {
  it("lists each project with a link to its page and its repo", async () => {
    renderApp("/projects");
    const link = await screen.findByRole("link", { name: "Widgets" });
    expect(link).toHaveAttribute("href", "/projects/prj_one/manager");
    expect(screen.getByRole("link", { name: "owner/widgets" })).toHaveAttribute("href", "https://github.com/owner/widgets");
  });

  it("a project's \"needs you\" goes to its Board, where asks are answered; the project opens on its Manager", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Which key?" })];
    renderApp("/projects", api);
    const badge = await screen.findByRole("link", { name: /1 thing needs you/ });
    expect(badge).toHaveAttribute("href", "/projects/prj_one/board");
    expect(screen.getByRole("link", { name: "Widgets" })).toHaveAttribute("href", "/projects/prj_one/manager");
  });

  it("creates one with its settings, refusing a malformed repo first, then opens it", async () => {
    const api = new FakeApi();
    api.projects = [];
    const { user, router } = renderApp("/projects", api);

    await user.click(await screen.findByRole("button", { name: "Create the first project" }));
    const d = screen.getByRole("dialog", { name: "New project" });
    await user.type(within(d).getByLabelText(/Name/), "Gadgets");
    await user.type(within(d).getByLabelText(/Repository/), "not a repo");
    await user.click(within(d).getByRole("button", { name: "Create project" }));
    expect(within(d).getByText("repo is owner/name")).toBeInTheDocument();
    expect(api.writes).toEqual([]);

    await user.clear(within(d).getByLabelText(/Repository/));
    await user.type(within(d).getByLabelText(/Repository/), "Owner/Gadgets");
    await user.click(within(d).getByRole("switch", { name: /Assign ready tasks automatically/ }));
    await user.clear(within(d).getByLabelText(/Max workers/));
    await user.type(within(d).getByLabelText(/Max workers/), "3");
    await user.click(within(d).getByRole("button", { name: "Create project" }));

    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects", body: { name: "Gadgets", repo: "Owner/Gadgets", auto_assign: true, max_workers: 3 } }]));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/projects\/prj_new[a-z0-9]+\/manager$/));
    expect(await screen.findByRole("heading", { level: 1, name: "Gadgets" })).toBeInTheDocument();
  });

  it("says when the list can't be loaded", async () => {
    const api = new FakeApi();
    api.fail(/^GET \/api\/projects$/, 403, "a Cloudflare Access login for this app is required");
    renderApp("/projects", api);
    expect(await screen.findByRole("alert")).toHaveTextContent("a Cloudflare Access login for this app is required");
  });
});
