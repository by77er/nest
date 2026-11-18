// Placement packs (docs/compute/autoscaling/): a host takes sandboxes until its reported hugepages
// and vCPUs, less what unreported leases reserve, no longer fit; then the next host; an empty host
// always takes one. And the operator views the dashboard reads: the fleet view with residents and
// capacity, and the cell's images.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { Ec2, ImageInfo } from "../src/lib/ec2";
import { pickSandboxHost, type SandboxHostFacts } from "../src/lib/placement";
import { adminJson, connectHost, enrollHost, hostHello, sendEvents, uniqueCell, Ws } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
type HostView = { host: string; leases: number; capacity: Record<string, unknown> | null; tunnel_state: string | null;
  sandboxes: { sandbox: string; epoch: number; state: string | null; vcpus: number | null; memory_mib: number | null }[]; agents: string[] };
type FleetView = { hosts: HostView[]; launches: Record<string, unknown>[]; sandboxes: { sandbox: string; host: string | null; epoch: number | null }[] };
const view = async (cell: string) => (await fleetStub(cell).fleetView()) as unknown as FleetView;

async function place(cell: string, status = 201) {
  return adminJson<{ sandbox: string; host: string | null }>("/v1/sandboxes", { body: { cell } }, status);
}

/** A connected sandbox host whose hello reports the given capacity. */
async function hostWithCapacity(cell: string, capacity: Record<string, unknown>) {
  const enrolled = await enrollHost(cell, "sandbox");
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, { capacity: { vcpus_free: 8, memory_mib_free: 16384, hugepages_mib_free: 8192, hugepages_mib_total: capacity.hugepages_mib_free ?? 8192, sandboxes: 0, agents: 0, warm: [], ...capacity } }));
  await ws.next("hello_ack");
  return { host: enrolled.host, ws };
}

describe("placement packs", () => {
  it("fills a host up to its hugepages before opening the next, and leaves the rest unplaced", async () => {
    const cell = uniqueCell();
    // 8192 MiB of hugepages each: room for two default sandboxes (4096 MiB) per host.
    const a = await connectHost(cell);
    const b = await connectHost(cell);
    const s1 = await place(cell);
    const s2 = await place(cell);
    const s3 = await place(cell);
    const s4 = await place(cell);
    expect([s1.host, s2.host], "the first host fills first").toEqual([a.host, a.host]);
    expect([s3.host, s4.host], "then the second").toEqual([b.host, b.host]);
    const s5 = await place(cell, 202);
    expect(s5.host, "nothing fits: unplaced, not squeezed on").toBeNull();
    const v = await view(cell);
    expect(v.hosts.map((h) => h.leases)).toEqual([2, 2]);
    expect(v.sandboxes.filter((s) => s.host === null).map((s) => s.sandbox)).toEqual([s5.sandbox]);
  });

  it("a capacity report after the leases' first states ends their reservation; the host's report then rules", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s1 = await place(cell);
    const s2 = await place(cell);
    expect([s1.host, s2.host]).toEqual([a.host, a.host]);
    expect((await place(cell, 202)).host).toBeNull();
    // The host counts both sandboxes and still reports room for one more.
    const seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 4, memory_mib_free: 8192, hugepages_mib_free: 4096, hugepages_mib_total: 8192, sandboxes: 2, agents: 0, warm: [] } },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell)).host, "the report's free hugepages admit a third").toBe(a.host);
    expect((await place(cell, 202)).host, "and no more").toBeNull();
  });

  it("an empty host takes a sandbox larger than its pool; a second one does not join it", async () => {
    const cell = uniqueCell();
    const small = await hostWithCapacity(cell, { hugepages_mib_free: 1952, vcpus_free: 2 });
    expect((await place(cell)).host, "placed alone, overcommitted as before packing").toBe(small.host);
    expect((await place(cell, 202)).host, "the host is spoken for").toBeNull();
    const big = await hostWithCapacity(cell, { hugepages_mib_free: 8192, vcpus_free: 8 });
    expect((await place(cell)).host).toBe(big.host);
  });
});

