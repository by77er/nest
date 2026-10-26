// What the control plane's two read routes return. The shapes are the control plane's own
// (control-plane/src/protocol/admin.ts, the return types of FleetDO's `fleetView` and `images`),
// imported as types only: the dashboard stays an independent Worker with no runtime dependency on
// the control plane, and `npm run typecheck` fails when the page reads a field the view lacks.
export type {
  CapacityView as Capacity, FleetView as Fleet, HostRole, HostStatus, HostView as Host, ImageView as Image, ImagesView as Images,
  LaunchEndReason, LaunchView as Launch, ResidentView as Resident, SandboxState, SandboxView as SandboxRow, TemplateView as Template,
  TunnelState,
} from "../../control-plane/src/protocol/admin";
import type { FleetView, ImagesView } from "../../control-plane/src/protocol/admin";

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
  fleet: (cell: string) => get<FleetView>(`/api/fleet?cell=${encodeURIComponent(cell)}`),
  images: (cell: string) => get<ImagesView>(`/api/images?cell=${encodeURIComponent(cell)}`),
};
