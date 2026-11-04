// A scrolling log of a fixed height (a trace). The chat's own pieces are in ChatLog.tsx.

import { ScrollArea } from "@mantine/core";
import type { ReactNode, RefObject } from "react";

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
