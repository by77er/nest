// Retention and stored enums (docs/data/#retention, #enums): a dead host's unanswered commands and
// channel are closed at once and its row pruned later; launches, GC runs, destroyed sandboxes and
// commit records go after their retention, and nothing something still depends on; the GC registry
// is written by SandboxDO's create; salvage is authorized against every epoch; values read back
// outside their union are logged.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetDO } from "../src/do/fleet";
import { SandboxDO } from "../src/do/sandbox";
import type { FleetView } from "../src/protocol/admin";
import type { CommitRequestEvent } from "../src/protocol/control";
import { storedEnum } from "../src/lib/stored";
import { SandboxState } from "../src/protocol/model";
import { adminJson, BASE, connectHost, csrPem, manifest, nextCommands, uniqueCell } from "./helpers";

const fleetStub = (cell: string) => env.FLEET.get(env.FLEET.idFromName(cell));
const sandboxStub = (id: string) => env.SANDBOX.get(env.SANDBOX.idFromName(id));
const DAY = 86_400_000;

afterEach(() => {
  vi.restoreAllMocks();
});

async function fleetSql<T>(cell: string, fn: (sql: SqlStorage, inst: FleetDO) => T): Promise<T> {
  return runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => fn(st.storage.sql, inst));
}

const rows = (sql: SqlStorage, q: string, ...args: SqlStorageValue[]) => sql.exec(q, ...args).toArray() as Record<string, SqlStorageValue>[];

/** Run FleetDO's pruning pass now (it runs at most hourly, from any alarm). */
async function prune(cell: string): Promise<void> {
  await runInDurableObject(fleetStub(cell), async (_inst: FleetDO, st) => {
    st.storage.sql.exec("DELETE FROM kv WHERE key = 'pruned_ms'");
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)");
    await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
  });
  expect(await runDurableObjectAlarm(fleetStub(cell)), "the alarm ran").toBe(true);
}

async function workerOnHost(cell: string) {
  await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-retention" } });
  const host = await connectHost(cell);
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "retention" } }, 201);
  const sbx = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { host, sandbox: sbx.sandbox, agent: worker.agent, workstream };
}

describe("a host's death", () => {
  it("closes the commands it never answered, resets its channel and moves its brains", async () => {
    const cell = uniqueCell();
    const { host, agent } = await workerOnHost(cell);
    host.ws.close();
    // Queued while it is gone: nothing will ever ack it.
    await fleetSql(cell, (_sql, inst) => inst.issueCommands(host.host, [{ type: "drain", reason: "test", deadline_ms: Date.now() }]));
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT cmd FROM commands WHERE host = ? AND result IS NULL", host.host).length)).toBeGreaterThan(0);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM rel_out WHERE chan = ?", host.host).length)).toBe(1);

    await adminJson(`/v1/admin/hosts/${host.host}/confirm-dead?cell=${cell}`, { body: {} });
    const after = await fleetSql(cell, (sql) => ({
      pending: rows(sql, "SELECT cmd FROM commands WHERE host = ? AND result IS NULL", host.host).length,
      outbox: rows(sql, "SELECT 1 FROM rel_out WHERE chan = ?", host.host).length,
      brains: rows(sql, "SELECT agent FROM host_agents WHERE host = ?", host.host).length,
      dead: rows(sql, "SELECT dead_ms FROM hosts WHERE host = ?", host.host)[0]?.dead_ms,
    }));
    expect(after).toMatchObject({ pending: 0, outbox: 0, brains: 0, dead: expect.any(Number) });
    // The agent no longer believes its brain runs on the dead host.
    expect((await adminJson<{ host: string | null }>(`/v1/agents/${agent}`)).host).not.toBe(host.host);
  });

  it("prunes the dead host's row after its retention, unless something still names it", async () => {
    const cell = uniqueCell();
    const a = await connectHost(cell);
    const b = await connectHost(cell);
    for (const h of [a, b]) {
      h.ws.close();
      await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    }
    await fleetSql(cell, (sql) => {
      sql.exec("UPDATE hosts SET dead_ms = ? WHERE host IN (?, ?)", Date.now() - 8 * DAY, a.host, b.host);
      sql.exec("INSERT INTO tunnels_created (host, created_ms) VALUES (?, ?)", a.host, Date.now() - 9 * DAY);
      // b's tunnel delete is still owed: the sweep needs its row.
      sql.exec("UPDATE hosts SET tunnel_id = 'tun_owed' WHERE host = ?", b.host);
    });
    await prune(cell);
    const left = await fleetSql(cell, (sql) => ({
      hosts: rows(sql, "SELECT host FROM hosts").map((r) => r.host),
      intents: rows(sql, "SELECT host FROM tunnels_created").map((r) => r.host),
      channels: rows(sql, "SELECT chan FROM rel_state WHERE chan = ?", a.host).length,
    }));
    expect(left).toEqual({ hosts: [b.host], intents: [], channels: 0 });
    // A dead host is not pruned before its retention.
    const c = await connectHost(cell);
    c.ws.close();
    await adminJson(`/v1/admin/hosts/${c.host}/confirm-dead?cell=${cell}`, { body: {} });
    await prune(cell);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", c.host).length)).toBe(1);
  });
});

