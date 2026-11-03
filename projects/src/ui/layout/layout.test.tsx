// The primitives' placement rules (the nest-ui-design skill's Placement and Layout primitives): where each
// slot goes, that action rows wrap and stay right-aligned, destructive actions last behind a divider, and
// the spinner's 300 ms delay.
import { MantineProvider } from "@mantine/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { cssVariablesResolver, motion, theme } from "../theme";
import { AppFrame, ErrorState, FieldGroup, LoadingState, NavGroup, NavGroups, NavRow, Page, PageHeader, Panel, PinnedFooter, Section, Toolbar } from ".";

const wrap = (ui: ReactNode) => render(<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">{ui}</MantineProvider>);
/** Whether `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const style = (el: Element) => el.getAttribute("style") ?? "";

describe("PageHeader", () => {
  it("puts the one h1 with its actions on its row, then the meta line, and no breadcrumb", () => {
    wrap(<PageHeader title="Widgets" meta={<span>owner/widgets</span>} actions={<button>Settings</button>} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Widgets" });
    const actions = screen.getByRole("button", { name: "Settings" }).closest("[data-slot=actions]")!;
    expect(document.querySelector(".mantine-Breadcrumbs-root")).toBeNull();
    expect(before(h1, actions)).toBe(true);
    // The actions share the title's row, wrap under it when narrow, and stay at the right edge.
    expect(actions.parentElement).toBe(h1.parentElement);
    expect(style(actions)).toMatch(/--group-wrap:\s*wrap/);
    expect(style(actions)).toMatch(/--group-justify:\s*flex-end/);
    expect(style(actions)).toMatch(/margin-left:\s*auto/);
    expect(style(h1.parentElement!)).toMatch(/--group-wrap:\s*wrap/);
    expect(before(actions, screen.getByText("owner/widgets"))).toBe(true);
  });
});

describe("Section", () => {
  it("is a region named by its title, with its count beside the title and its actions at the right", () => {
    wrap(
      <Section title="Board" count={3} actions={<button>New task</button>}>
        <p>content</p>
      </Section>,
    );
    const region = screen.getByRole("region", { name: "Board" });
    const head = region.querySelector<HTMLElement>("[data-slot=head]")!;
    expect(within(head).getByRole("heading", { level: 3, name: "Board" })).toBeInTheDocument();
    expect(within(head).getByLabelText("3 items")).toBeInTheDocument();
    const actions = within(head).getByRole("button", { name: "New task" }).closest("[data-slot=actions]")!;
    expect(style(actions)).toMatch(/margin-left:\s*auto/);
    expect(before(head, screen.getByText("content"))).toBe(true);
    // Every heading row has the same height, so headings line up across a page.
    expect(style(head)).toContain("var(--nest-section-head)");
  });

  it("a dense one (a board column) has an h4, and one that isn't a place of its own is no landmark", () => {
    wrap(<Section title="Ready" dense region={false} />);
    expect(screen.getByRole("heading", { level: 4, name: "Ready" })).toBeInTheDocument();
    expect(screen.queryByRole("region")).toBeNull();
  });
});

describe("Toolbar", () => {
  it("puts destructive actions last, after a divider", () => {
    wrap(<Toolbar danger={<button>Cancel task</button>}><button>Assign</button></Toolbar>);
    const danger = screen.getByRole("button", { name: "Cancel task" });
    const separator = document.querySelector("[data-slot=separator]")!;
    expect(before(screen.getByRole("button", { name: "Assign" }), separator)).toBe(true);
    expect(before(separator, danger)).toBe(true);
  });

  it("has no divider when it holds only destructive actions", () => {
    wrap(<Toolbar danger={<button>Delete</button>}>{false}{null}</Toolbar>);
    expect(document.querySelector("[data-slot=separator]")).toBeNull();
  });
});

describe("FieldGroup", () => {
  it("puts the actions after the fields, right-aligned, primary rightmost as given", () => {
    wrap(
      <FieldGroup actions={<><button>Cancel</button><button>Save</button></>}>
        <label>Name<input /></label>
      </FieldGroup>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(before(screen.getByLabelText("Name"), save)).toBe(true);
    expect(before(screen.getByRole("button", { name: "Cancel" }), save)).toBe(true);
    expect(style(save.closest("[data-ds=toolbar]")!)).toMatch(/--group-justify:\s*flex-end/);
  });
});

describe("the states", () => {
  it("a spinner shows only once loading has taken 300 ms", () => {
    vi.useFakeTimers();
    try {
      wrap(<LoadingState label="Loading the board" />);
      const status = screen.getByRole("status", { name: "Loading the board" });
      expect(within(status).queryByText("Loading the board")).toBeNull();
      act(() => vi.advanceTimersByTime(motion.spinnerDelay - 1));
      expect(within(status).queryByText("Loading the board")).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(within(status).getByText("Loading the board")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an error says what failed and why, and offers one retry", async () => {
    const retry = vi.fn();
    wrap(<ErrorState title="The board couldn't be loaded" error={new Error("ProjectDO is unavailable")} onRetry={retry} />);
    const alert = screen.getByRole("alert", { name: "The board couldn't be loaded" });
    expect(alert).toHaveTextContent("ProjectDO is unavailable");
    await userEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe("Panel", () => {
  it("is the surface, and a warning panel the surface with a warning rule, not a tinted fill, never a raw color", () => {
    wrap(
      <>
        <Panel data-testid="plain" />
        <Panel tone="warning" data-testid="banner" />
      </>,
    );
    expect(style(screen.getByTestId("plain"))).toContain("var(--nest-surface)");
    const banner = style(screen.getByTestId("banner"));
    expect(banner).toContain("var(--nest-surface)");
    expect(banner).toContain("var(--mantine-color-warning-filled)");
    expect(banner).not.toContain("var(--mantine-color-warning-light)");
  });
});

describe("AppFrame", () => {
  it("puts the brand, then the places, then the footer, in the sidebar; the page beside it", () => {
    wrap(
      <AppFrame brand={<a href="/">nest</a>} nav={() => <a href="/projects">Projects</a>} navFooter={() => <a href="/admin">Admin</a>}>
        <p>the page</p>
      </AppFrame>,
    );
    const bar = screen.getByRole("navigation", { name: "Sidebar" });
    const [brand, places, footer] = ["nest", "Projects", "Admin"].map((n) => within(bar).getByRole("link", { name: n }));
    expect(before(brand!, places!) && before(places!, footer!)).toBe(true);
    expect(within(screen.getByRole("main")).getByText("the page")).toBeInTheDocument();
    expect(bar).toHaveAttribute("id", "sidebar");
  });

  it("the burger toggles the drawer and closes it when a place is picked", async () => {
    wrap(
      <AppFrame brand={<span>nest</span>} nav={(close) => <button onClick={close}>Board</button>}>
        <p />
      </AppFrame>,
    );
    const user = userEvent.setup();
    const bar = screen.getByRole("navigation", { name: "Sidebar" });
    expect(bar).not.toHaveAttribute("data-opened");
    await user.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(bar).toHaveAttribute("data-opened");
    await user.click(within(bar).getByRole("button", { name: "Board" }));
    expect(bar).not.toHaveAttribute("data-opened");
  });
});

describe("Page and PinnedFooter", () => {
  it("a reading page keeps its content to the reading measure, centred; a pinned footer sticks to the bottom", () => {
    wrap(
      <Page measure="reading">
        <PinnedFooter>
          <button>Send</button>
        </PinnedFooter>
      </Page>,
    );
    const footer = screen.getByRole("button", { name: "Send" }).closest("[data-ds=pinned-footer]")!;
    expect(style(footer)).toMatch(/position:\s*sticky/);
    expect(style(footer)).toMatch(/bottom:\s*0/);
    expect(style(footer.parentElement!)).toContain("var(--nest-reading-measure)");
    // Centred in the content area, and the header inside the same column.
    expect(style(footer.parentElement!)).toMatch(/margin-inline:\s*auto|margin-left:\s*auto/);
  });
});

describe("the navigation primitives", () => {
  it("draw every row the same way: an icon column, then the label, then its end", () => {
    const Icon = () => <svg data-testid="icon" />;
    wrap(
      <NavGroups>
        <NavGroup label="Views">
          <NavRow href="/a" icon={Icon} label="Board" end={<span>3</span>} />
          <NavRow href="/b" icon={Icon} label="Manager" aria-current="page" />
        </NavGroup>
        <NavGroup label="More">
          <NavRow href="/c" icon={Icon} label="Admin" />
        </NavGroup>
      </NavGroups>,
    );
    const rows = document.querySelectorAll("[data-ds=nav-row]");
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // The same structure: the icon's column first, the label second.
      expect(r.children[0]!.querySelector("[data-testid=icon]")).not.toBeNull();
      expect(r.className).toBe(rows[0]!.className);
    }
    expect(screen.getByRole("link", { name: /Manager/ })).toHaveAttribute("aria-current", "page");
    // Rows are `xs` apart within a group; groups `xl` apart.
    const group = screen.getByRole("group", { name: "Views" });
    expect(style(group)).toContain("var(--mantine-spacing-xs)");
    expect(style(group.parentElement!)).toContain("var(--mantine-spacing-xl)");
  });
});
