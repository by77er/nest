# LiveRules (TLA+)

A model of live capability rules ([CatalogDO](../../../docs/control-plane/durable-objects/catalog/#live-rules), [AgentDO](../../../docs/control-plane/durable-objects/agent/#rules)). It has:
- one capability, whose rules are a version number;
- two agents watching it;
- CatalogDO's watch, its nudge rows (agent → `rev`), the `nudge` deadline row and the storage alarm;
- each AgentDO's `rules` deadline and its read, split at the read's one await.

`LiveRules.tla` maps each action to code in its header, and constants switch the code's guards off. Conformance: [docs/verification/live-rules/](../../../docs/verification/live-rules/).

- **Faults** (each bounded):
  - a lost RPC, before or after the agent took the nudge;
  - an AgentDO reset mid-read;
  - a lost watch row;
  - a `wrangler rollback` to the release before, then forward again. It covers both DOs:
    - CatalogDO has no alarm handler, so an alarm it runs is consumed and the deadline row stays. Its writes nudge nobody, and it has no `watchRules`.
    - With `AgentRollback`, AgentDO has no `rules` handler, so its alarm drops the deadline (`OldDropDue`), and it has no `rulesChanged`.
- **Property:** `Converges`. Every watcher's rules end at the capability's latest write and stay there. This assumes eventual delivery, as weak fairness on the alarm, the RPCs' answers, the reads and the roll-forward. Where it is switched on, it also assumes the hourly read.
- **Abstracted:** rule sources and joining (a version number stands for the rules), `rules_set`, `rules_derived`, unreadable rows, ending, and the backoff's timing (a retry is the next alarm). Each of these has a vitest test in `control-plane/test/live-rules.test.ts` instead.
- **Assumptions:**
  - no deploy in the middle of an alarm run (`Rollback` requires `~running`);
  - no CatalogDO reset in the middle of `deliverNudges` (a reset there loses only the run's in-flight answers, which the rows outlive, but it isn't modelled);
  - small bounds: two agents, two writes, and at most one of each fault.

## Running

`verification/run.sh --only tla --spec live-rules`, or one config by hand:

```
java -XX:+UseParallelGC -Xmx3g -cp ../../.tools/tla2tools-1.7.4.jar tlc2.TLC -workers 4 \
  -metadir /var/tmp/tlc-<tag> -config MC_fixed.cfg LiveRules.tla
```

Each config finishes in under 30 s with 4 workers (TLC v1.7.4).

## Configurations

[`expect.tsv`](expect.tsv) lists each config's expected result.

| Config | Switches and faults | Expected |
|---|---|---|
| MC_fixed | As built, with the hourly read. One each of lost RPC, reset, lost watch and rollback of both DOs, plus writes under the rolled-back release. | holds (581,300 states) |
| MC_old_hourly | `RearmAlarm = FALSE` (review finding 1), otherwise as MC_fixed. | holds: the hourly read covers the stall |
| MC_nudges | As built, with no hourly read and no rollback. One lost RPC and one reset. | holds (9,886 states) |
| MC_old_fixed | As built, with no hourly read and one rollback of CatalogDO alone. | holds: the control for MC_old_stall |
| MC_agent_rollback | As MC_old_fixed, but the rollback covers AgentDO too. | violates Converges: a rolled-back AgentDO drops a read it owed, and only the hourly read recovers it |
| MC_mut_ack | `AckByRev = FALSE`: an answer deletes the row at any rev. No hourly read. | violates Converges: a stale answer drops the newer nudge |
| MC_old_stall | As MC_old_fixed, with `RearmAlarm = FALSE`. | violates Converges: finding 1, no alarm after the roll-forward |
