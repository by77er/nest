// `GET /v1/health` (docs/control-plane/#upgrades, dev/deploy.md): one read-only round trip to each
// Durable Object class, on an instance of its own that nothing else addresses. That instance stores
// nothing and arms no alarm: each class's constructor returns before its schema when it is the health
// instance (`isHealthInstance`), and `health()` only reads.
import type { Env } from "../env";

/**
 * The health instance's name in every namespace. `~` appears in no name anything else derives an
 * instance from (cells, agent and sandbox ids, `broker`, `catalog`, MCP connector names,
 * which start `["mcp",`; the previous releases' ChannelDO directory was `~directory` and workstream ids `ws_…`), so no user input reaches it.
 */
export const HEALTH_INSTANCE = "~health";

/** How long each class has to answer; the deploy's smoke check gives a whole request 10 s. */
export const HEALTH_TIMEOUT_MS = 5_000;

/** Whether this object is its namespace's health instance (constructors skip their schema for it). */
export function isHealthInstance(ctx: DurableObjectState, ns: { idFromName(name: string): DurableObjectId }): boolean {
  return ctx.id.equals(ns.idFromName(HEALTH_INSTANCE));
}

/** The health RPC's body: a read that touches no table, so it proves the object runs and its SQLite answers. */
export function healthRead(sql: SqlStorage): true {
  sql.exec("SELECT 1").toArray();
  return true;
}

export type ProbeOutcome = "ok" | "error" | "timeout";

/** One probe per Durable Object class, by class name (what a failing health check names). */
export function healthProbes(env: Env): Record<string, () => Promise<unknown>> {
  const at = <T extends { health(): Promise<unknown> }>(ns: { idFromName(n: string): DurableObjectId; get(id: DurableObjectId): T }) =>
    () => ns.get(ns.idFromName(HEALTH_INSTANCE)).health();
  return {
    FleetDO: at(env.FLEET),
    SandboxDO: at(env.SANDBOX),
    AgentDO: at(env.AGENT),
    BrokerDO: at(env.BROKER),
    CatalogDO: at(env.CATALOG),
    WorkstreamDO: at(env.WORKSTREAM),
    ChannelDO: at(env.CHANNEL),
    TaskLedgerDO: at(env.TASKS),
    McpConnectorDO: at(env.MCP_CONNECTOR),
  };
}

/**
 * Run every probe in parallel, each cut off at `timeoutMs`. `ok` only if every one answered; each
 * class's outcome is named, and nothing else (no ids, no error text) is reported.
 */
export async function checkHealth(probes: Record<string, () => Promise<unknown>>, timeoutMs = HEALTH_TIMEOUT_MS): Promise<{ ok: boolean; durable_objects: Record<string, ProbeOutcome> }> {
  const entries = await Promise.all(Object.entries(probes).map(async ([name, probe]): Promise<[string, ProbeOutcome]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ProbeOutcome>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const outcome = await Promise.race([Promise.resolve().then(probe).then((): ProbeOutcome => "ok", (e: unknown): ProbeOutcome => {
        console.error(`health: ${name} failed`, e);
        return "error";
      }), timeout]);
      if (outcome === "timeout") console.error(`health: ${name} didn't answer within ${timeoutMs} ms`);
      return [name, outcome];
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }));
  const durable_objects = Object.fromEntries(entries);
  return { ok: entries.every(([, o]) => o === "ok"), durable_objects };
}
