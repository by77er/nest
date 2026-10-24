// What the control plane's two read routes return (control-plane/src/do/fleet.ts: fleetView, images).

export interface Capacity {
  vcpus_free: number;
  memory_mib_free: number;
  hugepages_mib_free: number;
  sandboxes: number;
  agents: number;
  warm: string[];
}

export interface Resident {
  sandbox: string;
  epoch: number;
  state: string | null;
  vcpus: number | null;
  memory_mib: number | null;
}

export interface Host {
  host: string;
  role: string;
  instance_id: string | null;
  status: "active" | "draining" | "stonith_pending" | "dead" | string;
  idle_since: number | null;
  enrolled_ms: number;
  last_rx: number | null;
  tunnel_hostname: string | null;
  tunnel_state: "none" | "connecting" | "connected" | null;
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
  /** The lease's reported state on a host; the sandbox's own state when it has no lease. */
  state: string | null;
  image: string | null;
  workstream: string | null;
}

export interface Fleet {
  hosts: Host[];
  launches: Launch[];
  sandboxes: SandboxRow[];
}

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
  templates?: Template[];
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
