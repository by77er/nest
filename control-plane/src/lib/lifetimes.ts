// Agent and sandbox lifetimes as pure decisions (docs/agents/#lifetimes,
// docs/control-plane/durable-objects/sandbox/#lifetime): who may stop whom, when an ephemeral agent
// is done, how spawn limits and idle TTLs narrow, and when a dormant sandbox is noticed and destroyed.
// AgentDO and SandboxDO sequence the awaits and apply each decision in one synchronous step.
import { type Env, num } from "../env";
import { awsCell } from "./cells";
import type { SandboxState } from "../protocol/model";

/** Why an agent ended for good. */
export type EndReason = "stopped" | "exited" | "done" | "owner_ended";

/**
 * An agent stopped for good (`agent_stop`, `exit`, an ephemeral agent's end, its owner's end, or the
 * operator's `stop {end: true}`): it takes no more turns or starts. The steps after it are recorded as
 * they finish, so the `end` deadline resumes where a reset left it.
 */
export interface Ended {
  ms: number;
  /** Who ended it: an agent id (itself, an owner), a client id (`cli_…`), or `user`. */
  by: string;
  reason: EndReason;
  /** Its brain is killed (condemned) rather than left to finish its turn. */
  kill: boolean;
  /** Destroy its sandbox, when no other agent is attached and `endMayDestroy` (an ephemeral agent's always asks). */
  destroy_sandbox: boolean;
  /**
   * Its ender asked for `destroy_sandbox` itself (not only the ephemeral default): only then does the ender's
   * authority count (`endMayDestroy`'s `by`). Absent (and on ends from before it): only a sandbox made for it.
   */
  destroy_asked?: true;
  /** The stopper's words (`reason` of `agent_stop` or `exit`), shown in its `exited` event. */
  note?: string;
  /** The graceful `agent_stop` went out for the brain at this epoch. */
  stop_sent?: number;
  /** What became of its sandbox: `destroyed`, `detached` (kept: another agent is attached, or neither it nor its ender may destroy it, or not asked). */
  sandbox?: "destroyed" | "detached";
  /** Its owner was told (`childEnded`). */
  owner_told?: boolean;
  /** Every step finished: its records are pruned `AGENT_RECORD_RETENTION_MS` after `ms`. */
  done_ms?: number;
}

/** An ended agent's records (AgentDO storage, its R2 session segments) go this long after it ended. */
export const AGENT_RECORD_RETENTION_MS = 30 * 86_400_000;
/** An unfinished end's steps are tried again this often (a release re-arms it at once). */
export const END_RETRY_MS = 60_000;
/** A graceful end (`exit`, an ephemeral agent's) whose turn hasn't finished this long after it is killed instead. */
export const END_GRACE_MS = 15 * 60_000;
/** An agent spawned by an agent is one deeper than its spawner; the operator's are at depth 0. Stands in for budgets. */
export const MAX_SPAWN_DEPTH = 3;
/** Children an agent may have that haven't ended. Stands in for budgets' `concurrent`. */
export const MAX_LIVE_CHILDREN = 8;
/** An owner chain longer than this is refused (it can't be: depth is capped), so a walk is bounded. */
export const MAX_OWNER_HOPS = MAX_SPAWN_DEPTH + 1;
/** The shortest idle TTL a sandbox may be given. */
export const MIN_IDLE_TTL_MS = 60_000;
/**
 * The cell default idle TTL of a sandbox (`SANDBOX_IDLE_TTL_MS`, or the cell's `sandbox_idle_ttl_ms`): a day, so the
 * sandboxes of many short-lived agents don't pile up; one to keep gets its own TTL.
 */
export const DEFAULT_SANDBOX_IDLE_TTL_MS = 86_400_000;
/** A sandbox destroyed by an idle TTL longer than this is noticed (logged; the lifetimes view shows when) this long first. */
export const EXPIRY_NOTICE_MS = 86_400_000;
/** How often a live sandbox re-checks whether it is dormant, at most. */
export const EXPIRY_CHECK_MAX_MS = 3_600_000;
/**
 * Checks this far apart were missed (a rolled-back release ran meanwhile, which keeps but never
 * updates the dormancy clock): the clock starts again, so a missed wake can't shorten a TTL.
 */
