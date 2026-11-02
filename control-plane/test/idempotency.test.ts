// Idempotency keys on creates (docs/control-plane/api/#idempotency-keys): `POST /v1/agents` and
// `POST /v1/sandboxes` with an `Idempotency-Key` header. A key binds its principal's first request and
// the id it was given; a replay answers that object, another body with the key is a 409, keys of
// different principals never meet, concurrent requests with one key make one object, and a key is free
// again after its retention window.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ClientDO } from "../src/do/client";
import { CLIENT_OPERATOR } from "../src/do/client";
import { IDEMPOTENCY_LEASE_MS, IDEMPOTENCY_TTL_MS } from "../src/lib/idempotency";
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
