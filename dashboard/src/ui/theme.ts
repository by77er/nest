// The page's one theme: the values of the nest-ui-design skill (.claude/skills/nest-ui-design/SKILL.md),
// which is their source of truth; test/ui/theme.test.ts reads the skill's tables and fails when this file
// drifts from them. Monochrome, with color only for actions and status in four semantic roles, light and
// dark following the system. Feature code names tokens (`c="dimmed"`, `gap="lg"`, `color="danger"`),
// never a value: only this file and the layout primitives (src/ui/layout/) hold values.

import {
  Badge, createTheme, type CSSVariablesResolver, defaultVariantColorsResolver, type MantineColorsTuple, rem, Table, type VariantColorsResolver,
} from "@mantine/core";

/** The neutral roles, per scheme (the skill's color table). */
export const neutrals = {
  light: { page: "#fafafa", surface: "#ffffff", subtle: "#f1f3f5", border: "#e9ecef", text: "#212529", muted: "#666e76", terminal: "#e6ebf0", terminalMuted: "#5c636a" },
  dark: { page: "#121314", surface: "#1a1b1e", subtle: "#222327", border: "#2c2e33", text: "#e9ecef", muted: "#9aa0a6", terminal: "#0d0e0f", terminalMuted: "#9aa0a6" },
} as const;

/**
 * The semantic roles: ten shades each, shade 6 the light scheme's filled color and shade 5 the dark
 * scheme's (the skill's table), the rest mixed from them toward white (0 to 4) and black (7 to 9).
 */
export const palette = {
  primary: ["#f2f6fc", "#e5ecf8", "#c4d5f0", "#9fbbe7", "#7ba1de", "#5a8ad6", "#3b6fc0", "#305b9d", "#26477b", "#1b3358"],
  danger: ["#fcf2f3", "#f9e6e7", "#f1c6c9", "#e9a3a9", "#e18088", "#d9606a", "#c2414c", "#9f353e", "#7c2a31", "#591e23"],
  warning: ["#fdf9f0", "#fbf3e1", "#f5e4bb", "#efd391", "#e9c267", "#e3b341", "#dca71c", "#b48917", "#8d6b12", "#654d0d"],
  success: ["#f0f7f3", "#e0efe7", "#badcc9", "#90c7a9", "#65b188", "#3f9e6a", "#2c8152", "#246a43", "#1c5334", "#143b26"],
} as const satisfies Record<string, MantineColorsTuple>;

export type SemanticRole = keyof typeof palette;
/** A role a status can take: a semantic one, or the neutral gray of something that needs nothing. */
export type Role = SemanticRole | "gray";
export const ROLES = Object.keys(palette) as SemanticRole[];

/**
 * Mantine's neutral tuples, with the skill's neutrals at the shades Mantine reads (light: `gray`;
 * dark: `dark`, whose 7 is the body, 0 the text, 2 dimmed and 4 the default border).
 */
const gray: MantineColorsTuple = [
  neutrals.light.page, neutrals.light.subtle, neutrals.light.border, "#dee2e6", "#ced4da", "#adb5bd", neutrals.light.muted, "#495057", "#343a40", neutrals.light.text,
];
const dark: MantineColorsTuple = [
  neutrals.dark.text, "#c1c2c5", neutrals.dark.muted, "#5c5f66", neutrals.dark.border, neutrals.dark.subtle, "#1e1f22", neutrals.dark.surface, "#161719", neutrals.dark.page,
];

/** Text on a filled role: white on the light scheme's (dark on warning), the dark page on the dark scheme's. */
export const onFilled: Record<"light" | "dark", Record<SemanticRole, string>> = {
  light: { primary: neutrals.light.surface, danger: neutrals.light.surface, warning: neutrals.light.text, success: neutrals.light.surface },
  dark: { primary: neutrals.dark.page, danger: neutrals.dark.page, warning: neutrals.dark.page, success: neutrals.dark.page },
};

