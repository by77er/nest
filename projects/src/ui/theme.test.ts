// The theme against its source of truth, the nest-ui-design skill (.claude/skills/nest-ui-design/SKILL.md):
// each token is read from the skill's own tables here, so the two can't drift apart silently. Then
// contrast: every place the page puts text on a color meets WCAG AA (4.5:1) in both schemes, computed
// from WCAG's definition, not taken from Mantine. https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
import { readFileSync } from "node:fs";
import { darken, DEFAULT_THEME, mergeMantineTheme } from "@mantine/core";
import { describe, expect, it } from "vitest";
import { TASK_STATES } from "../tasks";
import { STATE_COLOR, STATE_LABEL } from "./status";
import { cssVariablesResolver, filled, fontSizes, headings, layout, lineHeights, motion, neutrals, palette, radius, ROLES, roleText, spacing, theme } from "./theme";

// vitest runs from projects/; the skill is the repo's.
const SKILL = readFileSync(`${process.cwd()}/../.claude/skills/nest-ui-design/SKILL.md`, "utf8");
const full = mergeMantineTheme(DEFAULT_THEME, theme);

const px = (rem: string) => Math.round(parseFloat(rem) * 16 * 100) / 100;
/** The rows of the skill's table whose header row starts with `| <first> |`. */
function table(first: string): string[][] {
  const lines: string[] = SKILL.split("\n");
  const at = lines.findIndex((l) => l.startsWith(`| ${first} |`));
  expect(at, `the skill's "${first}" table`).toBeGreaterThanOrEqual(0);
  const rows: string[][] = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(l.split("|").slice(1, -1).map((c: string) => c.trim()));
  }
  return rows;
}

function luminance(color: string): number {
  const rgb = color.startsWith("#") ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : color.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
  const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};
const AA = 4.5;

describe("the tokens match the skill", () => {
  it("type scale: caption, small, body, body-lg and h1 to h4, size and line height", () => {
    const ours: Record<string, { fontSize: string; lineHeight: string }> = {
      caption: { fontSize: fontSizes.xs, lineHeight: lineHeights.xs },
      small: { fontSize: fontSizes.sm, lineHeight: lineHeights.sm },
      body: { fontSize: fontSizes.md, lineHeight: lineHeights.md },
      "body-lg": { fontSize: fontSizes.lg, lineHeight: lineHeights.lg },
      h4: headings.h4, h3: headings.h3, h2: headings.h2, h1: headings.h1,
    };
    const rows = table("Token");
    expect(rows.map((r) => r[0]).sort()).toEqual(Object.keys(ours).sort());
    for (const [token, sizeLh] of rows) {
      const [size, lh] = sizeLh!.split(",")[0]!.split("/").map(Number);
      expect([px(ours[token!]!.fontSize), px(ours[token!]!.lineHeight)], token).toEqual([size, lh]);
      if (token!.startsWith("h")) expect(headings[token as "h1"].fontWeight, token).toBe("600");
    }
    expect(full.fontWeights).toMatchObject({ regular: "400", medium: "500", bold: "600" });
  });

  it("spacing: exactly the skill's scale", () => {
    const line = SKILL.split("\n").find((l: string) => l.startsWith("**Spacing**"))!;
    const want = Object.fromEntries([...line.matchAll(/`([0-9a-z]+) (\d+)`/g)].map((m) => [m[1], Number(m[2])]));
    expect(Object.keys(want).length).toBeGreaterThan(5);
    expect(Object.fromEntries(Object.entries(spacing).map(([k, v]) => [k, px(v)]))).toEqual(want);
    expect(full.spacing).toMatchObject(spacing);
  });

  it("radii: sm and md, and Mantine's other names only alias them", () => {
    const line = SKILL.split("\n").find((l: string) => l.startsWith("**Radii:**"))!;
    const want = Object.fromEntries([...line.matchAll(/`(\w+) (\d+)`/g)].map((m) => [m[1], Number(m[2])]));
    expect(want).toEqual({ sm: px(radius.sm), md: px(radius.md) });
    expect(new Set(Object.values(radius)).size).toBe(2);
  });

  it("shadows: raised and overlay, and nothing else", () => {
    expect(new Set(Object.values(full.shadows)).size).toBe(2);
    expect(full.shadows).toMatchObject({ raised: expect.any(String), overlay: expect.any(String) });
  });

  it("colors: the neutral roles and each semantic role's filled shade, light and dark", () => {
    const hex = (cell: string) => /#[0-9a-f]{6}/i.exec(cell)![0].toLowerCase();
    const rows = table("Role");
    const neutralRoles = ["page", "surface", "subtle", "border", "text", "muted"] as const;
    expect(rows.map((r) => r[0]).sort()).toEqual([...neutralRoles, ...ROLES].sort());
    for (const [role, light, dark] of rows) {
      if ((neutralRoles as readonly string[]).includes(role!)) {
        expect([neutrals.light[role as "page"], neutrals.dark[role as "page"]], role).toEqual([hex(light!), hex(dark!)]);
      } else {
        const tuple = palette[role as "primary"];
        expect([tuple[filled.light.shade], tuple[filled.dark.shade]], role).toEqual([hex(light!), hex(dark!)]);
        expect(tuple, role).toHaveLength(10);
      }
    }
    expect(full.primaryShade).toEqual({ light: filled.light.shade, dark: filled.dark.shade });
  });

  it("each task status in its semantic role, as the skill's color table says", () => {
    const use = Object.fromEntries(table("Role").map((r) => [r[0], r[3]!.toLowerCase()]));
    for (const s of TASK_STATES) {
      const label = STATE_LABEL[s].toLowerCase();
      const role = ROLES.find((r) => new RegExp(`\\b${label}\\b`).test(use[r]!));
      expect(STATE_COLOR[s], s).toBe(role ?? "gray");
    }
  });

  it("motion: the three durations, the two easings, and the spinner's delay", () => {
    expect(SKILL).toContain(`\`fast\` ${motion.fast} ms`);
    expect(SKILL).toContain(`\`base\` ${motion.base} ms`);
    expect(SKILL).toContain(`\`slow\` ${motion.slow} ms`);
    expect(SKILL).toContain(`\`${motion.enter}\` on entering`);
    expect(SKILL).toContain(`\`${motion.exit}\` on leaving`);
    expect(SKILL).toContain(`only after ${motion.spinnerDelay} ms`);
    expect(full.respectReducedMotion).toBe(true);
  });

  it("the page's max width", () => {
    expect(SKILL).toContain(`Max content width ${px(layout.pageMax)} px`);
  });

  it("fonts: Inter for the UI and JetBrains Mono, self-hosted", () => {
    expect(full.fontFamily.startsWith("'Inter Variable'")).toBe(true);
    expect(full.fontFamilyMonospace.startsWith("'JetBrains Mono Variable'")).toBe(true);
    expect(SKILL).toContain("@fontsource-variable/inter");
    expect(SKILL).toContain("@fontsource-variable/jetbrains-mono");
  });
});