describe("pruning", () => {
  it("drops old launches, GC runs and destroyed sandboxes, keeping what is still needed", async () => {
    const cell = uniqueCell();
    const live = await connectHost(cell);
    const old = Date.now() - 40 * DAY;
    await fleetSql(cell, (sql) => {
      const launch = (id: string, host: string | null, reason: string | null, ended: number | null) =>
        sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role, reason, ended_ms) VALUES (?, ?, ?, 'burst', ?, ?)", id, old, host, reason, ended);
      launch("i-ended-old", null, "idle", old);
      launch("i-ended-new", null, "idle", Date.now());
      launch("i-terminating", null, "idle", null); // not confirmed gone: still to terminate
      launch("i-host-pruned", "hst_gone000000000000000000", null, null);
      launch("i-host-live", live.host, null, null);
      const run = (id: string, marked: number, report: string | null) =>
        sql.exec("INSERT INTO gc_runs (run, host, marked_ms, dry_run, mark_version, roots, finished_ms, report) VALUES (?, 'h', ?, 0, 1, 0, ?, ?)",
          id, marked, report === null ? null : marked + 1, report);
      run("gc_proven_old", old - 3, "{}");
      run("gc_proven_latest", old - 2, "{}");
      run("gc_abandoned", old - 1, '{"abandoned":true}');
      run("gc_latest", old, '{"error":"x"}');
      run("gc_unfinished", old - 4, null);
      sql.exec("INSERT INTO sandboxes (sandbox, registered_ms, destroyed_ms) VALUES ('sbx_old', ?, ?), ('sbx_recent', ?, ?), ('sbx_live', ?, NULL)",
        old, old, old, Date.now(), old);
    });
    await prune(cell);
    const left = await fleetSql(cell, (sql) => ({
      launched: rows(sql, "SELECT instance_id FROM launched ORDER BY instance_id").map((r) => r.instance_id),
      runs: rows(sql, "SELECT run FROM gc_runs ORDER BY run").map((r) => r.run),
      sandboxes: rows(sql, "SELECT sandbox FROM sandboxes ORDER BY sandbox").map((r) => r.sandbox),
    }));
    expect(left).toEqual({
      // Only an instance EC2 confirmed gone goes: one whose host row is gone may still run.
      launched: ["i-ended-new", "i-host-live", "i-host-pruned", "i-terminating"],
      runs: ["gc_latest", "gc_proven_latest", "gc_unfinished"],
      sandboxes: ["sbx_live", "sbx_recent"],
    });
  });
});

