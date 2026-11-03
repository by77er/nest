// Any gray outline Badge, rendered, reads at AA in both schemes: the theme maps the variant (muted text,
// a border-colored hairline), so a new one ("Tainted", "Waiting on", "Fork") can't fall back to
// Mantine's gray 6 (3.3:1 on white) or invert to the loudest badge in dark.
import { Badge, DEFAULT_THEME, MantineProvider, mergeMantineTheme } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cssVariablesResolver, neutrals, theme } from "./theme";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("a gray outline Badge", () => {
  const vars = cssVariablesResolver(mergeMantineTheme(DEFAULT_THEME, theme));
  it.each(["light", "dark"] as const)("%s: its text and outline are the scheme's muted and border, at AA on every ground", (s) => {
    render(
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} forceColorScheme={s} env="test">
        <Badge color="gray" variant="outline">
          Waiting on
        </Badge>
      </MantineProvider>,
    );
    const style = screen.getByText("Waiting on").closest(".mantine-Badge-root")!.getAttribute("style") ?? "";
    const color = /--badge-color:\s*var\((--[\w-]+)\)/.exec(style)?.[1];
    expect(color).toBe("--nest-muted");
    expect(style).toMatch(/--badge-bd:\s*1px solid var\(--nest-border-color\)/);
    const fg = (vars[s] as Record<string, string>)[color!]!;
    expect(fg).toBe(neutrals[s].muted);
    for (const ground of [neutrals[s].surface, neutrals[s].page, neutrals[s].subtle]) expect(contrast(fg, ground), `${fg} on ${ground}`).toBeGreaterThanOrEqual(4.5);
  });
});
