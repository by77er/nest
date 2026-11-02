// Generation retention in SandboxDO (docs/sandbox/state/#retention): the `retention` alarm marks what
// lib/retention.ts drops `deleting` and GC's roots shrink to what is kept; a placement's claim pins the
// generation it restores before anything else can run; a head that isn't a restore source is never
// restored; `report` and `off` change nothing; a destroyed sandbox is left alone; rows stored before
// the `state` column read as ready; FleetDO's first GC run after retention is switched on is dry.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import { SandboxDO } from "../src/do/sandbox";
import type { CommitRequestEvent } from "../src/protocol/control";
import type { GenerationRecord } from "../src/protocol/model";
import { adminJson, connectHost, nextCommands, runDue, uniqueCell } from "./helpers";

const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** A distinct manifest hash per generation and kind (low-entropy on purpose). */
const mf = (i: number, kind: "d" | "m") => `blake3:${i.toString(16).padStart(63, "0")}${kind === "d" ? "d" : "e"}`;

interface Private {
  runRetention(): Promise<void>;
  placeCurrentEpoch(excludeHost?: string): Promise<string | null>;
  env: typeof env;
}

async function placedSandbox() {
  const cell = uniqueCell();
  const h = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "retention" } }, 201);
  const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(h.ws, (c) => c.type === "sandbox_create");
  return { cell, h, sandbox };
}

let seq = 0;
/** Where each chain's seqs start, by its first id. */
const seqBase = new Map<string, number>();
/**
 * Commit a chain from the head on, one generation per spec, each then aged to `age` ms before now
 * (the column retention reads, and the record). Returns the ids in order.
 */
async function commitChain(sandbox: string, host: string, specs: { reason: string; age: number; mem?: boolean }[]): Promise<string[]> {
  const ids: string[] = [];
  const start = seq + 1;
  for (const s of specs) {
    const i = ++seq;
    const parent = (await sandboxStub(sandbox).info()).head;
    const out = await sandboxStub(sandbox).commit(host, {
      ts_ms: Date.now(), type: "commit_request", request: `req_ret_${i}`, sandbox, epoch: 1, kind: s.mem ? "checkpoint" : "disk_only",
      disk_manifest: mf(i, "d"), ...(s.mem ? { mem_manifest: mf(i, "m") } : {}), reason: s.reason, ...(parent ? { parent } : {}),
    } as CommitRequestEvent);
    if (out.status !== "committed") throw new Error(`commit ${i}: ${JSON.stringify(out)}`);
    ids.push(out.generation.id);
    await age(sandbox, out.generation.id, s.age);
  }
  if (ids.length) seqBase.set(ids[0]!, start);
  return ids;
}

async function age(sandbox: string, id: string, ageMs: number): Promise<void> {
  await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
    const at = Date.now() - ageMs;
    const rec = JSON.parse(st.storage.sql.exec<{ record: string }>("SELECT record FROM generations WHERE id = ?", id).one().record) as GenerationRecord;
    st.storage.sql.exec("UPDATE generations SET created_ms = ?, record = ? WHERE id = ?", at, JSON.stringify({ ...rec, created_ms: at }), id);
  });
}

const states = async (sandbox: string) =>
  Object.fromEntries((await sandboxStub(sandbox).generations()).map((g) => [g.record.id, g.state]));

/** Fire one deadline through the real alarm handler (after the sandbox's event posts drained). */
async function runSandboxAlarm(sandbox: string, key: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) =>
    st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'chan_out' UNION ALL SELECT 1 FROM chan_out").toArray().length > 0)) {
    if (Date.now() > end) throw new Error("the sandbox's channel outbox didn't drain");
    await new Promise((r) => setTimeout(r, 50));
  }
  await runInDurableObject(sandboxStub(sandbox), async (_inst: SandboxDO, st) => {
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES (?, 0)", key);
    await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
  });
  await runDue(sandboxStub(sandbox));
}

const deadline = (sandbox: string, key: string) => runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) =>
  st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = ?", key).toArray()[0]?.at);