describe("placement under the commit rule", () => {
  // The cell's `memory_commit_pct` reaches the packing: FleetDO counts what a host's sandboxes may
  // grow to (declared size + 128 MiB each) against the size the host reports, less its reserve.
  it("a host takes sandboxes up to the cell's percent of its memory, and one that doesn't say its size takes none", async () => {
    const cell = uniqueCell();
    await runInDurableObject(fleetStub(cell), async (inst: FleetDO) => {
      inst.cellConfigOverride = {
        region: "us-east-1", launch_template_id: "lt-0abc", subnet_ids: ["subnet-0a"], instance_types: ["m8id.large"], spot: true,
        // No host is launched here: the cell is at its maximum.
        max_hosts: 0, idle_grace_ms: 60_000, enroll_timeout_ms: 600_000, sandbox_reserve_mib: 768, max_sandboxes_per_host: 0,
        memory_commit_pct: 100, host_reserve_mib: 768,
      };
    });
    const regular = { hugepages_mib_free: 0, hugepages_mib_total: 0, vcpus_free: 2 };
    // Plenty free, but it is a nestd from before `memory_mib_total`: nothing bounds its guests.
    await hostWithCapacity(cell, { ...regular, memory_mib_free: 15000 });
    expect((await place(cell, 202)).host, "a host that doesn't say its size takes none").toBeNull();
    // 8 GiB: one default sandbox (4096 + 128 <= 7900 - 768), not two (8448 > 7132), whatever is free.
    const sized = await hostWithCapacity(cell, { ...regular, memory_mib_free: 7200, memory_mib_total: 7900 });
    expect((await place(cell)).host).toBe(sized.host);
    expect((await place(cell, 202)).host, "a second would commit 8448 MiB of 7132").toBeNull();
  });
});

describe("placement on regular pages", () => {
  // No hugepage pool: a sandbox reserves the cell's `sandbox_reserve_mib` (768 by default)
  // against the host's free memory until the host counts it; its declared 4096 MiB is a ceiling.
  it("packs by free memory: a 2.5 GiB host takes three default sandboxes, not a fourth", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 2560, vcpus_free: 2 });
    const placed = [await place(cell), await place(cell), await place(cell)];
    expect(placed.map((p) => p.host), "three fit: 2560 - 2*768 = 1024 >= 768").toEqual([a.host, a.host, a.host]);
    expect((await place(cell, 202)).host, "the fourth would leave less than a reserve").toBeNull();
  });

  it("a burst of placements keeps its reservations until a capacity report made after the sandboxes reported", async () => {
    const cell = uniqueCell();
    // Room for two reserves (2000 - 768 = 1232 >= 768), not three (2000 - 2*768 = 464).
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 2000, vcpus_free: 2 });
    const s1 = await place(cell);
    const s2 = await place(cell);
    expect([s1.host, s2.host]).toEqual([a.host, a.host]);
    // nestd reports state at once, capacity at most every 30 s: the stale report counts neither.
    let seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "creating" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, 202)).host, "still reserved: the last report predates both").toBeNull();
    // A report made since counts them; its free memory rules.
    seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 2, memory_mib_free: 2000, hugepages_mib_free: 0, hugepages_mib_total: 0, sandboxes: 2, agents: 0, warm: [] } }]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell)).host).toBe(a.host);
  });

  it("declared vCPUs are a shape, not a reservation: a 2 vCPU host takes several 2 vCPU sandboxes", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 8192, vcpus_free: 2 });
    for (let i = 0; i < 5; i++) expect((await place(cell)).host).toBe(a.host);
  });

  it("the host's report rules once it counts a sandbox: a report with less room stops placement", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 4096, vcpus_free: 2 });
    const s1 = await place(cell);
    expect(s1.host).toBe(a.host);
    const seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 0, memory_mib_free: 500, hugepages_mib_free: 0, hugepages_mib_total: 0, sandboxes: 1, agents: 0, warm: [] } },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, 202)).host, "500 MiB free is under a reserve").toBeNull();
  });

  it("a hugepage host keeps the pool rule: the declared size counts against the pool", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 8192, hugepages_mib_total: 8192, memory_mib_free: 16384, vcpus_free: 8 });
    expect([(await place(cell)).host, (await place(cell)).host]).toEqual([a.host, a.host]);
    expect((await place(cell, 202)).host, "two 4096 MiB sandboxes fill an 8192 MiB pool").toBeNull();
  });
});

