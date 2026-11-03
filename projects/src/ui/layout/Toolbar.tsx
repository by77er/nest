// Actions in one row, `sm` apart, wrapping: secondary first, the primary rightmost, and destructive ones
// last of all after a divider, so a red button is never next to the one the owner meant.

import { Divider, Group } from "@mantine/core";
import { Children, type ReactNode, useLayoutEffect, useRef, useState } from "react";

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
  // The divider and the destructive actions wrap as one unit; on a line of their own (a phone), the
  // divider separates nothing and goes.
  const row = useRef<HTMLDivElement>(null);
  const unit = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const r = row.current;
    const u = unit.current;
    if (!r || !u || typeof ResizeObserver === "undefined") return;
    // Decided again only when the row's width changes: hiding the divider can let the unit fit back on
    // the line, which mustn't flip it back and forth at one width.
    let width = -1;
    const check = () => {
      if (r.clientWidth === width) return;
      width = r.clientWidth;
      const first = r.firstElementChild as HTMLElement | null;
      setWrapped(false);
      requestAnimationFrame(() => setWrapped(!!first && first !== u && u.offsetTop > first.offsetTop + 2));
    };
    check();
    const o = new ResizeObserver(check);
    o.observe(r);
    return () => o.disconnect();
  }, [any, danger]);
  return (
    <Group ref={row} gap="sm" wrap="wrap" justify={align === "end" ? "flex-end" : "flex-start"} data-ds="toolbar" {...aria}>
      {children}
      {danger && (
        <Group ref={unit} gap="sm" wrap="nowrap" data-slot="danger-unit" data-wrapped={wrapped || undefined}>
          {any && !wrapped && <Divider orientation="vertical" data-slot="separator" />}
          <Group gap="sm" wrap="wrap" data-slot="danger">
            {danger}
          </Group>
        </Group>
      )}
    </Group>
  );
}
