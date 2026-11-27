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
let hiddenLog: boolean;
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
  hiddenLog = false;
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
  Object.defineProperty(v, "clientHeight", { configurable: true, get: () => (hiddenLog ? 0 : VIEW) });
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
// The page held starts inside a turn (its start is on the page before), so loading that page makes the first
// turn anew: its lines are new elements.
const page2 = [text(20), text(21), text(22), hist(23, "turn_started", { input_kind: "user" }), text(24), text(25)];
const page1 = [hist(10, "turn_started", { input_kind: "user" }), text(11), text(12), text(13)];
const READ = "h21.0";

/** Read from near the top, the page before asked for (and on its way); then `arrive` brings it. */
function readingAtTop() {
  const loadOlder = vi.fn();
  const rerender = show(state(ring, { older: page2, olderCursor: "c1" }), loadOlder);
  const calls = layOut();
  scrolled(30);
  expect(loadOlder).toHaveBeenCalledTimes(1);
  rerender(state(ring, { older: page2, olderCursor: "c1", olderState: "loading" }));
  return { rerender, calls, arrive: () => rerender(state(ring, { older: [...page1, ...page2], olderCursor: null })) };
}

describe("the trace's scroll, as its turns are drawn", () => {
  it("keeps the line being read in place across Load older, while the turns around it are drawn, its own made anew", () => {
    const { arrive } = readingAtTop();
    expect(at(READ)).toBe(LINE - 30);
    // While the page is on its way, a line above is drawn taller than its estimate: the line being read is
    // where the reader now sees it (the browser anchors nothing at the top).
    heights.set("h20.0", 35);
    drawn();
    const y = at(READ);
    expect(y).toBe(35 - 30);
    const before = viewport().querySelector(`[data-item="${READ}"]`);
    arrive();
    expect(viewport().querySelector(`[data-item="${READ}"]`)).not.toBe(before);
    expect(at(READ)).toBe(y);
    // The new page's lines drawn at heights other than their estimates, a frame on: still in place.
    heights.set("h11.0", 63).set("h12.0", 41);
    drawn();
    expect(at(READ)).toBe(y);
    // Still held three frames on (each draw that moved it starts the count again), to the pixel.
    frame(3);
    heights.set("h13.0", 7);
    drawn();
    expect(at(READ)).toBe(y);
    frame(3);
    heights.set("h12.0", 43);
    drawn();
    expect(at(READ)).toBe(y);
    // Once it's settled, a turn drawn as the reader scrolls is the browser's to anchor, as before.
    frame(5);
    heights.set("h11.0", 90);
    drawn();
    expect(at(READ)).toBe(y + 27);
  });

  it("holds the line the reader scrolled to while the page was on its way", () => {
    const { arrive } = readingAtTop();
    scrolled(45);
    const y = at(READ);
    expect(y).toBe(LINE - 45);
    arrive();
    expect(at(READ)).toBe(y);
  });

  it("lets the hold go once nothing above it moves", () => {
    // Lines arriving below, drawn frame after frame, keep nothing held: a turn drawn above later moves it.
    const { arrive } = readingAtTop();
    arrive();
    for (let i = 0; i < 8; i++) {
      heights.set("s40", 30 + i);
      drawn();
      frame();
    }
    const y = at(READ);
    heights.set("h11.0", 50);
    drawn();
    expect(at(READ)).toBe(y + 30);
  });

  it("lets the hold go to a scroll that isn't its own (find-in-page, a screen reader)", () => {
    const { arrive } = readingAtTop();
    arrive();
    scrolled(300);
    heights.set("h11.0", 50);
    drawn();
    expect(scroll.top).toBe(300);
  });

  it("lets the hold go to the reader's wheel", () => {
    const { arrive } = readingAtTop();
    arrive();
    const y = at(READ);
    act(() => viewport().parentElement!.dispatchEvent(new Event("wheel")));
    heights.set("h11.0", 50);
    drawn();
    expect(at(READ)).toBe(y + 30);
  });

  it("measures nothing from a page that failed: one that comes later leaves the reader where they are", () => {
    const { rerender } = readingAtTop();
    rerender(state(ring, { older: page2, olderCursor: "c1", olderState: "error" }));
    scrolled(200);
    rerender(state(ring, { older: [...page1, ...page2], olderCursor: null }));
    expect(scroll.top).toBe(200);
  });

  it("follows the bottom while a page is on its way", () => {
    const loadOlder = vi.fn();
    const older = page2;
    const rerender = show(state(ring, { older, olderCursor: "c1" }), loadOlder);
    layOut();
    scrolled(total() - VIEW);
    act(() => screen.getByRole("button", { name: /load earlier/ }).click());
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender(state(ring, { older, olderCursor: "c1", olderState: "loading" }));
    rerender(state([...ring, ev(41, "assistant_text", { text: "new" })], { older, olderCursor: "c1", olderState: "loading" }));
    frame();
    heights.set("s41", 80);
    drawn();
    expect(scroll.top).toBe(total() - VIEW);
  });

  it("lets the hold go when Jump to live is pressed", () => {
    const { arrive, calls } = readingAtTop();
    arrive();
    act(() => screen.getByRole("button", { name: "Jump to live" }).click());
    expect(calls.at(-1)).toEqual({ top: total(), behavior: "smooth" });
    // On its way down, a turn above is drawn: the jump isn't pulled back to the line.
    scroll.top = 500;
    heights.set("h11.0", 50);
    drawn();
    expect(scroll.top).toBe(500);
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
    // Scrolled up while it's drawn: no longer followed.
    rerender(state([...ring, ev(41, "assistant_text", { text: "new" }), ev(42, "assistant_text", { text: "newer" })]));
    scrolled(total() - VIEW - 200);
    const up = scroll.top;
    heights.set("s42", 90);
    drawn();
    expect(scroll.top).toBe(up);
    scrolled(total() - VIEW);
    // Long after, content growing (a result expanded) leaves the reader where they are.
    frame(5);
    const top = scroll.top;
    heights.set("s41", 140);
    drawn();
    expect(scroll.top).toBe(top);
  });

  it("ends Jump to live on the reader's wheel, or a scroll back up (find-in-page), and gives up after a few tries", () => {
    show(state(ring));
    const calls = layOut();
    const jumpTo = () => {
      scrolled(0);
      act(() => screen.getByRole("button", { name: "Jump to live" }).click());
    };
    const after = (f: () => void) => {
      const n = calls.length;
      f();
      frame(12);
      return calls.length - n;
    };
    // The wheel: it stays where the reader took it.
    jumpTo();
    expect(after(() => act(() => viewport().parentElement!.dispatchEvent(new Event("wheel"))))).toBe(0);
    // Part way down, then sent back up past half the log: the reader's.
    jumpTo();
    expect(after(() => {
      scrolled(350);
      scrolled(100);
    })).toBe(0);
    // Stuck short (nothing moves it): a few tries, then it stops.
    jumpTo();
    frame(200);
    const n = calls.length;
    frame(40);
    expect(calls.length).toBe(n);
  });

  it("lands Jump to live at the bottom when the log is shown again, hidden on its way", () => {
    show(state(ring));
    layOut();
    scrolled(0);
    act(() => screen.getByRole("button", { name: "Jump to live" }).click());
    scroll.top = 300;
    hiddenLog = true;
    drawn();
    frame(60);
    hiddenLog = false;
    drawn();
    expect(scroll.top).toBe(total() - VIEW);
  });

  it("stops following what's being drawn at the reader's wheel, before the log has moved", () => {
    const rerender = show(state(ring));
    layOut();
    scrolled(total() - VIEW);
    rerender(state([...ring, ev(41, "assistant_text", { text: "new" })]));
    const top = scroll.top;
    act(() => viewport().parentElement!.dispatchEvent(new Event("wheel")));
    heights.set("s41", 80);
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
    // It ends where it aimed, the bottom having moved on a little (within what counts as at the bottom):
    // it goes on still.
    const aimed = total() - VIEW;
    heights.set("s4", 30);
    scrolled(aimed);
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
