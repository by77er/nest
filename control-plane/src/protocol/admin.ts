// The admin API's read views (`GET /v1/admin/fleet`, `GET /v1/admin/images`): what FleetDO's
// `fleetView` and `images` return. This module imports nothing, so the dashboard (an independent
// Worker) can check its client against it with `import type` and no runtime dependency on the
// control plane. The enum lists here must equal the protocol's zod enums; fleet.ts asserts that at
// compile time.

/** protocol/model.ts `SandboxState`. */
export const SANDBOX_STATES = [
  "creating", "restoring", "running", "suspending", "suspended", "archiving", "archived", "fenced", "destroyed", "failed",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

/** protocol/model.ts `HostRole`. */
export const HOST_ROLES = ["burst", "controller"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** protocol/control.ts `TunnelState`. */
export const TUNNEL_STATES = ["none", "connecting", "connected"] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

/**
 * FleetDO's `hosts.status`: connected or not (`active`), taking no placements (`draining`), a silent
 * controller (`expired`), leases expired awaiting STONITH (`stonith_pending`), gone (`dead`).
 */
export const HOST_STATUSES = ["active", "draining", "expired", "stonith_pending", "dead"] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

/** Why FleetDO stopped counting a launched instance (`launched.reason`); null while it counts. */
export const LAUNCH_END_REASONS = ["enroll_timeout", "idle", "drained", "dead"] as const;
export type LaunchEndReason = (typeof LAUNCH_END_REASONS)[number];

/** lib/cells.ts `AwsSource`: where a cell's AWS setting came from. */
export const AWS_SOURCES = ["cell", "legacy", "none"] as const;
export type AwsSource = (typeof AWS_SOURCES)[number];

/**
 * The fleet view's `aws`: the cell's region and each setting's source (never a value), with `error`
 * when the cell's own credentials were malformed and passed over; or only `error` when its
 * `AWS_CELLS` entry is unusable.
 */
export type AwsView =
  | { cell: string | null; region: string | null; sources: { region: AwsSource; credentials: AwsSource; kms_key: AwsSource }; error?: string }
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
  workstream: string | null;
  /** SandboxDO did not answer: `sandbox_state`, `image` and `workstream` are null. */
  info_error: boolean;
}

export interface FleetView {
  hosts: HostView[];
  launches: LaunchView[];
  sandboxes: SandboxView[];
  aws: AwsView;
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
