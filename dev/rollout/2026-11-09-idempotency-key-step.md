# The idempotency keys' step (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, column or wire change: `idempotency_keys` keeps its shape and state values. The transitions are the ones the SQL guards made. Two behaviours change: a key past its 24 h whose row wasn't pruned yet is free at once (it used to answer as bound until a prune reached it), and a `finish` on such a row records nothing. A `wrangler rollback` reads every row as before.
