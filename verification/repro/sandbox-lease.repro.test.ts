// Reproductions of the TLA+ counterexamples in verification/tla/sandbox-lease/ against the real
// SandboxDO and FleetDO (vitest-pool-workers). NOT wired into any suite: copy it into
// control-plane/test/ to run it, then delete the copy. Each test asserts the behaviour on main
// (the bug); the comment says what the protocol promises instead.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adminJson, connectHost, manifest, nextCommands, sendEvents, sleep, uniqueCell } from "./helpers";

const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));

describe("TLA+ counterexamples (sandbox lease)", () => {
  // MCB1: a holder self-fences, the re-placement finds no capacity and rolls the epoch back to
  // the lost one (sandbox.ts:312), so the holder's salvage at that epoch fails `ev.epoch <
  // info.epoch` (:575) and is refused as stale_epoch (:585), which nestd treats as final.
  // Promised: the salvage becomes an orphaned generation (docs: "only from the host that held it").
  it("B1: salvage from the epoch's own holder is refused after a no-capacity rollback", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell); // 8192 MiB hugepage pool: room for two default sandboxes
    const { workstream } = await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "repro" } }, 201);
    const s1 = await adminJson<{ sandbox: string; host: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    const s2 = await adminJson<{ sandbox: string; host: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    expect([s1.host, s2.host]).toEqual([a.host, a.host]);
    // Both run; the pool is full.
    let seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 4, memory_mib_free: 8192, hugepages_mib_free: 0, hugepages_mib_total: 8192, sandboxes: 2, agents: 0, warm: [] } },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    // The holder self-fences s1 (its host lease lapsed): FleetDO reassigns at once; nothing fits.
    seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "fenced" }]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    await sleep(50);
    const info = await sandboxStub(s1.sandbox).info();
    expect(info.host).toBeNull();
    expect(info.epoch, "the claimed epoch 2 was rolled back to the lost epoch 1").toBe(1);
    // The fenced incarnation's salvage arrives next on the same channel.
    sendEvents(a.ws, [{ ts_ms: Date.now(), type: "commit_request", request: "req_salv", sandbox: s1.sandbox, epoch: 1,
      kind: "disk_only", disk_manifest: manifest("e"), reason: "salvage" }]);
    const [r] = await nextCommands(a.ws, (c) => c.type === "commit_result" && c.request === "req_salv");
    // Bug: refused for good (nestd deletes the disk). Expected: { status: "orphaned" }.
    expect(r.outcome).toMatchObject({ status: "rejected", reason: "stale_epoch" });
  });

  // MCB2: destroy() doesn't clear `placing`, and the placement continuation checks only
  // `i.placing === epoch` (sandbox.ts:305), so it writes host/state over `destroyed`.
  // Promised: destroyed is terminal and no lease outlives it.
  // The race window is SandboxDO's `await fleet.place(...)` (sandbox.ts:287). Miniflare answers
  // that RPC too fast to interleave a second call, so the test holds the await open by wrapping
  // the instance's FleetDO stub (real SandboxDO and FleetDO code; only the await's timing is
  // controlled): `served` lets FleetDO grant before the hold (a slow answer), otherwise the
  // request itself is held (a slow request).
  for (const served of [true, false]) {
    it(`B2: a destroy during an in-flight placement is undone (${served ? "answer" : "request"} held)`, async () => {
      const cell = uniqueCell();
      const { workstream } = await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "repro" } }, 201);
      // No host yet: the sandbox is created unplaced (the no-capacity path).
      const s = await adminJson<{ sandbox: string; host: string | null }>("/v1/sandboxes", { body: { workstream, cell } }, 202);
      const a = await connectHost(cell);
      const stub = sandboxStub(s.sandbox);
      await runInDurableObject(stub, async (inst: any) => {
        const realFleet = inst.fleet.bind(inst);
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        inst.fleet = (c: string) => {
          const f = realFleet(c);
          return new Proxy(f, {
            get(t: any, p: string | symbol) {
              if (p === "then") return undefined;
              if (p === "place") {
                return async (req: unknown) => {
                  if (served) { const h = await t.place(req); await gate; return h; }
                  await gate;
                  return t.place(req);
                };
              }
              return (...args: unknown[]) => t[p](...args);
            },
          });
        };
        const woke = inst.wake().catch((e: unknown) => e);
        await sleep(20);
        await inst.destroy(); // returns: the operator sees the sandbox destroyed
        expect((await inst.info()).state).toBe("destroyed");
        open();
        await woke;
      });
      await sleep(20);
      const info = await stub.info();
      const lease = await fleetStub(cell).leaseOf(s.sandbox);
      console.log(`B2 (${served ? "answer" : "request"} held)`, JSON.stringify({ state: info.state, host: info.host, epoch: info.epoch, lease }));
      // Bug. Expected: state "destroyed", host null, no lease.
      expect({ state: info.state, host: info.host }).toEqual({ state: "creating", host: a.host });
      if (!served) expect(lease?.host, "a lease granted after releaseLease outlives the destroy").toBe(a.host);
    });
  }
});
