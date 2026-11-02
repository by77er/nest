// The primitives' placement rules (the nest-ui-design skill's Placement and Layout primitives): where each
// slot goes, that action rows wrap and stay right-aligned, destructive actions last behind a divider, and
// the spinner's 300 ms delay.
import { MantineProvider } from "@mantine/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { cssVariablesResolver, motion, theme } from "../theme";
import { ErrorState, FieldGroup, LoadingState, PageHeader, Panel, Section, Toolbar } from ".";

const wrap = (ui: ReactNode) => render(<MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">{ui}</MantineProvider>);
/** Whether `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
const style = (el: Element) => el.getAttribute("style") ?? "";

describe("PageHeader", () => {
  it("puts the breadcrumbs, then the one h1 with its actions on its row, then the meta line", () => {
    wrap(<PageHeader breadcrumbs={[<a key="a" href="/">Projects</a>]} title="Widgets" meta={<span>owner/widgets</span>} actions={<button>Settings</button>} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Widgets" });
    const actions = screen.getByRole("button", { name: "Settings" }).closest("[data-slot=actions]")!;
    expect(before(screen.getByRole("link", { name: "Projects" }), h1)).toBe(true);
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
  it("is the surface, or the warning tint for a banner, never a raw color", () => {
    wrap(
      <>
        <Panel data-testid="plain" />
        <Panel tone="warning" data-testid="banner" />
      </>,
    );
    expect(style(screen.getByTestId("plain"))).toContain("var(--nest-surface)");
    expect(style(screen.getByTestId("banner"))).toContain("var(--mantine-color-warning-light)");
  });
});
