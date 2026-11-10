// The sandbox lease's pure core (lib/sandbox-lease.ts), checked directly: seeded random walks over
// the model's actions (docs/verification/sandbox-lease §9) against a small FleetDO mirror (one lease
// row, two hosts with or without room), with lost replies and resets at the place await. After every
// step: destroyed is final (S9), a sandbox is never both placed and being placed, no leased epoch is
// granted twice (S3'), SandboxDO's host agrees with a live lease (S8), and once a destroy's cleanup
// and every answer are in, no lease is left.
import { describe, expect, it } from "vitest";
import {
  claim, createFailed, decideCommit, destroyed, evicted, failedHolder, gone, type Lease, leaseLost, type PlaceAnswer, placeAnswered,
  FAILED_RELEASE_MS, failedReleased, failedReleaseDue, placeWanted, reconciled, reported, retried, retriedReleased,
} from "../src/lib/sandbox-lease";
import type { SandboxState } from "../src/protocol/model";

/** mulberry32: a small seeded PRNG, so a failure names its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTS = ["hst_a", "hst_b"];
const REPORTS: SandboxState[] = ["creating", "running", "suspended", "fenced", "failed"];

interface Inflight { epoch: number; executed: boolean; answer: PlaceAnswer | null }
interface World {
  l: Lease;
  /** FleetDO's lease row for the sandbox, and the state its holder last reported. */
  lease: { host: string; epoch: number; state: SandboxState | null } | null;
  room: Record<string, boolean>;
  inflight: Inflight[];
  /** Every epoch FleetDO ever granted. */
  leased: Set<number>;
  /** A destroy whose lease release hasn't run yet. */
  cleanupDue: boolean;
  /** A grant whose answer this object will never see (a reset dropped the continuation). */
  orphanedGrant: boolean;
}

function newWorld(): World {
  return {
    l: { epoch: 0, placing: null, placing_ms: null, host: null, state: "creating", head: null, lost_from: null, create_attempts: 0, guest: null, working: [] },
    lease: null, room: { hst_a: true, hst_b: true }, inflight: [], leased: new Set(), cleanupDue: false, orphanedGrant: false,
  };
}

/** FleetDO.place: idempotent for the live lease at that epoch, refused for any other row, else the first host with room. */
function fleetPlace(w: World, epoch: number): PlaceAnswer {
  if (w.lease) return w.lease.epoch === epoch ? { kind: "host", host: w.lease.host } : { kind: "refused" };
  const host = HOSTS.find((h) => w.room[h]);
  if (!host) return { kind: "none" };
  expect(w.leased.has(epoch), `S3': epoch ${epoch} leased twice`).toBe(false);
  w.leased.add(epoch);
  w.lease = { host, epoch, state: null };
  return { kind: "host", host };
}

/** SandboxDO's shell after an answer that no longer applies to a destroyed sandbox: release that epoch's lease. */
function discard(w: World, epoch: number) {
  if (w.lease?.epoch === epoch) w.lease = null;
}

function answer(w: World, f: Inflight, a: PlaceAnswer) {
  const r = placeAnswered(w.l, f.epoch, a, w.l.head !== null);
  if (r === "stale" && gone(w.l.state) && (a.kind === "host" || a.kind === "unknown")) discard(w, f.epoch);
}

type Action = (w: World, r: () => number) => void;
const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)]!;