/** Eight daily `timer` generations, a checkpoint among them, then a checkpoint head. */
async function history(sandbox: string, host: string) {
  const specs = Array.from({ length: 8 }, (_, i) => ({ reason: "timer", age: (8 - i) * DAY, mem: i === 5 }));
  return commitChain(sandbox, host, [...specs, { reason: "suspend", age: 0, mem: true }]);
}

describe("the retention alarm", () => {
  it("marks what retention drops deleting, and GC's roots shrink to the kept generations' disks and the head's memory", async () => {
    const { h, sandbox } = await placedSandbox();
    const ids = await history(sandbox, h.host);
    const head = ids[8]!;
    // A commit arms it a minute out (a burst of commits gets one pass).
    expect(await deadline(sandbox, "retention")).toBeGreaterThan(Date.now() + 50_000);
    await runSandboxAlarm(sandbox, "retention");
    // Sparse history: each tier keeps its newest slots, so the head and the five newest before it stay.
    const s = await states(sandbox);
    expect(ids.map((id) => s[id])).toEqual(["deleting", "deleting", "deleting", "ready", "ready", "ready", "ready", "ready", "ready"]);
    const listed = await sandboxStub(sandbox).generations();
    expect(listed.find((g) => g.record.id === head)).toMatchObject({ state: "ready", retained: "restore_source" });
    expect(listed.find((g) => g.record.id === ids[3])).toMatchObject({ state: "ready", retained: "tier" });
    const roots = await sandboxStub(sandbox).gcRoots();
    const want = [3, 4, 5, 6, 7, 8].map((k) => mf(seqOf(ids, k), "d"));
    expect(roots.sort()).toEqual([...want, mf(seqOf(ids, 8), "m")].sort());
    // The checkpoint at index 5 is kept, but its memory is no longer a root: only the head's memory loads.
    expect(roots).not.toContain(mf(seqOf(ids, 5), "m"));
    // Re-armed while it lives; a second pass marks nothing more.
    expect(await deadline(sandbox, "retention")).toBeGreaterThan(Date.now() + 5 * HOUR);
    await runSandboxAlarm(sandbox, "retention");
    expect(await states(sandbox)).toEqual(s);
    // The head is still what a placement restores.
    expect((await sandboxStub(sandbox).headGeneration())?.id).toBe(head);
  });

  it("marks at most 500 a pass and continues a second later", async () => {
    const { h, sandbox } = await placedSandbox();
    await commitChain(sandbox, h.host, [{ reason: "timer", age: 0 }]);
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
      for (let i = 0; i < 620; i++) {
        const id = `gen_bulk${String(i).padStart(19, "0")}`;
        const at = Date.now() - 40 * DAY + i * 1000; // a second apart, about 11 minutes: the tiers keep a few
        st.storage.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, 0, ?)", id,
          JSON.stringify({ id, sandbox, epoch: 1, kind: "disk_only", disk_manifest: mf(100_000 + i, "d"), reason: "timer", created_ms: at }), at);
      }
    });
    await runSandboxAlarm(sandbox, "retention");
    const count = () => runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) =>
      st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM generations WHERE state = 'deleting'").one().n);
    expect(await count()).toBe(500);
    expect(await deadline(sandbox, "retention")).toBeLessThan(Date.now() + 5_000);
    await runSandboxAlarm(sandbox, "retention");
    // The rest go in the second pass: all but the few slot representatives the tiers keep.
    const after = await count();
    expect(after).toBeGreaterThan(600);
    expect(after).toBeLessThan(620);
    expect(await deadline(sandbox, "retention")).toBeGreaterThan(Date.now() + 5 * HOUR);
  });

  it("prunes main-chain deleting rows a week after they were marked, and never an orphan's", async () => {
    const { h, sandbox } = await placedSandbox();
    await commitChain(sandbox, h.host, [{ reason: "timer", age: 0 }]);
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
      const put = (id: string, orphaned: number, markedAgo: number) => st.storage.sql.exec(
        "INSERT INTO generations (id, record, orphaned, created_ms, state, deleting_ms) VALUES (?, ?, ?, ?, 'deleting', ?)", id,
        JSON.stringify({ id, sandbox, epoch: 1, kind: "disk_only", disk_manifest: mf(9, "d"), reason: "timer", created_ms: 0 }), orphaned, 0, Date.now() - markedAgo);
      put("gen_main_recent0000000000", 0, 6 * DAY);
      put("gen_main_old000000000000000", 0, 8 * DAY);
      put("gen_orph_recent0000000000", 1, 30 * DAY);
      put("gen_orph_old000000000000000", 1, 32 * DAY);
    });
    await runSandboxAlarm(sandbox, "retention");
    const left = Object.keys(await states(sandbox)).filter((id) => id.includes("_main_") || id.includes("_orph_")).sort();
    // An orphan's row keeps its commit record: a salvage has no parent check, so a late re-ask must find it.
    expect(left).toEqual(["gen_main_recent0000000000", "gen_orph_old000000000000000", "gen_orph_recent0000000000"]);
  });

  it("is armed by the lifetime check for a sandbox that never commits again", async () => {
    const { sandbox } = await placedSandbox();
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'retention'"));
    await runSandboxAlarm(sandbox, "expiry");
    expect(await deadline(sandbox, "retention")).toBeDefined();
  });
});

