// An agent's brain lifecycle as pure decisions (docs/control-plane/durable-objects/agent/, "Brain
// lifecycle"; docs/verification/agent-brain/): each returns a patch and what follows. AgentDO
// sequences the awaits and applies each patch in one synchronous step with the deadlines it arms.

import { type AgentExitReason } from "../protocol/control";
import { AgentLifecycle, type AgentState } from "../protocol/model";

/** A brain start AgentDO issued. `condemned`: none of its sessions is current; `kill` once FleetDO stored it. */
export type Brain =
  | { phase: "starting" | "live"; host: string; epoch: number; since_ms: number }
  | { phase: "condemned"; host: string; epoch: number; since_ms: number; kill?: { cmd: string; ms: number } };

export type IntentReason = "operator" | "restart" | "wake" | "drain" | "retry";

/** A start someone wants: on a chosen host, or anywhere but a host going away. */
export interface StartIntent {
  host_hint?: string;
  avoid?: string;
  reason: IntentReason;
}

/** The fields of AgentDO's record the brain lifecycle owns. */
export interface BrainFields {
  /**
   * Bumped by every `agent_start`, never reused; sessions, platform calls and events are keyed by it.
   * A record from before it starts from the sandbox epoch its brain was started with (`load()`).
   */
  agent_epoch: number;
  /** The only authority for where the brain runs; cleared only by its release. */
  brain: Brain | null;
  /** The only stored start request. */
  intent: StartIntent | null;
  /** The last released brain's host: preferred for the next start while healthy (a warm session). */
  prev_host?: string;
  /** AgentDO's part of `state`, written only by its own transitions. */
  lifecycle: AgentLifecycle;
  /** The runner's last report (null: none since the brain started); counts only while `ready`. */
  activity: AgentState | null;
  /** Retried refusals of the current start; reset by a hello or a wake. */
  start_attempts: number;
  /** Restarts after an exit since the last completed turn (crash-loop guard). */
  exit_restarts?: number;
  /** Consecutive starts condemned for want of a hello (backs off the `starting` deadline). */
  start_timeouts?: number;
  /** Consecutive intent runs that found no brain host with room (`capacityRetryMs`); not a crash. Goes with the intent. */
  capacity_waits?: number;
  /**
   * The agent epoch of an operator's last stop: a brain at or below it restarts nothing however it
   * ends; only a start, input or sandbox move after the stop starts the agent again.
   */
  stop_epoch?: number;
  /**
   * Set by a stop, cleared by input from outside the agent (never the platform's `system` notes).
   * While no start has been issued since the stop, nothing older wakes the agent (`quietSinceStop`).
   */
  stop_quiet?: boolean;
}

/** What a decision changes in the record (`undefined` removes an optional field). */
export type BrainPatch = Partial<BrainFields>;

/** Which exits restart the brain when work is waiting (a `Record`: a new reason needs a decision). */
export const RESTART_ON_EXIT: Record<AgentExitReason, boolean> = {
  idle: true, crashed: true, fenced: true, host_lost: true, stopped: false, auth_failed: false, unknown: false,
};
/** Restarts after an exit without a turn completing in between, before giving up (`errored`). */
export const MAX_EXIT_RESTARTS = 3;
/** Retried refusals of one start before giving up (`errored`). */
export const MAX_START_ATTEMPTS = 3;
/** Which reason wins when two starts merge into one intent. */
const INTENT_RANK: Record<IntentReason, number> = { wake: 0, retry: 1, drain: 2, operator: 3, restart: 4 };

/** No start wanted: the intent and its capacity backoff go together. */
export const NO_INTENT = { intent: null, capacity_waits: undefined } as const satisfies BrainPatch;

/** Whether an intent moves a brain off `host` (another host named, or `host` avoided). */
export const moves = (intent: StartIntent, host: string) =>
  (intent.host_hint !== undefined && intent.host_hint !== host) || intent.avoid === host;
export const stoppedBrain = (s: Pick<BrainFields, "stop_epoch">, epoch: number) => (s.stop_epoch ?? -1) >= epoch;
/** Stopped with no outside input and no start since. */
export const quietSinceStop = (s: Pick<BrainFields, "stop_quiet" | "stop_epoch" | "agent_epoch">) =>
  !!s.stop_quiet && (s.stop_epoch ?? -1) >= s.agent_epoch;