const ACTIONS: Record<string, Action> = {
  claim: (w) => {
    const c = claim(w.l, 0);
    if (c.ok) w.inflight.push({ epoch: c.epoch, executed: false, answer: null });
  },
  execute: (w, r) => {
    const f = pick(r, w.inflight.filter((x) => !x.executed));
    if (!f) return;
    f.executed = true;
    f.answer = fleetPlace(w, f.epoch);
  },
  answer: (w, r) => {
    const f = pick(r, w.inflight.filter((x) => x.executed));
    if (!f) return;
    w.inflight.splice(w.inflight.indexOf(f), 1);
    answer(w, f, f.answer!);
  },
  // The reply is lost: the request was delivered (it runs now) or never was; the shell sees a failure.
  lostReply: (w, r) => {
    const f = pick(r, w.inflight);
    if (!f) return;
    if (!f.executed && r() < 0.5) fleetPlace(w, f.epoch);
    w.inflight.splice(w.inflight.indexOf(f), 1);
    answer(w, f, { kind: "unknown" });
  },
  // SandboxDO resets at the await: the continuation never runs; its marker waits for Reconcile.
  reset: (w, r) => {
    const f = pick(r, w.inflight);
    if (!f) return;
    const a = f.executed ? f.answer! : r() < 0.5 ? fleetPlace(w, f.epoch) : null;
    if (a?.kind === "host" && gone(w.l.state)) w.orphanedGrant = true;
    w.inflight.splice(w.inflight.indexOf(f), 1);
  },
  // Assumes a place request runs within PLACING_STALE_MS of its claim (S3'): only a marker whose request already ran (or never will) is reconciled.
  reconcile: (w) => {
    const epoch = w.l.placing;
    if (epoch === null || w.inflight.some((f) => f.epoch === epoch && !f.executed)) return;
    const lease = w.lease ? { ...w.lease, expired: false, guest: null } : null;
    if (reconciled(w.l, epoch, lease) === "gone" && lease?.epoch === epoch) discard(w, epoch);
  },
  report: (w, r) => {
    if (!w.lease) return;
    const s = pick(r, REPORTS);
    w.lease.state = s;
    reported(w.l, w.lease.host, w.lease.epoch, s, null);
  },
  leaseLost: (w, r) => {
    if (!w.lease) return;
    const { host, epoch } = w.lease;
    w.lease = null;
    if (r() < 0.5) w.room[host] = false; // dead
    leaseLost(w.l, host, epoch);
  },
  evict: (w) => {
    if (w.lease?.state !== "suspended") return;
    const { host, epoch } = w.lease;
    w.lease = null;
    evicted(w.l, host, epoch);
  },
  createFailed: (w, r) => {
    if (w.lease) createFailed(w.l, w.lease.host, w.lease.epoch, r() < 0.7);
  },
  retry: (w) => {
    const f = failedHolder(w.l);
    if (!f) return;
    if (w.lease?.epoch === f.epoch) w.lease = null;
    retried(w.l, f.host, f.epoch);
  },
  work: (w, r) => {
    w.l.working = r() < 0.5 ? ["agt_x"] : [];
  },
  room: (w, r) => {
    w.room[pick(r, HOSTS)] = r() < 0.6;
  },
  // The `place` alarm: claim only what it wants placed.
  alarm: (w) => {
    if (placeWanted(w.l)) ACTIONS.claim!(w, () => 0);
  },
  destroy: (w) => {
    if (gone(w.l.state)) return;
    destroyed(w.l);
    w.cleanupDue = true;
  },
  destroyCleanup: (w) => {
    if (!w.cleanupDue) return;
    w.lease = null;
    w.cleanupDue = false;
  },
};
const NAMES = Object.keys(ACTIONS);
/** Destroy is rare, so most of a walk exercises the live protocol. */
const weight = (n: string) => (n === "destroy" ? 0.2 : 1);

function check(w: World, wasGone: boolean, ctx: string) {
  const l = w.l;
  if (wasGone) expect(gone(l.state), `${ctx}: S9 destroyed is final`).toBe(true);
  if (gone(l.state)) expect({ host: l.host, placing: l.placing }, `${ctx}: gone holds nothing`).toEqual({ host: null, placing: null });
  expect(l.placing !== null && l.host !== null, `${ctx}: placed and being placed`).toBe(false);
  if (w.lease && l.host !== null) expect({ host: l.host, epoch: l.epoch }, `${ctx}: S8 lease and claim agree`).toEqual({ host: w.lease.host, epoch: w.lease.epoch });
  if (gone(l.state) && !w.cleanupDue && w.inflight.length === 0 && !w.orphanedGrant) expect(w.lease, `${ctx}: a lease outlived the destroy`).toBeNull();
}

describe("random walks over the lease's actions (600 seeds x 60 steps)", () => {
  it("keep S9, S3', S8, one of placed/placing, and no lease after a destroy", () => {
    const total = NAMES.reduce((s, n) => s + weight(n), 0);
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const w = newWorld();
      const trace: string[] = [];
      for (let step = 0; step < 60; step++) {
        let x = r() * total;
        const name = NAMES.find((n) => (x -= weight(n)) < 0) ?? NAMES[NAMES.length - 1]!;
        trace.push(name);
        const wasGone = gone(w.l.state);
        ACTIONS[name]!(w, r);
        check(w, wasGone, `seed ${seed} step ${step} [${trace.join(" ")}]`);
      }
    }
  });
});

