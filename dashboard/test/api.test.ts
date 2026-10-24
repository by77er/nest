// The dashboard's copies of the control plane's enums (src/api.ts) list exactly the values the
// control plane's sources define, so a new or renamed state fails here rather than rendering as an
// unknown chip. The field shapes are held by fixtures/admin.ts at typecheck time.
import { describe, expect, it } from "vitest";
import fleetTs from "../../control-plane/src/do/fleet.ts?raw";
import controlTs from "../../control-plane/src/protocol/control.ts?raw";
import modelTs from "../../control-plane/src/protocol/model.ts?raw";
import { HOST_ROLES, HOST_STATUSES, SANDBOX_STATES, TUNNEL_STATES } from "../src/api";

const SOURCES: Record<string, string> = { "protocol/model.ts": modelTs, "protocol/control.ts": controlTs, "do/fleet.ts": fleetTs };
const source = (path: string) => SOURCES[path] ?? "";

/** The string literals of the first match of `pattern`'s group 1. */
function literals(path: string, pattern: RegExp): string[] {
  const m = source(path).match(pattern);
  if (!m?.[1]) throw new Error(`${pattern} not found in control-plane/src/${path}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

describe("the dashboard's enums match the control plane's", () => {
  it.each([
    ["SandboxState", SANDBOX_STATES, literals("protocol/model.ts", /export const SandboxState = z\.enum\(\[([^\]]*)\]/)],
    ["HostRole", HOST_ROLES, literals("protocol/model.ts", /export const HostRole = z\.enum\(\[([^\]]*)\]/)],
    ["TunnelState", TUNNEL_STATES, literals("protocol/control.ts", /export const TunnelState = z\.enum\(\[([^\]]*)\]/)],
    ["HostStatus", HOST_STATUSES, literals("do/fleet.ts", /type HostStatus = ([^;]*);/)],
  ] as const)("%s", (_name, ours, theirs) => {
    expect([...ours].sort()).toEqual([...theirs].sort());
  });
});
