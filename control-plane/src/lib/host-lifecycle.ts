// A host's lifecycle as FleetDO decides it (transitions H1-H13 of docs/verification/hosts/), as pure
// functions. FleetDO reads the row, asks here and writes the answer in one synchronous step.
import type { HostStatus, LaunchEndReason } from "../../../protocol/admin/view";

export interface HostFacts {
  status: HostStatus;
  /** A drain was asked for; kept across expiry and recovery. */
  draining: boolean;
  /** A brain there didn't exit when killed: only its death ends STONITH (D5). */
  wedged: boolean;
  /** FleetDO is terminating its instance: only EC2's answer ends STONITH. */
  terminating: boolean;
}

export type HostTransition =
  | "hello_back" // H4
  | "drain" // H10, from any live status, so a recovery keeps it
  | "expire_held" // H5: silent holding a live lease, or wedged
  | "expire_silent" // H6
  | "fence_done" // H7
  | "die"; // H2, H8, H9, H11, H12, H13

/** The status `t` moves a host to, or `null` when it doesn't apply. Nothing leaves `dead`. */
export function hostStep(h: HostFacts, t: HostTransition): HostStatus | null {
  const back = h.draining ? "draining" : "active";
  const serving = h.status === "active" || h.status === "draining";
  switch (t) {
    case "hello_back":
      return h.status === "expired" ? back : null;
    case "drain":
      return h.status === "dead" ? null : h.status === "active" ? "draining" : h.status;
    case "expire_held":
      return serving ? "stonith_pending" : null;
    case "expire_silent":
      return serving ? "expired" : null;
    case "fence_done":
      return h.status === "stonith_pending" && !h.wedged && !h.terminating ? back : null;
    case "die":
      return h.status === "dead" ? null : "dead";
  }
}

/**
 * The tick's verdict on a serving host silent for `expiryMs` (H5, H6). A wedged one waits for STONITH
 * like one holding a lease (D5: its watchdog isn't trusted). A host that never said hello isn't silent.
 */
export function expiryVerdict(
  h: { status: HostStatus; last_rx: number | null; wedged: boolean }, holdsLease: boolean, nowMs: number, expiryMs: number,
): "expire_held" | "expire_silent" | null {
  if ((h.status !== "active" && h.status !== "draining") || h.last_rx === null || nowMs - h.last_rx < expiryMs) return null;
  return h.wedged || holdsLease ? "expire_held" : "expire_silent";
}

/** `confirmed`: EC2 or an operator (H8, H9); `never_connected`: its proof enrolled again (H2); `enroll_timeout`: H13. */
export type DeathCause = "confirmed" | "never_connected" | "enroll_timeout" | "idle" | "drained";

export interface DeathPlan {
  /** Its brains are proven gone now (A6); otherwise only EC2's confirmation proves it. */
  proof: boolean;
  /** `launched.reason` its instance is terminated for; null: it isn't. */
  end: LaunchEndReason | null;
  /** Its leases are placed elsewhere, or evicted (suspended, head in the object store). */
  leases: "reassign" | "evict";
}

const DEATHS: Record<DeathCause, DeathPlan> = {
  confirmed: { proof: true, end: "dead", leases: "reassign" },
  never_connected: { proof: true, end: null, leases: "reassign" },
  enroll_timeout: { proof: true, end: "enroll_timeout", leases: "reassign" },
  idle: { proof: false, end: "idle", leases: "evict" },
  drained: { proof: false, end: "drained", leases: "evict" },
};

export const deathPlan = (cause: DeathCause): DeathPlan => DEATHS[cause];
