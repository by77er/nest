# The webhook delivery's step and the events' age limit (2026-11-09)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** ClientDO's `outbox` gains a nullable column, `queued_ms`; `kv.delivery` keeps its shape. A row queued by the previous release has no time: its 7 days start at this release's first hourly prune. A `wrangler rollback` ignores the column and queues rows without it, which then start their wait at the next prune after a roll-forward; nothing is dropped early. No wire change: the client's record keeps `events.dropped`, which now also counts events dropped for their age.

**Also in this release:** `ClientDO.finishKey` takes an optional third argument, the id of the object the finishing request made, and refuses a finish for another id. Optional both ways: a Worker of the previous release sends none (not checked, as before), and a ClientDO of the previous release ignores it.
