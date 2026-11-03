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
  expandTemplate, mcpPrefix, rewritePrompt, SEED_CATALOG, SEED_VERSION, seedMigration, type SpawnSpec, Template, templatesUsing,
} from "../lib/spec";
import { capabilityOutsideGrant, entryVisible, type Grant, grantRefusal, namespaceOf, specOutsideGrant } from "../lib/clients";
import { CLIENT_DIRECTORY } from "./client";
import { NestError } from "../lib/util";
import { ErrorCodes } from "../protocol/model";

/**
 * Fields the previous release requires in every template row (its schema has no default for
 * `escalate_to`): written beside each template for one release, so a rollback still spawns from a
 * template written now. This release's schema strips them on read; they mean nothing here.
 */
const PREVIOUS_RELEASE_TEMPLATE_FIELDS = { escalate_to: "user", subscribe: [] } as const;
const templateRow = (t: Template): string => JSON.stringify({ ...PREVIOUS_RELEASE_TEMPLATE_FIELDS, ...t });

/**
 * A client acting on the catalog (docs/control-plane/api/clients/#the-clients-catalog): it sees the
 * operator's entries and its own namespace, and everything it writes or spawns is held to its grant.
 */
export interface ClientScope {
  /** Its id, `cli_…` (named in refusals). */
  client: string;
  /** Its name: its namespace. */
  name: string;
  grant: Grant;
}

/** The entries `scope` sees (all of them for the operator, `undefined`). */
function visibleTo(cat: Catalog, scope: ClientScope | undefined): Catalog {
  if (!scope) return cat;
  const pick = <T>(r: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(r).filter(([n]) => entryVisible(n, scope.name)));
  return { capabilities: pick(cat.capabilities), templates: pick(cat.templates) };
}

/** A client's write may only name entries it sees: the operator's and its own. */
function refuseHidden(names: readonly string[], scope: ClientScope | undefined, what: string): void {
  const hidden = scope ? names.filter((n) => !entryVisible(n, scope.name)) : [];
  if (hidden.length) throw new NestError(ErrorCodes.INVALID_MESSAGE, `${what}: unknown ${hidden.join(", ")}`);
}

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

  /** The catalog, or what a client sees of it: the operator's entries and its own. */
  async catalog(scope?: ClientScope): Promise<Catalog> {
    return visibleTo(this.load(), scope);
  }

  /** One entry (404 when absent). */
  async entry(kind: "templates" | "capabilities", name: string): Promise<Template | Capability> {
    const cat = this.load();
    const e = kind === "templates" ? cat.templates[name] : cat.capabilities[name];
    if (!Object.hasOwn(cat[kind], name) || !e) throw new NestError(ErrorCodes.NOT_FOUND, `unknown ${kind === "templates" ? "template" : "capability"} ${name}`, 404);
    return e;
  }

  /**
   * Create or replace a capability. Its tools must be platform tools, and its mcp source a server nest
   * will call. A client's (`scope`) names only entries it sees and stays within its grant.
   */
  async putCapability(name: string, cap: Capability, scope?: ClientScope): Promise<Capability> {
    const r = checkCapability(cap, PLATFORM_TOOL_NAMES, {
      name: mcpPrefix(name), allowLoopback: this.env.ALLOW_LOOPBACK_MCP === "1", allowLoopbackBrokered: this.env.ALLOW_LOOPBACK_BROKERED === "1",
    });
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name}: ${r.error}`);
    if (scope) {
      refuseHidden(cap.spawn ?? [], scope, `capability ${name}: spawn`);
      const refusal = grantRefusal(scope.client, capabilityOutsideGrant(name, cap, scope.grant));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `capability ${name}: ${refusal}`, 403);
    }
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

  /**
   * Create or replace a template. Its capabilities must exist. A client's (`scope`) lists only
   * capabilities it sees, and expands within its grant.
   */
  async putTemplate(name: string, tpl: Template, scope?: ClientScope): Promise<Template> {
    refuseHidden(tpl.capabilities, scope, `template ${name}`);
    const cat = this.load();
    const r = checkTemplate(tpl, cat.capabilities);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `template ${name}: ${r.error}`);
    // Expanded as written (no overrides): what it gives must hold together, and a client's stay in its grant.
    const spec = expandTemplate({ capabilities: cat.capabilities, templates: { [name]: tpl } }, PLATFORM_TOOL_NAMES, name,
      scope ? { [scope.name]: scope.client } : {});
    if (!spec.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, spec.error);
    if (scope) {
      const refusal = grantRefusal(scope.client, specOutsideGrant(spec.value, scope.grant));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `template ${name}: ${refusal}`, 403);
    }
    this.sql.exec("INSERT INTO templates (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      name, templateRow(tpl));
    return tpl;
  }

  async deleteTemplate(name: string): Promise<void> {
    this.sql.exec("DELETE FROM templates WHERE name = ?", name);
  }

  /**
   * The client of each namespace template `name`'s capabilities are in (`expandSpec`'s `clients`): a
   * client's own from its scope, any other's from the client directory. Only the catalog is read before
   * the await; nothing here is written.
   */
  private async namespaceClients(cat: Catalog, name: string, scope?: ClientScope): Promise<Record<string, string>> {
    const tpl = Object.hasOwn(cat.templates, name) ? cat.templates[name] : undefined;
    const out: Record<string, string> = scope ? { [scope.name]: scope.client } : {};
    const wanted = new Set([...(tpl?.capabilities ?? []).filter((c) => cat.capabilities[c]?.mcp), ...(tpl?.inject?.length ? [name] : [])]
      .map(namespaceOf).filter((ns): ns is string => ns !== null));
    for (const ns of wanted) {
      if (Object.hasOwn(out, ns)) continue;
      const id = await this.env.CLIENT.get(this.env.CLIENT.idFromName(CLIENT_DIRECTORY)).lookup(ns);
      if (id) out[ns] = id;
    }
    return out;
  }

  /** A deleted client's namespace: every `<ns>/…` entry, templates first. */
  async deleteNamespace(ns: string): Promise<number> {
    const prefix = `${ns}/`;
    let n = this.sql.exec("DELETE FROM templates WHERE substr(name, 1, ?) = ?", prefix.length, prefix).rowsWritten;
    n += this.sql.exec("DELETE FROM capabilities WHERE substr(name, 1, ?) = ?", prefix.length, prefix).rowsWritten;
    return n;
  }

  /**
   * Expand a spawn spec against the current catalog (400 when it doesn't expand). In a client's
   * subtree (`scope`), only what it sees expands, and the result must lie within its grant (403):
   * neither a template nor an override widens it.
   */
  async expand(spec: SpawnSpec, scope?: ClientScope): Promise<AgentSpec> {
    const cat = visibleTo(this.load(), scope);
    const r = expandSpec(cat, PLATFORM_TOOL_NAMES, spec, await this.namespaceClients(cat, spec.template, scope));
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, r.error);
    if (scope) {
      const refusal = grantRefusal(scope.client, specOutsideGrant(r.value, scope.grant));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `template ${spec.template}: ${refusal}`, 403);
    }
    return r.value;
  }
}
