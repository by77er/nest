// The design tokens, defined here once, with the values of the nest-ui-design skill
// (.claude/skills/nest-ui-design/SKILL.md, the source of truth; theme.test.ts checks them against its
// tables). Mantine turns them into CSS variables (`--mantine-spacing-md`, `--mantine-font-size-sm`, …);
// `cssVariablesResolver` adds the app's own (`--nest-*`), per color scheme. Components name a token
// (`gap="md"`, `color="danger"`, `fz="sm"`), never a raw value; only the primitives in src/ui/layout/
// read the variables directly.
//
// Color is monochrome, with color only for actions and status, in four semantic roles, each a 10-shade
// tuple: shade 6 is the filled one in light, shade 5 in dark. The scheme follows the system.

import {
  ActionIcon, Alert, Badge, Burger, Button, CloseButton, Code, Collapse, createTheme, type CSSVariablesResolver, defaultVariantColorsResolver, Drawer, InputWrapper,
  type MantineColorsTuple, Modal, NumberInput, Paper, parseThemeColor, Popover, Text, Timeline, Title, Tooltip, type VariantColorsResolver,
} from "@mantine/core";
import themeClasses from "./theme.module.css";

export const palette = {
  /** Primary actions; assigned, in progress, in review. */
  primary: ["#edf3fc", "#d9e6f8", "#b4cdf0", "#8db2e7", "#6a99de", "#5a8ad6", "#3b6fc0", "#305ca2", "#264a84", "#1c3865"],
  /** Close, cancel, delete, deny; cancelled, failed. */
  danger: ["#fcefef", "#f8dcdd", "#f0b8bb", "#e79298", "#de6e76", "#d9606a", "#c2414c", "#a3353f", "#842b33", "#652127"],
  /** Stalled, needs input, undelivered, expiring. */
  warning: ["#fff8e5", "#fdefc2", "#fae29a", "#f6d36d", "#f2c547", "#e3b341", "#dca71c", "#b48716", "#8a6711", "#654b0c"],
  /** Done, approve, healthy. */
  success: ["#ecf6f0", "#d6ecdf", "#addabf", "#83c69f", "#5db380", "#3f9e6a", "#2c8152", "#256c45", "#1e5738", "#17422a"],
  /**
   * Mantine's dark-scheme neutrals, set to the skill's: 0 text, 2 muted, 4 border, 6 subtle, 7 surface,
   * 9 page (Mantine reads dark[7] as the body, dark[6] as a default control, dark[4] as its border).
   */
  dark: ["#e9ecef", "#c1c4c8", "#9aa0a6", "#5c5f66", "#2c2e33", "#26272b", "#222327", "#1a1b1e", "#161719", "#121314"],
} as const satisfies Record<string, MantineColorsTuple>;

/** A semantic role, or the neutral gray everything else is drawn in. */
export type Role = "primary" | "danger" | "warning" | "success" | "gray";
export const ROLES = ["primary", "danger", "warning", "success"] as const;

/** The neutral roles, per scheme (the skill's color table). */
export const neutrals = {
  light: { page: "#fafafa", surface: "#ffffff", subtle: "#f1f3f5", border: "#e9ecef", text: "#212529", muted: "#666e76", terminal: "#e6ebf0", terminalMuted: "#5c636a", terminalRule: "#c2c9d0" },
  dark: { page: "#121314", surface: "#1a1b1e", subtle: "#222327", border: "#2c2e33", text: "#e9ecef", muted: "#9aa0a6", terminal: "#0d0e0f", terminalMuted: "#9aa0a6", terminalRule: "#2c2e33" },
} as const;

/** The filled shade of each role, per scheme, and the text on it (all AA, theme.test.ts). */
export const filled = {
  light: { shade: 6, text: { primary: "#ffffff", danger: "#ffffff", warning: "#212529", success: "#ffffff" } },
  dark: { shade: 5, text: { primary: "#121314", danger: "#121314", warning: "#121314", success: "#121314" } },
} as const;

