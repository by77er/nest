// Generation retention's pure core (lib/retention.ts), checked directly: the one predicate
// `isRestoreSource`, the live pins, the retention table (docs/sandbox/state/#retention) with its
// boundary ages, the GC roots it leaves, and seeded random walks for the properties SandboxDO relies
// on: no restore source is ever dropped, retention is stable (a second pass marks nothing more), and a
// generation that stops being a restore source never becomes one again (so unrooting its memory is safe).
import { describe, expect, it } from "vitest";
import {
  chainView, gcRootsOf, type GenRow, isRestoreSource, livePins, memoryToUnroot, ORPHAN_HEAD_TTL_MS, retention, retentionMode,
  type RootRow, TURN_END_MAX_AGE_MS,
} from "../src/lib/retention";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** A time on a 6-hour boundary, so every tier's slots start at `NOW`. */
const NOW = 100_000 * 6 * HOUR;

const gen = (id: string, created_ms: number, extra: Partial<GenRow> = {}): GenRow => ({
  id, parent: null, orphaned: false, reason: "timer", created_ms, deleting: false, ...extra,
});
const view = (head: string | null, pins: string[] = [], orphanParents: string[] = [], now = NOW) => chainView(head, pins, orphanParents, now);
const dropped = (rows: GenRow[], v = view(null)) => retention(rows, v).drop;

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

describe("isRestoreSource", () => {
  const cases: [string, GenRow, ReturnType<typeof view>, boolean][] = [
    ["the head", gen("g1", NOW - 90 * DAY), view("g1"), true],
    ["a pinned generation that isn't the head", gen("g1", NOW - 90 * DAY), view("g2", ["g1"]), true],
    ["neither head nor pinned", gen("g1", NOW - MIN), view("g2", ["g3"]), false],
    ["a deleting head (never: deleting is one-way)", gen("g1", NOW, { deleting: true }), view("g1"), false],
    ["a deleting pinned generation", gen("g1", NOW, { deleting: true }), view("g2", ["g1"]), false],
    ["an orphan branch's head, a moment before 30 days", gen("o1", NOW - ORPHAN_HEAD_TTL_MS + 1, { orphaned: true }), view("g2"), true],
    ["an orphan branch's head at 30 days", gen("o1", NOW - ORPHAN_HEAD_TTL_MS, { orphaned: true }), view("g2"), false],
    ["an orphan another orphan names as parent", gen("o1", NOW - MIN, { orphaned: true }), view("g2", [], ["o1"]), false],
    ["a main-chain generation an orphan names as parent", gen("g1", NOW - MIN), view("g2", [], ["g1"]), false],
  ];
  it.each(cases)("%s", (_name, g, v, want) => {
    expect(isRestoreSource(g, v)).toBe(want);
  });
});

describe("livePins", () => {
  const base = { restore_pin: { generation: "g1", epoch: 3 }, epoch: 3, placing: null as number | null, host: "hst_a" as string | null };
  const cases: [string, Parameters<typeof livePins>[0], string[]][] = [
    ["while its epoch is being placed", { ...base, placing: 3, host: null, state: "suspended" }, ["g1"]],
    ["while its VM is restoring", { ...base, state: "restoring" }, ["g1"]],
    ["while its VM is created (a re-issued create)", { ...base, state: "creating" }, ["g1"]],
    ["not once it runs", { ...base, state: "running" }, []],
    ["not once it failed", { ...base, state: "failed" }, []],
    ["not for an older epoch's claim", { ...base, epoch: 4, state: "restoring" }, []],
    ["not once destroyed", { ...base, state: "destroyed", host: null }, []],
    ["not when placement ended without a host", { ...base, host: null, state: "creating" }, []],
    ["none recorded (a record from before pins)", { ...base, restore_pin: undefined, state: "restoring" }, []],
  ];
  it.each(cases)("%s", (_name, info, want) => {
    expect(livePins(info)).toEqual(want);
  });
});

