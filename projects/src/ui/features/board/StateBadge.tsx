import { Badge, type BadgeProps } from "@mantine/core";
import type { TaskState } from "../../api/types";
import { STATE_COLOR, STATE_LABEL } from "../../status";

/** A task's state in its semantic color (src/ui/status.ts). `component="span"` inside running text. */
export function StateBadge({ state, component = "div", ...rest }: { state: TaskState; component?: "div" | "span" } & Omit<BadgeProps, "color" | "children">) {
  return (
    <Badge component={component} variant="light" color={STATE_COLOR[state]} data-state={state} {...rest}>
      {STATE_LABEL[state]}
    </Badge>
  );
}