/** A stopped brain ends as `stopped`, whatever ended it. */
const endedAs = (s: BrainFields, epoch: number, reason: AgentExitReason): AgentExitReason =>
  stoppedBrain(s, epoch) ? "stopped" : reason;
/** An end the crash-loop guard counts: one that restarts, other than going idle. */
const counted = (ended: AgentExitReason) => RESTART_ON_EXIT[ended] && ended !== "idle";
const crashCount = (s: BrainFields): BrainPatch => ({ exit_restarts: (s.exit_restarts ?? 0) + 1 });

/** An agent's one-word state: AgentDO's lifecycle, or while a brain runs, what its runner reports. */
export function agentState(s: Pick<BrainFields, "lifecycle" | "activity">): AgentState {
  return s.lifecycle === "ready" ? s.activity ?? "ready" : s.lifecycle;
}

/** `agentState`'s inverse, for a `state` the previous release stored alone. */
export function splitState(state: AgentState): Pick<BrainFields, "lifecycle" | "activity"> {
  const own = AgentLifecycle.safeParse(state);
  if (own.success && own.data !== "ready") return { lifecycle: own.data, activity: null };
  return { lifecycle: "ready", activity: state === "ready" ? null : state };
}

/** The newer request's fields win, the stronger reason stays (N15), and an avoided host is never the hint. */
export function mergeIntent(cur: StartIntent | null, patch: StartIntent): StartIntent {
  const next: StartIntent = { ...(cur ?? {}), ...patch };
  if (cur && INTENT_RANK[cur.reason] > INTENT_RANK[patch.reason]) next.reason = cur.reason;
  if (patch.avoid && next.host_hint === patch.avoid) delete next.host_hint;
  if (patch.host_hint && next.avoid === patch.host_hint) delete next.avoid;
  return next;
}

/**
 * The intent meets a brain that isn't condemned (never re-issued on its host): a move, a restart or
 * an unhealthy host (N19) condemns it with the intent kept; an operator's start waits for its exit
 * (N14); any other is dropped. A start without a hint never moves a healthy brain.
 */
export function liveBrainStart(intent: StartIntent, b: Brain, healthy: boolean): "condemn" | "keep" | "drop" {
  if (moves(intent, b.host) || intent.reason === "restart" || !healthy) return "condemn";
  return intent.reason === "operator" ? "keep" : "drop";
}

/** What carries on after a release: the intent, a wake for waiting work (counted or not), or nothing. */
export type AfterRelease = "intent" | "wake" | "wake_after_exit" | null;

/**
 * The release of the brain on `host` (design rule 3) at `epoch` or later, or null if the record holds
 * another. A stopped brain wakes (uncounted) only for input after the stop. A condemned brain's end
 * was decided by its condemn, so it restarts and counts nothing of its own. An operator's kept start
 * (N14) survives only a `stopped` end or a move (N20). `errored` stays while nothing will start.
 */
export function brainRelease(s: BrainFields, host: string, epoch: number, reason: AgentExitReason, hasWork: boolean):
  { patch: BrainPatch; wakes: boolean; next: AfterRelease } | null {
  const b = s.brain;
  if (!b || b.host !== host || epoch < b.epoch) return null;
  const condemned = b.phase === "condemned";
  const ended = endedAs(s, b.epoch, reason);
  const restarts = !condemned && counted(ended);
  const wakes = (!condemned && RESTART_ON_EXIT[ended]) || (stoppedBrain(s, b.epoch) && !quietSinceStop(s));
  const dropIntent = s.intent?.reason === "operator" && !condemned && ended !== "stopped" && !moves(s.intent, b.host);
  const intent = dropIntent ? null : s.intent;
  const patch: BrainPatch = {
    brain: null,
    prev_host: b.host,
    activity: null,
    ...(restarts ? crashCount(s) : {}),
    ...(dropIntent ? NO_INTENT : {}),
    ...(s.lifecycle !== "errored" || intent || wakes ? { lifecycle: "detached" as const } : {}),
  };
  const next: AfterRelease = intent ? "intent" : hasWork && wakes ? (restarts ? "wake_after_exit" : "wake") : null;
  return { patch, wakes, next };
}

