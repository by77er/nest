// Host-kind decisions FleetDO takes (docs/compute/brain-hosts/, docs/compute/autoscaling/), as pure
// functions: no I/O and no clock of their own. FleetDO gathers the inputs and applies the answer.
import type { Capacity } from "../protocol/control";

/** A connected, active, unwedged sandbox host as packing sees it. */
export interface SandboxHostFacts {
  host: string;
  capacity: Capacity | null;
  /** The `mark` of the capacity report (null: before marks existed). */
  capacity_seq: number | null;
  leases: readonly {
    sandbox?: string; state: string | null; state_seq: number | null; vcpus: number | null; memory_mib: number | null;
    /** It may be moved off to make room (`evictionsFor`): suspended, its lease live, and no resume of it in flight. */
    movable?: boolean;
  }[];
  /** It holds a warm snapshot of what the sandbox is created from. */
  warm: boolean;
}

/**
 * `AWS_CELLS` packing: what a sandbox reserves against `memory_mib_free`; a per-host cap (0: none);
 * and the commit rule: how much of a host's memory, less `host_reserve_mib` for the host itself, its
 * sandboxes' declared sizes may add up to, in percent (0 or absent: no such rule).
 */
export interface PackSettings {
  reserve_mib: number;
  max_per_host: number;
  host_reserve_mib?: number;
  commit_pct?: number;
}

/** What a VM costs its host beyond the guest's declared memory: nestd's default jailer margin (`vm_memory_overhead_mib`). */
export const VMM_OVERHEAD_MIB = 128;

/**
 * The commit rule (regular pages): whether `h` may take one more sandbox of `need_mib`, counting
 * what every sandbox on it may grow to, not what it uses now. Guest memory is demand-paged, so an
 * idle guest costs little and free memory admits far more than a host can hold once they work: the
 * kernel then kills a VMM. Two conditions, each on declared size plus the VMM's overhead:
 * - **alone:** the sandbox fits the host's memory less the host's own reserve, so no host takes a
 *   guest it could never hold (an empty host included);
 * - **together:** with every lease already there, it stays within `commit_pct` of that.
 *
 * A host that doesn't say its size (a nestd before `memory_mib_total`) takes nothing more: what its
 * guests may grow to can't be bounded. Off (`commit_pct` 0 or absent), every host passes.
 */
export function withinCommit(h: SandboxHostFacts, need_mib: number, cfg: PackSettings): boolean {
  const pct = cfg.commit_pct ?? 0;
  if (pct <= 0) return true;
  const total = h.capacity?.memory_mib_total ?? 0;
  if (total <= 0) return false;
  const usable = total - (cfg.host_reserve_mib ?? 0);
  const cost = (mib: number) => mib + VMM_OVERHEAD_MIB;
  const committed = h.leases.reduce((sum, l) => sum + cost(l.memory_mib ?? need_mib), 0);
  return cost(need_mib) <= usable && (committed + cost(need_mib)) * 100 <= usable * pct;
}

/**
 * Making room under the commit rule: a suspended sandbox still counts toward its host's commit (it
 * resumes in place, with no placement in between), so a host of mostly suspended sandboxes would be
 * full for good. When no host takes `need`, the suspended sandboxes to move off one host so that it
 * does: their heads are in the object store, and each wakes wherever there is room. Only a lease
 * marked `movable` goes: not an expired one (its host's fence is still owed), nor one being resumed. The host that
 * needs the fewest moved (then the first given); the biggest suspended ones first. Null when the
 * rule is off, or no host would take `need` even with every suspended sandbox gone.
 */
export function evictionsFor(hosts: readonly SandboxHostFacts[], need: { vcpus: number; memory_mib: number }, cfg: PackSettings): { host: string; sandboxes: string[] } | null {
  if ((cfg.commit_pct ?? 0) <= 0) return null;
  let best: { host: string; sandboxes: string[] } | null = null;
  for (const h of hosts) {
    const movable = h.leases.filter((l) => l.movable === true && l.state === "suspended" && l.sandbox !== undefined)
      .sort((a, b) => (b.memory_mib ?? need.memory_mib) - (a.memory_mib ?? need.memory_mib));
    const moved: string[] = [];
    let leases = [...h.leases];
    for (const l of movable) {
      if (pickSandboxHost([{ ...h, leases }], need, cfg)) break;
      leases = leases.filter((x) => x !== l);
      moved.push(l.sandbox!);
    }
    if (moved.length && pickSandboxHost([{ ...h, leases }], need, cfg) && (!best || moved.length < best.sandboxes.length)) best = { host: h.host, sandboxes: moved };
  }
  return best;
}

/**
 * What a host is assumed to report of its instance's nominal memory (`MemTotal`), in percent, when
 * judging a launch type before any host of it exists. Unverified on r8id and m8i (an idle m8id
 * reported 7359 MiB available of 8192 on 2026-11-18, so at least 89.8%); set low on purpose, since
 * an estimate above what hosts report would admit a sandbox every launched host then refuses.
 */
export const MEMTOTAL_PCT = 90;

/**
 * Whether a host of a launch type (`type_mib`: its nominal memory) would hold a sandbox of `need_mib`
 * alone under the commit rule. True when that can't be told: the rule off, or the type's size unknown.
 */
export function typeHolds(type_mib: number | undefined, need_mib: number, cfg: PackSettings): boolean {
  if ((cfg.commit_pct ?? 0) <= 0 || !(type_mib! > 0)) return true;
  return need_mib + VMM_OVERHEAD_MIB <= Math.floor(type_mib! * MEMTOTAL_PCT / 100) - (cfg.host_reserve_mib ?? 0);
}

