// CatalogDO (one, named "catalog"): templates and capabilities, stored as data and edited by the
// operator (docs/control-plane/durable-objects/catalog/). Seeded once with `worker` and `captain` (and
// migrated once per later seed version: new entries, and the capabilities and tools the platform removed);
// expansion itself is pure (lib/spec.ts).
import { DurableObject } from "cloudflare:workers";
import { healthRead, isHealthInstance } from "../lib/health";
import type { Env } from "../env";
import { PLATFORM_TOOL_NAMES } from "../lib/registry";
import {
  type AgentSpec, Capability, type Catalog, checkCapability, checkTemplate, EntryName, expandSpec, type PromptRewrite, pruneCapability, pruneTemplate, type Removes,
  expandTemplate, mcpPrefix, rewritePrompt, rewriteRules, type RuleSource, type RulesRewrite, SEED_CATALOG, templateRuleSources, SEED_VERSION, seedMigration, type SpawnSpec, Template,
  templatesUsing,
} from "../lib/spec";
import type { ToolRule } from "../protocol/control";
import { Deadlines } from "../lib/reliable";
import {
  capabilityOutsideGrant, capabilityRepos, grantBoundIds, REPO_OWNERS_PER_CALL, entryVisible, type Grant, grantRefusal, namespaceOf, ownerLookups, type RepoOwners, specOutsideGrant, specRepos,
} from "../lib/clients";
import { CLIENT_DIRECTORY } from "./client";
import { asNestError, NestError } from "../lib/util";
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
  /**
   * The grant's revision: higher for every later `setGrant` (absent in a record from before it: 0). A
   * copy of the grant kept elsewhere (a sandbox's egress ceiling) is never replaced by an older one.
   */
  grant_rev?: number;
  /**
   * The identity the revision counts within: random, fixed for the record, and new whenever the record
   * has no revision (it was lost, or never set), so a copy compares revisions only within one epoch.
   */
  grant_epoch?: string;
}

/** Live agents told of a rules change per alarm run, at once (docs/control-plane/durable-objects/catalog/#live-rules). */
export const NUDGE_BATCH = 64;
/** A nudge an agent didn't take is sent again after this, doubling to `NUDGE_RETRY_MAX_MS`. */
export const NUDGE_RETRY_MS = 5_000;
export const NUDGE_RETRY_MAX_MS = 300_000;

/** What `watchRules` answers: each capability's rules now (null: it doesn't exist), and those that don't parse. */
export interface WatchedRules {
  rules: Record<string, ToolRule[] | null>;
  /** Stored rows this release can't read (a later release's, a hand edit): the agent keeps the rules it has. */
  unreadable: string[];
}

