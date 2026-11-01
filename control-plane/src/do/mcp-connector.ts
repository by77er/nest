// McpConnectorDO: one remote MCP server as nest shares it (docs/agents/capabilities/mcp/#the-connector),
// keyed by `connectorName(grant)`: the server's URL and the credential it is called with. It owns what is
// per server rather than per agent:
// - the tool list: one `tools/list` over the connector's own MCP session, cached for every agent;
// - noticing that the list changed (`notifications/tools/list_changed` on any stream it or an AgentDO
//   reads, or its re-list interval while brains use it) and telling each subscribed AgentDO, from its
//   alarm only (never while an AgentDO is mid-call into it);
// - admission: at most `max_concurrent` calls in flight and `per_minute` calls a minute, across agents,
//   as leases an AgentDO takes before it forwards.
// It never forwards a call, never sees one's arguments, and never decides the epoch fence: AgentDO does,
// in the synchronous step the request leaves, after the lease's await.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { num } from "../env";
import { healthRead, isHealthInstance } from "../lib/health";
import {
  checkMcpUrl, listAll, type ListedTool, MCP_DEFAULT_MAX_CONCURRENT, MCP_DEFAULT_PER_MINUTE, type McpGrant, openSession, toolsDigest,
} from "../lib/mcp";
import { type Admission, type ConnectorList, MCP_LIST_TTL_MS, mcpToken, setupError } from "../lib/mcp-proxy";
import { Deadlines, withTimeout } from "../lib/reliable";
import { newId } from "../lib/util";

/** While any brain uses the list, it is fetched again this often (`MCP_RELIST_MS`): a change no stream carried is seen within it. */
export const MCP_RELIST_MS = 60_000;
/** A subscriber the connector hasn't heard from this long is asked whether it still wants notices. */
export const SUBSCRIBER_PROBE_MS = 6 * 3_600_000;
/** A subscriber that hasn't answered for this long is dropped (its next list subscribes it again). */
export const SUBSCRIBER_TTL_MS = 24 * 3_600_000;
/** Admission's rate window. */
const RATE_WINDOW_MS = 60_000;
/** Notices (or probes) sent per alarm run, and how long each may take. */
const NOTICES_PER_RUN = 50;
const NOTICE_TIMEOUT_MS = 5_000;
const NOTICE_RETRY_MS = 5_000;

type Key = "relist" | "notices";

/** The AgentDO side of a notice (`AgentDO.mcpToolsChanged`): whether it still wants notices. */
type Notify = (agent: string, server: Pick<McpGrant, "url" | "auth">, changed: boolean) => Promise<boolean>;

