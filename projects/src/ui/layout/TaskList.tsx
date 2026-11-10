// The board as a list (the owner, 2026-11-10: "a table layout instead of a column layout"): one full-width
// frame of groups, each a quiet sticky header (its state, its count, a collapse toggle) over dense rows.
// A row is one line from `sm` up, in fixed columns (grip, state glyph, id, title, markers, worker, PR,
// updated); on a phone it wraps to two lines, the title first and its metadata below. The whole row
// opens the task (its title link's ::after covers it); its own controls sit above that link. A row drags
// by its grip, by pointer or keyboard (dnd-kit), within its group only.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, UnstyledButton } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconChevronRight, IconGripVertical } from "@tabler/icons-react";
import { type AnchorHTMLAttributes, forwardRef, type ReactNode, useId } from "react";
import { icon } from "../theme";
import classes from "./TaskList.module.css";

/** The list's frame: a hairline on the surface, its groups one under another. */
export function TaskList({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={classes.list} data-ds="task-list" aria-label={label} role="group">
      {children}
    </div>
  );
}

/**
 * A group of rows: a region named by its title, its header a toggle (sticky while its rows scroll by),
 * then its rows unless collapsed.
 */
export function TaskGroup({ title, count, open, onToggle, glyph, children }: { title: string; count: number; open: boolean; onToggle: () => void; glyph?: ReactNode; children: ReactNode }) {
  const id = useId();
  const body = useId();
  return (
    <section className={classes.group} aria-labelledby={id} data-ds="task-group" data-open={open || undefined}>
      <div role="heading" aria-level={4} className={classes.head}>
        <UnstyledButton className={classes.toggle} onClick={onToggle} aria-expanded={open} aria-controls={body} data-slot="group-toggle">
          <IconChevronRight size={icon.sm} className={classes.chevron} aria-hidden />
          {glyph}
          <span id={id} className={classes.title}>
            {title}
          </span>
          <span className={classes.count} aria-label={`${count} ${count === 1 ? "task" : "tasks"}`}>
            {count}
          </span>
        </UnstyledButton>
      </div>
      <div id={body} hidden={!open} data-slot="group-rows">
        {open && children}
      </div>
    </section>
  );
}

/** A task's state as a small glyph in its role's text color (gray: muted), named for screen readers. */
export function StateGlyph({ children, color, label, ...data }: { children: ReactNode; color: string; label: string; [k: `data-${string}`]: string | undefined }) {
  const text = color === "gray" ? "var(--nest-muted)" : `var(--mantine-color-${color}-text)`;
  return (
    <span className={classes.glyph} role="img" aria-label={label} title={label} style={{ color: text, ["--glyph-color" as string]: text }} {...data}>
      {children}
    </span>
  );
}

/** A row's title: the link that opens the task, its ::after covering the row. One line from `sm` up, cut with its full text as its title. */
export const TaskRowTitleAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(function TaskRowTitleAnchor({ className: _c, children, ...rest }, ref) {
  return (
    <a ref={ref} className={classes.rowTitle} data-ds="row-title" {...rest}>
      <span className={classes.rowTitleText} data-ds="truncate" title={typeof children === "string" ? children : undefined}>
        {children}
      </span>
    </a>
  );
});

export interface TaskRowProps {
  id: string;
  /** The task's title, the row's accessible name. */
  label: string;
  /** Whether it can be dragged (more than one row in its group). */
  sortable: boolean;
  glyph: ReactNode;
  /** Its short id, mono. */
  code: ReactNode;
  title: ReactNode;
  /** Its markers (waiting on, blocked, needs input, tainted, a failed start). */
  markers?: ReactNode;
  who?: ReactNode;
  pr?: ReactNode;
  updated: ReactNode;
  [k: `data-${string}`]: string | undefined;
}

/** One task: a row of fixed columns, its grip first. */
export function TaskRow({ id, label, sortable, glyph, code, title, markers, who, pr, updated, ...data }: TaskRowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !sortable });
  const reduced = useReducedMotion();
  return (
    <article
      ref={setNodeRef}
      className={classes.row}
      aria-label={label}
      data-ds="task-row"
      data-dragging={isDragging || undefined}
      style={{ transform: CSS.Translate.toString(transform), transition: reduced ? undefined : transition }}
      {...data}
    >
      <div className={classes.gripCell}>
        {sortable && (
          <ActionIcon ref={setActivatorNodeRef} variant="subtle" color="gray" className={classes.grip} aria-label={`Move ${label}`} data-dragging={isDragging || undefined} {...attributes} {...listeners}>
            <IconGripVertical size={icon.md} />
          </ActionIcon>
        )}
      </div>
      <div className={classes.glyphCell}>{glyph}</div>
      <div className={classes.titleCell}>{title}</div>
      <div className={classes.meta} data-slot="meta">
        <div className={classes.code}>{code}</div>
        <div className={classes.markers}>{markers}</div>
        <div className={classes.who}>{who}</div>
        <div className={classes.pr}>{pr}</div>
        <div className={classes.updated}>{updated}</div>
      </div>
    </article>
  );
}

/** A group's rows, when it has none to show (collapsed groups show nothing). */
export function TaskRowsEmpty({ children }: { children: ReactNode }) {
  return <div className={classes.empty}>{children}</div>;
}
