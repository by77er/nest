// A host's lifecycle as FleetDO decides it (docs/control-plane/durable-objects/fleet/; transitions H1-H12
// of docs/verification/hosts/), as pure functions. FleetDO reads the host's row, asks here, and writes
// the answer in the same synchronous step, so a transition never applies to a row an await changed.
import type { HostStatus, LaunchEndReason } from "../../../protocol/admin/view";

/** What a status transition depends on. */
export interface HostFacts {
  status: HostStatus;
  /** A drain was asked for (a spot notice, a previous-release nestd). Kept across expiry and recovery. */
  draining: boolean;
  /** AgentDO reported a brain there that didn't exit when killed: only its death ends STONITH (D5). */
  wedged: boolean;
  /** FleetDO is terminating its instance (STONITH through EC2): only EC2's answer ends STONITH. */
  terminating: boolean;
}

export type HostTransition =
  /** H4: an expired host said hello: it serves again, or drains again if it was draining. */
  | "hello_back"
  /** H10: no new placements. Recorded whatever the host's liveness, so a recovery keeps it. */
  | "drain"
  /** H5: silent while holding a live lease, or wedged: its leases expire and it waits for STONITH. */
  | "expire_held"
  /** H6: silent holding no live lease: expired at once. */
  | "expire_silent"
  /** H7: a fence covered every expired lease: it serves (or drains) again. */
  | "fence_done"
  /** H2, H8, H9, H11, H12, H13: gone for good. */
  | "die";

/**
 * The status transition `t` moves a host to, or `null` when `t` doesn't apply from where the host
 * is. Nothing leaves `dead`. A host FleetDO is terminating, or that is wedged, never serves again
 * by its own fence: only its confirmed death ends its STONITH.
 */
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
 * The tick's verdict on one host (H5, H6): any serving host silent for `expiryMs` is expired,
 * whatever its kind. One holding a live lease waits for STONITH, and so does a wedged one (D5: its
 * own watchdog isn't trusted to have killed its brains). A host that never said hello isn't silent.
 */
export function expiryVerdict(
  h: { status: HostStatus; last_rx: number | null; wedged: boolean }, holdsLease: boolean, nowMs: number, expiryMs: number,
): "expire_held" | "expire_silent" | null {
  if ((h.status !== "active" && h.status !== "draining") || h.last_rx === null || nowMs - h.last_rx < expiryMs) return null;
  return h.wedged || holdsLease ? "expire_held" : "expire_silent";
}

export type DeathCause =
  /** STONITH confirmed (EC2 says the instance is gone), or an operator's confirm-dead (H8, H9). */
  | "confirmed"
  /** Its proof enrolled again before it ever said hello (H2). */
  | "never_connected"
  /** It enrolled but never said hello within the cell's enroll timeout (H13). */
  | "enroll_timeout"
  /** It held nothing for its kind's idle grace (H11). */
  | "idle"
  /** Draining, and everything has left (H12). */
  | "drained";

export interface DeathPlan {
  /** Its brains are proven gone (A6) and handed back now; otherwise only EC2's confirmation proves it. */
  proof: boolean;
  /** Why its instance, if it has one, is terminated (`launched.reason`); null: it isn't (it enrolls again). */
  end: LaunchEndReason | null;
  /** Its leases: placed again elsewhere, or evicted (each is suspended, its head in the object store). */
  leases: "reassign" | "evict";
}

/** What a host's death means, by cause. */
export function deathPlan(cause: DeathCause): DeathPlan {
  switch (cause) {
    case "confirmed":
      return { proof: true, end: "dead", leases: "reassign" };
    case "never_connected":
      return { proof: true, end: null, leases: "reassign" };
    case "enroll_timeout":
      return { proof: true, end: "enroll_timeout", leases: "reassign" };
    case "idle":
      return { proof: false, end: "idle", leases: "evict" };
    case "drained":
      return { proof: false, end: "drained", leases: "evict" };
  }
}