describe("stored enums", () => {
  it("a value outside its union is logged as an error, and still returned", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(storedEnum(SandboxState, "running", "t.ok")).toBe("running");
    expect(error).not.toHaveBeenCalled();
    expect(storedEnum(SandboxState, "evacuating", "t.state")).toBe("evacuating");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("t.state"));
  });

  it("FleetDO logs a host row whose status is outside the union", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = await fleetSql(cell, (sql, inst) => {
      sql.exec("UPDATE hosts SET status = 'paused' WHERE host = ?", h.host);
      return inst.fleetView();
    });
    expect(view.hosts[0]!.status).toBe("paused");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("hosts.status"));
  });

  it("WorkstreamDO logs an event row whose type is outside the union", async () => {
    const { workstream } = await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "types" } }, 201);
    const stub = env.WORKSTREAM.get(env.WORKSTREAM.idFromName(workstream));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(stub, (_inst, st) => {
      st.storage.sql.exec("UPDATE events SET type = 'kickoff'");
    });
    expect((await stub.events()).map((e) => e.type)).toEqual(["started"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("events.type"));
  });

  it("AgentDO logs a turn whose status is outside the union", async () => {
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-enum" } });
    const { workstream } = await adminJson<{ workstream: string }>("/v1/workstreams", { body: { goal: "agent enums" } }, 201);
    const { agent } = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "captain", workstream, cell: uniqueCell(), start: false } }, 201);
    await adminJson(`/v1/agents/${agent}/turns`, { body: { text: "hello" } });
    const stub = env.AGENT.get(env.AGENT.idFromName(agent));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await runInDurableObject(stub, (_inst, st) => {
      st.storage.sql.exec("UPDATE turns SET status = 'paused'");
    });
    expect((await stub.turns()).map((t) => t.status)).toEqual(["paused"]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("turns.status"));
  });

  it("a host row from before `tunnel_state` reads `none`, written once by the migration", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const state = await runInDurableObject(fleetStub(cell), (_inst: FleetDO, st) => {
      st.storage.sql.exec("UPDATE hosts SET tunnel_state = NULL, status = 'dead', dead_ms = NULL WHERE host = ?", h.host);
      new FleetDO(st, env); // the migrations run in the constructor
      return st.storage.sql.exec<{ tunnel_state: string | null; dead_ms: number | null }>(
        "SELECT tunnel_state, dead_ms FROM hosts WHERE host = ?", h.host).toArray()[0];
    });
    expect(state).toEqual({ tunnel_state: "none", dead_ms: expect.any(Number) });
  });
});

describe("the fleet view", () => {
  it("keeps the lease's state and the sandbox's own apart", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "view" } }, 201);
    const placed = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    const unplaced = placed.sandbox;
    await fleetSql(cell, (sql) => sql.exec("INSERT INTO sandboxes (sandbox, registered_ms) VALUES ('sbx_unreadable', ?)", Date.now()));
    const view: FleetView = await fleetStub(cell).fleetView();
    const byId = new Map(view.sandboxes.map((s) => [s.sandbox, s]));
    // Its host died with no other to take it: no lease, and SandboxDO says it is waiting to be created.
    expect(byId.get(unplaced)).toMatchObject({ host: null, lease_state: null, sandbox_state: "creating", info_error: false });
    expect(byId.get("sbx_unreadable")).toMatchObject({ lease_state: null, sandbox_state: null, image: null, info_error: true });
    expect(view.hosts[0]).toMatchObject({ status: "dead", tunnel_state: "none" });
  });
});

