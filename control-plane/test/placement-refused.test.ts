// A placement FleetDO refuses (the leases disagree) and the lost-lease reassignment that runs into it
// (state-machine sweep, bug 9): each retried with backoff, then given up visibly, never a 5 s loop for
// ever; an operator's placement ends both. The pure step first.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SandboxDO } from "../src/do/sandbox";
import { PLACE_REFUSED_RETRY, REASSIGN_RETRY, reassignRetry, retryAfter } from "../src/lib/retry";
import { adminJson, connectHost, runDue, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));

describe("reassignRetry (pure)", () => {
  const p = { first_ms: 10, max_ms: 35, max_attempts: 3 };
  it("only refusals count toward giving up; a call that never landed is retried for ever, its backoff capped", () => {
    // [attempts, refusals, refused] -> [attempts, refusals, next]
    const table: [number, number, boolean, number, number, { at_ms: number } | { gave_up: true }][] = [
      [0, 0, true, 1, 1, { at_ms: 1010 }],
      [1, 1, true, 2, 2, { at_ms: 1020 }],
      [2, 2, true, 3, 3, { gave_up: true }],
      [0, 0, false, 1, 0, { at_ms: 1010 }],
      [9, 0, false, 10, 0, { at_ms: 1035 }],
      [500, 0, false, 501, 0, { at_ms: 1035 }],
      // Refused twice, then lost: not given up, whatever the attempts.
      [7, 2, false, 8, 2, { at_ms: 1035 }],
      // The third refusal gives up, even after many lost calls.
      [40, 2, true, 41, 3, { gave_up: true }],
    ];
    for (const [attempts, refusals, refused, a, r, next] of table) {
      expect(reassignRetry({ attempts, refusals, refused }, 1000, p), `${attempts}/${refusals}/${refused}`).toEqual({ attempts: a, refusals: r, next });
    }
  });
});

describe("retryAfter (pure)", () => {
  it("doubles from the first wait up to the cap, and gives up at the last attempt", () => {
    const p = { first_ms: 10, max_ms: 35, max_attempts: 5 };
    expect([1, 2, 3, 4].map((n) => retryAfter(n, 1000, p))).toEqual([{ at_ms: 1010 }, { at_ms: 1020 }, { at_ms: 1035 }, { at_ms: 1035 }]);
    expect(retryAfter(5, 1000, p)).toEqual({ gave_up: true });
    expect(retryAfter(9, 1000, p)).toEqual({ gave_up: true });
  });
  it("the two policies end in under an hour", () => {
    const total = (p: typeof REASSIGN_RETRY) => {
      let t = 0;
      for (let n = 1; ; n++) {
        const r = retryAfter(n, t, p);
        if ("gave_up" in r) return t;
        t = r.at_ms;
      }
    };
    expect(total(REASSIGN_RETRY)).toBeLessThan(3_600_000);
    expect(total(PLACE_REFUSED_RETRY)).toBeLessThan(3_600_000);
  });
});

/** A sandbox placed on a connected host, whose lease FleetDO then holds at another epoch (the leases disagree). */
async function diverged() {
  const cell = uniqueCell();
  const a = await connectHost(cell);
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  expect(sbx.host).toBe(a.host);
  await runInDurableObject(fleetStub(cell), (_i, st) => {
    st.storage.sql.exec("UPDATE leases SET epoch = 7 WHERE sandbox = ?", sbx.sandbox);
  });
  return { cell, host: a.host as string, sandbox: sbx.sandbox as string };
}
const reassignment = (cell: string, sandbox: string) => runInDurableObject(fleetStub(cell), (_i, st) =>
  st.storage.sql.exec<{ attempts: number; refusals: number; next_ms: number | null; gave_up_ms: number | null }>(
    "SELECT attempts, refusals, next_ms, gave_up_ms FROM reassignments WHERE sandbox = ?", sandbox).toArray()[0] ?? null);
