# Quota-aware scheduling

All agents share one Claude subscription. Its limits assume "ordinary, individual usage" with no published numbers ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)), so quota is treated as a scheduling resource. This is platform mechanism, unlike the rest of [orchestration/](../).

- **Concurrency cap** on active brains, configurable, starting at 2–4.
- **Priority classes:** agents with `priority: high` in their spawn spec (the `captain` template sets it) get priority, with headroom reserved for them.
- **Budgets shrink like grants:** a spawn spec's `budget{depth, concurrent, spawns, turns_per_day}` is carved from what its spawner has left and enforced per owner subtree, so a subtree can't exceed what I gave its root. See [agents](../../agents/#spawning).
- **On a rate limit** (`api_retry` with `rate_limit`, or `StopFailure`), park the agent and back off. This is a durable pause, not a failure.
- **Fallback:** wait for quota.
- **Agents can read their remaining budget and recorded usage**, and a turn's input carries the remaining budget.
- **Cache-aware waking:** resuming a long session after the one-hour prompt cache has expired re-reads the whole history, so a wake may start fresh from memory instead (see [continuity](../../agents/#continuity)).

**No quota shares.** Subscription windows aren't published for individual plans, and how cache reads count is unknown, so the scheduler doesn't estimate shares: the concurrency cap and priority classes divide capacity, and a rate limit parks agents until quota returns. The usage each `turn_completed` reports is shown in the trace only.

**Built:** a rate limit marks the agent `quota_parked` (an `api_retry` one also emits `rate_limited`, logged and traced; a `StopFailure` one only sets the state), and a brain host takes at most `brain.max_brains_per_host` brains (a capacity limit, not quota). **Not built:** the concurrency cap, priority classes, budgets (fixed spawn-depth and live-children caps stand in: [spawning](../../agents/#spawning)), the durable park and back-off, and cache-aware waking.