describe("the GC registry", () => {
  it("is written by SandboxDO's create, before placement, even when placement fails", async () => {
    const cell = uniqueCell();
    const sandbox = "sbx_01registryfirst0000000000";
    const registered: string[] = [];
    const fakeFleet = {
      registerSandbox: async (s: string) => {
        registered.push(s);
      },
      place: async () => {
        throw new Error("FleetDO unavailable");
      },
      leaseOf: async () => null,
    };
    await runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO) => {
      (inst as unknown as { env: unknown }).env = { ...env, FLEET: { idFromName: () => "x", get: () => fakeFleet } };
      await expect(inst.create({ sandbox, workstream: "ws_01registry0000000000000000", cell })).rejects.toThrow("FleetDO unavailable");
    });
    expect(registered).toEqual([sandbox]);
  });

  it("is not written again for a destroyed sandbox (its row may be pruned)", async () => {
    const sandbox = "sbx_01registrydestroyed00000000";
    const registered: string[] = [];
    await runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO, st) => {
      st.storage.sql.exec("INSERT INTO kv (key, value) VALUES ('info', ?)", JSON.stringify({
        sandbox, workstream: "ws_01registry0000000000000000", cell: "c", image: "nest-base:latest", resources: { vcpus: 1, memory_mib: 1, disk_gib: 1 },
        epoch: 1, host: null, state: "destroyed", head: null, policy_version: 1, attached: [], working: [], ports: [],
      }));
      (inst as unknown as { env: unknown }).env = {
        ...env, FLEET: { idFromName: () => "x", get: () => ({ registerSandbox: async (s: string) => { registered.push(s); } }) },
      };
      expect((await inst.create({ sandbox, workstream: "ws_01registry0000000000000000", cell: "c" })).state).toBe("destroyed");
    });
    expect(registered).toEqual([]);
  });
});

describe("salvage authorization", () => {
  it("holds for an epoch older than the 50 that info().history shows", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "salvage" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    // 60 placements later (epochs 2..61 on other hosts), the host of epoch 1 salvages.
    await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      for (let e = 2; e <= 61; e++) st.storage.sql.exec("INSERT INTO epochs (epoch, host) VALUES (?, 'hst_other00000000000000000')", e);
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0]!;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...JSON.parse(row.value), epoch: 61, host: "hst_other00000000000000000" }));
    });
    const info = await sandboxStub(sandbox).info();
    expect(info.history).toHaveLength(50);
    expect(info.history.some((x) => x.epoch === 1)).toBe(false);
    const salvage = (request: string, host: string): CommitRequestEvent => ({
      ts_ms: Date.now(), type: "commit_request", request, sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("5"), reason: "salvage",
    } as CommitRequestEvent);
    expect(await sandboxStub(sandbox).commit(h.host, salvage("req_salvage_1", h.host))).toMatchObject({ status: "orphaned" });
    expect(await sandboxStub(sandbox).commit("hst_other00000000000000000", salvage("req_salvage_2", "x"))).toMatchObject({ status: "rejected", reason: "stale_epoch" });
  });

  it("copies a blob's capped history into the epochs table once", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "history" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const epochs = await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0]!;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'",
        JSON.stringify({ ...JSON.parse(row.value), history: [{ epoch: 1, host: h.host }, { epoch: 2, host: "hst_b" }] }));
      st.storage.sql.exec("DELETE FROM epochs");
      new SandboxDO(st, env);
      return st.storage.sql.exec("SELECT epoch, host FROM epochs ORDER BY epoch").toArray();
    });
    expect(epochs).toEqual([{ epoch: 1, host: h.host }, { epoch: 2, host: "hst_b" }]);
  });

  it("merges what a rolled-back release wrote into the blob, and keeps writing the blob for it", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "rollback" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const out = await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      const blob = () => JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").toArray()[0]!.value);
      const written = blob().history;
      // The old release ran meanwhile: it placed epochs 2 and 3 and recorded them only in the blob.
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'",
        JSON.stringify({ ...blob(), epoch: 3, history: [...written, { epoch: 2, host: "hst_b" }, { epoch: 3, host: "hst_c" }] }));
      new SandboxDO(st, env);
      return { written, epochs: st.storage.sql.exec("SELECT epoch, host FROM epochs ORDER BY epoch").toArray() };
    });
    expect(out.written, "the blob carries the history for the old release").toEqual([{ epoch: 1, host: h.host }]);
    expect(out.epochs).toEqual([{ epoch: 1, host: h.host }, { epoch: 2, host: "hst_b" }, { epoch: 3, host: "hst_c" }]);
  });
});

