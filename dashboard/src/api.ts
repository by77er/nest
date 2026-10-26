// What the control plane's two read routes return: the admin view contract in
// protocol/admin/view.ts, which the control plane's `fleetView` and `images` are typed by too. The
// dashboard imports nothing from the control plane, and only types from protocol/: it stays an
// independent Worker, and `npm run typecheck` fails when the page reads a field the view lacks.
export type {
  CapacityView as Capacity, FleetView as Fleet, HostRole, HostStatus, HostView as Host, ImageView as Image, ImagesView as Images,
  LaunchEndReason, LaunchView as Launch, ResidentView as Resident, SandboxState, SandboxView as SandboxRow, TemplateView as Template,
  TunnelState,
} from "../../protocol/admin/view";
import type { AwsView, FleetView, HostView, ImagesView, SandboxState, SandboxView, TunnelState } from "../../protocol/admin/view";

/**
 * A sandbox row as the control plane before the typed view returned it: one `state`, the lease's
 * with a host and the sandbox's own without. Accepted for one release, since the dashboard and the
 * control plane deploy separately.
 */
export interface LegacySandboxRow {
  sandbox: string;
  registered_ms: number;
  host: string | null;
  epoch: number | null;
  state: SandboxState | null;
  image: string | null;
  workstream: string | null;
}

/** What `GET /api/fleet` may answer during that release. */
export interface FleetResponse {
  /** The previous release sends `tunnel_state` null for `none`, and `lost`/`brain_epochs` as 0/1 (or not at all, before them). */
  hosts: (Omit<HostView, "tunnel_state" | "lost" | "brain_epochs" | "wedged_ms"> & {
    tunnel_state: TunnelState | null; lost?: boolean | number; brain_epochs?: boolean | number; wedged_ms?: number | null;
  })[];
  launches: FleetView["launches"];
  sandboxes: (SandboxView | LegacySandboxRow)[];
  aws?: AwsView;
}

/** Either shape as the current one. */
export function normalizeFleet(raw: FleetResponse): FleetView {
  return {
    hosts: raw.hosts.map((h) => ({
      ...h, tunnel_state: h.tunnel_state ?? "none", lost: !!h.lost, brain_epochs: !!h.brain_epochs, wedged_ms: h.wedged_ms ?? null,
    })),
    launches: raw.launches,
    aws: raw.aws ?? { cell: null, error: "not reported by this control plane" },
    sandboxes: raw.sandboxes.map((s): SandboxView => {
      if ("lease_state" in s) return s;
      const { state, ...rest } = s;
      // The old view could not read the sandbox when it returned neither image nor workstream.
      const infoError = s.image === null && s.workstream === null;
      return { ...rest, lease_state: s.host ? state : null, sandbox_state: s.host || infoError ? null : state, info_error: infoError };
    }),
  };
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
  fleet: async (cell: string) => normalizeFleet(await get<FleetResponse>(`/api/fleet?cell=${encodeURIComponent(cell)}`)),
  images: (cell: string) => get<ImagesView>(`/api/images?cell=${encodeURIComponent(cell)}`),
};
