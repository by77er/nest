// The enrolment circuit breaker (docs/compute/autoscaling/#enrolment-breaker): launches of an instance type
// that keep ending `enroll_timeout` (a type without KVM makes a sandbox host shut down without enrolling)
// stop being launched for a cool-down, instead of a launch every enrolment timeout for ever. Pure: FleetDO
// stores the state per role (`kv enroll_breaker:<role>`) and applies each step in the step that decides
// the event.

/** Consecutive `enroll_timeout` launches of one type that open its breaker. */
export const ENROLL_BREAKER_THRESHOLD = 3;
/** The first cool-down, doubled at each reopening up to the cap. */
export const ENROLL_BREAKER_COOLDOWN_MS = 30 * 60_000;
export const ENROLL_BREAKER_COOLDOWN_MAX_MS = 6 * 3_600_000;

/** One instance type's breaker. Absent: closed with no failures. */
export interface TypeBreaker {
  /** Consecutive launches of the type that never enrolled (an enrolment resets it). */
  failures: number;
  /** How many times it opened since the last enrolment: its cool-down doubles each time. */
  opens: number;
  /** Open until then (no launch of the type before it); null: closed. */
  open_until_ms: number | null;
}
export type Breakers = Readonly<Record<string, TypeBreaker>>;

export type BreakerEvent = { kind: "enroll_timeout"; type: string } | { kind: "enrolled"; type: string };

export interface BreakerStep {
  next: Record<string, TypeBreaker>;
  /** The type's breaker opened at this step, until then (the operator is told). */
  opened?: { type: string; until_ms: number; failures: number };
  /** The type enrolled with its breaker open or failures counted: closed again. */
  reset?: string;
}

const closed: TypeBreaker = { failures: 0, opens: 0, open_until_ms: null };

/** The cool-down of the `opens`th opening. */
export const cooldownMs = (opens: number): number => Math.min(ENROLL_BREAKER_COOLDOWN_MS * 2 ** Math.max(0, opens - 1), ENROLL_BREAKER_COOLDOWN_MAX_MS);

/**
 * One event. A launch of `type` that never enrolled counts; at the threshold (and at each failure after
 * it, once a cool-down has passed: the one launch it let through failed too) the breaker opens for the
 * next cool-down. An enrolment of the type closes it and clears its counts.
 */
export function breakerStep(b: Breakers, ev: BreakerEvent, now: number): BreakerStep {
  const next: Record<string, TypeBreaker> = { ...b };
  const cur = b[ev.type] ?? closed;
  if (ev.kind === "enrolled") {
    if (cur.failures === 0 && cur.opens === 0 && cur.open_until_ms === null) return { next };
    delete next[ev.type];
    return { next, reset: ev.type };
  }
  const failures = cur.failures + 1;
  const isOpen = cur.open_until_ms !== null && now < cur.open_until_ms;
  if (failures >= ENROLL_BREAKER_THRESHOLD && !isOpen) {
    const opens = cur.opens + 1;
    const until_ms = now + cooldownMs(opens);
    next[ev.type] = { failures, opens, open_until_ms: until_ms };
    return { next, opened: { type: ev.type, until_ms, failures } };
  }
  next[ev.type] = { ...cur, failures };
  return { next };
}

/** Whether `type`'s breaker is open at `now` (no launch of it). */
export const breakerOpen = (b: Breakers, type: string, now: number): boolean => {
  const t = b[type];
  return !!t && t.open_until_ms !== null && now < t.open_until_ms;
};

/**
 * A launch plan without the types whose breakers are open. `role_open`: the plan had launches and none is
 * left, so the role's breaker is open until the earliest of its types' cool-downs ends.
 */
export function filterPlan<T extends { type: string }>(b: Breakers, plan: readonly T[], now: number): { launch: T[]; role_open_until_ms: number | null } {
  const launch = plan.filter((a) => !breakerOpen(b, a.type, now));
  if (launch.length || !plan.length) return { launch, role_open_until_ms: null };
  return { launch, role_open_until_ms: Math.min(...plan.map((a) => b[a.type]!.open_until_ms!)) };
}
