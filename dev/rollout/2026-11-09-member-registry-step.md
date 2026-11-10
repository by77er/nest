# The subtree registry's step (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, column or wire change: ClientDO's `members` keeps its shape and state values. The transitions are the ones the SQL guards already made, now decided by one pure step. One behaviour changes: a report that reaches a ClientDO with no record (purged) is answered and writes nothing. A `wrangler rollback` reads every row as before.
