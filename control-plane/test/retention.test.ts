// Retention and stored enums (docs/data/#retention, #enums): a dead host's unanswered commands and
// channel are closed at once and its row pruned later; launches, GC runs, destroyed sandboxes and
// commit records go after their retention, and nothing something still depends on; the GC registry
// is written by SandboxDO's create; salvage is authorized against every epoch; values read back
// outside their union are logged.
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetDO } from "../src/do/fleet";
import { SandboxDO } from "../src/do/sandbox";
import type { FleetView } from "../../protocol/admin/view";
import type { CommitRequestEvent } from "../src/protocol/control";
import { storedEnum } from "../src/lib/stored";
import { SandboxState } from "../src/protocol/model";
import type { AgentDO } from "../src/do/agent";
import { adminJson, BASE, connectHost, csrPem, hostHello, manifest, nextCommands, okResult, sendEvents, uniqueCell, Ws } from "./helpers";

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
  const sbxHost = await connectHost(cell);
  const host = await connectHost(cell, "brain");
  const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "retention" } }, 201);
  const sbx = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
  await nextCommands(sbxHost.ws, (c) => c.type === "sandbox_create");
  const worker = await adminJson<{ agent: string }>("/v1/agents", { body: { role: "worker", workstream, sandbox: sbx.sandbox, cell } }, 201);
  await nextCommands(host.ws, (c) => c.type === "agent_start" && c.agent === worker.agent);
  return { host, sbxHost, sandbox: sbx.sandbox, agent: worker.agent, workstream };
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
        sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role, reason, ended_ms) VALUES (?, ?, ?, 'sandbox', ?, ?)", id, old, host, reason, ended);
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
      // The answer is unknown: the sandbox exists, and its place deadline will finish the placement.
      expect(await inst.create({ sandbox, workstream: "ws_01registry0000000000000000", cell })).toMatchObject({ placing: 1, host: null });
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
  it("an orphan's orphaned_work notice survives a failed post: the resent request posts it, once", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "salvage" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const salvage = {
      ts_ms: Date.now(), type: "commit_request", request: "req_orphan_1", sandbox, epoch: 1, kind: "disk_only", disk_manifest: manifest("6"), reason: "salvage",
    } as CommitRequestEvent;
    const outcomes = await runInDurableObject(sandboxStub(sandbox), async (inst: SandboxDO, st) => {
      const row = st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one();
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify({ ...JSON.parse(row.value), epoch: 2, host: "hst_other00000000000000000" }));
      // WorkstreamDO fails the first post (a reset, a lost reply); FleetDO resends the request.
      let fail = true;
      const self = inst as unknown as { env: typeof env };
      const real = self.env.WORKSTREAM;
      self.env = { ...self.env, WORKSTREAM: { idFromName: (n: string) => real.idFromName(n), get: (id: DurableObjectId) => {
        const ws = real.get(id);
        return { ingest: async (...a: Parameters<typeof ws.ingest>) => {
          if (fail) { fail = false; throw new Error("Network connection lost."); }
          return ws.ingest(...a);
        } };
      } } as unknown as typeof env.WORKSTREAM };
      const first = await inst.commit(h.host, salvage).then((o) => o.status, (e: Error) => e.message);
      return [first, (await inst.commit(h.host, salvage)).status, (await inst.commit(h.host, salvage)).status];
    });
    expect(outcomes).toEqual(["Network connection lost.", "orphaned", "orphaned"]);
    const notices = (await env.WORKSTREAM.get(env.WORKSTREAM.idFromName(workstream)).events()).filter((e) => e.type === "orphaned_work");
    expect(notices).toHaveLength(1);
  });

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

