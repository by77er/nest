// A client's name and its phases (docs/control-plane/durable-objects/client/): reserved → live →
// deleted (a tombstone) → purged, decided by the directory row. A create's lost answers are recoverable,
// a dead create's reservation goes stale, a delete is idempotent and holds the name until the sweep has
// deleted once more what late requests wrote, and an orphan record purges itself.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ClientDO, CLIENT_DIRECTORY } from "../src/do/client";
import {
  confirmDecision, type NameRow, nameRow, RESERVE_TTL_MS, reserveDecision, sweepDecision, sweepDueMs, tombstoneDecision, TOMBSTONE_MS,
} from "../src/lib/client-names";
import { adminJson, BASE, runDue } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const dir = () => env.CLIENT.get(env.CLIENT.idFromName(CLIENT_DIRECTORY));
const clientStub = (id: string) => env.CLIENT.get(env.CLIENT.idFromName(id));

// --- Pure -------------------------------------------------------------------------------------------------

const row = (phase: NameRow["phase"], client = "cli_a", phase_ms = 1000): NameRow => ({ name: "n", client, created_ms: 0, phase, phase_ms });

describe("client names (pure)", () => {
  it("reserve: free, held by the same client, taken, or taken over once stale", () => {
    const now = 1000 + RESERVE_TTL_MS;
    expect(reserveDecision(undefined, "cli_a", now)).toEqual({ kind: "insert" });
    expect(reserveDecision(row("reserved"), "cli_a", now)).toEqual({ kind: "held", phase: "reserved" });
    expect(reserveDecision(row("live"), "cli_a", now)).toEqual({ kind: "held", phase: "live" });
    expect(reserveDecision(row("deleted"), "cli_a", now)).toMatchObject({ kind: "taken", phase: "deleted" });
    expect(reserveDecision(row("live"), "cli_b", now)).toEqual({ kind: "taken", phase: "live", free_ms: null });
    expect(reserveDecision(row("reserved"), "cli_b", now - 1)).toEqual({ kind: "taken", phase: "reserved", free_ms: 1000 + RESERVE_TTL_MS });
    expect(reserveDecision(row("reserved"), "cli_b", now)).toEqual({ kind: "takeover", stale: "cli_a" });
    // A tombstone is never taken over, whatever its age: only the sweep frees it, after its cleanup.
    expect(reserveDecision(row("deleted"), "cli_b", now + TOMBSTONE_MS * 10)).toEqual({ kind: "taken", phase: "deleted", free_ms: 1000 + TOMBSTONE_MS });
    // Nor a live name.
    expect(reserveDecision(row("live", "cli_a", 0), "cli_b", 1e15)).toMatchObject({ kind: "taken" });
  });

  it("confirm is idempotent and refuses a lost reservation; a tombstone comes from reserved or live", () => {
    expect(confirmDecision(row("reserved"), "cli_a")).toBe("confirm");
    expect(confirmDecision(row("live"), "cli_a")).toBe("already");
    expect(confirmDecision(row("deleted"), "cli_a")).toBe("lost");
    expect(confirmDecision(row("reserved", "cli_b"), "cli_a")).toBe("lost");
    expect(confirmDecision(undefined, "cli_a")).toBe("lost");
    expect(tombstoneDecision(row("reserved"), "cli_a")).toBe("tombstone");
    expect(tombstoneDecision(row("live"), "cli_a")).toBe("tombstone");
    expect(tombstoneDecision(row("deleted"), "cli_a")).toBe("already");
    expect(tombstoneDecision(row("live", "cli_b"), "cli_a")).toBe("none");
    expect(tombstoneDecision(undefined, "cli_a")).toBe("none");
  });

  it("the sweep drops stale reservations and finishes aged tombstones, and nothing else", () => {
    expect(sweepDecision(row("reserved"), 1000 + RESERVE_TTL_MS - 1)).toBeNull();
    expect(sweepDecision(row("reserved"), 1000 + RESERVE_TTL_MS)).toBe("drop_reservation");
    expect(sweepDecision(row("deleted"), 1000 + TOMBSTONE_MS - 1)).toBeNull();
    expect(sweepDecision(row("deleted"), 1000 + TOMBSTONE_MS)).toBe("finish_delete");
    expect(sweepDecision(row("live"), 1e15)).toBeNull();
    expect(sweepDueMs(row("reserved"))).toBe(1000 + RESERVE_TTL_MS);
    expect(sweepDueMs(row("deleted"))).toBe(1000 + TOMBSTONE_MS);
    expect(sweepDueMs(row("live"))).toBeNull();
  });

  it("a row from before phases is live; an unknown phase holds the name", () => {
    expect(nameRow({ name: "n", client: "cli_a", created_ms: 5, phase: null, phase_ms: null })).toEqual({ name: "n", client: "cli_a", created_ms: 5, phase: "live", phase_ms: 5 });
    expect(nameRow({ name: "n", client: "cli_a", created_ms: 5, phase: "frozen", phase_ms: 7 }).phase).toBe("deleted");
  });
});