export class McpConnectorDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly deadlines!: Deadlines<Key>;
  /** The fetch in flight: concurrent lists wait for one `tools/list`. */
  private fetching: Promise<ConnectorList> | null = null;
  /** Tests replace how a notice reaches an AgentDO. */
  notify: Notify = (agent, server, changed) => this.env.AGENT.get(this.env.AGENT.idFromName(agent)).mcpToolsChanged(server, changed);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    if (isHealthInstance(ctx, env.MCP_CONNECTOR)) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    // `digest`: the list it was last handed or told of; it is owed a notice while that isn't the current one.
    this.sql.exec("CREATE TABLE IF NOT EXISTS subscribers (agent TEXT PRIMARY KEY, seen_ms INTEGER NOT NULL, digest TEXT, next_ms INTEGER NOT NULL DEFAULT 0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, agent TEXT NOT NULL, expires_ms INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS admits (id INTEGER PRIMARY KEY AUTOINCREMENT, ms INTEGER NOT NULL)");
    this.deadlines = new Deadlines<Key>(this.sql, ctx.storage);
  }

  async health(): Promise<true> {
    return healthRead(this.sql);
  }

  private kv<T>(key: string): T | undefined {
    const r = this.sql.exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key).toArray()[0];
    return r ? (JSON.parse(r.value) as T) : undefined;
  }

  private kvPut(key: string, value: unknown): void {
    this.sql.exec("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, JSON.stringify(value));
  }

  private cached(): ConnectorList & { digest: string | null } {
    return { tools: this.kv<ListedTool[]>("tools") ?? null, listed_ms: this.kv<number>("listed_ms") ?? 0, digest: this.kv<string>("digest") ?? null };
  }

  private relistMs(): number {
    return num(this.env.MCP_RELIST_MS, MCP_RELIST_MS);
  }

  // --- The list -----------------------------------------------------------------------------------------

  /**
   * The server's tools: the cache while it's fresh (`MCP_LIST_TTL_MS`) and no change was reported, else
   * fetched again within the list timeout; a failed fetch serves the cache. `subscriber`: an agent whose
   * brain is handed this list, told (from the alarm) when it changes.
   */
  async list(g: McpGrant, subscriber: string | null): Promise<ConnectorList> {
    // The grant the alarm re-lists with: the latest caller's (every caller names this URL and credential).
    this.kvPut("grant", g);
    const now = Date.now();
    if (subscriber) {
      this.sql.exec(`INSERT INTO subscribers (agent, seen_ms, digest) VALUES (?, ?, NULL)
        ON CONFLICT(agent) DO UPDATE SET seen_ms = excluded.seen_ms`, subscriber, now);
      await this.deadlines.set("relist", now + this.relistMs(), true);
    }
    let c = this.cached();
    if (!c.tools || this.kv<boolean>("stale") || now - c.listed_ms >= MCP_LIST_TTL_MS) {
      try {
        await this.refresh(g);
      } catch (e) {
        console.warn(`mcp connector ${new URL(g.url).host}: tools/list failed${c.tools ? "; serving the cached list" : ""}`, e);
      }
      c = this.cached();
    }
    // Handed the current list: it is owed no notice for it.
    if (subscriber && c.digest) this.sql.exec("UPDATE subscribers SET digest = ? WHERE agent = ?", c.digest, subscriber);
    return { tools: c.tools, listed_ms: c.listed_ms };
  }

  /** An AgentDO read `notifications/tools/list_changed` on a call's stream: fetch the list again now. */
  async changed(g: McpGrant): Promise<void> {
    this.kvPut("grant", g);
    this.kvPut("stale", true);
    await this.deadlines.set("relist", Date.now(), true);
  }

  /** One fetch at a time; a newer list owes every subscriber that wasn't handed it a notice. */
  private refresh(g: McpGrant): Promise<ConnectorList> {
    this.fetching ??= this.fetchList(g).finally(() => {
      this.fetching = null;
    });
    return this.fetching;
  }

  private async fetchList(g: McpGrant): Promise<ConnectorList> {
    const timeout = num(this.env.MCP_LIST_TIMEOUT_MS, 4_000);
    const deadline = Date.now() + timeout;
    const u = checkMcpUrl(g.url, this.env.ALLOW_LOOPBACK_MCP === "1");
    if (!u.ok) throw new Error(u.error);
    const token = await mcpToken(this.env, g);
    if (!token) throw new Error(`no credential stored as ${g.auth}`);
    // Cleared before the fetch: a change reported while it runs marks the list stale again.
    this.kvPut("stale", false);
    for (let reinit = 0; ; reinit++) {
      let s = this.kv<{ session: string | null; version: string }>("session");
      if (!s) {
        const o = await openSession(g.url, token, Math.max(1, deadline - Date.now()), "nest-connector");
        if (o.kind === "failed") throw setupError(g, "initialize", o.answer);
        if (o.kind === "unsupported") throw new Error(`the server speaks ${String(o.version)}`);
        s = { session: o.session, version: o.version };
        this.kvPut("session", s);
      }
      const r = await listAll(g.url, token, s, deadline);
      if (r.kind === "session_gone") {
        // Only the session that failed: one opened meanwhile stays.
        if (this.kv<{ session: string | null }>("session")?.session === s.session) this.sql.exec("DELETE FROM kv WHERE key = 'session'");
        if (reinit >= 1) throw new Error("the server ended two sessions in a row");
        continue;
      }
      if (r.kind === "failed") throw setupError(g, "tools/list", r.answer);
      const digest = await toolsDigest(r.tools);
      const now = Date.now();
      this.kvPut("tools", r.tools);
      this.kvPut("listed_ms", now);
      this.kvPut("digest", digest);
      if (r.list_changed) this.kvPut("stale", true);
      // In the step that stored the list: every subscriber not handed it is owed a notice.
      if (this.owed(digest)) await this.deadlines.set("notices", now, true);
      return { tools: r.tools, listed_ms: now };
    }
  }

  private owed(digest: string): boolean {
    return this.sql.exec("SELECT 1 FROM subscribers WHERE digest IS NOT ? LIMIT 1", digest).toArray().length > 0;
  }

  // --- Admission ----------------------------------------------------------------------------------------

  /**
   * A lease on one of the server's call slots for `holdMs`, if fewer than the grant's `max_concurrent`
   * are held and fewer than its `per_minute` were granted in the last minute; else when to ask again.
   * Each caller is admitted by its own grant's caps. A lease its holder never releases (an incarnation
   * that died mid-call) frees its slot when it expires.
   */
  async acquire(g: McpGrant, agent: string, holdMs: number): Promise<Admission> {
    const now = Date.now();
    this.sql.exec("DELETE FROM leases WHERE expires_ms <= ?", now);
    this.sql.exec("DELETE FROM admits WHERE ms <= ?", now - RATE_WINDOW_MS);
    const held = this.sql.exec<{ n: number; next: number | null }>("SELECT COUNT(*) AS n, MIN(expires_ms) AS next FROM leases").one();
    if (held.n >= (g.max_concurrent ?? MCP_DEFAULT_MAX_CONCURRENT)) return { retry_after_ms: Math.max(1, (held.next ?? now) - now) };
    const recent = this.sql.exec<{ n: number; oldest: number | null }>("SELECT COUNT(*) AS n, MIN(ms) AS oldest FROM admits").one();
    if (recent.n >= (g.per_minute ?? MCP_DEFAULT_PER_MINUTE)) return { retry_after_ms: Math.max(1, (recent.oldest ?? now) + RATE_WINDOW_MS - now) };
    const lease = newId("mls");
    this.sql.exec("INSERT INTO leases (id, agent, expires_ms) VALUES (?, ?, ?)", lease, agent, now + Math.max(1, holdMs));
    this.sql.exec("INSERT INTO admits (ms) VALUES (?)", now);
    return { lease };
  }

  async release(lease: string): Promise<void> {
    this.sql.exec("DELETE FROM leases WHERE id = ?", lease);
  }

  // --- The alarm: re-list, notices, probes ------------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.deadlines.runDue(Date.now(), async (key) => {
      if (key === "relist") await this.relist();
      else if (key === "notices") await this.deliver();
    });
  }

  /** While anyone subscribes: fetch the list again (a change owes notices), probe quiet subscribers, and re-arm. */
  private async relist(): Promise<void> {
    const g = this.kv<McpGrant>("grant");
    if (!g || this.sql.exec("SELECT 1 FROM subscribers LIMIT 1").toArray().length === 0) return;
    try {
      await this.refresh(g);
    } catch (e) {
      console.warn(`mcp connector ${new URL(g.url).host}: re-list failed`, e);
    }
    const now = Date.now();
    const quiet = this.sql.exec<{ agent: string; seen_ms: number }>(
      "SELECT agent, seen_ms FROM subscribers WHERE seen_ms < ? ORDER BY seen_ms LIMIT ?", now - SUBSCRIBER_PROBE_MS, NOTICES_PER_RUN).toArray();
    for (const q of quiet) await this.tell(g, q.agent, q.seen_ms, false, null);
    // A change reported while that fetch ran (it may have left before the change): soon, not a whole interval later.
    const next = this.kv<boolean>("stale") ? Math.min(1_000, this.relistMs()) : this.relistMs();
    if (this.sql.exec("SELECT 1 FROM subscribers LIMIT 1").toArray().length) await this.deadlines.set("relist", Date.now() + next, true);
  }

  /** Tell each subscriber owed a notice (its digest isn't the current one) that the list changed. */
  private async deliver(): Promise<void> {
    const g = this.kv<McpGrant>("grant");
    const digest = this.kv<string>("digest");
    if (!g || !digest) return;
    const now = Date.now();
    const due = this.sql.exec<{ agent: string; seen_ms: number }>(
      "SELECT agent, seen_ms FROM subscribers WHERE digest IS NOT ? AND next_ms <= ? ORDER BY seen_ms LIMIT ?", digest, now, NOTICES_PER_RUN).toArray();
    for (const d of due) await this.tell(g, d.agent, d.seen_ms, true, digest);
    const left = this.sql.exec<{ next: number | null }>("SELECT MIN(next_ms) AS next FROM subscribers WHERE digest IS NOT ?", digest).one().next;
    if (left !== null) await this.deadlines.set("notices", Math.max(left, Date.now() + 1), true);
  }

  /**
   * One notice (`changed`) or probe to an AgentDO. It answers whether it still wants notices: yes keeps
   * it (told of `digest`), no drops it. Unreachable: tried again later, and dropped once it hasn't
   * answered for `SUBSCRIBER_TTL_MS`.
   */
  private async tell(g: McpGrant, agent: string, seen: number, changed: boolean, digest: string | null): Promise<void> {
    try {
      const keep = await withTimeout(this.notify(agent, { url: g.url, auth: g.auth }, changed), NOTICE_TIMEOUT_MS, "mcp notice");
      if (!keep) this.sql.exec("DELETE FROM subscribers WHERE agent = ?", agent);
      else if (digest) this.sql.exec("UPDATE subscribers SET seen_ms = ?, digest = ?, next_ms = 0 WHERE agent = ?", Date.now(), digest, agent);
      else this.sql.exec("UPDATE subscribers SET seen_ms = ? WHERE agent = ?", Date.now(), agent);
    } catch (e) {
      console.warn(`mcp connector: notice to ${agent} failed`, e);
      if (Date.now() - seen > SUBSCRIBER_TTL_MS) this.sql.exec("DELETE FROM subscribers WHERE agent = ?", agent);
      else this.sql.exec("UPDATE subscribers SET next_ms = ? WHERE agent = ?", Date.now() + NOTICE_RETRY_MS, agent);
    }
  }
}
