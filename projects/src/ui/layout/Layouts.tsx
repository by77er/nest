// Page layouts: a row of equal columns (the board), and a grid of cards (the projects). Their sizes are layout tokens (theme.ts), read in Layouts.module.css.

import { Badge, type BadgeProps, SimpleGrid } from "@mantine/core";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import classes from "./Layouts.module.css";

export function ColumnGrid({ children, columns }: { children: ReactNode; columns: number }) {
  return (
    <div className={classes.columns} data-ds="columns" data-columns={columns}>
      {children}
    </div>
  );
}

/** Cards in a grid, `md` apart: one column on a phone, two from `sm`, three from `lg`. */
export function CardGrid({ children }: { children: ReactNode }) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" verticalSpacing="md" data-ds="card-grid">
      {children}
    </SimpleGrid>
  );
}

export interface TriggerBadgeProps extends Pick<BadgeProps, "size" | "color" | "variant" | "leftSection" | "children"> {
  "data-marker"?: string;
  "data-verdict"?: string;
  "aria-label"?: string;
}

/**
 * A badge whose details open on hover, focus or a tap (a Tooltip's child). The wrapper is the target:
 * focusable, with the theme's ring, and on touch at least 44 px each way, the badge centred in it, its
 * own box unchanged; the room is layout, so it never overlaps a neighbour. The Tooltip's props (its
 * handlers, its className) are kept, ours merged in.
 */
export const TriggerBadge = forwardRef<HTMLSpanElement, TriggerBadgeProps & HTMLAttributes<HTMLSpanElement>>(function TriggerBadge(
  { size, color, variant, leftSection, children, "data-marker": marker, "data-verdict": verdict, "aria-label": label, ...target },
  ref,
) {
  return (
    <span {...target} ref={ref} tabIndex={0} aria-label={label} data-marker={marker} data-verdict={verdict} data-ds="trigger-badge" className={[classes.trigger, target.className].filter(Boolean).join(" ")}>
      <Badge size={size} color={color} variant={variant} leftSection={leftSection}>
        {children}
      </Badge>
    </span>
  );
});
