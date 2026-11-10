# A rewrite's length on its base segment (2026-11-09, #194)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** The session wire gains one optional field, `segment.total_bytes`; AgentDO's record two optional fields, `recv_total` and `recv_high`, and AgentDO a table, `seg_trash`, with a deadline of that name (a `wrangler rollback` has no handler for it and drops it: the listed R2 objects stay, unreferenced). The Worker deploys first: runners of the previous release send no `total_bytes` and are committed as before. A `wrangler rollback` under new runners ignores the field (zod strips it) and `recv_total`, and commits as before. No capability flag: nothing new is sent to an old peer that it could reject.
