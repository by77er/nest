// The page's types are the control plane's own view types (control-plane/src/protocol/admin.ts),
// so the fields are checked by `npm run typecheck`, and the control plane checks that the view's
// enums equal its protocol's. What this test holds is the other half of the bargain: the dashboard
// stays an independent Worker, so every reference to the control plane from its sources is erased
// at build time (`import type` / `export type`), never a runtime import.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** Every import or re-export statement of a control-plane module, with whether it is type-only. */
function controlPlaneImports(text: string): { statement: string; typeOnly: boolean }[] {
  const out: { statement: string; typeOnly: boolean }[] = [];
  for (const m of text.matchAll(/\b(import|export)\s+(type\s+)?[^;]*?\bfrom\s+["']([^"']*control-plane[^"']*)["']/gs)) {
    out.push({ statement: m[0].replace(/\s+/g, " "), typeOnly: !!m[2] });
  }
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']*control-plane[^"']*)["']/g)) out.push({ statement: m[0], typeOnly: false });
  for (const m of text.matchAll(/\bimport\s+["']([^"']*control-plane[^"']*)["']/g)) out.push({ statement: m[0], typeOnly: false });
  return out;
}

describe("the dashboard's dependency on the control plane", () => {
  it("is types only", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(0);
    const runtime = files.flatMap((f) => controlPlaneImports(sources[f]!).filter((i) => !i.typeOnly).map((i) => `${f}: ${i.statement}`));
    expect(runtime).toEqual([]);
    // The view types do come from there (src/api.ts).
    expect(controlPlaneImports(sources["../src/api.ts"]!).length).toBeGreaterThan(0);
  });

  it("the check sees a runtime import", () => {
    expect(controlPlaneImports(`import { SANDBOX_STATES } from "../../control-plane/src/protocol/admin";`)).toEqual([
      { statement: `import { SANDBOX_STATES } from "../../control-plane/src/protocol/admin"`, typeOnly: false },
    ]);
    expect(controlPlaneImports(`export type {\n  FleetView,\n} from "../../control-plane/src/protocol/admin";`)[0]!.typeOnly).toBe(true);
  });
});
