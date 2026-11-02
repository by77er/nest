// Actions in one row, `sm` apart, wrapping: secondary first, the primary rightmost, and destructive ones
// last of all after a divider, so a red button is never next to the one the owner meant.

import { Divider, Group } from "@mantine/core";
import { Children, type ReactNode } from "react";

export interface ToolbarProps {
  children?: ReactNode;
  /** Destructive actions (cancel, delete): last, after a divider. Each asks for confirmation. */
  danger?: ReactNode;
  /** Where the row sits in its container: at the end (a heading row, a form's foot) or the start. */
  align?: "start" | "end";
  "aria-label"?: string;
}

export function Toolbar({ children, danger, align = "end", ...aria }: ToolbarProps) {
  // `{cond && <Button/>}` children that render nothing don't count: no divider before a lone red button.
  const any = Children.toArray(children).length > 0;
  return (
    <Group gap="sm" wrap="wrap" justify={align === "end" ? "flex-end" : "flex-start"} data-ds="toolbar" {...aria}>
      {children}
      {danger && (
        <>
          {any && <Divider orientation="vertical" data-slot="separator" />}
          <Group gap="sm" wrap="wrap" data-slot="danger">
            {danger}
          </Group>
        </>
      )}
    </Group>
  );
}