/** The entries `scope` sees (all of them for the operator, `undefined`). */
function visibleTo(cat: Catalog, scope: Pick<ClientScope, "name"> | undefined): Catalog {
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
  private readonly deadlines!: Deadlines<"nudge">;

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
    // Live rules (docs/control-plane/durable-objects/catalog/#live-rules): which live agents read which
    // capability's rules (each agent sets its own rows), and the agents still to be told of a change.
    this.sql.exec("CREATE TABLE IF NOT EXISTS rule_watch (capability TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY (capability, agent))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS rule_watch_agent ON rule_watch (agent)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS rule_nudges (agent TEXT PRIMARY KEY, rev INTEGER NOT NULL, attempts INTEGER NOT NULL, next_ms INTEGER NOT NULL)");
    this.deadlines = new Deadlines(this.sql, ctx.storage);
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
        // Every capability row the steps change, however they change it, is found by comparing the rows.
        const before = this.capabilityRows();
        this.insertSeed(m);
        this.removeSeed(m.removes);
        this.rewritePrompts(m.prompts);
        this.rewriteRules(m.rules);
        this.setSeedVersion(m.version);
        const after = this.capabilityRows();
        // Changed, deleted or inserted (a name an agent may still watch from before a deletion).
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((n) => after.get(n) !== before.get(n));
        // The live agents reading a capability the step changed or deleted are told, as for any write
        // (the rows in this step; only arming the alarm is awaited).
        if (changed.length) {
          const armed = this.nudgeWatchers(changed);
          void ctx.blockConcurrencyWhile(() => armed);
        }
      }
    }
    // A rolled-back release (no alarm handler) may have left nudges with no storage alarm: armed again.
    void ctx.blockConcurrencyWhile(() => this.armNudges());
  }

  /** Every stored capability row, by name, as stored. */
  private capabilityRows(): Map<string, string> {
    return new Map(this.sql.exec<{ name: string; body: string }>("SELECT name, body FROM capabilities").toArray().map((r) => [r.name, r.body]));
  }

  /**
   * Arm the `nudge` deadline for the first nudge due (or `at`, if sooner), and the storage alarm when none
   * is set: a rolled-back release has no alarm handler, so its run may have consumed the alarm and left
   * the deadline row, and `Deadlines.set` returns early for a row already armed earlier.
   */
  private async armNudges(at?: number): Promise<void> {
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(next_ms) AS at FROM rule_nudges").one().at;
    if (next === null) return;
    await this.deadlines.set("nudge", Math.min(at ?? next, next), true);
    if ((await this.ctx.storage.getAlarm()) === null) await this.deadlines.reschedule();
  }

  // --- Live rules (docs/control-plane/durable-objects/catalog/#live-rules) ----------------------------

  /**
   * Capabilities `names` were written or deleted: every live agent reading one is to be told, in the
   * caller's synchronous step (the rows and the `nudge` deadline are written before this awaits), so a
   * reset after the write can't lose a nudge. A row already waiting is replaced: its new `rev` means an
   * acknowledgement of the older nudge doesn't delete it.
   */
  private nudgeWatchers(names: readonly string[]): Promise<void> {
    const rev = Number(this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = 'rules_rev'").toArray()[0]?.value ?? "0") + 1;
    this.sql.exec("INSERT INTO kv (key, value) VALUES ('rules_rev', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(rev));
    const now = Date.now();
    let any = false;
    for (const name of new Set(names)) {
      for (const { agent } of this.sql.exec<{ agent: string }>("SELECT agent FROM rule_watch WHERE capability = ?", name).toArray()) {
        this.sql.exec(
          "INSERT INTO rule_nudges (agent, rev, attempts, next_ms) VALUES (?, ?, 0, ?) ON CONFLICT(agent) DO UPDATE SET rev = excluded.rev, attempts = 0, next_ms = excluded.next_ms",
          agent, rev, now,
        );
        any = true;
      }
    }
    return any ? this.armNudges(now) : Promise.resolve();
  }

  /**
   * An agent's watch, set to exactly `names` (none: it reads no capability's rules any more, or it
   * ended), and those capabilities' rules as they are now, in the same step: a write either lands
   * before it (and is read here) or after (and nudges the agent).
   */
  async watchRules(agent: string, names: string[]): Promise<WatchedRules> {
    if (typeof agent !== "string" || !agent.startsWith("agt_")) throw new NestError(ErrorCodes.INVALID_MESSAGE, "watchRules: an agent id");
    if (!Array.isArray(names) || !names.every((n) => EntryName.safeParse(n).success)) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, "watchRules: capability names");
    }
    const want = [...new Set(names)];
    const have = this.sql.exec<{ capability: string }>("SELECT capability FROM rule_watch WHERE agent = ?", agent).toArray().map((r) => r.capability);
    // The hourly read finds its watch as it was: nothing to write.
    const same = have.length === want.length && want.every((n) => have.includes(n));
    if (!same) {
      this.sql.exec("DELETE FROM rule_watch WHERE agent = ?", agent);
      for (const name of want) this.sql.exec("INSERT INTO rule_watch (capability, agent) VALUES (?, ?)", name, agent);
    }
    const out: WatchedRules = { rules: {}, unreadable: [] };
    for (const name of want) {
      const row = this.sql.exec<{ body: string }>("SELECT body FROM capabilities WHERE name = ?", name).toArray()[0];
      if (!row) {
        out.rules[name] = null;
        continue;
      }
      let parsed: ReturnType<typeof Capability.safeParse> | undefined;
      try {
        parsed = Capability.safeParse(JSON.parse(row.body));
      } catch {
        parsed = undefined;
      }
      if (parsed?.success) out.rules[name] = parsed.data.rules;
      else out.unreadable.push(name);
    }
    // An agent that reads nothing needs no nudge.
    if (!names.length) this.sql.exec("DELETE FROM rule_nudges WHERE agent = ?", agent);
    // Nudges a rolled-back release left waiting (it has no alarm handler) are sent again.
    await this.armNudges();
    return out;
  }

  /**
   * The rule sources template `name` gives an agent in namespace `ns`'s subtree as it is now (as at a
   * spawn): for an agent from before rule sources whose operator clears its rules.
   */
  async ruleSources(name: string, ns: string | null): Promise<RuleSource[]> {
    const r = templateRuleSources(visibleTo(this.load(), ns === null ? undefined : { name: ns }), name, ns);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, r.error, 409);
    return r.value;
  }

  /** The `nudge` deadline: tell up to `NUDGE_BATCH` agents their capabilities' rules changed; each row goes once its agent took it. */
  private async deliverNudges(): Promise<void> {
    const now = Date.now();
    const due = this.sql.exec<{ agent: string; rev: number; attempts: number }>(
      "SELECT agent, rev, attempts FROM rule_nudges WHERE next_ms <= ? ORDER BY next_ms LIMIT ?", now, NUDGE_BATCH,
    ).toArray();
    await Promise.all(due.map(async (r) => {
      try {
        await this.env.AGENT.get(this.env.AGENT.idFromName(r.agent)).rulesChanged();
        this.sql.exec("DELETE FROM rule_nudges WHERE agent = ? AND rev = ?", r.agent, r.rev);
      } catch (e) {
        if (asNestError(e)?.code === ErrorCodes.UNKNOWN_AGENT) {
          // Gone (its record pruned): it reads nothing any more.
          this.sql.exec("DELETE FROM rule_nudges WHERE agent = ? AND rev = ?", r.agent, r.rev);
          this.sql.exec("DELETE FROM rule_watch WHERE agent = ?", r.agent);
          return;
        }
        console.warn(`catalog: telling ${r.agent} its rules changed failed; retrying`, e);
        const wait = Math.min(NUDGE_RETRY_MS * 2 ** Math.min(r.attempts, 16), NUDGE_RETRY_MAX_MS);
        this.sql.exec("UPDATE rule_nudges SET attempts = attempts + 1, next_ms = ? WHERE agent = ? AND rev = ?", Date.now() + wait, r.agent, r.rev);
      }
    }));
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(next_ms) AS at FROM rule_nudges").one().at;
    if (next !== null) await this.deadlines.set("nudge", Math.max(next, Date.now()));
  }

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "nudge") await this.deliverNudges();
      else console.error(`catalog: no handler for deadline ${key}; dropped`);
    });
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

  /** Replace each seed capability's rules still exactly as the seed left them, in step order (an operator's edit stays). */
  private rewriteRules(rules: readonly RulesRewrite[]): void {
    for (const r of rules) this.rewriteRows("capabilities", (body) => rewriteRules(body, r), r.capability);
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
    // GitHub's answer for repos only an owner-wide entry could cover; the catalog is read after this await.
    const owners = scope ? await this.repoOwners(scope, capabilityRepos(cap)) : {};
    if (scope) {
      refuseHidden(cap.spawn ?? [], scope, `capability ${name}: spawn`);
      const refusal = grantRefusal(scope.client, capabilityOutsideGrant(name, cap, scope.grant, owners));
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
    // Its rules reach every live agent that reads them (the write and the nudges in one step).
    await this.nudgeWatchers([name]);
    return cap;
  }

  /** Delete a capability no template lists. A live agent that read its rules has none of them from now on. */
  async deleteCapability(name: string): Promise<void> {
    const users = templatesUsing(this.load(), name);
    if (users.length) throw new NestError(ErrorCodes.INVALID_MESSAGE, `capability ${name} is listed by ${users.join(", ")}`, 409);
    this.sql.exec("DELETE FROM capabilities WHERE name = ?", name);
    await this.nudgeWatchers([name]);
  }

  /**
   * Create or replace a template. Its capabilities must exist. A client's (`scope`) lists only
   * capabilities it sees, and expands within its grant.
   */
  async putTemplate(name: string, tpl: Template, scope?: ClientScope): Promise<Template> {
    refuseHidden(tpl.capabilities, scope, `template ${name}`);
    // Expand first (nest-wire): the previous release's CatalogDO parses a location strictly and would skip the
    // whole template after a rollback. Taken in a template from the release after (docs/interfaces/#pending-contract-changes).
    const basicUser = (tpl.inject ?? []).find((b) => b.locations.some((l) => l.type === "authorization_basic_password" && l.username !== undefined));
    if (basicUser) {
      throw new NestError(ErrorCodes.INVALID_MESSAGE, `template ${name}: binding ${basicUser.name} names a Basic username, which a catalog template can't hold yet (a rollback would drop the template): name it in a sandbox's or a spawn's own bindings instead`);
    }
    // GitHub's answer for repos only an owner-wide entry could cover, from a first expansion; everything
    // below runs again from the catalog as it is after this await, in one step.
    const owners = scope ? await this.repoOwners(scope, this.templateRepos(name, tpl, scope)) : {};
    const cat = this.load();
    const r = checkTemplate(tpl, cat.capabilities);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, `template ${name}: ${r.error}`);
    // Expanded as written (no overrides): what it gives must hold together (its launch's model and effort
    // plain tokens, `launchProblem`, whoever writes it), and a client's stay in its grant.
    const spec = expandTemplate({ capabilities: cat.capabilities, templates: { [name]: tpl } }, PLATFORM_TOOL_NAMES, name,
      scope ? { [scope.name]: scope.client } : {});
    if (!spec.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, spec.error);
    if (scope) {
      const refusal = grantRefusal(scope.client, specOutsideGrant(spec.value, scope.grant, owners));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `template ${name}: ${refusal}`, 403);
    }
    this.sql.exec("INSERT INTO templates (name, body) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body",
      name, templateRow(tpl));
    return tpl;
  }

  /**
   * GitHub's answer (BrokerDO) for the repos among `repos` that only an owner-wide entry of `grant` could
   * cover (`ownerLookups`); nothing is asked for a grant of exact entries.
   */
  private async repoOwners(scope: ClientScope, repos: readonly string[]): Promise<RepoOwners> {
    const grant = scope.grant;
    const need = ownerLookups(grant, repos);
    const out: Record<string, number | null> = {};
    // BrokerDO answers at most `REPO_OWNERS_PER_CALL` a call; a spec may name more.
    for (let i = 0; i < need.length; i += REPO_OWNERS_PER_CALL) {
      Object.assign(out, await this.env.BROKER.get(this.env.BROKER.idFromName("broker")).repoOwners(need.slice(i, i + REPO_OWNERS_PER_CALL), grantBoundIds(grant), scope.client));
    }
    return out;
  }

  /** The repos template `name` would reach as written (none when it doesn't expand: its checks below say why). */
  private templateRepos(name: string, tpl: Template, scope: ClientScope): string[] {
    const cat = this.load();
    const spec = expandTemplate({ capabilities: cat.capabilities, templates: { [name]: tpl } }, PLATFORM_TOOL_NAMES, name, { [scope.name]: scope.client });
    return spec.ok ? specRepos(spec.value) : [];
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
    const wanted = new Set([...(tpl?.capabilities ?? []).filter((c) => cat.capabilities[c]?.mcp), ...(tpl?.inject?.length || tpl?.guards?.length ? [name] : [])]
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
    const caps = this.sql.exec<{ name: string }>("SELECT name FROM capabilities WHERE substr(name, 1, ?) = ?", prefix.length, prefix).toArray().map((r) => r.name);
    let n = this.sql.exec("DELETE FROM templates WHERE substr(name, 1, ?) = ?", prefix.length, prefix).rowsWritten;
    n += this.sql.exec("DELETE FROM capabilities WHERE substr(name, 1, ?) = ?", prefix.length, prefix).rowsWritten;
    await this.nudgeWatchers(caps);
    return n;
  }

  /**
   * Expand a spawn spec against the current catalog (400 when it doesn't expand). In a client's
   * subtree (`scope`), only what it sees expands, and the result must lie within its grant (403):
   * neither a template nor an override widens it.
   */
  async expand(spec: SpawnSpec, scope?: ClientScope): Promise<AgentSpec> {
    const cat = visibleTo(this.load(), scope);
    const r = expandSpec(cat, PLATFORM_TOOL_NAMES, spec, await this.namespaceClients(cat, spec.template, scope), scope?.name ?? null);
    if (!r.ok) throw new NestError(ErrorCodes.INVALID_MESSAGE, r.error);
    if (scope) {
      const owners = await this.repoOwners(scope, specRepos(r.value));
      const refusal = grantRefusal(scope.client, specOutsideGrant(r.value, scope.grant, owners));
      if (refusal) throw new NestError(ErrorCodes.FORBIDDEN, `template ${spec.template}: ${refusal}`, 403);
    }
    return r.value;
  }
}
