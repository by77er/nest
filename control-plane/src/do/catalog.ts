// CatalogDO (one, named "catalog"): templates and capabilities, stored as data and edited by the
// operator (docs/control-plane/durable-objects/catalog/). Seeded once with `worker` and `captain` (and
// migrated once per later seed version: new entries only);
// expansion itself is pure (lib/spec.ts).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { PLATFORM_TOOL_NAMES } from "../lib/registry";
import {
  type AgentSpec, Capability, type Catalog, checkCapability, checkTemplate, expandSpec, SEED_CATALOG, SEED_VERSION, seedMigration, type SpawnSpec, Template,
  templatesUsing,
} from "../lib/spec";
import { NestError } from "../lib/util";
import { ErrorCodes } from "../protocol/model";

export class CatalogDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS capabilities (name TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS templates (name TEXT PRIMARY KEY, body TEXT NOT NULL)");
    // Seeded once: an entry the operator deletes stays deleted. A catalog seeded by an earlier
    // version (no `seed_version`: version 1) gains each later version's new entries once, where the
    // name is free; existing entries are never edited.
    const kv = (key: string) => this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0]?.value;
    if (kv("seeded") === undefined) {
      this.insertSeed(SEED_CATALOG);
      this.sql.exec("INSERT INTO kv (key, value) VALUES ('seeded', '1')");
      this.setSeedVersion(SEED_VERSION);
    } else {
      const from = Number(kv("seed_version") ?? "1");
      if (from < SEED_VERSION) {
        const names = (table: string) => this.sql.exec<{ name: string }>(`SELECT name FROM ${table}`).toArray().map((r) => r.name);
        const m = seedMigration({ capabilities: names("capabilities"), templates: names("templates") }, from);
        this.insertSeed(m);
        this.setSeedVersion(m.version);
      }
    }
  }

  private insertSeed(c: Pick<Catalog, "capabilities" | "templates">): void {
    for (const [name, cap] of Object.entries(c.capabilities)) {
      this.sql.exec("INSERT OR IGNORE INTO capabilities (name, body) VALUES (?, ?)", name, JSON.stringify(cap));
    }
    for (const [name, t] of Object.entries(c.templates)) {
      this.sql.exec("INSERT OR IGNORE INTO templates (name, body) VALUES (?, ?)", name, JSON.stringify(t));
    }
  }

  private setSeedVersion(v: number): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(v));
  }

  /**
   * Every row that parses. One that doesn't (written by a later release, or edited by hand) is logged
   * and skipped, so one bad row cannot stop spawning from every other template.
   */
  private load(): Catalog {
    const rows = <T>(table: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }) => {
      const out: Record<string, T> = {};
      for (const r of this.sql.exec<{ name: string; body: string }>(`SELECT name, body FROM ${table}`).toArray()) {
        let parsed: { success: true; data: T } | { success: false };
        try {
          parsed = schema.safeParse(JSON.parse(r.body));
        } catch {
          parsed = { success: false };
        }
        if (parsed.success) out[r.name] = parsed.data;
        else console.error(`catalog: ${table} row ${r.name} does not parse; skipped`);
      }
      return out;
    };
    return { capabilities: rows("capabilities", Capability), templates: rows("templates", Template) };
  }

  async catalog(): Promise<Catalog> {
    return this.load();
  }

  /** Create or replace a capability. Its tools must be platform tools. */
  async putCapability(name: string, cap: Capability): Promise<Capability> {
    const r = checkCapability(cap, PLATFORM_TOOL_NAMES);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name}: ${r.error}`);
    this.sql.exec("INSERT INTO capabilities (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      name, JSON.stringify(cap));
    return cap;
  }

  /** Delete a capability no template lists. */
  async deleteCapability(name: string): Promise<void> {
    const users = templatesUsing(this.load(), name);
    if (users.length) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name} is listed by ${users.join(", ")}`, 409);
    this.sql.exec("DELETE FROM capabilities WHERE name = ?", name);
  }

  /** Create or replace a template. Its capabilities must exist. */
  async putTemplate(name: string, tpl: Template): Promise<Template> {
    const r = checkTemplate(tpl, this.load().capabilities);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `template ${name}: ${r.error}`);
    this.sql.exec("INSERT INTO templates (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      name, JSON.stringify(tpl));
    return tpl;
  }

  async deleteTemplate(name: string): Promise<void> {
    this.sql.exec("DELETE FROM templates WHERE name = ?", name);
  }

  /** Expand a spawn spec against the current catalog (400 when it doesn't expand). */
  async expand(spec: SpawnSpec): Promise<AgentSpec> {
    const r = expandSpec(this.load(), PLATFORM_TOOL_NAMES, spec);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, r.error);
    return r.value;
  }
}
