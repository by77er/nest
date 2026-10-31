# Sandbox lease: TLA+ pilot

A TLA+ model of placement, leases, epochs, fencing, STONITH, salvage and commit as main implements them (edf6829), checked with TLC. Spec, configurations and run commands: [verification/tla/sandbox-lease/](../../../../verification/tla/sandbox-lease/). Reproductions against the real DOs: [verification/repro/](../../../../verification/repro/).

**Result:** TLC found seven real defects on main: four lose or resurrect state (B1, B1b, B-B1, B2), one runs a sandbox twice (D1), and two leave a sandbox stuck (L1, L2). It also found two contributing smells (O1, O2), one stuck state that needs an RPC delayed by more than 60 s (O3), and one design-doc disagreement. The real DOs reproduce B1 and B2. With the seven modelled fixes on, every safety invariant holds exhaustively in one small configuration (MCFixedS2). The other "fixed" and liveness runs are partial (see [Configurations](#configurations)).

## Findings

| # | Property broken | Where | Trace, in words | Consequence | Likelihood | Status |
|---|---|---|---|---|---|---|
| B1 | SalvageNeverDropped | sandbox.ts:312, :575, :585; host.rs:1193, :2216 | Holder self-fences; `holderFenced` reassigns; leaseLost claims E+1; FleetDO finds no capacity; the epoch is rolled back to E; the holder's salvage at E fails `ev.epoch < info.epoch`, reaches the stale branch (host null) and nestd deletes the disk | The fenced incarnation's uncommitted work is dropped silently | **High** where hosts are full or the cell scales from zero: no faults needed, only a missed heartbeat and no room | Real. TLC (MCB1, 18 steps, no faults) and vitest (passes on main) |
| B1b | SalvageNeverDropped | sandbox.ts:220-252, :575-585 | SandboxDO resets (or loses the answer) mid-placement; the lease is granted but never adopted, so `history` has no entry; the host fails within the 60 s marker; its salvage at the current epoch is refused (host null) | As B1 (the work is mostly boot writes: no agent can bind while `placing`) | Low: reset + host failure within 60 s | Real (TLC: the first all-fixes run, before the salvage-check fix; 11 steps) |
| B-B1 | SalvageNeverDropped | host.rs:2052-2058, :485, :1193 | A turn-end commit is persisted, then nestd restarts before it is delivered; the new process reports the incarnation fenced, so it is reassigned to E+1; retire resends the unanswered turn-end at E, gets STALE_EPOCH, and ends without preparing the salvage | As B1 | Medium: a nestd restart during a commit | Real (TLC, MCBB1, with the SandboxDO side already fixed) |
| B2 | DestroyIsTerminal | sandbox.ts:305-319, :507-519 | `destroy` runs inside placeCurrentEpoch's `await fleet.place`: it neither clears `placing` nor blocks FleetDO, so the continuation writes `host` and `state: creating` over `destroyed`; if `place` lands after `releaseLease`, a live lease outlives the destroy | A destroyed sandbox comes back, possibly running, and its generations become GC roots again | Low: destroy during one RPC (also wake vs operator destroy) | Real. TLC (MCB2, 7 steps) and vitest, both orderings (passes on main) |
| D1 | NoDoubleRun | host.rs:1066-1072, :1404-1490; ec2.ts:45 | The host lease lapses and the watchdog fires once, then waits for a renewal; a `sandbox_create` executed afterwards runs unfenced (create never checks the lease); FleetDO expires the host, terminates it, and counts `shutting-down` as dead; the next epoch boots elsewhere while the old VM still runs | Two VMs for one sandbox until the instance stops. The old one cannot commit (epoch CAS) and its egress is refused by nest-proxy's lease check (state.rs:99, unverified end to end) | Low: create executed after the lapse (an executor backlog, then a partition) | Real (TLC, MCDoubleRun, 18 steps). With STONITH waiting for `terminated`, no violation in a partial run (MCDoubleRunNoShutting) |
| L1 | HostTruthful (liveness) | sandbox.ts:466-473 | FleetDO grants (E, h), and the host is lost (nestd restart then dropUnreported, or STONITH) before SandboxDO reads the place answer; leaseLost arrives while `placing` is set and returns "already handled"; the late answer adopts h | SandboxDO says "placed on h" with no lease and no VM, forever; `resolve` answers not-ready forever | Low: host loss inside one RPC | Real (TLC, MCL1) |
| L2 | Placed (liveness) | fleet.ts:1849-1850, :804-820 | While reassign_queue holds the row for (h1, E), the new holder h2's nestd restarts before creating the VM; dropUnreported's `INSERT OR IGNORE` hits the sandbox's primary key and is dropped; working the old row changes nothing | Lease (E+1, h2) with no VM and nothing to repair it: the sandbox never runs again | Low: a restart inside one leaseLost call (or within 5 s after one throws) | Real (TLC, MCL2) |
| O1 | (contributing to NoDoubleRun) | fleet.ts:1806-1808 | ensureStonithFence skips a sandbox with *any* reassign row, also a stale row for another (host, epoch) | No STONITH fence for the expired lease; with O2 and a hello renewal, a resent create ran unfenced | Very low (row lives for one leaseLost call, or 5 s after one throws) | Real code smell, TLC trace with zero-time interleavings |
| O2 | (contributing) | fleet.ts:1231 | place filters candidates on status and an open socket, not on `last_rx` | A host silent for 30 s with no leases (never expired) is granted a lease and is expired and STONITHed at once | Low (half-open sockets) | Observation |
| O3 | (liveness, needs RPC > 60 s) | sandbox.ts:220-252, fleet.ts:1191 | A place request delivered after reconcilePlacing cleared its stale marker grants a lease SandboxDO never adopts; every later claim is refused (and rolled back) | Sandbox stuck unplaced while a VM runs | Unverified: needs a DO RPC delayed > 60 s | TLC (MCLiveDelayedRpc) |

**Design-doc disagreement:** "an epoch is never retried" (docs/README.md) against S:312, which reuses an epoch number after no capacity (documented as "a placement no host can take spends no epoch"). TLC confirms EpochMonotone fails by design (MCEpochMonotone). No lease was ever granted at a reused number (EpochUnique holds), but the rollback is what turns B1 into a silent loss.

**Lead's three bugs:** B1, B2 and B-B1 are each reproduced as TLC counterexamples (MCB1, MCB2, MCBB1); B1 and B2 also against the real DOs.

**Reproduction against the real DOs:** [verification/repro/sandbox-lease.repro.test.ts](../../../../verification/repro/sandbox-lease.repro.test.ts), not wired into any suite. The pilot copied it into `control-plane/test/`, ran it with `npx vitest run` (vitest-pool-workers), and deleted the copy. **Result on main: 3 of 3 tests pass, and each asserts the bug.** The tests:
- B1: a holder's `fenced` report, a full host, then epoch 1 rolled back and the salvage answered `rejected: stale_epoch`.
- B2, answer held: the destroyed sandbox comes back as `creating` on the host.
- B2, request held: the same, plus a live lease at epoch 1.

The B2 tests hold SandboxDO's `await fleet.place` open by wrapping the instance's FleetDO stub; the SandboxDO and FleetDO code is unchanged. Without that, miniflare answers too fast to interleave in 12 attempts.

**Since:** B2 is fixed as next step 3 says (`destroy` marks the sandbox destroyed and clears `placing` before any await, tells FleetDO, whose `place` then refuses it, and a placement answer for a destroyed sandbox releases its lease and destroys the VM, `SandboxDO.discardPlacement`). Its two cases left the repro file and are regression tests in `control-plane/test/lifecycle.test.ts` ("the lease's guards"). The model follows the code: `FixDestroy` is that fix, `MCFixedB2` checks it, and the fence result, like `StonithClear`, no longer reactivates a host whose instance FleetDO is terminating (MCFixedS2 now reaches 4,147,530 distinct states; MCFixedB2 holds over 14,984,623, TLC 1.7.4).

## What is modelled

| Actor | State | Abstraction |
|---|---|---|
| SandboxDO | epoch, host, placing, lost_from, head, history (capped), destroyed, stored commit outcomes; continuations of placeCurrentEpoch, reconcilePlacing, destroy | Methods split at each await; reset drops continuations, keeps SQLite |
| FleetDO | one lease row, host status, `last_rx` as silence, reassign queue (PK sandbox), STONITH fence pending; leaseLost calls in flight | Reset drops in-flight calls and undelivered requests |
| nestd (2 hosts) | summary row (one per sandbox), retiring incarnations, host lease deadline, watchdog fired, `unanswered` commit, new-process flag | Create, fence, destroy and commit results atomic per command |
| EC2 | running, shutting-down, terminated | Terminate, then a later instance death |
| Network | per host: reliable FIFO events and commands, one heartbeat slot; DO RPC requests and answers | Disconnect, lost answer as faults |
| Ghosts | grants ever made, expired and settled leases, generations, refused salvages | |

**Time:** a discrete tick. Each heartbeat ack sets the host's deadline to `F − age` (age counted from its send); FleetDO expires a host when its silence reaches `E`. Bug and mutation runs use F = 2, E = 3 (20 s and 30 s at a 10 s tick); the fixed and liveness runs use F = 1, E = 2 to finish. Nothing assumes the host fences first: time simply cannot pass a due watchdog, as in nestd (250 ms polling).

**Timing assumptions** (each is an explicit guard, listed so a reader can drop one):

| Assumption | Guard | Real basis |
|---|---|---|
| DO RPCs finish within a tick | `RpcQuiet` on `Tick` | ms against 5 s; a lost answer or reset is the explicit fault; `DelayedRpc` lifts it |
| A host boots after in-flight RPCs settle | `RpcQuiet` on create | boot takes seconds |
| A stale marker means its call ended | `ReconcileStart` | 60 s staleness |
| A queued reassignment is worked at once | `Tick` | queueReassign calls processReassign (fleet.ts:1853) |
| A fence already sent arrives before another host finishes a boot | `FenceQuiet` on create | fence acts on arrival (host.rs:795-801); unverified |

**Fault budget per run:** at most one nestd crash or instance death, one SandboxDO or FleetDO reset, one disconnect, one lost answer, one destroy. Self-fences, timeouts and no-capacity answers are unbounded.

## Properties

| Property | Statement |
|---|---|
| NoDoubleRun | never two alive, unfenced incarnations on different hosts |
| SingleWriter | a head-moving commit is accepted only while no other host runs the sandbox, and every generation came from the host granted its epoch |
| EpochUnique | no epoch is ever leased to two hosts |
| EpochMonotone | SandboxDO.epoch never decreases (action property) |
| HeadChain | head is a non-orphan generation; parents exist; epochs never decrease along non-orphan links |
| SalvageOnlyFromHolder | an orphaned generation at epoch e came from the host granted e |
| SalvageNeverDropped | no salvage (or its resent unanswered commit) is refused for good |
| StonithBeforeReassign | a newer epoch is granted only after each older expired lease was settled: EC2 dead, a STONITH fence acknowledged, or the holder's own fence report |
| DestroyIsTerminal | after destroy returns: destroyed, no host, no lease |
| Placed, PlacingClears, QueueDrains, Recovers, HostTruthful | liveness under weak fairness (strong on a grant), finite faults |

## Configurations

Two hosts with symmetry, one sandbox; epochs ≤ 3 unless noted. "Exhaustive" means TLC explored every reachable state within the bounds; "partial" means the run was stopped with no violation found up to the count shown. Counts for `ci` rows come from TLC v1.7.4 (8 workers, 6 GB, 20 cores shared with other agents); partial rows come from the 2026.10.24 nightly.

| Config | Bounds beyond the defaults | Result | Distinct states | Depth | Time | Coverage |
|---|---|---|---|---|---|---|
| MCB1 | no faults, epochs ≤ 2, 1 commit | violates SalvageNeverDropped | 80,883 | 18 | 2 s | counterexample |
| MCBB1 | 1 nestd restart, salvage check fixed | violates SalvageNeverDropped | 47,257 | 14 | 1 s | counterexample |
| MCB2 | 1 destroy, epochs ≤ 2 | violates DestroyIsTerminal | 211 | 7 | 0 s | counterexample |
| MCDoubleRun | all faults (1 each) | violates NoDoubleRun | 4,673,892 | 19 | 49 s | counterexample |
| MCEpochMonotone | no faults, epochs ≤ 2 | violates EpochMonotone | 127 | 6 | 0 s | counterexample |
| MCL1 | liveness, 1 crash | violates HostTruthful | 860,294 | n/a | 65 s | counterexample (lasso) |
| MCL2 | liveness, 1 crash, F = 1, E = 2 | violates Placed | 682,972 | n/a | 70 s | counterexample (lasso) |
| MCLiveDelayedRpc | liveness, late RPCs | violates Placed | 714,053 | n/a | 69 s | counterexample (lasso) |
| MCMutFgeE | F = E = 3, fixes on | violates NoDoubleRun | 4,314,056 | 19 | 52 s | counterexample |
| MCMutNoStonith | fixes on | violates StonithBeforeReassign | 131,652 | 13 | 2 s | counterexample |
| MCMutNoEpochCheck | fixes on | violates SingleWriter | 1,523,363 | 17 | 16 s | counterexample |
| MCMutHistory | HISTORY_MAX = 1, no faults | violates SalvageNeverDropped | 161,281 | 19 | 2 s | counterexample |
| **MCFixedS2** | fixes on; F = 1, E = 2, epochs ≤ 2, no commits, 1 disconnect | **holds** | 4,345,720 | 47 | 61 s | **exhaustive** |
| MCFixedS3 | fixes on; small; 1 reset, 1 lost answer, 1 destroy | no violation | 30,540,075 | 26 | 40 min | partial |
| MCDoubleRunNoShutting | main, STONITH waits for `terminated`; F = 1, E = 2, epochs ≤ 2 | no violation | 23,123,632 | 26 | 5 min | partial |
| MCLive | liveness, fixes on, 1 crash, epochs ≤ 2 | no violation | 378,102 | 20 | 14 min | partial |
| MCFixedS1, S4, S5 | fixes on; small; crash with a commit / late RPCs / no rollback | not run on the final spec | | | | none |
| (removed) fixes on, F = 2, E = 3, epochs ≤ 3, 1 disconnect | earlier spec revision | no violation | 83,934,041 | 35 | 22 min | partial |

**So what is proved:** with all seven fixes on, two hosts, one sandbox, F = 1 < E = 2, at most two epochs, no commits and one disconnect, every safety invariant holds over every reachable state (MCFixedS2). For the other fault classes, the commit-carrying configurations and liveness, the evidence is only "no counterexample up to the partial depths above". On main, every finding has a concrete counterexample.

## Mutations (teeth)

Every key invariant was shown violable:

| Mutation | Property violated | Trace |
|---|---|---|
| F = E (fixes on) | NoDoubleRun | lease expiry and the host deadline fall in the same instant; FleetDO expires first, EC2 confirms, the next epoch boots while the old VM runs |
| Expiry reassigns without STONITH | StonithBeforeReassign | epoch 2 granted while (1, h1) is expired and unsettled |
| Commit without the epoch/host check | SingleWriter | a stale holder's commit moves the head while the new holder runs |
| HISTORY_MAX = 1 | SalvageNeverDropped | the holder's salvage is refused once its epoch left the history |
| Code as on main | see Findings | B1, B-B1, B2, D1, L1, L2, EpochMonotone |

## Model corrections along the way

Each first counterexample was checked line by line against the code; these were modelling artifacts and were fixed: an RPC answer outliving a seconds-long boot (`RpcQuiet` on create); the holder's own fence report not counted as STONITH settlement; the epoch bound as an action guard producing a fake leaseLost error (now a state constraint); reconcile before a 60 s staleness; a sent fence lost when the socket closed; the hello missing `ensureStonithFence`; and a queued reassignment left unworked across ticks.

## What the model cannot catch

- Anything below the abstractions: the generation chain's retention, pins and GC; forks; evacuation, drains and spot notices; the attach and binding path; the agent epoch; brain hosts.
- The real duration of an await. Interleavings only within the guards above. The "very low" likelihoods are judgements, not measurements.
- Byzantine or buggy hosts, clock drift beyond the tick, CLOCK_BOOTTIME suspends, Firecracker or cgroup failures (a nestd crash is assumed to kill its VMs: unverified on a real host).
- Command failure paths (`commandFailed` retries, `failed` sandboxes, retryPlacement) and `reapStale`, except as noted.
- More than two hosts, one sandbox, epochs above 3, and two commits per run.

## Effort

- **Artifacts:** 810 lines of TLA+, 19 configurations, and one vitest file (98 lines, 3 tests).
- **Time:** about 3.5 hours by one agent, roughly half of it waiting on large TLC runs that never finished. The lesson: start with F = 1, E = 2 and one fault class per configuration.
- **Iterations:** about a dozen model corrections (below), plus seven fix switches.
- **Tools:** TLC 2026.10.24 for development, v1.7.4 for the `ci` set, 8 workers, 6 GB heap.

## Next steps

1. Fix B1/B1b: check a salvage against FleetDO's lease grants (FleetDO keeps a grant log; `onCommitRequest` attaches "this host held E"), and accept it as an orphan also at the current epoch from a non-holder. Dropping the rollback alone does not fix B1b.
2. Fix B-B1: in retire, a STALE_EPOCH answer to the resent `unanswered` request must fall through to preparing the salvage (host.rs:2052-2058).
3. Fix B2: mark `destroying` before the first await and check it in every placement continuation; have FleetDO.place refuse a destroyed sandbox (the registry already records `destroyed_ms`). Done on refactor/all.
4. Fix D1: a create under a lapsed host lease starts fenced (or the watchdog re-checks every new incarnation); and/or STONITH waits for `terminated`, not `shutting-down`.
5. Fix L1: a lease lost at the epoch still being placed clears the marker and claims again.
6. Fix L2, O1 and O2: key reassign_queue rows, and ensureStonithFence's skip, by (sandbox, host, epoch); filter placement candidates by `last_rx`. L2 and O1 are fixed on refactor/fleet as modelled (`FixQueue`, `FixStonithFence`): the `reassignments` table, keyed by (sandbox, host, epoch), and the skip matching the lease's own host and epoch.
7. Turn the vitest reproductions into regression tests with the fixes; add a CI job that runs the "holds" and "violates" configurations listed in the spec README.
