# LiveRules (TLA+)

This is a model of live capability rules ([CatalogDO](../../../docs/control-plane/durable-objects/catalog/#live-rules), [AgentDO](../../../docs/control-plane/durable-objects/agent/#rules)). It has:
- one capability, whose rules are a version number;
- two agents watching it;
- CatalogDO's watch, its nudge rows (agent → `rev`), the `nudge` deadline row and the storage alarm;
- each AgentDO's `rules` deadline and its read, split at the read's one await.

`LiveRules.tla` maps each action to code in its header, and constants switch the code's guards off. Conformance: [docs/verification/live-rules/](../../../docs/verification/live-rules/).

- **Faults** (each bounded):
  - a lost RPC, before or after the agent took the nudge;
  - an AgentDO reset mid-read;
  - a lost watch row;
  - a `wrangler rollback` of CatalogDO to the release before, then forward again. The old release has no alarm handler, so an alarm it runs is consumed and the deadline row stays. Its writes nudge nobody, and it has no `watchRules`.
- **Property:** `Converges`. Every watcher's rules end at the capability's latest write and stay there. This assumes eventual delivery, as weak fairness on the alarm, the RPCs' answers, the reads and the roll-forward. Where it is switched on, it also assumes the hourly read.
- **Abstracted:** rule sources and joining (a version number stands for the rules), `rules_set`, `rules_derived`, unreadable rows, ending, and the backoff's timing (a retry is the next alarm). Each of these has a vitest test in `control-plane/test/live-rules.test.ts` instead.

## Running

`verification/run.sh --only tla --spec live-rules`, or one config by hand:

```
java -XX:+UseParallelGC -Xmx3g -cp ../../.tools/tla2tools-1.7.4.jar tlc2.TLC -workers 4 \
  -metadir /var/tmp/tlc-<tag> -config MC_fixed.cfg LiveRules.tla
```

Each config finishes in under 30 s with 4 workers (TLC v1.7.4).

## Configurations

Every config is bounded to two agents and two writes. [`expect.tsv`](expect.tsv) lists each one's expected result.

| Config | Switches and faults | Expected |
|---|---|---|
| MC_fixed | As built. One each of lost RPC, reset, lost watch and rollback, writes under the rolled-back release, the hourly read. | holds (547,260 states) |
| MC_nudges | As built, with no hourly read. So no lost watch and no write under the rolled-back release, since only the hourly read recovers those. One lost RPC, reset and rollback. | holds (23,135 states) |
| MC_old_hourly | `RearmAlarm = FALSE` (review finding 1), with the hourly read. | holds: the hourly read covers the stall |
| MC_mut_ack | `AckByRev = FALSE`: an answer deletes the row at any rev. No hourly read. | violates Converges: a stale answer drops the newer nudge |
| MC_old_stall | `RearmAlarm = FALSE`. One rollback, no hourly read. | violates Converges: finding 1, no alarm after the roll-forward |
