// Each status the page shows, as the skill's semantic role it takes: success healthy or done,
// primary in progress, warning stalled, waiting on someone or expiring, danger failed or broken, gray
// at rest. A Record over a typed enum fails the typecheck until a new value has a role.

import type { AgentLifetimeKind, SandboxLifetimeKind, SandboxState, TunnelState } from "../api";
import type { Role } from "./theme";

export const SANDBOX_STATE_ROLE: Record<SandboxState, Role> = {
  running: "success",
  creating: "primary", restoring: "primary", suspending: "primary", archiving: "primary",
  suspended: "gray", archived: "gray", destroyed: "gray",
  failed: "danger", fenced: "danger",
};

// An agent's fields come from `GET /v1/agents/:agent`, outside the typed view, as strings: a value not
// listed here is gray.
/** protocol/model.ts `AgentState`: an agent's `state`, and its `activity` (the runner's last report). */
export const AGENT_STATE_ROLE: Record<string, Role> = {
  ready: "success",
  working: "primary", starting: "primary", compacting: "primary",
  waiting_permission: "warning", waiting_input: "warning", quota_parked: "warning", stalled: "warning",
  idle: "gray", detached: "gray",
  errored: "danger", needs_attention: "danger",
};
/** protocol/model.ts `AgentLifecycle`: AgentDO's own part of `state`. */
export const LIFECYCLE_ROLE: Record<string, Role> = { ready: "success", starting: "primary", detached: "gray", errored: "danger" };
/** lib/brain.ts `Brain.phase`: `condemned` once none of the brain's sessions is current. */
export const PHASE_ROLE: Record<string, Role> = { live: "success", starting: "primary", condemned: "danger" };

export const TUNNEL_ROLE: Record<TunnelState, Role> = { connected: "success", connecting: "warning", none: "gray" };

/**
 * What is left lying around: dormant is expiring (its TTL takes it), held, unknown and quiet or
 * stuck-ending agents wait on the owner, an inconsistent or unreadable record is broken; in use,
 * active and recent are healthy, ended at rest.
 */
export const SANDBOX_LIFETIME_ROLE: Record<SandboxLifetimeKind, Role> = {
  dormant: "warning", held: "warning", unknown: "warning", in_use: "success", destroyed: "danger", unreadable: "danger",
};
export const AGENT_LIFETIME_ROLE: Record<AgentLifetimeKind, Role> = {
  quiet: "warning", ending: "warning", gone: "danger", unreadable: "danger", active: "success", recent: "success", ended: "gray",
};

/** A value's role in a table of them; one the table lacks is gray. */
export const roleOf = (table: Record<string, Role>, value: string | null | undefined): Role => (value ? table[value] ?? "gray" : "gray");
