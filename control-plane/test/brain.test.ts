// The brain lifecycle's decisions (lib/brain.ts), against the AgentDO README's "Brain lifecycle"
// rules: what an end counts, wakes and leaves behind. The DO tests (agent-seams, brain-hosts,
// host-events) check the same rules through AgentDO's handlers.
import { describe, expect, it } from "vitest";
import {
  agentState, type Brain, brainRelease, type BrainFields, epochlessExit, escalation, liveBrainStart, MAX_EXIT_RESTARTS, MAX_START_ATTEMPTS,
  mergeIntent, phaseDeadlines, splitState, startFailure, type StartIntent, unresponsive, wakeDecision,
} from "../src/lib/brain";
import { AGENT_EXIT_REASONS, type AgentExitReason } from "../src/protocol/control";
import { AgentState } from "../src/protocol/model";

const live = (epoch = 2, host = "h1"): Brain => ({ phase: "live", host, epoch, since_ms: 0 });
const condemned = (epoch = 2, host = "h1"): Brain => ({ phase: "condemned", host, epoch, since_ms: 0 });
const rec = (over: Partial<BrainFields> = {}): BrainFields => ({
  agent_epoch: 2, brain: live(), intent: null, lifecycle: "ready", activity: "working", start_attempts: 0, ...over,
});
/** Stopped by an operator at the brain's epoch, with input since (not quiet) or without (quiet). */
const stopped = (quiet: boolean): Partial<BrainFields> => ({ stop_epoch: 2, ...(quiet ? { stop_quiet: true } : {}) });

/**
 * The README's crash-loop guard: which exits of a brain that ended on its own restart it when work
 * waits, and which of those count. A `Record`, so a new exit reason fails to compile here too.
 */
const EXIT: Record<AgentExitReason, { restarts: boolean; counted: boolean }> = {
  idle: { restarts: true, counted: false },
  crashed: { restarts: true, counted: true },
  fenced: { restarts: true, counted: true },
  host_lost: { restarts: true, counted: true },
  stopped: { restarts: false, counted: false },
  auth_failed: { restarts: false, counted: false },
  unknown: { restarts: false, counted: false },
};

describe("brainRelease", () => {
  it("releases only the brain on that host at or below the exit's epoch", () => {
    expect(brainRelease(rec(), "h2", 2, "crashed", true)).toBeNull();
    expect(brainRelease(rec(), "h1", 1, "crashed", true)).toBeNull();
    expect(brainRelease(rec({ brain: null }), "h1", 2, "crashed", true)).toBeNull();
    expect(brainRelease(rec(), "h1", 3, "crashed", true)?.patch).toMatchObject({ brain: null, prev_host: "h1", activity: null, lifecycle: "detached" });
  });

  it.each(AGENT_EXIT_REASONS)("a brain that ended on its own (%s): restarts and counts as the guard says", (reason) => {
    const d = brainRelease(rec({ exit_restarts: 1 }), "h1", 2, reason, true)!;
    const e = EXIT[reason];
    expect(d.wakes).toBe(e.restarts);
    expect(d.patch.exit_restarts).toBe(e.counted ? 2 : undefined);
    expect(d.next).toBe(!e.restarts ? null : e.counted ? "wake_after_exit" : "wake");
    // Without work waiting nothing follows; the count is the same.
    expect(brainRelease(rec({ exit_restarts: 1 }), "h1", 2, reason, false)!.next).toBeNull();
  });

  it.each(AGENT_EXIT_REASONS)("a condemned brain (%s): its end was its condemn's, so nothing of its own follows", (reason) => {
    const d = brainRelease(rec({ brain: condemned() }), "h1", 2, reason, true)!;
    expect(d).toMatchObject({ wakes: false, next: null });
    expect(d.patch.exit_restarts).toBeUndefined();
    // Its condemn's intent runs.
    expect(brainRelease(rec({ brain: condemned(), intent: { reason: "retry" } }), "h1", 2, reason, true)!.next).toBe("intent");
  });

  it.each(AGENT_EXIT_REASONS)("a stopped brain (%s) ends `stopped`: uncounted, and wakes only for input after the stop", (reason) => {
    for (const brain of [live(), condemned()]) {
      const quiet = brainRelease(rec({ brain, ...stopped(true) }), "h1", 2, reason, true)!;
      expect(quiet).toMatchObject({ wakes: false, next: null });
      expect(quiet.patch.exit_restarts).toBeUndefined();
      const input = brainRelease(rec({ brain, ...stopped(false) }), "h1", 2, reason, true)!;
      expect(input).toMatchObject({ wakes: true, next: "wake" });
      expect(input.patch.exit_restarts).toBeUndefined();
    }
  });

  it("an operator's start kept beside a brain runs after a graceful stop or a move, and is dropped by any other end (N14, N20)", () => {
    const op: StartIntent = { reason: "operator" };
    expect(brainRelease(rec({ intent: op }), "h1", 2, "stopped", false)!).toMatchObject({ next: "intent" });
    expect(brainRelease(rec({ intent: op }), "h1", 2, "crashed", false)!.patch).toMatchObject({ intent: null, capacity_waits: undefined });
    expect(brainRelease(rec({ intent: op }), "h1", 2, "idle", true)!.next).toBe("wake");
    expect(brainRelease(rec({ intent: { ...op, host_hint: "h2" } }), "h1", 2, "crashed", false)!.next).toBe("intent");
    expect(brainRelease(rec({ intent: { ...op, avoid: "h1" } }), "h1", 2, "crashed", false)!.next).toBe("intent");
    expect(brainRelease(rec({ brain: condemned(), intent: op }), "h1", 2, "fenced", false)!.next).toBe("intent");
  });

  it("`errored` stays while nothing will start a brain; any start wanted makes it `detached`", () => {
    const errored = { lifecycle: "errored" as const, brain: condemned() };
    expect(brainRelease(rec(errored), "h1", 2, "fenced", true)!.patch.lifecycle).toBeUndefined();
    expect(brainRelease(rec({ ...errored, intent: { reason: "retry" } }), "h1", 2, "fenced", true)!.patch.lifecycle).toBe("detached");
    expect(brainRelease(rec({ ...errored, ...stopped(false) }), "h1", 2, "fenced", true)!.patch.lifecycle).toBe("detached");
  });
});

