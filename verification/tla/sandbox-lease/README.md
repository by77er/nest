# SandboxLease (TLA+)

A model of the sandbox placement / lease / epoch / fencing / STONITH / salvage / commit protocol as main implements it (edf6829): one sandbox, one FleetDO, two hosts. `SandboxLease.tla` maps each action to code in its header; constants switch each modelled fix or mutation on. The code as refactored (refactor/all) is main with `FixDestroy` (as built: destroyed before any await, FleetDO told first and refusing to place it, a late grant discarded), `FixStonithFence` and `FixQueue` on, and neither `StonithClear` nor a fence result reactivating a host whose instance FleetDO is terminating. Since then STONITH waits for `terminated` (`ShuttingDownIsDead = FALSE`, set in the MCFixed and MCLive configurations). The report is in [docs/verification/sandbox-lease/pilot/](../../../docs/verification/sandbox-lease/pilot/).

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
| MCFixedS2 | all fixes (STONITH waits for `terminated`), F = 1, E = 2, epochs ≤ 2, one disconnect | holds |
| MCFixedB2 | as MCFixedS2, with one destroy and no disconnect | holds |
| MCFixedS1, S3, S4, S5 | all fixes, small bounds, other fault classes (S5: no rollback, EpochMonotone) | holds (not completed) |
| MCDoubleRunNoShutting | main, but STONITH waits for `terminated` | holds (not completed) |
| MCLive | liveness, all fixes | holds (not completed) |

Each `.cfg` starts with a comment saying what it sets and what to expect.

## SlotFollowups

`SlotFollowups.tla` models what this spec abstracts away and the 2026-11-06 sweep found lost: a command result's follow-up (bug 2) and a new placement's follow-ups (bug 3), with one agent's slot, its `agent_attach` commands and results, and the bindings `resolve` mints. The lease is abstracted to "placed at epoch e on host h, may move to another host at e + 1" (an adopted lease may already be `running`), plus the holder's `running` report. FleetDO's follow-up is split at its await on SandboxDO, `afterPlaced` at its awaits; both objects reset (losing their continuations), a DO-to-DO call fails, `afterPlaced` throws, and nestd resends an unacked result. It is a separate module, in this directory, so that its state space stays small: the slots multiply the lease model's states, and none of the lease's properties depends on them. Its header maps each action to the code; the dated [conformance pass](../../../docs/verification/sandbox-lease/conformance/) checks the mapping.

