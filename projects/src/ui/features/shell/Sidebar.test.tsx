// The sidebar (the nest-ui-design skill's Navigation): the switcher says which project, the flat rows
// which view, one active row; the page's h1 is the project; there is no breadcrumb; and the routes, old
// links included.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ask, FakeApi, project, task } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const sidebar = () => screen.getByRole("navigation", { name: "Main" });
const switcher = () => within(sidebar()).getByRole("button", { name: /Switch project/ });

function twoProjects() {
  const api = new FakeApi();
  api.projects = [project(), project({ id: "prj_two", name: "Gadgets", repo: "owner/gadgets" })];
  return api;
}

describe("the switcher", () => {
  it("names the current project, and reads All projects on the list", async () => {
    const api = twoProjects();
    const first = renderApp("/projects/prj_one/reviews", api);
    await waitFor(() => expect(switcher()).toHaveAccessibleName(/^Project: Widgets/));
    first.unmount();
    renderApp("/projects", api);
    await waitFor(() => expect(switcher()).toHaveAccessibleName(/^Project: All projects/));
  });

  it("finds a project by typing and picks it with the keyboard, keeping the view", async () => {
    const api = twoProjects();
    const { user, router } = renderApp("/projects/prj_one/reviews", api);
    await waitFor(() => expect(switcher()).toHaveAccessibleName(/Widgets/));
    await user.click(switcher());
    const search = await screen.findByRole("textbox", { name: "Find a project" });
    await waitFor(() => expect(search).toHaveFocus());
    await user.type(search, "gad");
    expect(screen.queryByRole("option", { name: "Widgets" })).toBeNull();
    expect(screen.queryByRole("option", { name: "All projects" })).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/prj_two/reviews"));
    await waitFor(() => expect(switcher()).toHaveAccessibleName(/^Project: Gadgets/));
  });

  it("lists All projects first, and picking it goes to the list", async () => {
    const api = twoProjects();
    const { user, router } = renderApp("/projects/prj_one/board", api);
    await waitFor(() => expect(switcher()).toHaveAccessibleName(/Widgets/));
    await user.click(switcher());
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["All projects", "Widgets", "Gadgets"]);
    await user.click(options[0]!);
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects"));
  });

  it("from outside a project, picking one opens its manager, the default view", async () => {
    const api = twoProjects();
    const { user, router } = renderApp("/admin", api);
    await screen.findByRole("heading", { level: 1, name: "Admin" });
    await user.click(switcher());
    await user.click(await screen.findByRole("option", { name: "Gadgets" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/prj_two/manager"));
  });

  it("shows the project's needs-you count once, on Board, and every project's in the list", async () => {
    const api = twoProjects();
    api.asks = [ask({ question: "q1" }), ask({ question: "q2" })];
    const { user } = renderApp("/projects/prj_one/manager", api);
    await waitFor(() => expect(switcher()).toHaveAccessibleName("Project: Widgets. Switch project"));
    // The sidebar's own badges, not the switcher's list (in the DOM, closed).
    const badges = () => [...sidebar().querySelectorAll("[data-marker=needs-you]")].filter((b) => !b.closest(".mantine-Combobox-dropdown"));
    // Once: on the Board row, not again on the switcher's button 50 px above it.
    expect(badges().map((b) => b.closest("[data-ds]")!.getAttribute("data-ds"))).toEqual(["nav-row"]);
    expect(badges()[0]!.closest("a")).toHaveAttribute("href", "/projects/prj_one/board");
    expect(switcher().querySelector("[data-marker=needs-you]")).toBeNull();
    for (const b of badges()) expect(b.getAttribute("style")).toContain("--mantine-color-warning-");
    await user.click(switcher());
    expect(await screen.findByRole("option", { name: "Widgets, 2 need you" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Gadgets" })).toBeInTheDocument();
  });
});

describe("the views", () => {
  it("are flat rows for the current project, one active, and no breadcrumb", async () => {
    renderApp("/projects/prj_one/reviews");
    expect(await screen.findByRole("heading", { level: 1, name: "Widgets" })).toBeInTheDocument();
    const views = within(sidebar()).getByRole("group", { name: "Views" });
    const rows = within(views).getAllByRole("link");
    // The manager first: the project's default view.
    expect(rows.map((r) => r.textContent)).toEqual(["Manager", "Board", "Reviews", "Settings"]);
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["manager", "board", "reviews", "settings"].map((v) => `/projects/prj_one/${v}`));
    expect(rows.filter((r) => r.getAttribute("aria-current") === "page").map((r) => r.textContent)).toEqual(["Reviews"]);
    for (const r of rows) expect(r).toHaveAttribute("data-ds", "nav-row");
    expect(document.querySelector(".mantine-Breadcrumbs-root")).toBeNull();
  });

  it("outside a project are only the switcher and the projects list", async () => {
    renderApp("/projects");
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    const nav = sidebar();
    expect(within(nav).queryByRole("group", { name: "Views" })).toBeNull();
    expect(within(nav).getByRole("link", { name: "All projects" })).toHaveAttribute("aria-current", "page");
  });

  it("the project's name is the h1 on every view, once", async () => {
    for (const v of ["board", "manager", "reviews", "settings"]) {
      const r = renderApp(`/projects/prj_one/${v}`);
      await screen.findByRole("heading", { level: 1, name: "Widgets" });
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      r.unmount();
    }
  });

  it("puts Admin in the sidebar's foot", async () => {
    renderApp("/admin");
    await screen.findByRole("heading", { level: 1, name: "Admin" });
    const bar = screen.getByRole("navigation", { name: "Sidebar" });
    const links = within(bar).getAllByRole("link");
    expect(links.at(-1)).toHaveAccessibleName("Admin");
    expect(links.at(-1)).toHaveAttribute("aria-current", "page");
  });
});

describe("the phone drawer", () => {
  it("opens from the burger with the switcher first, and closes when a view is picked", async () => {
    const { user } = renderApp("/projects/prj_one/board");
    await screen.findByRole("heading", { level: 1, name: "Widgets" });
    await user.click(screen.getByRole("button", { name: "Open the menu" }));
    const bar = screen.getByRole("navigation", { name: "Sidebar" });
    expect(bar).toHaveAttribute("data-opened");
    const first = sidebar().querySelector("button, a");
    expect(first).toBe(switcher());
    await user.click(within(sidebar()).getByRole("link", { name: "Manager" }));
    await waitFor(() => expect(bar).not.toHaveAttribute("data-opened"));
  });
});

describe("the routes", () => {
  it("send / to the projects, a project to its manager, and an old project link with a task to the board with that task", async () => {
    const api = new FakeApi();
    const first = renderApp("/", api);
    await waitFor(() => expect(first.router.state.location.pathname).toBe("/projects"));
    first.unmount();
    const t = task({ title: "Old link" });
    api.tasks = [t];
    const bare = renderApp("/projects/prj_one", api);
    await waitFor(() => expect(bare.router.state.location.pathname).toBe("/projects/prj_one/manager"));
    bare.unmount();
    const second = renderApp(`/projects/prj_one?task=${t.id}`, api);
    await waitFor(() => expect(second.router.state.location.pathname).toBe("/projects/prj_one/board"));
    expect(second.router.state.location.search).toEqual({ task: t.id });
    expect(await screen.findByRole("dialog", { name: "Task" })).toBeInTheDocument();
  });
});
