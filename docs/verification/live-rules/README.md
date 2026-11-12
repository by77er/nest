# Live capability rules

The protocol that carries a capability's rules to the live agents that read them ([CatalogDO](../../control-plane/durable-objects/catalog/#live-rules), [AgentDO](../../control-plane/durable-objects/agent/#rules)). Model: [verification/tla/live-rules/](../../../verification/tla/live-rules/).

- **Actors:**
  - a capability writer: the operator, a client, or a seed step;
  - CatalogDO: the watch, the nudge rows and their `rev`, the `nudge` deadline and the storage alarm;
  - AgentDO: its `rules` deadline and its read.
- **Safety:**
  - A rules push moves `rules_version` in the same step. This is the #244 invariant: a rule approval checked against older rules gets `conflict`.
  - A stale answer never deletes a newer nudge.
  - The operator's rules stand over capability changes.
- **Liveness:** every live watcher's rules converge to the capability's latest write, given eventual delivery and the hourly read.
- **Past bugs:** review finding 1 of #249. A rolled-back CatalogDO's alarm run consumed the storage alarm and left the deadline row, and `Deadlines.set`'s early return never set the alarm again. `MC_old_stall` reproduces it.

## Conformance

**Dated pass: 2026-11-12**, on `kernel/live-capability-rules` after merging `main` at `988efc9f`. Paths: `catalog.ts` and `agent.ts` are in `control-plane/src/do/`. The verdicts mean what they mean in [sandbox-lease](../sandbox-lease/conformance/).

| Action | Code | Conforms | Notes |
|---|---|---|---|
| Write | `nudgeWatchers` `catalog.ts:164`, called from `putCapability` `376`, `deleteCapability` `385`, `deleteNamespace` `464` and the seed step `126` | yes | The rows, `rules_rev` and the deadline row are written in the write's synchronous step. `armNudges` (`149`) awaits only the alarm. |
| AlarmStart / AlarmEnd | `deliverNudges` `catalog.ts:233`, its tail `254` | partly | One run sends up to 64 due rows. A row in backoff waits for a later run; in the model, a retry is just the next alarm. |
| Take | `rulesChanged` `agent.ts:3053` | yes | The `rules` deadline is written before the answer. |
| AckArrive | `catalog.ts:241` | yes | `AND rev = ?` (`AckByRev`). |
| Lost | `catalog.ts:251` | yes | The row stays, with `attempts` + 1 and `next_ms` backed off. |
| ReadStart | `refreshRules` `agent.ts:3073` → `watchRules` `catalog.ts:186` | yes | The watch is set and the rules read in one CatalogDO step, which also calls `armNudges`. |
| ReadEnd | `agent.ts:3083`–`3111` | yes | The sources are re-read after the await, and a change triggers another read. The push with `rulesChanged` happens in the step that stores the rules. |
| Reset | `Deadlines.runDue` (`lib/reliable.ts`): the row is deleted only after the handler | yes | |
| LoseWatch | none in the code | yes | It stands for any write the catalog made without a watch row, such as a rolled-back release's. |
| Hourly | `prune` `agent.ts:3917` | yes | |
| RollForward | the constructor's `armNudges`, `catalog.ts:136` | yes | `RearmAlarm`. |
