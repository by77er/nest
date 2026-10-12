# WorkstreamDO

A goal and its event history.
- **Event intake:** collects members' events (the last 5,000 are kept) and **batches decision events into one captain wake** after a 2 s window (`WAKE_BATCH_MS`), adding the most recent progress events as a digest.
- **User notifications:** queues them (the last 1,000 are kept) for the Discord bot, which isn't built yet.
- **Orphaned work:** records `orphaned_work` when work is salvaged.

Not built: budgets, member tracking, captain event filters. See [../../../orchestration/workstreams/](../../../orchestration/workstreams/).