/**
 * A light (tinted) badge or banner, from the role's own tuple: in the light scheme shade 9 on shade 1
 * (Mantine's own), in the dark scheme shade 2 on shade 5 at 16 % over the surface.
 */
export const LIGHT_TINT_ALPHA = 0.16;
export const lightVariant = (role: SemanticRole, scheme: "light" | "dark") =>
  scheme === "light"
    ? { background: palette[role][1], hover: palette[role][2], color: palette[role][9] }
    : { background: alpha(palette[role][5], LIGHT_TINT_ALPHA), hover: alpha(palette[role][5], LIGHT_TINT_ALPHA + 0.08), color: palette[role][2] };

function alpha(hex: string, a: number): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** The skill's motion tokens. */
export const motion = {
  fast: 120,
  base: 180,
  slow: 240,
  enter: "cubic-bezier(0.2, 0, 0, 1)",
  leave: "cubic-bezier(0.4, 0, 1, 1)",
} as const;

const px = (n: number) => rem(n);

export const theme = createTheme({
  colors: { ...palette, gray, dark },
  primaryColor: "primary",
  primaryShade: { light: 6, dark: 5 },
  white: neutrals.light.surface,
  black: neutrals.light.text,
  fontFamily: "'Inter Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace: "'JetBrains Mono Variable', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  // caption, small, body, body-lg, and h2's size for a hero value.
  fontSizes: { xs: px(12), sm: px(13), md: px(14), lg: px(16), xl: px(20) },
  lineHeights: { xs: px(16), sm: px(20), md: px(20), lg: px(24), xl: px(28) },
  fontWeights: { regular: "400", medium: "500", bold: "600" },
  headings: {
    fontWeight: "600",
    sizes: {
      h1: { fontSize: px(24), lineHeight: px(32) },
      h2: { fontSize: px(20), lineHeight: px(28) },
      h3: { fontSize: px(16), lineHeight: px(24) },
      h4: { fontSize: px(14), lineHeight: px(20) },
      h5: { fontSize: px(14), lineHeight: px(20) },
      h6: { fontSize: px(14), lineHeight: px(20) },
    },
  },
  spacing: {
    "2xs": px(2), xs: px(4), sm: px(8), md: px(12), lg: px(16), xl: px(24), "2xl": px(32), "3xl": px(48), "4xl": px(64),
  },
  // Two radii: sm for badges and inputs, md for panels, cards and buttons. Mantine's other sizes alias them.
  radius: { xs: px(4), sm: px(4), md: px(8), lg: px(8), xl: px(8) },
  defaultRadius: "md",
  // Two shadows: raised and overlay. Mantine's sizes alias them (menus and popovers use md).
  shadows: {
    raised: "0 1px 2px rgba(33, 37, 41, 0.06), 0 2px 8px rgba(33, 37, 41, 0.08)",
    overlay: "0 4px 12px rgba(33, 37, 41, 0.10), 0 12px 32px rgba(33, 37, 41, 0.14)",
    xs: "0 1px 2px rgba(33, 37, 41, 0.06), 0 2px 8px rgba(33, 37, 41, 0.08)",
    sm: "0 1px 2px rgba(33, 37, 41, 0.06), 0 2px 8px rgba(33, 37, 41, 0.08)",
    md: "0 4px 12px rgba(33, 37, 41, 0.10), 0 12px 32px rgba(33, 37, 41, 0.14)",
    lg: "0 4px 12px rgba(33, 37, 41, 0.10), 0 12px 32px rgba(33, 37, 41, 0.14)",
    xl: "0 4px 12px rgba(33, 37, 41, 0.10), 0 12px 32px rgba(33, 37, 41, 0.14)",
  },
  breakpoints: { xs: "36em", sm: "48em", md: "62em", lg: "75em", xl: "88em" },
  // Filled controls in a role take their text from --nest-on-<role>, set per scheme below.
  variantColorResolver: ((input) => {
    const out = defaultVariantColorsResolver(input);
    if (input.variant === "filled" && input.color && (ROLES as string[]).includes(input.color)) return { ...out, color: `var(--nest-on-${input.color})` };
    return out;
  }) satisfies VariantColorsResolver,
  respectReducedMotion: true,
  focusRing: "auto",
  cursorType: "pointer",
  other: { motion },
  components: {
    // One badge style per status: the role's light tint, caption type (12/16, 500), sentence case.
    Badge: Badge.extend({
      defaultProps: { variant: "light", radius: "sm" },
      vars: () => ({ root: { "--badge-fz": "var(--mantine-font-size-xs)", "--badge-height": px(20), "--badge-padding-x": "var(--mantine-spacing-sm)" } }),
      styles: { root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 } },
    }),
    // Tables: small (13/20) cells, dense rows, tabular numbers, hairlines in the border role.
    Table: Table.extend({
      defaultProps: { fz: "sm", verticalSpacing: "xs", horizontalSpacing: "md", tabularNums: true },
      vars: () => ({
        table: {
          "--table-border-color": "var(--nest-border)",
          "--table-striped-color": "var(--nest-subtle)",
          "--table-highlight-on-hover-color": "var(--nest-subtle)",
        },
      }),
    }),
  },
});