Not modelled: a re-placement on the same host (`Move` always picks another host; the slot reset doesn't depend on which), error results of `agent_attach`, and the follow-ups other than `attach_result`.

Properties: `BindingOnlyConfirmed` (a binding at epoch e only for an attach confirmed at e), `BindingConfigured` (only for a slot the guest at that placement configured), and, under weak fairness on every step that isn't a fault, a move or a client call (faults bounded, unfair), `FollowupsDone` (every recorded result's follow-up runs, none stays owed), `HandsEventually` (the slot is confirmed at the placement that lasts) and `PlacedDone` (that placement's follow-ups run).

Bounds: hosts h1, h2; epochs ≤ 3 (so two moves), commands ≤ 3, and at most one of each fault (FleetDO reset, SandboxDO reset, failed call, throw). `MCSlotsFixedBig` doubles the faults (the same with a third move as well did not finish in 35 minutes and isn't kept).

| Config | What | Expected |
|---|---|---|
| MCSlotsOld | before #187: slots reset after `afterPlaced`'s awaits, follow-ups not owed | violates BindingOnlyConfirmed (bug 3: a move adopts a lease already `running`, and `resolve` in `afterPlaced`'s await window mints for the new epoch on the old epoch's confirmation; the same once the new guest reports `running` after a throw cut `afterPlaced`) |
| MCSlotsOldPlacement | results fixed, placement as before | violates BindingOnlyConfirmed |
| MCSlotsOldResults | placement fixed, results as before | violates FollowupsDone (bug 2: a FleetDO reset at the await, the redelivered result ignored) |
| MCSlotsMutNoRerun | mutation: owed, but no `followups` deadline | violates FollowupsDone |
| MCSlotsMutNoPlacedDeadline | mutation: slots reset in the step, no `placed` deadline | violates PlacedDone |
| MCSlotsReachRerun, ReachCut, ReachMovedBind | reachability: a follow-up left to the deadline; a placement's follow-ups cut; a binding after a move | violates NoRerun, NoCut, NoMovedBind (not vacuous) |
| MCSlotsFixed | both fixes | holds (1,363,140 states, 12 s) |
| MCSlotsFixedFollowups, Hands, Placed | both fixes, one liveness property each | holds (1,363,140 states, 42-50 s each) |
| MCSlotsFixedBig | both fixes; epochs ≤ 3, two of each fault | holds (12,459,894 states, 110 s) |

Two further mutations of the spec, run by hand and not kept: `Deliver` without its epoch check violates BindingOnlyConfirmed; `Move` resetting `pending` but not the in-flight command violates HandsEventually.

## PlacementRetry

`PlacementRetry.tla` models who retries a refused placement, and when each side gives up (#191): FleetDO's reassignment row and SandboxDO's own `place` deadline, for one lost lease. `SandboxLease`'s `Reassign` retries for ever under weak fairness and its Refused answer leaves no retry, so neither bound is in it. The `leaseLost` call is split at its awaits: the request can be lost before it lands, the answer after, and FleetDO can reset with the call out. A refusal is FleetDO holding a lease that disagrees, which may heal or never. SandboxDO's step (`leaseLost`, then its placement) is one step: `FleetDO.place` is synchronous.

Properties: `NotStranded` (the row never gives up while SandboxDO still names the lost host), `Bounded` (neither side's refusal count passes its limit), and under weak fairness on the tick, the alarm and the call's steps (faults, the operator and the heal unfair), `SandboxSettles` (L1, weakened: placed again, or given up where the owner sees it) and `RowSettles` (L3, weakened: the row deleted, or given up).

Bounds: the limits are 3 refusals for the row and 2 for SandboxDO (10 and 6 in the code: the counting is the same), one lost call, one FleetDO reset, one "no capacity", one operator retry. `MCRetryFixedBig`: limits 4 and 3, two of each.

| Config | What | Expected |
|---|---|---|
| MCRetryOldHotLoop | before #191: a refused reassignment retried every tick | violates RowSettles |
| MCRetryOldNeverRetried | before #191: SandboxDO's refused placement clears its deadline, with nothing shown | violates SandboxSettles (once the row gives up nothing places it, even after the conflict heals) |
| MCRetryStranded, MCRetryStrandedLive | #191's first version: any failed call counts toward giving up | violates NotStranded (three lost requests, 7 steps), and SandboxSettles |
| MCRetryReachGiveUp, ReachRecovery, ReachLostRetry | reachability: both sides give up; placed again after refusals; a lost call retried | violates NoGiveUp, NoRecovery, NoLostRetry (not vacuous) |
| MCRetryFixed, FixedSandbox, FixedRow | as built | holds (912 states) |
| MCRetryFixedBig | as built, larger | holds (7,466 states) |

## FailedRelease

`FailedRelease.tla` models a failed sandbox releasing its lease (#192) and what the release leaves: the incarnation on the host, recorded stale, which keeps the host from being retired until it is salvaged (or its window passed) and destroyed. `SandboxLease` has no such action. The release is split at its two awaits (the fence's issue, `releaseFailedLease`), with an operator's retry, a destroy, a host's loss and a SandboxDO reset between them. Placement is one step (claim, `FleetDO.place`, the answer), with the no-capacity rollback.

Properties: `EpochAboveStale` (unplaced, the sandbox's epoch is above every incarnation not yet salvaged), `SalvageAccepted` (what that guards: no recorded incarnation's salvage is refused as stale), `OnlyItsLease` (the release deletes no lease but the one at (h, e)), `NoWorkLostToRetire` (no host retired with an incarnation a released lease left there, unrecorded or unsalvaged, before its window), and under weak fairness on the release's steps, the window and the reaper, `StaleReaped` (every recorded incarnation ends destroyed) and `FailedReleases` (a failed sandbox leaves its host).

Bounds: two hosts, epochs ≤ 4, two failures, two retries, one destroy, one host loss, one reset, one "no capacity".

| Config | What | Expected |
|---|---|---|
| MCFailedNoSpend, NoSpendSalvage | #192's first version: the release doesn't spend an epoch; no retry | violates EpochAboveStale, SalvageAccepted |
| MCFailedRetryNoSpend, RetryNoSpendSalvage | #192 as merged (82e007f9): `lease.retried` spends no epoch | violates EpochAboveStale and SalvageAccepted: an operator's retry between FleetDO's release and SandboxDO's leaves it unplaced at the released epoch, and the incarnation's salvage arriving before the next claim is refused (6 steps) |
| MCFailedRetryUnrecorded | before 2026-11-10: the retry releases the lease without recording the incarnation it leaves | violates NoWorkLostToRetire (fail, retry, the idle host retired: 3 steps) |
| MCFailedFixed | as built: the release and the retry each spend an epoch and record what they leave | holds (45,140 states) |
| MCFailedFixedReaped, FixedReleases | as built, one liveness property each | holds |
| MCFailedMutDeleteAny | mutation: the release deletes the sandbox's lease whatever it is | violates OnlyItsLease |
| MCFailedMutRetire | mutation: scaleDown ignores incarnations not yet destroyed | violates NoWorkLostToRetire |
| MCFailedReachRelease, ReachRetired, ReachReplaced | reachability | violates NoRelease, NoRetiredAfter, NoReplaced (not vacuous) |

Not modelled in either: a lease lost from a live host (`leaseLost` after a fence, where what is left of B1 lives: SandboxLease's `MCB1`), lost answers and resets around `FleetDO.place` (SandboxLease's subject), the fence's acknowledgement (B5), and a stale row dropped when the sandbox is placed again on the same host (`reapStale`: nestd salvages it when it creates the new one).