describe("commit records written by a release without their columns (a rollback)", () => {
  it("get their generation and an age from now on the next start, and none is pruned at once", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "rollback commits" } }, 201);
    const { sandbox } = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    const before = Date.now();
    const out = await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) => {
      const sql = st.storage.sql;
      // What the previous release inserts: the columns exist (this release added them), it leaves them null.
      sql.exec("INSERT INTO commits (request, outcome) VALUES ('req_rb_c', ?), ('req_rb_r', ?)",
        JSON.stringify({ status: "committed", generation: { id: "gen_rollback" } }), JSON.stringify({ status: "rejected", reason: "parent_mismatch" }));
      new SandboxDO(st, env);
      return sql.exec("SELECT request, generation_id, created_ms FROM commits WHERE request LIKE 'req_rb_%' ORDER BY request").toArray();
    });
    expect(out).toEqual([
      { request: "req_rb_c", generation_id: "gen_rollback", created_ms: expect.any(Number) },
      { request: "req_rb_r", generation_id: null, created_ms: expect.any(Number) },
    ]);
    expect((out[0] as { created_ms: number }).created_ms).toBeGreaterThanOrEqual(before);
    await runSandboxAlarm(sandbox, "commit_prune");
    const left = await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) =>
      st.storage.sql.exec<{ request: string }>("SELECT request FROM commits WHERE request LIKE 'req_rb_%' ORDER BY request").toArray().map((r) => r.request));
    expect(left).toEqual(["req_rb_c", "req_rb_r"]);
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
      st.storage.sql.exec("INSERT INTO commits (request, outcome, created_ms, generation_id) VALUES ('req_gone', ?, ?, 'gen_notinthechain00000000000')",
        JSON.stringify({ status: "committed", generation: { id: "gen_notinthechain00000000000" } }), Date.now() - 8 * DAY);
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
  // Let the sandbox's `<sbx>/events` posts (queued with its placement, sent from its alarm) drain
  // first: their alarm would otherwise run the forced deadline below before this does.
  const end = Date.now() + 10_000;
  while (await runInDurableObject(sandboxStub(sandbox), (_inst: SandboxDO, st) =>
    st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'chan_out' UNION ALL SELECT 1 FROM chan_out").toArray().length > 0)) {
    if (Date.now() > end) throw new Error("the sandbox's channel outbox didn't drain");
    await new Promise((r) => setTimeout(r, 50));
  }
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
    const { token } = await adminJson<{ token: string }>("/v1/admin/enrollment-tokens", { body: { role: "sandbox", cell } });
    const enroll = async () => {
      const res = await SELF.fetch(`${BASE}/v1/hosts/enroll`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocol_version: 1, role: "sandbox", cell, proof: { type: "enrollment_token", token }, proxy_ca_csr_pem: await csrPem() }),
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

describe("a kill FleetDO answered itself", () => {
  const agentStub = (id: string) => env.AGENT.get(env.AGENT.idFromName(id));
  const brainOf = (agent: string) => runInDurableObject(agentStub(agent), (_i: AgentDO, st) =>
    (JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value) as {
      brain: { host: string; phase: string } | null;
    }).brain);
  /** Run the agent's `condemned` deadline now, as if a minute had passed since the kill. */
  const escalate = async (agent: string) => {
    await runInDurableObject(agentStub(agent), async (_i: AgentDO, st) => {
      const info = JSON.parse(st.storage.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'info'").one().value);
      if (info.brain?.kill) info.brain.kill.ms = Date.now() - 61_000;
      st.storage.sql.exec("UPDATE kv SET value = ? WHERE key = 'info'", JSON.stringify(info));
      st.storage.sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('condemned', 0)");
      await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
    });
    await runDurableObjectAlarm(agentStub(agent));
  };

  it("never releases a brain on a retired host whose death isn't proof; its loss does", async () => {
    const cell = uniqueCell();
    await adminJson("/v1/admin/secrets/claude_oauth_token", { method: "PUT", body: { value: "sk-ant-oat01-killed" } });
    const a = await connectHost(cell, "brain");
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "kill answered by fleet" } }, 201);
    const captain = (await adminJson<{ agent: string }>("/v1/agents", { body: { role: "captain", workstream, cell } }, 201)).agent;
    const [start] = await nextCommands(a.ws, (c) => c.type === "agent_start" && c.agent === captain);
    await okResult(a.ws, start.cmd);
    const b = await connectHost(cell, "brain");
    await agentStub(captain).start(b.host);
    await nextCommands(a.ws, (c) => c.type === "agent_stop" && c.agent === captain && c.mode === "kill");
    // `a` is retired by FleetDO alone (a drain or idle retirement: dead, but not proof), its
    // index row gone, and the kill it never answered answered by FleetDO.
    const kill = await fleetSql(cell, (sql, inst) => {
      sql.exec("DELETE FROM host_agents WHERE host = ?", a.host);
      (inst as unknown as { hostDied(h: string, why: string): void }).hostDied(a.host, "drained");
      return rows(sql, "SELECT result, answered_by, (SELECT lost FROM hosts WHERE host = ?) AS lost FROM commands WHERE host = ? AND type = 'agent_stop'", a.host, a.host)[0];
    });
    expect(kill).toMatchObject({ result: expect.any(String), answered_by: "fleet", lost: 0 });
    await escalate(captain);
    expect(await brainOf(captain), "a FleetDO answer is not the host running the kill").toMatchObject({ host: a.host, phase: "condemned" });
    // A day later its answered commands are still kept (a missing kill would read as processed).
    await fleetSql(cell, (sql) => sql.exec("UPDATE commands SET result_ms = ? WHERE host = ?", Date.now() - 2 * DAY, a.host));
    await prune(cell);
    await escalate(captain);
    expect(await brainOf(captain)).toMatchObject({ host: a.host, phase: "condemned" });
    // Its death becomes proof: released.
    await fleetSql(cell, (sql) => sql.exec("UPDATE hosts SET lost = 1 WHERE host = ?", a.host));
    await escalate(captain);
    expect((await brainOf(captain))?.host ?? null).not.toBe(a.host);
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
    // FleetDO's answer, not the host's: the kill is not processed.
    const p = await fleetSql(cell, (_sql, inst) => inst.killProgress(first!, "agt_01killdedupe00000000000000", h.host, 3));
    expect(p.processed).toBe(false);
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
      sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role) VALUES ('i-0confirm', ?, ?, 'sandbox')", Date.now(), h.host);
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

describe("a dead host's launch left open", () => {
  it("is ended: terminated if it still runs, then recorded gone", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const live = await connectHost(cell);
    const terminated: string[] = [];
    let state: "running" | "terminated" = "running";
    await fleetSql(cell, (sql, inst) => {
      inst.ec2Override = {
        launch: async () => "i-x", images: async () => [],
        terminate: async (id: string) => { terminated.push(id); state = "terminated"; },
        state: async () => state,
      };
      // A previous release's death: the host dead, its launch never marked.
      sql.exec("UPDATE hosts SET instance_id = 'i-0stale', status = 'dead' WHERE host = ?", h.host);
      sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role) VALUES ('i-0stale', ?, ?, 'sandbox')", Date.now(), h.host);
      // A live host's open launch is left alone.
      sql.exec("INSERT INTO launched (instance_id, launched_ms, host, role) VALUES ('i-0live', ?, ?, 'sandbox')", Date.now(), live.host);
    });
    h.ws.close();
    for (let i = 0; i < 2; i++) {
      await fleetSql(cell, (sql) => sql.exec("INSERT OR REPLACE INTO deadlines (key, at) VALUES ('tick', 0)"));
      await runDurableObjectAlarm(fleetStub(cell));
    }
    expect(terminated).toEqual(["i-0stale"]);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT instance_id, reason, ended_ms IS NOT NULL AS ended FROM launched ORDER BY instance_id")))
      .toEqual([{ instance_id: "i-0live", reason: null, ended: 0 }, { instance_id: "i-0stale", reason: "dead", ended: 1 }]);
  });
});

