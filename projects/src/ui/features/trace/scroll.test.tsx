// The trace's scroll where its turns are drawn after they render (content-visibility: a turn off screen is
// held at an estimated height until the browser first draws it, Terminal.module.css): the line being read
// stays put across Load older while the turns around it are drawn, following holds the bottom while new
// lines are drawn, and "Jump to live" reaches the bottom as it is when it gets there. jsdom doesn't lay
// out, so a small layout stands in: every line stacked in document order at a height the test sets, and
// the log's ResizeObservers fired by hand, as a browser fires them when what's drawn changes size. (The
// browser's own numbers: the PR's measurements in Chromium.)
import { MantineProvider } from "@mantine/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cssVariablesResolver, theme } from "../../theme";
import { initialTrace, type TraceEvent, type TraceState } from "./model";
import { TraceLog } from "./TraceView";

const VIEW = 400;
const LINE = 20;

/** Each line's height (by its item's key), default LINE; the log's scroll offset. */
let heights: Map<string, number>;
let scroll: { top: number };
let observers: ResizeObserverCallback[];
let frames: FrameRequestCallback[];
const realRect = Element.prototype.getBoundingClientRect;
const realRO = window.ResizeObserver;

const box = (top: number, height: number) => ({ x: 0, y: top, top, bottom: top + height, left: 0, right: 600, width: 600, height, toJSON: () => ({}) }) as DOMRect;
const viewport = () => document.querySelector(".mantine-ScrollArea-viewport") as HTMLElement;
const lines = () => [...viewport().querySelectorAll("[data-item]")];
const total = () => lines().reduce((s, l) => s + (heights.get(l.getAttribute("data-item")!) ?? LINE), 0);
/** Where a line starts in the log's content. */
function offset(el: Element): number {
  let y = 0;
  for (const l of lines()) {
    if (l === el) return y;
    y += heights.get(l.getAttribute("data-item")!) ?? LINE;
  }
  throw new Error("not a line of the log");
}
/** A line's top on screen (the log's top is 0), by its item's key. */
const at = (item: string) => viewport().querySelector(`[data-item="${item}"]`)!.getBoundingClientRect().top;
/** The browser drawing what changed: every ResizeObserver of the page told. */
const drawn = () => act(() => observers.forEach((cb) => cb([], {} as ResizeObserver)));
/** `n` animation frames. */
function frame(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = frames.splice(0);
    act(() => due.forEach((f) => f(performance.now())));
  }
}

beforeEach(() => {
  heights = new Map();
  scroll = { top: 0 };
  observers = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  window.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      observers.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const v = viewport();
    if (!v || !v.contains(this)) return realRect.call(this);
    if (this === v) return box(0, VIEW);
    if (this.hasAttribute("data-item")) return box(offset(this) - scroll.top, heights.get(this.getAttribute("data-item")!) ?? LINE);
    const inner = [...this.querySelectorAll("[data-item]")];
    if (!inner.length) return box(-scroll.top, 0);
    const top = offset(inner[0]!);
    const last = inner.at(-1)!;
    return box(top - scroll.top, offset(last) + (heights.get(last.getAttribute("data-item")!) ?? LINE) - top);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = realRect;
  window.ResizeObserver = realRO;
  vi.unstubAllGlobals();
});

/** The log's scroll, laid out as above; `scrollTo` recorded (a smooth one doesn't move it: it's on its way). */
function layOut() {
  const v = viewport();
  const calls: ScrollToOptions[] = [];
  Object.defineProperty(v, "clientHeight", { configurable: true, get: () => VIEW });
  Object.defineProperty(v, "scrollHeight", { configurable: true, get: () => Math.max(VIEW, total()) });
  Object.defineProperty(v, "scrollTop", {
    configurable: true,
    get: () => scroll.top,
    set: (t: number) => {
      scroll.top = Math.max(0, Math.min(t, Math.max(VIEW, total()) - VIEW));
    },
  });
  v.scrollTo = ((o: ScrollToOptions) => {
    calls.push(o);
    if (o.behavior !== "smooth" && o.top !== undefined) v.scrollTop = o.top;
  }) as typeof v.scrollTo;
  return calls;
}
const scrolled = (top: number) => {
  viewport().scrollTop = top;
  act(() => viewport().dispatchEvent(new Event("scroll")));
};

