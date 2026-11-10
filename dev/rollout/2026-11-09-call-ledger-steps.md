# The call, ask and approval ledgers' steps (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, column or wire change: AgentDO's `tool_calls`, `asks` and `approvals` keep their shapes and status values. Two behaviours change, both in what the Worker writes. A call that already has an outcome keeps it and no second `tool_result` is sent. The hourly prune ends a call still unfinished after 7 days as `outcome_unknown` and turns a previous release's `sync` or `cli` ask of that age into an open (`async`) ask. A `wrangler rollback` reads every row this release wrote as before; calls and asks the prune settled stay settled.