describe("pins and restore sources", () => {
  it("a placement's claim pins the generation it restores: retention running mid-placement keeps it, though it is no longer head", async () => {
    const { h, sandbox } = await placedSandbox();
    const [pinned] = await commitChain(sandbox, h.host, [{ reason: "timer", age: 5 * DAY }]);
    const out = await runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO, st) => {
      const self = inst as unknown as Private;
      const real = self.env;
      // Unplaced (its host gone), head = `pinned`.
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...info, host: null, state: "suspended" }));
      let from: string | undefined;
      const fleet = {
        place: async (req: { from?: GenerationRecord }) => {
          from = req.from?.id;
          // While FleetDO answers: the head moves past it (newer generations in their own slots), and
          // retention runs in this same object.
          const cur = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
          let head = cur.head as string;
          for (let i = 0; i < 8; i++) {
            const id = `gen_newer${String(i).padStart(18, "0")}`;
            const at = Date.now() - i * 7 * HOUR;
            st.storage.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, 0, ?)", id,
              JSON.stringify({ id, sandbox, parent: head, epoch: 1, kind: "disk_only", disk_manifest: mf(200 + i, "d"), reason: "timer", created_ms: at }), at);
            head = id;
          }
          st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...cur, head }));
          await self.runRetention();
          return "hst_fake00000000000000000";
        },
        issueCommands: async () => [],
        releaseLease: async () => undefined,
      };
      self.env = { ...real, FLEET: { idFromName: () => "x", get: () => fleet } } as unknown as typeof env;
      try {
        await self.placeCurrentEpoch();
      } finally {
        self.env = real;
      }
      return { from, state: st.storage.sql.exec<{ state: string | null }>("SELECT state FROM generations WHERE id = ?", pinned).one().state };
    });
    expect(out.from).toBe(pinned);
    expect(out.state).toBeNull(); // ready
    // Once the restore is over (the VM runs) the pin ends, and the next pass may drop it.
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...info, state: "running" }));
    });
    await runSandboxAlarm(sandbox, "retention");
    expect((await states(sandbox))[pinned!]).toBe("deleting");
  });

  it("a head that isn't a restore source is never restored: the placement is refused before any claim", async () => {
    const { h, sandbox } = await placedSandbox();
    const [head] = await commitChain(sandbox, h.host, [{ reason: "timer", age: 0 }]);
    const out = await runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO, st) => {
      const self = inst as unknown as Private;
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...info, host: null, state: "suspended" }));
      st.storage.sql.exec("UPDATE generations SET state = 'deleting', deleting_ms = ? WHERE id = ?", Date.now(), head);
      let placed = 0;
      const real = self.env;
      self.env = { ...real, FLEET: { idFromName: () => "x", get: () => ({ place: async () => { placed++; return "hst_x"; } }) } } as unknown as typeof env;
      try {
        const err = await self.placeCurrentEpoch().then(() => null, (e: Error) => e.message);
        const after = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
        return { err, placed, epoch: after.epoch, placing: after.placing };
      } finally {
        self.env = real;
      }
    });
    expect(out).toEqual({ err: expect.stringContaining("not a restore source"), placed: 0, epoch: 1, placing: null });
  });
});

