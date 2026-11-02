// The sidebar: every project a group of its pages, the current one open and its page highlighted, a
// "needs you" badge from the attention count, Admin at the foot; and the routes, old links included.
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FakeApi, project } from "../../test/fakeApi";
import { renderApp } from "../../test/render";

const sidebar = () => screen.getByRole("navigation", { name: "Main" });

describe("the sidebar", () => {
  it("opens the current project's group, highlights its page, and leaves the others closed", async () => {
    const api = new FakeApi();
    api.projects = [project(), project({ id: "prj_two", name: "Gadgets", repo: "owner/gadgets" })];
    renderApp("/projects/prj_one/reviews", api);
    await screen.findByRole("heading", { level: 1, name: "Reviews" });
    const nav = sidebar();
    const current = await within(nav).findByRole("link", { name: "Reviews" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveAttribute("href", "/projects/prj_one/reviews");
    for (const page of ["Board", "Manager", "Settings"]) {
      const l = within(nav).getByRole("link", { name: page });
      expect(l).toHaveAttribute("href", `/projects/prj_one/${page.toLowerCase()}`);
      expect(l).not.toHaveAttribute("aria-current");
    }
    // The other project is a closed group: its pages aren't links until it's opened.
    expect(within(nav).getAllByRole("link", { name: "Board" })).toHaveLength(1);
    expect(within(nav).getByRole("button", { name: /Gadgets/ })).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).getByRole("link", { name: "Projects" })).not.toHaveAttribute("aria-current");
  });

  it("lists Projects first and Admin last, in the sidebar's foot", async () => {
    renderApp("/admin");
    await screen.findByRole("heading", { level: 1, name: "Admin" });
    const bar = screen.getByRole("navigation", { name: "Sidebar" });
    const links = within(bar).getAllByRole("link");
    expect(links[0]).toHaveAccessibleName("nest projects: all projects");
    expect(links.at(-1)).toHaveAccessibleName("Admin");
    expect(links.at(-1)).toHaveAttribute("aria-current", "page");
  });

  it("the burger opens and closes the drawer it controls", async () => {
    const { user } = renderApp("/projects");
    const burger = await screen.findByRole("button", { name: "Open the menu" });
    expect(burger).toHaveAttribute("aria-controls", "sidebar");
    await user.click(burger);
    expect(screen.getByRole("button", { name: "Close the menu" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("the attention badge", () => {
  it("shows a project's count when there is one, and nothing at zero", async () => {
    const { NeedsYouBadge } = await import("./Sidebar");
    const { MantineProvider } = await import("@mantine/core");
    const { theme } = await import("../../theme");
    render(<MantineProvider theme={theme} env="test"><NeedsYouBadge count={3} /><NeedsYouBadge count={0} /><NeedsYouBadge count={undefined} /></MantineProvider>);
    const badges = document.querySelectorAll("[data-marker=needs-you]");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAccessibleName("3 things need you");
    expect(badges[0]!.getAttribute("style")).toContain("--mantine-color-warning-");
  });
});

describe("the routes", () => {
  it("send / to the projects, and an old project link with a task to the board with that task", async () => {
    const api = new FakeApi();
    const first = renderApp("/", api);
    await waitFor(() => expect(first.router.state.location.pathname).toBe("/projects"));
    first.unmount();
    const t = { ...(await import("../../test/fakeApi")).task({ title: "Old link" }) };
    api.tasks = [t];
    const second = renderApp(`/projects/prj_one?task=${t.id}`, api);
    await waitFor(() => expect(second.router.state.location.pathname).toBe("/projects/prj_one/board"));
    expect(second.router.state.location.search).toEqual({ task: t.id });
    expect(await screen.findByRole("dialog", { name: "Task" })).toBeInTheDocument();
  });
});
