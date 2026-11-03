// Page layouts: a row of equal columns (the board), and a grid of cards (the projects). Their sizes are layout tokens (theme.ts), read in Layouts.module.css.

import { Button, Collapse, SimpleGrid } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { icon } from "../theme";
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
 * A view whose content is narrow: the content on the frame's left edge, and beside it, from `lg` on,
 * a context column (sticky) using the width for related things, not empty margins. Below `lg` the
 * context is a disclosure above the content (`contextLabel` names it).
 */
export function WithContext({ children, context, contextLabel }: { children: ReactNode; context: ReactNode; contextLabel: string }) {
  const wide = useMediaQuery("(min-width: 75em)") ?? true;
  const [open, { toggle }] = useDisclosure(false);
  return (
    <div className={classes.withContext} data-ds="with-context">
      {!wide && (
        <div data-slot="context-disclosure">
          <Button variant="default" fullWidth justify="space-between" onClick={toggle} aria-expanded={open} rightSection={open ? <IconChevronUp size={icon.sm} /> : <IconChevronDown size={icon.sm} />}>
            {contextLabel}
          </Button>
          <Collapse expanded={open}>
            <div className={classes.contextInner}>{context}</div>
          </Collapse>
        </div>
      )}
      <div data-slot="main" style={{ minWidth: 0 }}>
        {children}
      </div>
      {wide && (
        <aside className={classes.context} aria-label={contextLabel} data-slot="context">
          {context}
        </aside>
      )}
    </div>
  );
}

/** Sections of a page as Panels in a responsive grid: one column, two from `lg`. */
export function SectionGrid({ children }: { children: ReactNode }) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl" verticalSpacing="xl" data-ds="section-grid">
      {children}
    </SimpleGrid>
  );
}
