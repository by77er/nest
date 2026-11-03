// A conversation's pieces: a message on the owner's side (end, on the subtle ground), the other's
// (start, a hairline around it), or a note across the middle; the composer pinned below them; and a
// scrolling log of a fixed height.

import { Box, ScrollArea } from "@mantine/core";
export { Bubble } from "./Rich";
import { forwardRef, type ReactNode, type RefObject } from "react";

/** A log's lines wrap to its width: never Mantine's `min-width: min-content`, which lets a long line scroll it sideways. */
const WRAPPED = { content: { minWidth: 0 } };

/** A log of a fixed height that scrolls in itself (the trace): the viewport's rest from `lg` on. */
export function ScrollLog({ children, viewportRef, fill = false }: { children: ReactNode; viewportRef?: RefObject<HTMLDivElement | null>; fill?: boolean }) {
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

/**
 * What stays at the viewport's bottom while the page scrolls above it (a conversation's composer): on
 * the page's ground, with a hairline above, the page's width.
 */
export const PinnedFooter = forwardRef<HTMLDivElement, { children: ReactNode }>(function PinnedFooter({ children }, ref) {
  return (
    <Box
      ref={ref}
      pt="md"
      pb="lg"
      data-ds="pinned-footer"
      style={{ position: "sticky", bottom: 0, zIndex: 1, background: "var(--nest-page-bg)", borderTop: "var(--nest-border)" }}
    >
      {children}
    </Box>
  );
});
