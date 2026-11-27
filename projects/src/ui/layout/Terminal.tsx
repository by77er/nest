// A terminal transcript (an agent's trace): the `terminal` surface with a hairline, the mono family
// throughout, long lines wrapped (`pre-wrap`, breaking anywhere) so nothing scrolls sideways while code
// keeps its spacing. A line is a glyph column and its text, so a wrapped line hangs under its text; a rule
// separates turns. It is text, so it selects and copies as text.
//
// Its rows are text-line targets (the skill's exception to the 32 px rule): a row that acts is a real
// button as wide as its row.

import { Box, Stack as MantineStack, UnstyledButton } from "@mantine/core";
import type { CSSProperties, ReactNode } from "react";
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
/** One style object per tone, made once. */
const byTone = (make: (t: TermTone) => CSSProperties) => ({ text: make("text"), muted: make("muted"), danger: make("danger"), warning: make("warning"), success: make("success") });

// Style objects made once, not per line (a trace draws thousands of lines): a glyph's by tone, a line's by
// indent and tone.
const GLYPH_STYLE = byTone((t) => ({ color: COLOR[t], userSelect: "none", ["--glyph" as string]: COLOR[t] }));
const lineStyle = (indent: number) =>
  byTone((t) => ({ display: "grid", gridTemplateColumns: "2ch minmax(0, 1fr)", paddingLeft: `${indent * 2}ch`, color: COLOR[t], width: "100%", textAlign: "left", ...WRAP }));
const LINE_STYLE = { 0: lineStyle(0), 1: lineStyle(1), 2: lineStyle(2) };
const TEXT_STYLE: CSSProperties = { minWidth: 0 };

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
      style={GLYPH_STYLE[tone]}
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
  const style = LINE_STYLE[indent][tone];
  const inner = (
    <>
      {glyph ? <Glyph g={glyph} tone={glyphTone} /> : <span aria-hidden />}
      <span data-slot="text" style={TEXT_STYLE}>
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

/**
 * An assistant's Markdown in the terminal (the trace's TraceMarkdown renders into it): mono at the
 * terminal's one size, styled as Claude Code prints Markdown (Terminal.module.css, `.md`).
 */
export function TermProse({ children }: { children: ReactNode }) {
  return (
    <div className={classes.md} data-ds="term-prose">
      {children}
    </div>
  );
}

/**
 * One turn of the transcript, its lines `md` apart. Off screen, the browser skips its style, layout and paint
 * (`content-visibility: auto`, Terminal.module.css), so a long trace costs only what is on screen; it is
 * still found by find-in-page, focused, selected and read out as before. Skipped, it keeps the height it had
 * when last drawn; one not drawn yet is held at an estimate so the scrollbar barely moves when it is:
 * `rows` lines, `chars` characters of text wrapping at the log's width (`--nest-log-cols`, ScrollLog's) and
 * `gaps` gaps of `md`. The last turn (the one growing) is never skipped.
 */
export function TermTurn({ rows, chars, gaps, children, ...rest }: {
  rows: number; chars: number; gaps: number; children: ReactNode;
  role?: string; "aria-label"?: string; [k: `data-${string}`]: string | undefined;
}) {
  return (
    <MantineStack
      gap="md"
      className={classes.turn}
      {...rest}
      style={{ "--nest-turn-rows": rows.toFixed(1), "--nest-turn-chars": String(Math.round(chars)), "--nest-turn-gaps": String(gaps) } as CSSProperties}
    >
      {children}
    </MantineStack>
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

/** The terminal's first line when nothing above names it: a note (the agent's state) and a status, at the right. */
export function TermStatus({ note, children }: { note?: string; children: ReactNode }) {
  return (
    <Box data-slot="status-row" pb="sm" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "var(--mantine-spacing-sm)" }}>
      {note && (
        <Box component="span" fz="xs" data-slot="agent-state" style={{ color: COLOR.muted }}>
          {note}
        </Box>
      )}
      {children}
    </Box>
  );
}
