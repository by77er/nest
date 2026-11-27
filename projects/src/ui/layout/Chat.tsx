// A scrolling log of a fixed height (a trace). The chat's own pieces are in ChatLog.tsx.

import { ScrollArea } from "@mantine/core";
import { useMergedRef } from "@mantine/hooks";
import { type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";

/** A log's lines wrap to its width: never Mantine's `min-width: min-content`, which lets a long line scroll it sideways. */
const WRAPPED = { content: { minWidth: 0 } };

/** A mono character's advance in `em` (JetBrains Mono's, as most mono fonts'). */
const MONO_ADVANCE = 0.6;

/**
 * Keeps `--nest-log-cols` on a log's viewport: how many mono characters fit across it, for the estimated
 * height of what isn't drawn yet (TermTurn). Set on the element, so a resize restyles nothing else.
 */
function useColumns(ref: RefObject<HTMLDivElement | null>) {
  // Before the first paint: the turns' first estimates are at the log's own width.
  useLayoutEffect(() => {
    const v = ref.current;
    if (!v) return;
    const measure = () => {
      if (v.clientWidth === 0) return; // hidden (a tab switched away): kept as it was
      const cols = String(Math.max(30, Math.floor(v.clientWidth / (parseFloat(getComputedStyle(v).fontSize) * MONO_ADVANCE))));
      if (v.style.getPropertyValue("--nest-log-cols") !== cols) v.style.setProperty("--nest-log-cols", cols);
    };
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(v);
    return () => seen.disconnect();
  }, [ref]);
}

/** A log of a fixed height that scrolls in itself (the trace): the viewport's rest from `lg` on. */
export function ScrollLog({ children, viewportRef: outer, fill = false }: { children: ReactNode; viewportRef?: RefObject<HTMLDivElement | null>; fill?: boolean }) {
  const own = useRef<HTMLDivElement>(null);
  const viewportRef = useMergedRef(own, outer);
  useColumns(own);
  // `fill`: the rest of a column that has a height of its own (the sheet's trace column), scrolling in itself.
  if (fill) {
    return (
      <ScrollArea viewportRef={viewportRef} type="auto" aria-live="polite" offsetScrollbars style={{ flex: 1, minHeight: 0 }} styles={WRAPPED} data-fill="true">
        {children}
      </ScrollArea>
    );
  }
  return (
    <ScrollArea.Autosize mah={{ base: "var(--nest-log-max)", lg: "var(--nest-log-max-beside)" }} viewportRef={viewportRef} type="auto" aria-live="polite" offsetScrollbars styles={WRAPPED}>
      {children}
    </ScrollArea.Autosize>
  );
}
