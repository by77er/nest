// The sandbox lease's decisions (docs/verification/sandbox-lease/): which host holds a sandbox, at
// which epoch, and what each event does to that. A pure, synchronous core: one function per model
// action (§9: Claim, PlaceReply, Reconcile, Report, LeaseLost, Evict, CreateFailed, Retry, Destroy).
// Each takes the lease fields of SandboxDO's `info`, mutates them in place (SandboxDO calls it inside
// `update()`, so nothing is saved from a pre-await copy), awaits nothing and returns what the shell
// does next. SandboxDO is the I/O shell: FleetDO calls, deadlines, follow-ups.
//
// Two rules hold in every transition here: a destroyed or archived sandbox is never changed again
// (`gone`), and only the current lease holder's reports count (`holds`).
import { NestError } from "./util";
import type { GuestInfo } from "../protocol/gateway";
import { ErrorCodes, type SandboxState } from "../protocol/model";

/** The fields of SandboxDO's `info` that the lease decides. */
export interface Lease {
  epoch: number;
  /** The epoch being placed (FleetDO.place in flight), and since when. */
  placing: number | null;
  placing_ms: number | null;
  host: string | null;
  state: SandboxState;
  head: string | null;
  /** The host whose lease was lost, while the sandbox waits for a new placement. */
  lost_from: string | null;
  /** `sandbox_create` re-issues after retryable failures at the current epoch. */
  create_attempts: number;
  guest: GuestInfo | null;
  /** Agents mid-turn on the sandbox: a suspended sandbox with any is placed at once. */
  working: string[];
}

/** FleetDO's lease row for the sandbox, as `leaseOf` reports it. */
export interface LeaseView {
  host: string;
  epoch: number;
  expired: boolean;
  state: SandboxState | null;
  guest: GuestInfo | null;
}

/** A `placing` marker this old belongs to a placement that never finished: reconciled against FleetDO's lease. */
export const PLACING_STALE_MS = 60_000;
export const MAX_CREATE_ATTEMPTS = 3;

/** Destroyed and archived are final: no transition leaves them (S9). */
export const gone = (s: SandboxState): boolean => s === "destroyed" || s === "archived";

/** `host` holds the sandbox's current lease at `epoch`: the guard on every host-reported event. */
export const holds = (l: Lease, host: string, epoch: number): boolean => !gone(l.state) && l.host === host && l.epoch === epoch;

