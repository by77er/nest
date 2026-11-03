// Page layouts: a row of equal columns (the board), and a grid of cards (the projects). Their sizes are layout tokens (theme.ts), read in Layouts.module.css.

import { SimpleGrid } from "@mantine/core";
import type { ReactNode } from "react";
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

/**
 * A small trigger (a badge with a tooltip) on touch: its own room grows to the 44 px target, centred
 * around the unchanged visual box, so the hit area never reaches over a neighbour.
 */
export function TouchTarget({ children }: { children: ReactNode }) {
  return (
    <span className={classes.touchTarget} data-ds="touch-target">
      {children}
    </span>
  );
}
