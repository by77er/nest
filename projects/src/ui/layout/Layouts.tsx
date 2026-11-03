// Page layouts: a row of equal columns (the board), and a grid of cards (the projects). Their sizes are layout tokens (theme.ts), read in Layouts.module.css.

import { Badge, type BadgeProps, Button, Collapse, SimpleGrid } from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { icon } from "../theme";
import { type AnchorHTMLAttributes, forwardRef, type ReactNode } from "react";
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
 * A view whose content is narrow: the content at its measure on the frame's left edge, and beside it,
 * from `lg` on, a context column (sticky, at most a third of the width) using the width for related
 * things, not empty margins. Below `lg` the
 * context is a disclosure above the content (`contextLabel` names it).
 */
export function WithContext({ children, context, contextLabel, measure }: { children: ReactNode; context: ReactNode; contextLabel: string; measure: "reading" | "form" }) {
  const wide = useMediaQuery("(min-width: 75em)") ?? true;
  const [open, { toggle }] = useDisclosure(false);
  return (
    <div className={classes.withContext} data-ds="with-context" data-main={measure}>
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

/** Sections of a page as Panels in a responsive grid: one column, two from `lg`, each as tall as its content. */
export function SectionGrid({ children }: { children: ReactNode }) {
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="xl" verticalSpacing="xl" style={{ alignItems: "start" }} data-ds="section-grid">
      {children}
    </SimpleGrid>
  );
}

export interface BadgeAnchorProps extends Pick<BadgeProps, "size" | "color" | "variant" | "leftSection" | "children"> {}

/**
 * A badge that goes somewhere (a project's "needs you", to its Board): the link wraps the badge, and on
 * touch it's at least 44 px each way around it, its own box unchanged; the room is layout, never over
 * a neighbour.
 */
export const BadgeAnchor = forwardRef<HTMLAnchorElement, BadgeAnchorProps & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "color">>(function BadgeAnchor(
  { size, color, variant, leftSection, children, className, ...anchor },
  ref,
) {
  return (
    <a {...anchor} ref={ref} className={[classes.badgeAnchor, className].filter(Boolean).join(" ")} data-ds="badge-anchor">
      <Badge size={size} color={color} variant={variant} leftSection={leftSection} component="span">
        {children}
      </Badge>
    </a>
  );
});
