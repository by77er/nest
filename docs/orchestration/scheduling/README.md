# Quota-aware scheduling

All agents share one Claude subscription. Its advertised limits assume "ordinary, individual usage," so quota is treated as a scheduling resource. This is platform mechanism, unlike the rest of [orchestration/](../).

- **Concurrency cap** on active brains, configurable, starting at 2–4.
- **Priority classes:** agents with `priority: high` in their spawn spec (the `captain` template sets it) get priority, with headroom reserved for them.
- **On a rate limit** (`api_retry` with `rate_limit`, or `StopFailure`), park the agent. This is a durable pause, not a failure, and it's posted to the agent's `events`.
- **Fallback:** wait for quota.
- **Agents can read remaining quota** and plan around it.

## Open questions

- **Budgets:** quota and cost budgets per agent or per owner subtree, and how spawning splits them (e.g. as a limit on `agent_spawn`).