describe("commit records", () => {
  it("drop after their retention unless their generation is still in the chain", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "commits" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const commit = (request: string, parent?: string) => sandboxStub(sandbox).commit(h.host, {
      ts_ms: Date.now(), type: "commit_request", request, sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("6"), reason: "timer",
      ...(parent ? { parent } : {}),
    } as CommitRequestEvent);
    const first = await commit("req_kept");
    expect(first).toMatchObject({ status: "committed" });
    expect(await commit("req_rejected")).toMatchObject({ status: "rejected" }); // parent mismatch
    await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      st.storage.sql.exec("UPDATE commits SET created_ms = ?", Date.now() - 8 * DAY);
      st.storage.sql.exec("INSERT INTO commits (request, outcome, created_ms, generation_id) VALUES ('req_gone', ?, NULL, 'gen_notinthechain00000000000')",
        JSON.stringify({ status: "committed", generation: { id: "gen_notinthechain00000000000" } }));
    });
    const gen = (first as { generation: { id: string } }).generation.id;
    await commit("req_next", gen);
    const requests = () => runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) =>
      st.storage.sql.exec<{ request: string }>("SELECT request FROM commits ORDER BY request").toArray().map((r) => r.request));
    // Never on the commit path: the hourly deadline does it.
    expect(await requests()).toEqual(["req_gone", "req_kept", "req_next", "req_rejected"]);
    expect(await sandboxDeadline(sandbox, "commit_prune")).toBeGreaterThan(Date.now() + 50 * 60_000);
    await runSandboxAlarm(sandbox, "commit_prune");
    expect(await requests()).toEqual(["req_kept", "req_next"]);
  });

  it("get their generation column filled once from the stored outcome", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "backfill" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const rows = await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      const sql = st.storage.sql;
      // The table as the previous release left it.
      sql.exec("DROP INDEX commits_generation");
      sql.exec("DROP INDEX commits_rejected");
      sql.exec("ALTER TABLE commits DROP COLUMN generation_id");
      sql.exec("INSERT INTO commits (request, outcome) VALUES ('req_c', ?), ('req_r', ?)",
        JSON.stringify({ status: "committed", generation: { id: "gen_a" } }), JSON.stringify({ status: "rejected", reason: "parent_mismatch" }));
      new SandboxDO(st, env);
      return sql.exec("SELECT request, generation_id FROM commits ORDER BY request").toArray();
    });
    expect(rows).toEqual([{ request: "req_c", generation_id: "gen_a" }, { request: "req_r", generation_id: null }]);
  });
});

async function runSandboxAlarm(sandbox: string, key: string): Promise<void> {
  await runInDurableObject(sandboxStub(sandbox), async (_inst: SandboxDO, st) => {
    st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES (?, 0)", key);
    await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
  });
  expect(await runDurableObjectAlarm(sandboxStub(sandbox)), "the alarm ran").toBe(true);
}

async function sandboxDeadline(sandbox: string, key: string): Promise<number | undefined> {
  return runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) =>
    st.storage.sql.exec<{ at: number }>("SELECT at FROM deadlines WHERE key = ?", key).toArray()[0]?.at);
}