describe("unresponsive", () => {
  it("a start that never said hello: counted, backed off, `errored`, woken", () => {
    expect(unresponsive(rec({ exit_restarts: 1, start_timeouts: 1 }), live(), "starting"))
      .toEqual({ patch: { exit_restarts: 2, start_timeouts: 2, lifecycle: "errored" }, wake: true });
  });
  it("a live brain with no session: counted and woken, nothing else", () => {
    expect(unresponsive(rec(), live(), "no_session")).toEqual({ patch: { exit_restarts: 1 }, wake: true });
  });
  it("a stopped one: condemned all the same, but neither counted nor woken", () => {
    for (const kind of ["starting", "no_session"] as const) {
      expect(unresponsive(rec(stopped(false)), live(), kind)).toEqual({ patch: {}, wake: false });
    }
  });
});

describe("epochlessExit", () => {
  it.each(AGENT_EXIT_REASONS)("counts and wakes as the same exit at an epoch would (%s)", (reason) => {
    const e = EXIT[reason];
    expect(epochlessExit(rec(), live(), reason)).toEqual({ patch: e.counted ? { exit_restarts: 1 } : {}, wake: e.restarts, afterExit: e.counted });
    expect(epochlessExit(rec(stopped(false)), live(), reason)).toEqual({ patch: {}, wake: false, afterExit: false });
  });
});

describe("startFailure", () => {
  it(`a retryable refusal is retried ${MAX_START_ATTEMPTS} times, then \`errored\``, () => {
    for (let n = 0; n < MAX_START_ATTEMPTS; n++) {
      expect(startFailure(rec({ start_attempts: n }), 2, true)).toEqual({ patch: { start_attempts: n + 1, intent: { reason: "retry" } }, retry: true });
    }
    expect(startFailure(rec({ start_attempts: MAX_START_ATTEMPTS }), 2, true)).toEqual({ patch: { lifecycle: "errored" }, retry: false });
  });
  it("a refusal for good is `errored` at once; with a start already wanted, or stopped, it's neither retried nor an error", () => {
    expect(startFailure(rec(), 2, false)).toEqual({ patch: { lifecycle: "errored" }, retry: false });
    expect(startFailure(rec({ intent: { reason: "operator" } }), 2, true)).toEqual({ patch: {}, retry: false });
    expect(startFailure(rec(stopped(true)), 2, true)).toEqual({ patch: {}, retry: false });
  });
});

