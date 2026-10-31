// An agent's brain lifecycle, as decisions (docs/control-plane/durable-objects/agent/, "Brain
// lifecycle"; design rules 2-4 and the model's brain rows, docs/verification/agent-brain/). Pure
// functions over the brain record's fields: each returns what changes (a patch) and what follows.
// AgentDO sequences the awaits (FleetDO, R2, the broker) and applies each patch in one synchronous
// step with the deadlines it arms; the rules live here.

import { type AgentExitReason } from "../protocol/control";
import { AgentLifecycle, type AgentState } from "../protocol/model";

/**
 * A brain start AgentDO issued: its host and agent epoch. `starting` until its session's hello,
 * then `live`; `condemned` once AgentDO wants it gone (none of its sessions is current from then
 * on), with the kill command FleetDO stored for it and when (absent while the kill is owed).
 */
export type Brain =
  | { phase: "starting" | "live"; host: string; epoch: number; since_ms: number }
  | { phase: "condemned"; host: string; epoch: number; since_ms: number; kill?: { cmd: string; ms: number } };

/** Who wanted a start. */
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
   * The agent epoch: bumped by every `agent_start` (never reused), unrelated to the sandbox's epoch.
   * The brain presents it in its session hello; platform tool calls and asks are keyed by it and
   * events filtered by it. Rows stored before it existed carry the sandbox epoch the brain was
   * started with, which is where `load()` starts the counter.
   */
  agent_epoch: number;
  /**
   * The one brain this agent has, if any: the only authority for where it runs (see the brain
   * lifecycle section). Cleared only by its release (its exit at its epoch or later, or its host's
   * loss).
   */
  brain: Brain | null;
  /** The start someone wants (an operator, a wake, a drain, a retry): the only stored start request. */
  intent: StartIntent | null;
  /** The host the last released brain ran on: preferred for the next start while healthy (a warm session). */
  prev_host?: string;
  /** AgentDO's part of `state` (the brain's lifecycle), written only by AgentDO's own transitions. */
  lifecycle: AgentLifecycle;
  /**
   * The runner's part of `state`: what it last reported its brain doing (null: nothing since the
   * brain started, or no brain). Counts only while `lifecycle` is `ready` (`agentState`).
   */
  activity: AgentState | null;
  /** Retried refusals of the current start (`startFailure`); reset by a hello or a wake. */
  start_attempts: number;
  /** Restarts after an exit since the last completed turn (crash-loop guard). */
  exit_restarts?: number;
  /** Consecutive starts condemned for want of a hello (backs off the `starting` deadline). */
  start_timeouts?: number;
  /**
   * Consecutive runs of the intent that found no brain host with room (backs off their retry:
   * `capacityRetryMs`). Not the crash-loop guard's: waiting for capacity is not a crash. Goes with
   * the intent (`NO_INTENT`).
   */
  capacity_waits?: number;
  /**
   * The agent epoch when an operator last stopped it. One rule: a brain at or below it is stopped,
   * so however it ends (its exit, a failed send or refusal of its start, its host's loss or drain,
   * a start or session deadline) it restarts nothing; only a start, new input or a sandbox move
   * after the stop starts the agent again (`stoppedBrain`). Absent: never stopped (or stored by a
   * release before it, which keeps the field without reading it).
   */
  stop_epoch?: number;
  /**
   * Set by an operator's stop, cleared by the next input from outside the agent (a turn, an inbox
   * message, a delivery merged into a queued turn; never the platform's own `system` notes). It
   * quiets wakes only while no start has been issued since the stop (`quietSinceStop`): then
   * nothing that predates the stop wakes the agent (a release, a sandbox move, a wake alarm), and a
   * stopped brain's end wakes it only for input that came after the stop (`wake`, `release`).
   * Derived from the epochs too, so a flag a previous release left set after its own start heals.
   */
  stop_quiet?: boolean;
}

/** What a decision changes in the record (`undefined` removes an optional field). */
export type BrainPatch = Partial<BrainFields>;

