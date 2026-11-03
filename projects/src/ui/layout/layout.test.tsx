// The primitives' placement rules (the nest-ui-design skill's Placement and Layout primitives): where each
// slot goes, that action rows wrap and stay right-aligned, destructive actions last behind a divider, and
// the spinner's 300 ms delay.
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { cssVariablesResolver, motion, theme } from "../theme";
import { AppFrame, ErrorState, FieldGroup, LoadingState, Measure, NavGroup, NavGroups, NavRow, Page, PageHeader, Panel, PinnedFooter, Section, SectionGrid, Toolbar, WithContext } from ".";

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

describe("Page, Measure and PinnedFooter", () => {
  it("the page has one frame, no measure of its own; a Measure is left-aligned in it; a pinned footer sticks", () => {
    wrap(
      <Page>
        <Measure type="reading">
          <PinnedFooter>
            <button>Send</button>
          </PinnedFooter>
        </Measure>
      </Page>,
    );
    const content = document.querySelector("[data-ds=page-content]")!;
    expect(style(content)).not.toMatch(/max-width/);
    const measure = document.querySelector("[data-ds=measure]")!;
    expect(style(measure)).toContain("var(--nest-reading-measure)");
    // On the frame's left edge: never centred, so switching views never moves an edge.
    expect(style(measure)).not.toMatch(/margin-(inline|left|right):\s*auto/);
    const footer = screen.getByRole("button", { name: "Send" }).closest("[data-ds=pinned-footer]")!;
    expect(style(footer)).toMatch(/position:\s*sticky/);
    expect(style(footer)).toMatch(/bottom:\s*0/);
  });
});

describe("WithContext and SectionGrid", () => {
  it("puts the content first and the context beside it, or above it in a disclosure when narrow", async () => {
    wrap(
      <WithContext measure="reading" contextLabel="About it" context={<p>context</p>}>
        <p>content</p>
      </WithContext>,
    );
    // jsdom matches no media query: the narrow layout, its context behind a disclosure above the content.
    const toggle = await screen.findByRole("button", { name: "About it" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(before(toggle, screen.getByText("content"))).toBe(true);
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("lays sections out in one column, two from lg", () => {
    wrap(
      <SectionGrid>
        <p>a</p>
        <p>b</p>
      </SectionGrid>,
    );
    const grid = document.querySelector("[data-ds=section-grid]")!;
    expect(grid.className).toMatch(/SimpleGrid/);
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

describe("TriggerBadge", () => {
  it("keeps its own class inside a Tooltip (which clones its className in), and so the theme's focus ring and touch target", async () => {
    const { Tooltip } = await import("@mantine/core");
    const { TriggerBadge } = await import("./Actions");
    const classes = (await import("./Actions.module.css")).default as Record<string, string>;
    // From disk: vitest doesn't process CSS, so a `?raw` import of a module stylesheet isn't its text.
    const css = readFileSync(`${process.cwd()}/src/ui/layout/Actions.module.css`, "utf8");
    const user = userEvent.setup();
    wrap(
      <Tooltip label="Its details" events={{ hover: true, focus: true, touch: true }}>
        <TriggerBadge data-marker="waiting" aria-label="Waiting on 2">
          Waiting on 2
        </TriggerBadge>
      </Tooltip>,
    );
    const target = screen.getByLabelText("Waiting on 2");
    expect(target.className.split(" ")).toContain(classes.trigger);
    // The class's rules: the theme's 2 px primary ring, and on touch a reserved 44 px height (no
    // pseudo-element reaching over a neighbour).
    expect(css).toMatch(/\.trigger:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mantine-primary-color-filled\)/);
    // On touch its hit box is the 44 px target around the badge, without growing the line: padding with
    // an equal negative margin.
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{[^}]*\.trigger\s*\{[^}]*--nest-hit-pad:\s*calc\(\(var\(--nest-hit-touch\)[^}]*padding-block:\s*var\(--nest-hit-pad\);\s*margin-block:\s*calc\(var\(--nest-hit-pad\) \* -1\)/);
    expect(css).not.toMatch(/\.trigger::(before|after)/);
    // It's the tooltip's target: focus opens it.
    await user.tab();
    expect(target).toHaveFocus();
    expect(await screen.findByText("Its details")).toBeInTheDocument();
  });
});
