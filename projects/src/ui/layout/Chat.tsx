// A conversation's pieces: a scrolling log of a fixed height (the viewport's rest beside the board), and
// a message on the owner's side (end, on the subtle ground), the other's (start), or a note across the
// middle. Borderless: the log sits in one Panel already.

import { Box, ScrollArea } from "@mantine/core";
import type { ReactNode, RefObject } from "react";

export function ScrollLog({ children, viewportRef }: { children: ReactNode; viewportRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <ScrollArea.Autosize mah={{ base: "var(--nest-log-max)", lg: "var(--nest-log-max-beside)" }} viewportRef={viewportRef} type="auto" aria-live="polite" offsetScrollbars>
      {children}
    </ScrollArea.Autosize>
  );
}

export function Bubble({ side, children, ...data }: { side: "start" | "end" | "note"; children: ReactNode; [k: `data-${string}`]: string | undefined }) {
  const style =
    side === "note"
      ? { alignSelf: "center", textAlign: "center" as const, maxWidth: "100%" }
      : { alignSelf: side === "end" ? "flex-end" : "flex-start", maxWidth: "88%", background: side === "end" ? "var(--nest-subtle)" : "transparent", border: side === "end" ? "none" : "var(--nest-border)" };
  return (
    <Box px={side === "note" ? "sm" : "md"} py={side === "note" ? "2xs" : "sm"} style={{ ...style, borderRadius: "var(--mantine-radius-md)" }} data-ds="bubble" {...data}>
      {children}
    </Box>
  );
}

/**
 * What stays at the viewport's bottom while the page scrolls above it (a conversation's composer): on
 * the page's ground, with a hairline above, the page's width.
 */
export function PinnedFooter({ children }: { children: ReactNode }) {
  return (
    <Box
      pt="md"
      pb="lg"
      data-ds="pinned-footer"
      style={{ position: "sticky", bottom: 0, zIndex: 1, background: "var(--nest-page-bg)", borderTop: "var(--nest-border)" }}
    >
      {children}
    </Box>
  );
}
