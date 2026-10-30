# Pilot: TLA+ model of the brain lifecycle and the one-brain rule

A TLC-checked model of how an agent's brain is started, killed, moved and released, across AgentDO, FleetDO, nestd and the agent runner. It covers:

- `origin/deferred/agent-epoch` at 65bf6ef;
- the single-record design chosen on 2026-10-25 ([design/](../design/)), with the amendments A1-A6 that this model's counterexamples led to;
- the **current design** as built on `brain-record` 82396b3 / 36b60d5 and main@b2b9219. It has no same-host re-issue and never adopts, and the tick re-checks a host before expiring it. A host-loss notice releases only a record at or below its epoch, and only while FleetDO still reports the host lost (`AgentDO.onHostLost`). A previous-release host is closed off as described below.

Spec, configs and expected outcomes: [verification/tla/agent-brain/](../../../../verification/tla/agent-brain/); `verification/run.sh` runs them. Tools: the TLC 2026.10.24 nightly for exploration, and TLC v1.7.4 for every `ci` config and every current-design run. Prose inventory: [../](../README.md). Conformance against the code: [../conformance/](../conformance/README.md). This version supersedes the copies merged in PRs #29 and #31.

**Correction.** Earlier versions said the 6073da7 variant's "host-loss release ignores the epoch". That was wrong about the code, which had both guards; the claim described a relayed design choice. The `MC_built_*` runs model that weaker, unguarded release, so they are a model variant, not the code.

## Verdict

| Question | Answer |
|---|---|
| S on the current design, epochs ≤ 2 | **Holds exhaustively** with one fault of each kind (none, reset, lost RPC, idle exit, crash, operator restart, partition) and with restart + ignored kill. Drain: **no violation through BFS depth ~40 (72.2M states), not exhaustive.** An ignored kill alone is vacuous. |
| S on the current design, epochs ≤ 3 | **Depth-bounded only:** no violation through BFS depth ~34-44, for no fault and for each fault kind (drain, partition, idle exit, lost RPC, ignored kill; 23-41M states each). C6 sits at depth 30 and the other counterexamples at ≤ 31, so all of them fall inside this bound. No run finishes in 15 min. |
| S with a previous-release host (`OLD_HOST`) | Holds exhaustively, epochs ≤ 2: no fault, crash, partition. |
| L (turns drain, no wedge) on the current design | **Partial:** no violation in the explored part, with no fault (2.5M states) and with a previous-release host (2.1M states), under the premise that lease lapses eventually stop. Liveness with faults on the current design is not run. C2 and the 65bf6ef liveness bugs reproduce. |
| The review's H1-H4 on 65bf6ef | All four reproduced. |
| The record design as first written | Two L counterexamples (C1, C2). Its amended versions then gave three S counterexamples (C3, C5, N1), and the refused-start contract two more (C4, D1). The host-loss guards are load-bearing (C6). Each led to an amendment or a fix that is in the code. |
| Timing (self-fence F < expiry E) | Load-bearing: with F = E, TLC finds two acting brains. |

## What is modelled

One agent with hands, two hosts that can run its brain, and the sandbox's gateway on a third, healthy host. Neither design fences the gateway by agent epoch: a hands binding at the unchanged sandbox epoch is admitted for as long as the process holding it lives. S therefore rests entirely on the old process being dead before a new one gets a binding.