export const EXPIRY_GAP_MS = 6 * EXPIRY_CHECK_MAX_MS;

/** The idle TTL a sandbox without its own gets in `cell`. */
export function cellIdleTtlMs(env: Pick<Env, "AWS_CELLS" | "SANDBOX_IDLE_TTL_MS">, cell: string): number {
  let own: number | undefined;
  try {
    own = awsCell(env.AWS_CELLS, cell)?.sandbox_idle_ttl_ms;
  } catch (e) {
    console.error(`AWS_CELLS doesn't parse; cell ${cell} gets the default sandbox idle TTL`, e);
  }
  return own ?? num(env.SANDBOX_IDLE_TTL_MS, DEFAULT_SANDBOX_IDLE_TTL_MS);
}

/**
 * The ownership grant (docs/agents/tools/#grants): creating an agent gives its creator every grant on
 * it, and on what it owns in turn. Recorded as the child's `owner` (the one deciding record; the
 * spawner's `children` table is an index). `chain` is the target's owner, that owner's owner, and so
 * on, as far as it was read; the caller holds the grant iff it appears in it.
 */
export function ownsVia(caller: string, chain: readonly (string | null)[]): boolean {
  return chain.slice(0, MAX_OWNER_HOPS).includes(caller);
}

/** `Ended.by` when the operator ended it (`POST /v1/agents/<id>/stop` with the admin token). */
export const OPERATOR_ENDER = "user";

/**
 * Whether ending `agent` with `destroy_sandbox` may destroy the sandbox `s` it is attached to (still only
 * once no other agent is attached; SandboxDO decides that in its step). Yes when the sandbox was made for
 * that agent (`owner`, from `agent_spawn{sandbox: new}`), or when its ender `by` may destroy it anyway:
 * the agent that owns it, the API client whose subtree it is in, or the operator, as
 * `DELETE /v1/sandboxes/<id>` authorizes the API callers. `by` absent (a caller of the previous release): only the first.
 */
export function endMayDestroy(s: { owner?: string; client?: string }, agent: string, by?: string): boolean {
  if (s.owner === agent) return true;
  if (by === undefined) return false;
  return by === OPERATOR_ENDER || s.owner === by || s.client === by;
}

/**
 * Whether a spawn by an agent at `depth` with `liveChildren` unended children may go ahead (null), or why
 * not: `full` when only the live children are in the way, so a spawn goes ahead once one ends (`at_capacity`);
 * the depth never changes (`forbidden`).
 */
export function spawnRefusal(depth: number, liveChildren: number): { message: string; full: boolean } | null {
  if (depth + 1 > MAX_SPAWN_DEPTH) return { message: `spawn depth ${depth + 1} is over the limit of ${MAX_SPAWN_DEPTH}`, full: false };
  if (liveChildren >= MAX_LIVE_CHILDREN) {
    return { message: `live children: it already has ${liveChildren} agents that haven't ended (at most ${MAX_LIVE_CHILDREN}); there is room once one ends`, full: true };
  }
  return null;
}

/**
 * An ephemeral agent is done when a turn completes with nothing waiting for it: no turn current or
 * queued (an unconfirmed inbox message is one by then), no open ask or approval (whose answer would be
 * its next turn), and no agent it spawned that hasn't ended (whose result would be). Background hands
 * tasks aren't waited for.
 */
export const ephemeralDone = (f: { ephemeral: boolean; ended: boolean; current: boolean; queued: boolean; openAsks: number; liveChildren: number }): boolean =>
  f.ephemeral && !f.ended && !f.current && !f.queued && f.openAsks === 0 && f.liveChildren === 0;

/** Narrowing only: the shortest of the given TTLs, else the fallback. */
export function narrowTtl(fallback: number, ...given: (number | undefined)[]): number {
  return Math.min(fallback, ...given.filter((t): t is number => t !== undefined));
}

