// The one bordered surface: cards, side panels, banners. A hairline border, the `md` radius, `lg`
// padding (`md` when dense). Panels don't nest: inside one, group with spacing and dividers. A Well is
// the borderless region that holds Panels (a board column).

import { Box, Paper, type PaperProps, Table } from "@mantine/core";
import { forwardRef, type ReactNode } from "react";

export type PanelTone = "default" | "warning";

export interface PanelProps extends Omit<PaperProps, "p" | "bg" | "withBorder" | "shadow" | "radius" | "style"> {
  /** `default`: the surface; `warning`: a banner of things waiting on the owner. */
  tone?: PanelTone;
  dense?: boolean;
  /** Lifted (`raised` shadow): while dragged. */
  raised?: boolean;
  component?: "div" | "section" | "article" | "aside";
  children?: ReactNode;
  role?: string;
  [data: `data-${string}`]: string | number | boolean | undefined;
  [aria: `aria-${string}`]: string | number | boolean | undefined;
}

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel({ tone = "default", dense = false, raised = false, component = "div", ...rest }, ref) {
  return (
    <Paper
      ref={ref}
      component={component}
      withBorder
      radius="md"
      p={dense ? "md" : "lg"}
      shadow={raised ? "raised" : undefined}
      data-ds="panel"
      data-tone={tone}
      style={
        tone === "warning"
          ? { background: "var(--mantine-color-warning-light)", borderColor: "var(--mantine-color-warning-outline)" }
          : { background: "var(--nest-surface)", borderColor: "var(--nest-border-color)" }
      }
      {...rest}
    />
  );
});

/** A borderless region on the subtle ground that holds Panels: common region without another border. */
export function Well({ children, component = "div", ...rest }: { children: ReactNode; component?: "div" | "section"; [k: `aria-${string}`]: string | undefined }) {
  return (
    <Box component={component} p="sm" data-ds="well" style={{ background: "var(--nest-subtle)", borderRadius: "var(--mantine-radius-md)", minWidth: 0 }} {...rest}>
      {children}
    </Box>
  );
}

/**
 * A table in a Panel frame: the frame keeps the page's outer space, the rows are dense (`sm`), and a
 * table wider than the screen scrolls inside its own frame, never the page.
 */
export function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <Paper withBorder radius="md" data-ds="table-frame" style={{ background: "var(--nest-surface)", borderColor: "var(--nest-border-color)", overflow: "hidden" }}>
      <Table.ScrollContainer minWidth="40rem" type="native">
        <Table verticalSpacing="sm" horizontalSpacing="lg" aria-label={label} style={{ fontVariantNumeric: "tabular-nums" }}>
          {children}
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
