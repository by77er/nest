// A terminal transcript (an agent's trace): the `terminal` surface with a hairline, the mono family
// throughout, long lines wrapped (`pre-wrap`, breaking anywhere) so nothing scrolls sideways while code
// keeps its spacing. A line is a glyph column and its text, so a wrapped line hangs under its text; a rule
// separates turns. It is text, so it selects and copies as text.

import { Box, Divider, Text } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./Terminal.module.css";

/**
 * The glyphs, by codepoint: none has an emoji presentation (U+23FA, Claude Code's own bullet, does: it
 * isn't used), and a test pins each. `bullet` an assistant line or a finished tool call, `pending` a tool still running,
 * `result` a tool's output, `error` a failure (always with the danger role's color), `note` a state.
 */
export const GLYPH = {
  bullet: "\u25CF",
  pending: "\u25CB",
  result: "\u23BF",
  error: "\u2717",
  note: "\u00B7",
  ask: "?",
} as const;

export type TermTone = "text" | "muted" | "danger" | "warning" | "success";
const COLOR: Record<TermTone, string> = {
  text: "var(--mantine-color-text)",
  muted: "var(--mantine-color-dimmed)",
  danger: "var(--mantine-color-danger-text)",
  warning: "var(--mantine-color-warning-text)",
  success: "var(--mantine-color-success-text)",
};

const WRAP = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", wordBreak: "normal" } as const;

/** The surface; it frames its log (which scrolls inside it). `fill`: the rest of a column with a height. */
export function Terminal({ children, fill = false, ...data }: { children: ReactNode; fill?: boolean; [k: `data-${string}`]: string | undefined }) {
  return (
    <Box
      p="md"
      ff="monospace"
      fz="sm"
      data-ds="terminal"
      {...data}
      style={{
        ...WRAP, background: "var(--nest-terminal)", border: "var(--nest-terminal-border)", borderRadius: "var(--mantine-radius-md)", minWidth: 0, color: COLOR.text,
        ...(fill ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : {}),
      }}
    >
      {children}
    </Box>
  );
}

/**
 * One line: its glyph (in `glyphTone`), then its content (in `tone`), indented by `indent` glyph columns.
 * The content wraps under itself, never under the glyph.
 */
export function TermLine({ glyph, glyphTone = "text", tone = "text", indent = 0, children, ...data }: {
  glyph?: string; glyphTone?: TermTone; tone?: TermTone; indent?: 0 | 1 | 2; children: ReactNode; [k: `data-${string}`]: string | undefined;
}) {
  return (
    <Box data-ds="term-line" {...data} style={{ display: "grid", gridTemplateColumns: "2ch minmax(0, 1fr)", paddingLeft: `${indent * 2}ch`, color: COLOR[tone], ...WRAP }}>
      <span aria-hidden={glyph ? undefined : true} data-slot="glyph" className={glyph === GLYPH.result ? classes.corner : undefined} style={{ color: COLOR[glyphTone], userSelect: "none" }}>
        {glyph ?? ""}
      </span>
      <span data-slot="text" style={{ minWidth: 0 }}>
        {children}
      </span>
    </Box>
  );
}

/** A quiet rule between turns, with its label (a time, a stop reason) in muted text. */
export function TermRule({ children }: { children: ReactNode }) {
  return (
    <Divider
      my="sm"
      labelPosition="left"
      data-ds="term-rule"
      label={
        <Text component="span" ff="monospace" fz="xs" c="dimmed">
          {children}
        </Text>
      }
    />
  );
}
