# An operator's retry spends an epoch (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table, wire type or host change. `lease.retried` (an operator's `POST /v1/sandboxes/<id>/place` on a sandbox failed on its host) now leaves the sandbox at the next epoch before it claims, so a retried sandbox's epoch rises by two, not one. Epoch numbers were never contiguous for clients (a release already skips one). A `wrangler rollback` brings back the window in which the old incarnation's salvage is refused; records written meanwhile read the same.
