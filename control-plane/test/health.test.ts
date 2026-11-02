// `GET /v1/health` (lib/health.ts): a read-only round trip to every Durable Object class, on a health
// instance per class that stores nothing and arms no alarm; 503 naming the class that didn't answer.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { checkHealth, HEALTH_INSTANCE } from "../src/lib/health";
import { CatalogName } from "../src/lib/spec";
import { BASE } from "./helpers";
import wrangler from "../wrangler.jsonc?raw";

// Every Durable Object binding wrangler.jsonc declares, by class name, read from the file itself: a
// class added there without a probe in lib/health.ts fails below.
// Each binding object, whatever its key order; every `class_name` in the file must be one of them.
const BINDINGS = [...wrangler.matchAll(/\{[^{}]*"class_name"[^{}]*\}/g)].map(([obj]) => ({
  binding: /"name":\s*"(\w+)"/.exec(obj)?.[1], cls: /"class_name":\s*"(\w+)"/.exec(obj)?.[1],
}));
const CLASSES: Record<string, DurableObjectNamespace> = Object.fromEntries(
  BINDINGS.map(({ binding, cls }) => [cls!, (env as unknown as Record<string, DurableObjectNamespace>)[binding!]!]),
);

describe("GET /v1/health", () => {
  it("answers 200 only after every DO class answered, naming each class and nothing else", async () => {
    expect(Object.keys(CLASSES).length).toBe([...wrangler.matchAll(/"class_name"/g)].length);
    expect(Object.keys(CLASSES).length).toBeGreaterThanOrEqual(6);
    for (const ns of Object.values(CLASSES)) expect(ns).toBeDefined();
    const res = await SELF.fetch(`${BASE}/v1/health`);
    const body = await res.json<Record<string, unknown>>();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["config", "durable_objects", "ok", "protocol_version"]);
    expect(body.config).toBe("none");
    expect(body.ok).toBe(true);
    expect(body.durable_objects).toEqual(Object.fromEntries(Object.keys(CLASSES).map((c) => [c, "ok"])));
  });

  it("leaves each class's health instance with no tables and no alarm", async () => {
    expect((await SELF.fetch(`${BASE}/v1/health`)).status).toBe(200);
    for (const [name, ns] of Object.entries(CLASSES)) {
      const stub = ns.get(ns.idFromName(HEALTH_INSTANCE));
      const found = await runInDurableObject(stub, async (_i, state) => ({
        tables: state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
          .toArray().map((r) => r.name),
        alarm: await state.storage.getAlarm(),
        keys: [...(await state.storage.list()).keys()],
      }));
      expect(found, name).toEqual({ tables: [], alarm: null, keys: [] });
    }
  });

  it("ClientDO is probed", async () => {
    const res = await SELF.fetch(`${BASE}/v1/health`);
    expect((await res.json<{ durable_objects: Record<string, string> }>()).durable_objects.ClientDO).toBe("ok");
  });

  it("no name a user can give reaches the health instance", () => {
    expect(CatalogName.safeParse(HEALTH_INSTANCE).success).toBe(false);
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
