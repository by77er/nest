// A host's lifecycle (lib/host-lifecycle.ts): the status transitions FleetDO applies, swept over every
// status and fact, the tick's expiry verdict, and what each kind of death means.
import { describe, expect, it } from "vitest";
import { deathPlan, expiryVerdict, hostStep, type DeathCause, type HostFacts, type HostTransition } from "../src/lib/host-lifecycle";
import { HOST_STATUSES } from "../../protocol/admin/view";

const TRANSITIONS: HostTransition[] = ["hello_back", "drain", "expire_held", "expire_silent", "fence_done", "die"];
const facts = function* (): Generator<HostFacts> {
  for (const status of HOST_STATUSES) {
    for (const draining of [false, true]) for (const wedged of [false, true]) for (const terminating of [false, true]) yield { status, draining, wedged, terminating };
  }
};

describe("hostStep (pure)", () => {
  it("never leaves dead, and each transition applies only from its own statuses", () => {
    const from: Record<HostTransition, string[]> = {
      hello_back: ["expired"], drain: ["active", "draining", "expired", "stonith_pending"], expire_held: ["active", "draining"],
      expire_silent: ["active", "draining"], fence_done: ["stonith_pending"], die: ["active", "draining", "expired", "stonith_pending"],
    };
    for (const h of facts()) {
      for (const t of TRANSITIONS) {
        const to = hostStep(h, t);
        if (h.status === "dead") expect(to, t).toBeNull();
        if (!from[t].includes(h.status)) expect(to, `${t} from ${h.status}`).toBeNull();
      }
    }
  });

  it("a host returns to draining, never active, once a drain was asked for (a spot notice survives a blip)", () => {
    for (const h of facts()) {
      for (const t of ["hello_back", "fence_done"] as const) {
        const to = hostStep(h, t);
        if (to !== null) expect(to, `${t} ${JSON.stringify(h)}`).toBe(h.draining ? "draining" : "active");
      }
    }
    expect(hostStep({ status: "active", draining: false, wedged: false, terminating: false }, "drain")).toBe("draining");
    expect(hostStep({ status: "stonith_pending", draining: false, wedged: false, terminating: false }, "drain")).toBe("stonith_pending");
  });

  it("a fence never ends STONITH for a wedged host or one FleetDO is terminating: only its death does", () => {
    for (const h of facts()) {
      if (h.status !== "stonith_pending") continue;
      expect(hostStep(h, "fence_done") !== null, JSON.stringify(h)).toBe(!h.wedged && !h.terminating);
      expect(hostStep(h, "die")).toBe("dead");
    }
  });
});

describe("expiryVerdict (pure)", () => {
  const EXPIRY = 30_000;
  it("expires only a serving host silent for the expiry, never one that hasn't said hello", () => {
    for (const status of HOST_STATUSES) {
      for (const lastRx of [null, 0, 1, 10_000]) {
        for (const wedged of [false, true]) {
          for (const holds of [false, true]) {
            const v = expiryVerdict({ status, last_rx: lastRx, wedged }, holds, 30_001, EXPIRY);
            const silent = (status === "active" || status === "draining") && lastRx !== null && 30_001 - lastRx >= EXPIRY;
            expect(v, `${status} ${lastRx} ${wedged} ${holds}`).toBe(!silent ? null : wedged || holds ? "expire_held" : "expire_silent");
          }
        }
      }
    }
  });
});

describe("deathPlan (pure)", () => {
  it("proof (A6) only where nothing can still run there; leases placed again unless all suspended", () => {
    const causes: DeathCause[] = ["confirmed", "never_connected", "enroll_timeout", "idle", "drained"];
    expect(Object.fromEntries(causes.map((c) => [c, deathPlan(c)]))).toEqual({
      confirmed: { proof: true, end: "dead", leases: "reassign" },
      never_connected: { proof: true, end: null, leases: "reassign" },
      enroll_timeout: { proof: true, end: "enroll_timeout", leases: "reassign" },
      idle: { proof: false, end: "idle", leases: "evict" },
      drained: { proof: false, end: "drained", leases: "evict" },
    });
  });
});
