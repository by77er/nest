// The enrolment breaker (docs/compute/autoscaling/): an instance type whose launches keep ending
// `enroll_timeout` isn't launched for a cool-down; with every type open, the role launches nothing; an
// enrolment closes it. The pure step first; FleetDO's wiring is in fleet.test.ts ("autoscaling").
import { describe, expect, it } from "vitest";
import {
  basisChanged, pausedReason, breakerOpen, breakerStep, type Breakers, cooldownMs, ENROLL_BREAKER_COOLDOWN_MAX_MS, ENROLL_BREAKER_COOLDOWN_MS, ENROLL_BREAKER_THRESHOLD, filterPlan,
} from "../src/lib/enroll-breaker";

const T = "c8i.large";
const timeout = { kind: "enroll_timeout" as const, type: T };
const enrolled = { kind: "enrolled" as const, type: T };

describe("breakerStep (pure)", () => {
  it("opens at the threshold of consecutive timeouts, not before", () => {
    let b: Breakers = {};
    for (let i = 1; i < ENROLL_BREAKER_THRESHOLD; i++) {
      const s = breakerStep(b, timeout, 1000);
      expect(s.opened).toBeUndefined();
      expect(breakerOpen(s.next, T, 1000)).toBe(false);
      b = s.next;
    }
    const s = breakerStep(b, timeout, 1000);
    expect(s.opened).toEqual({ type: T, until_ms: 1000 + ENROLL_BREAKER_COOLDOWN_MS, failures: ENROLL_BREAKER_THRESHOLD });
    expect(breakerOpen(s.next, T, 1000 + ENROLL_BREAKER_COOLDOWN_MS - 1)).toBe(true);
    expect(breakerOpen(s.next, T, 1000 + ENROLL_BREAKER_COOLDOWN_MS)).toBe(false);
  });

  // [state before, event, now, failures after, open_until after, opened?, reset?]
  const open = (failures: number, opens: number, until: number | null) => ({ [T]: { failures, opens, open_until_ms: until } });
  const table: [string, Breakers, typeof timeout | typeof enrolled, number, number | undefined, number | null | undefined, boolean, boolean][] = [
    ["a timeout while open counts, doesn't reopen", open(3, 1, 5000), timeout, 2000, 4, 5000, false, false],
    ["the one launch let through after the cool-down fails: reopens, doubled", open(3, 1, 5000), timeout, 6000, 4, 6000 + cooldownMs(2), true, false],
    ["an enrolment closes an open breaker", open(3, 1, 5000), enrolled, 2000, undefined, undefined, false, true],
    ["an enrolment clears counted failures", open(2, 0, null), enrolled, 2000, undefined, undefined, false, true],
    ["an enrolment with nothing counted is nothing", {}, enrolled, 2000, undefined, undefined, false, false],
    ["another type's state is untouched", { other: { failures: 2, opens: 0, open_until_ms: null } }, timeout, 2000, 1, null, false, false],
  ];
  it.each(table)("%s", (_what, before, ev, now, failures, until, opened, reset) => {
    const s = breakerStep(before, ev, now);
    if (failures === undefined) expect(s.next[T]).toBeUndefined();
    else expect(s.next[T]).toMatchObject({ failures, open_until_ms: until });
    expect(!!s.opened).toBe(opened);
    expect(s.reset === T).toBe(reset);
    if (before.other) expect(s.next.other).toEqual(before.other);
  });

  it("cool-downs double from the first to the cap", () => {
    expect(cooldownMs(1)).toBe(ENROLL_BREAKER_COOLDOWN_MS);
    expect(cooldownMs(2)).toBe(2 * ENROLL_BREAKER_COOLDOWN_MS);
    expect(cooldownMs(50)).toBe(ENROLL_BREAKER_COOLDOWN_MAX_MS);
  });

  it("a plan loses the open types; with none left, the role is open until the earliest cool-down ends", () => {
    const b: Breakers = { a: { failures: 3, opens: 1, open_until_ms: 900 }, b: { failures: 3, opens: 1, open_until_ms: 500 } };
    const plan = [{ type: "a", spot: true }, { type: "b", spot: true }, { type: "c", spot: false }];
    expect(filterPlan(b, plan, 100)).toEqual({ launch: [{ type: "c", spot: false }], role_open_until_ms: null });
    expect(filterPlan(b, plan.slice(0, 2), 100)).toEqual({ launch: [], role_open_until_ms: 500 });
    expect(filterPlan(b, plan.slice(0, 2), 600)).toEqual({ launch: [{ type: "b", spot: true }], role_open_until_ms: null });
    expect(filterPlan(b, [], 100)).toEqual({ launch: [], role_open_until_ms: null });
  });
});

describe("the pause reason and the basis (pure)", () => {
  const b: Breakers = { a: { failures: 3, opens: 1, open_until_ms: 900 }, b: { failures: 4, opens: 2, open_until_ms: 500 } };
  it("names every type with its failures and the earliest probe, only when all are open", () => {
    expect(pausedReason(b, ["a", "b", "a"], 100)).toEqual({ reason: `launches paused: consecutive enrolment failures for a (3), b (4); next probe at ${new Date(500).toISOString()}`, until_ms: 500 });
    expect(pausedReason(b, ["a", "b", "c"], 100)).toBeNull();
    expect(pausedReason(b, ["a", "b"], 600)).toBeNull();
    expect(pausedReason(b, [], 100)).toBeNull();
  });
  it("a basis changed only when both sides are known and differ", () => {
    expect(basisChanged("ami-1", "ami-2")).toBe(true);
    expect(basisChanged("ami-1", "ami-1")).toBe(false);
    expect(basisChanged(undefined, "ami-2")).toBe(false);
    expect(basisChanged(null, "ami-2")).toBe(false);
    expect(basisChanged("ami-1", null)).toBe(false);
  });
});
