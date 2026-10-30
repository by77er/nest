// Placement packs (docs/compute/autoscaling/): a host takes sandboxes until its reported hugepages
// and vCPUs, less what unreported leases reserve, no longer fit; then the next host; an empty host
// always takes one. And the operator views the dashboard reads: the fleet view with residents and
// capacity, and the cell's images.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FleetDO } from "../src/do/fleet";
import type { Ec2, ImageInfo } from "../src/lib/ec2";
import { adminJson, connectHost, enrollHost, hostHello, sendEvents, uniqueCell, Ws } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
type HostView = { host: string; leases: number; capacity: Record<string, unknown> | null; tunnel_state: string | null;
  sandboxes: { sandbox: string; epoch: number; state: string | null; vcpus: number | null; memory_mib: number | null }[]; agents: string[] };
type FleetView = { hosts: HostView[]; launches: Record<string, unknown>[]; sandboxes: { sandbox: string; host: string | null; epoch: number | null }[] };
const view = async (cell: string) => (await fleetStub(cell).fleetView()) as unknown as FleetView;

async function workstream() {
  return adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "placement" } }, 201);
}

async function place(cell: string, ws: string, status = 201) {
  return adminJson<{ sandbox: string; host: string | null }>("/v1/sandboxes", { body: { workstream: ws, cell } }, status);
}

/** A connected sandbox host whose hello reports the given capacity. */
async function hostWithCapacity(cell: string, capacity: Record<string, unknown>) {
  const enrolled = await enrollHost(cell, "sandbox");
  const ws = await Ws.connect("/v1/fleet", enrolled.host_token);
  ws.send(hostHello(enrolled.host, cell, { capacity: { vcpus_free: 8, memory_mib_free: 16384, hugepages_mib_free: 8192, sandboxes: 0, agents: 0, warm: [], ...capacity } }));
  await ws.next("hello_ack");
  return { host: enrolled.host, ws };
}

describe("placement packs", () => {
  it("fills a host up to its hugepages before opening the next, and leaves the rest unplaced", async () => {
    const cell = uniqueCell();
    // 8192 MiB of hugepages each: room for two default sandboxes (4096 MiB) per host.
    const a = await connectHost(cell);
    const b = await connectHost(cell);
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws);
    const s2 = await place(cell, ws);
    const s3 = await place(cell, ws);
    const s4 = await place(cell, ws);
    expect([s1.host, s2.host], "the first host fills first").toEqual([a.host, a.host]);
    expect([s3.host, s4.host], "then the second").toEqual([b.host, b.host]);
    const s5 = await place(cell, ws, 202);
    expect(s5.host, "nothing fits: unplaced, not squeezed on").toBeNull();
    const v = await view(cell);
    expect(v.hosts.map((h) => h.leases)).toEqual([2, 2]);
    expect(v.sandboxes.filter((s) => s.host === null).map((s) => s.sandbox)).toEqual([s5.sandbox]);
  });

  it("a capacity report after the leases' first states ends their reservation; the host's report then rules", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws);
    const s2 = await place(cell, ws);
    expect([s1.host, s2.host]).toEqual([a.host, a.host]);
    expect((await place(cell, ws, 202)).host).toBeNull();
    // The host counts both sandboxes and still reports room for one more.
    const seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 4, memory_mib_free: 8192, hugepages_mib_free: 4096, sandboxes: 2, agents: 0, warm: [] } },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, ws)).host, "the report's free hugepages admit a third").toBe(a.host);
    expect((await place(cell, ws, 202)).host, "and no more").toBeNull();
  });

  it("an empty host takes a sandbox larger than its pool; a second one does not join it", async () => {
    const cell = uniqueCell();
    const small = await hostWithCapacity(cell, { hugepages_mib_free: 1952, vcpus_free: 2 });
    const { workstream: ws } = await workstream();
    expect((await place(cell, ws)).host, "placed alone, overcommitted as before packing").toBe(small.host);
    expect((await place(cell, ws, 202)).host, "the host is spoken for").toBeNull();
    const big = await hostWithCapacity(cell, { hugepages_mib_free: 8192, vcpus_free: 8 });
    expect((await place(cell, ws)).host).toBe(big.host);
  });
});

