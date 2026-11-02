// Each status the page shows takes the skill's semantic role for what it means (the skill's color
// table: success healthy or done, primary in progress, warning stalled or needs input or expiring,
// danger failed). The enums are swept from their sources: the admin view contract (protocol/admin/,
// imported here at run time, which only the page's own sources may not do) and, for an agent's
// state, the control plane's zod enums, read as text so the dashboard imports nothing from it.
import { describe, expect, it } from "vitest";
import brain from "../../../control-plane/src/lib/brain.ts?raw";
import model from "../../../control-plane/src/protocol/model.ts?raw";
import { AGENT_LIFETIME_KINDS, SANDBOX_LIFETIME_KINDS, SANDBOX_STATES, TUNNEL_STATES } from "../../../protocol/admin/view";
import {
  AGENT_LIFETIME_ROLE, AGENT_STATE_ROLE, LIFECYCLE_ROLE, PHASE_ROLE, SANDBOX_LIFETIME_ROLE, SANDBOX_STATE_ROLE, TUNNEL_ROLE,
} from "../../src/ui/status";
import { ROLES } from "../../src/ui/theme";

/** The values of `export const <name> = z.enum([...])` in the control plane's protocol model. */
function zodEnum(name: string): string[] {
  const m = new RegExp(`export const ${name} = z\\.enum\\(\\[([^\\]]*)\\]`).exec(model);
  if (!m) throw new Error(`no enum ${name}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((v) => v[1]!);
}

const ALL_ROLES = [...ROLES, "gray"];

describe("every status has a role, and only the theme's", () => {
  it.each([
    ["SandboxState", SANDBOX_STATES, SANDBOX_STATE_ROLE],
    ["TunnelState", TUNNEL_STATES, TUNNEL_ROLE],
    ["SandboxLifetimeKind", SANDBOX_LIFETIME_KINDS, SANDBOX_LIFETIME_ROLE],
    ["AgentLifetimeKind", AGENT_LIFETIME_KINDS, AGENT_LIFETIME_ROLE],
    ["AgentState", zodEnum("AgentState"), AGENT_STATE_ROLE],
    ["AgentLifecycle", zodEnum("AgentLifecycle"), LIFECYCLE_ROLE],
  ] as const)("%s", (_, values, table) => {
    expect(values.length).toBeGreaterThan(0);
    expect(Object.keys(table).sort()).toEqual([...values].sort());
    for (const v of values) expect(ALL_ROLES).toContain((table as Record<string, string>)[v]);
  });

  it("a brain's phases (control-plane/src/lib/brain.ts)", () => {
    const phases = [...brain.matchAll(/phase: "([a-z]+)"(?: \| "([a-z]+)")?/g)].flatMap((m) => [m[1]!, m[2]].filter(Boolean));
    expect(Object.keys(PHASE_ROLE).sort()).toEqual([...new Set(phases)].sort());
  });
});

describe("the role says what the status means", () => {
  it.each([
    // failed
    ["danger", ["failed", "fenced"], SANDBOX_STATE_ROLE],
    ["danger", ["errored", "needs_attention"], AGENT_STATE_ROLE],
    ["danger", ["errored"], LIFECYCLE_ROLE],
    ["danger", ["condemned"], PHASE_ROLE],
    ["danger", ["destroyed", "unreadable"], SANDBOX_LIFETIME_ROLE],
    ["danger", ["gone", "unreadable"], AGENT_LIFETIME_ROLE],
    // stalled, needs input, expiring
    ["warning", ["waiting_permission", "waiting_input", "stalled", "quota_parked"], AGENT_STATE_ROLE],
    ["warning", ["dormant", "held", "unknown"], SANDBOX_LIFETIME_ROLE],
    ["warning", ["quiet", "ending"], AGENT_LIFETIME_ROLE],
    ["warning", ["connecting"], TUNNEL_ROLE],
    // in progress
    ["primary", ["creating", "restoring", "suspending", "archiving"], SANDBOX_STATE_ROLE],
    ["primary", ["starting", "working", "compacting"], AGENT_STATE_ROLE],
    // healthy
    ["success", ["running"], SANDBOX_STATE_ROLE],
    ["success", ["ready"], AGENT_STATE_ROLE],
    ["success", ["live"], PHASE_ROLE],
    ["success", ["connected"], TUNNEL_ROLE],
    // at rest
    ["gray", ["suspended", "archived", "destroyed"], SANDBOX_STATE_ROLE],
    ["gray", ["idle", "detached"], AGENT_STATE_ROLE],
  ] as [string, string[], Record<string, string>][])("%s: %j", (role, values, table) => {
    for (const v of values) expect([v, table[v]]).toEqual([v, role]);
  });
});
