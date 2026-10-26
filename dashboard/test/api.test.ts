// The page's types are the admin view contract (protocol/admin/view.ts), which the control plane is
// typed by too, so the fields are checked by `npm run typecheck`, and the control plane checks that
// the view's enums equal its protocol's. What this test holds is the other half of the bargain: the
// dashboard stays an independent Worker. Nothing in its sources imports the control plane, and every
// import from protocol/ is erased at build time (`import type` / `export type`).
import { describe, expect, it } from "vitest";
import { fleet } from "../fixtures/admin";
import { normalizeFleet, type FleetResponse } from "../src/api";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** Every import or re-export statement of a module whose path contains `part`, with whether it is type-only. */
function importsOf(text: string, part: string): { statement: string; typeOnly: boolean }[] {
  const out: { statement: string; typeOnly: boolean }[] = [];
  const quoted = `["']([^"']*${part}[^"']*)["']`;
  for (const m of text.matchAll(new RegExp(`\\b(import|export)\\s+(type\\s+)?[^;]*?\\bfrom\\s+${quoted}`, "gs"))) {
    out.push({ statement: m[0].replace(/\s+/g, " "), typeOnly: !!m[2] });
  }
  for (const m of text.matchAll(new RegExp(`\\bimport\\s*\\(\\s*${quoted}`, "g"))) out.push({ statement: m[0], typeOnly: false });
  for (const m of text.matchAll(new RegExp(`\\bimport\\s+${quoted}`, "g"))) out.push({ statement: m[0], typeOnly: false });
  return out;
}

describe("the dashboard's dependencies outside dashboard/", () => {
  const files = Object.keys(sources);

  it("include nothing from the control plane", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => importsOf(sources[f]!, "control-plane").map((i) => `${f}: ${i.statement}`))).toEqual([]);
  });

  it("are types only from protocol/", () => {
    const runtime = files.flatMap((f) => importsOf(sources[f]!, "protocol/").filter((i) => !i.typeOnly).map((i) => `${f}: ${i.statement}`));
    expect(runtime).toEqual([]);
    // The view types do come from there (src/api.ts).
    expect(importsOf(sources["../src/api.ts"]!, "protocol/admin/view").length).toBeGreaterThan(0);
  });

  it("the check sees a runtime import", () => {
    expect(importsOf(`import { SANDBOX_STATES } from "../../protocol/admin/view";`, "protocol/")).toEqual([
      { statement: `import { SANDBOX_STATES } from "../../protocol/admin/view"`, typeOnly: false },
    ]);
    expect(importsOf(`export type {\n  FleetView,\n} from "../../protocol/admin/view";`, "protocol/")[0]!.typeOnly).toBe(true);
    expect(importsOf(`import type { X } from "../../control-plane/src/do/fleet";`, "control-plane")).toHaveLength(1);
  });
});

describe("the fleet response", () => {
  it("passes the current shape through", () => {
    expect(normalizeFleet(fleet)).toEqual(fleet);
  });

  it("takes the previous release's shape for one release", () => {
    const old: FleetResponse = {
      hosts: [{ ...fleet.hosts[0]!, tunnel_state: null }],
      launches: [],
      sandboxes: [
        { sandbox: "sbx_on", registered_ms: 1, host: "hst_a", epoch: 1, state: "running", image: "nest-base:latest", workstream: "ws_a" },
        { sandbox: "sbx_parked", registered_ms: 2, host: null, epoch: 3, state: "suspended", image: "nest-base:latest", workstream: "ws_a" },
        { sandbox: "sbx_unreadable", registered_ms: 3, host: null, epoch: null, state: null, image: null, workstream: null },
      ],
    };
    const v = normalizeFleet(old);
    expect(v.hosts[0]!.tunnel_state).toBe("none");
    expect(v.sandboxes).toEqual([
      { sandbox: "sbx_on", registered_ms: 1, host: "hst_a", epoch: 1, lease_state: "running", sandbox_state: null, image: "nest-base:latest", workstream: "ws_a", info_error: false },
      { sandbox: "sbx_parked", registered_ms: 2, host: null, epoch: 3, lease_state: null, sandbox_state: "suspended", image: "nest-base:latest", workstream: "ws_a", info_error: false },
      { sandbox: "sbx_unreadable", registered_ms: 3, host: null, epoch: null, lease_state: null, sandbox_state: null, image: null, workstream: null, info_error: true },
    ]);
  });
});
