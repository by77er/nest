// Polling and the motion it may cause: the page reads the fleet every 10 s and the lifetimes view
// every 60 s, only while the tab is visible; a value that changes on a poll flashes its tint once, and
// an unchanged poll animates nothing. The waits are on fake timers, past the 10 s and 60 s intervals.
import { act, render, screen, within } from "@testing-library/react";
import { focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MantineProvider } from "@mantine/core";
import { Flash } from "../../src/ui/layout";
import { theme } from "../../src/ui/theme";
import { recorded, renderPage } from "./render";

const flashing = () => document.querySelectorAll("[data-flash]");
const count = (calls: string[], path: string) => calls.filter((c) => c === path).length;

describe("Flash", () => {
  const at = (value: number) => <MantineProvider theme={theme} env="test"><Flash value={value}>{value}</Flash></MantineProvider>;

  it("does nothing on the first render or an unchanged value, and flashes once on a change", () => {
    const { rerender } = render(at(1));
    expect(flashing()).toHaveLength(0);
    rerender(at(1));
    expect(flashing()).toHaveLength(0);
    rerender(at(2));
    expect(flashing()).toHaveLength(1);
  });
});

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
  });

  it("reads every 10 s (the lifetimes view every 60 s), and an unchanged poll flashes nothing", async () => {
    const { calls } = renderPage();
    await screen.findByRole("table", { name: "Agents" });
    const fleet = count(calls, "/api/fleet");
    const life = count(calls, "/api/lifetimes");
    await act(() => vi.advanceTimersByTimeAsync(10_500));
    expect(count(calls, "/api/fleet")).toBe(fleet + 1);
    expect(count(calls, "/api/agents")).toBeGreaterThan(1);
    expect(count(calls, "/api/lifetimes")).toBe(life);
    expect(flashing()).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(50_000));
    expect(count(calls, "/api/lifetimes")).toBe(life + 1);
    expect(flashing()).toHaveLength(0);
  });

  it("stops while the tab is hidden, and reads again when it shows", async () => {
    const { calls } = renderPage();
    await screen.findByRole("table", { name: "Agents" });
    act(() => focusManager.setFocused(false));
    const fleet = count(calls, "/api/fleet");
    await act(() => vi.advanceTimersByTimeAsync(35_000));
    expect(count(calls, "/api/fleet")).toBe(fleet);
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(count(calls, "/api/fleet")).toBe(fleet + 1);
  });

  it("a count that changes on a poll flashes its tile", async () => {
    const { routes } = renderPage();
    await screen.findByRole("table", { name: "Agents" });
    const more = recorded.fleet();
    more.sandboxes.push({ ...more.sandboxes[0]!, sandbox: "sbx_01second0000000000000000" });
    routes["/api/fleet"] = more;
    await act(() => vi.advanceTimersByTimeAsync(10_500));
    const tile = within(screen.getByLabelText("Summary")).getByText("Sandboxes").parentElement!;
    expect(tile).toHaveTextContent("2");
    expect(tile.querySelectorAll("[data-flash]")).toHaveLength(1);
  });
});
