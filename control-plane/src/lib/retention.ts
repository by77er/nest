// Generation retention as pure decisions (docs/sandbox/state/#restore-sources, #retention). The one
// predicate, `isRestoreSource`, answers both "may this be loaded" and "may this stop being a GC root";
// `retention` decides which ready generations to mark `deleting`; `gcRootsOf` says which manifests GC
// keeps. SandboxDO reads its rows, calls these and writes the answer in one synchronous step.
import type { Env } from "../env";
import { gone } from "./sandbox-lease";
import type { SandboxState } from "../protocol/model";

/**
 * `SANDBOX_RETENTION`: `on` (the default) marks generations `deleting` and marks the memory of
 * checkpoints that are no longer restore sources unrooted; `off`, an emergency stop, marks nothing more.
 * Both marks are durable and one-way, and GC's roots follow them in either mode, so switching off never
 * roots again what a sweep may already have taken.
 */
export type RetentionMode = "off" | "on";
export const RETENTION_MODES: readonly RetentionMode[] = ["off", "on"];
export const DEFAULT_RETENTION_MODE: RetentionMode = "on";

export function retentionMode(env: Pick<Env, "SANDBOX_RETENTION">): RetentionMode {
  const v = env.SANDBOX_RETENTION;
  if (v === undefined || v === "") return DEFAULT_RETENTION_MODE;
  if ((RETENTION_MODES as readonly string[]).includes(v)) return v as RetentionMode;
  console.error(`SANDBOX_RETENTION=${v} is not one of ${RETENTION_MODES.join("|")}; using ${DEFAULT_RETENTION_MODE}`);
  return DEFAULT_RETENTION_MODE;
}

/** An orphaned sibling's head is a restore source this long after it was committed ("like other parked work"). */
export const ORPHAN_HEAD_TTL_MS = 30 * 86_400_000;
/** Turn ends: the newest this many are kept whatever their age. */
export const TURN_END_KEEP_MIN = 20;
/** Turn ends: up to this many of the newest are kept while younger than `TURN_END_MAX_AGE_MS`. */
export const TURN_END_KEEP_MAX = 200;
export const TURN_END_MAX_AGE_MS = 7 * 86_400_000;
/**
 * The age tiers (SPACE's: each tier keeps its newest `keep` slots, tiers overlap). A slot is a
 * wall-clock interval of `spacing`, aligned to the Unix epoch, so every tier's slots nest in the next
 * one's; a slot is represented by its newest generation.
 */
export const TIERS: readonly { spacing: number; keep: number }[] = [
  { spacing: 60_000, keep: 5 },
  { spacing: 5 * 60_000, keep: 1 },
  { spacing: 10 * 60_000, keep: 6 },
  { spacing: 3_600_000, keep: 6 },
  { spacing: 6 * 3_600_000, keep: 4 },
];

/** What retention reads of a `generations` row. */
export interface GenRow {
  id: string;
  /** The parent named by the commit (an orphan's may be another orphan). */
  parent: string | null;
  orphaned: boolean;
  reason: string;
  created_ms: number;
  /** `state = 'deleting'`: one-way. */
  deleting: boolean;
}

/** A row with its manifests, for `gcRootsOf`. */
export interface RootRow extends GenRow {
  disk_manifest: string;
  mem_manifest?: string;
  /** Its memory was marked unrooted (`mem_unrooted_ms`): one-way, like `deleting`. */
  mem_unrooted: boolean;
}

/** An in-flight claim's pin: the generation a placement at `epoch` restores (`SandboxInfo.restore_pin`). */
export interface Pin {
  generation: string;
  epoch: number;
}

/** What the predicate reads besides the generation itself. */
export interface ChainView {
  head: string | null;
  /** Generations pinned by an in-flight resume, fork or restore claim. */
  pins: ReadonlySet<string>;
  /** Every generation an orphan names as its parent, `deleting` ones' included: such a generation isn't an orphan branch's head. */
  orphanParents: ReadonlySet<string>;
  now: number;
}

export function chainView(
  head: string | null, pins: Iterable<string>, orphanParents: Iterable<string>, now: number,
): ChainView {
  return { head, pins: new Set(pins), orphanParents: new Set(orphanParents), now };
}

/**
 * **The one predicate** (docs/sandbox/state/#restore-sources): `g` is ready and is, by id, the head, a
 * pinned generation, or the head of an orphaned sibling branch that hasn't expired. Resume and
 * placement load only a restore source; retention never marks one `deleting`; GC roots its memory only
 * while it is one. Ids, never timestamps, except an orphan head's expiry.
 */
