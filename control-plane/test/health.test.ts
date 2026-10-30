// `GET /v1/health` (lib/health.ts): a read-only round trip to every Durable Object class, on a health
// instance per class that stores nothing and arms no alarm; 503 naming the class that didn't answer.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkHealth, HEALTH_INSTANCE } from "../src/lib/health";
import { ChannelName } from "../src/lib/channels";
import { LedgerName } from "../src/lib/tasks";
import { BASE } from "./helpers";

// Every binding in wrangler.jsonc, by class name: a class added there without a probe fails below.
const CLASSES = {
  FleetDO: env.FLEET, SandboxDO: env.SANDBOX, AgentDO: env.AGENT, WorkstreamDO: env.WORKSTREAM,
  BrokerDO: env.BROKER, CatalogDO: env.CATALOG, ChannelDO: env.CHANNEL, TaskLedgerDO: env.TASKS,
} as const;

describe("GET /v1/health", () => {
  it("answers 200 only after every DO class answered, naming each class and nothing else", async () => {
    const res = await SELF.fetch(`${BASE}/v1/health`);
    const body = await res.json<Record<string, unknown>>();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["durable_objects", "ok", "protocol_version"]);
    expect(body.ok).toBe(true);
    expect(body.durable_objects).toEqual(Object.fromEntries(Object.keys(CLASSES).map((c) => [c, "ok"])));
  });

  it("leaves each class's health instance with no tables and no alarm", async () => {
    expect((await SELF.fetch(`${BASE}/v1/health`)).status).toBe(200);
    for (const [name, ns] of Object.entries(CLASSES)) {
      const n = ns as unknown as DurableObjectNamespace;
      const stub = n.get(n.idFromName(HEALTH_INSTANCE));
      const found = await runInDurableObject(stub, async (_i, state) => ({
        tables: state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
          .toArray().map((r) => r.name),
        alarm: await state.storage.getAlarm(),
        keys: [...(await state.storage.list()).keys()],
      }));
      expect(found, name).toEqual({ tables: [], alarm: null, keys: [] });
    }
  });

  it("no name a user can give reaches the health instance", () => {
    expect(ChannelName.safeParse(HEALTH_INSTANCE).success).toBe(false);
    expect(LedgerName.safeParse(HEALTH_INSTANCE).success).toBe(false);
  });
});

describe("checkHealth", () => {
  it("a class that fails or doesn't answer in time fails the check and is named; the others still report, in parallel", async () => {
    const never = () => new Promise<never>(() => {});
    const started = Date.now();
    const r = await checkHealth({
      A: async () => true,
      B: async () => { throw new Error("agt_secret-id: boom"); },
      C: never, D: never, E: never,
    }, 300);
    // Three probes that never answer, each cut off at 300 ms: together, not one after another.
    expect(Date.now() - started).toBeLessThan(800);
    expect(r).toEqual({ ok: false, durable_objects: { A: "ok", B: "error", C: "timeout", D: "timeout", E: "timeout" } });
    expect(JSON.stringify(r)).not.toContain("agt_");
    expect(await checkHealth({ A: async () => true, B: async () => true }, 300)).toEqual({ ok: true, durable_objects: { A: "ok", B: "ok" } });
  });
});