/** States in which a placed sandbox has a VM up (or coming up, or going down). */
const VM_UP: readonly SandboxState[] = ["creating", "restoring", "running", "suspending"];

/** Dormant: no agent attached, no placement in flight, and no VM up (suspended, unplaced or failed); never once destroyed. */
export const dormant = (s: { state: SandboxState; host: string | null; placing: number | null; attached: readonly string[] }): boolean =>
  s.state !== "destroyed" && s.attached.length === 0 && s.placing === null && !(s.host !== null && VM_UP.includes(s.state));

/** What a sandbox's lifetime check sees. */
export interface ExpiryFacts {
  /** No agent attached and no VM up (suspended, unplaced or failed). */
  dormant: boolean;
  /** Since when it has been dormant (absent: not, as far as recorded). */
  since?: number;
  /** When the notice was given (absent: not yet). */
  noticed?: number;
  ttl: number;
  now: number;
}

export type ExpiryStep =
  | { kind: "awake"; at: number }
  | { kind: "wait"; since: number; at: number }
  | { kind: "notice"; since: number; destroy_at: number; at: number }
  | { kind: "destroy"; since: number };

/**
 * One lifetime check. A dormant sandbox is destroyed `ttl` after it became dormant; for a TTL over a
 * day the notice comes a day ahead, and destruction never comes less than a day after the notice (a
 * late check pushes it back rather than skip the warning). `at`: when to check next, at most an hour
 * on (so a missed transition is caught), and at the due time.
 */
export function expiryStep(f: ExpiryFacts): ExpiryStep {
  const every = Math.max(MIN_IDLE_TTL_MS / 4, Math.min(EXPIRY_CHECK_MAX_MS, Math.floor(f.ttl / 10)));
  if (!f.dormant) return { kind: "awake", at: f.now + every };
  const since = f.since ?? f.now;
  const due = since + f.ttl;
  const next = (t: number) => Math.min(t, f.now + every);
  if (f.ttl <= EXPIRY_NOTICE_MS) {
    return f.now >= due ? { kind: "destroy", since } : { kind: "wait", since, at: next(due) };
  }
  if (f.noticed === undefined) {
    if (f.now < due - EXPIRY_NOTICE_MS) return { kind: "wait", since, at: next(due - EXPIRY_NOTICE_MS) };
    const destroyAt = Math.max(due, f.now + EXPIRY_NOTICE_MS);
    return { kind: "notice", since, destroy_at: destroyAt, at: next(destroyAt) };
  }
  const destroyAt = Math.max(due, f.noticed + EXPIRY_NOTICE_MS);
  return f.now >= destroyAt ? { kind: "destroy", since } : { kind: "wait", since, at: next(destroyAt) };
}

/**
 * When `expiryStep` will destroy a dormant sandbox if nothing changes and its checks keep running
 * (each at its `at`); null while its dormancy clock hasn't started (the next check starts it). A
 * check missed for over `EXPIRY_GAP_MS` (`checked`: the last) restarts the clock and any notice, as
 * `checkExpiry` does, so the answer counts from `now`. For the operator's view, never a decision.
 */
export function destroyAtMs(f: Omit<ExpiryFacts, "dormant"> & { checked?: number }): number | null {
  // After a gap the clock restarts now, so any earlier notice is too early to matter.
  const gap = f.checked !== undefined && f.now - f.checked > EXPIRY_GAP_MS;
  const since = gap && f.since !== undefined ? f.now : f.since;
  if (since === undefined) return null;
  const due = since + f.ttl;
  if (f.ttl <= EXPIRY_NOTICE_MS) return due;
  // Not noticed yet: the notice comes at `due - EXPIRY_NOTICE_MS`, or at the next check if that is past.
  return Math.max(due, (f.noticed ?? Math.max(f.now, due - EXPIRY_NOTICE_MS)) + EXPIRY_NOTICE_MS);
}
