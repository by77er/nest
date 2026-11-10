// Idempotency keys on creates (docs/control-plane/api/#idempotency-keys): `POST /v1/agents` and
// `POST /v1/sandboxes` with an `Idempotency-Key` header. A key binds its principal's first request and
// the id it was given; a replay answers that object, another body with the key is a 409, keys of
// different principals never meet, concurrent requests with one key make one object, and a key is free
// again after its retention window.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClientDO } from "../src/do/client";
import { ClientDO as ClientDOClass, CLIENT_OPERATOR } from "../src/do/client";
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS, IdempotencyKeys, KEY_EVENTS, KEY_VIEWS, keyStep, keyView } from "../src/lib/idempotency";
import { ADMIN, BASE, uniqueCell } from "./helpers";

const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 8);
const clientStub = (id: string) => env.CLIENT.get(env.CLIENT.idFromName(id));

async function post(token: string, path: string, body: unknown, key?: string): Promise<{ status: number; body: any; replayed: boolean }> {
  const res = await SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key === undefined ? {} : { "idempotency-key": key }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: JSON.parse(await res.text()), replayed: res.headers.get("idempotent-replayed") === "true" };
}

const LAUNCH = { builtin_tools: [], system_prompt: { mode: "append", text: "" } };

/** A client with a grant on `cell` and a template in its namespace. */
async function newClient(cell: string) {
  const name = `ik-${rand()}`;
  const res = await post(ADMIN, "/v1/admin/clients", { name, grant: { cells: [cell], credentials: ["claude_oauth_token"], max_agents: 20, max_sandboxes: 20 } });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const token = res.body.token as string;
  const put = await SELF.fetch(`${BASE}/v1/catalog/templates/${name}/t`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ capabilities: ["nest"], launch: LAUNCH, hands: "forbidden", credential: "claude_oauth_token" }),
  });
  expect(put.status, await put.text()).toBe(200);
  return { id: res.body.client as string, token, tpl: `${name}/t`, cell };
}

/** The client's live agents, from its registry. */
const liveAgents = async (client: string) => (await clientStub(client).list("agent")).items.map((m) => m.id);