declare module "@mantine/core" {
  export interface MantineThemeSizesOverride {
    spacing: Record<"2xs" | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" | "3xl" | "4xl", string>;
    shadows: Record<"raised" | "overlay" | "xs" | "sm" | "md" | "lg" | "xl", string>;
  }
}

const schemeVariables = (scheme: "light" | "dark") => {
  const n = neutrals[scheme];
  const vars: Record<string, string> = {
    "--nest-page": n.page,
    "--nest-surface": n.surface,
    "--nest-subtle": n.subtle,
    "--nest-border": n.border,
    "--nest-text": n.text,
    "--nest-muted": n.muted,
    // The skill's terminal surface (the projects app's traces); defined here so the two themes stay one.
    "--nest-terminal": n.terminal,
    "--nest-terminal-muted": n.terminalMuted,
    "--mantine-color-body": n.surface,
    "--mantine-color-text": n.text,
    "--mantine-color-dimmed": n.muted,
    "--mantine-color-placeholder": n.muted,
    "--mantine-color-default": n.surface,
    "--mantine-color-default-hover": n.subtle,
    "--mantine-color-default-color": n.text,
    "--mantine-color-default-border": n.border,
    "--mantine-color-anchor": `var(--mantine-color-primary-${scheme === "light" ? 6 : 5})`,
  };
  // A gray badge: the text on the subtle well (light), or on the border's gray (dark).
  vars["--mantine-color-gray-light"] = scheme === "light" ? n.subtle : n.border;
  vars["--mantine-color-gray-light-hover"] = scheme === "light" ? n.border : n.subtle;
  vars["--mantine-color-gray-light-color"] = n.text;
  for (const role of ROLES) {
    const v = lightVariant(role, scheme);
    vars[`--nest-on-${role}`] = onFilled[scheme][role];
    vars[`--mantine-color-${role}-light`] = v.background;
    vars[`--mantine-color-${role}-light-hover`] = v.hover;
    vars[`--mantine-color-${role}-light-color`] = v.color;
  }
  return vars;
};

/** The CSS variables the theme adds (or replaces) on top of Mantine's, light and dark. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {
    "--nest-duration-fast": `${motion.fast}ms`,
    "--nest-duration-base": `${motion.base}ms`,
    "--nest-duration-slow": `${motion.slow}ms`,
    "--nest-ease-enter": motion.enter,
    "--nest-ease-leave": motion.leave,
  },
  light: schemeVariables("light"),
  dark: schemeVariables("dark"),
});
