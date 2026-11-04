// Component tests run in jsdom, which lacks a few browser APIs Mantine and dnd-kit use.
import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The pages load lazily (one chunk each), and a CI runner renders jsdom far slower than a laptop: the
// default 1 s for `findBy…`/`waitFor` ran out there (PR #108's first run) while the page was still loading.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLElement.prototype.scrollTo = () => {};
window.scrollTo = () => {};
// Mantine's autosizing textarea listens for web fonts loading.
if (!("fonts" in document)) {
  Object.defineProperty(document, "fonts", { value: { addEventListener: () => {}, removeEventListener: () => {}, ready: Promise.resolve() } });
}

// ProseMirror (the description editor) measures the selection to scroll it into view and to place the
// cursor: jsdom lays nothing out, so every rect is empty.
const noRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= noRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();
(Text.prototype as unknown as { getClientRects?: () => DOMRectList }).getClientRects ??= noRects;
document.elementFromPoint ??= () => null;
// jsdom has no ClipboardEvent, which ProseMirror's paste makes.
globalThis.ClipboardEvent ??= class extends Event {
  clipboardData = null;
} as unknown as typeof ClipboardEvent;
