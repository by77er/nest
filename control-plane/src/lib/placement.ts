// Host-kind decisions FleetDO takes (docs/compute/brain-hosts/, docs/compute/autoscaling/), as pure
// functions: inputs in, a decision out, no I/O and no clock of their own. FleetDO gathers the inputs
// (its rows, the host's last capacity report, the cell's `AWS_CELLS` entry) and applies what comes
// back; the decision logic lives only here, where it is unit- and property-tested.
import type { Capacity } from "../protocol/control";

/** A connected, active, unwedged sandbox host as packing sees it. */
export interface SandboxHostFacts {
  host: string;
  /** Its last capacity report (null: none yet). */
  capacity: Capacity | null;
  /** The `mark` at which `capacity` was reported (null: before marks existed). */
  capacity_seq: number | null;
  /** Its leases: what each reserves, and whether the capacity report already counts it. */
  leases: readonly { state: string | null; state_seq: number | null; vcpus: number | null; memory_mib: number | null }[];
  /** It holds a warm snapshot of what the sandbox is created from. */
  warm: boolean;
}

/** How a cell packs sandboxes on regular pages (`AWS_CELLS`). */
export interface PackSettings {
  /** What a sandbox reserves against `memory_mib_free` (MiB). */
  reserve_mib: number;
  /** At most this many sandboxes per host; 0: no cap. */
  max_per_host: number;
}

/**
 * Where a new sandbox goes (docs/compute/autoscaling/): fill hosts before opening new ones, so idle
 * hosts empty out. A host's room is its last capacity report less what leases placed since reserve
 * (a lease with no state yet, or whose first state the last capacity report predates: nestd reports
 * state at once but capacity at most every 30 s, so a burst would otherwise see none of its own
 * placements). On regular pages (no hugepage pool, the default) a sandbox costs what it touches: it
 * reserves `reserve_mib` against `memory_mib_free`, its declared size being a ceiling the jailer
 * enforces, and `max_per_host` caps the count. On a hugepage host the pool is a hard reservation:
 * the declared size counts against `hugepages_mib_free`, declared vCPUs against `vcpus_free`. An
 * empty host always takes one. Among the hosts that fit: a warm snapshot first, then the fullest
 * (least room left after this sandbox, then most leases). `null`: none fits.
 */
export function pickSandboxHost(hosts: readonly SandboxHostFacts[], need: { vcpus: number; memory_mib: number }, cfg: PackSettings): string | null {
  const fit = (h: SandboxHostFacts): { room: number; fits: boolean } => {
    const n = h.leases.length;
    const cap = h.capacity;
    if (!cap) return { room: n ? 0 : Infinity, fits: n === 0 };
    // A lease that reported before marks existed (state set, no state_seq) is counted.
    const pending = h.leases.filter((l) => l.state === null || (l.state_seq !== null && (h.capacity_seq ?? 0) <= l.state_seq));
    const hugepageHost = (cap.hugepages_mib_total ?? 0) > 0;
    if (hugepageHost) {
      const huge = cap.hugepages_mib_free - pending.reduce((sum, l) => sum + (l.memory_mib ?? need.memory_mib), 0);
      const vcpus = cap.vcpus_free - pending.reduce((sum, l) => sum + (l.vcpus ?? need.vcpus), 0);
      return { room: huge - need.memory_mib, fits: n === 0 || (huge >= need.memory_mib && vcpus >= need.vcpus) };
    }
    const mem = cap.memory_mib_free - pending.length * cfg.reserve_mib;
    const underCap = cfg.max_per_host === 0 || n < cfg.max_per_host;
    return { room: mem - cfg.reserve_mib, fits: n === 0 || (underCap && mem >= cfg.reserve_mib) };
  };
  const fitting = hosts.map((h) => ({ h, ...fit(h) })).filter((c) => c.fits);
  fitting.sort((a, b) => Number(b.h.warm) - Number(a.h.warm) || a.room - b.room || b.h.leases.length - a.h.leases.length);
  return fitting[0]?.h.host ?? null;
}

/** A brain host as brain placement sees it. */
export interface BrainHostFacts {
  host: string;
  /** Active, connected, not wedged, and of this release (its hello said `brain_epochs`). */
  healthy: boolean;
  /**
   * Active and not wedged, but not connected now, and not known to be of the previous release (its
   * last hello said `brain_epochs`, or it hasn't said hello yet): it is expected back (or expired at
   * 30 s), so it is no reason to launch another host.
   */
  reconnecting?: boolean;
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

/**
 * Whether the cell needs another brain host for a start that avoids `avoid`: only for a real lack of
 * capacity. No host with room is healthy, and none with room is merely reconnecting (a brief drop,
 * or a host that just enrolled): those are not capacity to buy. A host of the previous release is
 * neither, so it never stops a launch.
 */
export function brainHostNeeded(hosts: readonly BrainHostFacts[], avoid?: string | null): boolean {
  return !hosts.some((h) => h.host !== avoid && (h.healthy || h.reconnecting) && h.brains < h.max_brains);
}

/** Brains per vCPU when the cell sets no `brain.max_brains_per_host`: a Claude Code brain mostly waits on the API. Unverified: no measurement on a brain host yet. */
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