/** Claim: a new epoch for an unplaced sandbox, marked as being placed. One lease, one host, ever. */
export function claim(l: Lease, now: number): { ok: true; epoch: number } | { ok: false; error: NestError } {
  if (gone(l.state)) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${l.state}`, 409) };
  if (l.host) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, `sandbox is already placed on ${l.host} (epoch ${l.epoch})`, 409) };
  if (l.placing !== null) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, "placement already in progress", 409, true) };
  l.epoch += 1;
  l.placing = l.epoch;
  l.placing_ms = now;
  l.create_attempts = 0;
  // A new placement is a new VM: the old guest's version means nothing to it.
  l.guest = null;
  return { ok: true, epoch: l.epoch };
}

/**
 * FleetDO's answer to `place`: a host (a lease at the claimed epoch), none fits, refused outright (a
 * lease at another epoch), or unknown (any other failure: a lease may exist).
 */
export type PlaceAnswer = { kind: "host"; host: string } | { kind: "none" } | { kind: "refused" } | { kind: "unknown" };

/**
 * PlaceReply. `stale`: the marker is no longer this claim's (destroyed, or reconciled meanwhile), so
 * nothing changes and nothing follows. `unknown`: the marker stays for the `place` deadline to
 * reconcile. Otherwise the marker is cleared; with no lease under the claimed epoch it is rolled back
 * (the next claim reuses it: sandbox-lease B1, the owner's open decision).
 */
export function placeAnswered(l: Lease, epoch: number, a: PlaceAnswer, restoring: boolean): "stale" | "unknown" | "placed" | "unplaced" {
  if (l.placing !== epoch || gone(l.state)) return "stale";
  if (a.kind === "unknown") return "unknown";
  l.placing = null;
  l.placing_ms = null;
  if (a.kind !== "host") {
    if (l.epoch === epoch) l.epoch = epoch - 1;
    return "unplaced";
  }
  l.host = a.host;
  l.state = restoring ? "restoring" : "creating";
  l.lost_from = null;
  return "placed";
}

/** When an unfinished marker may be reconciled (null: no marker). */
export const reconcileAt = (l: Lease): number | null => (l.placing === null ? null : (l.placing_ms ?? 0) + PLACING_STALE_MS);

/**
 * Reconcile a stale marker for `epoch` against FleetDO's lease. `gone`: destroyed meanwhile (a lease
 * at `epoch` is the shell's to discard); `stale`: someone else already settled it; `adopted`: a live
 * lease at that epoch is taken, with the state and guest its holder last reported; `cleared`: no such
 * lease, so the marker goes.
 */
export function reconciled(l: Lease, epoch: number, lease: LeaseView | null): "gone" | "stale" | "adopted" | "cleared" {
  if (l.placing === epoch) {
    l.placing = null;
    l.placing_ms = null;
  } else if (!gone(l.state)) {
    return "stale";
  }
  if (gone(l.state)) return "gone";
  if (!lease || lease.epoch !== epoch || lease.expired) return "cleared";
  l.host = lease.host;
  l.state = lease.state ?? (l.head ? "restoring" : "creating");
  l.guest = lease.guest;
  l.lost_from = null;
  return "adopted";
}

/** Report: a host-reported state, from the holder only. A `running` report carries the guest's version. */
export function reported(
  l: Lease, host: string, epoch: number, state: SandboxState, guest: GuestInfo | null,
): { applied: false } | { applied: true; changed: boolean; becameRunning: boolean } {
  if (!holds(l, host, epoch)) return { applied: false };
  const before = l.state;
  l.state = state;
  if (guest && state === "running") l.guest = guest;
  return { applied: true, changed: state !== before, becameRunning: state === "running" && before !== "running" };
}

/**
 * LeaseLost (STONITH confirmed, or the holder fenced; FleetDO already dropped the lease). Keyed on
 * the lease (host, epoch), never on a host-reported state: host evidence doesn't block the control
 * plane's own transitions. A lease this object never adopted (its placement was cut off and the
 * marker since cleared) counts as its own. `replace` again for a loss already handled and not yet
 * re-placed (FleetDO retries until the call succeeds).
 */
export function leaseLost(l: Lease, host: string, epoch: number): "replace" | "ignore" {
  if (gone(l.state)) return "ignore";
  if (l.epoch === epoch && (l.host === host || (l.host === null && l.placing === null))) {
    // `working` stays: the brains run elsewhere, untouched by this host's loss.
    l.host = null;
    l.lost_from = host;
    return "replace";
  }
  return l.host === null && l.lost_from === host ? "replace" : "ignore";
}

/**
 * Evict: FleetDO took this suspended sandbox off a host going away (its head is in the object
 * store). Placed elsewhere now if an agent is mid-turn on it, else parked until something wakes it.
 */
export function evicted(l: Lease, host: string, epoch: number): "replace" | "park" | "ignore" {
  if (!holds(l, host, epoch)) return "ignore";
  l.host = null;
  l.state = "suspended";
  return l.working.length ? "replace" : "park";
}

/** CreateFailed: a retryable `sandbox_create` failure is re-issued at the same epoch a few times; then failed. */
export function createFailed(l: Lease, host: string, epoch: number, retryable: boolean): "reissue" | "failed" | "ignore" {
  if (!holds(l, host, epoch)) return "ignore";
  if (retryable && l.create_attempts < MAX_CREATE_ATTEMPTS) {
    l.create_attempts += 1;
    return "reissue";
  }
  l.state = "failed";
  return "failed";
}

/** Retry (operator): a failed sandbox's holder, to fence and release before it is placed again. */
export const failedHolder = (l: Lease): { host: string; epoch: number } | null =>
  l.state === "failed" && l.host && !gone(l.state) ? { host: l.host, epoch: l.epoch } : null;

/** Retry, after the fence and the release: unplaced, if nothing moved meanwhile. */
export function retried(l: Lease, host: string, epoch: number): void {
  if (!holds(l, host, epoch)) return;
  l.host = null;
  l.state = "creating";
}

/** Destroy: final. A placement still in flight finds no marker, so it adopts nothing. */
export function destroyed(l: Lease): void {
  l.state = "destroyed";
  l.host = null;
  l.placing = null;
  l.placing_ms = null;
}

/** The `place` alarm places a live, unplaced sandbox; a suspended one only while someone works. */
export const placeWanted = (l: Lease): boolean =>
  l.host === null && l.placing === null && !gone(l.state) && (l.state !== "suspended" || l.working.length > 0);

/**
 * Commit (sandbox-lease §2.4, the commit-gc Lean pilot's `CommitChain.commit`, guard for guard): a
 * request not answered before. `kind` must agree with the memory manifest (the chain is immutable,
 * and a checkpoint without one would restore without memory). A salvage from an older epoch is an
 * orphaned sibling (head unchanged), only from the host that held that epoch. Anything else moves
 * the head only from the current holder at the current epoch, with the head as its parent (S1, S6).
 */
export function decideCommit(
  l: Pick<Lease, "epoch" | "host" | "head">, epochHost: (epoch: number) => string | undefined, host: string,
  ev: { kind: "disk_only" | "checkpoint"; mem_manifest?: string; reason: string; epoch: number; parent?: string },
): { kind: "rejected"; reason: string } | { kind: "orphan" } | { kind: "head" } {
  if ((ev.kind === "checkpoint") !== (ev.mem_manifest !== undefined)) return { kind: "rejected", reason: ErrorCodes.INVALID_MESSAGE };
  if (ev.reason === "salvage" && ev.epoch < l.epoch) {
    return epochHost(ev.epoch) === host ? { kind: "orphan" } : { kind: "rejected", reason: ErrorCodes.STALE_EPOCH };
  }
  if (ev.epoch !== l.epoch || host !== l.host) return { kind: "rejected", reason: ErrorCodes.STALE_EPOCH };
  if ((ev.parent ?? null) !== l.head) return { kind: "rejected", reason: ErrorCodes.PARENT_MISMATCH };
  return { kind: "head" };
}