describe("decisions the walk doesn't pin", () => {
  const placed = (over: Partial<Lease> = {}): Lease => ({
    epoch: 3, placing: null, placing_ms: null, host: "hst_a", state: "running", head: "gen_1", lost_from: null, create_attempts: 0, guest: null,
    working: [], ...over,
  });

  it("claim refuses a gone, placed or already placing sandbox, and nothing changes", () => {
    for (const [over, code, retryable] of [
      [{ host: null, state: "destroyed" }, "forbidden", false],
      [{ host: null, state: "archived" }, "forbidden", false],
      [{}, "forbidden", false],
      [{ host: null, placing: 4, epoch: 4 }, "forbidden", true],
    ] as const) {
      const l = placed(over);
      const before = { ...l };
      const c = claim(l, 0);
      expect(c.ok, JSON.stringify(over)).toBe(false);
      if (!c.ok) expect({ code: c.error.code, retryable: c.error.retryable }, JSON.stringify(over)).toEqual({ code, retryable });
      expect(l).toEqual(before);
    }
  });

  it("host events count only from the holder at its epoch, never on a gone sandbox", () => {
    // Stored before destroy cleared the marker: a destroyed sandbox may still say `placing`.
    const cases: [string, Partial<Lease>, string, number][] = [
      ["other host", {}, "hst_b", 3], ["other epoch", {}, "hst_a", 2], ["gone", { state: "destroyed", host: "hst_a" }, "hst_a", 3],
    ];
    for (const [why, over, host, epoch] of cases) {
      const l = placed(over);
      const before = { ...l };
      expect(reported(l, host, epoch, "suspended", null).applied, why).toBe(false);
      expect(evicted(l, host, epoch), why).toBe("ignore");
      expect(createFailed(l, host, epoch, false), why).toBe("ignore");
      expect(l, why).toEqual(before);
    }
    const old = placed({ host: null, state: "destroyed", placing: 4, epoch: 4 });
    expect(placeAnswered(old, 4, { kind: "host", host: "hst_b" }, true)).toBe("stale");
    expect(reconciled(old, 4, { host: "hst_b", epoch: 4, expired: false, state: "running", guest: null })).toBe("gone");
    expect(old).toMatchObject({ host: null, state: "destroyed", placing: null });
  });

  it("an eviction parks a sandbox nobody works on, and re-places one an agent is mid-turn on", () => {
    expect(evicted(placed(), "hst_a", 3)).toBe("park");
    expect(evicted(placed({ working: ["agt_x"] }), "hst_a", 3)).toBe("replace");
    expect(evicted(placed(), "hst_a", 2)).toBe("ignore");
  });

  it("a retryable create failure is re-issued three times, then the sandbox is failed", () => {
    const l = placed({ state: "creating" });
    expect([1, 2, 3, 4].map(() => createFailed(l, "hst_a", 3, true))).toEqual(["reissue", "reissue", "reissue", "failed"]);
    expect(l.state).toBe("failed");
  });

  it("no capacity rolls the claimed epoch back: nothing was leased under it (sandbox-lease B1, the owner's open decision)", () => {
    const l = placed({ host: null, state: "fenced" });
    const c = claim(l, 0);
    expect(c).toMatchObject({ ok: true, epoch: 4 });
    expect(placeAnswered(l, 4, { kind: "none" }, true)).toBe("unplaced");
    expect({ epoch: l.epoch, placing: l.placing }).toEqual({ epoch: 3, placing: null });
  });

  it("an adopted lease takes its holder's last report, or restoring/creating by whether a head exists", () => {
    const lease = { host: "hst_b", epoch: 4, expired: false, state: null, guest: null };
    const withHead = placed({ host: null, placing: 4, epoch: 4 });
    expect(reconciled(withHead, 4, lease)).toBe("adopted");
    expect(withHead).toMatchObject({ host: "hst_b", state: "restoring" });
    const fresh = placed({ host: null, placing: 4, epoch: 4, head: null });
    expect(reconciled(fresh, 4, { ...lease, state: "running" })).toBe("adopted");
    expect(fresh.state).toBe("running");
    expect(reconciled(placed({ host: null, placing: 4, epoch: 4 }), 4, { ...lease, expired: true })).toBe("cleared");
    expect(reconciled(placed({ host: null, placing: 4, epoch: 4 }), 4, { ...lease, epoch: 3 })).toBe("cleared");
  });
});