/**
 * A filled button's hover shade, per scheme and role: away from the label so it keeps AA (theme.test.ts).
 * Mantine's default (one shade darker) puts the dark label in dark on 3.7:1, and darkens warning under its
 * dark label in light.
 */
export const filledHover = {
  light: { primary: 7, danger: 7, warning: 5, success: 7 },
  dark: { primary: 4, danger: 4, warning: 4, success: 4 },
} as const;

/** The shade a role's text takes on the surface, per scheme (`c="danger"`; theme.test.ts checks AA). */
export const roleText = {
  light: { primary: 7, danger: 7, warning: 8, success: 7 },
  dark: { primary: 3, danger: 3, warning: 3, success: 3 },
} as const;

/**
 * The syntax colors of a code block (the skill's syntax table; the owner, 2026-11-06): the only color
 * inside one, each AA on the `subtle` ground it sits on (theme.test.ts). Six softened Bootstrap hues and
 * the muted grays, not the roles' text shades.
 */
export const syntax = {
  light: { keyword: "#2f5fa8", string: "#237047", number: "#a4510b", title: "#6a3fb0", type: "#13705f", attribute: "#13705f", punctuation: "#495057", comment: "#666e76", addition: "#237047", deletion: "#b02a37" },
  dark: { keyword: "#7ea6e6", string: "#74c69d", number: "#e8a35c", title: "#b49ae6", type: "#5fcfb6", attribute: "#5fcfb6", punctuation: "#c1c4c8", comment: "#9aa0a6", addition: "#74c69d", deletion: "#ec8a92" },
} as const;
export type SyntaxToken = keyof (typeof syntax)["light"];

/** The warning role's text shade on the terminal surface, per scheme. */
export const terminalWarning = { light: 9, dark: 3 } as const;

/** The spacing scale, 4 px based. Nothing else. */
export const spacing = {
  "2xs": "0.125rem", xs: "0.25rem", sm: "0.5rem", md: "0.75rem", lg: "1rem", xl: "1.5rem", "2xl": "2rem", "3xl": "3rem", "4xl": "4rem",
} as const;
export type Space = keyof typeof spacing;

/** The type scale (size/line height): caption 12/16 (xs), small 13/20 (sm), body 14/20 (md), body-lg 16/24 (lg). */
export const fontSizes = { xs: "0.75rem", sm: "0.8125rem", md: "0.875rem", lg: "1rem", xl: "1.25rem" } as const;
export const lineHeights = { xs: "1rem", sm: "1.25rem", md: "1.25rem", lg: "1.5rem", xl: "1.75rem" } as const;
/** 400 body, 500 labels, 600 headings. */
export const fontWeights = { regular: "400", medium: "500", bold: "600" } as const;
/**
 * The weights as style-prop values, by name: `fw={weight.medium}`. Mantine passes `fw` through as CSS,
 * so a name string (`fw="medium"`) is no weight at all and `fw="bold"` is 700, not the scale's 600.
 */
export const weight = { regular: 400, medium: 500, bold: 600 } as const;
export const headings = {
  h1: { fontSize: "1.5rem", lineHeight: "2rem", fontWeight: "600" },
  h2: { fontSize: "1.25rem", lineHeight: "1.75rem", fontWeight: "600" },
  h3: { fontSize: "1rem", lineHeight: "1.5rem", fontWeight: "600" },
  h4: { fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "600" },
  h5: { fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "600" },
  h6: { fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: "600" },
} as const;

/** Two radii: `sm` 4 (badges, inputs), `md` 8 (panels, cards, buttons). Mantine's other names map onto them. */
export const radius = { xs: "0.25rem", sm: "0.25rem", md: "0.5rem", lg: "0.5rem", xl: "0.5rem" } as const;

/** Two shadows: `raised` (a dragged or hovered card) and `overlay` (drawers, modals, menus). */
const RAISED = "0 1px 3px rgba(18, 19, 20, 0.08), 0 1px 2px rgba(18, 19, 20, 0.06)";
const OVERLAY = "0 12px 32px rgba(18, 19, 20, 0.14), 0 4px 8px rgba(18, 19, 20, 0.08)";
export const shadows = { raised: RAISED, overlay: OVERLAY, xs: RAISED, sm: RAISED, md: OVERLAY, lg: OVERLAY, xl: OVERLAY } as const;