describe("the pruning pass", () => {
  it("has its own daily deadline, armed on every start, so a quiet cell without tunnels prunes", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    h.ws.close();
    await adminJson(`/v1/admin/hosts/${h.host}/confirm-dead?cell=${cell}`, { body: {} });
    const at = await fleetSql(cell, (sql) => rows(sql, "SELECT at FROM deadlines WHERE key = 'prune'")[0]?.at as number | undefined);
    expect(at).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // Quiet: no tick, no sweep; only the prune deadline is due.
    await runInDurableObject(fleetStub(cell), async (_inst: FleetDO, st) => {
      st.storage.sql.exec("DELETE FROM deadlines WHERE key <> 'prune'");
      st.storage.sql.exec("UPDATE deadlines SET at = 0 WHERE key = 'prune'");
      st.storage.sql.exec("DELETE FROM kv WHERE key = 'pruned_ms'");
      st.storage.sql.exec("UPDATE hosts SET dead_ms = ? WHERE host = ?", Date.now() - 8 * DAY, h.host);
      await st.storage.setAlarm(Date.now() + 3_600_000); // run below, not by the runtime
    });
    expect(await runDurableObjectAlarm(fleetStub(cell))).toBe(true);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT 1 FROM hosts WHERE host = ?", h.host).length)).toBe(0);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT at FROM deadlines WHERE key = 'prune'")[0]?.at as number)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // A fresh start re-arms a missing one.
    const rearmed = await runInDurableObject(fleetStub(cell), async (_inst: FleetDO, st) => {
      st.storage.sql.exec("DELETE FROM deadlines WHERE key = 'prune'");
      new FleetDO(st, env);
      await new Promise((r) => setTimeout(r, 50));
      return st.storage.sql.exec("SELECT 1 FROM deadlines WHERE key = 'prune'").toArray().length;
    });
    expect(rearmed).toBe(1);
  });

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

