// The design system's rule (the nest-ui-design skill's enforcement; README.md#design-system): code outside
// the theme and the layout primitives arranges primitives and components, and never styles. So it has:
// - no inline `style`, `className` or CSS of its own;
// - no raw lengths (px, rem, em, vh, vw, %) and no literal colors (hex, rgb, hsl);
// - colors only by semantic role, gray, `dimmed` or `bright`, without a shade (a shade breaks dark mode);
// - spacing only by the scale's names, and sizes only by token names or variables;
// - weights only by name;
// - no layout containers of Mantine's own: those are the primitives' (Stack, Row, Panel, Page, …).
import { describe, expect, it } from "vitest";
import { spacing } from "./theme";

const sources = import.meta.glob<string>("./**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });
/** Where values may be defined: the theme, the primitives, and the tests. */
const exempt = (f: string) => f === "./theme.ts" || f.startsWith("./layout/") || f.startsWith("./test/") || /\.test\.tsx?$/.test(f);

const SPACE = new Set(Object.keys(spacing));
const SIZE_NAMES = new Set(["xs", "sm", "md", "lg", "xl", "compact-xs", "compact-sm", "compact-md", "auto"]);
const COLORS = /^(primary|danger|warning|success|gray|dimmed|bright)$/;
const SPACING_PROPS = "m|mt|mb|ml|mr|mx|my|p|pt|pb|pl|pr|px|py|gap|rowGap|columnGap|spacing|verticalSpacing|separatorMargin";
const SIZE_PROPS = "w|h|miw|maw|mih|mah|fz|lh|size|radius|top|left|right|bottom|bulletSize|lineWidth|iconSize|width|height|offset";
const LAYOUT = ["Group", "Stack", "Flex", "Grid", "SimpleGrid", "Container", "Paper", "Card", "Box", "Center", "AppShell", "Space", "ScrollArea"];

/** Each JSX attribute value of `prop`: a string literal, or every string inside a `{…}` object literal. */
function values(text: string, props: string): { prop: string; value: string; numeric: boolean }[] {
  const out: { prop: string; value: string; numeric: boolean }[] = [];
  const re = new RegExp(`\\s(${props})=(?:"([^"]*)"|\\{(-?[0-9.]+)\\}|\\{\\{([^}]*)\\}\\})`, "g");
  for (const m of text.matchAll(re)) {
    if (m[2] !== undefined) out.push({ prop: m[1]!, value: m[2], numeric: false });
    else if (m[3] !== undefined) out.push({ prop: m[1]!, value: m[3], numeric: true });
    else for (const v of m[4]!.matchAll(/:\s*(?:"([^"]*)"|(-?[0-9.]+))/g)) out.push({ prop: m[1]!, value: v[1] ?? v[2]!, numeric: v[2] !== undefined });
  }
  return out;
}

export function offences(file: string, text: string): string[] {
  const out: string[] = [];
  const at = (what: string) => out.push(`${file}: ${what}`);
  if (/\sstyle=\{/.test(text)) at("an inline style");
  if (/\sclassName=/.test(text)) at("a className");
  if (/import\s+[^;]*\.css["']|import\s+["'][^"']*\.css["']/.test(text)) at("a CSS import");
  for (const m of text.matchAll(/["'`][^"'`\n]*?(?<![\w-])(\d+(?:\.\d+)?)(px|rem|em|vh|vw|%)(?![\w-])/g)) at(`a raw length ${m[1]}${m[2]}`);
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)) at(`a literal color ${m[0]}`);
  for (const v of values(text, "c|color|bg|bd")) if (v.numeric || !COLORS.test(v.value)) at(`a color ${v.prop}="${v.value}"`);
  for (const v of values(text, SPACING_PROPS)) if (v.numeric || !SPACE.has(v.value)) at(`a spacing ${v.prop}="${v.value}"`);
  for (const v of values(text, SIZE_PROPS)) if (v.numeric || !(SIZE_NAMES.has(v.value) || /^var\(--[\w-]+\)$/.test(v.value) || /^h[1-6]$/.test(v.value))) at(`a size ${v.prop}="${v.value}"`);
  for (const v of values(text, "fw")) if (v.numeric || !/^(regular|medium|bold)$/.test(v.value)) at(`a weight fw="${v.value}"`);
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@mantine\/core["']/g)) {
    for (const name of m[1]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.replace(/^type\s+/, ""))) if (LAYOUT.includes(name)) at(`Mantine's ${name} (use the layout primitives)`);
  }
  return out;
}

describe("the design rule", () => {
  it("holds for everything but the theme, the primitives and tests", () => {
    const files = Object.keys(sources).filter((f) => !exempt(f));
    expect(files.filter((f) => f.startsWith("./features/")).length).toBeGreaterThan(15);
    expect(files.flatMap((f) => offences(f, sources[f]!))).toEqual([]);
  });

  it("the check sees each kind of offence, and passes what the rule allows", () => {
    const bad = [
      `<Box style={{ flex: 1 }} />`,
      `<div className="x" />`,
      `import classes from "./x.module.css";`,
      `<Text maw="18rem" />`,
      `const w = "12px";`,
      `<Text c="#ff0000" />`,
      `<Badge color="blue" />`,
      `<Text c="warning.8" />`,
      `<Stack gap={6} />`,
      `<Row gap="10px" />`,
      `<Text mt={{ base: "lg", sm: 4 }} />`,
      `<Icon size={14} />`,
      `<Text fw={600} />`,
      `import { Group, Text } from "@mantine/core";`,
    ];
    for (const b of bad) expect(offences("x.tsx", b), b).not.toEqual([]);
    const good = [
      `<Stack gap="2xl" />`,
      `<Row gap="xs" py="lg" mt={{ base: "sm", md: "xl" }} />`,
      `<Text c="dimmed" fz="xs" fw="medium" />`,
      `<Badge color="warning" variant="light" size="sm" />`,
      `<IconX size={icon.md} />`,
      `<Tooltip maw="var(--nest-side-panel)" />`,
      `<Textarea minRows={2} maxLength={1000} />`,
      `import { Badge, Button, Text } from "@mantine/core";`,
    ];
    for (const g of good) expect(offences("x.tsx", g), g).toEqual([]);
  });
});
