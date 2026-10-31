# SandboxLease (TLA+)

A model of the sandbox placement / lease / epoch / fencing / STONITH / salvage / commit protocol as main implements it (edf6829): one sandbox, one FleetDO, two hosts. `SandboxLease.tla` maps each action to code in its header; constants switch each modelled fix or mutation on. The code as refactored (refactor/all) is main with `FixDestroy` (as built: destroyed before any await, FleetDO told first and refusing to place it, a late grant discarded), `FixStonithFence` and `FixQueue` on, and neither `StonithClear` nor a fence result reactivating a host whose instance FleetDO is terminating. The report is in [docs/verification/sandbox-lease/pilot/](../../../docs/verification/sandbox-lease/pilot/).

## Running

Each configuration is one TLC run. Put the states directory on disk, not tmpfs: the larger runs write several GB.

```
java -XX:+UseParallelGC -Xmx6g -cp tla2tools.jar tlc2.TLC -workers 8 \
  -metadir $STATES/<Config> -config <Config>.cfg SandboxLease.tla
```

- **v1.7.4** (what `verification/run.sh` uses): every `ci` line of `expect.tsv` was run with it and gives the expected result. It writes `SandboxLease_TTrace_*` files next to the spec on a violation; delete them.
- **2026.10.24 nightly** (the pilot's development runs): add `-noGenerateSpecTE`. Verdicts are the same.

A run that holds prints `Model checking completed. No error has been found.` A violation prints `Error: Invariant <Name> is violated.`, `Error: Action property <Name> is violated.`, or `Error: Temporal properties were violated.` (v1.7.4 names no property; each liveness configuration checks exactly one).

## Configurations

[`expect.tsv`](expect.tsv) lists each configuration's expected result and tier. `ci` lines finish in under 3 minutes with 8 workers; `full` lines did not finish during the pilot.

| Config | What | Expected |
|---|---|---|
| MCB1 | main, no faults | violates SalvageNeverDropped (B1) |
| MCBB1 | salvage check fixed, nestd resend as on main, one nestd restart | violates SalvageNeverDropped (B-B1) |
| MCB2 | main, one destroy | violates DestroyIsTerminal (B2) |
| MCDoubleRun | main, faults | violates NoDoubleRun (D1) |
| MCEpochMonotone | main | violates EpochMonotone (by design) |
| MCL1 | liveness, leaseLost as on main | violates HostTruthful (L1) |
| MCL2 | liveness, reassign queue as on main | violates Placed (L2) |
| MCLiveDelayedRpc | liveness, a place RPC delivered after its marker went stale | violates Placed (O3) |
| MCMutFgeE | mutation: F = E | violates NoDoubleRun |
| MCMutNoStonith | mutation: expiry reassigns without STONITH | violates StonithBeforeReassign |
| MCMutNoEpochCheck | mutation: commit without the epoch/host check | violates SingleWriter |
| MCMutHistory | sensitivity: HISTORY_MAX = 1 | violates SalvageNeverDropped |
| MCFixedS2 | all fixes, F = 1, E = 2, epochs ≤ 2, one disconnect | holds |
| MCFixedB2 | as MCFixedS2, with one destroy and no disconnect | holds |
| MCFixedS1, S3, S4, S5 | all fixes, small bounds, other fault classes (S5: no rollback, EpochMonotone) | holds (not completed) |
| MCDoubleRunNoShutting | main, but STONITH waits for `terminated` | holds (not completed) |
| MCLive | liveness, all fixes | holds (not completed) |

Each `.cfg` starts with a comment saying what it sets and what to expect.