/** Motion: three durations and two easings, on opacity and transform only. */
export const motion = {
  fast: 120,
  base: 180,
  slow: 240,
  enter: "cubic-bezier(0.2, 0, 0, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  /** A spinner shows only once loading has taken this long. */
  spinnerDelay: 300,
} as const;

/** One UI family and one mono family (ids, code, numbers), self-hosted from npm (src/main.tsx). */
export const fonts = {
  ui: "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

/** Layout sizes the primitives use (src/ui/layout/). */
export const layout = {
  /** The page's max content width. */
  pageMax: "90rem",
  /** A readable measure, for a page of forms or prose (admin). */
  measure: "45rem",
  headerHeight: "3.5rem",
  /** The persistent sidebar (projects and their pages), from `md` on; a drawer below. */
  sidebar: "16.5rem",
  /** The sidebar rows' icon column: one width, so every label starts on one edge. */
  navIcon: "1.25rem",
  /** A comfortable reading line for a conversation (the Manager page): about 70 characters. */
  readingMeasure: "42rem",
  /** An image in a message (a data: raster, an SVG figure): at most this tall. */
  richImageMax: "20rem",
  /** A scrolling log's height (a trace): fixed below `lg`, the viewport's rest from `lg` on. */
  logMax: "22.5rem",
  logMaxBeside: "calc(100vh - 24rem)",
  /** A narrow side element's width (a tooltip's): under a third of a desktop page. */
  sidePanel: "20rem",
  /** A board column's least width: from `md` on (all six beside the chat at 1280 px), and below. */
  column: { min: "8.5rem", minNarrow: "16rem" },
  /** A section heading row's height (a small button's), so heading rows line up; a column's. */
  sectionHead: "2.25rem",
  denseHead: "1.75rem",
  /**
   * The sheet when it holds two columns (a task with its worker's trace), and its details column. The task
   * is what's read first, so it gets the wider column, at a reading line (body-lg prose at 40rem is about 70
   * characters, inside the reading measure); the trace gets the rest, about 80 columns of its mono from
   * `xl` up. The sheet leaves a sliver of the board beside it, so it still reads as a sheet over the page.
   */
  sheetWide: "min(84rem, 100vw - 6rem)",
  sheetDetails: "40rem",
  /** Hit targets: 32 px with a pointer, 44 px on touch. */
  hit: "2rem",
  hitTouch: "2.75rem",
} as const;

/** Icon sizes in px (Tabler icons take numbers). */
export const icon = { sm: 14, md: 16, lg: 20, xl: 28 } as const;

/** The app's own CSS variables, and Mantine's neutrals set to the skill's, per scheme. */
export const cssVariablesResolver: CSSVariablesResolver = () => {
  const scheme = (s: "light" | "dark") => ({
    "--nest-page-bg": neutrals[s].page,
    "--nest-surface": neutrals[s].surface,
    "--nest-subtle": neutrals[s].subtle,
    "--nest-border-color": neutrals[s].border,
    "--nest-border": `1px solid ${neutrals[s].border}`,
    "--nest-muted": neutrals[s].muted,
    "--nest-terminal": neutrals[s].terminal,
    // The terminal's hairlines (its border, a turn's rule): `border` vanishes on the light terminal (1.01:1).
    "--nest-term-rule": neutrals[s].terminalRule,
    "--nest-terminal-border": `1px solid ${neutrals[s].terminalRule}`,
    // On the terminal: its own muted (the light terminal is darker than the page), and warning a shade
    // darker in light (shade 8 is under AA there), each checked by theme.test.ts.
    "--nest-term-muted": neutrals[s].terminalMuted,
    "--nest-term-warning": palette.warning[terminalWarning[s]],
    // A code block's syntax colors (`--nest-syntax-keyword`, …).
    ...Object.fromEntries(Object.entries(syntax[s]).map(([k, v]) => [`--nest-syntax-${k}`, v])),
    "--mantine-color-body": neutrals[s].surface,
    "--mantine-color-text": neutrals[s].text,
    "--mantine-color-bright": neutrals[s].text,
    "--mantine-color-dimmed": neutrals[s].muted,
    "--mantine-color-default-border": neutrals[s].border,
    ...Object.fromEntries(ROLES.map((r) => [`--nest-on-${r}`, filled[s].text[r]])),
    // A filled button's hover (Mantine's own variables, which its filled variant reads).
    ...Object.fromEntries(ROLES.map((r) => [`--mantine-color-${r}-filled-hover`, palette[r][filledHover[s][r]]])),
    "--mantine-primary-color-filled-hover": palette.primary[filledHover[s].primary],
    // Mantine's error color (a field's error, the required asterisk) is the danger role's text shade.
    "--mantine-color-error": palette.danger[roleText[s].danger],
    // A role's text on the surface (`c="warning"`): dark enough in light, light enough in dark, for AA.
    ...Object.fromEntries(ROLES.map((r) => [`--mantine-color-${r}-text`, palette[r][roleText[s][r]]])),
  });
  return {
    variables: {
      "--nest-page-max": layout.pageMax,
      "--nest-measure": layout.measure,
      "--nest-header-height": layout.headerHeight,
      "--nest-sidebar": layout.sidebar,
      "--nest-nav-icon": layout.navIcon,
      "--nest-reading-measure": layout.readingMeasure,
      "--nest-rich-image-max": layout.richImageMax,
      "--nest-log-max": layout.logMax,
      "--nest-log-max-beside": layout.logMaxBeside,
      "--nest-side-panel": layout.sidePanel,
      "--nest-column-min": layout.column.min,
      "--nest-column-min-narrow": layout.column.minNarrow,
      "--nest-section-head": layout.sectionHead,
      "--nest-dense-head": layout.denseHead,
      "--nest-sheet-wide": layout.sheetWide,
      "--nest-sheet-details": layout.sheetDetails,
      "--nest-hit": layout.hit,
      "--nest-hit-touch": layout.hitTouch,
      "--nest-motion-fast": `${motion.fast}ms`,
      "--nest-motion-base": `${motion.base}ms`,
      "--nest-motion-slow": `${motion.slow}ms`,
      "--nest-ease-enter": motion.enter,
      "--nest-ease-exit": motion.exit,
    },
    light: scheme("light"),
    dark: scheme("dark"),
  };
};

/**
 * A filled role takes its scheme's text color (`--nest-on-<role>`): white or dark in light, dark in dark,
 * whichever meets AA; a subtle or light role is its text shade; a gray outline is the muted text on a
 * hairline. Everything else is Mantine's.
 */
const variantColorResolver: VariantColorsResolver = (input) => {
  const r = defaultVariantColorsResolver(input);
  const parsed = parseThemeColor({ color: input.color ?? input.theme.primaryColor, theme: input.theme });
  if (input.variant === "filled" && parsed.isThemeColor && (ROLES as readonly string[]).includes(parsed.color) && parsed.shade === undefined) {
    return { ...r, color: `var(--nest-on-${parsed.color})` };
  }
  // A subtle or light role (a subtle "Delete", a light "Failed"): the role's text shade, 7 in light and 3 in
  // dark, never Mantine's shade 0 in dark, which is near-white and loses the role's cue.
  if ((input.variant === "subtle" || input.variant === "light") && parsed.isThemeColor && (ROLES as readonly string[]).includes(parsed.color) && parsed.shade === undefined) {
    return { ...r, color: `var(--mantine-color-${parsed.color}-text)`, hoverColor: `var(--mantine-color-${parsed.color}-text)` };
  }
  // A neutral outline (a "Tainted" badge): muted text on a hairline, not Mantine's gray 6 (3.3:1 on white).
  if (input.variant === "outline" && (input.color ?? "") === "gray") {
    return { ...r, color: "var(--nest-muted)", border: "1px solid var(--nest-border-color)", hover: "var(--nest-subtle)" };
  }
  return r;
};

const transition = (duration: number) => ({ duration, timingFunction: motion.enter, exitDuration: duration, exitTimingFunction: motion.exit });

export const theme = createTheme({
  primaryColor: "primary",
  primaryShade: { light: filled.light.shade, dark: filled.dark.shade },
  colors: palette,
  variantColorResolver,
  black: neutrals.light.text,
  white: neutrals.light.surface,
  fontFamily: fonts.ui,
  fontFamilyMonospace: fonts.mono,
  fontSizes,
  lineHeights,
  fontWeights,
  headings: { fontFamily: fonts.ui, fontWeight: "600", textWrap: "wrap", sizes: headings },
  spacing,
  radius,
  defaultRadius: "md",
  shadows,
  cursorType: "pointer",
  focusRing: "auto",
  respectReducedMotion: true,
  other: { layout, icon, motion, neutrals },
  components: {
    // Close is red: every close button (a modal's, a drawer's, a notification's), at a 32 px target.
    CloseButton: CloseButton.extend({ defaultProps: { c: "danger", size: "lg" } }),
    ActionIcon: ActionIcon.extend({ defaultProps: { size: "lg" } }),
    Burger: Burger.extend({ classNames: { root: themeClasses.burger } }),
    NumberInput: NumberInput.extend({ classNames: { wrapper: themeClasses.numberWrapper, controls: themeClasses.steppers } }),
    Button: Button.extend({ defaultProps: { size: "sm", radius: "md" }, classNames: { root: themeClasses.button } }),
    // A badge is never cut short: its text keeps its width (a table column grows for it; a card wraps it).
    Badge: Badge.extend({ defaultProps: { radius: "sm" }, styles: { root: { fontVariantNumeric: "tabular-nums", maxWidth: "none", flexShrink: 0 }, label: { overflow: "visible", textOverflow: "clip" } } }),
    Paper: Paper.extend({ defaultProps: { radius: "md" } }),
    Alert: Alert.extend({ defaultProps: { radius: "md" } }),
    Code: Code.extend({ styles: { root: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", borderRadius: radius.sm } } }),
    // Long ids and URLs wrap instead of overflowing their container, everywhere.
    Text: Text.extend({ styles: { root: { overflowWrap: "anywhere" } } }),
    Title: Title.extend({ styles: { root: { overflowWrap: "anywhere" } } }),
    // Every field the same way: its label above, small and medium, a step above the input.
    InputWrapper: InputWrapper.extend({
      styles: {
        label: { fontSize: fontSizes.sm, fontWeight: 500, marginBottom: spacing.xs },
        description: { fontSize: fontSizes.xs, marginBottom: spacing.xs },
        error: { fontSize: fontSizes.xs, marginTop: spacing.xs },
      },
    }),
    Modal: Modal.extend({ defaultProps: { radius: "md", padding: "xl", shadow: "overlay", transitionProps: transition(motion.slow) }, styles: { title: { fontSize: headings.h2.fontSize, lineHeight: headings.h2.lineHeight, fontWeight: 600 } } }),
    Drawer: Drawer.extend({ defaultProps: { padding: "xl", shadow: "overlay", transitionProps: transition(motion.slow) }, styles: { title: { fontSize: headings.h2.fontSize, lineHeight: headings.h2.lineHeight, fontWeight: 600 } } }),
    Tooltip: Tooltip.extend({ defaultProps: { transitionProps: transition(motion.base), events: { hover: true, focus: true, touch: true } } }),
    Popover: Popover.extend({ defaultProps: { shadow: "overlay", transitionProps: transition(motion.base) } }),
    Timeline: Timeline.extend({ defaultProps: { bulletSize: 12, lineWidth: 2 } }),
    Collapse: Collapse.extend({ defaultProps: { transitionDuration: motion.slow, transitionTimingFunction: motion.enter } }),
  },
});