describe("placement on regular pages", () => {
  // No hugepage pool: a sandbox reserves the cell's `sandbox_reserve_mib` (768 by default)
  // against the host's free memory until the host counts it; its declared 4096 MiB is a ceiling.
  it("packs by free memory: a 2.5 GiB host takes three default sandboxes, not a fourth", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 2560, vcpus_free: 2 });
    const { workstream: ws } = await workstream();
    const placed = [await place(cell, ws), await place(cell, ws), await place(cell, ws)];
    expect(placed.map((p) => p.host), "three fit: 2560 - 2*768 = 1024 >= 768").toEqual([a.host, a.host, a.host]);
    expect((await place(cell, ws, 202)).host, "the fourth would leave less than a reserve").toBeNull();
  });

  it("a burst of placements keeps its reservations until a capacity report made after the sandboxes reported", async () => {
    const cell = uniqueCell();
    // Room for two reserves (2000 - 768 = 1232 >= 768), not three (2000 - 2*768 = 464).
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 2000, vcpus_free: 2 });
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws);
    const s2 = await place(cell, ws);
    expect([s1.host, s2.host]).toEqual([a.host, a.host]);
    // nestd reports state at once, capacity at most every 30 s: the stale report counts neither.
    let seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "creating" },
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s2.sandbox, epoch: 1, state: "running" },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, ws, 202)).host, "still reserved: the last report predates both").toBeNull();
    // A report made since counts them; its free memory rules.
    seq = sendEvents(a.ws, [{ ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 2, memory_mib_free: 2000, hugepages_mib_free: 0, hugepages_mib_total: 0, sandboxes: 2, agents: 0, warm: [] } }]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, ws)).host).toBe(a.host);
  });

  it("declared vCPUs are a shape, not a reservation: a 2 vCPU host takes several 2 vCPU sandboxes", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 8192, vcpus_free: 2 });
    const { workstream: ws } = await workstream();
    for (let i = 0; i < 5; i++) expect((await place(cell, ws)).host).toBe(a.host);
  });

  it("the host's report rules once it counts a sandbox: a report with less room stops placement", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 0, hugepages_mib_total: 0, memory_mib_free: 4096, vcpus_free: 2 });
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws);
    expect(s1.host).toBe(a.host);
    const seq = sendEvents(a.ws, [
      { ts_ms: Date.now(), type: "sandbox_state", sandbox: s1.sandbox, epoch: 1, state: "running" },
      { ts_ms: Date.now(), type: "capacity", capacity: { vcpus_free: 0, memory_mib_free: 500, hugepages_mib_free: 0, hugepages_mib_total: 0, sandboxes: 1, agents: 0, warm: [] } },
    ]);
    await a.ws.next("ack", (m) => m.up_to >= seq);
    expect((await place(cell, ws, 202)).host, "500 MiB free is under a reserve").toBeNull();
  });

  it("a hugepage host keeps the pool rule: the declared size counts against the pool", async () => {
    const cell = uniqueCell();
    const a = await hostWithCapacity(cell, { hugepages_mib_free: 8192, hugepages_mib_total: 8192, memory_mib_free: 16384, vcpus_free: 8 });
    const { workstream: ws } = await workstream();
    expect([(await place(cell, ws)).host, (await place(cell, ws)).host]).toEqual([a.host, a.host]);
    expect((await place(cell, ws, 202)).host, "two 4096 MiB sandboxes fill an 8192 MiB pool").toBeNull();
  });
});

describe("operator views", () => {
  it("a sandbox without a lease shows its own state, not 'unplaced'", async () => {
    const cell = uniqueCell();
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws, 202); // no host at all
    const v = await view(cell);
    expect(v.sandboxes).toEqual([expect.objectContaining({ sandbox: s1.sandbox, host: null })]);
    const row = v.sandboxes[0] as unknown as { state: string | null; image: string };
    expect(row.state, "the SandboxDO's own state").not.toBeNull();
    expect(row.image).toBe("nest-base:latest");
  });

  it("the fleet view lists each host's residents, brains and capacity, and every live sandbox", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const { workstream: ws } = await workstream();
    const s1 = await place(cell, ws);
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
