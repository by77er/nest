// Schema migrations (src/sql.ts) run each step once, across restarts, in order: a release that adds a
// step runs only that one on objects an older release made.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/sql";

describe("migrate", () => {
  it("runs only the steps past the stored version", async () => {
    const stub = env.REVIEW.get(env.REVIEW.idFromName(`migrate-${crypto.randomUUID()}`));
    await runInDurableObject(stub, (_o, state) => {
      const sql = state.storage.sql;
      // The constructor ran this release's steps; a step that ran twice would fail on its CREATE TABLE.
      const base = sql.exec<{ v: number }>("SELECT v FROM schema_version").one().v;
      expect(base).toBeGreaterThan(0);
      const extra = [...Array.from({ length: base }, () => ["SELECT 1"]), ["CREATE TABLE added (a INTEGER)"], ["INSERT INTO added (a) VALUES (1)"]];
      expect(migrate(state.storage, extra)).toBe(base + 2);
      expect(migrate(state.storage, extra)).toBe(base + 2);
      expect(sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM added").one().n).toBe(1);
    });
  });
});
