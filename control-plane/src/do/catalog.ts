// CatalogDO (one, named "catalog"): templates and capabilities, stored as data and edited by the
// operator (docs/control-plane/durable-objects/catalog/). Seeded once with `worker` and `captain` (and
// migrated once per later seed version: new entries, and the capabilities and tools the platform removed);
// expansion itself is pure (lib/spec.ts).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { PLATFORM_TOOL_NAMES } from "../lib/registry";
import {
  type AgentSpec, Capability, type Catalog, checkCapability, checkTemplate, expandSpec, type PromptRewrite, pruneCapability, pruneTemplate, type Removes,
  rewritePrompt, SEED_CATALOG, SEED_VERSION, seedMigration, type SpawnSpec, Template, templatesUsing,
} from "../lib/spec";
import { NestError } from "../lib/util";
import { ErrorCodes } from "../protocol/model";

/**
 * Fields the previous release requires in every template row (its schema has no default for
 * `escalate_to`): written beside each template for one release, so a rollback still spawns from a
 * template written now. This release's schema strips them on read; they mean nothing here.
 */
const PREVIOUS_RELEASE_TEMPLATE_FIELDS = { escalate_to: "user", subscribe: [] } as const;
const templateRow = (t: Template): string => JSON.stringify({ ...PREVIOUS_RELEASE_TEMPLATE_FIELDS, ...t });

export class CatalogDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  /** `GET /v1/health`'s read-only round trip (lib/health.ts). */
  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // The health instance (`GET /v1/health`) stores nothing: no schema, no alarm.
    if (isHealthInstance(ctx, env.CATALOG)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS capabilities (name TEXT PRIMARY KEY, body TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS templates (name TEXT PRIMARY KEY, body TEXT NOT NULL)");
    // Seeded once: an entry the operator deletes stays deleted. A catalog seeded by an earlier
    // version (no `seed_version`: version 1) gains each later version's new entries once, where the
    // name is free, and loses the capabilities a later version removed (from every template too, which
    // keeps its other capabilities) and the tools and fields it removed (from every capability, which
    // keeps the rest); a seed prompt a later version replaced is replaced only where it is unedited.
    // Existing entries are otherwise never edited. One synchronous step with the new version.
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
        this.removeSeed(m.removes);
        this.rewritePrompts(m.prompts);
        this.setSeedVersion(m.version);
      }
    }
  }

  private insertSeed(c: Pick<Catalog, "capabilities" | "templates">): void {
    for (const [name, cap] of Object.entries(c.capabilities)) {
      this.sql.exec("INSERT OR IGNORE INTO capabilities (name, body) VALUES (?, ?)", name, JSON.stringify(cap));
    }
    for (const [name, t] of Object.entries(c.templates)) {
      this.sql.exec("INSERT OR IGNORE INTO templates (name, body) VALUES (?, ?)", name, templateRow(t));
    }
  }

  /**
   * Delete the removed capabilities and prune them (and the parameters they read) from every template
   * row, and the removed tools and fields from every capability row.
   */
  private removeSeed(removes: Removes): void {
    for (const name of removes.capabilities) this.sql.exec("DELETE FROM capabilities WHERE name = ?", name);
    if (removes.capabilities.length) this.rewriteRows("templates", (body) => pruneTemplate(body, removes));
    if (removes.tools?.length || removes.fields?.length) this.rewriteRows("capabilities", (body) => pruneCapability(body, removes));
  }

  /** Replace each seed prompt still as a step left it, in step order. */
  private rewritePrompts(prompts: readonly PromptRewrite[]): void {
    for (const p of prompts) this.rewriteRows("capabilities", (body) => rewritePrompt(body, p), p.capability);
  }

  /** Each row of `table` (or only `only`) that `edit` changes (non-null), written back. A row that isn't JSON is left. */
  private rewriteRows(table: "templates" | "capabilities", edit: (body: unknown) => Record<string, unknown> | null, only?: string): void {
    const rows = only === undefined
      ? this.sql.exec<{ name: string; body: string }>(`SELECT name, body FROM ${table}`).toArray()
      : this.sql.exec<{ name: string; body: string }>(`SELECT name, body FROM ${table} WHERE name = ?`, only).toArray();
    for (const r of rows) {
      let body: unknown;
      try {
        body = JSON.parse(r.body);
      } catch {
        continue; // `load()` logs and skips it, as before.
      }
      const edited = edit(body);
      if (edited) this.sql.exec(`UPDATE ${table} SET body = ? WHERE name = ?`, JSON.stringify(edited), r.name);
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

  /** Create or replace a capability. Its tools must be platform tools, and its mcp source a server nest will call. */
  async putCapability(name: string, cap: Capability): Promise<Capability> {
    const r = checkCapability(cap, PLATFORM_TOOL_NAMES, {
      name, allowLoopback: this.env.ALLOW_LOOPBACK_MCP === "1", allowLoopbackBrokered: this.env.ALLOW_LOOPBACK_BROKERED === "1",
    });
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name}: ${r.error}`);
    // Every template listing it must still hold together (e.g. a parameter default it no longer takes).
    const cat = this.load();
    const next = { ...cat.capabilities, [name]: cap };
    for (const t of templatesUsing(cat, name)) {
      const c = checkTemplate(cat.templates[t]!, next);
      if (!c.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name}: template ${t} would break: ${c.error}`, 409);
    }
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
      name, templateRow(tpl));
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
