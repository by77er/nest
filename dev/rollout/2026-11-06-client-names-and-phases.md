# Client names and phases (2026-11-06)

A release's rollout rule ([Rollout rules](../deploy.md#rollout-rules)).

**Not a one-way deploy, and no ordering constraint.** No Durable Object class is added. ClientDO's `directory` gains two nullable columns on `names` (`phase`, `phase_ms`; a row without them is live) and a `sweep` deadline; a client record's prune may purge an orphan record. A Worker of the previous release mid-deploy calls `claimName` and `releaseName`, kept as compat (a confirmed reservation; a tombstone). A `wrangler rollback`: the previous release reads `names` by its old columns, so a reserved or deleted row holds its name as a taken one, and its `releaseName` deletes a tombstone at once. Its directory has no alarm handler, so a tombstone waits for this release's sweep, and an orphan record keeps its hourly alarm as before. Drop `claimName` and `releaseName` next release.
