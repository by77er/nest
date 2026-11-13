// The projects list and creating one: the repo is checked by the Worker's own rule before it's sent,
// and the new project's page opens.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi, project } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

/** The create form's repo picker (Mantine's Select: its visible input), once the list has loaded. */
const repoPicker = async (d: HTMLElement) => {
  await within(d).findAllByLabelText(/Repository/);
  return within(d).getAllByLabelText(/Repository/).find((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type !== "hidden")!;
};

describe("projects", () => {
  it("lists each project with a link to its page and its repo", async () => {
    renderApp("/projects");
    const link = await screen.findByRole("link", { name: "Widgets" });
    expect(link).toHaveAttribute("href", "/projects/prj_one/manager");
    expect(screen.getByRole("link", { name: "owner/widgets" })).toHaveAttribute("href", "https://github.com/owner/widgets");
  });

  it("one still being created says so, with nothing to open yet (B10)", async () => {
    const api = new FakeApi();
    api.projects = [...api.projects, project({ id: "prj_new", name: "Gizmos", repo: "owner/gizmos", state: "pending" })];
    renderApp("/projects", api);
    const card = await screen.findByRole("article", { name: "Gizmos" });
    expect(within(card).getByText("Being created")).toBeInTheDocument();
    expect(within(card).queryByRole("link", { name: "Gizmos" })).toBeNull();
    expect(within(screen.getByRole("article", { name: "Widgets" })).queryByText("Being created")).toBeNull();
  });

  it("a list that fails to refresh after a good read shows the count as unknown (\"?\"), not the old number", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Which key?" })];
    const { queryClient } = renderApp("/projects", api);
    expect(await screen.findByRole("link", { name: /1 thing needs you/ })).toBeInTheDocument();
    api.fail(/^GET \/api\/projects$/, 502, "the Worker is unavailable");
    await queryClient.refetchQueries({ queryKey: ["projects"], exact: true });
    const badge = await screen.findByRole("link", { name: /Couldn't check what needs you/ });
    expect(badge).toHaveTextContent(/^\?$/);
    expect(screen.queryByRole("link", { name: /1 thing needs you/ })).toBeNull();
    // Said once, calmly: these cards are the last good read.
    expect(screen.getByText(/Couldn't refresh; showing what was read at \d/)).toBeInTheDocument();
  });

  it("a project's \"needs you\" goes to its Board, where asks are answered; the project opens on its Manager", async () => {
    const api = new FakeApi();
    api.asks = [ask({ question: "Which key?" })];
    renderApp("/projects", api);
    const badge = await screen.findByRole("link", { name: /1 thing needs you/ });
    expect(badge).toHaveAttribute("href", "/projects/prj_one/board");
    expect(screen.getByRole("link", { name: "Widgets" })).toHaveAttribute("href", "/projects/prj_one/manager");
  });

  it("nest unreadable for the asks: the count is unknown, said so, never shown as nothing", async () => {
    const api = new FakeApi();
    api.asksError = "nest 503";
    renderApp("/projects", api);
    const badge = await screen.findByRole("link", { name: /Couldn't check what needs you/ });
    // "?", as on the sidebar; the sentence is its name and tooltip.
    expect(badge).toHaveTextContent(/^\?$/);
    expect(badge).toHaveAttribute("title", "Couldn't check what needs you");
    expect(badge).toHaveAttribute("href", "/projects/prj_one/board");
    expect(document.querySelector("[data-marker=needs-you]")).toBeNull();
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

  const app = { slug: "nest-test", install_url: "https://github.com/apps/nest-test/installations/new" };

  it("picks the repo from those the App reaches; one already a project's is shown but can't be picked; a missing one is added on GitHub", async () => {
    const api = new FakeApi();
    api.attachable = {
      repos: [{ repo: "owner/widgets", project: "prj_one" }, { repo: "owner/gadgets", project: null }],
      unlisted: [], complete: true, app,
    };
    const { user } = renderApp("/projects", api);
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const d = screen.getByRole("dialog", { name: "New project" });
    await user.type(within(d).getByLabelText(/Name/), "Gadgets");
    const picker = await repoPicker(d);
    await waitFor(() => expect(picker).toBeEnabled());
    // The App by name, and where on GitHub a missing repo is added.
    expect(within(d).getByText(/Repos the GitHub App nest-test is installed on/)).toBeInTheDocument();
    expect(within(d).getByText(/Missing one\? Add it to the App's installation/)).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: /^on\sGitHub$/ })).toHaveAttribute("href", app.install_url);
    expect(within(d).queryByText("Some repos aren't listed")).toBeNull();
    await user.click(picker);
    const taken = await screen.findByRole("option", { name: "owner/widgets (already a project)" });
    expect(taken).toHaveAttribute("data-combobox-disabled", "true");
    // Pickable repos first, then those already a project's.
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["owner/gadgets", "owner/widgets (already a project)"]);
    await user.click(screen.getByRole("option", { name: "owner/gadgets" }));
    await user.click(within(d).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects", body: { name: "Gadgets", repo: "owner/gadgets", auto_assign: false, max_workers: 2 } }]));
  });

  it("a search that matches nothing says how to add the repo", async () => {
    const api = new FakeApi();
    api.attachable = { repos: [{ repo: "owner/gadgets", project: null }], unlisted: [], complete: true, app };
    const { user } = renderApp("/projects", api);
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const d = screen.getByRole("dialog", { name: "New project" });
    const picker = await repoPicker(d);
    await waitFor(() => expect(picker).toBeEnabled());
    await user.type(picker, "sprockets");
    expect(await screen.findByText(/No repo matches/)).toBeInTheDocument();
    const links = screen.getAllByRole("link", { name: /^on\sGitHub$/ });
    expect(links.length).toBeGreaterThan(1);
    expect(links.every((a) => a.getAttribute("href") === app.install_url)).toBe(true);
  });

  it("what GitHub couldn't list is said line by line, and a repo it may not show can be typed", async () => {
    const api = new FakeApi();
    api.attachable = { repos: [{ repo: "owner/gadgets", project: null }], unlisted: ["elsewhere"], complete: false, app };
    const { user } = renderApp("/projects", api);
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const d = screen.getByRole("dialog", { name: "New project" });
    await user.type(within(d).getByLabelText(/Name/), "Far");
    await repoPicker(d);
    expect(within(d).getByText("Some repos aren't listed")).toBeInTheDocument();
    expect(within(d).getByText(/The App's repos on elsewhere couldn't be listed just now: reopen this form to try again/)).toBeInTheDocument();
    expect(within(d).getByText(/Only an installation's first 1000 repos are listed/)).toBeInTheDocument();
    await user.click(within(d).getByRole("button", { name: "Type a repo instead" }));
    const typed = within(d).getByRole("textbox", { name: /Repository/ });
    await user.type(typed, "elsewhere/far");
    await user.click(within(d).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.writes).toEqual([{ method: "POST", path: "/api/projects", body: { name: "Far", repo: "elsewhere/far", auto_assign: false, max_workers: 2 } }]));
  });

  it("with nothing to attach, the picker says why and where to install the App, and can't be opened", async () => {
    const api = new FakeApi();
    api.attachable = { repos: [], unlisted: [], complete: true, app };
    const { user } = renderApp("/projects", api);
    await user.click(await screen.findByRole("button", { name: "New project" }));
    const d = screen.getByRole("dialog", { name: "New project" });
    expect(await within(d).findByText(/Install the App on an account, or add repos to an installation it already has/)).toBeInTheDocument();
    expect(within(d).getByRole("link", { name: /^on\sGitHub$/ })).toHaveAttribute("href", app.install_url);
    expect(await repoPicker(d)).toBeDisabled();
    expect(within(d).getByRole("button", { name: "Create project" })).toBeDisabled();
    expect(within(d).queryByText("Some repos aren't listed")).toBeNull();
  });

  it("says when the list can't be loaded", async () => {
    const api = new FakeApi();
    api.fail(/^GET \/api\/projects$/, 403, "a Cloudflare Access login for this app is required");
    renderApp("/projects", api);
    expect(await screen.findByRole("alert")).toHaveTextContent("a Cloudflare Access login for this app is required");
  });
});