describe("retention", () => {
  it("keeps restore sources however old, and drops oldest first", () => {
    const rows = [gen("old_head", NOW - 90 * DAY), gen("old_pin", NOW - 80 * DAY)];
    for (let i = 0; i < 30; i++) rows.push(gen(`m${i}`, NOW - 70 * DAY + i * DAY));
    const d = retention(rows, view("old_head", ["old_pin"]));
    expect(d.kept.get("old_head")).toBe("restore_source");
    expect(d.kept.get("old_pin")).toBe("restore_source");
    expect(d.drop).not.toContain("old_head");
    expect(d.drop).not.toContain("old_pin");
    // Sparse history: each tier keeps its newest slots, so the newest 6 survive (the 10-minute and hourly tiers' 6).
    expect(d.drop).toEqual(Array.from({ length: 24 }, (_, i) => `m${i}`));
  });

  it("keeps the newest 20 turn ends at any age, and up to 200 while younger than 7 days", () => {
    // 25 turn ends a day apart, all older than 7 days: the tiers keep the newest 6, the turn-end rule 20.
    const old = Array.from({ length: 25 }, (_, i) => gen(`t${i}`, NOW - 8 * DAY - i * DAY, { reason: "turn_end" }));
    expect(dropped(old)).toEqual(["t24", "t23", "t22", "t21", "t20"]);
    // 250 turn ends ten minutes apart (under two days): the newest 200, and nothing older.
    const young = Array.from({ length: 250 }, (_, i) => gen(`y${i}`, NOW - MIN - i * 10 * MIN, { reason: "turn_end" }));
    expect(dropped(young)).toEqual(Array.from({ length: 50 }, (_, i) => `y${249 - i}`));
  });

  it("drops the 21st newest turn end exactly at 7 days, not a millisecond before", () => {
    const rows = (age: number) => [
      ...Array.from({ length: 20 }, (_, i) => gen(`t${i}`, NOW - i * MIN, { reason: "turn_end" })),
      gen("t20", NOW - age, { reason: "turn_end" }),
      // Six newer non-turn-end generations in six separate 6-hour slots fill every tier ahead of t20,
      // so only the turn-end rule can keep it.
      ...Array.from({ length: 6 }, (_, i) => gen(`f${i}`, NOW - DAY - i * 6 * HOUR)),
    ];
    expect(retention(rows(TURN_END_MAX_AGE_MS - 1), view(null)).kept.get("t20")).toBe("turn_end");
    expect(dropped(rows(TURN_END_MAX_AGE_MS))).toContain("t20");
  });

  it("a non-turn-end generation keeps no turn end's place", () => {
    const rows = [
      ...Array.from({ length: 21 }, (_, i) => gen(`t${i}`, NOW - 8 * DAY - i * DAY, { reason: "turn_end" })),
      ...Array.from({ length: 30 }, (_, i) => gen(`s${i}`, NOW - i * MIN, { reason: "suspend" })),
    ];
    // The turn-end rule counts turn ends only: t0..t19 stay, t20 goes.
    const d = retention(rows, view(null));
    for (let i = 0; i < 20; i++) expect(d.kept.has(`t${i}`)).toBe(true);
    expect(d.drop).toContain("t20");
  });

  it("thins one minute's generations to its newest, and keeps the newest 5 minutes", () => {
    const at = (m: number) => NOW - 6000 * MIN + m * MIN; // minute m of the hour before NOW
    const rows = [5999.5, 5999.2, 5998.5, 5997.5, 5996.5, 5995.5, 5994.5, 5994.2].map((m) => gen(`m${m}`, at(m)));
    // Minutes 5999..5995 keep their newest; 5994 is the sixth minute, and its 5-, 10-minute, hour and
    // 6-hour slots are represented by 5999.5.
    expect(dropped(rows)).toEqual(["m5994.2", "m5994.5", "m5999.2"]);
  });

  it("keeps an hourly slot's newest past the 10-minute tier", () => {
    const at = (m: number) => NOW - 6000 * MIN + m * MIN;
    const rows = [5999.5, 5985, 5975, 5965, 5955, 5945, 5935, 5925].map((m) => gen(`m${m}`, at(m)));
    // 10-minute slots keep 5999.5..5945 (six); 5935 is the newest of the hour 5880..5939; 5925 is in it too.
    expect(dropped(rows)).toEqual(["m5925"]);
  });

  it("a generation a minute for 48 hours keeps 18, none older than 24 hours", () => {
    const rows = Array.from({ length: 2880 }, (_, k) => gen(`k${k + 1}`, NOW - (k + 1) * MIN));
    const d = retention(rows, view(null));
    // By hand: minutes 1-5; 10-minute slots' newest at 11, 21, 31, 41, 51; hours' at 61, 121, 181, 241, 301;
    // 6-hour slots' at 361, 721, 1081 (minute 1 represents the newest slot of every tier).
    const want = [1, 2, 3, 4, 5, 11, 21, 31, 41, 51, 61, 121, 181, 241, 301, 361, 721, 1081].map((k) => `k${k}`);
    expect([...d.kept.keys()].sort()).toEqual(want.sort());
    expect(d.drop).toHaveLength(2880 - 18);
  });

  it("orphans: a branch's head for 30 days, nothing else of it, and no tier slot taken from the main chain", () => {
    const rows = [
      gen("main", NOW - 2 * MIN),
      gen("o_head", NOW - MIN, { orphaned: true, parent: "o_mid" }),
      gen("o_mid", NOW - 3 * MIN, { orphaned: true }),
      gen("o_old", NOW - ORPHAN_HEAD_TTL_MS - 1, { orphaned: true }),
    ];
    const d = retention(rows, view(null, [], ["o_mid"]));
    expect(d.kept.get("o_head")).toBe("restore_source");
    expect(d.kept.get("main")).toBe("tier");
    expect(d.drop).toEqual(["o_old", "o_mid"]);
  });

  it("never drops or revives a deleting generation", () => {
    const rows = [gen("gone", NOW - MIN, { deleting: true }), gen("g", NOW - 2 * MIN)];
    const d = retention(rows, view("gone", ["gone"]));
    expect(d.drop).toEqual([]);
    expect(d.kept.has("gone")).toBe(false);
  });
});