/**
 * Which exits restart the brain at once when work is waiting. A `Record` over every member, so a
 * new exit reason doesn't compile until it has a decision here.
 */
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
/** Whether the brain at agent epoch `epoch` is one an operator stopped (see `stop_epoch`). */
export const stoppedBrain = (s: Pick<BrainFields, "stop_epoch">, epoch: number) => (s.stop_epoch ?? -1) >= epoch;
/** Stopped with no outside input and no start since (see `stop_quiet`). */
export const quietSinceStop = (s: Pick<BrainFields, "stop_quiet" | "stop_epoch" | "agent_epoch">) =>
  !!s.stop_quiet && (s.stop_epoch ?? -1) >= s.agent_epoch;
/** How a brain at `epoch` ended: `stopped` if an operator stopped it, whatever ended it. */
const endedAs = (s: BrainFields, epoch: number, reason: AgentExitReason): AgentExitReason =>
  stoppedBrain(s, epoch) ? "stopped" : reason;
/** An end the crash-loop guard counts: one that restarts, other than going idle. */
const counted = (ended: AgentExitReason) => RESTART_ON_EXIT[ended] && ended !== "idle";
const crashCount = (s: BrainFields): BrainPatch => ({ exit_restarts: (s.exit_restarts ?? 0) + 1 });

/** An agent's one-word state: AgentDO's lifecycle, or while a brain runs, what its runner reports. */
export function agentState(s: Pick<BrainFields, "lifecycle" | "activity">): AgentState {
  return s.lifecycle === "ready" ? s.activity ?? "ready" : s.lifecycle;
}

/** The two parts of a `state` stored alone (by the previous release): the inverse of `agentState`. */
export function splitState(state: AgentState): Pick<BrainFields, "lifecycle" | "activity"> {
  const own = AgentLifecycle.safeParse(state);
  if (own.success && own.data !== "ready") return { lifecycle: own.data, activity: null };
  return { lifecycle: "ready", activity: state === "ready" ? null : state };
}

/**
 * A start request merged into the intent: the newer request's fields win, the stronger reason stays
 * (N15: a plain start never downgrades an explicit restart), and a host it avoids is never also
 * the hint.
 */
export function mergeIntent(cur: StartIntent | null, patch: StartIntent): StartIntent {
  const next: StartIntent = { ...(cur ?? {}), ...patch };
  if (cur && INTENT_RANK[cur.reason] > INTENT_RANK[patch.reason]) next.reason = cur.reason;
  if (patch.avoid && next.host_hint === patch.avoid) delete next.host_hint;
  if (patch.host_hint && next.avoid === patch.host_hint) delete next.avoid;
  return next;
}

/**
 * The intent meets a brain that isn't condemned (no same-host re-issue): it moves (another hint,
 * its host avoided, or its host no longer healthy: draining, expired, lost or wedged, N19) or
 * restarts (an operator's explicit restart) by condemning it with the intent kept. Otherwise an
 * operator's intent stays, so it runs after this brain exits (N14: a graceful stop's `stopped`
 * exit), and any other is dropped. A start without a hint never moves a healthy brain.
 */
export function liveBrainStart(intent: StartIntent, b: Brain, healthy: boolean): "condemn" | "keep" | "drop" {
  if (moves(intent, b.host) || intent.reason === "restart" || !healthy) return "condemn";
  return intent.reason === "operator" ? "keep" : "drop";
}

/** What carries on after a release: the intent, a wake for waiting work (counted or not), or nothing. */
export type AfterRelease = "intent" | "wake" | "wake_after_exit" | null;

/**
 * The release of the brain on `host` (design rule 3) for an exit at `epoch` or a host's loss, or
 * null if that doesn't match the record (another host, or an older start). A stopped brain ends as
 * `stopped` whatever ended it: no wake, no crash count, unless input arrived after the stop (an
 * uncounted wake). A condemned brain's exit reason describes its kill, not the brain: its end was
 * decided by its condemn, whose cause kept an intent or woke if a start is wanted, so its release
 * restarts nothing of its own and isn't counted again. An operator's start kept while this brain
 * ran (N14) is for after a graceful stop: any other end of a brain that wasn't condemned drops it
 * (N20); a move and a condemned brain's intent always run. `errored` stays while nothing will
 * start a brain.
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
 * A brain that went unresponsive: no hello within the `starting` deadline, or a live brain with no
 * session for `NO_SESSION_MS`. It is condemned either way; unless an operator stopped it, the end
 * is counted by the crash-loop guard (a start that never connected also backs off the next
 * deadline and is `errored` until a wake starts another) and waiting work wakes it.
 */
