# Live capability rules (2026-11-12)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class is added and no wire message changes: a rules change reaches the runner as the `cache_update` it already takes. CatalogDO gains the tables `rule_watch` and `rule_nudges`, a `deadlines` table, `kv.rules_rev` and an alarm; AgentDO gains the `rules` deadline, `kv.rules_watched` and `kv.rules_derived`, and an agent's spec the optional `rule_sources` and `rules_set`. New RPC methods: `CatalogDO.watchRules`, `CatalogDO.ruleSources`, `AgentDO.rulesChanged`, `AgentDO.clearRules`. New route: `DELETE /v1/agents/<id>/rules` (admin).

- **Agents made before this release** have no `rule_sources`: they keep the rules they stored, and the catalog doesn't watch them. The operator moves one to live rules with `DELETE /v1/agents/<id>/rules` (its template's capabilities as a spawn would read them now, after the `deny` and `ask` rules it holds). The projects app's agents started before its built-in rules (PR #243) need this, or a respawn, to stop asking.
- **What a `wrangler rollback` does with what this release wrote:**
  - The previous AgentDO reads `rules` (kept current by every read here) and ignores `rule_sources` and `rules_set`; its save keeps them. It drops the `rules` deadline (no handler; logged). The agent's rules then stay as they are until the roll-forward, when its next alarm sees the watch out of date and reads again.
  - The previous AgentDO's `setRules` writes `rules` alone. After the roll-forward a read finds rules it didn't derive (`kv.rules_derived`) and takes them as the operator's (`rules_set`), so they stand as they did.
  - The previous CatalogDO has no alarm handler and writes no nudges: a capability written under it reaches live agents at their hourly read after the roll-forward. Nudge rows waiting at the rollback are sent again once any agent reads (`watchRules` arms the alarm).
  - Agents the previous release spawns have no sources and keep their rules, as above.
- **Mixed versions within a deploy:** a nudge to an AgentDO still on the previous code fails ("does not implement") and is retried, 5 s doubling to 5 minutes; the hourly read covers the rest.
- **No shim to drop.** Records without `rule_sources` are read as fixed for as long as such agents live.
