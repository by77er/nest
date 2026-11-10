# Bounded retries of a refused placement (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class or host change. FleetDO's `reassignments` gains two nullable columns (`next_ms`, `gave_up_ms`) and `refusals` (default 0); SandboxDO a `kv` key (`placement_refused`). A `wrangler rollback` retries every row every tick again (the bug), given-up ones included, and refusals clear the `place` deadline as before.
