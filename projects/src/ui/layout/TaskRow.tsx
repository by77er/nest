// A board row (TaskList.tsx): one task in fixed columns, dragged by its grip with dnd-kit. In a module of its
// own, apart from the list's frame and the title link that every page uses, so that dnd-kit loads only
// with the board's chunk, not with the entry.

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconGripVertical } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { icon } from "../theme";
import classes from "./TaskList.module.css";

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
