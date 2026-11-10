# A failed sandbox releases its lease (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class, table or host change: SandboxDO gains a deadline, `failed_release`, and a `kv` key, `failed_since`; FleetDO a method, `releaseFailedLease` (a FleetDO of the previous release lacks it mid-deploy: the release's deadline fails and is retried). A `wrangler rollback` has no handler for it (the row lapses unhandled), and a sandbox this release left `failed` and unplaced is placed again by the previous release's `place` alarm or a `wake`, as before.
