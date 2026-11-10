# Sandbox lease: conformance

Does the code still do what the models say? Each row maps a model action to the code that implements it and says whether it conforms. **Dated pass: 2026-11-06**, by reading `main` at `9fd147ff` plus [#187](https://github.com/by77er/nest/pull/187) (bugs 2 and 3 of the 2026-11-06 state-machine sweep). The previous pass was the [pilot](../pilot/) at `edf6829`; #62 changed the code without one. Paths: `sandbox.ts` and `fleet.ts` are `control-plane/src/do/`, `lease.ts` is `control-plane/src/lib/sandbox-lease.ts`, `slots.ts` is `control-plane/src/lib/slots.ts`; lines are at this pass's head.

Verdicts: **yes** (the action is the code's step, guards and effects alike), **partly** (the stated difference is an abstraction the properties don't depend on, or a known gap), **no** (the model and the code disagree; an open item).

## SandboxLease.tla

Switches as the code is now: `FixDestroy`, `FixStonithFence`, `FixQueue` TRUE; `ShuttingDownIsDead` FALSE (`isDead`, `lib/ec2.ts:61`); `RollbackEpoch` TRUE, `FixSalvage` FALSE, `FixLeaseLost` FALSE (the open B1 and its neighbours, the owner's decision); host-side switches as the nestd inventories record them. That is the `MCFixed*` configurations.

| Action | Code | Conforms | Notes |
|---|---|---|---|
| PlaceStart | `lease.claim`; `placeCurrentEpoch` `sandbox.ts:510` (alarm `place` `1117` via `placeWanted`, `wake` `636`, `evicted` `653`, `leaseLost` `716`) | yes | The claim's step also pins the restore source (`restore_pin`), not modelled: it guards retention, not the lease. The `place` deadline is set before the first await. |
| ServePlaceGrant / ServePlaceOther | `place` `fleet.ts:1640` | yes | Refuses a lease at another epoch and a destroyed sandbox; an unregistered one is registered (logged), never refused. Candidates: active, unwedged, connected. |
| ResumePlace | `lease.placeAnswered` in `placeCurrentEpoch`; `discardPlacement` `sandbox.ts:793` | yes | The rollback on no capacity or refusal is still there (B1, open). New since the pilot: the `placed` step also resets the slots and owes the follow-ups (SlotFollowups below). |
| ReconcileStart / ResumeReconcile | `lease.reconcileAt`, `lease.reconciled`; `reconcilePlacing` `sandbox.ts:483`; `leaseOf` `fleet.ts:1692` | yes | `adopted` resets the slots and owes the follow-ups like `placed`. |
| ServeLL | `lease.leaseLost`; `leaseLost` `sandbox.ts:716` | yes | With a marker at the lost epoch, `placeCurrentEpoch` throws "placement already in progress" and FleetDO keeps the row: `FixLeaseLost` FALSE, as modelled. |
| DestroyStart / ServeRelease / ResumeDestroy | `lease.destroyed`; `destroy` `sandbox.ts:760`, `afterDestroyed` `767`; `sandboxDestroyed` `fleet.ts:2331`, `releaseLease` `1687` | yes | `FixDestroy` as built. |
| DoCommit | `lease.decideCommit`; `commit` `sandbox.ts:921` | partly | Salvage is authorized against the full `epochs` table (#32), not the 50-entry history the model's `HistoryMax` bounds; B1 unchanged. |
| FleetEvent | `handleEvent` `fleet.ts:1331` (`sandbox_state`, `commit_request`), `holderFenced` `1141`, `onCommandResult` `1452` | yes | A non-holder's `fenced` is recorded stale. A draining host's `suspended` report evicts (not modelled: Evict is outside this spec's actions). |
| Expire | `tick` `fleet.ts:1864` (`expiryVerdict`, `lib/host-lifecycle.ts`), `expireHost` `2707` | yes | `expire_silent` (no live lease) skips STONITH; the model's host always holds the lease when it expires. |
| Ec2Terminate / PollStonith | `expireHost`, `pollStonith` `fleet.ts:2799`, `confirmHostDead` `2848` → `die` `2776`; `isDead` | yes | Only `terminated` or an unknown instance is dead. `die` also answers the host's unanswered commands (hosts §2.4, fixed). |
| EnsureFence / StonithClear | `ensureStonithFence` `fleet.ts:2818`, `stonithDoneIfClear` `2842`, `move` `2923` → `hostStep` | yes | `FixStonithFence`: a queued row covers only its own `(sandbox, epoch)`. Never cleared for a host FleetDO is terminating or a wedged one. |
| ProcessReassign / ResumeLL | `queueReassign` `fleet.ts:2853`, `processReassign` `2864` | yes | `FixQueue`: `reassignments` keyed by `(sandbox, host, epoch)`. A refused re-placement makes `leaseLost` throw, so its row retries every tick (L1 "Refused", open at this head; #191 adds backoff and a give-up, with its own dated section in the [inventory](../)). |
| HbSend / HbRecv / AckRecv | `onHeartbeat` `fleet.ts:1273`; nestd `fleet.rs` | yes (CP side) | nestd side: see [nestd](../../nestd/). |
| Connect | `onHello` `fleet.ts:982`, `reconcileSandboxes` `1103`, `dropUnreported` `1084` | yes | The unreported leases and unanswered commands are captured in the reset's step (`kv`), so a FleetDO reset midway leaves them to the next hello. |
| SelfFence, HostCmd, CommitSend, SalvageSend, Timeout | nestd `host.rs` `lease_watchdog`, `self_fence`, `fence_sandbox`, `retire`, `commit`, `send_commit`, `apply_commit` | not re-checked here | Host side; owned by [nestd](../../nestd/) and [nestd-incarnations](../../nestd-incarnations/). |
| SbxReset, FleetReset, LoseAnswer, NestdCrash, HostDie, Ec2Die | faults | — | |

Not in the model and not needed by its properties: the turn-checkpoint machine (`turnEndCheckpoint`, `checkpointResult`), evictions from `die(idle/drained)`, `expire_silent`, `hostWedged`.

## SlotFollowups.tla

The follow-ups the sweep found lost ([`verification/tla/sandbox-lease/SlotFollowups.tla`](../../../../verification/tla/sandbox-lease/SlotFollowups.tla)), with `FixResults` and `FixPlacement` TRUE.

| Action | Code | Conforms | Notes |
|---|---|---|---|
| Move | `placedStep` `sandbox.ts:274` inside the decide of `placeCurrentEpoch` and `reconcilePlacing`; `owePlaced` `579` | yes | `slots.newPlacement` runs in the placement's own step; the `placed` deadline row is written before that step's first await. |
| SecretsStep, IssueStep | `afterPlaced` `sandbox.ts:589`: `pushSecrets`, `issueAttachesOrRetry` `1679` (`slots.due`), `notifyAgentsMoved`, `armIdle` | partly | The model has two steps (secrets, the attach issue); the code has four awaits. The last two only arm deadlines, so a cut there is the same as a cut after IssueStep with the deadline still owed. |
| PlacedDone | `afterPlaced`'s end: clears `placed` only if the epoch is still the one it ran for | yes | |
| PlacedDeadline | alarm `placed` `sandbox.ts:1131` | yes | Runs `afterPlaced` for the placement current then; a handler that throws keeps its key (`Deadlines.runDue`). |
| ThrowStep | any throw in `afterPlaced` (`pushSecrets` reaches BrokerDO and FleetDO) | yes | |
| IssueAttach | `issueAttachCommands` `sandbox.ts:1660` (+ `slots.sent`), from `afterPlaced`, a `running` report (`reportState` `618`), and `attach_retry` | yes | `slots.sent` records the command only if host and epoch are unchanged after the await. |
| HostApply | nestd `agent_attach` (`host.rs`) answering at its `lock_live` epoch | partly | The model sends only ok results; an error result leaves the slot pending with a retry (P3), which the model abstracts as a later IssueAttach. |
| Recv | `onCommandResult` `fleet.ts:1452` with `resultStep`, `resultFollowups` (`lib/command-result.ts`) | yes | The result and `followup_ms` (owed) are written in one step. Results FleetDO writes itself (`answerByFleet`: a dead host, a restarted process) owe no follow-ups: the death's or the reset's own transitions (`leaseLost`, `brainsLost`, `failPendingCommands` through `onCommandResult`) cover them. |
| Deliver | `attachResult` `sandbox.ts:1697` (`lease.holds`, `slots.attachResult` keyed by `cmd`) | yes | Idempotent: a stale or repeated result changes nothing. |
| Finish | `runFollowups` `fleet.ts:1498`: `followup_ms := NULL` after every follow-up ran | yes | |
| LoseCall | `runFollowups`' catch: owed kept, backoff (`followupBackoff`) | yes | The batch is acked; the deadline re-runs it. |
| Rerun | alarm `followups` `fleet.ts:1849` → `followupsDue` `1539`; a redelivered result (`resultStep` = `rerun`) | yes | |
| FleetReset, SbxReset | faults | — | |
| Run | `reportState` `sandbox.ts:618` (`lease.reported`) | yes | A move by adoption (`reconciled`) takes the lease's last state, which may be `running`: the model's Move chooses. |
| Resolve | `resolve` `sandbox.ts:1714` (`slots.unbindable` before and after its awaits) | yes | The model's guard is `unbindable`'s slot and `running` clauses; the others (gateway, tunnel, guest) only refuse more. |

The other follow-ups of a result (`checkpoint_result`, `command_failed`, `start_failed`) are owed and re-run the same way; their receivers are idempotent per command (`checkpointResult` by `cmd`, `commandFailed` by its `create_failure` record, `startFailed` by epoch and intent). The model checks one, `attach_result`.

## PlacementRetry.tla and FailedRelease.tla

**Dated pass: 2026-11-09**, by reading `main` at `78dc720a` (#191 and #192 merged). The models: [`PlacementRetry.tla`, `FailedRelease.tla`](../../../../verification/tla/sandbox-lease/README.md#placementretry). `retry.ts` is `control-plane/src/lib/retry.ts`.

| Action | Code | Conforms | Notes |
|---|---|---|---|
| Send, Resume (PlacementRetry) | `processReassign` `fleet.ts:3030`; `reassignRetry` `retry.ts:24` | yes | Only a `FORBIDDEN`, non-retryable answer counts as a refusal; "placement already in progress" is retryable and doesn't. The backoff is abstracted to "tried again later". |
| LoseCall, FleetReset | `processReassign`'s catch with `refused` false; a reset leaves the row | yes | Retried without limit, as the model's fair `Send`. |
| Land | `leaseLost` `sandbox.ts:859`, then `placeCurrentEpoch(…, false)` `558` | partly | One step in the model: lost answers and resets inside SandboxDO's placement are SandboxLease's. A refusal asked by FleetDO is noted, not counted, and arms SandboxDO's own deadline unless it gave up. |
| Alarm | alarm `place` `sandbox.ts:1262` (`placeWanted`), `retryAfter` `retry.ts:13` | yes | Counted, then given up: the deadline cleared, `placement_refused.gave_up` shown. |
| Operator | `retryPlacement` `sandbox.ts:673` | yes | The count starts again. |
| Granted deleting a given-up row | `place` `fleet.ts:1698` | yes | |
| Fail (FailedRelease) | `lease.reported`, `createFailed`; `failedChanged` `sandbox.ts:766` arms `failed_release` | yes | The 15-minute grace is abstracted to "some time later". |
| FRStart, FRFleet, FRFinish | `releaseFailed` `sandbox.ts:740`; `releaseFailedLease` `fleet.ts:1724`; `failedReleased` `lease.ts:164` | yes | The lease and the stale record in one FleetDO step; the epoch spent only if still failed on (h, e). A reset between the steps leaves the deadline to run it again. |
| RetryRelease, RetryPlace | `retryPlacement` `sandbox.ts:673` with a holder: `releaseFailedLease` `fleet.ts:1724`, `retried` `lease.ts:201` | yes | `retried` spends an epoch (the finding below, fixed with this pass). Since 2026-11-10 the retry releases the lease through `releaseFailedLease`, as the release does, so the incarnation it leaves is recorded stale in the step that deletes the lease (second note below). |
| RetryReleased | `lease.retriedReleased` `lease.ts:189` | yes | |
| Alarm | `placeWanted` `lease.ts:211` | yes | False for `failed`. |
| Salvage | `decideCommit` `lease.ts:220` | yes | An orphan from an older epoch's holder; the current epoch's only from its holder. |
| WindowPass, Reap | `reapStale` `fleet.ts:1194` | partly | The model lacks its drop of a row superseded on the same host. |
| Retire | `scaleDown`'s `salvaging` `fleet.ts:2359` | yes | A row counts until its `sandbox_destroy` is issued (`cmd`), which the model's "destroyed" is. |
| HostLoss | `die` → `queueReassign` → `leaseLost` | partly | One step in the model. |

**Finding, fixed with this pass:** at `78dc720a`, an operator's retry of a sandbox failed on (h, e) left it unplaced at epoch e until its next claim succeeded (`lease.retried` spent no epoch). The incarnation's salvage commit arriving then was refused as stale by `decideCommit`, and nestd deleted the work. With #192 the retry could also run between FleetDO's release and SandboxDO's (`MCFailedRetryNoSpend`, 6 steps to the refusal), but the window was `retried`'s own and older than #192. `retried` now spends an epoch, as `failedReleased` does (`MCFailedFixed`); tests: the table in `control-plane/test/sandbox-lease-core.test.ts` and the six steps against the real objects in `test/fleet.test.ts`.

**A second finding, fixed 2026-11-10 (from #200's review):** the retry released the lease with `releaseLease`, which records nothing, so FleetDO learnt of the incarnation left on the host only from that host's next hello. Until then nothing kept the host: placed elsewhere, or finding no room, the sandbox left it idle, and `scaleDown` could retire it with work not yet salvaged (`MCFailedRetryUnrecorded`: fail, retry, retire). The retry now calls `releaseFailedLease(h, e)`: the lease at (h, e) and the stale record in one FleetDO step. The model's `NoWorkLostToRetire` now counts every incarnation a released lease leaves, recorded or not (`left`). Test: `control-plane/test/fleet.test.ts` ("an operator's retry records the incarnation it leaves").

**What is left of B1** (the owner's open decision on the no-capacity rollback): a lease lost through `leaseLost` (the host fenced itself, a STONITH fence, a restarted nestd), whose salvage arrives while the sandbox is unplaced at the lost epoch: before its next claim succeeds, or after a claim that found no room, or was refused, rolled back to it. Neither model here covers `leaseLost` from a live host; SandboxLease's `MCB1` does.

## Results (TLC 1.7.4, 4 workers)

SlotFollowups, at this pass's head, with the bounds in the [model README](../../../../verification/tla/sandbox-lease/README.md#slotfollowups) (two hosts, epochs ≤ 3, one of each fault): `BindingOnlyConfirmed`, `BindingConfigured`, `FollowupsDone`, `HandsEventually` and `PlacedDone` hold with both fixes (1,363,140 states). With either fix off, the old code's counterexample: `BindingOnlyConfirmed` fails in 6 steps (attach confirmed at epoch 1, a move adopting a running lease, `resolve`), `FollowupsDone` after a FleetDO reset at the follow-up's await and the redelivered result ignored. Each fix's mutation and three reachability checks fail as expected. Rows in [`expect.tsv`](../../../../verification/tla/sandbox-lease/expect.tsv).

SandboxLease was not re-run for this pass: no action it models changed since its last run except the follow-ups SlotFollowups adds.

PlacementRetry and FailedRelease (2026-11-09, `78dc720a`): every row of [`expect.tsv`](../../../../verification/tla/sandbox-lease/expect.tsv) for them gives its expected result; the bounds and state counts are in the [model README](../../../../verification/tla/sandbox-lease/README.md#placementretry).