describe("Idempotency-Key on POST /v1/agents and POST /v1/sandboxes", () => {
  it("a replay answers the first request's object with its status, marked replayed; another body with the key is a 409", async () => {
    const cell = uniqueCell();
    const c = await newClient(cell);
    const key = `k-${rand()}`;
    const body = { template: c.tpl, cell, start: false, labels: { task: "t1" } };
    const first = await post(c.token, "/v1/agents", body, key);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.replayed).toBe(false);
    const again = await post(c.token, "/v1/agents", body, key);
    expect(again).toMatchObject({ status: 201, replayed: true, body: { agent: first.body.agent, labels: { task: "t1" }, started: null } });
    expect(await liveAgents(c.id)).toEqual([first.body.agent]);
    // The same key with another body, or on the other create route: refused for good, nothing made.
    const other = await post(c.token, "/v1/agents", { ...body, labels: { task: "t2" } }, key);
    expect(other.status).toBe(409);
    expect(other.body.error).toMatchObject({ code: "conflict", retryable: false });
    expect((await post(c.token, "/v1/sandboxes", { cell }, key)).status).toBe(409);
    expect(await liveAgents(c.id)).toEqual([first.body.agent]);
    // Without a key, each create is its own.
    const a = await post(c.token, "/v1/agents", body);
    const b = await post(c.token, "/v1/agents", body);
    expect(new Set([first.body.agent, a.body.agent, b.body.agent]).size).toBe(3);
  });

  it("the operator's creates take keys too, and a sandbox's replay keeps its first status", async () => {
    const cell = uniqueCell();
    const key = `op-${rand()}`;
    const first = await post(ADMIN, "/v1/sandboxes", { cell }, key);
    // No host in the cell: accepted and waiting (202), and so is its replay.
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const again = await post(ADMIN, "/v1/sandboxes", { cell }, key);
    expect(again).toMatchObject({ status: 202, replayed: true, body: { sandbox: first.body.sandbox } });
    expect((await post(ADMIN, "/v1/sandboxes", { cell, labels: { x: "y" } }, key)).status).toBe(409);
  });

  it("a key is its principal's: two clients and the operator using one key each make their own", async () => {
    const cell = uniqueCell();
    const a = await newClient(cell);
    const b = await newClient(cell);
    const key = `shared-${rand()}`;
    const ids: string[] = [];
    for (const token of [a.token, b.token, ADMIN]) {
      const r = await post(token, "/v1/sandboxes", { cell }, key);
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      expect(r.replayed).toBe(false);
      ids.push(r.body.sandbox);
    }
    expect(new Set(ids).size).toBe(3);
    // Each still replays its own.
    expect((await post(b.token, "/v1/sandboxes", { cell }, key)).body.sandbox).toBe(ids[1]);
    expect((await post(ADMIN, "/v1/sandboxes", { cell }, key)).body.sandbox).toBe(ids[2]);
  });

  it("concurrent requests with one key make one agent: each answers it, or a retryable 409 while the first is handled", async () => {
    const cell = uniqueCell();
    const c = await newClient(cell);
    const key = `race-${rand()}`;
    const body = { template: c.tpl, cell, start: false };
    const all = await Promise.all(Array.from({ length: 6 }, () => post(c.token, "/v1/agents", body, key)));
    for (const r of all) {
      if (r.status === 409) expect(r.body.error).toMatchObject({ code: "conflict", retryable: true });
      else expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
    const made = new Set(all.filter((r) => r.status === 201).map((r) => r.body.agent));
    expect(made.size).toBe(1);
    expect(await liveAgents(c.id)).toEqual([...made]);
    // A retry once the first is answered gets the same agent.
    expect((await post(c.token, "/v1/agents", body, key)).body.agent).toBe([...made][0]);
  });

  it("a key whose request died mid-create is taken over after its lease, under the same id; a fresh key whose request failed is free again", async () => {
    const cell = uniqueCell();
    const c = await newClient(cell);
    // A request that claimed the key and died before answering (its lease long gone).
    const key = `dead-${rand()}`;
    const body = { template: c.tpl, cell, start: false };
    const first = await post(c.token, "/v1/agents", body, key);
    const id = first.body.agent as string;
    await runInDurableObject(clientStub(c.id), (_: ClientDO, st) => {
      st.storage.sql.exec("UPDATE idempotency_keys SET state = 'pending', status = NULL, claim = 'gone', claimed_ms = ? WHERE key = ?",
        Date.now() - IDEMPOTENCY_LEASE_MS - 1, key);
    });
    const retried = await post(c.token, "/v1/agents", body, key);
    expect(retried).toMatchObject({ status: 201, replayed: false, body: { agent: id } });
    expect(await liveAgents(c.id)).toEqual([id]);
    // A request that failed before making anything (an unknown template) leaves its key free for a corrected one.
    const k2 = `fix-${rand()}`;
    expect((await post(c.token, "/v1/agents", { ...body, template: `${c.tpl}x` }, k2)).status).toBe(400);
    expect((await post(c.token, "/v1/agents", body, k2)).status).toBe(201);
    // A malformed key is refused before anything else.
    expect((await post(c.token, "/v1/agents", body, "has space")).status).toBe(400);
  });

  it("a key expires after its retention window: then it makes a new object, and the old row is gone", async () => {
    const cell = uniqueCell();
    const key = `old-${rand()}`;
    const first = await post(ADMIN, "/v1/sandboxes", { cell }, key);
    expect(first.status).toBe(202);
    const store = clientStub(CLIENT_OPERATOR);
    // Just inside the window: still bound.
    const age = (ms: number) => runInDurableObject(store, (_: ClientDO, st) => {
      st.storage.sql.exec("UPDATE idempotency_keys SET created_ms = ? WHERE key = ?", Date.now() - ms, key);
    });
    await age(IDEMPOTENCY_TTL_MS - 60_000);
    expect((await post(ADMIN, "/v1/sandboxes", { cell }, key)).body.sandbox).toBe(first.body.sandbox);
    await age(IDEMPOTENCY_TTL_MS + 1);
    const later = await post(ADMIN, "/v1/sandboxes", { cell }, key);
    expect(later).toMatchObject({ status: 202, replayed: false });
    expect(later.body.sandbox).not.toBe(first.body.sandbox);
    const rows = await runInDurableObject(store, (_: ClientDO, st) =>
      st.storage.sql.exec<{ id: string }>("SELECT id FROM idempotency_keys WHERE key = ?", key).toArray().map((r) => r.id));
    expect(rows).toEqual([later.body.sandbox]);
  });
});