describe("operator views", () => {
  it("a sandbox without a lease shows its own state, not 'unplaced'", async () => {
    const cell = uniqueCell();
    const s1 = await place(cell, 202); // no host at all
    const v = await view(cell);
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox: s1.sandbox, host: null })]);
    const row = v.sandboxes[0] as unknown as { state: string | null; image: string };
    expect(row.state, "the SandboxDO's own state").not.toBeNull();
    expect(row.image).toBe("nest-base:latest");
  });

  it("the fleet view lists each host's residents, brains and capacity, and every live sandbox", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const s1 = await place(cell);
    const v = await view(cell);
    const h = v.hosts.find((x) => x.host === a.host)!;
    expect(h.capacity).toMatchObject({ hugepages_mib_free: 8192, vcpus_free: 8 });
    expect(h.sandboxes).toEqual([{ sandbox: s1.sandbox, epoch: 1, state: null, vcpus: 2, memory_mib: 4096 }]);
    expect(h.agents).toEqual([]);
    expect(h.tunnel_state).toBe("none");
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox: s1.sandbox, host: a.host, epoch: 1, image: "nest-base:latest" })]);
    const viaApi = await adminJson<FleetView>(`/v1/admin/fleet?cell=${cell}`);
    expect(viaApi.hosts[0]!.sandboxes).toEqual(h.sandboxes);
  });

  it("the images view names the AMI the launch template resolves to, newest first", async () => {
    const cell = uniqueCell();
    const images: ImageInfo[] = [
      { image_id: "ami-old", name: "nest-use1-host-2026-10-20", created: "2026-10-20T10:00:00.000Z", state: "available", size_gib: 30, tags: { nest: "true" } },
      { image_id: "ami-new", name: "nest-use1-host-2026-10-23", created: "2026-10-23T10:00:00.000Z", state: "available", size_gib: 30, tags: { nest: "true" } },
    ];
    const ec2: Ec2 = { launch: async () => "i-0", terminate: async () => {}, state: async () => null, images: async () => images };
    await runInDurableObject(fleetStub(cell), (inst: FleetDO) => {
      inst.ec2Override = ec2;
      inst.ssmOverride = { parameter: async (name: string) => (name === `/imagebuilder/nest-${cell}/host-ami` ? { value: "ami-new", modified_ms: 1760000000000 } : null) };
    });
    await connectHost(cell); // registers the cell name the parameter is named after
    const v = await adminJson<{ current: string | null; current_since_ms: number | null; images: ImageInfo[] }>(`/v1/admin/images?cell=${cell}`);
    expect(v.current).toBe("ami-new");
    expect((v as unknown as { templates: { name: string; default: boolean }[] }).templates).toEqual([expect.objectContaining({ name: "nest-base:latest", default: true })]);
    expect(v.current_since_ms).toBe(1760000000000);
    expect(v.images.map((i) => i.image_id)).toEqual(["ami-old", "ami-new"]);
  });
});

/** A small deterministic generator (mulberry32), so a failing property names its seed. */
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

