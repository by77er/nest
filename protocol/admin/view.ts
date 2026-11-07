// The admin API's read views (`GET /v1/admin/fleet`, `/v1/admin/images`, `/v1/admin/lifetimes`): the
// contract between the control plane (FleetDO's `fleetView`, `images` and `lifetimes` return these
// types) and the dashboard (which checks its client against them). It lives in protocol/, which both
// depend on, so neither imports the other; it imports nothing, so the dashboard needs only `import
// type` and carries no code from here. The enum lists must equal the control plane's zod enums
// (control-plane/src/do/fleet.ts asserts that at compile time).

/** protocol/model.ts `SandboxState`. */
export const SANDBOX_STATES = [
  "creating", "restoring", "running", "suspending", "suspended", "archiving", "archived", "fenced", "destroyed", "failed",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

/** protocol/model.ts `HostRole`. */
export const HOST_ROLES = ["sandbox", "brain"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** protocol/control.ts `TunnelState`. */
export const TUNNEL_STATES = ["none", "connecting", "connected"] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

/**
 * FleetDO's `hosts.status`: connected or not (`active`), taking no placements (`draining`), silent
 * holding no lease (`expired`), leases expired awaiting STONITH (`stonith_pending`), gone (`dead`).
 */
export const HOST_STATUSES = ["active", "draining", "expired", "stonith_pending", "dead"] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

/** Why FleetDO stopped counting a launched instance (`launched.reason`); null while it counts. */
export const LAUNCH_END_REASONS = ["enroll_timeout", "idle", "drained", "dead"] as const;
export type LaunchEndReason = (typeof LAUNCH_END_REASONS)[number];

/**
 * The fleet view's `aws`: the cell's region and whether it has its credentials and KMS key (never a
 * value), with `error` when its credentials entry was malformed and passed over; or only `error`
 * when its `AWS_CELLS` entry is unusable.
 */
export type AwsView =
  | { cell: string | null; region: string | null; credentials: boolean; kms_key: boolean; error?: string }
  | { cell: string | null; error: string };

/** protocol/control.ts `Capacity`, as the host last reported it. */
export interface CapacityView {
  vcpus_free: number;
  memory_mib_free: number;
  hugepages_mib_free: number;
  /** The hugepage pool's size; 0 or absent (a host from before the field) means regular pages. */
  hugepages_mib_total?: number;
  sandboxes: number;
  agents: number;
  warm: string[];
}

/** A lease on a host. `state` is what the holder last reported; null until its first report. */
export interface ResidentView {
  sandbox: string;
  epoch: number;
  state: SandboxState | null;
  vcpus: number | null;
  memory_mib: number | null;
}

export interface HostView {
  host: string;
  role: HostRole;
  instance_id: string | null;
  status: HostStatus;
  idle_since: number | null;
  enrolled_ms: number;
  last_rx: number | null;
  tunnel_hostname: string | null;
  tunnel_state: TunnelState;
  capacity: CapacityView | null;
  leases: number;
  connected: boolean;
  sandboxes: ResidentView[];
  /** Agents with a brain indexed on the host (FleetDO's `host_agents`). */
  agents: string[];
  /** When AgentDO reported a brain here that did not exit after a kill; null: not wedged. */
  wedged_ms: number | null;
  /** Its brains are proven gone: lease expired, or death confirmed. */
  lost: boolean;
  /** Its nestd keys brains by agent epoch (false: the previous release). */
  brain_epochs: boolean;
  /** How many brains a brain host may hold (the cell's setting, else from its vCPUs); null for a sandbox host. */
  max_brains: number | null;
}

export interface LaunchView {
  instance_id: string;
  launched_ms: number;
  host: string | null;
  reason: LaunchEndReason | null;
  ended_ms: number | null;
}

/** A live (registered, not destroyed) sandbox of the cell. */
export interface SandboxView {
  sandbox: string;
  registered_ms: number;
  /** The lease's holder; null without a lease (suspended to the object store, or unplaced). */
  host: string | null;
  /** The lease's epoch, else SandboxDO's; null when neither could be read. */
  epoch: number | null;
  /** What the lease holder last reported; null without a lease or before the holder's first report. */
  lease_state: SandboxState | null;
  /** SandboxDO's own state; null when it could not be read (`info_error`). */
  sandbox_state: SandboxState | null;
  image: string | null;
  /** SandboxDO did not answer: `sandbox_state` and `image` are null. */
  info_error: boolean;
}

/**
 * An instance type whose launches kept ending `enroll_timeout` (control-plane/src/lib/enroll-breaker.ts):
 * `open` while no launch of it is made, until `open_until_ms`; consecutive `failures` since its last enrolment.
 */
export interface EnrollBreakerView {
  role: HostRole;
  type: string;
  failures: number;
  open_until_ms: number | null;
  open: boolean;
}

export interface FleetView {
  hosts: HostView[];
  launches: LaunchView[];
  sandboxes: SandboxView[];
  aws: AwsView;
  /** Types with enrolment failures counted (absent from a control plane before it). */
  enroll_breakers?: EnrollBreakerView[];
}

/** lib/ec2.ts `ImageInfo`: a host AMI. `state` is EC2's image state. */
export interface ImageView {
  image_id: string;
  name: string;
  created: string;
  state: string;
  size_gib: number | null;
  tags: Record<string, string>;
}

/** A sandbox template (guest image) and how many live sandboxes name it. */
export interface TemplateView {
  name: string;
  default: boolean;
  source: string;
  in_use: number;
}

export interface ImagesView {
  current: string | null;
  current_since_ms: number | null;
  images: ImageView[];
  templates: TemplateView[];
}

// --- `GET /v1/admin/lifetimes`: what is left lying around (docs/control-plane/dashboard/#abandoned) ---

/**
 * A live registered sandbox's lifetime class: `dormant` (no agent attached, no VM up: its idle TTL
 * runs), `held` (attached only to agents that are quiet, ending, ended or gone: never dormant, so no
 * TTL takes it), `unknown` (an attached agent could not be read, none is active), `in_use` (counted,
 * not listed), `destroyed` (SandboxDO says destroyed but the registry still lists it), `unreadable`
 * (SandboxDO did not answer).
 */
export const SANDBOX_LIFETIME_KINDS = ["dormant", "held", "unknown", "in_use", "destroyed", "unreadable"] as const;
export type SandboxLifetimeKind = (typeof SANDBOX_LIFETIME_KINDS)[number];

/**
 * An agent's lifetime class: `quiet` (not ended, no brain, no start wanted, no turn current or
 * queued, and none for `quiet_ms`), `ending` (ended, its steps unfinished past `ENDING_STUCK_MS`),
 * `gone` (its records are pruned, yet a sandbox or owner still names it), `unreadable`; counted,
 * not listed: `active` (a brain, a start wanted, or a turn current or queued), `recent` (quiet for
 * less than `quiet_ms`), `ended` (its end done, its records awaiting their prune).
 */
export const AGENT_LIFETIME_KINDS = ["quiet", "ending", "gone", "unreadable", "active", "recent", "ended"] as const;
export type AgentLifetimeKind = (typeof AGENT_LIFETIME_KINDS)[number];

/** A sandbox the lifetimes view lists (any kind but `in_use`). */
export interface LifetimeSandboxView {
  sandbox: string;
  kind: SandboxLifetimeKind;
  registered_ms: number;
  /** SandboxDO's state; null when it could not be read (`error`). */
  state: SandboxState | null;
  host: string | null;
  /** The agent it was made for (which may destroy it when it ends); null: the operator's. */
  owner: string | null;
  attached: string[];
  /** The idle TTL that applies: its own (`own_ttl`), else the cell's. */
  idle_ttl_ms: number | null;
  own_ttl: boolean;
  dormant_since_ms: number | null;
  expiry_notice_ms: number | null;
  /**
   * When its lifetime check will destroy it if nothing changes (a dormant sandbox only); null while
   * its dormancy clock has not started. Past checks missed for over 6 h restart the clock, as the
   * check itself does.
   */
  destroy_at_ms: number | null;
  /** Its generation records, and how many carry a memory snapshot: counts, not bytes (the control plane has no sizes). */
  generations: number | null;
  memory_generations: number | null;
  error: string | null;
}

/** An agent the lifetimes view lists (`quiet`, `ending`, `gone`, `unreadable`). */
export interface LifetimeAgentView {
  agent: string;
  kind: AgentLifetimeKind;
  template: string | null;
  owner: string | null;
  /** The sandbox it is bound to, by id. */
  sandbox: string | null;
  /** When its latest turn started (or was queued); null: it never had one. */
  last_turn_ms: number | null;
  /** The operator stopped it and nothing has started it since. */
  stopped_by_operator: boolean;
  /** Agents it spawned that haven't ended. */
  live_children: string[];
  ended_ms: number | null;
  ended_reason: string | null;
  /** Where it was read: the cell's agent registry, or (once its records are gone) attached to a listed sandbox. */
  found_via: "registry" | "sandbox";
  error: string | null;
}

export interface LifetimesView {
  cell: string;
  now_ms: number;
  /** An agent with no turn for this long is `quiet` (else `recent`). */
  quiet_ms: number;
  /** The cell's default idle TTL (a sandbox without its own gets it). */
  cell_idle_ttl_ms: number;
  sandboxes: LifetimeSandboxView[];
  agents: LifetimeAgentView[];
  /** Everything this page read, by kind (the listed and the counted). */
  counts: { sandboxes: Record<SandboxLifetimeKind, number>; agents: Record<AgentLifetimeKind, number> };
  /** The registry's next page (pass as `cursor`); null: this was the last. */
  next_cursor: string | null;
  /** Agents found on this page but not read (over the per-page cap). */
  agents_omitted: number;
}
