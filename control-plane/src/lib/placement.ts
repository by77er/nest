// Host-kind decisions FleetDO takes (docs/compute/brain-hosts/, docs/compute/autoscaling/), as pure
// functions: inputs in, a decision out, no I/O and no clock of their own. FleetDO gathers the inputs
// (its rows, the host's last capacity report, the cell's `AWS_CELLS` entry) and applies what comes
// back; the decision logic lives only here, where it is unit- and property-tested.

/** A brain host as brain placement sees it. */
export interface BrainHostFacts {
  host: string;
  /** Active, connected, not wedged, and of this release (its hello said `brain_epochs`). */
  healthy: boolean;
  /** Brains indexed there (FleetDO's `host_agents`: started and not yet proven exited). */
  brains: number;
  /** What it may hold (`maxBrains`). */
  max_brains: number;
}

export type BrainPick =
  /** `previous`: the host that ran the agent last (its session file is still on disk). `packed`: the fullest host with room. */
  | { host: string; why: "previous" | "packed" }
  /** `full`: healthy brain hosts exist but none has room. `none`: no healthy brain host at all. */
  | { host: null; why: "full" | "none" };

/**
 * Where a new brain goes: never a host that isn't healthy, never `avoid`, never one at its
 * `max_brains`. Among the rest, `prev` (a warm session: a preference, not a rule), else the fullest
 * (most brains, then the smallest id), so idle hosts empty out and scale to zero.
 */
export function pickBrainHost(hosts: readonly BrainHostFacts[], prev?: string | null, avoid?: string | null): BrainPick {
  const usable = hosts.filter((h) => h.healthy && h.host !== avoid);
  const room = usable.filter((h) => h.brains < h.max_brains);
  if (!room.length) return { host: null, why: usable.length ? "full" : "none" };
  const warm = prev ? room.find((h) => h.host === prev) : undefined;
  if (warm) return { host: warm.host, why: "previous" };
  const best = room.reduce((a, b) => (b.brains > a.brains || (b.brains === a.brains && b.host < a.host) ? b : a));
  return { host: best.host, why: "packed" };
}

/** Brains per vCPU when the cell sets no `brain.max_brains_per_host`: a Claude Code brain mostly waits on the API. */
export const BRAINS_PER_VCPU = 2;

/**
 * What a brain host may hold: the cell's `brain.max_brains_per_host` when set (above 0), else from
 * the instance's size, `BRAINS_PER_VCPU` per vCPU it reports (a brain host holds no sandbox, so its
 * `vcpus_free` is all of them); 1 when it has reported nothing.
 */
export function maxBrains(configured: number | undefined, vcpus: number | null | undefined): number {
  if (configured && configured > 0) return configured;
  return Math.max(1, BRAINS_PER_VCPU * Math.max(0, Math.floor(vcpus ?? 0)));
}

/** One host kind's autoscaler settings (a cell's `AWS_CELLS` entry, or its `brain` section). */
export interface ScaleSettings {
  instance_types: readonly string[];
  subnet_ids: readonly string[];
  spot: boolean;
  max_hosts: number;
}

export interface LaunchAttempt {
  type: string;
  subnet: string;
  spot: boolean;
}

export type ScaleUp =
  | { launch: LaunchAttempt[] }
  | { launch: null; why: "launching" | "pending" | "at_max" };

/**
 * A host of one kind is needed and none can take the work: launch one, unless a launch of that
 * kind is in flight (`launching`) or launched and not yet enrolled (`pending`), or the kind is at
 * `max_hosts` (`live`: its active and STONITH-pending hosts; a draining one doesn't count). The
 * attempts: each instance type on spot (zones rotating with the second), then the first type on
 * demand.
 */
export function scaleUpPlan(s: ScaleSettings, live: number, pending: number, launching: boolean, nowMs: number): ScaleUp {
  if (launching) return { launch: null, why: "launching" };
  if (pending > 0) return { launch: null, why: "pending" };
  if (live >= s.max_hosts) return { launch: null, why: "at_max" };
  const zone = (i: number) => s.subnet_ids[(Math.floor(nowMs / 1000) + i) % s.subnet_ids.length]!;
  return {
    launch: [
      ...(s.spot ? s.instance_types.map((type, i) => ({ type, subnet: zone(i), spot: true })) : []),
      { type: s.instance_types[0]!, subnet: zone(0), spot: false },
    ],
  };
}

export type IdleStep =
  /** Holding work: its idle clock (if any) is cleared. */
  | "busy"
  /** Newly idle: its idle clock starts now. */
  | "start"
  /** Idle, within the grace. */
  | "wait"
  /** Idle for the whole grace: retire it. */
  | "retire";

/**
 * A launched host's idle clock: one holding work is busy; one that isn't starts its clock, and is
 * retired once it has held nothing for `graceMs` (`idle_since` is when the clock started).
 */
export function idleStep(busy: boolean, idleSince: number | null, nowMs: number, graceMs: number): IdleStep {
  if (busy) return "busy";
  if (idleSince === null) return "start";
  return nowMs - idleSince >= graceMs ? "retire" : "wait";
}