describe("a dead host's brains", () => {
  it("stay on record until their agent is told, retried from the tick, and keep the host from being pruned", async () => {
    const cell = uniqueCell();
    const { host, agent } = await workerOnHost(cell);
    let calls = 0;
    await fleetSql(cell, (_sql, inst) => {
      const real = env.AGENT;
      const flaky = {
        idFromName: (n: string) => real.idFromName(n),
        get: (id: DurableObjectId) => {
          const stub = real.get(id);
          return new Proxy(stub, {
            get: (t, p) => p === "onHostLost"
              ? async (h: string, e?: number) => {
                calls++;
                if (calls <= 2) throw new Error("AgentDO unavailable");
                return t.onHostLost(h, e);
              }
              : Reflect.get(t, p),
          });
        },
      };
      (inst as unknown as { env: unknown }).env = { ...env, AGENT: flaky };
    });
    host.ws.close();
    await adminJson(`/v1/admin/hosts/${host.host}/confirm-dead?cell=${cell}`, { body: {} });
    const brains = () => fleetSql(cell, (sql) => rows(sql, "SELECT agent FROM host_agents WHERE host = ?", host.host).map((r) => r.agent));
    expect(calls).toBe(1);
    expect(await brains(), "a failed call keeps the row").toEqual([agent]);
    // Old enough to prune, but its brains still name it.
    await fleetSql(cell, (sql) => sql.exec("UPDATE hosts SET dead_ms = ? WHERE host = ?", Date.now() - 8 * DAY, host.host));
    await prune(cell);
    expect(calls).toBe(2);
    expect(await brains()).toEqual([agent]);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", host.host).length)).toBe(1);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT at FROM deadlines WHERE key = 'tick'").length), "the tick stays armed").toBe(1);
    await prune(cell);
    expect(calls).toBe(3);
    expect(await brains()).toEqual([]);
    expect((await adminJson<{ host: string | null }>(`/v1/agents/${agent}`)).host).not.toBe(host.host);
    await prune(cell);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", host.host).length)).toBe(0);
  });
});

describe("a host that never connected and whose proof enrolls again", () => {
  it("gives up its sandboxes before its brains are moved", async () => {
    const cell = uniqueCell();
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "retire" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 202);
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "burst", cell } });
    const enroll = async () => {
      const res = await SELF.fetch(`${BASE}/v1/hosts/enroll`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, role: "burst", cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: await csrPem() }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { host: string }).host;
    };
    const first = await enroll();
    // When the agent hears of it, is the sandbox still queued for reassignment off the host?
    const seen: number[] = [];
    await runInDurableObject(fleetStub(cell), (inst: FleetDO, st) => {
      st.storage.sql.exec("INSERT INTO leases (sandbox, host, epoch, expired) VALUES (?, ?, 0, 0)", sandbox, first);
      st.storage.sql.exec("INSERT INTO host_agents (agent, host, cmd) VALUES ('agt_01retire000000000000000000', ?, 'cmd_x')", first);
      (inst as unknown as { env: unknown }).env = {
        ...env,
        AGENT: { idFromName: (n: string) => n, get: () => ({
          onHostLost: async () => {
            seen.push(st.storage.sql.exec("SELECT 1 FROM reassign_queue WHERE host = ?", first).toArray().length);
          },
        }) },
      };
    });
    await enroll();
    const end = Date.now() + 3000;
    while (!seen.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([0]);
  });
});

describe("a dead host's row", () => {
  it.each([
    ["a lease", "INSERT INTO leases (sandbox, host, epoch, expired) VALUES ('sbx_guard', ?, 1, 1)"],
    ["a stale incarnation", "INSERT INTO stale_incarnations (sandbox, host, epoch, first_seen_ms) VALUES ('sbx_guard', ?, 1, 0)"],
    ["a queued reassignment", "INSERT INTO reassign_queue (sandbox, host, epoch, host_dead) VALUES ('sbx_guard', ?, 1, 1)"],
    ["an eviction", "INSERT INTO evictions (sandbox, host, epoch) VALUES ('sbx_guard', ?, 1)"],
  ])("is kept while %s names it", async (_what, insert) => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    await fleetSql(cell, (sql) => {
      sql.exec("UPDATE hosts SET dead_ms = ? WHERE host = ?", Date.now() - 8 * DAY, h.host);
      sql.exec(insert, h.host);
    });
    await prune(cell);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", h.host).length)).toBe(1);
  });
});

