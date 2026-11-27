// Something that just arrived, faded in once at `base` (180 ms) on entering. `animate` is read only when it
// mounts: an item that was already there, or came in a replay, never moves. Reduced motion makes it
// instant (Mantine's `respectReducedMotion`, and global.css). `item` names what it holds (`data-item`), so a
// log can find the same line again once it is drawn anew (the trace holding the reader's line, TraceView).

import { Box, Transition } from "@mantine/core";
import { type ReactNode, useEffect, useState } from "react";
import { motion } from "../theme";

export function FadeIn({ animate, item, children }: { animate: boolean; item?: string; children: ReactNode }) {
  const [shown, setShown] = useState(!animate);
  useEffect(() => {
    if (shown) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [shown]);
  return (
    <Transition mounted={shown} transition="fade" duration={motion.base} timingFunction={motion.enter} keepMounted>
      {(styles) => (
        <Box style={styles} data-ds="fade-in" data-animated={animate ? "true" : "false"} data-item={item}>
          {children}
        </Box>
      )}
    </Transition>
  );
}
