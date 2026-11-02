// The page's one theme (README.md#the-ui): light and monochrome, with color only for actions and
// status, in four semantic roles. Each is a 10-shade tuple, roughly Bootstrap's hue a step muted; shade 6
// is the filled one. Components name a role (`color="danger"`), never a raw color or another palette.

import { CloseButton, createTheme, type MantineColorsTuple } from "@mantine/core";

export const palette = {
  /** Primary actions, and work in progress. White text on shade 6: 4.98:1. */
  primary: ["#edf3fc", "#d9e6f8", "#b4cdf0", "#8db2e7", "#6a99de", "#4f86d6", "#3b6fc0", "#305ca2", "#264a84", "#1c3865"],
  /** Close, delete, cancel, danger. White text on shade 6: 5.05:1. */
  danger: ["#fcefef", "#f8dcdd", "#f0b8bb", "#e79298", "#de6e76", "#d65660", "#c2414c", "#a3353f", "#842b33", "#652127"],
  /** Warning, stalled, needs input. Dark text on shade 6 (autoContrast): 7.21:1. */
  warning: ["#fff8e5", "#fdefc2", "#fae29a", "#f6d36d", "#f2c547", "#efbb2f", "#dca71c", "#b48716", "#8a6711", "#654b0c"],
  /** Success, done, approve. White text on shade 6: 4.81:1. */
  success: ["#ecf6f0", "#d6ecdf", "#addabf", "#83c69f", "#5db380", "#44a56c", "#2c8152", "#256c45", "#1e5738", "#17422a"],
} as const satisfies Record<string, MantineColorsTuple>;

/** A semantic role, or the neutral gray everything else is drawn in. */
export type Role = keyof typeof palette | "gray";

export const theme = createTheme({
  primaryColor: "primary",
  primaryShade: 6,
  colors: palette,
  // Filled buttons pick black or white text by luminance: dark on yellow, white on the rest.
  autoContrast: true,
  luminanceThreshold: 0.3,
  black: "#212529",
  white: "#ffffff",
  defaultRadius: "md",
  fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  headings: { fontWeight: "600" },
  cursorType: "pointer",
  components: {
    // Close is red: every close button (a modal's, a drawer's, a notification's) in the danger role.
    CloseButton: CloseButton.extend({ defaultProps: { c: "danger.6" } }),
  },
});

/** The page's background; surfaces (cards, panels) are white on it. */
export const PAGE_BG = "#fafafa";