describe("the switch", () => {
  async function inMode(sandbox: string, mode: string) {
    return runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO, st) => {
      const self = inst as unknown as Private;
      const real = self.env;
      self.env = { ...real, SANDBOX_RETENTION: mode };
      try {
        await self.runRetention();
        const report = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'retention_report'").toArray()[0]?.value;
        return { roots: await inst.gcRoots(), report: report ? JSON.parse(report) : null };
      } finally {
        self.env = real;
      }
    });
  }

  it("unset is on: marks what it drops and records the pass", async () => {
    const { h, sandbox } = await placedSandbox();
    const ids = await history(sandbox, h.host);
    const out = await inMode(sandbox, "");
    expect(out.report).toMatchObject({ mode: "on", ready: 9, drop: 3, marked: 3, memory_to_unroot: 1, memory_unrooted: 1 });
    expect(Object.values(await states(sandbox)).filter((s) => s === "deleting")).toHaveLength(3);
    expect(out.roots).not.toContain(mf(seqOf(ids, 5), "m"));
    expect(out.roots).not.toContain(mf(seqOf(ids, 0), "d"));
  });

  it("switching back from on roots nothing again: what was marked deleting or unrooted stays out of the roots", async () => {
    const { h, sandbox } = await placedSandbox();
    const ids = await history(sandbox, h.host);
    const on = await inMode(sandbox, "on");
    expect(on.report).toMatchObject({ marked: 3, memory_unrooted: 1 });
    const off = await inMode(sandbox, "off");
    expect(off.roots).not.toContain(mf(seqOf(ids, 5), "m"));
    expect(off.roots).not.toContain(mf(seqOf(ids, 0), "d"));
    expect(off.roots.sort()).toEqual(on.roots.sort());
  });

  it("off: marks and records nothing", async () => {
    const { h, sandbox } = await placedSandbox();
    await history(sandbox, h.host);
    const out = await inMode(sandbox, "off");
    expect(Object.values(await states(sandbox)).every((s) => s === "ready")).toBe(true);
    expect(out.report).toBeNull();
    expect(out.roots).toHaveLength(9 + 2);
  });

  it("a destroyed sandbox is left alone: nothing marked, no roots", async () => {
    const { h, sandbox } = await placedSandbox();
    await history(sandbox, h.host);
    await sandboxStub(sandbox).destroy();
    expect(await deadline(sandbox, "retention")).toBeUndefined();
    await inMode(sandbox, "on");
    expect(Object.values(await states(sandbox)).every((s) => s === "ready")).toBe(true);
    expect(await sandboxStub(sandbox).gcRoots()).toEqual([]);
  });
});

