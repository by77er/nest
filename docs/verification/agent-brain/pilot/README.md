# Pilot: TLA+ model of the brain lifecycle and the one-brain rule

A TLC-checked model of how an agent's brain is started, killed, moved and released, across AgentDO, FleetDO, nestd and the agent runner. It covers three things:

- `origin/deferred/agent-epoch` at 65bf6ef;
- the single-record design the owner chose on 2026-10-25 (`BRAIN-RECORD-DESIGN.md`), with the amendments A1-A6 this model's counterexamples led to;
- two as-built choices of `origin/deferred/brain-record` at 6073da7.

Spec, configs and expected outcomes: [verification/tla/agent-brain/](../../../../verification/tla/agent-brain/). Tools: TLC 2026.10.24 (nightly) for exploration, TLC v1.7.4 for every `ci` config. Prose inventory: [../](../README.md). Conformance against the code: [../conformance/](../conformance/README.md).

**In progress:** the design change that drops same-host re-issue (a start while a non-condemned brain exists answers `none`); the epochs ≤ 3 sweep; liveness on the amended design. Results below are as of 2026-10-26 00:30.

## Verdict

| Question | Answer |
|---|---|
| S (at most one brain can act, on AgentDO or through a hands binding) on the fully amended design | **Holds exhaustively** at the small bound (epochs ≤ 2, one fault of each kind; table below). Not yet at epochs ≤ 3, which every counterexample here needed. |
| S on the as-built variant (6073da7: host-loss release ignores the epoch) | Holds at the same bound with atomic expiry. With the tick's expiry split at its await (N1), **violated with zero faults**; with the re-check, holds. |
| The review's H1-H4 on 65bf6ef | All four reproduced. |
| The record design as first written | Two L counterexamples (C1, C2), then three S counterexamples in the amended versions (C3, C5, N1) and two in the refused-start contract (C4, D1). Each led to an amendment or fix (A1-A6, A4's scope, the N1 re-check). |
| Timing (self-fence F < expiry E) | Load-bearing: with F = E, TLC finds two acting brains. |

## What is modelled

One agent with hands, two hosts that can run its brain, and the sandbox's gateway on a third, healthy host. Neither design has an agent-epoch fence at the gateway: a hands binding at the unchanged sandbox epoch is admitted for as long as the process holding it lives. So S rests entirely on the old process being dead before a new one gets a binding.

| Model | Design rule / code |
|---|---|
| `RWake`, `RStart`, `RKill`/`RKillAlarm`, `REscalate`, `RDeadline`, `RStatusRelease` | Rules 2-4, A1, A2. `RDeadline` (a starting brain that can't say hello is condemned) is **assumed**: the design doesn't say how a start that never arrives ends. |
| `RExited`, `RHostLost` | Rule 3: release only on an exit at or above `brain.epoch`, or on host loss |
| `SessOK`, `Hello`, `ResolveReq/Resp` | Rule 1; 65bf6ef `current()`, `onHello`, `hands_resolve` (re-checked after its await) |
| `T*` actions | 65bf6ef `startBrain`, `killForMove` (split at its await), `onExited`, `onHostLost`, the `exit_wait` and `pending_start` alarms |
| `Issue`, `IssueFail`, `RKillFail`, `ResetAgentDO` | `issueCommands` RPCs; an AgentDO eviction between awaits |
| `Deliver`, `Exec`, `ApplyKill` | The fleet channel: in order, resent after reconnect; a kill applied on arrival. A kill is two-phase: the process lives, still holding its binding, until it exits. |
| `RunnerStart`, `Register`, `StopExit`, `IdleBegin` | The runner's start (lease check, a brain on its way out is replaced once gone, a live one adopts the newer epoch); an `AgentStop` for an unregistered agent is a no-op |
| `AccOut`/`AccSet`, `OwedExit` | nestd's `accept_event` (65bf6ef: keyed by agent; `FIX_H1`: by epoch); A4's owed exit |
| `LeaseLapse` | nestd `self_fence` and the runner's watchdog, each once per lapse |
| `HostHello`, `Heartbeat`, `Tick`, `Expire`/`ExpireRead`+`ExpireCommit`, `LostSend/Deliver/Drop`, `DrainRetire`, `ConfirmDead` | fleet.ts hello and reconcile, lease expiry (atomic, or split at the tick's await), A2's retried `onHostLost`, scaleDown's drained branch, STONITH |

**Time.** Ages instead of clocks. The host lease holds while the time since its newest acked heartbeat was sent is below F; FleetDO may expire a host once `last_rx` is E old. Heartbeats are received and acked instantly, the worst case for safety. Time never passes a lapse the host hasn't acted on. The 60 s and 15 min timers fire only when nothing is in flight on a connected link (including a dying process or an owed exit), or the host is disconnected.

**Abstracted / not modelled:** sandbox moves (the binding stays valid); one queued turn; nestd restarts; the runner crashing while Claude Code survives; binding expiry; epoch-less exits from an old nestd or old rows (6073da7's choice 2, a gap); mixed versions per host; and the newest 6073da7 additions (orphan-kill backstop, version gating, wedge closing the socket, runner restart before STONITH).

## Properties

| Property | Meaning |
|---|---|
| `OneActingBrain` (S) | At most one brain process is acting: AgentDO would accept its platform call or `hands_resolve`, or the gateway would admit its hands call (it holds a binding and lives) |
| `CondemnedFenced` | A brain being killed never acts on AgentDO (rule 1, H3) |
| `KillTombstone` | No runner registers or adopts a start at or below a kill that reached its host first |
| `NoHealthyWedge` (L3) | A host never partitioned, crashed, terminated or kill-ignoring is never wedged |
| `AwaitConsistent` | 65bf6ef: `awaiting_exit` names the assigned host at the current epoch (H2) |
| `NoEpochRegression` | Epoch counters, tombstones and a process's adopted epoch never decrease |
| `TurnsDrain`, `NoWedge` (L1, L2) | A queued turn eventually runs; a condemned brain is eventually resolved (weak fairness, finite faults) |

## Results: exhaustive bound

Bound: 2 hosts (symmetry), agent epochs ≤ 2, one turn, F = 1 < E = 2, queues ≤ 2/2/3, one fault of the named kind, depth uncapped. Every run below finished: TLC drained its queue. Fully amended = every H-fix, A1-A6, A4 (`REFUSED_WAITS`), `LOSS_EPOCH` on. As built = the same with `LOSS_EPOCH` off.

| Fault kind | Fully amended: states / depth / time | As built: states / depth / time | Result |
|---|---|---|---|
| none | 1,675,968 / 53 / 37 s | 1,698,223 / 53 / 49 s | holds |
| drain | 24,380,329 / 56 / 8m10s | 24,738,809 / 56 / 8m34s | holds |
| partition | 13,310,838 / 57 / 5m40s | 13,580,437 / 57 / 3m56s | holds |
| crash | 8,128,979 / 55 / 3m28s | 8,261,961 / 55 / 3m15s | holds |
| lost RPC (`issueCommands`, `onHostLost` send or ack) | 3,399,849 / 56 / 1m34s | 3,441,749 / 54 / 2m53s | holds |
| AgentDO reset | 2,666,875 / 56 / 1m11s | 2,699,000 / 54 / 1m17s | holds |
| idle exit / session drop | 6,457,924 / 56 / 3m16s | 6,566,829 / 58 / 7m35s | holds |
| runner ignores a kill | 1,675,968 / 53 / 42 s | not run | holds, but **vacuous**: at this bound no kill meets a live brain |
| none, as built with split expiry + re-check (N1 fixed) | | 5,345,649 / 59 / 3m59s | holds |

**Partial only** (cut at 10-15 min, no violation): epochs ≤ 3 with zero faults (31.1M states, depth 41); epochs ≤ 3 with idle exit + drain before A5/A6 (67.1M states, depth 30); A1-A3 with one host fault before A4 (36M states). Every counterexample below needed 3 epochs, except N1 and C3, so the epochs ≤ 2 result is weak evidence; the epochs ≤ 3 sweep is in progress.

## Counterexamples

Each comes from a TLC trace and is reproduced by a `ci` config (TLC v1.7.4; steps, distinct states).

| Id | Config | Design | Broken | Steps / states | Status |
|---|---|---|---|---|---|
| H1 | `MC_tip_H1`, `MC_rec_noH1` | 65bf6ef; record without `FIX_H1` | S | 29 / 3.8M; 25 / 4.7M | real (review H1) |
| H2 | `MC_tip_H2`, `MC_tip_H2b` | 65bf6ef AgentDO | `AwaitConsistent`, L3 | 13 / 2.0k; 18 / 23k | real (H2) |
| H3 | `MC_tip_H3`, `MC_rec_noH3` | 65bf6ef; record without `FIX_H3` | `CondemnedFenced` | 14 / 2.0k; 11 / 1.1k | real (H3); S still holds |
| H4 | `MC_tip_H4` | 65bf6ef AgentDO | L1 | liveness, 24k | real (H4) |
| C1 | `MC_rec_design` | record as first written | L3 | 9 / 517 | design gap, fixed by A1 |
| C2 | `MC_rec_live_lost` | record + A1, no A2 | L2 | (re-check in progress) | design gap, fixed by A2 |
| C3 | `MC_rec_hosts`, `MC_amend_noepoch` | A1 + A2, no A3 | S | 25 / 1.6M; 25 / 2.8M | design gap, fixed by A3 |
| C4 | `MC_refused_off` | A1-A3, refused exits immediate | S | 25 / 5.4M | the implementer's hole, wider scope; fixed by A4 for every refused start |
| D1 | `MC_startfail` | A1-A4 + a38d3c0's `startFailed` release | S | 25 / 7.5M | real in a38d3c0 (conformance D1) |
| C5 | `MC_ex_all` | A1-A4, no A5/A6 | S | 31 / 43.2M (10 min) | design gap, fixed by A5 + A6 |
| N1 | `MC_n1_off` | as built, tick expiry split, no re-check | S, with **zero faults** | 26 / 402k | real in 6073da7 (conformance N1); fixed by the re-check |
| — | `MC_mut_nowait`, `MC_mut_FE`, `MC_tip_notomb` | mutations | S, S, `KillTombstone` | 16 / 23k; 23 / 489k; 12 / 1.1k | teeth |

**C1. A healthy host is wedged by a kill FleetDO never stored.** A brain is condemned (drain, operator host hint, or starting deadline) and `phase = condemned` is saved. Then an AgentDO reset, or a failed `issueCommands`, loses the kill before FleetDO stores it. At since+60 s rule 4 finds the kill "not processed" and wedges a healthy host. Every brain on it dies at 20 s, and its sandboxes self-fence. A1 sends the kill from an alarm until it is stored, and re-sends when none is stored.

**C2. The agent is stuck on a dead host.** `brainsLost` deletes the row, then its `onHostLost` call fails and the failure is only logged. `brain` still names the expired host. The kill can't be processed and `hostWedged` ignores an expired host, so nothing releases. A2 releases when FleetDO reports the host lost, and retries `onHostLost` until acked.

**C3. A host that comes back runs a start issued before its loss.** Start{1} is queued to h1. h1 misses heartbeats, lapses and is expired. A2's `onHostLost` is in flight. h1 says hello, FleetDO resends the unacked start, and brain 1 runs and gets a binding: AgentDO still holds {h1, 1}. The late `onHostLost` then releases {h1, 1}, and brain 2 starts on h2. The epoch check doesn't help (1 = 1). A3: nestd refuses starts it holds or receives across a lapse; FleetDO fails undelivered starts at expiry and refuses starts for an expired host.

**C4. A refused start's exit releases while an older brain lives.** Brain 1 begins an idle exit. A same-host restart issues start{2}, which reaches nestd just after h1's lease deadline. A3 refuses it and reports exit{2} at once. AgentDO releases {h1, 2} and starts brain 3 on h2 while brain 1 still holds its binding. This is the implementer's hole (a tombstone refusal while N is dying), reached through another refusal. So A4 has to cover every refused start: tombstone, A3 and no-lease refusals.

**D1.** Same shape: a38d3c0 also fails the refused start's command (`Err(stale_epoch)`, host.rs:1941), and `startFailed` releases before the owed exit.

**C5. The `onHostLost` ack deletes a newer row, and a drained host reads as dead.** h1 is expired with `onHostLost(h1, 1)` in flight. h1 returns, and reconcile releases {h1, 1}. Brain 2 starts on h1 and upserts row (agent, h1) = 2. h1 is drained. The old `onHostLost` lands: AgentDO ignores it (1 < 2), but its ack deletes the (agent, h1) row. With no row, the drained-host check passes, scaleDown marks h1 dead, and A2 releases on "dead". Brain 3 starts on h2 beside brain 2. A5: delete only at the acked epoch. A6: "lost" is expiry or confirmed death, never a drain.

**N1. The tick expires a host from a stale snapshot.** h1 is silent with start{1} queued. The tick reads h1 as silent and awaits another host's work. h1 heartbeats, its lease is renewed, and start{1} runs; brain 1 says hello and gets a binding. The tick then commits "expired". `onHostLost` releases {h1, 1}, and brain 2 starts on h2 while brain 1 runs with a valid lease. No fault is needed. The re-check at commit removes it.

**Also seen:** OneLiveBrain doesn't hold in any design, and isn't meant to: an expired host that returns may run a queued start (before A3), and the result is a zombie that can't act. nestd drops a no-lease refusal's exit as stale (runner_link.rs 414), which the 65bf6ef model keeps.

## Mutations (teeth)

| Mutation | Result |
|---|---|
| No condemn-and-wait (`MC_mut_nowait`) | violates S (16 steps) |
| F = E (`MC_mut_FE`) | violates S (23 steps) |
| No nestd tombstone (`MC_tip_notomb`) | violates `KillTombstone` (12 steps) |
| Each H-fix, A1-A4 and the N1 re-check off | violates its property (table above) |

## Conformance items added

From [../conformance/](../conformance/README.md#what-the-model-should-add): item 1 (`START_FAIL`, D1) is added and reproduced; item 2 (`LostDeliver` racing `HostHello` plus a resent start, and a cmd- or epoch-keyed delete) is added as C3 and A5; N1 is added as `SPLIT_EXPIRE`. Items 3-6 (reconcile failure and epoch-less redelivery, a reset dropping deadlines armed after an await, a runner that also skips its watchdog, mixed versions) are not modelled.

## What the model cannot catch

Code that diverges from these actions (the model encodes the design and a reading of the code, not the code); the gateway admitting calls after the process holding them dies (assumed cut on close, unverified); clock skew between host and FleetDO (one global clock); more than 2 hosts, 3 epochs or one queued turn.

## Effort

About 990 spec lines, 37 configs, about 10 hours. The design moved five times during the pilot: 65bf6ef, the record design, A1-A3, A4 and D1, then A5, A6 and the as-built choices. About 15 TLC iterations went to fixing model artifacts: a terminated host counted as healthy, delayed acks exploding the state space, a silently dropped start, and a dying process missing from the timer guard. State space was the main cost: the all-faults configurations at epochs ≤ 3 don't finish, so faults are split by kind.

## Next steps

1. Model the design change (no same-host re-issue: at most one start per (agent, host)), then re-run the exhaustive table and N1.
2. Finish the epochs ≤ 3 sweep (drain, partition, idle exit, ignored kill, lost RPC) and liveness L on the amended design.
3. Add conformance items 3-6 and epoch-less exits.
