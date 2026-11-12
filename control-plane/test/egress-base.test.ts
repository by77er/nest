// The base egress layer as operator data (docs/sandbox/networking/egress/policy/#base-layer): one per cell
// in FleetDO, seeded with the hosts nest had built in, edited by the operator only, under the operator
// layer's schemas, and told to every live sandbox of the cell, which sends it as a new policy version.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { FleetDO } from "../src/do/fleet";
import { SandboxDO } from "../src/do/sandbox";
import { admin, adminJson, BASE, connectHost, eventually, nextCommands, runDue, uniqueCell } from "./helpers";

/** The base layer's hosts before this release made it data, written out here as the oracle (not imported). */
const TODAYS_BASE = ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "crates.io", "static.crates.io", "index.crates.io",
  "github.com", "*.githubusercontent.com", "deb.debian.org"];

const fleetOf = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxOf = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const base = (cell: string) => `/v1/admin/egress/base?cell=${cell}`;
const baseRules = (policy: { allow: { host: string; ports: number[]; layer: string }[] }) => policy.allow.filter((a) => a.layer === "base");
const GUARD = { name: "no-npm-publish", hosts: ["registry.npmjs.org"], scope: [{ methods: ["PUT"] }], reason: "publishing is the operator's" };

/** A sandbox of the cell placed on a host, and that host's socket. */
async function placed(cell: string, ws?: Awaited<ReturnType<typeof connectHost>>["ws"]) {
  const sock = ws ?? (await connectHost(cell)).ws;
  const sbx = await adminJson("/v1/sandboxes", { body: { cell } }, 201);
  const [create] = await nextCommands(sock, (c) => c.type === "sandbox_create" && c.sandbox === sbx.sandbox);
  return { sandbox: sbx.sandbox as string, ws: sock, create };
}