/** Run FleetDO's tick now, with every reassignment's backoff passed. */
async function tickDue(cell: string) {
  await runInDurableObject(fleetStub(cell), (_i, st) => {
    st.storage.sql.exec("UPDATE reassignments SET next_ms = 0 WHERE next_ms IS NOT NULL");
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDue(fleetStub(cell));
}

describe("a refused placement and its reassignment", () => {
  it("a reassignment refused again and again gives up at the cap; the sandbox keeps its own count and gives up on its own deadline; an operator's placement ends both", async () => {
    const d = await diverged();
    // Its host's lease is lost (as an expiry queues it): FleetDO tells SandboxDO, whose new placement is refused.
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead) VALUES (?, ?, 1, 1)", d.sandbox, d.host);
    });
    await tickDue(d.cell);
    const first = await reassignment(d.cell, d.sandbox);
    expect(first).toMatchObject({ attempts: 1, refusals: 1, gave_up_ms: null });
    // The next try waits its backoff (not the next 5 s tick).
    expect(first!.next_ms! - Date.now()).toBeGreaterThan(REASSIGN_RETRY.first_ms - 2_000);
    const view = await adminJson(`/v1/sandboxes/${d.sandbox}`);
    expect(view.host).toBeNull();
    // Noted on the sandbox, not counted there: FleetDO's tries are FleetDO's.
    expect(view.placement_refused).toMatchObject({ count: 0, gave_up: false, reason: expect.stringContaining("already holds a lease") });

    for (let i = 2; i <= REASSIGN_RETRY.max_attempts; i++) await tickDue(d.cell);
    const last = await reassignment(d.cell, d.sandbox);
    expect(last).toMatchObject({ attempts: REASSIGN_RETRY.max_attempts, refusals: REASSIGN_RETRY.max_attempts, next_ms: null });
    expect(last!.gave_up_ms).toBeGreaterThan(0);
    // Given up: no more tries, however often the tick runs.
    await tickDue(d.cell);
    expect((await reassignment(d.cell, d.sandbox))!.attempts).toBe(REASSIGN_RETRY.max_attempts);
    // Ten FleetDO tries didn't use up the sandbox's own six: it still retries on its own deadline.
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused).toMatchObject({ count: 0, gave_up: false });
    const ownTry = async () => {
      await runInDurableObject(sandboxStub(d.sandbox), (_i, st) => {
        st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'");
      });
      await runDue(sandboxStub(d.sandbox));
    };
    for (let i = 1; i <= PLACE_REFUSED_RETRY.max_attempts; i++) {
      await ownTry();
      expect((await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused).toMatchObject({ count: i, gave_up: i === PLACE_REFUSED_RETRY.max_attempts });
    }
    expect(await runInDurableObject(sandboxStub(d.sandbox), (_i, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'place'").toArray().length)).toBe(0);

    // The operator's try while the leases still disagree: refused, and the count starts again from it.
    await adminJson(`/v1/sandboxes/${d.sandbox}/place`, { body: {} }, 409);
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused).toMatchObject({ count: 1, gave_up: false });
    // The operator clears the divergence and places it: placed; its refusal and the stuck row go.
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", d.sandbox);
    });
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}/place`, { body: {} })).host).toBe(d.host);
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused).toBeUndefined();
    expect(await reassignment(d.cell, d.sandbox)).toBeNull();
  });

  it("a leaseLost that never lands is retried for ever, never given up: once it lands the sandbox is placed again", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead) VALUES (?, ?, 1, 0)", sbx.sandbox, a.host);
    });
    // SandboxDO can't be reached (as through a long outage): every call fails before it does anything.
    const proto = SandboxDO.prototype as unknown as { leaseLost: (...x: unknown[]) => Promise<void> };
    const real = proto.leaseLost;
    proto.leaseLost = async () => {
      throw new Error("Network connection lost.");
    };
    try {
      for (let i = 1; i <= REASSIGN_RETRY.max_attempts + 3; i++) await tickDue(cell);
    } finally {
      proto.leaseLost = real;
    }
    const row = await reassignment(cell, sbx.sandbox);
    expect(row).toMatchObject({ attempts: REASSIGN_RETRY.max_attempts + 3, refusals: 0, gave_up_ms: null });
    expect(row!.next_ms! - Date.now()).toBeLessThanOrEqual(REASSIGN_RETRY.max_ms);
    // FleetDO's lease went at the first try; SandboxDO still names the host until the call lands.
    expect((await adminJson(`/v1/sandboxes/${sbx.sandbox}`)).host).toBe(a.host);
    await tickDue(cell);
    expect(await reassignment(cell, sbx.sandbox)).toBeNull();
    expect(await adminJson(`/v1/sandboxes/${sbx.sandbox}`)).toMatchObject({ host: a.host, epoch: 2 });
  });

  it("a refused placement retries itself on its own deadline, with backoff, and is placed once the cause goes", async () => {
    const d = await diverged();
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead) VALUES (?, ?, 1, 0)", d.sandbox, d.host);
    });
    await tickDue(d.cell);
    const at = await runInDurableObject(sandboxStub(d.sandbox), (_i, st) =>
      st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = 'place'").toArray()[0]?.at ?? null);
    expect(at! - Date.now()).toBeGreaterThan(PLACE_REFUSED_RETRY.first_ms - 2_000);
    // The divergence goes; the sandbox's own deadline places it.
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", d.sandbox);
    });
    await runInDurableObject(sandboxStub(d.sandbox), (_i, st) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'place'");
    });
    await runDue(sandboxStub(d.sandbox));
    const view = await adminJson(`/v1/sandboxes/${d.sandbox}`);
    expect(view.host).toBe(d.host);
    expect(view.placement_refused).toBeUndefined();
    // Gone from the record too, not only hidden: a later move off its host shows no stale refusal.
    expect(await runInDurableObject(sandboxStub(d.sandbox), (_i, st) =>
      st.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'placement_refused'").toArray().length)).toBe(0);
  });
});

describe("a reassignment that gave up", () => {
  /** A cell with nothing in it but one dead, lost host of long ago and a reassignment from it. */
  async function stuck(gaveUp: boolean) {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    a.ws.close();
    await runInDurableObject(fleetStub(cell), (_i, st) => {
      const sql = st.storage.sql;
      sql.exec("UPDATE hosts SET status = 'dead', lost = 1, dead_ms = 1, tunnel_id = NULL, dns_record_id = NULL, instance_id = NULL WHERE host = ?", a.host);
      sql.exec("DELETE FROM leases");
      sql.exec("DELETE FROM host_agents");
      sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead, attempts, refusals, next_ms, gave_up_ms) VALUES ('sbx_stuck', ?, 1, 1, 10, 10, ?, ?)",
        a.host, gaveUp ? null : Date.now() + 3_600_000, gaveUp ? Date.now() : null);
      sql.exec("DELETE FROM kv WHERE key = 'pruned_ms'");
      sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    });
    await runDue(fleetStub(cell));
    return runInDurableObject(fleetStub(cell), (_i, st) => ({
      tick: st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'tick'").toArray().length,
      host: st.storage.sql.exec("SELECT 1 FROM hosts WHERE host = ?", a.host).toArray().length,
    }));
  }

  it("neither keeps the tick armed nor its dead host's record; one still retrying keeps both", async () => {
    expect(await stuck(true)).toEqual({ tick: 0, host: 0 });
    expect(await stuck(false)).toEqual({ tick: 1, host: 1 });
  });

  it("goes when its sandbox is destroyed", async () => {
    const d = await diverged();
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead, gave_up_ms) VALUES (?, ?, 1, 1, ?)", d.sandbox, d.host, Date.now());
    });
    await adminJson(`/v1/sandboxes/${d.sandbox}`, { method: "DELETE" });
    expect(await reassignment(d.cell, d.sandbox)).toBeNull();
  });
});
