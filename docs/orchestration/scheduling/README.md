# Quota-aware scheduling

All agents share one Claude subscription. Its limits assume "ordinary, individual usage" with no published numbers ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)), so quota is treated as a scheduling resource. This is platform mechanism, unlike the rest of [orchestration/](../).

- **Concurrency cap** on active brains, configurable, starting at 2–4.
- **Priority classes:** agents with `priority: high` in their spawn spec (the `captain` template sets it) get priority, with headroom reserved for them.
- **Budgets shrink like grants:** a spawn spec's `budget{depth, concurrent, spawns, turns_per_day, quota_share}` is carved from what its spawner has left and enforced per owner subtree, so a subtree can't exceed what I gave its root. See [agents](../../agents/#spawning).
- **On a rate limit** (`api_retry` with `rate_limit`, or `StopFailure`), park the agent and back off. This is a durable pause, not a failure, and it's posted to the agent's `events`.
- **Fallback:** wait for quota.
- **Agents can read remaining quota and budget**, and the wake envelope carries their remaining budget.
- **Cache-aware waking:** resuming a long session after the one-hour prompt cache has expired re-reads the whole history, so a wake may start fresh from memory instead (see [continuity](../../agents/#continuity)).

## Open questions

- **Measuring `quota_share`:** subscription windows aren't published for individual plans, and how cache reads count against quota is unknown; the first version counts turns and tokens from `usage` events.