describe("the commit decision (sandbox-lease §2.4), guard by guard in order", () => {
  // Epoch 3 held by hst_a; epoch 2 was hst_b's; the head is gen_h.
  const at = { epoch: 3, host: "hst_a", head: "gen_h" };
  const epochHost = (e: number) => ({ 1: "hst_c", 2: "hst_b", 3: "hst_a" } as Record<number, string>)[e];
  const ev = (over: Partial<Parameters<typeof decideCommit>[3]> = {}) => ({ kind: "disk_only" as const, reason: "turn_end", epoch: 3, parent: "gen_h", ...over });
  const rows: [string, string, ReturnType<typeof ev>, ReturnType<typeof decideCommit>][] = [
    ["head", "hst_a", ev(), { kind: "head" }],
    ["checkpoint with its memory", "hst_a", ev({ kind: "checkpoint", mem_manifest: "m" }), { kind: "head" }],
    ["checkpoint without memory, even as a salvage", "hst_b", ev({ kind: "checkpoint", reason: "salvage", epoch: 2 }), { kind: "rejected", reason: "invalid_message" }],
    ["disk_only with memory", "hst_a", ev({ mem_manifest: "m" }), { kind: "rejected", reason: "invalid_message" }],
    ["salvage from the old epoch's holder, any parent", "hst_b", ev({ reason: "salvage", epoch: 2, parent: "gen_x" }), { kind: "orphan" }],
    ["salvage from another host", "hst_a", ev({ reason: "salvage", epoch: 2 }), { kind: "rejected", reason: "stale_epoch" }],
    ["salvage at the current epoch is an ordinary commit", "hst_a", ev({ reason: "salvage" }), { kind: "head" }],
    ["not salvage, old epoch", "hst_b", ev({ epoch: 2 }), { kind: "rejected", reason: "stale_epoch" }],
    ["current epoch, not the holder", "hst_b", ev(), { kind: "rejected", reason: "stale_epoch" }],
    ["future epoch", "hst_a", ev({ epoch: 4 }), { kind: "rejected", reason: "stale_epoch" }],
    ["parent not the head", "hst_a", ev({ parent: "gen_x" }), { kind: "rejected", reason: "parent_mismatch" }],
    ["no parent on a chain with a head", "hst_a", ev({ parent: undefined }), { kind: "rejected", reason: "parent_mismatch" }],
  ];
  it.each(rows)("%s", (_why, host, e, want) => {
    expect(decideCommit(at, epochHost, host, e)).toEqual(want);
  });

  it("an unplaced sandbox moves no head, and the first commit has no parent", () => {
    expect(decideCommit({ epoch: 3, host: null, head: "gen_h" }, epochHost, "hst_a", ev())).toEqual({ kind: "rejected", reason: "stale_epoch" });
    expect(decideCommit({ epoch: 1, host: "hst_c", head: null }, epochHost, "hst_c", ev({ epoch: 1, parent: undefined }))).toEqual({ kind: "head" });
  });
});