export function isRestoreSource(g: GenRow, v: ChainView): boolean {
  if (g.deleting) return false;
  if (g.id === v.head) return true;
  if (v.pins.has(g.id)) return true;
  return g.orphaned && !v.orphanParents.has(g.id) && v.now < g.created_ms + ORPHAN_HEAD_TTL_MS;
}

/**
 * The live pins of a sandbox's record. A placement's claim pins the head it restores, in the step
 * that claims the epoch; the pin lasts while that epoch is being placed or its VM is being created
 * or restored, and ends when the sandbox runs, suspends, fails, is destroyed, or a newer epoch is
 * claimed (an older epoch's restore is fenced before the newer lease is granted).
 */
export function livePins(info: {
  restore_pin?: Pin | null; epoch: number; placing: number | null; host: string | null; state: SandboxState;
}): string[] {
  const p = info.restore_pin;
  if (!p || p.epoch !== info.epoch || gone(info.state)) return [];
  const placing = info.placing === p.epoch;
  const restoring = info.host !== null && (info.state === "creating" || info.state === "restoring");
  return placing || restoring ? [p.generation] : [];
}

export type KeepReason = "restore_source" | "turn_end" | "tier";

export interface RetentionDecision {
  /** Why each kept ready generation is kept (the first reason that applies). */
  kept: Map<string, KeepReason>;
  /** Ready generations to mark `deleting`, oldest first. */
  drop: string[];
}

/** Newest first: `created_ms`, then id (ids are random; a total order is all that matters). */
const newestFirst = (a: GenRow, b: GenRow) => b.created_ms - a.created_ms || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/**
 * Retention (docs/sandbox/state/#retention): restore sources always; turn ends, the newest
 * `TURN_END_KEEP_MIN` always and up to `TURN_END_KEEP_MAX` while younger than `TURN_END_MAX_AGE_MS`;
 * the main chain's generations (turn ends included) thinned by the age tiers; an orphan only while it
 * is a restore source (its branch's head, 30 days). Everything else ready is dropped.
 *
 * It reads ready rows only and is stable: dropping what it drops changes nothing it keeps, and a
 * generation it doesn't keep is never kept later (new generations only add newer slots and ranks), so
 * running it again marks nothing more until something new is committed or time passes.
 */
export function retention(rows: readonly GenRow[], v: ChainView): RetentionDecision {
  const ready = rows.filter((g) => !g.deleting);
  const kept = new Map<string, KeepReason>();
  const keep = (g: GenRow, why: KeepReason) => {
    if (!kept.has(g.id)) kept.set(g.id, why);
  };
  for (const g of ready) if (isRestoreSource(g, v)) keep(g, "restore_source");
  const main = ready.filter((g) => !g.orphaned).sort(newestFirst);
  let rank = 0;
  for (const g of main) {
    if (g.reason !== "turn_end") continue;
    if (rank < TURN_END_KEEP_MIN || (rank < TURN_END_KEEP_MAX && v.now - g.created_ms < TURN_END_MAX_AGE_MS)) keep(g, "turn_end");
    rank += 1;
  }
  for (const { spacing, keep: n } of TIERS) {
    // `main` is newest first, so a slot's first generation is its newest.
    let slots = 0;
    let last: number | null = null;
    for (const g of main) {
      const slot = Math.floor(g.created_ms / spacing);
      if (slot === last) continue;
      last = slot;
      if (slots++ >= n) break;
      keep(g, "tier");
    }
  }
  const drop = ready.filter((g) => !kept.has(g.id)).sort((a, b) => -newestFirst(a, b)).map((g) => g.id);
  return { kept, drop };
}

/**
 * The ready checkpoints whose memory retention (`on`) marks unrooted: no longer restore sources, so
 * nothing will load their memory again (the restore rule loads memory only with its own head, and a
 * generation that stops being a restore source never becomes one again). Oldest first.
 */
export function memoryToUnroot(rows: readonly RootRow[], v: ChainView): string[] {
  return rows.filter((g) => !g.deleting && g.mem_manifest && !g.mem_unrooted && !isRestoreSource(g, v))
    .sort((a, b) => -newestFirst(a, b)).map((g) => g.id);
}

/**
 * The manifests GC must keep for one live sandbox: every ready generation's disk manifest, and its
 * memory manifest unless it was marked unrooted. `deleting` generations: none. It reads only durable
 * marks, never the mode or the clock, so a mode switch or a rollback of the switch roots nothing again.
 */
export function gcRootsOf(rows: readonly RootRow[]): string[] {
  const roots = new Set<string>();
  for (const g of rows) {
    if (g.deleting) continue;
    roots.add(g.disk_manifest);
    if (g.mem_manifest && !g.mem_unrooted) roots.add(g.mem_manifest);
  }
  return [...roots];
}