/**
 * Under the commit rule, the most memory a sandbox may declare and still fit, alone, the largest
 * host the cell launches (`type_memory_mib`: each launch type's nominal memory), or null when that
 * can't be told (the rule off, or a launch type of unknown size). A bigger sandbox fits nowhere:
 * every host launched for it would refuse it.
 */
export function largestSandboxMib(types: readonly string[], type_memory_mib: Readonly<Record<string, number>> | undefined, cfg: PackSettings): number | null {
  if ((cfg.commit_pct ?? 0) <= 0 || !type_memory_mib || !types.length) return null;
  if (types.some((t) => !(type_memory_mib[t]! > 0))) return null;
  const largest = Math.max(...types.map((t) => type_memory_mib[t]!));
  return Math.floor(largest * MEMTOTAL_PCT / 100) - (cfg.host_reserve_mib ?? 0) - VMM_OVERHEAD_MIB;
}

/**
 * Where a new sandbox goes (docs/compute/autoscaling/): fill hosts before opening new ones. A host's
 * room is its last capacity report less what leases it doesn't count yet reserve (no state, or a first
 * state after the report: capacity is reported at most every 30 s). Regular pages: `reserve_mib` each
 * against `memory_mib_free` (the declared size is a jailer ceiling), capped by `max_per_host`. A
 * hugepage host: the declared size against `hugepages_mib_free`, vCPUs against `vcpus_free`. An empty
 * host always takes one, unless the commit rule ([`withinCommit`], regular pages only) refuses it.
 * Preferred: warm, then least room left, then most leases.
 */
export function pickSandboxHost(hosts: readonly SandboxHostFacts[], need: { vcpus: number; memory_mib: number }, cfg: PackSettings): string | null {
  const fit = (h: SandboxHostFacts): { room: number; fits: boolean } => {
    const n = h.leases.length;
    const cap = h.capacity;
    // No report yet: its size is unknown, so the commit rule (when on) refuses it.
    if (!cap) return { room: n ? 0 : Infinity, fits: n === 0 && withinCommit(h, need.memory_mib, cfg) };
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
    return { room: mem - cfg.reserve_mib, fits: withinCommit(h, need.memory_mib, cfg) && (n === 0 || (underCap && mem >= cfg.reserve_mib)) };
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
  /** The on-demand order (cheapest first); absent: `instance_types`. */
  on_demand_types?: readonly string[];
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
  | { launch: null; why: "pending" | "at_max" };

/**
 * A host of one kind is needed and none can take the work: launch one, unless one of that kind was
 * launched and hasn't enrolled (`pending`; one still in flight is the caller's to skip), or the kind
 * is at `max_hosts` (`live`: its active and STONITH-pending hosts; a draining one doesn't count). The
 * attempts, one pass: each instance type on spot in `instance_types` order, then each on demand in
 * `on_demand_types` order, cheapest first (zones rotating with the second). The caller stops at the
 * first launch, at a spent quota, or at an error that isn't EC2 having no room; a pass where nothing
 * had room starts FleetDO's backoff for the kind (`noRoomBackoffMs`).
 */
export function scaleUpPlan(s: ScaleSettings, live: number, pending: number, nowMs: number): ScaleUp {
  if (pending > 0) return { launch: null, why: "pending" };
  if (live >= s.max_hosts) return { launch: null, why: "at_max" };
  const zone = (i: number) => s.subnet_ids[(Math.floor(nowMs / 1000) + i) % s.subnet_ids.length]!;
  return {
    launch: [
      ...(s.spot ? s.instance_types.map((type, i) => ({ type, subnet: zone(i), spot: true })) : []),
      ...(s.on_demand_types ?? s.instance_types).map((type, i) => ({ type, subnet: zone(i), spot: false })),
    ],
  };
}

/** The first wait after a pass where nothing had room; the cap for sandbox hosts and for brain hosts. */
export const NO_ROOM_BACKOFF_FIRST_MS = 60_000;
export const NO_ROOM_BACKOFF_MAX_MS = 15 * 60_000;
/** Brain hosts: under FleetDO's brain-waiter TTL (12 min), so a waiting brain sees a pass before it lapses. */
export const NO_ROOM_BACKOFF_BRAIN_MAX_MS = 5 * 60_000;
/** A backoff that lapsed this long ago is forgotten: the next pass with no room waits the first again. */
export const NO_ROOM_RESET_MS = 30 * 60_000;

/**
 * The wait after a pass with no room: the first, then doubling to `maxMs`, from the previous backoff
 * (`{until_ms, wait_ms}`), which counts only if it lapsed within `NO_ROOM_RESET_MS` of `nowMs`.
 */
export function noRoomBackoffMs(previous: { until_ms: number; wait_ms: number } | null, nowMs: number, maxMs = NO_ROOM_BACKOFF_MAX_MS): number {
  if (!previous || nowMs - previous.until_ms > NO_ROOM_RESET_MS) return Math.min(NO_ROOM_BACKOFF_FIRST_MS, maxMs);
  return Math.min(maxMs, previous.wait_ms * 2);
}

/** `busy` clears the clock, `start` starts it, `retire`: idle for the whole grace. */
export type IdleStep = "busy" | "start" | "wait" | "retire";

/** A launched host's idle clock (`idleSince`: when it started). */
export function idleStep(busy: boolean, idleSince: number | null, nowMs: number, graceMs: number): IdleStep {
  if (busy) return "busy";
  if (idleSince === null) return "start";
  return nowMs - idleSince >= graceMs ? "retire" : "wait";
}