describe("pickSandboxHost", () => {
  const need = { vcpus: 2, memory_mib: 2048 };
  const cfg = { reserve_mib: 768, max_per_host: 0 };
  const cap = (memory: number, huge = 0, vcpus = 8) =>
    ({ vcpus_free: vcpus, memory_mib_free: memory, hugepages_mib_free: huge, hugepages_mib_total: huge, sandboxes: 0, agents: 0, warm: [] });
  const lease = (state: string | null = "running", state_seq: number | null = 1) => ({ state, state_seq, vcpus: 2, memory_mib: 2048 });
  const host = (id: string, f: Partial<SandboxHostFacts> = {}): SandboxHostFacts => ({ host: id, capacity: cap(16384), capacity_seq: 5, leases: [], warm: false, ...f });

  it("prefers a warm snapshot, then the fullest host that fits", () => {
    expect(pickSandboxHost([host("hst_a", { capacity: cap(4000) }), host("hst_b", { capacity: cap(9000) })], need, cfg)).toBe("hst_a");
    expect(pickSandboxHost([host("hst_a", { capacity: cap(4000) }), host("hst_b", { capacity: cap(9000), warm: true })], need, cfg)).toBe("hst_b");
    // Leases since the last capacity report reserve their share; one it already counts doesn't.
    expect(pickSandboxHost([host("hst_a", { capacity: cap(1500), leases: [lease(null)] })], need, cfg)).toBeNull();
    expect(pickSandboxHost([host("hst_a", { capacity: cap(1500), leases: [lease("running", 1)] })], need, cfg)).toBe("hst_a");
    expect(pickSandboxHost([host("hst_a", { leases: [lease()] })], need, { ...cfg, max_per_host: 1 })).toBeNull();
    // A hugepage host counts declared sizes against its pool.
    expect(pickSandboxHost([host("hst_a", { capacity: cap(16384, 2047), leases: [lease()] })], need, cfg)).toBeNull();
    expect(pickSandboxHost([host("hst_a", { capacity: cap(16384, 2048), leases: [lease()] })], need, cfg)).toBe("hst_a");
  });

  describe("the commit rule", () => {
    // 150% of a host's memory less 768 MiB for the host; a guest costs its declared size + 128 MiB.
    const rule = { ...cfg, host_reserve_mib: 768, commit_pct: 150 };
    const sized = (total: number, free = total - 700) => ({ ...cap(free), memory_mib_total: total });
    const guest = (memory_mib: number | null = 4096) => ({ state: "running", state_seq: 1, vcpus: 2, memory_mib });
    const big = { vcpus: 2, memory_mib: 4096 };

    it("refuses what free memory admits: six 4 GiB guests on a 4 GiB host (2026-11-18)", () => {
      // Idle guests touch little, so the host still reports room; without the rule it takes more.
      const packed = host("hst_a", { capacity: sized(3900, 1351), leases: Array.from({ length: 6 }, () => guest()) });
      expect(pickSandboxHost([packed], big, cfg)).toBe("hst_a");
      expect(pickSandboxHost([packed], big, rule)).toBeNull();
    });

    it("alone: an empty host never takes a guest it could not hold", () => {
      const small = host("hst_a", { capacity: sized(3900) });
      expect(pickSandboxHost([small], big, cfg)).toBe("hst_a");
      expect(pickSandboxHost([small], big, rule)).toBeNull(); // 4224 > 3900 - 768
      expect(pickSandboxHost([small], need, rule)).toBe("hst_a"); // 2176 <= 3132
      // The boundary: the guest and its overhead exactly fill the host less its reserve.
      expect(pickSandboxHost([host("hst_a", { capacity: sized(4096 + 128 + 768) })], big, rule)).toBe("hst_a");
      expect(pickSandboxHost([host("hst_a", { capacity: sized(4096 + 128 + 768 - 1) })], big, rule)).toBeNull();
    });

    it("together: declared sizes add up to the cell's percent of the host and no further", () => {
      // 16 GiB: (15900 - 768) * 1.5 = 22698, and 5 * 4224 = 21120 fit where 6 * 4224 = 25344 don't.
      const with_ = (n: number) => host("hst_a", { capacity: sized(15900), leases: Array.from({ length: n }, () => guest()) });
      expect(pickSandboxHost([with_(4)], big, rule)).toBe("hst_a");
      expect(pickSandboxHost([with_(5)], big, rule)).toBeNull();
      // At 100% the same host holds three: 3 * 4224 = 12672 <= 15132 < 4 * 4224.
      expect(pickSandboxHost([with_(2)], big, { ...rule, commit_pct: 100 })).toBe("hst_a");
      expect(pickSandboxHost([with_(3)], big, { ...rule, commit_pct: 100 })).toBeNull();
      // A lease with no recorded size (from before sizes were stored) counts as the one being placed.
      const unsized = host("hst_a", { capacity: sized(15900), leases: Array.from({ length: 5 }, () => guest(null)) });
      expect(pickSandboxHost([unsized], big, rule)).toBeNull();
      expect(pickSandboxHost([unsized], need, rule)).toBe("hst_a"); // 6 * 2176 = 13056
      // A smaller guest still fits beside five big ones: 21120 + 1152 <= 22698.
      expect(pickSandboxHost([with_(5)], { vcpus: 1, memory_mib: 1024 }, rule)).toBe("hst_a");
    });

    it("a host that doesn't say its size takes nothing more, empty or not", () => {
      expect(pickSandboxHost([host("hst_old")], big, rule)).toBeNull();
      expect(pickSandboxHost([host("hst_old", { capacity: null })], big, rule)).toBeNull();
      expect(pickSandboxHost([host("hst_old", { capacity: { ...cap(16384), memory_mib_total: 0 } })], big, rule)).toBeNull();
      // Another host that does say takes it.
      expect(pickSandboxHost([host("hst_old"), host("hst_new", { capacity: sized(15900) })], big, rule)).toBe("hst_new");
    });

    it("free memory and the per-host cap still count", () => {
      const full = host("hst_a", { capacity: sized(15900, 700), leases: [guest()] });
      expect(pickSandboxHost([full], big, rule)).toBeNull(); // 700 MiB free < the 768 reserve
      expect(pickSandboxHost([host("hst_a", { capacity: sized(15900), leases: [guest()] })], big, { ...rule, max_per_host: 1 })).toBeNull();
    });

    it("property: no pick ever commits a host beyond the rule, and off changes nothing", () => {
      for (let seed = 1; seed <= 500; seed++) {
        const r = rng(seed);
        const hosts = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => host(`hst_${i}`, {
          capacity: r() < 0.1 ? null : { ...cap(Math.floor(r() * 16000)), ...(r() < 0.2 ? {} : { memory_mib_total: 2000 + Math.floor(r() * 30000) }) },
          leases: Array.from({ length: Math.floor(r() * 7) }, () => guest(r() < 0.2 ? null : 1024 * (1 + Math.floor(r() * 8)))),
        }));
        const want = { vcpus: 2, memory_mib: 1024 * (1 + Math.floor(r() * 8)) };
        const c = { ...cfg, host_reserve_mib: Math.floor(r() * 1500), commit_pct: 50 + Math.floor(r() * 200) };
        const picked = pickSandboxHost(hosts, want, c);
        if (picked) {
          const h = hosts.find((x) => x.host === picked)!;
          const usable = h.capacity!.memory_mib_total! - c.host_reserve_mib;
          const committed = h.leases.reduce((sum, l) => sum + (l.memory_mib ?? want.memory_mib) + 128, 0) + want.memory_mib + 128;
          expect(want.memory_mib + 128, `seed ${seed}`).toBeLessThanOrEqual(usable);
          expect(committed * 100, `seed ${seed}`).toBeLessThanOrEqual(usable * c.commit_pct);
        }
        // Off (0, or the setting absent), the pick is the one without the rule.
        expect(pickSandboxHost(hosts, want, { ...c, commit_pct: 0 }), `seed ${seed}`).toBe(pickSandboxHost(hosts, want, cfg));
      }
    });
  });

  it("property: an empty host always fits, a pick always fits, and no pick means none fits", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const hosts = Array.from({ length: Math.floor(r() * 4) }, (_, i) => host(`hst_${i}`, {
        capacity: r() < 0.15 ? null : cap(Math.floor(r() * 8000), r() < 0.4 ? Math.floor(r() * 6000) : 0, Math.floor(r() * 6)),
        capacity_seq: Math.floor(r() * 4),
        leases: Array.from({ length: Math.floor(r() * 3) }, () => lease(r() < 0.3 ? null : "running", Math.floor(r() * 4))),
        warm: r() < 0.2,
      }));
      const c = { reserve_mib: 768, max_per_host: Math.floor(r() * 3) };
      const picked = pickSandboxHost(hosts, need, c);
      const fits = (h: SandboxHostFacts) => pickSandboxHost([h], need, c) === h.host;
      if (hosts.some((h) => h.leases.length === 0)) expect(picked, `seed ${seed}`).not.toBeNull();
      if (picked) expect(fits(hosts.find((h) => h.host === picked)!), `seed ${seed}`).toBe(true);
      else expect(hosts.some(fits), `seed ${seed}`).toBe(false);
      // Warm first: a warm host that fits beats every cold one.
      if (hosts.some((h) => h.warm && fits(h))) expect(hosts.find((h) => h.host === picked)!.warm, `seed ${seed}`).toBe(true);
    }
  });
});