describe("a failed sandbox's lease is released, and only an operator's retry places it again (bug 6)", () => {
  const failed = (over: Partial<Lease> = {}): Lease => ({
    epoch: 3, placing: null, placing_ms: null, host: "hst_a", state: "failed", head: "blake3:h", lost_from: null, create_attempts: 3, guest: null, working: ["agt_w"], ...over,
  });

  // [what, lease, host, epoch, released]
  const table: [string, Lease, string, number, boolean][] = [
    ["failed on its holder at its epoch", failed(), "hst_a", 3, true],
    ["another host", failed(), "hst_b", 3, false],
    ["another epoch (retried meanwhile)", failed(), "hst_a", 2, false],
    ["no longer failed (the retry placed it)", failed({ state: "running" }), "hst_a", 3, false],
    ["already released", failed({ host: null }), "hst_a", 3, false],
    ["destroyed meanwhile", failed({ state: "destroyed", host: null }), "hst_a", 3, false],
  ];
  it.each(table)("failedReleased: %s", (_w, l, host, epoch, want) => {
    const before = structuredClone(l);
    expect(failedReleased(l, host, epoch)).toBe(want);
    // Released: unplaced, still failed, its head kept, an epoch spent. Otherwise untouched.
    expect(l).toEqual(want ? { ...before, host: null, lost_from: null, epoch: before.epoch + 1 } : before);
  });

  it("released, it is never placed on its own, even with an agent working; an operator's retry makes it placeable", () => {
    const l = failed();
    failedReleased(l, "hst_a", 3);
    expect(placeWanted(l)).toBe(false);
    expect(failedHolder(l)).toBeNull();
    expect(retriedReleased(l)).toBe(true);
    expect(l).toMatchObject({ state: "creating", host: null, epoch: 4, head: "blake3:h" });
    expect(placeWanted(l)).toBe(true);
    const c = claim(l, 1);
    expect(c).toMatchObject({ ok: true, epoch: 5 });
  });

  // [what, lease, host, epoch, retried]
  const retries: [string, Lease, string, number, boolean][] = [
    ["failed on its holder at its epoch", failed(), "hst_a", 3, true],
    ["another host", failed(), "hst_b", 3, false],
    ["another epoch (released, or placed again, meanwhile)", failed(), "hst_a", 2, false],
    ["already unplaced (the release finished first)", failed({ host: null, epoch: 4 }), "hst_a", 3, false],
    ["destroyed meanwhile", failed({ state: "destroyed", host: null }), "hst_a", 3, false],
  ];
  it.each(retries)("retried: %s", (_w, l, host, epoch, want) => {
    const before = structuredClone(l);
    retried(l, host, epoch);
    // Retried: unplaced and creating, an epoch spent (so what it left on the host is an older epoch's). Otherwise untouched.
    expect(l).toEqual(want ? { ...before, host: null, state: "creating", epoch: before.epoch + 1 } : before);
  });

  it("after a retry, as after a release, the old incarnation's salvage is an orphan even before the next claim, and after one that found no room", () => {
    const l = failed();
    const hostOf = (e: number) => (e === 3 ? "hst_a" : undefined);
    const salvage = { kind: "disk_only" as const, reason: "salvage", epoch: 3, parent: "blake3:h" };
    retried(l, "hst_a", 3);
    expect(decideCommit(l, hostOf, "hst_a", salvage)).toEqual({ kind: "orphan" });
    // A claim that finds no host rolls back to the epoch the retry left, still above the incarnation's.
    const c = claim(l, 1);
    expect(c).toMatchObject({ ok: true, epoch: 5 });
    expect(placeAnswered(l, 5, { kind: "none" }, false)).toBe("unplaced");
    expect(l.epoch).toBe(4);
    expect(decideCommit(l, hostOf, "hst_a", salvage)).toEqual({ kind: "orphan" });
  });

  it("after the release, the old incarnation's salvage is an orphan from its host only; before it, the holder's moves the head", () => {
    const l = failed();
    const hostOf = (e: number) => (e === 3 ? "hst_a" : undefined);
    const salvage = { kind: "disk_only" as const, reason: "salvage", epoch: 3, parent: "blake3:h" };
    expect(decideCommit(l, hostOf, "hst_a", salvage)).toEqual({ kind: "head" });
    failedReleased(l, "hst_a", 3);
    expect(decideCommit(l, hostOf, "hst_a", salvage)).toEqual({ kind: "orphan" });
    expect(decideCommit(l, hostOf, "hst_b", salvage)).toMatchObject({ kind: "rejected" });
  });

  it("failedReleaseDue: the whole grace from the latest failure of this holder and epoch", () => {
    const G = FAILED_RELEASE_MS;
    const since = (ms: number, over: object = {}) => ({ host: "hst_a", epoch: 3, ms, ...over });
    // [what, lease, since, now, expected]
    expect(failedReleaseDue(failed(), since(1000), 1000 + G)).toEqual({ kind: "release", host: "hst_a", epoch: 3 });
    expect(failedReleaseDue(failed(), since(1000), 1000 + G - 1)).toEqual({ kind: "wait", at_ms: 1000 + G, since: since(1000) });
    // A record of an older failure (another epoch, another host), or none: the grace starts now.
    for (const stale of [since(0, { epoch: 2 }), since(0, { host: "hst_b" }), undefined]) {
      expect(failedReleaseDue(failed(), stale, 5 * G)).toEqual({ kind: "wait", at_ms: 6 * G, since: since(5 * G) });
    }
    // Not failed on a host any more: nothing.
    expect(failedReleaseDue(failed({ state: "running" }), since(0), 5 * G)).toEqual({ kind: "none" });
    expect(failedReleaseDue(failed({ host: null }), since(0), 5 * G)).toEqual({ kind: "none" });
  });

  it("retriedReleased touches only a failed, unplaced sandbox with no placement in flight", () => {
    for (const l of [failed(), failed({ host: null, placing: 4 }), failed({ host: null, state: "suspended" }), failed({ host: null, state: "destroyed" })]) {
      const before = structuredClone(l);
      expect(retriedReleased(l)).toBe(false);
      expect(l).toEqual(before);
    }
  });
});