// --- Through the Worker -------------------------------------------------------------------------------------

async function as(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}
const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };
const TPL = { capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" };

/** Age a name's phase by `ms` and run the directory's sweep. */
async function ageAndSweep(name: string, ms: number): Promise<void> {
  await runInDurableObject(dir(), (_i: ClientDO, st: DurableObjectState) => {
    st.storage.sql.exec("UPDATE names SET phase_ms = phase_ms - ? WHERE name = ?", ms, name);
    st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'sweep'");
  });
  await runDue(dir());
}
const nameRowOf = (name: string) => runInDurableObject(dir(), (_i: ClientDO, st: DurableObjectState) =>
  st.storage.sql.exec<{ client: string; phase: string | null }>("SELECT client, phase FROM names WHERE name = ?", name).toArray()[0] ?? null);

describe("creating a client", () => {
  it("a name whose create answered nothing (the probe's state) is freed by DELETE, held as a tombstone, then free", async () => {
    const name = `ghost-${rand()}`;
    const ghost = `cli_ghost${rand()}`;
    // What a lost answer used to leave: the name mapped to an id whose record is gone.
    await dir().claimName(name, ghost);
    expect((await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 409)).error.code).toBe("conflict");
    // DELETE finds the name by id though the record is gone, and holds it as a tombstone.
    const del = await adminJson(`/v1/admin/clients/${ghost}`, { method: "DELETE" });
    expect(del).toMatchObject({ deleted: ghost, name });
    expect(del.name_free_ms).toBeGreaterThan(Date.now());
    // Run again: the same answer (idempotent).
    await adminJson(`/v1/admin/clients/${ghost}`, { method: "DELETE" });
    expect((await adminJson("/v1/admin/clients")).clients).toContainEqual(expect.objectContaining({ client: ghost, phase: "deleted", deleted: true }));
    expect((await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 409)).error.message).toContain("was deleted");
    await ageAndSweep(name, TOMBSTONE_MS);
    expect(await nameRowOf(name)).toBeNull();
    await adminJson(`/v1/admin/clients/${ghost}`, { method: "DELETE" }, 404);
    await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 201);
  });

  it("a confirm whose answer is lost is asked again, and the create succeeds with a working token", async () => {
    const proto = ClientDO.prototype as unknown as { confirmName: (n: string, c: string) => Promise<void> };
    const real = proto.confirmName;
    let calls = 0;
    proto.confirmName = async function (this: ClientDO, n: string, c: string) {
      await real.call(this, n, c);
      if (calls++ === 0) throw new Error("the answer was lost");
    };
    let c;
    try {
      c = await adminJson("/v1/admin/clients", { body: { name: `lost-${rand()}`, grant: {} } }, 201);
    } finally {
      proto.confirmName = real;
    }
    expect(calls).toBe(2);
    expect((await as(c.token, "/v1/clients/self")).status).toBe(200);
    expect(await nameRowOf(c.name)).toEqual({ client: c.client, phase: "live" });
  });

  it("a create that fails before its record exists gives the name back at once", async () => {
    const name = `fail-${rand()}`;
    const proto = ClientDO.prototype as unknown as { create: (...a: unknown[]) => Promise<unknown> };
    const real = proto.create;
    proto.create = async () => {
      throw new Error("the record write failed");
    };
    try {
      expect((await SELF.fetch(`${BASE}/v1/admin/clients`, {
        method: "POST", headers: { authorization: "Bearer test-admin-token", "content-type": "application/json" }, body: JSON.stringify({ name, grant: {} }),
      })).status).toBeGreaterThanOrEqual(500);
    } finally {
      proto.create = real;
    }
    expect(await nameRowOf(name)).toBeNull();
    await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 201);
  });

  it("a create that died after reserving holds the name only until its reservation is stale; its record then purges itself", async () => {
    const name = `dead-${rand()}`;
    const dead = `cli_dead${rand()}`;
    // The route reserved and wrote the record, then died before confirming: its token never went out.
    await dir().reserveName(name, dead);
    await clientStub(dead).create({ client: dead, name, grant: { cells: [], credentials: [], repos: [], read_repos: [], mcp_urls: [], secrets: { max_count: 0, max_bytes: 4096 }, inject_hosts: [], egress_hosts: [], max_agents: 0, max_sandboxes: 0 } as never, token_hash: "x" });
    expect((await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 409)).error.message).toContain("is being created");
    expect((await adminJson("/v1/admin/clients")).clients).toContainEqual({ client: dead, name, phase: "reserved" });
    // Stale: a new create takes the name over.
    await runInDurableObject(dir(), (_i: ClientDO, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE names SET phase_ms = phase_ms - ? WHERE name = ?", RESERVE_TTL_MS, name);
    });
    const c = await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 201);
    expect(await nameRowOf(name)).toEqual({ client: c.client, phase: "live" });
    // The dead create's record, no longer named by the directory, purges itself at its prune.
    await runInDurableObject(clientStub(dead), (_i: ClientDO, st: DurableObjectState) => {
      const r = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'record'").one().value);
      r.created_ms -= RESERVE_TTL_MS;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'record'", JSON.stringify(r));
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    await runDue(clientStub(dead));
    expect(await runInDurableObject(clientStub(dead), async (_i: ClientDO, st: DurableObjectState) => ({
      record: st.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'record'").toArray().length, alarm: await st.storage.getAlarm(),
    }))).toEqual({ record: 0, alarm: null });
  });

  it("an orphan record with anything of its subtree still live or reserved is kept, not purged", async () => {
    const name = `busy-${rand()}`;
    const orphan = `cli_busy${rand()}`;
    // A record the directory doesn't name, as a dead create leaves it, but with an agent being created under it.
    await clientStub(orphan).create({ client: orphan, name, grant: { cells: [], credentials: [], repos: [], read_repos: [], mcp_urls: [], secrets: { max_count: 0, max_bytes: 4096 }, inject_hosts: [], egress_hosts: [], max_agents: 5, max_sandboxes: 0 } as never, token_hash: "x" });
    await runInDurableObject(clientStub(orphan), (_i: ClientDO, st: DurableObjectState) => {
      const r = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'record'").one().value);
      r.created_ms -= RESERVE_TTL_MS;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'record'", JSON.stringify(r));
      st.storage.sql.exec("INSERT INTO members (id, kind, cell, owner, labels, created_ms, state) VALUES (?, 'agent', 'c', ?, '{}', ?, 'reserved')", `agt_${rand()}`, orphan, Date.now());
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    await runDue(clientStub(orphan));
    expect(await runInDurableObject(clientStub(orphan), (_i: ClientDO, st: DurableObjectState) =>
      st.storage.sql.exec("SELECT 1 FROM kv WHERE key = 'record'").toArray().length)).toBe(1);
  });

  it("a stale reservation nobody takes over goes at the sweep", async () => {
    const name = `swept-${rand()}`;
    await dir().reserveName(name, `cli_x${rand()}`);
    await ageAndSweep(name, RESERVE_TTL_MS);
    expect(await nameRowOf(name)).toBeNull();
  });
});