describe("FleetDO's own answers are no evidence that a host processes commands", () => {
  it("a start failed on expiry (failStarts) doesn't count as host_processing for a kill issued before it", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    await runInDurableObject(fleetStub(cell), async (inst: FleetDO, st) => {
      const sql = st.storage.sql;
      const t0 = Date.now() - 1000;
      sql.exec(`INSERT INTO commands (cmd, host, type, agent, epoch, body, issued_ms) VALUES ('cmd_kill', ?, 'agent_stop', 'agt_x', 1, '{}', ?)`, h.host, t0);
      sql.exec(`INSERT INTO commands (cmd, host, type, agent, epoch, body, issued_ms) VALUES ('cmd_start', ?, 'agent_start', 'agt_y', 1, '{}', ?)`, h.host, t0 + 10);
      (inst as unknown as { failStarts(host: string): void }).failStarts(h.host);
      const p = await inst.killProgress("cmd_kill", "agt_x", h.host, 1);
      expect(p.processed).toBe(false);
      expect(p.host_processing).toBe(false);
    });
  });

  it("nor are the answers to what an old nestd process left: a kill it never ran is not processed", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell);
    const { workstream } = await adminJson("/v1/workstreams", { body: { goal: "restart answers" } }, 201);
    const sbx = await adminJson<{ sandbox: string }>("/v1/sandboxes", { body: { workstream, cell } }, 201);
    const [create] = await nextCommands(h.ws, (c) => c.type === "sandbox_create");
    await okResult(h.ws, create.cmd);
    const agent = "agt_01restartkill000000000000";
    // Unanswered when nestd restarts: one for the sandbox the new process won't report (closed by
    // dropUnreported), one for the host (failed retryably), and the kill (issued last).
    const [checkpoint] = await fleetStub(cell).issueCommands(h.host, [{ type: "sandbox_checkpoint", sandbox: sbx.sandbox, epoch: 1, reason: "checkpoint" }]);
    const [fence] = await fleetStub(cell).issueCommands(h.host, [{ type: "fence", sandboxes: [], reason: "t" }]);
    const kill = await fleetSql(cell, (_sql, inst) => inst.issueKill(h.host, agent, 1, "t"));
    const ws = await Ws.connect("/v1/fleet", h.host_token);
    ws.send(hostHello(h.host, cell, { instance_id: "nestdtest0000002", sandboxes: [] }));
    const seq = sendEvents(ws, []); // queued behind the hello: its ack means the hello is done
    await ws.next("ack", (m) => m.up_to === seq);

    expect(await fleetSql(cell, (_sql, inst) => inst.killProgress(kill, agent, h.host, 1))).toMatchObject({ processed: false, host_processing: false });
    const answered = await fleetSql(cell, (sql) =>
      rows(sql, "SELECT answered_by FROM commands WHERE cmd IN (?, ?, ?) AND result IS NOT NULL", checkpoint!, fence!, kill));
    expect(answered).toEqual([{ answered_by: "fleet" }, { answered_by: "fleet" }, { answered_by: "fleet" }]);
  });

  it("only its kills outlive their retention on a host whose death isn't proof", async () => {
    const cell = uniqueCell();
    const h = await connectHost(cell); // live: `lost` = 0
    const old = Date.now() - 2 * DAY;
    await fleetSql(cell, (sql) => {
      for (const [cmd, type, by] of [["cmd_fleetfence", "fence", "fleet"], ["cmd_fleetkill", "agent_stop", "fleet"], ["cmd_hostkill", "agent_stop", null]]) {
        sql.exec(`INSERT INTO commands (cmd, host, type, body, issued_ms, result, result_ms, answered_by)
          VALUES (?, ?, ?, '{}', ?, '{"status":"ok"}', ?, ?)`, cmd, h.host, type, old, old, by);
      }
    });
    await prune(cell);
    expect(await fleetSql(cell, (sql) => rows(sql, "SELECT cmd FROM commands WHERE cmd IN ('cmd_fleetfence', 'cmd_fleetkill', 'cmd_hostkill')")))
      .toEqual([{ cmd: "cmd_fleetkill" }]);
  });
});