/**
 * No hello within the `starting` deadline, or a live brain without a session for `NO_SESSION_MS`:
 * condemned; unless stopped, counted and woken (a start that never connected also backs off and is
 * `errored` until a wake).
 */
export function unresponsive(s: BrainFields, b: Brain, kind: "starting" | "no_session"): { patch: BrainPatch; wake: boolean } {
  if (stoppedBrain(s, b.epoch)) return { patch: {}, wake: false };
  const patch: BrainPatch = kind === "starting"
    ? { ...crashCount(s), lifecycle: "errored", start_timeouts: (s.start_timeouts ?? 0) + 1 }
    : crashCount(s);
  return { patch, wake: true };
}

/** An exit without an agent epoch proves nothing about which start it was: condemned, counted and woken as that end would be. */
export function epochlessExit(s: BrainFields, b: Brain, reason: AgentExitReason): { patch: BrainPatch; wake: boolean; afterExit: boolean } {
  const ended = endedAs(s, b.epoch, reason);
  const c = counted(ended);
  return { patch: c ? crashCount(s) : {}, wake: RESTART_ON_EXIT[ended], afterExit: c };
}

/**
 * The start at `epoch` was refused (always condemned: its exit is owed, A4). A retryable refusal is
 * retried up to `MAX_START_ATTEMPTS` times; otherwise, with no start wanted and no stop, `errored`.
 */
export function startFailure(s: BrainFields, epoch: number, retryable: boolean): { patch: BrainPatch; retry: boolean } {
  const stopped = stoppedBrain(s, epoch);
  const retry = !stopped && !s.intent && retryable && s.start_attempts < MAX_START_ATTEMPTS;
  if (retry) return { patch: { start_attempts: s.start_attempts + 1, intent: { reason: "retry" } }, retry };
  return { patch: !s.intent && !stopped ? { lifecycle: "errored" } : {}, retry };
}

/**
 * Whether waiting work starts a brain: not while one runs (a condemned one's intent waits), not for
 * work from before a stop, and after an exit (`afterExit`) only within `MAX_EXIT_RESTARTS`.
 */
export function wakeDecision(s: BrainFields, hasWork: boolean, afterExit: boolean): "none" | "errored" | "start" {
  if (s.brain && s.brain.phase !== "condemned") return "none";
  if (quietSinceStop(s) || !hasWork) return "none";
  if (afterExit && (s.exit_restarts ?? 0) > MAX_EXIT_RESTARTS) return "errored";
  return "start";
}

/** What a condemned brain's escalation found on a current host (design rule 4). */
export interface KillProgress {
  processed: boolean;
  /** FleetDO's index still has a start at or below the brain's epoch on that host. */
  indexed: boolean;
  /** The host processed some command since the kill was stored (or nothing older is pending there). */
  host_processing: boolean;
}

/**
 * Gone once the kill was processed and nothing is indexed. A host that processed nothing for
 * `exitWaitMs` since the kill is wedged (`stuck`); one still working through older commands, past `capMs`.
 */
export function escalation(p: KillProgress, ageMs: number, exitWaitMs: number, capMs: number): "release" | "stuck" | "cap" | "recheck" {
  if (p.processed && !p.indexed) return "release";
  if (!p.processed && !p.host_processing && ageMs >= exitWaitMs) return "stuck";
  return ageMs >= capMs ? "cap" : "recheck";
}

export type PhaseDeadline = "starting" | "no_session" | "condemned";

/** Each phase's continuation (A1), armed in the step that enters it; null: none. */
export function phaseDeadlines(b: Brain | null, now: number, startMs: number, noSessionMs: number, connected: boolean):
  Record<PhaseDeadline, number | null> {
  return {
    starting: b?.phase === "starting" ? now + startMs : null,
    no_session: b?.phase === "live" && !connected ? now + noSessionMs : null,
    condemned: b?.phase === "condemned" ? now : null,
  };
}