const ev = (seq: number, type: string, more: Record<string, unknown> = {}): TraceEvent => ({ seq, ts_ms: 1_000 + seq, type, turn: "trn_1", ...more });
const hist = (entry: number, type: string, more: Record<string, unknown> = {}) => ({ ts_ms: 500 + entry, entry, type, ...more });
const text = (entry: number) => hist(entry, "assistant_text", { text: `older ${entry}` });
const state = (events: TraceEvent[], more: Partial<TraceState> = {}): TraceState => ({
  ...initialTrace(), events, last: events.at(-1)?.seq ?? 0, status: "live", animateAfter: events.at(-1)?.seq ?? 0, ...more,
});
function show(s: TraceState, loadOlder = () => {}) {
  const view = render(
    <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
      <TraceLog title="T" state={s} loadOlder={loadOlder} />
    </MantineProvider>,
  );
  return (next: TraceState) =>
    view.rerender(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
        <TraceLog title="T" state={next} loadOlder={loadOlder} />
      </MantineProvider>,
    );
}

const ring = Array.from({ length: 40 }, (_, i) => ev(i + 1, "assistant_text", { text: `live ${i + 1}` }));

describe("the trace's scroll, as its turns are drawn", () => {
  it("keeps the line being read in place across Load older, while the turns around it are drawn, its own made anew", () => {
    // The page held starts inside a turn (its start is on the page before), so loading that page makes the
    // first turn anew: its lines are new elements.
    const page2 = [text(20), text(21), text(22), hist(23, "turn_started", { input_kind: "user" }), text(24), text(25)];
    const page1 = [hist(10, "turn_started", { input_kind: "user" }), text(11), text(12), text(13)];
    const loadOlder = vi.fn();
    const rerender = show(state(ring, { older: page2, olderCursor: "c1" }), loadOlder);
    layOut();
    // Read from near the top: the page before is asked for; the line being read is "older 21"'s.
    scrolled(30);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    const read = "h21.0";
    const y = at(read);
    expect(y).toBe(LINE - 30);
    const before = viewport().querySelector(`[data-item="${read}"]`);
    rerender(state(ring, { older: [...page1, ...page2], olderCursor: null }));
    expect(viewport().querySelector(`[data-item="${read}"]`)).not.toBe(before);
    expect(at(read)).toBe(y);
    // The new page's lines drawn at heights other than their estimates, a frame on: still in place.
    heights.set("h11.0", 63).set("h12.0", 41);
    drawn();
    expect(at(read)).toBe(y);
    frame();
    heights.set("h13.0", 7);
    drawn();
    expect(at(read)).toBe(y);
    // Once it's settled, a turn drawn as the reader scrolls is the browser's to anchor, as before.
    frame(5);
    heights.set("h11.0", 90);
    drawn();
    expect(at(read)).toBe(y + 27);
  });

  it("holds the bottom while the lines it follows are drawn, and only then", () => {
    const rerender = show(state(ring));
    const calls = layOut();
    scrolled(total() - VIEW);
    rerender(state([...ring, ev(41, "assistant_text", { text: "new" })]));
    expect(calls.at(-1)).toEqual({ top: total() });
    // The new line takes its height a frame on (it fades in): followed.
    frame();
    heights.set("s41", 80);
    drawn();
    expect(scroll.top).toBe(total() - VIEW);
    // Long after, content growing (a result expanded) leaves the reader where they are.
    frame(5);
    const top = scroll.top;
    heights.set("s41", 140);
    drawn();
    expect(scroll.top).toBe(top);
  });

  it("goes on to the bottom when Jump to live stops short of it, the bottom having moved", async () => {
    show(state(ring));
    const calls = layOut();
    scrolled(0);
    act(() => screen.getByRole("button", { name: "Jump to live" }).click());
    expect(calls).toEqual([{ top: total(), behavior: "smooth" }]);
    // On its way, the turns it passed were drawn taller than their estimates; it stopped where it aimed.
    scroll.top = total() - VIEW;
    heights.set("s3", 300);
    frame(6);
    expect(calls.at(-1)).toEqual({ top: total(), behavior: "smooth" });
    // At the bottom, it's done: no more scrolling.
    scroll.top = total() - VIEW;
    frame(2);
    const n = calls.length;
    frame(10);
    expect(calls).toHaveLength(n);
  });
});
