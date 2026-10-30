// The one schema change in a Durable Object that renames and drops (docs/control-plane/#upgrades,
// the recorded exception): FleetDO's `host_agents` rekeyed from `agent` to `(agent, host)`, with
// `epoch`, in the release of 2026-10-26 (#30). It runs once, in the constructor, for a FleetDO
// whose table still has the old key, and is a no-op on every other; it stays because a FleetDO
// not constructed since then (a cell nothing has touched) would still hold the old shape, and
// this is its only correct reader. The rekey is fenced to this file (scripts/fences.toml).

/** Rebuild `host_agents` keyed by `(agent, host)` (`create`), its rows carried over with no epoch. */
export function rekeyHostAgents(sql: SqlStorage, storage: DurableObjectStorage, create: string): void {
  storage.transactionSync(() => {
    sql.exec("ALTER TABLE host_agents RENAME TO host_agents_by_agent");
    sql.exec(create);
    sql.exec("INSERT INTO host_agents (agent, host, cmd, epoch) SELECT agent, host, cmd, NULL FROM host_agents_by_agent");
    sql.exec("DROP TABLE host_agents_by_agent");
  });
}
