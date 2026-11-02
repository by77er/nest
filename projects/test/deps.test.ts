// The app stays a separate system (README.md): nothing in its sources imports the control plane, or
// anything outside projects/ but its own dependencies. The check is the dashboard's (dashboard/test/api.test.ts).
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** Every module specifier a source imports or re-exports, statically or dynamically. */
function specifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?[^;]*?\bfrom\s+["']([^"']+)["']/gs)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/** A specifier that leaves projects/: a relative path climbing out of src/, or the control plane by name. */
const outside = (file: string, spec: string) => {
  if (spec.includes("control-plane")) return true;
  if (!spec.startsWith(".")) return false; // a package: projects/package.json's
  const depth = file.split("/").length - 2; // "../src/do/x.ts" is 1 below src/
  const ups = spec.split("/").filter((p) => p === "..").length;
  return ups > depth;
};

describe("the app's imports", () => {
  it("stay inside projects/", () => {
    const files = Object.keys(sources);
    expect(files.length).toBeGreaterThan(5);
    const bad = files.flatMap((f) => specifiers(sources[f]!).filter((s) => outside(f, s)).map((s) => `${f}: ${s}`));
    expect(bad).toEqual([]);
  });

  it("the check sees an import of the control plane or a path out of the app", () => {
    expect(specifiers(`import { Template } from "../../control-plane/src/lib/spec";`).filter((s) => outside("../src/x.ts", s))).toHaveLength(1);
    expect(specifiers(`export type { X } from "../../../protocol/admin/view";`).filter((s) => outside("../src/do/x.ts", s))).toHaveLength(1);
    expect(specifiers(`import { env } from "../env";`).filter((s) => outside("../src/do/x.ts", s))).toHaveLength(0);
  });
});
