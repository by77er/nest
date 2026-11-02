// A sortable card (dnd-kit): the feature renders its content and places the grip; the transform, the
// lift while dragged and the reduced-motion rule live here. The grip is a 32 px target (44 on touch).

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon } from "@mantine/core";
import { useReducedMotion } from "@mantine/hooks";
import { IconGripVertical } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { icon } from "../theme";
import classes from "./Layouts.module.css";
import { Panel, type PanelProps } from "./Panel";

export interface SortablePanelProps extends Omit<PanelProps, "children" | "raised"> {
  id: string;
  disabled?: boolean;
  /** The grip's accessible name ("Move <title>"). */
  gripLabel: string;
  /** The card's content, given the grip to place (null when it can't be dragged). */
  children: (grip: ReactNode) => ReactNode;
}

export function SortablePanel({ id, disabled = false, gripLabel, children, ...panel }: SortablePanelProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  const reduced = useReducedMotion();
  const grip = disabled ? null : (
    <ActionIcon ref={setActivatorNodeRef} variant="subtle" color="gray" ml="auto" className={classes.grip} aria-label={gripLabel} data-dragging={isDragging || undefined} {...attributes} {...listeners}>
      <IconGripVertical size={icon.md} />
    </ActionIcon>
  );
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition: reduced ? undefined : transition, position: "relative", zIndex: isDragging ? 2 : undefined }}>
      <Panel raised={isDragging} {...panel}>
        {children(grip)}
      </Panel>
    </div>
  );
}
