// The theme's roles are readable (WCAG AA, 4.5:1 for normal text) wherever the page puts text on them:
// a filled button's label on shade 6, in the text color Mantine itself picks, and a light badge's text on
// its tint. The contrast is computed here from WCAG's definition, not taken from Mantine.
// https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
import { DEFAULT_THEME, defaultVariantColorsResolver, mergeMantineTheme } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { palette, theme } from "./theme";

const full = mergeMantineTheme(DEFAULT_THEME, theme);

function relativeLuminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** A `var(--mantine-color-<name>-<shade>)` or `var(--mantine-color-white|black)` as its hex. */
function resolve(v: string): string {
  if (v === "var(--mantine-color-white)") return full.white;
  if (v === "var(--mantine-color-black)") return full.black;
  const m = /^var\(--mantine-color-([a-z]+)-(filled|\d)\)$/.exec(v);
  if (!m) throw new Error(`can't resolve ${v}`);
  const shade = m[2] === "filled" ? (full.primaryShade as number) : Number(m[2]);
  return full.colors[m[1]!]![shade]!;
}

describe("the palette", () => {
  const roles = Object.keys(palette) as (keyof typeof palette)[];

  it("has exactly the four semantic roles, ten shades each", () => {
    expect(roles.sort()).toEqual(["danger", "primary", "success", "warning"]);
    for (const r of roles) expect(full.colors[r]).toHaveLength(10);
    expect(full.primaryColor).toBe("primary");
  });

  it.each(roles)("%s: a filled button's label meets AA in the text color Mantine picks", (role) => {
    const v = defaultVariantColorsResolver({ color: role, theme: full, variant: "filled" });
    expect(contrast(resolve(v.color), resolve(v.background))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(roles)("%s: a light badge's text meets AA on its tint", (role) => {
    // Mantine 9's light variant in the light scheme: shade 9 on shade 1 (get-css-color-variables).
    expect(contrast(palette[role][9], palette[role][1])).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the components", () => {
  // Every color a component names is a role, the neutral grays, or Mantine's text tones: no other
  // palette (blue, grape...) and no literal color outside the theme.
  const sources = import.meta.glob<string>("./**/*.tsx", { query: "?raw", import: "default", eager: true });
  const ALLOWED = /^(primary|danger|warning|success|gray|dark|dimmed|white|black|var\(--mantine-color-(dimmed|text)\))(\.\d)?$/;

  function offences(file: string, text: string): string[] {
    const out: string[] = [];
    for (const m of text.matchAll(/\b(?:color|c|bg)=\{?["']([^"']+)["']/g)) if (!ALLOWED.test(m[1]!)) out.push(`${file}: ${m[0]}`);
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g)) out.push(`${file}: ${m[0]}`);
    return out;
  }

  it("name only the theme's roles and grays", () => {
    const files = Object.keys(sources).filter((f) => !f.includes(".test."));
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => offences(f, sources[f]!))).toEqual([]);
  });

  it("the check sees another palette and a literal color", () => {
    expect(offences("x.tsx", `<Button color="blue">`)).toHaveLength(1);
    expect(offences("x.tsx", `<Text c="grape.6">`)).toHaveLength(1);
    expect(offences("x.tsx", `<Box style={{ color: "#ff0000" }}>`)).toHaveLength(1);
    expect(offences("x.tsx", `<Badge color="warning" /><Text c="warning.8" />`)).toHaveLength(0);
  });
});