describe("gcRootsOf and memoryToUnroot", () => {
  const row = (id: string, created: number, mem: boolean, extra: Partial<RootRow> = {}): RootRow => ({
    ...gen(id, created), disk_manifest: `disk:${id}`, ...(mem ? { mem_manifest: `mem:${id}` } : {}), mem_unrooted: false, ...extra,
  });
  const rows = [
    row("head", NOW, true), row("old_ckpt", NOW - MIN, true), row("old_disk", NOW - 2 * MIN, false),
    row("gone", NOW - 3 * MIN, true, { deleting: true }), row("unrooted", NOW - 4 * MIN, true, { mem_unrooted: true }),
  ];
  it("roots every ready generation's disk, and its memory unless marked unrooted; nothing of a deleting one", () => {
    expect(gcRootsOf(rows).sort()).toEqual(["disk:head", "disk:old_ckpt", "disk:old_disk", "disk:unrooted", "mem:head", "mem:old_ckpt"]);
  });
  it("marks unrooted only the memory of ready checkpoints that aren't restore sources, once", () => {
    expect(memoryToUnroot(rows, view("head"))).toEqual(["old_ckpt"]);
    expect(memoryToUnroot(rows, view("head", ["old_ckpt"]))).toEqual([]);
    expect(memoryToUnroot(rows, view("old_ckpt"))).toEqual(["head"]);
  });
});

describe("the switch", () => {
  it.each([[undefined, "report"], ["", "report"], ["on", "on"], ["off", "off"], ["report", "report"], ["yes", "report"]] as const)(
    "SANDBOX_RETENTION=%s is %s", (v, want) => {
      expect(retentionMode({ SANDBOX_RETENTION: v })).toBe(want);
    });
});

