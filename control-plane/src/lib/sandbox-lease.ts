// The sandbox lease's decisions (docs/verification/sandbox-lease/), one pure function per model action
// (§9). Each mutates the lease fields of SandboxDO's `info` inside `update()` and returns what the
// shell does next. In every one, a `gone` sandbox never changes, and only the holder's reports count.
import { NestError } from "./util";
import type { GuestInfo } from "../protocol/gateway";
import { ErrorCodes, type SandboxState } from "../protocol/model";

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
  /** `sandbox_create` re-issues at the current epoch. */
  create_attempts: number;
  guest: GuestInfo | null;
  /** Agents mid-turn: a suspended sandbox with any is placed at once. */
  working: string[];
}

/** FleetDO's lease row (`leaseOf`). */
export interface LeaseView {
  host: string;
  epoch: number;
  expired: boolean;
  state: SandboxState | null;
  guest: GuestInfo | null;
}

/** A `placing` marker this old is reconciled against FleetDO's lease. */
export const PLACING_STALE_MS = 60_000;
export const MAX_CREATE_ATTEMPTS = 3;

/** Final: no transition leaves them (S9). */
export const gone = (s: SandboxState): boolean => s === "destroyed" || s === "archived";

/** The guard on every host-reported event. */
export const holds = (l: Lease, host: string, epoch: number): boolean => !gone(l.state) && l.host === host && l.epoch === epoch;

/** Claim: a new epoch for an unplaced sandbox, marked as being placed. */
export function claim(l: Lease, now: number): { ok: true; epoch: number } | { ok: false; error: NestError } {
  if (gone(l.state)) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, `sandbox is ${l.state}`, 409) };
  if (l.host) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, `sandbox is already placed on ${l.host} (epoch ${l.epoch})`, 409) };
  if (l.placing !== null) return { ok: false, error: new NestError(ErrorCodes.FORBIDDEN, "placement already in progress", 409, true) };
  l.epoch += 1;
  l.placing = l.epoch;
  l.placing_ms = now;
  l.create_attempts = 0;
  l.guest = null; // a new VM
  return { ok: true, epoch: l.epoch };
}

/** FleetDO's answer to `place`: `refused` (a lease at another epoch), `unknown` (a lease may exist). */
export type PlaceAnswer = { kind: "host"; host: string } | { kind: "none" } | { kind: "refused" } | { kind: "unknown" };

/**
 * PlaceReply. `stale`: the marker is no longer this claim's, so nothing follows. `unknown`: the marker
 * stays for the `place` deadline. With no lease, the epoch is rolled back (B1, the owner's open decision).
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
 * Reconcile a stale marker for `epoch` against FleetDO's lease. `gone`: destroyed meanwhile (the shell
 * discards a lease at `epoch`); `stale`: already settled; `adopted`: a live lease at `epoch`, with its
 * holder's last state and guest; `cleared`: no such lease.
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

/** Report. A `running` report carries the guest's version. */
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
 * LeaseLost (FleetDO already dropped the lease). Keyed on (host, epoch), never on a reported state. A
 * lease never adopted (its marker since cleared) counts as its own. A loss handled but not yet
 * re-placed is `replace` again (FleetDO retries until the call succeeds).
 */
export function leaseLost(l: Lease, host: string, epoch: number): "replace" | "ignore" {
  if (gone(l.state)) return "ignore";
  if (l.epoch === epoch && (l.host === host || (l.host === null && l.placing === null))) {
    l.host = null; // `working` stays: the brains run elsewhere
    l.lost_from = host;
    return "replace";
  }
  return l.host === null && l.lost_from === host ? "replace" : "ignore";
}

/** Evict: off a host going away, suspended (head in the object store); placed now only if someone works. */
export function evicted(l: Lease, host: string, epoch: number): "replace" | "park" | "ignore" {
  if (!holds(l, host, epoch)) return "ignore";
  l.host = null;
  l.state = "suspended";
  return l.working.length ? "replace" : "park";
}

/** CreateFailed: a retryable failure is re-issued at the same epoch a few times; then failed. */
export function createFailed(l: Lease, host: string, epoch: number, retryable: boolean): "reissue" | "failed" | "ignore" {
  if (!holds(l, host, epoch)) return "ignore";
  if (retryable && l.create_attempts < MAX_CREATE_ATTEMPTS) {
    l.create_attempts += 1;
    return "reissue";
  }
  l.state = "failed";
  return "failed";
}

/** Retry (operator): a failed sandbox's holder, fenced and released before it is placed again. */
export const failedHolder = (l: Lease): { host: string; epoch: number } | null =>
  l.state === "failed" && l.host ? { host: l.host, epoch: l.epoch } : null;

/** How long a failed sandbox keeps its lease (and so its host) before `failedReleased` (state-machine sweep, bug 6). */
export const FAILED_RELEASE_MS = 15 * 60_000;

/**
 * A failed sandbox's lease, released after `FAILED_RELEASE_MS` (its holder fenced first), if nothing moved
 * meanwhile: unplaced, still `failed`, so its host can retire. Nothing places it again on its own
 * (`placeWanted`, `wake`): an operator's retry (`claim`) or a destroy does.
 */
export function failedReleased(l: Lease, host: string, epoch: number): boolean {
  if (l.state !== "failed" || !holds(l, host, epoch)) return false;
  l.host = null;
  l.lost_from = null;
  return true;
}

/** An operator's retry of a failed sandbox whose lease was already released: placeable again (`creating`). */
export function retriedReleased(l: Lease): boolean {
  if (l.state !== "failed" || l.host !== null || l.placing !== null) return false;
  l.state = "creating";
  return true;
}

/** Retry, after the fence and release, if nothing moved meanwhile. */
export function retried(l: Lease, host: string, epoch: number): void {
  if (!holds(l, host, epoch)) return;
  l.host = null;
  l.state = "creating";
}

/** Destroy. A placement in flight finds no marker, so it adopts nothing. */
export function destroyed(l: Lease): void {
  l.state = "destroyed";
  l.host = null;
  l.placing = null;
  l.placing_ms = null;
}

/** The `place` alarm places a live, unplaced sandbox; a suspended one only while someone works. */
export const placeWanted = (l: Lease): boolean =>
  l.host === null && l.placing === null && !gone(l.state) && l.state !== "failed" && (l.state !== "suspended" || l.working.length > 0);

/**
 * Commit (sandbox-lease §2.4; the commit-gc pilot's `CommitChain.commit`, guard for guard). `kind`
 * must agree with the memory manifest (a checkpoint without one restores without memory). A salvage
 * from an older epoch is an orphaned sibling, only from that epoch's host. Anything else moves the
 * head only from the holder at the current epoch, with the head as its parent (S1, S6).
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
