// A bounded retry with backoff (state-machine sweep, bug 9): after each failure, when to try again, or
// that it gave up, so a failure that never heals is neither retried for ever nor silent. Pure.

export interface RetryPolicy {
  /** The wait after the first failure; it doubles after each one. */
  first_ms: number;
  max_ms: number;
  /** Failures after which it gives up. */
  max_attempts: number;
}

/** After `attempts` failures in all (this one included): the next try's time, or give up. */
export function retryAfter(attempts: number, now: number, p: RetryPolicy): { at_ms: number } | { gave_up: true } {
  if (attempts >= p.max_attempts) return { gave_up: true };
  return { at_ms: now + Math.min(p.first_ms * 2 ** Math.max(0, attempts - 1), p.max_ms) };
}

/** FleetDO's reassignment of a lost lease (`leaseLost` to SandboxDO): ~5 s doubling to 5 min, 10 tries (about 20 min). */
export const REASSIGN_RETRY: RetryPolicy = { first_ms: 5_000, max_ms: 5 * 60_000, max_attempts: 10 };
/** SandboxDO's placement that FleetDO refused (the leases disagree): 30 s doubling to 10 min, 6 tries (about half an hour). */
export const PLACE_REFUSED_RETRY: RetryPolicy = { first_ms: 30_000, max_ms: 10 * 60_000, max_attempts: 6 };