describe("wakeDecision", () => {
  it("starts a brain only for waiting work, none running, and nothing quieted by a stop", () => {
    expect(wakeDecision(rec({ brain: null }), true, false)).toBe("start");
    expect(wakeDecision(rec({ brain: condemned() }), true, false)).toBe("start");
    expect(wakeDecision(rec(), true, false)).toBe("none");
    expect(wakeDecision(rec({ brain: null }), false, false)).toBe("none");
    expect(wakeDecision(rec({ brain: null, ...stopped(true) }), true, false)).toBe("none");
    expect(wakeDecision(rec({ brain: null, ...stopped(false) }), true, false)).toBe("start");
  });
  it(`after an exit, past ${MAX_EXIT_RESTARTS} restarts it gives up; new input always gets a try`, () => {
    expect(wakeDecision(rec({ brain: null, exit_restarts: MAX_EXIT_RESTARTS }), true, true)).toBe("start");
    expect(wakeDecision(rec({ brain: null, exit_restarts: MAX_EXIT_RESTARTS + 1 }), true, true)).toBe("errored");
    expect(wakeDecision(rec({ brain: null, exit_restarts: MAX_EXIT_RESTARTS + 1 }), true, false)).toBe("start");
  });
});

describe("intents", () => {
  it("merge: the newer fields win, the stronger reason stays (N15), a host is never both hint and avoided", () => {
    expect(mergeIntent({ reason: "restart" }, { reason: "operator", host_hint: "h2" })).toEqual({ reason: "restart", host_hint: "h2" });
    expect(mergeIntent({ reason: "wake" }, { reason: "drain", avoid: "h1" })).toEqual({ reason: "drain", avoid: "h1" });
    expect(mergeIntent({ reason: "operator", host_hint: "h1" }, { reason: "drain", avoid: "h1" })).toEqual({ reason: "operator", avoid: "h1" });
    expect(mergeIntent({ reason: "drain", avoid: "h1" }, { reason: "operator", host_hint: "h1" })).toEqual({ reason: "operator", host_hint: "h1" });
    expect(mergeIntent(null, { reason: "wake" })).toEqual({ reason: "wake" });
  });
  it("against a brain that isn't condemned: moves and restarts condemn it, an operator's start waits, any other is dropped", () => {
    const b = live(2, "h1");
    expect(liveBrainStart({ reason: "operator", host_hint: "h2" }, b, true)).toBe("condemn");
    expect(liveBrainStart({ reason: "drain", avoid: "h1" }, b, true)).toBe("condemn");
    expect(liveBrainStart({ reason: "restart" }, b, true)).toBe("condemn");
    expect(liveBrainStart({ reason: "wake" }, b, false)).toBe("condemn");
    expect(liveBrainStart({ reason: "operator", host_hint: "h1" }, b, true)).toBe("keep");
    for (const reason of ["wake", "retry", "drain"] as const) expect(liveBrainStart({ reason }, b, true)).toBe("drop");
  });
});

describe("escalation", () => {
  const p = (processed: boolean, indexed: boolean, host_processing: boolean) => ({ processed, indexed, host_processing });
  it("a processed kill with no start left indexed releases; a host processing nothing for the exit wait is stuck; past the cap, wedged", () => {
    expect(escalation(p(true, false, true), 0, 60, 900)).toBe("release");
    expect(escalation(p(true, true, true), 100, 60, 900)).toBe("recheck");
    expect(escalation(p(false, true, false), 59, 60, 900)).toBe("recheck");
    expect(escalation(p(false, true, false), 60, 60, 900)).toBe("stuck");
    expect(escalation(p(false, true, true), 899, 60, 900)).toBe("recheck");
    expect(escalation(p(false, true, true), 900, 60, 900)).toBe("cap");
  });
});

describe("phaseDeadlines", () => {
  it("each phase carries its own continuation, and a released brain none", () => {
    const at = (b: Brain | null, connected: boolean) => phaseDeadlines(b, 1000, 240, 600, connected);
    expect(at({ ...live(), phase: "starting" }, false)).toEqual({ starting: 1240, no_session: null, condemned: null });
    expect(at(live(), false)).toEqual({ starting: null, no_session: 1600, condemned: null });
    expect(at(live(), true)).toEqual({ starting: null, no_session: null, condemned: null });
    expect(at(condemned(), false)).toEqual({ starting: null, no_session: null, condemned: 1000 });
    expect(at(null, false)).toEqual({ starting: null, no_session: null, condemned: null });
  });
});

describe("state", () => {
  it("is the lifecycle, or while it is `ready`, the runner's report", () => {
    expect(agentState({ lifecycle: "starting", activity: "working" })).toBe("starting");
    expect(agentState({ lifecycle: "errored", activity: "idle" })).toBe("errored");
    expect(agentState({ lifecycle: "ready", activity: null })).toBe("ready");
    expect(agentState({ lifecycle: "ready", activity: "errored" })).toBe("errored");
  });
  it.each(AgentState.options)("a `state` stored alone (%s) splits into parts that give it back", (state) => {
    expect(agentState(splitState(state))).toBe(state);
  });
});