describe("the base egress layer", () => {
  it("is seeded with exactly the hosts nest had built in, on web ports, with no guards, in the API and in what a new sandbox's proxy gets", async () => {
    const cell = uniqueCell();
    expect(await adminJson(base(cell))).toEqual({ version: 0, allow: TODAYS_BASE.map((host) => ({ host })), guards: [], pending: 0 });
    const s = await placed(cell);
    expect(baseRules(s.create.policy)).toEqual(TODAYS_BASE.map((host) => ({ host, ports: [80, 443], layer: "base" })));
    const view = await adminJson(`/v1/sandboxes/${s.sandbox}/policy`);
    expect(view.allow.filter((a: any) => a.source === "base").map((a: any) => a.host)).toEqual(TODAYS_BASE);
  });

  it("an edit reaches a live sandbox as a new policy version, and a sandbox created after it starts with it; other cells keep theirs", async () => {
    const cell = uniqueCell();
    const s = await placed(cell);
    const before = s.create.policy.version as number;
    const next = { allow: [{ host: "deb.debian.org" }, { host: "mirror.example.org", ports: [443] }], guards: [GUARD] };
    const put = await adminJson(base(cell), { method: "PUT", body: next });
    expect(put).toMatchObject({ version: 1, ...next });
    const [update] = await nextCommands(s.ws, (c) => c.type === "policy_update");
    expect(update.policy.version).toBeGreaterThan(before);
    expect(baseRules(update.policy)).toEqual([
      { host: "deb.debian.org", ports: [80, 443], layer: "base" }, { host: "mirror.example.org", ports: [443], layer: "base" }]);
    expect(update.policy.guards).toContainEqual(GUARD);
    await eventually("every live sandbox told", async () => (await adminJson(base(cell))).pending === 0);
    // Created after the write: its first policy has it (FleetDO answers it at registration).
    const later = await placed(cell, s.ws);
    expect(baseRules(later.create.policy).map((a) => a.host)).toEqual(["deb.debian.org", "mirror.example.org"]);
    // The layer is per cell.
    expect((await adminJson(base(uniqueCell()))).allow).toEqual(TODAYS_BASE.map((host) => ({ host })));
  });

  it("is the operator's: an API client's token can neither read nor write it", async () => {
    const cell = uniqueCell();
    const c = await adminJson("/v1/admin/clients", { body: { name: `eb-${crypto.randomUUID().slice(0, 8)}`, grant: { cells: [cell] } } }, 201);
    for (const init of [{ method: "GET" }, { method: "PUT", body: JSON.stringify({ allow: [{ host: "evil.net" }] }) }]) {
      const r = await SELF.fetch(`${BASE}/v1/admin/egress/base?cell=${cell}`, { ...init, headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" } });
      expect(r.status, init.method).toBe(401);
    }
    expect((await adminJson(base(cell))).version).toBe(0);
  });

  it("refuses what the operator layer's schemas refuse, and an unknown field or a missing allow, changing nothing", async () => {
    const cell = uniqueCell();
    await adminJson(base(cell), { method: "PUT", body: { allow: [{ host: "deb.debian.org" }] } });
    const bad: unknown[] = [
      {},
      { guards: [] },
      { allow: [{ host: "" }] },
      { allow: [{ host: "x.org", ports: [0] }] },
      { allow: [{ host: "x.org", ports: [65536] }] },
      { allow: [], guards: [{ name: "g", hosts: ["x.org"] }] },
      { allow: [], guards: Array.from({ length: 65 }, (_, i) => ({ ...GUARD, name: `g${i}` })) },
      { allow: [], passthrough: ["x.org"] },
      { allow: "deb.debian.org" },
    ];
    for (const body of bad) expect((await admin(base(cell), { method: "PUT", body })).status, JSON.stringify(body)).toBe(400);
    // FleetDO checks again (an RPC caller that skipped the route's schema).
    await expect(Promise.resolve().then(() => fleetOf(cell).setEgressBase({ allow: [{ host: "" }] }))).rejects.toThrow(/egress base/);
    expect(await adminJson(base(cell))).toMatchObject({ version: 1, allow: [{ host: "deb.debian.org" }] });
  });

  it("a sandbox that doesn't answer is told again with backoff; an older version never replaces a newer one", async () => {
    const cell = uniqueCell();
    const s = await placed(cell);
    const proto = SandboxDO.prototype as unknown as { egressBaseChanged: (b: unknown) => Promise<void> };
    const real = proto.egressBaseChanged;
    let calls = 0;
    proto.egressBaseChanged = async function (this: SandboxDO, b: unknown) {
      calls++;
      if (calls === 1) throw new Error("unreachable for now");
      return real.call(this, b);
    };
    try {
      await adminJson(base(cell), { method: "PUT", body: { allow: [{ host: "one.example.org" }] } });
      const row = await eventually("a failed notice backed off", () => runInDurableObject(fleetOf(cell), (_i: FleetDO, st) =>
        st.storage.sql.exec<{ attempts: number; due_ms: number }>("SELECT attempts, due_ms FROM egress_base_notices WHERE sandbox = ?", s.sandbox).toArray()
          .find((r) => r.attempts === 1)));
      expect(row.due_ms).toBeGreaterThan(Date.now() - 1_000);
      await runInDurableObject(fleetOf(cell), (_i: FleetDO, st) => { st.storage.sql.exec("UPDATE egress_base_notices SET due_ms = 0"); st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'egress_base'"); });
      await runDue(fleetOf(cell));
      await eventually("told on the retry", async () => (await adminJson(base(cell))).pending === 0);
    } finally {
      proto.egressBaseChanged = real;
    }
    const [update] = await nextCommands(s.ws, (c) => c.type === "policy_update" && baseRules(c.policy).some((a: any) => a.host === "one.example.org"));
    expect(baseRules(update.policy).map((a: any) => a.host)).toEqual(["one.example.org"]);
    // An older version (a registration's answer read before the write) is ignored.
    await sandboxOf(s.sandbox).egressBaseChanged({ version: 0, allow: [{ host: "old.example.org" }], guards: [] });
    expect((await adminJson(`/v1/sandboxes/${s.sandbox}/policy`)).allow.filter((a: any) => a.source === "base").map((a: any) => a.host)).toEqual(["one.example.org"]);
    // Told while its create waits on its registration's answer (read before the write): the answer, older, doesn't replace it.
    const id = `sbx_ebrace${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await sandboxOf(id).egressBaseChanged({ version: 7, allow: [{ host: "told.example.org" }], guards: [] });
    await sandboxOf(id).create({ sandbox: id, cell: uniqueCell() });
    expect((await sandboxOf(id).policy()).allow.filter((a) => a.source === "base").map((a) => a.host)).toEqual(["told.example.org"]);
  });

  it("its guards are the operator's: never a client's name, counted against no client's guard budget, and no bar to a host that can't bound client guards", async () => {
    // Over the 32 client guards a sandbox applies (SANDBOX_MAX_GUARDS), within the operator layer's 64.
    const many = Array.from({ length: 40 }, (_, i) => ({ ...GUARD, name: `base-${i}` }));
    const old = uniqueCell();
    expect((await admin(base(old), { method: "PUT", body: { allow: [], guards: [{ ...GUARD, name: "client:mine" }] } })).status).toBe(400);
    await adminJson(base(old), { method: "PUT", body: { allow: [{ host: "deb.debian.org" }], guards: many } });
    // Only a host whose nest-proxy doesn't bound client guards: a sandbox with the base's guards is placed there.
    const host = await connectHost(old, "sandbox", { guard_bounds: false });
    const s = await placed(old, host.ws);
    expect(s.create.policy.guards.map((g: { name: string }) => g.name).slice(0, many.length)).toEqual(many.map((g) => g.name));
    // A client's guard beside them is held to its own budget alone.
    const cell = uniqueCell();
    await adminJson(base(cell), { method: "PUT", body: { allow: [{ host: "deb.debian.org" }], guards: many } });
    await connectHost(cell);
    const c = await adminJson("/v1/admin/clients", { body: { name: `ebg-${crypto.randomUUID().slice(0, 8)}`, grant: { cells: [cell], max_sandboxes: 2 } } }, 201);
    const res = await SELF.fetch(`${BASE}/v1/sandboxes`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify({ cell, guards: [{ name: "no-delete", hosts: ["deb.debian.org"], scope: [{ methods: ["DELETE"] }] }] }) });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    const sbx = (await res.json() as { sandbox: string }).sandbox;
    // And on a live layer write (checked against what the sandbox holds, the base's guards among it).
    const live = await SELF.fetch(`${BASE}/v1/sandboxes/${sbx}/client-policy`, { method: "PUT", headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json" },
      body: JSON.stringify({ guards: [{ name: "no-delete", hosts: ["deb.debian.org"], scope: [{ methods: ["DELETE"] }] }] }) });
    expect(live.status, await live.clone().text()).toBeLessThan(300);
    const names = (await adminJson(`/v1/sandboxes/${sbx}/policy`)).guards.map((g: { name: string }) => g.name);
    expect([names.slice(0, many.length), names.at(-1)]).toEqual([many.map((g) => g.name), "client:no-delete"]);
  });

  it("a retried create that took the new base from its registration still sends it when the notice comes", async () => {
    const cell = uniqueCell();
    const s = await placed(cell);
    const proto = SandboxDO.prototype as unknown as { egressBaseChanged: (b: unknown) => Promise<void> };
    const real = proto.egressBaseChanged;
    proto.egressBaseChanged = async function () { throw new Error("held"); };
    try {
      await adminJson(base(cell), { method: "PUT", body: { allow: [{ host: "new.example.org" }] } });
      await eventually("the first notice failed", () => runInDurableObject(fleetOf(cell), (_i: FleetDO, st) =>
        st.storage.sql.exec<{ attempts: number }>("SELECT attempts FROM egress_base_notices").toArray().some((r) => r.attempts >= 1)));
      // The same create again (a retried POST, a retried spawn): registerSandbox answers the new base, which it holds.
      await sandboxOf(s.sandbox).create({ sandbox: s.sandbox, cell });
    } finally {
      proto.egressBaseChanged = real;
    }
    await runInDurableObject(fleetOf(cell), (_i: FleetDO, st) => {
      st.storage.sql.exec("UPDATE egress_base_notices SET due_ms = 0");
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'egress_base'");
    });
    await runDue(fleetOf(cell));
    const [update] = await nextCommands(s.ws, (c) => c.type === "policy_update" && baseRules(c.policy).some((a: any) => a.host === "new.example.org"));
    expect(baseRules(update.policy).map((a: any) => a.host)).toEqual(["new.example.org"]);
  });

  it("a destroyed sandbox told of a new base writes nothing", async () => {
    const cell = uniqueCell();
    const s = await placed(cell);
    await adminJson(`/v1/sandboxes/${s.sandbox}`, { method: "DELETE" });
    await eventually("destroyed", async () => (await sandboxOf(s.sandbox).info()).state === "destroyed");
    await sandboxOf(s.sandbox).egressBaseChanged({ version: 3, allow: [{ host: "late.example.org" }], guards: [] });
    const left = await runInDurableObject(sandboxOf(s.sandbox), (_i: SandboxDO, st) => [
      st.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'egress_base'").toArray().length,
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'egress_base'").toArray().length]);
    expect(left).toEqual([0, 0]);
  });

  it("an older run's failed notice leaves a newer write's notice as that write queued it", async () => {
    const cell = uniqueCell();
    const fleet = fleetOf(cell);
    const id = `sbx_ebold${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await fleet.registerSandboxes([id]);
    await runInDurableObject(fleet, async (inst: FleetDO, st) => {
      const run = inst as unknown as { tellEgressBase(): Promise<void>; armEgressBase(): Promise<void>; sandbox(id: string): unknown };
      run.armEgressBase = async () => {};
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let reached = false;
      run.sandbox = () => ({ egressBaseChanged: async () => { reached = true; await gate; throw new Error("unreachable"); } });
      try {
        await inst.setEgressBase({ allow: [{ host: "one.example.org" }] });
        const telling = run.tellEgressBase();
        await eventually("the notice of version 1 in flight", () => reached);
        // A newer write while it is out: the row is version 2's, due now, no attempts.
        await inst.setEgressBase({ allow: [{ host: "two.example.org" }] });
        const queued = st.storage.sql.exec<{ version: number; attempts: number; due_ms: number }>("SELECT version, attempts, due_ms FROM egress_base_notices").one();
        expect(queued).toMatchObject({ version: 2, attempts: 0 });
        release();
        await telling;
        expect(st.storage.sql.exec("SELECT version, attempts, due_ms FROM egress_base_notices").one()).toEqual(queued);
      } finally {
        delete (run as Partial<typeof run>).armEgressBase;
        delete (run as Partial<typeof run>).sandbox;
      }
    });
  });

  it("tells at most one batch per alarm run, and picks notices a previous release's alarm dropped up again at start", async () => {
    const cell = uniqueCell();
    const fleet = fleetOf(cell);
    await fleet.registerSandboxes(Array.from({ length: 60 }, (_, i) => `sbx_eb${i}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`));
    await runInDurableObject(fleet, async (inst: FleetDO, st) => {
      // A write's rows, planted with no deadline (so no real alarm runs alongside), and one run by hand
      // that arms nothing after it.
      st.storage.sql.exec("INSERT INTO kv (key, value) VALUES ('egress_base', ?)", JSON.stringify({ version: 1, allow: [{ host: "deb.debian.org" }], guards: [] }));
      st.storage.sql.exec("INSERT INTO egress_base_notices (sandbox, version, attempts, due_ms) SELECT sandbox, 1, 0, 0 FROM sandboxes");
      const run = inst as unknown as { tellEgressBase(): Promise<void>; armEgressBase(): Promise<void> };
      run.armEgressBase = async () => {};
      try {
        await run.tellEgressBase();
      } finally {
        delete (run as Partial<typeof run>).armEgressBase;
      }
      expect(st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM egress_base_notices").one().n).toBe(10);
      // As a previous release's alarm leaves it: rows, no deadline. A new instance arms it again.
      expect(st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'egress_base'").toArray()).toEqual([]);
      new FleetDO(st, env as never);
    });
    await eventually("the notices' deadline armed again", () => runInDurableObject(fleet, (_i: FleetDO, st) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'egress_base'").toArray().length > 0
      || st.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM egress_base_notices").one().n === 0));
    await eventually("the rest told", async () => (await adminJson(base(cell))).pending === 0);
  });
});