/** A fresh ledger on a real Durable Object's SQLite (a ClientDO's storage: its own keys' table). */
async function withKeys<T>(f: (k: IdempotencyKeys, sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(clientStub(`cli_keys${rand()}${rand()}`), (_i: ClientDO, st) => f(new IdempotencyKeys(st.storage.sql), st.storage.sql));
}

describe("a create's finish names its object", () => {
  it("the Worker passes the created id to finishKey, and a finish for another id leaves the key as it is", async () => {
    const cell = uniqueCell();
    const c = await newClient(cell);
    const key = `k-${rand()}`;
    const seen: unknown[][] = [];
    const proto = ClientDOClass.prototype as unknown as { finishKey: (...a: unknown[]) => Promise<void> };
    const real = proto.finishKey;
    proto.finishKey = function (this: ClientDO, ...a: unknown[]) {
      seen.push(a);
      return real.apply(this, a);
    };
    let made: string;
    try {
      const first = await post(c.token, "/v1/agents", { template: c.tpl, cell, start: false }, key);
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      made = first.body.agent;
    } finally {
      proto.finishKey = real;
    }
    expect(seen).toEqual([[key, 201, made]]);
    // Through the RPC: a finish for another object is refused, the right one accepted.
    const stub = clientStub(c.id);
    const k2 = `k-${rand()}`;
    const claim = await stub.claimKey(k2, "d", "agt_mine");
    expect(claim).toMatchObject({ kind: "run", id: "agt_mine" });
    await stub.finishKey(k2, 500, "agt_someone_elses");
    await expect((async () => { await stub.claimKey(k2, "d", "agt_x"); })()).rejects.toThrow(/still being handled/);
    await stub.finishKey(k2, 201, "agt_mine");
    expect(await stub.claimKey(k2, "d", "agt_x")).toEqual({ kind: "done", id: "agt_mine", status: 201 });
  });
});

describe("the key ledger's step", () => {
  it("keyStep: every view and event", () => {
    const table = Object.fromEntries(KEY_VIEWS.map((v) => [v, Object.fromEntries(KEY_EVENTS.map((e) => [e, keyStep(v, e)]))]));
    expect(table).toEqual({
      none: { claim: "held", finish: "refuse", abandon_free: "refuse", abandon_keep: "refuse" },
      held: { claim: "refuse", finish: "done", abandon_free: "none", abandon_keep: "open" },
      open: { claim: "held", finish: "done", abandon_free: "none", abandon_keep: "refuse" },
      done: { claim: "refuse", finish: "refuse", abandon_free: "refuse", abandon_keep: "refuse" },
    });
  });

  it.each([
    ["no row", undefined, "none"],
    ["claimed, within its lease", { state: "pending", claim: "c", claimed_ms: 1000 - IDEMPOTENCY_LEASE_MS + 1, created_ms: 500 }, "held"],
    ["claimed, its lease just lapsed", { state: "pending", claim: "c", claimed_ms: 1000 - IDEMPOTENCY_LEASE_MS, created_ms: 500 }, "open"],
    ["abandoned (no claim), however recent", { state: "pending", claim: null, claimed_ms: 999, created_ms: 500 }, "open"],
    ["answered", { state: "done", claim: null, claimed_ms: 999, created_ms: 500 }, "done"],
    ["answered, at its TTL", { state: "done", claim: null, claimed_ms: 999, created_ms: 1000 - IDEMPOTENCY_TTL_MS }, "none"],
    ["held, at its TTL", { state: "pending", claim: "c", claimed_ms: 999, created_ms: 1000 - IDEMPOTENCY_TTL_MS }, "none"],
  ] as const)("keyView: %s", (_n, row, view) => {
    expect(keyView(row, 1000)).toBe(view);
  });
});

describe("IdempotencyKeys: the guards are the ledger's", () => {
  it("the first answer stands; a held key is refused, an abandoned one taken over at once under its id", async () => {
    await withKeys((k) => {
      const t = 1_000_000;
      const a = k.claim("k", "d", "id_1", t);
      expect(a).toMatchObject({ kind: "run", id: "id_1", fresh: true });
      expect(() => k.claim("k", "d", "id_2", t + 1)).toThrow(/still being handled/);
      expect(() => k.claim("k", "other", "id_2", t + 1)).toThrow(/different request/);
      // Its request failed after its create began: bound still, and the next request takes it over at once.
      if (a.kind !== "run") throw new Error("unreachable");
      expect(k.abandon("k", "not-the-holder", true, t + 2)).toBe(false);
      expect(k.abandon("k", a.claim, false, t + 2)).toBe(true);
      expect(k.abandon("k", a.claim, false, t + 2)).toBe(false);
      const b = k.claim("k", "d", "id_2", t + 3);
      expect(b).toMatchObject({ kind: "run", id: "id_1", fresh: false });
      // The request that lost the key abandons late: nothing changes for its new holder.
      expect(k.abandon("k", a.claim, true, t + 4)).toBe(false);
      expect(() => k.claim("k", "d", "id_3", t + 5)).toThrow(/still being handled/);
      expect(k.finish("k", 201, undefined, t + 6)).toBe(true);
      expect(k.finish("k", 500, undefined, t + 7)).toBe(false);
      if (b.kind !== "run") throw new Error("unreachable");
      expect(k.abandon("k", b.claim, true, t + 8)).toBe(false);
      expect(k.claim("k", "d", "id_4", t + 9)).toEqual({ kind: "done", id: "id_1", status: 201 });
      expect(k.finish("never-claimed", 201, undefined, t)).toBe(false);
    });
  });

  it("a request that outlived its lease still finishes; a fresh claim that failed before its create frees the key", async () => {
    await withKeys((k) => {
      const t = 1_000_000;
      k.claim("slow", "d", "id_s", t);
      expect(k.finish("slow", 202, undefined, t + IDEMPOTENCY_LEASE_MS + 5)).toBe(true);
      expect(k.claim("slow", "d", "id_x", t + IDEMPOTENCY_LEASE_MS + 6)).toEqual({ kind: "done", id: "id_s", status: 202 });
      const f = k.claim("fresh", "d", "id_f", t);
      if (f.kind !== "run") throw new Error("unreachable");
      expect(k.abandon("fresh", f.claim, true, t + 1)).toBe(true);
      expect(k.claim("fresh", "other-body", "id_g", t + 2)).toMatchObject({ kind: "run", id: "id_g", fresh: true });
    });
  });

  it("a finish by the request that held the key before its TTL freed it doesn't answer for the new claim", async () => {
    await withKeys((k) => {
      const t = 1_000_000;
      k.claim("k", "d", "id_old", t);
      // A day on, the key is free and claimed afresh, for a new object, by a request still running.
      const later = t + IDEMPOTENCY_TTL_MS + 1;
      expect(k.claim("k", "d", "id_new", later)).toMatchObject({ kind: "run", id: "id_new", fresh: true });
      // The old request finishes at last: not its row any more.
      expect(k.finish("k", 500, "id_old", later + 1)).toBe(false);
      expect(() => k.claim("k", "d", "id_x", later + 2)).toThrow(/still being handled/);
      expect(k.finish("k", 201, "id_new", later + 3)).toBe(true);
      expect(k.claim("k", "d", "id_y", later + 4)).toEqual({ kind: "done", id: "id_new", status: 201 });
      // After a takeover the id is the same: either request's finish counts (the first decides).
      k.claim("same", "d", "id_s", t);
      k.claim("same", "d", "id_other", t + IDEMPOTENCY_LEASE_MS);
      expect(k.finish("same", 202, "id_s", t + IDEMPOTENCY_LEASE_MS + 1)).toBe(true);
    });
  });

  it("a key past its TTL is free even when the claim's prune didn't reach it", async () => {
    await withKeys((k, sql) => {
      const now = 10 * IDEMPOTENCY_TTL_MS;
      const old = now - IDEMPOTENCY_TTL_MS - 1000;
      // More expired keys than one claim deletes, the one under test the newest of them.
      for (let i = 0; i < 150; i++) sql.exec("INSERT INTO idempotency_keys (key, digest, id, state, status, claimed_ms, created_ms) VALUES (?, 'd', ?, 'done', 201, ?, ?)", `x${i}`, `id_${i}`, old + i, old + i);
      sql.exec("INSERT INTO idempotency_keys (key, digest, id, state, status, claimed_ms, created_ms) VALUES ('k', 'first-body', 'id_old', 'done', 201, ?, ?)", old + 500, old + 500);
      // Another body under the key: no conflict, a new object.
      expect(k.claim("k", "second-body", "id_new", now)).toMatchObject({ kind: "run", id: "id_new", fresh: true });
      expect(sql.exec("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE 'x%'").one().n).toBeGreaterThan(0);
    });
  });
});