describe("a dead host whose death is not proof", () => {
  it("is kept: an idle or drained retirement EC2 has not confirmed (`lost` = 0)", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    await fleetSql(cell, (sql) => sql.exec("UPDATE hosts SET dead_ms = ?, lost = 0 WHERE host = ?", Date.now() - 8 * DAY, h.host));
    await prune(cell);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", h.host).length)).toBe(1);
  });
});

describe("commands for a dead or unknown host", () => {
  it("a kill for a dead host is stored once: a retried issueKill gets the same command", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    const [first, again] = await fleetSql(cell, async (_sql, inst) => [
      await inst.issueKill(h.host, "agt_01killdedupe00000000000000", 3, "test"),
      await inst.issueKill(h.host, "agt_01killdedupe00000000000000", 3, "test"),
    ]);
    expect(again).toBe(first);
  });

  it("are answered at once with an error, never queued", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    const out = await fleetSql(cell, async (sql, inst) => {
      sql.exec("DELETE FROM rel_state WHERE chan = ?", h.host);
      const [dead] = await inst.issueCommands(h.host, [{ type: "drain", reason: "t", deadline_ms: 0 }]);
      const [unknown] = await inst.issueCommands("hst_nosuchhost0000000000000", [{ type: "drain", reason: "t", deadline_ms: 0 }]);
      return {
        dead: await inst.commandResult(dead!), unknown: await inst.commandResult(unknown!),
        queued: rows(sql, "SELECT 1 FROM rel_out WHERE chan IN (?, 'hst_nosuchhost0000000000000')", h.host).length,
        channels: rows(sql, "SELECT 1 FROM rel_state WHERE chan IN (?, 'hst_nosuchhost0000000000000')", h.host).length,
      };
    });
    expect(out).toMatchObject({
      dead: { status: "error", error: { message: expect.stringContaining("dead") } },
      unknown: { status: "error", error: { message: expect.stringContaining("unknown") } },
      queued: 0, channels: 0,
    });
  });
});

describe("confirming a host dead", () => {
  it("terminates its instance and records it ended once EC2 confirms", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const terminated: string[] = [];
    let state: "running" | "terminated" = "running";
    await fleetSql(cell, (sql, inst) => {
      inst.ec2Override = {
        launch: async () => "i-x", images: async () => [],
        terminate: async (id: string) => { terminated.push(id); state = "terminated"; },
        state: async () => state,
      };
      sql.exec("UPDATE hosts SET instance_id = 'i-0confirm' WHERE host = ?", h.host);
      sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role) VALUES ('i-0confirm', ?, ?, 'burst')", Date.now(), h.host);
    });
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT reason, ended_ms FROM launched WHERE instance_id = 'i-0confirm'")[0])).toEqual({ reason: "dead", ended_ms: null });
    await fleetSql(cell, (sql) => sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)"));
    await runDurableObjectAlarm(fleetStub(cell));
    expect(terminated).toEqual(["i-0confirm"]);
    await fleetSql(cell, (sql) => sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)"));
    await runDurableObjectAlarm(fleetStub(cell));
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT ended_ms FROM launched WHERE instance_id = 'i-0confirm'")[0]?.ended_ms)).toEqual(expect.any(Number));
  });
});

describe("the pruning pass", () => {
  it("never stalls the alarm it runs from", async () => {
    const cell = uniqueCell();
    await connectHost(cell);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await fleetSql(cell, (sql) => sql.exec("DROP TABLE gc_runs"));
    await prune(cell);
    expect(error).toHaveBeenCalledWith("FleetDO: pruning failed; next pass in an hour", expect.anything());
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT at FROM deadlines WHERE key = 'tick'").length), "the tick ran and re-armed").toBe(1);
  });
});