export function unresponsive(s: BrainFields, b: Brain, kind: "starting" | "no_session"): { patch: BrainPatch; wake: boolean } {
  if (stoppedBrain(s, b.epoch)) return { patch: {}, wake: false };
  const patch: BrainPatch = kind === "starting"
    ? { ...crashCount(s), lifecycle: "errored", start_timeouts: (s.start_timeouts ?? 0) + 1 }
    : crashCount(s);
  return { patch, wake: true };
}

/**
 * An exit without an agent epoch from the host of a brain that isn't condemned: it proves nothing
 * about which start it was, so the brain is condemned (escalation proves it gone), counted as its
 * end would be, and woken as that end would wake it (`afterExit`: through the crash-loop guard).
 */
export function epochlessExit(s: BrainFields, b: Brain, reason: AgentExitReason): { patch: BrainPatch; wake: boolean; afterExit: boolean } {
  const ended = endedAs(s, b.epoch, reason);
  const c = counted(ended);
  return { patch: c ? crashCount(s) : {}, wake: RESTART_ON_EXIT[ended], afterExit: c };
}

/**
 * The start at `epoch` was refused. Always condemned (its own exit is owed, A4); a retryable refusal
 * is retried (a `retry` intent) up to `MAX_START_ATTEMPTS` times, and anything else with no start
 * wanted ends `errored`, unless an operator stopped it (then it's not an error).
 */
export function startFailure(s: BrainFields, epoch: number, retryable: boolean): { patch: BrainPatch; retry: boolean } {
  const stopped = stoppedBrain(s, epoch);
  const retry = !stopped && !s.intent && retryable && s.start_attempts < MAX_START_ATTEMPTS;
  if (retry) return { patch: { start_attempts: s.start_attempts + 1, intent: { reason: "retry" } }, retry };
  return { patch: !s.intent && !stopped ? { lifecycle: "errored" } : {}, retry };
}

/**
 * Whether waiting work starts a brain now: not while one runs (a condemned one's intent waits for
 * its release), not for work that predates a stop, and through the crash-loop guard after an exit
 * (`afterExit`; exits are counted where they happen, once): past `MAX_EXIT_RESTARTS`, `errored`
 * until new input. New input always gets a fresh try.
 */
export function wakeDecision(s: BrainFields, hasWork: boolean, afterExit: boolean): "none" | "errored" | "start" {
  if (s.brain && s.brain.phase !== "condemned") return "none";
  if (quietSinceStop(s) || !hasWork) return "none";
  if (afterExit && (s.exit_restarts ?? 0) > MAX_EXIT_RESTARTS) return "errored";
  return "start";
}

/** What a condemned brain's escalation found, with its kill stored on a current host (design rule 4). */
export interface KillProgress {
  /** The host processed the kill. */
  processed: boolean;
  /** FleetDO's index still has a start at or below the brain's epoch on that host. */
  indexed: boolean;
  /** The host processed some command since the kill was stored (or nothing older is pending there). */
  host_processing: boolean;
}

/**
 * The brain is gone once its kill was processed and no start of it is indexed there (`release`).
 * A host that processed nothing at all for `exitWaitMs` since the kill is wedged (`stuck`); one
 * still working through older commands is wedged only past `capMs`. Otherwise, check again.
 */
export function escalation(p: KillProgress, ageMs: number, exitWaitMs: number, capMs: number): "release" | "stuck" | "cap" | "recheck" {
  if (p.processed && !p.indexed) return "release";
  if (!p.processed && !p.host_processing && ageMs >= exitWaitMs) return "stuck";
  return ageMs >= capMs ? "cap" : "recheck";
}

/** The phase deadlines a brain record keeps: when each fires, or null for none. */
export type PhaseDeadline = "starting" | "no_session" | "condemned";

/**
 * Each phase carries its own continuation (amendment A1), armed in the step that enters it: a
 * starting brain its start deadline, a live one without a session its session deadline, a
 * condemned one its escalation (now: its kill is owed); a released one none.
 */
export function phaseDeadlines(b: Brain | null, now: number, startMs: number, noSessionMs: number, connected: boolean):
  Record<PhaseDeadline, number | null> {
  return {
    starting: b?.phase === "starting" ? now + startMs : null,
    no_session: b?.phase === "live" && !connected ? now + noSessionMs : null,
    condemned: b?.phase === "condemned" ? now : null,
  };
}
