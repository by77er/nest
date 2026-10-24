// What the control plane's two read routes return (control-plane/src/do/fleet.ts: fleetView, images;
// the enums from control-plane/src/protocol). The control plane does not export these shapes, so
// they are mirrored here and held to a recorded response: fixtures/admin.ts must satisfy them, and
// `npm run typecheck` fails when the two disagree. The enums are compared with the control plane's
// sources by test/api.test.ts.

/** control-plane/src/protocol/model.ts `SandboxState`. */
export const SANDBOX_STATES = [
  "creating", "restoring", "running", "suspending", "suspended", "archiving", "archived", "fenced", "destroyed", "failed",
] as const;
export type SandboxState = (typeof SANDBOX_STATES)[number];

/** control-plane/src/protocol/model.ts `HostRole`. */
export const HOST_ROLES = ["burst", "controller"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** control-plane/src/protocol/control.ts `TunnelState`. */
export const TUNNEL_STATES = ["none", "connecting", "connected"] as const;
export type TunnelState = (typeof TUNNEL_STATES)[number];

/** control-plane/src/do/fleet.ts `HostStatus`. */
export const HOST_STATUSES = ["active", "draining", "expired", "stonith_pending", "dead"] as const;
export type HostStatus = (typeof HOST_STATUSES)[number];

/** control-plane/src/protocol/control.ts `Capacity`, as the host last reported it. */
export interface Capacity {
  vcpus_free: number;
  memory_mib_free: number;
  hugepages_mib_free: number;
  /** The hugepage pool's size; 0 or absent (a host from before the field) means regular pages. */
  hugepages_mib_total?: number;
  sandboxes: number;
  agents: number;
  warm: string[];
}

/** A lease on a host. `state` is what the host last reported; null until its first report. */
export interface Resident {
  sandbox: string;
  epoch: number;
  state: SandboxState | null;
  vcpus: number | null;
  memory_mib: number | null;
}

export interface Host {
  host: string;
  role: HostRole;
  instance_id: string | null;
  status: HostStatus;
  idle_since: number | null;
  enrolled_ms: number;
  last_rx: number | null;
  tunnel_hostname: string | null;
  /** Null on a host row from before the field. */
  tunnel_state: TunnelState | null;
  capacity: Capacity | null;
  leases: number;
  connected: boolean;
  sandboxes: Resident[];
  agents: string[];
}

export interface Launch {
  instance_id: string;
  launched_ms: number;
  host: string | null;
  reason: string | null;
  ended_ms: number | null;
}

export interface SandboxRow {
  sandbox: string;
  registered_ms: number;
  host: string | null;
  epoch: number | null;
  /**
   * With a host: the lease's state as the host reported it (null before its first report). Without
   * one: the sandbox's own state, or null when the control plane could not read it (then `image`
   * and `workstream` are null too).
   */
  state: SandboxState | null;
  image: string | null;
  workstream: string | null;
}

export interface Fleet {
  hosts: Host[];
  launches: Launch[];
  sandboxes: SandboxRow[];
}

/** control-plane/src/lib/ec2.ts `ImageInfo`: a host AMI. `state` is EC2's image state. */
export interface Image {
  image_id: string;
  name: string;
  created: string;
  state: string;
  size_gib: number | null;
  tags: Record<string, string>;
}

export interface Template {
  name: string;
  default: boolean;
  source: string;
  in_use: number;
}

export interface Images {
  current: string | null;
  current_since_ms: number | null;
  images: Image[];
  templates: Template[];
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: "application/json" } });
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: string | { message?: string } };
      message = typeof parsed.error === "string" ? parsed.error : (parsed.error?.message ?? message);
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, message);
  }
  return JSON.parse(text) as T;
}

export const api = {
  cells: () => get<{ cells: string[]; control_plane: string }>("/api/cells"),
  fleet: (cell: string) => get<Fleet>(`/api/fleet?cell=${encodeURIComponent(cell)}`),
  images: (cell: string) => get<Images>(`/api/images?cell=${encodeURIComponent(cell)}`),
};
