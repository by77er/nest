# The brokered journal's and MCP forwards' steps (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, column or wire change: AgentDO's `brokered_journal` and `mcp_forwards` keep their shapes and status values. What changes is what the Worker writes. A settled brokered call or forward keeps its outcome, and no further attempt of it is recorded or sent. The hourly prune gives up on a journal row still `sending` 7 days after its first attempt (`unknown`, kept 7 more days), settles a forward still open after 7 days as unknown and deletes it, and deletes settled journal rows by when they settled, not when they were created. A `wrangler rollback` reads every row as before; the previous release then deletes settled journal rows by creation time again and keeps `sending` rows for ever.
