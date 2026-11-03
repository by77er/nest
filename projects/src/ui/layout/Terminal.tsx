// A terminal transcript (an agent's trace): the `terminal` surface with a hairline, the mono family
// throughout, long lines wrapped (`pre-wrap`, breaking anywhere) so nothing scrolls sideways while code
// keeps its spacing. A line is a glyph column and its text, so a wrapped line hangs under its text; a rule
// separates turns. It is text, so it selects and copies as text.
//
// Its rows are text-line targets (the skill's exception to the 32 px rule): a row that acts is a real
// button as wide as its row.

import { Box, UnstyledButton } from "@mantine/core";
import type { ReactNode } from "react";
import classes from "./Terminal.module.css";

/**
 * The glyphs, by codepoint: none has an emoji presentation (U+23FA, Claude Code's own bullet, does: it
 * isn't used), and a test pins each. `bullet` an assistant line or a finished tool call, `pending` a tool
 * still running, `result` a tool's output, `error` a failure (always with the danger role's color),
 * `note` a state, `ask` a question, `warn` a rate limit. The first four are drawn (Terminal.module.css).
 */
export const GLYPH = {
  bullet: "●",
  pending: "○",
  result: "⎿",
  error: "✗",
  note: "·",
  ask: "?",
  warn: "!",
} as const;

const DRAWN: Record<string, string> = {
  [GLYPH.bullet]: classes.dot!,
  [GLYPH.pending]: classes.ring!,
  [GLYPH.result]: classes.corner!,
  [GLYPH.error]: classes.cross!,
};

export type TermTone = "text" | "muted" | "danger" | "warning" | "success";
const COLOR: Record<TermTone, string> = {
  text: "var(--mantine-color-text)",
  muted: "var(--nest-term-muted)",
  danger: "var(--mantine-color-danger-text)",
  warning: "var(--nest-term-warning)",
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

/** One glyph in its tone: a drawn shape for the four the font lacks, the character itself otherwise. */
export function Glyph({ g, tone = "text" }: { g: string; tone?: TermTone }) {
  const drawn = DRAWN[g];
  return (
    <span
      data-slot="glyph"
      data-glyph={g}
      className={drawn ? `${classes.glyph} ${drawn}` : undefined}
      style={{ color: COLOR[tone], userSelect: "none", ["--glyph" as string]: COLOR[tone] }}
    >
      {g}
    </span>
  );
}

/**
 * One line: its glyph (in `glyphTone`), then its content (in `tone`), indented by `indent` glyph columns.
 * The content wraps under itself, never under the glyph. With `onClick` the whole row is a button
 * (`expanded` for a disclosure, `controls` its region).
 */
export function TermLine({ glyph, glyphTone = "text", tone = "text", indent = 0, children, onClick, expanded, controls, label, title, ...data }: {
  glyph?: string; glyphTone?: TermTone; tone?: TermTone; indent?: 0 | 1 | 2; children: ReactNode;
  onClick?: () => void; expanded?: boolean; controls?: string; label?: string; title?: string;
  [k: `data-${string}`]: string | undefined;
}) {
  const style = { display: "grid", gridTemplateColumns: "2ch minmax(0, 1fr)", paddingLeft: `${indent * 2}ch`, color: COLOR[tone], width: "100%", textAlign: "left" as const, ...WRAP };
  const inner = (
    <>
      {glyph ? <Glyph g={glyph} tone={glyphTone} /> : <span aria-hidden />}
      <span data-slot="text" style={{ minWidth: 0 }}>
        {children}
      </span>
    </>
  );
  if (onClick) {
    return (
      <UnstyledButton
        type="button"
        onClick={onClick}
        aria-expanded={expanded}
        aria-controls={controls}
        aria-label={label}
        title={title}
        ff="monospace"
        fz="sm"
        data-ds="term-line"
        {...data}
        style={style}
      >
        {inner}
      </UnstyledButton>
    );
  }
  return (
    <Box data-ds="term-line" {...data} style={style}>
      {inner}
    </Box>
  );
}

/** A quiet rule between turns: its label (a time, a stop reason, wrapping when narrow), then a hairline. */
export function TermRule({ children }: { children: ReactNode }) {
  return (
    <Box className={classes.rule} data-ds="term-rule" fz="xs" style={{ color: COLOR.muted }}>
      <span>{children}</span>
    </Box>
  );
}
