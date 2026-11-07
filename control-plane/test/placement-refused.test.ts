// A placement FleetDO refuses (the leases disagree) and the lost-lease reassignment that runs into it
// (state-machine sweep, bug 9): each retried with backoff, then given up visibly, never a 5 s loop for
// ever; an operator's placement ends both. The pure step first.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { PLACE_REFUSED_RETRY, REASSIGN_RETRY, retryAfter } from "../src/lib/retry";
import { adminJson, connectHost, runDue, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));

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
  st.storage.sql.exec<{ attempts: number; next_ms: number | null; gave_up_ms: number | null }>(
    "SELECT attempts, next_ms, gave_up_ms FROM reassignments WHERE sandbox = ?", sandbox).toArray()[0] ?? null);
/** Run FleetDO's tick now, with every reassignment's backoff passed. */
async function tickDue(cell: string) {
  await runInDurableObject(fleetStub(cell), (_i, st) => {
    st.storage.sql.exec("UPDATE reassignments SET next_ms = 0 WHERE next_ms IS NOT NULL");
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
  });
  await runDue(fleetStub(cell));
}

describe("a refused placement and its reassignment", () => {
  it("the reassignment retries with backoff, gives up at the cap, and the sandbox says so; an operator's placement ends both", async () => {
    const d = await diverged();
    // Its host's lease is lost (as an expiry queues it): FleetDO tells SandboxDO, whose new placement is refused.
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("INSERT INTO reassignments (sandbox, host, epoch, host_dead) VALUES (?, ?, 1, 1)", d.sandbox, d.host);
    });
    await tickDue(d.cell);
    const first = await reassignment(d.cell, d.sandbox);
    expect(first).toMatchObject({ attempts: 1, gave_up_ms: null });
    // The next try waits its backoff (not the next 5 s tick).
    expect(first!.next_ms! - Date.now()).toBeGreaterThan(REASSIGN_RETRY.first_ms - 2_000);
    const view = await adminJson(`/v1/sandboxes/${d.sandbox}`);
    expect(view.host).toBeNull();
    expect(view.placement_refused).toMatchObject({ count: 1, gave_up: false, reason: expect.stringContaining("already holds a lease") });

    for (let i = 2; i <= REASSIGN_RETRY.max_attempts; i++) await tickDue(d.cell);
    const last = await reassignment(d.cell, d.sandbox);
    expect(last).toMatchObject({ attempts: REASSIGN_RETRY.max_attempts, next_ms: null });
    expect(last!.gave_up_ms).toBeGreaterThan(0);
    // Given up: no more tries, however often the tick runs.
    await tickDue(d.cell);
    expect((await reassignment(d.cell, d.sandbox))!.attempts).toBe(REASSIGN_RETRY.max_attempts);
    const refused = (await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused;
    expect(refused.gave_up).toBe(true);
    expect(refused.count).toBeGreaterThanOrEqual(PLACE_REFUSED_RETRY.max_attempts);
    expect(await runInDurableObject(sandboxStub(d.sandbox), (_i, st) => st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'place'").toArray().length)).toBe(0);

    // The operator clears the divergence and places it: the sandbox is placed, its refusal and the stuck row go.
    await runInDurableObject(fleetStub(d.cell), (_i, st) => {
      st.storage.sql.exec("DELETE FROM leases WHERE sandbox = ?", d.sandbox);
    });
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}/place`, { body: {} })).host).toBe(d.host);
    expect((await adminJson(`/v1/sandboxes/${d.sandbox}`)).placement_refused).toBeUndefined();
    expect(await reassignment(d.cell, d.sandbox)).toBeNull();
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
