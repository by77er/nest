// The skill's enforcement: feature code (src/ui/features/) arranges primitives and components and
// names tokens; it never styles. Only the theme (src/ui/theme.ts, src/ui/global.css) and the layout
// primitives (src/ui/layout/) may define values.
import { describe, expect, it } from "vitest";

const features = import.meta.glob<string>("../../src/ui/features/**/*.{ts,tsx,css}", { query: "?raw", import: "default", eager: true });

const SPACING = ["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"];
const SIZES = ["xs", "sm", "md", "lg", "xl"];
/** The semantic roles and grays, Mantine's text tones, and inherit; optionally a shade. */
const COLOR = /^(primary|danger|warning|success|gray|dimmed|text|inherit)(\.\d)?$/;
const SPACING_PROPS = "gap|rowGap|columnGap|spacing|verticalSpacing|horizontalSpacing|p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me";
const SIZE_PROPS = "w|h|miw|maw|mih|mah|size|fz|lh|top|left|right|bottom|inset|radius|stroke";

function offences(file: string, text: string): string[] {
  const out: string[] = [];
  const at = (what: string) => out.push(`${file}: ${what}`);
  for (const m of text.matchAll(/\bstyle=\{/g)) at(m[0]);
  for (const m of text.matchAll(/\bclassName=/g)) at(m[0]);
  for (const m of text.matchAll(/\.module\.css["']/g)) at(m[0]);
  for (const m of text.matchAll(/(?<![\w-])\d+(\.\d+)?(px|rem|em|vh|vw|ch)\b/g)) at(m[0]);
  for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/g)) at(m[0]);
  for (const m of text.matchAll(/\b(c|color|bg|bd)=\{?["']([^"']+)["']/g)) if (!COLOR.test(m[2]!)) at(m[0]);
  for (const m of text.matchAll(new RegExp(`\\b(${SPACING_PROPS})=\\{?["']([^"']+)["']`, "g"))) if (!SPACING.includes(m[2]!)) at(m[0]);
  for (const m of text.matchAll(new RegExp(`\\b(${SPACING_PROPS}|${SIZE_PROPS})=\\{(-?\\d[\\d.]*)\\}`, "g"))) if (m[2] !== "0") at(m[0]);
  for (const m of text.matchAll(/\b(fz|size)=["']([^"']+)["']/g)) if (!SIZES.includes(m[2]!)) at(m[0]);
  for (const m of text.matchAll(/\bfw=\{?["']?(\d+)/g)) if (!["400", "500", "600"].includes(m[1]!)) at(m[0]);
  return out;
}

describe("feature code names tokens and never styles", () => {
  it("has no inline style, class, raw value, other color or off-scale spacing", () => {
    const files = Object.keys(features);
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.flatMap((f) => offences(f, features[f]!))).toEqual([]);
  });

  it.each([
    [`<Box style={{ padding: 4 }}>`, "an inline style"],
    [`<div className={classes.x}>`, "a class"],
    [`import classes from "./x.module.css";`, "a CSS module"],
    [`<Text maw="80ch">`, "a raw size"],
    [`<Box w="12px">`, "a raw px"],
    [`<Text c="#ff0000">`, "a hex"],
    [`<Box bg="rgba(0,0,0,.1)">`, "an rgba"],
    [`<Button color="blue">`, "another palette"],
    [`<Text c="grape.6">`, "another palette's shade"],
    [`<Stack gap="5">`, "off-scale spacing"],
    [`<Stack gap={6}>`, "a number for spacing"],
    [`<Icon size={14} />`, "a number for a size"],
    [`<Text size="13px">`, "a raw font size"],
    [`<Text fw={700}>`, "a weight off the scale"],
  ])("the check sees %s (%s)", (snippet) => {
    expect(offences("x.tsx", snippet).length).toBeGreaterThan(0);
  });

  it("the check passes tokens", () => {
    expect(offences("x.tsx", `<Stack gap="2xl"><Text c="dimmed" size="sm" fw={500} mt="sm" /><Badge color="warning" /><Text c="danger.6" /><Group gap={0} /></Stack>`)).toEqual([]);
  });
});