describe("random histories", () => {
  // One sandbox's chain as SandboxDO drives it: commits move the head (or add an orphan), a claim
  // pins the head, a pin ends, time passes, retention marks what it drops and unroots memory, and
  // old main-chain `deleting` rows are pruned (orphan rows never are).
  interface W { rows: RootRow[]; head: string | null; pins: string[]; now: number; n: number }
  const orphanParents = (w: W) => w.rows.filter((g) => g.orphaned && g.parent).map((g) => g.parent!);
  const viewOf = (w: W) => view(w.head, w.pins, orphanParents(w), w.now);
  const sources = (w: W) => new Set(w.rows.filter((g) => isRestoreSource(g, viewOf(w))).map((g) => g.id));

  /** One walk; throws on a broken property. Returns how often the properties were exercised. */
  function walk(seed: number): { marked: number; pinnedNonHead: number; unrooted: number; pruned: number } {
    const r = rng(seed);
    const w: W = { rows: [], head: null, pins: [], now: NOW, n: 0 };
    const ever = new Set<string>();
    const former = new Set<string>();
    const reasons = ["turn_end", "timer", "suspend", "drain"];
    const stats = { marked: 0, pinnedNonHead: 0, unrooted: 0, pruned: 0 };
    const root = (id: string, orphaned: boolean, reason: string, parent: string | null): RootRow => ({
      ...gen(id, w.now, { orphaned, reason, parent }), disk_manifest: `disk:${id}`, ...(r() < 0.3 ? { mem_manifest: `mem:${id}` } : {}), mem_unrooted: false,
    });
    for (let step = 0; step < 300; step++) {
      const x = r();
      if (x < 0.4) {
        const id = `g${w.n++}`;
        w.rows.push(root(id, false, reasons[Math.floor(r() * reasons.length)]!, w.head));
        w.head = id;
      } else if (x < 0.47) {
        // A salvage: an orphan whose parent is an older orphan or a main-chain generation.
        const orphans = w.rows.filter((g) => g.orphaned);
        const parent = orphans.length && r() < 0.5 ? orphans[orphans.length - 1]!.id : w.head;
        w.rows.push(root(`o${w.n++}`, true, "salvage", parent));
      } else if (x < 0.55) {
        if (w.head) w.pins = [w.head]; // a claim pins the head it restores
      } else if (x < 0.6) {
        w.pins = [];
      } else if (x < 0.85) {
        w.now += Math.floor(r() * (r() < 0.1 ? 10 * DAY : 30 * MIN));
      } else if (x < 0.88) {
        // Prune main-chain deleting rows (SandboxDO does after a week; any time here).
        const before = w.rows.length;
        w.rows = w.rows.filter((g) => !(g.deleting && !g.orphaned));
        stats.pruned += before - w.rows.length;
      } else {
        const v = viewOf(w);
        const d = retention(w.rows, v);
        const mem = memoryToUnroot(w.rows, v);
        stats.marked += d.drop.length;
        stats.unrooted += mem.length;
        if (w.pins.some((p) => p !== w.head)) stats.pinnedNonHead += 1;
        for (const id of [...d.drop, ...mem]) {
          expect(isRestoreSource(w.rows.find((x) => x.id === id)!, v), `${id} is a restore source`).toBe(false);
        }
        for (const id of d.drop) w.rows.find((x) => x.id === id)!.deleting = true;
        for (const id of mem) w.rows.find((x) => x.id === id)!.mem_unrooted = true;
        // Stable: the same view drops nothing more.
        expect(retention(w.rows, v).drop).toEqual([]);
      }
      const now = sources(w);
      for (const id of now) expect(former.has(id), `${id} became a restore source again`).toBe(false);
      // Every restore source's manifests are GC roots.
      const roots = new Set(gcRootsOf(w.rows));
      for (const g of w.rows.filter((g) => now.has(g.id))) {
        expect(roots.has(g.disk_manifest) && (!g.mem_manifest || roots.has(g.mem_manifest)), `${g.id}'s manifests are roots`).toBe(true);
      }
      for (const id of ever) if (!now.has(id)) former.add(id);
      for (const id of now) ever.add(id);
    }
    return stats;
  }

  const seeds = Array.from({ length: 60 }, (_, i) => i + 1);
  it.each(seeds)("seed %i: never drops or unroots a restore source, is stable, and a former restore source never returns", (seed) => {
    expect(walk(seed).marked).toBeGreaterThan(0);
  });
  it("the walks are not vacuous: drops while a former head was pinned, memory unrooted, rows pruned", () => {
    const total = seeds.map(walk).reduce((a, b) => ({
      marked: a.marked + b.marked, pinnedNonHead: a.pinnedNonHead + b.pinnedNonHead, unrooted: a.unrooted + b.unrooted, pruned: a.pruned + b.pruned,
    }));
    expect(total.pinnedNonHead).toBeGreaterThan(10);
    expect(total.unrooted).toBeGreaterThan(10);
    expect(total.pruned).toBeGreaterThan(10);
  });
});