describe("tooltips", () => {
  it("open on hover, focus and touch, everywhere: details are reachable on a phone", () => {
    const props = (theme.components?.Tooltip?.defaultProps ?? {}) as { events?: { hover?: boolean; focus?: boolean; touch?: boolean } };
    expect(props.events).toEqual({ hover: true, focus: true, touch: true });
  });
});

describe("contrast, in both schemes", () => {
  const vars = cssVariablesResolver(full);
  const schemes = ["light", "dark"] as const;

  it.each(schemes)("%s: text and muted text on the page, the surface and the subtle ground", (s) => {
    const n = neutrals[s];
    for (const ground of [n.page, n.surface, n.subtle]) {
      expect(contrast(n.text, ground), `text on ${ground}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(n.muted, ground), `muted on ${ground}`).toBeGreaterThanOrEqual(AA);
    }
    expect(vars[s]["--mantine-color-dimmed"]).toBe(n.muted);
    expect(vars[s]["--mantine-color-text"]).toBe(n.text);
  });

  it.each(schemes)("%s: a filled button's label on each role", (s) => {
    for (const r of ROLES) {
      const label = vars[s][`--nest-on-${r}`]!;
      expect(label).toBe(filled[s].text[r]);
      expect(contrast(label, palette[r][filled[s].shade]), r).toBeGreaterThanOrEqual(AA);
    }
    // And the theme uses that label: the variant resolver names the variable.
    expect(full.variantColorResolver({ color: "warning", theme: full, variant: "filled" }).color).toBe("var(--nest-on-warning)");
  });

  it.each(schemes)("%s: a light badge's text on its tint, roles and gray", (s) => {
    for (const r of [...ROLES, "gray"] as const) {
      const tuple = full.colors[r]!;
      // Mantine 9's light variant: shade 9 on shade 1 in light; shade 0 on shade 9 darkened by half in dark.
      const [fg, bg] = s === "light" ? [tuple[9]!, tuple[1]!] : [tuple[0]!, darken(tuple[9]!, 0.5)];
      expect(contrast(fg, bg), r).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(schemes)("%s: a role's text (`c=\"warning\"`) on the surface, the page and the subtle ground", (s) => {
    for (const r of ROLES) {
      const fg = palette[r][roleText[s][r]];
      expect(vars[s][`--mantine-color-${r}-text`]).toBe(fg);
      for (const ground of [neutrals[s].surface, neutrals[s].page, neutrals[s].subtle]) expect(contrast(fg, ground), `${r} on ${ground}`).toBeGreaterThanOrEqual(AA);
    }
  });
});