describe("stored data", () => {
  it("an orphan's commit record outlives retention: a salvage re-asked months later gets its first answer", async () => {
    const { h, sandbox } = await placedSandbox();
    await commitChain(sandbox, h.host, [{ reason: "timer", age: 0 }]);
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...info, epoch: 2, host: "hst_other00000000000000000" }));
    });
    const salvage = {
      ts_ms: Date.now(), type: "commit_request", request: "req_late_salvage", sandbox, epoch: 1, kind: "disk_only", disk_manifest: mf(77, "d"), reason: "salvage",
    } as CommitRequestEvent;
    const first = await sandboxStub(sandbox).commit(h.host, salvage);
    expect(first).toMatchObject({ status: "orphaned" });
    const orphan = (first as { generation: GenerationRecord }).generation.id;
    // Two months on: expired, marked deleting, and every prune has run.
    await age(sandbox, orphan, 60 * DAY);
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => st.storage.sql.exec("UPDATE commits SET created_ms = ?", Date.now() - 60 * DAY));
    await runSandboxAlarm(sandbox, "retention");
    expect((await states(sandbox))[orphan]).toBe("deleting");
    await runInDurableObject(sandboxStub(sandbox), (_i: SandboxDO, st) => st.storage.sql.exec("UPDATE generations SET deleting_ms = ? WHERE id = ?", Date.now() - 60 * DAY, orphan));
    await runSandboxAlarm(sandbox, "retention");
    await runSandboxAlarm(sandbox, "commit_prune");
    const again = await sandboxStub(sandbox).commit(h.host, salvage);
    expect(again).toMatchObject({ status: "orphaned", generation: { id: orphan } });
    expect(Object.keys(await states(sandbox))).toHaveLength(2); // the head and the one orphan: no second orphan
  });


  it("rows stored before the state column read as ready restore points", async () => {
    const { h, sandbox } = await placedSandbox();
    const [head] = await commitChain(sandbox, h.host, [{ reason: "timer", age: 0 }]);
    const roots = await runInDurableObject(sandboxStub(sandbox), async (_inst: SandboxDO, st) => {
      const rows = st.storage.sql.exec<{ id: string; record: string; orphaned: number; created_ms: number }>(
        "SELECT id, record, orphaned, created_ms FROM generations").toArray();
      st.storage.sql.exec("DROP TABLE generations");
      st.storage.sql.exec(`CREATE TABLE generations (id TEXT PRIMARY KEY, record TEXT NOT NULL,
        orphaned INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL)`);
      for (const r of rows) st.storage.sql.exec("INSERT INTO generations (id, record, orphaned, created_ms) VALUES (?, ?, ?, ?)", r.id, r.record, r.orphaned, r.created_ms);
      const fresh = new SandboxDO(st as unknown as DurableObjectState, env);
      const cols = st.storage.sql.exec<{ name: string }>("PRAGMA table_info(generations)").toArray().map((c) => c.name);
      return { cols, roots: await fresh.gcRoots(), head: (await fresh.headGeneration())?.id };
    });
    expect(roots.cols).toEqual(expect.arrayContaining(["state", "deleting_ms"]));
    expect(roots.roots).toHaveLength(1);
    expect(roots.head).toBe(head);
  });
});

describe("FleetDO's GC marking", () => {
  it("switching retention on makes the next run dry, even after a proven run, and again after it was off", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const claim = async () => {
      await runInDurableObject(fleetStub(cell), (_i: FleetDO, st) => st.storage.sql.exec("INSERT OR REPLACE INTO kv (key, value) VALUES ('gc_requested', '1')"));
      const r = await SELF.fetch("http://cp.test/v1/hosts/gc/claim", { method: "POST", headers: { authorization: `Bearer ${h.host_token}` } });
      const c = await r.json<{ run: string; dry_run: boolean }>();
      const rep = await SELF.fetch("http://cp.test/v1/hosts/gc/report", { method: "POST",
        headers: { authorization: `Bearer ${h.host_token}`, "content-type": "application/json" }, body: JSON.stringify({ run: c.run, report: {} }) });
      expect(rep.status).toBe(200);
      return c.dry_run;
    };
    const mode = (m: string) => runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      const self = inst as unknown as { env: typeof env };
      self.env = { ...self.env, SANDBOX_RETENTION: m };
    });
    await mode("off");
    expect(await claim()).toBe(true); // a cell's first run
    expect(await claim()).toBe(false);
    await mode("on");
    expect(await claim()).toBe(true); // the proven run predates switching on
    expect(await claim()).toBe(false);
    await mode("off");
    expect(await claim()).toBe(false); // off is the old marking, already proven
    await mode("on");
    expect(await claim()).toBe(true); // on again: dry again
  });
});

/** The `seq` (manifest number) a commit used, by its index in the ids `commitChain` returned. */
function seqOf(ids: string[], index: number): number {
  return seqBase.get(ids[0]!)! + index;
}