| Model | Design rule / code |
|---|---|
| `RWake`, `RStart`, `RKill`/`RKillAlarm`, `REscalate`, `RDeadline`, `RStatusRelease`, `ROpRestart` | Rules 2-4, A1, A2. `RStart` answers `none` while a non-condemned brain exists (`NO_REISSUE`); an operator restart condemns and keeps the intent. `RDeadline` (a starting brain that can't say hello is condemned) is **assumed**. Rule 4's "processed" means the host's own result for the kill; FleetDO never writes one, as in PR #32 (`commands.answered_by`). |
| `RExited`, `RHostLost` | Rule 3: release on an exit at or above `brain.epoch`, or on host loss bounded by epoch (`LOSS_EPOCH`) and re-checked at delivery (`LOST_RECHECK`) |
| `ROldCap` | A previous-release host is wedged at the 15 min cap (36b60d5, N21) |
| `SessOK`, `Hello`, `ResolveReq/Resp` | Rule 1; 65bf6ef `current()`, `onHello`, `hands_resolve` (re-checked after its await) |
| `T*` actions | 65bf6ef `startBrain`, `killForMove` (split at its await), `onExited`, `onHostLost`, the `exit_wait` and `pending_start` alarms |
| `Issue`, `IssueFail`, `RKillFail`, `ResetAgentDO` | `issueCommands` RPCs; an AgentDO eviction between awaits |
| `Deliver`, `Exec`, `ApplyKill` | The fleet channel: in order, resent after reconnect; a kill applied on arrival. A kill is two-phase: the process lives, still holding its binding, until it exits. |
| `RunnerStart`, `Register`, `StopExit`, `IdleBegin` | The runner's start: lease check; a brain on its way out is replaced once gone; never adopts with `NO_ADOPT`. An `AgentStop` for an unregistered agent is a no-op. |
| `AccOut`/`AccSet`, `OwedExit` | nestd's `accept_event` (65bf6ef: keyed by agent; `FIX_H1`: by epoch); A4's owed exit |
| `LeaseLapse` | nestd `self_fence` and the runner's watchdog, each once per lapse |
| `HostHello`, `Heartbeat`, `Tick`, `Expire`/`ExpireRead`+`ExpireCommit`, `LostSend/Deliver/Drop`, `DrainRetire`, `ConfirmDead` | fleet.ts hello and reconcile, lease expiry (atomic, or split at the tick's await), A2's retried `onHostLost`, scaleDown's drained branch, STONITH |

**Time.** Ages instead of clocks. The host lease holds while the time since its newest acked heartbeat was sent is below F; FleetDO may expire a host once `last_rx` is E old. Heartbeats are received and acked instantly, the worst case for safety. Time never passes a lapse the host hasn't acted on. The 60 s and 15 min timers fire only when nothing is in flight on a connected link (counting a dying process or an owed exit), or when the host is disconnected.

**Previous-release host** (`OLD_HOST = h2`). h2 starts with a live brain at epoch 1 (with a binding and the current session) and is drained on sight. It never gets a start, and its exits and kill progress never release its brain. Escalation waits for the host's loss and wedges it at the cap; only loss releases the brain, and its epoch-less row is exempt from the epoch bound.

**Not modelled:** sandbox moves (the binding stays valid); more than one queued turn; nestd restarts; the runner crashing while Claude Code survives; binding expiry; epoch-less exits and other previous-release behaviour beyond the `OLD_HOST` closure; the orphan-kill backstop; nestd dropping its runner connection before a wedge (the model relies on the lease lapse alone, which is more conservative); re-draining a host reactivated by STONITH-by-fence.

## Properties

| Property | Meaning |
|---|---|
| `OneActingBrain` (S) | At most one brain process is acting: AgentDO would accept its platform call or `hands_resolve`, or the gateway would admit its hands call (it holds a binding and lives) |
| `CondemnedFenced` | A brain being killed never acts on AgentDO (rule 1, H3) |
| `KillTombstone` | No runner registers or adopts a start at or below a kill that reached its host first |
| `NoHealthyWedge` (L3) | A host never partitioned, crashed, terminated or kill-ignoring is never wedged (a previous-release host is excluded: it is wedged at the cap by design) |
| `AwaitConsistent` | 65bf6ef: `awaiting_exit` names the assigned host at the current epoch (H2) |
| `NoEpochRegression` | Epoch counters, tombstones and a process's adopted epoch never decrease |
| `TurnsDrain`, `NoWedge` (L1, L2) | A queued turn eventually runs; a condemned brain is eventually resolved (weak fairness, finite faults) |
| `StableTurnsDrain`, `StableNoWedge` | The same, for behaviours where lease lapses eventually stop. A lapse without a fault (a host merely slow to heartbeat) is free in the model, so without this premise a host can lapse and expire forever, which TLC duly reports. |

## Results

All runs: 2 hosts, one turn, `F = 1 < E = 2`, queues ≤ 2/2/3, depth uncapped unless cut. "Exhaustive" means TLC drained its queue. "Depth-bounded" means the run was cut at its time limit, and every state up to the BFS depth shown was checked.

### Current design, epochs ≤ 2 (exhaustive unless marked)

Host symmetry. Most rows below were run before the two host-loss guards were added to the model, so their release is the weaker, unguarded one: a superset of the code's releases. `NO_ADOPT` was on for none, wedge and restart (same state counts with it off). Re-run with both guards (TLC v1.7.4, 4 workers), all exhaustive, all hold:

- none: 5,271,444 states, 174 s;
- reset: 8,403,849 states, 330 s;
- ignored kill: 5,271,444 states, 208 s (vacuous);
- previous-release host, no fault: 5,392,154 states, 139 s.

| Fault kind | Distinct states | Depth | Time | Result |
|---|---|---|---|---|
| none | 5,345,649 | 59 | 83 s | holds |
| AgentDO reset | 8,510,580 | 60 | 155 s | holds |
| lost RPC | 10,794,534 | 61 | 209 s | holds |
| idle exit / session drop | 20,310,444 | 62 | 303 s | holds |
| crash | 26,456,116 | 61 | 449 s | holds |
| operator restart | 24,636,012 | 59 | 354 s | holds |
| partition | 43,765,849 | 65 | 781 s | holds |
| restart + ignored kill (2 faults) | 53,924,181 | 59 | 26 min | holds; not vacuous: the ignored kill, escalation, wedge, lapse and expiry are all reached |
| ignored kill alone | 5,345,649 | 59 | 111 s | holds, but **vacuous** (same states as no fault) |
| drain | 72,174,177, 2.8M queued | ~46 | 60 min, cut | **depth-bounded: no violation through depth ~40** (box out of memory) |
| previous-release host, none / crash / partition | 5,427,050 / 22,999,842 / 41,315,918 | 55 / 56 / 56 | 75 s / 337 s / 768 s | holds (no symmetry) |
| N1 re-check off, none | 380,822 | 26 | 7 s | **violates** S |

### Current design, epochs ≤ 3 (depth-bounded)

Both host-loss guards on, `E3Bounds` (`SmallBounds`, and never every host lapsed or expired at once), host symmetry, 15 min per run, TLC v1.7.4 with `-Xmx4g`, 4 workers, `-fpmem 0.25`.

| Fault kind | Distinct states | Depth reached | Queued at cut | Result |
|---|---|---|---|---|
| none | 35,253,951 | 45 | 6,420,601 | no violation through depth ~44 |
| drain | 40,180,285 | 35 | 10,728,442 | no violation through depth ~34 |
| partition | 40,717,934 | 37 | 10,812,521 | no violation through depth ~36 |
| idle exit / session drop | 27,409,538 | 40 | 6,679,947 | no violation through depth ~39 |
| lost RPC | 23,383,533 | 39 | 5,350,065 | no violation through depth ~38 |
| ignored kill | 23,487,979 | 43 | 4,755,310 | no violation through depth ~42 |
| C6: both guards off, none | 531,104 | 30 | | **violates** S (10 s) |
| epoch guard only, none | 38,449,604 | 45 | 6,810,830 | no violation through depth ~44 |
| re-check only, none | 36,747,955 | 45 | 6,800,909 | no violation through depth ~44 |

### Liveness

Liveness properties are checked under the `Stable*` premise (lapses eventually stop), without symmetry, at epochs ≤ 2, using TLC v1.7.4 with `-Xmx4g` and 4 workers. TLC checks liveness over the graph explored so far, so a cut run only shows that the explored part has no violating cycle.

| Config | Design, faults | Result |
|---|---|---|
| `MC_nr_live` | current design, none | no violation in the explored part (2,495,575 states, depth 34; cut at 15 min) |
| `MC_old_live` | current design + previous-release host, none | no violation in the explored part (2,065,473 states, depth 31; cut at 15 min) |
| `MC_rec_live_lost` | record + A1, no A2; crash + lost `onHostLost` | **violates** (C2): stuck on a dead host, ~0.45M states, 65 s |
| `MC_tip_H4` | 65bf6ef AgentDO with H1, H3 fixed; crash | **violates**, 37,478 states, 5 s. TLC's shortest trace mixes H4 and H2: after the crash the host is never expired (H4), an operator's `confirmDead` lands during `killForMove`, and the stale `awaiting_exit` (H2) strands the deferred start. An earlier run, before the model gained `confirmDead` during `killForMove`, gave the pure H4 trace (crash, then nothing ever moves the agent). |
| `MC_nr_live_crash`, `MC_nr_live_lost` | current design, one crash / one lost RPC | not run (out of time on the shared box) |

### Earlier designs, epochs ≤ 2 (exhaustive)

| Fault kind | Fully amended (A1-A6): states / depth / time | Unguarded-loss variant: states / depth / time |
|---|---|---|
| none | 1,675,968 / 53 / 37 s | 1,698,223 / 53 / 49 s |
| drain | 24,380,329 / 56 / 8m10s | 24,738,809 / 56 / 8m34s |
| partition | 13,310,838 / 57 / 5m40s | 13,580,437 / 57 / 3m56s |
| crash | 8,128,979 / 55 / 3m28s | 8,261,961 / 55 / 3m15s |
| lost RPC | 3,399,849 / 56 / 1m34s | 3,441,749 / 54 / 2m53s |
| AgentDO reset | 2,666,875 / 56 / 1m11s | 2,699,000 / 54 / 1m17s |
| idle exit | 6,457,924 / 56 / 3m16s | 6,566,829 / 58 / 7m35s |

All hold. Before the current sweep, three earlier partial runs found no violation: epochs ≤ 3 with no fault (31.1M states, depth 41); epochs ≤ 3 with idle exit + drain, before A5/A6 (67.1M states, depth 30); and A1-A3 with one host fault, before A4 (36M states).

## Counterexamples

Every one comes from a TLC trace and has a config that reproduces it; all but C5 are `ci` (TLC v1.7.4).

| Id | Config | Design | Broken | Steps / states | Status |
|---|---|---|---|---|---|
| H1 | `MC_tip_H1`, `MC_rec_noH1` | 65bf6ef; record without `FIX_H1` | S | 29 / 3.8M; 25 / 4.7M | real (review H1) |
| H2 | `MC_tip_H2`, `MC_tip_H2b` | 65bf6ef AgentDO | `AwaitConsistent`, L3 | 13 / 2.0k; 18 / 23k | real (H2) |
| H3 | `MC_tip_H3`, `MC_rec_noH3` | 65bf6ef; record without `FIX_H3` | `CondemnedFenced` | 14 / 2.0k; 11 / 1.1k | real (H3); S still holds |
| H4 | `MC_tip_H4` | 65bf6ef AgentDO | L1 | liveness, 58k | real (H4) |
| C1 | `MC_rec_design` | record as first written | L3 | 9 / 517 | design gap, fixed by A1 |
| C2 | `MC_rec_live_lost` | record + A1, no A2 | L2 | liveness | design gap, fixed by A2 |
| C3 | `MC_rec_hosts`, `MC_amend_noepoch` | A1 + A2, no A3 | S | 25 / 1.6M; 25 / 2.8M | design gap, fixed by A3 |
| C4 | `MC_refused_off` | A1-A3, refused exits immediate | S | 25 / 5.4M | the implementer's hole, wider scope; fixed by A4 for every refused start |
| D1 | `MC_startfail` | A1-A4 + a38d3c0's `startFailed` release | S | 25 / 7.5M | real in a38d3c0 (conformance D1), fixed |
| C5 | `MC_ex_all` (`full`) | A1-A4, no A5/A6 | S | 31 / 43.2M | design gap, fixed by A5 + A6 |
| N1 | `MC_n1_off`, `MC_nr_n1off` | tick expiry split, no re-check | S, with **zero faults** | 26 / 0.4M | real in 6073da7 (conformance N1), fixed |
| C6 | `MC_c6` | current design with both host-loss guards off, epochs ≤ 3 | S, with **zero faults** | 30 / 0.5M | regression: main has both guards, covered by `agent-seams.test.ts:918` (D2/M4); either guard alone clears depth ~44 |
| — | `MC_mut_nowait`, `MC_mut_FE`, `MC_tip_notomb` | mutations | S, S, `KillTombstone` | 16 / 23k; 23 / 489k; 12 / 1.1k | teeth |

**C1. A healthy host wedged by a kill FleetDO never stored.** A brain is condemned and `phase = condemned` is saved. An AgentDO reset or a failed `issueCommands` then loses the kill before FleetDO stores it. Rule 4 finds the kill "not processed" and wedges a healthy host. A1 sends the kill from an alarm until it is stored.

**C2. The agent stuck on a dead host.** `brainsLost` deletes the row, then its `onHostLost` call fails and is only logged. `brain` still names the expired host, and nothing releases it. A2 releases on a lost host and retries `onHostLost` until acked.

**C3. A returning host runs a start issued before its loss.** Start{1} is queued to h1, and h1 lapses and is expired with `onHostLost` in flight. h1 says hello and FleetDO resends the start; brain 1 runs and gets a binding. The late `onHostLost` releases {h1, 1}, and brain 2 starts on h2. A3: no start outlives a lapse or an expiry.

**C4 / D1. A refused start's exit, or its command error, releases while an older brain lives.** Brain 1 begins an idle exit. Start{2} on the same host is refused (here by A3, just after h1's lease deadline), and exit{2} releases {h1, 2}. Brain 3 starts on h2 while brain 1 still holds its binding. A4 makes every refused start's exit wait for older brains. D1 is the same release arriving through `startFailed`.

**C5. A stale `onHostLost` ack deletes a newer row, and a drained host reads as dead.** A5 deletes only at the acked epoch; A6 counts only expiry or confirmed death as "lost".

**N1. The tick expires a host from a stale snapshot.** h1's hello and the start run between the tick's read and its write. The expiry and `onHostLost` then release a brain that runs with a valid lease. The re-check at commit fixes it.

**C6. A stale host-loss notice releases a brain started after the host came back.**

1. Start{1} on h1 is dropped at h1's lapse (A3).
2. h1 is expired, and A2's `onHostLost(h1)` is in flight.
3. h1 says hello, which clears `lost`; reconcile releases {h1, 1}.
4. Start{2} runs on h1, and brain 2 gets a binding.
5. The stale notice lands and releases {h1, 2}.
6. Brain 3 starts on h2.

It needs three epochs, which is why the epochs ≤ 2 bound could not show it. On main both the epoch bound and the delivery re-check of `lost` prevent it, and either one alone clears depth ~44.

**Also seen:** OneLiveBrain doesn't hold in any design, and isn't meant to: a returning host could run a zombie start before A3, but the zombie can't act. A liveness counterexample with no fault: hosts lapse and expire forever. This is the environment, not the design, hence the `Stable*` premise.

## Mutations (teeth)

| Mutation | Result |
|---|---|
| No condemn-and-wait (`MC_mut_nowait`) | violates S (16 steps) |
| F = E (`MC_mut_FE`) | violates S (23 steps) |
| No nestd tombstone (`MC_tip_notomb`) | violates `KillTombstone` (12 steps) |
| Each H-fix, A1-A4, the N1 re-check, or both host-loss guards off | violates its property (table above) |

## Conformance items added

From [../conformance/](../conformance/README.md#what-the-model-should-add):
- Added: item 1 (`START_FAIL`, D1); item 2 (C3, plus A5's epoch-keyed delete); N1 (`SPLIT_EXPIRE`); D2/M4 (`LOSS_EPOCH`, `LOST_RECHECK`, C6); PR #32's FleetDO-written answers (they never count as processed).
- Partly covered: item 6, mixed versions, only as the `OLD_HOST` closure.
- Not modelled: items 3-5, and epoch-less exits.

## What the model cannot catch

Code that diverges from these actions: the model encodes the design and a reading of the code, not the code itself. Also beyond it: the gateway admitting calls after the process holding them dies (assumed cut on close, unverified); clock skew between host and FleetDO (one global clock); more than 2 hosts, 3 epochs or one queued turn; anything past the depth reached by the depth-bounded runs.

## Effort

About 1,060 spec lines, 61 configs, about 15 hours over four days. The design moved eight times during the pilot: 65bf6ef; the record design; A1-A3; A4 and D1; A5 and A6; the 6073da7 choices; 82396b3/36b60d5; and the host-loss guards. About 15 TLC iterations went to model artifacts: a terminated host counted as healthy, delayed acks exploding the state space, a silently dropped start, a dying process missing from the timer guard, and liveness without a stable environment. State space was the main cost, together with a shared box that ran out of memory: the epochs ≤ 3 runs and drain don't finish in 15 min.

## Next steps

1. On a dedicated machine, run drain (epochs ≤ 2) and the epochs ≤ 3 sweep to completion, or give them a depth bound that CI can state.
2. Model epoch-less exits and conformance items 3-5.
3. Check S on 3 hosts at epochs ≤ 2 (unexplored).
