// Two page layouts: a row of equal columns (the board), and content with a side panel (the board and
// its chat). Their sizes are layout tokens (theme.ts), read in Layouts.module.css.

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

/** The main content and, when there is one, a side panel: beside it from `lg` on, below it before. */
export function SplitView({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={classes.split} data-ds="split">
      <div className={classes.splitMain} data-slot="main">
        {children}
      </div>
      {aside && (
        <div className={classes.splitAside} data-slot="aside">
          {aside}
        </div>
      )}
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