describe("deleting a client", () => {
  it("writes that land after the delete are deleted by the sweep, and a later client of the name inherits none of them", async () => {
    const name = `late-${rand()}`;
    const c = await adminJson("/v1/admin/clients", { body: { name, grant: { credentials: ["claude_oauth_token"], secrets: { max_count: 5, max_bytes: 4096 } } } }, 201);
    // Authenticated before the delete (the scope a request holds once it is past auth).
    const scope = await clientStub(c.client).scope();
    await adminJson(`/v1/admin/clients/${c.client}`, { method: "DELETE" });
    // The requests that were in flight land now.
    const catalog = env.CATALOG.get(env.CATALOG.idFromName("catalog"));
    await catalog.putTemplate(`${name}/late`, TPL as never, scope);
    const broker = env.BROKER.get(env.BROKER.idFromName("broker"));
    await broker.putClientSecret(c.client, "late", "v", null, { max_count: 5, max_bytes: 4096 });
    // A tombstone owns no namespace: the operator can't write into it either.
    await adminJson(`/v1/catalog/templates/${name}/ops`, { method: "PUT", body: TPL }, 404);
    // Held meanwhile: no new client of the name can see them.
    expect((await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 409)).error.message).toContain("was deleted");
    await ageAndSweep(name, TOMBSTONE_MS);
    expect((await adminJson("/v1/admin/catalog")).templates[`${name}/late`]).toBeUndefined();
    expect(await broker.clientSecrets(c.client)).toEqual([]);
    const again = await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 201);
    expect(Object.keys((await (await as(again.token, "/v1/catalog")).json() as any).templates)).not.toContain(`${name}/late`);
  });

  it("a deleted record's prune stops re-arming (it waits for its purge, not the hour)", async () => {
    const name = `stop-${rand()}`;
    const c = await adminJson("/v1/admin/clients", { body: { name, grant: {} } }, 201);
    await clientStub(c.client).markDeleted();
    await runInDurableObject(clientStub(c.client), (_i: ClientDO, st: DurableObjectState) => {
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
    });
    await runDue(clientStub(c.client));
    expect(await runInDurableObject(clientStub(c.client), (_i: ClientDO, st: DurableObjectState) =>
      st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'prune'").toArray().length)).toBe(0);
  });
});
