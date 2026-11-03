// The theme against its source of truth, the nest-ui-design skill: its tables are read from the
// skill's own file, so a value changed on one side only fails here. And WCAG AA (4.5:1 for normal
// text) wherever the page puts text, in both schemes, computed from WCAG's definition rather than
// taken from Mantine. https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
import { DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import skill from "../../../.claude/skills/nest-ui-design/SKILL.md?raw";
import html from "../../index.html?raw";
import main from "../../src/main.tsx?raw";
import { describe, expect, it } from "vitest";
import { cssVariablesResolver, motion, neutrals, onFilled, palette, ROLES, theme } from "../../src/ui/theme";


const full = mergeMantineTheme(DEFAULT_THEME, theme);
const vars = cssVariablesResolver(full);
const SCHEMES = ["light", "dark"] as const;

/** `calc(0.75rem * var(--mantine-scale))`, `0.75rem` or `12px` in px. */
const px = (v: string) => {
  const rem = /([\d.]+)rem/.exec(v);
  if (rem) return Number(rem[1]) * 16;
  const p = /([\d.]+)px/.exec(v);
  if (p) return Number(p[1]);
  throw new Error(`not a size: ${v}`);
};

/** A token's name as the skill's table and the CSS variables spell it (`terminalMuted` is `terminal-muted`). */
const kebab = (n: string) => n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// --- the skill's tables ---
const colorRows = Object.fromEntries(
  [...skill.matchAll(/^\| ([\w-]+) \| `(#[0-9a-f]{6})`[^|]*\| `(#[0-9a-f]{6})`[^|]*\|/gm)].map((m) => [m[1]!, { light: m[2]!, dark: m[3]! }]),
);
const typeRows = Object.fromEntries(
  [...skill.matchAll(/^\| ([\w-]+) \| (\d+)\/(\d+)(?:, (\d+))? \|/gm)].map((m) => [m[1]!, { size: Number(m[2]), lh: Number(m[3]), weight: m[4] }]),
);
const line = (start: string) => skill.split("\n").find((l: string) => l.startsWith(start))!;
const pairs = (l: string) => Object.fromEntries([...l.matchAll(/`([\w-]+) (\d+)`/g)].map((m) => [m[1]!, Number(m[2])]));
const spacing = pairs(line("**Spacing**"));
const radii = pairs(line("**Radii:**"));
const durations = Object.fromEntries([...skill.matchAll(/`(fast|base|slow)` (\d+) ms/g)].map((m) => [m[1]!, Number(m[2])]));
const easing = /`(cubic-bezier\([^)]*\))` on entering and `(cubic-bezier\([^)]*\))` on leaving/.exec(skill)!;

describe("the skill's tables, as read", () => {
  it("are all there", () => {
    expect(Object.keys(colorRows).sort()).toEqual(["border", "danger", "muted", "page", "primary", "subtle", "success", "surface", "terminal", "terminal-muted", "text", "warning"]);
    expect(Object.keys(typeRows).sort()).toEqual(["body", "body-lg", "caption", "h1", "h2", "h3", "h4", "small"]);
    expect(Object.keys(spacing)).toEqual(["2xs", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"]);
    expect(radii).toEqual({ sm: 4, md: 8 });
    expect(Object.keys(durations).sort()).toEqual(["base", "fast", "slow"]);
    expect(easing).not.toBeNull();
  });
});

describe("the theme's tokens equal the skill's", () => {
  it.each(Object.keys(neutrals.light) as (keyof typeof neutrals.light)[])("neutral %s, light and dark", (name) => {
    expect({ light: neutrals.light[name], dark: neutrals.dark[name] }).toEqual(colorRows[kebab(name)]);
    for (const s of SCHEMES) expect(vars[s][`--nest-${kebab(name)}`]).toBe(neutrals[s][name]);
  });

  it("Mantine's own neutrals are the skill's: body (panels) the surface, text, dimmed the muted, default border", () => {
    for (const s of SCHEMES) {
      expect(vars[s]).toMatchObject({
        "--mantine-color-body": neutrals[s].surface,
        "--mantine-color-text": neutrals[s].text,
        "--mantine-color-dimmed": neutrals[s].muted,
        "--mantine-color-default-border": neutrals[s].border,
        "--mantine-color-default-hover": neutrals[s].subtle,
      });
    }
  });

  it.each(ROLES)("role %s: ten shades, filled light at 6 and dark at 5", (role) => {
    expect(full.colors[role]).toHaveLength(10);
    expect({ light: palette[role][6], dark: palette[role][5] }).toEqual(colorRows[role]);
    expect(full.primaryShade).toEqual({ light: 6, dark: 5 });
    expect(full.primaryColor).toBe("primary");
  });

  it("type scale: Mantine's xs to lg are caption, small, body and body-lg; headings h1 to h4; three weights", () => {
    const sizes = { caption: "xs", small: "sm", body: "md", "body-lg": "lg" } as const;
    for (const [token, key] of Object.entries(sizes)) {
      expect({ size: px(full.fontSizes[key]), lh: px(full.lineHeights[key]) }).toEqual({ size: typeRows[token]!.size, lh: typeRows[token]!.lh });
    }
    for (const h of ["h1", "h2", "h3", "h4"] as const) {
      const t = full.headings.sizes[h];
      expect({ size: px(t.fontSize), lh: px(t.lineHeight!) }).toEqual({ size: typeRows[h]!.size, lh: typeRows[h]!.lh });
      expect(full.headings.fontWeight).toBe(typeRows[h]!.weight);
    }
    expect(line("**Type scale**")).toContain("weights 400 body, 500 labels, 600 headings");
    expect(full.fontWeights).toEqual({ regular: "400", medium: "500", bold: "600" });
  });

  it("spacing is the scale and nothing else", () => {
    expect(Object.fromEntries(Object.entries(full.spacing).map(([k, v]) => [k, px(v)]))).toEqual(spacing);
  });

  it("two radii; Mantine's other sizes alias them; panels default to md", () => {
    expect(px(full.radius.sm)).toBe(radii.sm);
    expect(px(full.radius.md)).toBe(radii.md);
    for (const v of Object.values(full.radius)) expect([radii.sm, radii.md]).toContain(px(v));
    expect(full.defaultRadius).toBe("md");
  });

  it("two shadows, raised and overlay; Mantine's sizes alias them", () => {
    const { raised, overlay, ...rest } = full.shadows as Record<string, string>;
    expect(raised).toBeTruthy();
    expect(overlay).toBeTruthy();
    for (const v of Object.values(rest)) expect([raised, overlay]).toContain(v);
  });

  it("motion: the durations and easings, as theme values and CSS variables", () => {
    expect({ fast: motion.fast, base: motion.base, slow: motion.slow }).toEqual(durations);
    expect([motion.enter, motion.leave]).toEqual([easing[1], easing[2]]);
    expect(vars.variables).toMatchObject({
      "--nest-duration-fast": `${durations.fast}ms`, "--nest-duration-base": `${durations.base}ms`, "--nest-duration-slow": `${durations.slow}ms`,
      "--nest-ease-enter": easing[1], "--nest-ease-leave": easing[2],
    });
    expect(full.respectReducedMotion).toBe(true);
  });

  it("fonts: self-hosted Inter and JetBrains Mono, no external font request", () => {
    expect(full.fontFamily.startsWith("'Inter Variable'")).toBe(true);
    expect(full.fontFamilyMonospace.startsWith("'JetBrains Mono Variable'")).toBe(true);
    expect(main).toContain(`import "@fontsource-variable/inter/wght.css"`);
    expect(main).toContain(`import "@fontsource-variable/jetbrains-mono/wght.css"`);
    expect(html).not.toMatch(/<link[^>]+https?:/);
  });

  it("the check reads a changed value as a change", () => {
    const changed = skill.replace("| page | `#fafafa`", "| page | `#ffffff`");
    const row = /^\| page \| `(#[0-9a-f]{6})`/m.exec(changed)!;
    expect(row[1]).not.toBe(neutrals.light.page);
  });
});

// --- contrast ---
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
/** A color as RGB: a hex, or an rgba() composited over `under`. */
function rgbOf(v: string, under: string): number[] {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(v);
  if (!m) {
    if (!/^#[0-9a-f]{6}$/.test(v)) throw new Error(`can't resolve ${v}`);
    return channels(v);
  }
  const a = Number(m[4]);
  return [1, 2, 3].map((i, k) => Number(m[i]) * a + channels(under)[k]! * (1 - a));
}
const contrast = (fg: string, bg: string, under: string) => {
  const [hi, lo] = [luminance(rgbOf(fg, under)), luminance(rgbOf(bg, under))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("contrast meets AA in both schemes", () => {
  it.each(SCHEMES)("%s: text and muted text on the page, a surface and the subtle well", (s) => {
    const n = neutrals[s];
    for (const fg of [n.text, n.muted]) for (const bg of [n.page, n.surface, n.subtle]) expect(contrast(fg, bg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SCHEMES)("%s: the text on every filled role, as the theme picks it", (s) => {
    for (const role of ROLES) {
      const out = full.variantColorResolver({ color: role, theme: full, variant: "filled" });
      expect(out.color).toBe(`var(--nest-on-${role})`);
      expect(out.background).toBe(`var(--mantine-color-${role}-filled)`);
      const filled = palette[role][s === "light" ? 6 : 5];
      expect(vars[s][`--nest-on-${role}`]).toBe(onFilled[s][role]);
      expect(contrast(onFilled[s][role], filled, filled)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(SCHEMES)("%s: every light badge's text on its tint, over a surface (roles and gray)", (s) => {
    for (const role of [...ROLES, "gray"]) {
      const out = full.variantColorResolver({ color: role, theme: full, variant: "light" });
      expect(out).toMatchObject({ background: `var(--mantine-color-${role}-light)`, color: `var(--mantine-color-${role}-light-color)` });
      const bg = vars[s][`--mantine-color-${role}-light`]!;
      const fg = vars[s][`--mantine-color-${role}-light-color`]!;
      expect(contrast(fg, bg, neutrals[s].surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("the check fails a pair that does not meet it (the skill's previous light muted on the page)", () => {
    expect(contrast("#6c757d", neutrals.light.page, neutrals.light.page)).toBeLessThan(4.5);
  });
});
