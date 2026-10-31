# Conformance: the brain-record code against the model

> **Scope and freshness (2026-10-29):** the passes below follow `origin/deferred/brain-record` from a38d3c0 to 36b60d5 (merged as #30). Two later sections cover main@b2b9219 (`answered_by`, #32; the one low item it found was fixed in #33) and the brain-hosts delta at fe7b0d0 (merged as #36 from a later head; the check covered fe7b0d0 only). Code merged after those heads has not been checked, including #36's final head and #39's FleetDO send chain (which makes kills strictly FIFO, as the model assumes). By reading `main` at b63c0a3: the merged #36 fixes G2 (`placeBrain` clears the pick's `idle_since`) and G3 (the cap is checked where the brain-index row is written); G1 is the brain-hosts rollout rule in [dev/deploy.md](../../../../dev/deploy.md).

**Head checked:** `origin/deferred/brain-record` at **82396b3** (82396b304eaf8524a69999a4fdee8d11aecb9479, fetched 2026-10-26). **Design:** [the single-record design](../design/): invariant S, liveness L, rules 1-6, amendments A1-A6, plus the owner's as-built choices for 82396b3 (no same-host re-issue, one outstanding start per agent and host, no adopt, `brain_epochs` gating, the two-step wedge, the N1 re-check and orphan kill). **Model:** `verification/tla/agent-brain/AgentBrain.tla` as it stood on 2026-10-26 (`NO_REISSUE`, `SPLIT_EXPIRE`/`EXPIRE_RECHECK`, the `MC_nr_*` configs; another agent is still editing it). Background: [../README.md](../README.md), [../pilot/](../pilot/README.md).

**History.**

| Head | Result |
|---|---|
| a38d3c0 | First check: D1-D13 (D1-D5 high). A3 not implemented. |
| 4bc2c3f | A3: nestd `LapseGuard`, the runner's fence generation, FleetDO `failStarts`, no resend of an answered start, `issueCommands` refuses starts to expired or dead hosts. |
| 6073da7 | A4', A5, A6, D1-D13 fixes, adopt on a same-host re-issue. Second check: N1-N10 (N1 high: tick expiry from a stale snapshot). |
| b3f7f68 | N1-N10 round: per-host re-read in the tick, orphan kill, `brain_epochs`, LapseGuard under one lock, declined loss notices keep their row. |
| 82396b3 | No same-host re-issue, no adopt, `min_epoch` removed, NULL rows not indexed (M2), two-step wedge (M1), crash-loop count (L1). Third check: the body below (N11-N19). |
| fb9b836 | Merge gate: Gates 1-3 for previous-release hosts, N13-N19 fixes. Merge-gate check: [fb9b836 (merge gate)](#fb9b836-merge-gate) (N20-N24). |
| 36b60d5 | N21 (a): old hosts wedged at the cap, re-drained after STONITH by fence; brains-only drain before reconcile; `drain_told` retries; retirement guards; N20, N22-N24. Final check: [36b60d5 (final merge gate)](#36b60d5-final-merge-gate) (N25 new, medium). |

**Method.** I read the branch without checking it out (`git show`, `git diff 6073da7 82396b3`). Each model action, rule, amendment and as-built choice was mapped to code, and every changed AgentDO/FleetDO handler was read for awaits that skip a re-check, write groups a DO reset can split, and stale reads. I ran no tests and no TLC. Every scenario below comes from reading the code and is **unverified by execution**. Citations are `brain-record@82396b3:path:line`; in tables the prefix is left out: `agent.ts`/`fleet.ts` = `control-plane/src/do/`, `host.rs`/`runner_link.rs` = `crates/nestd/src/`, `ragent.rs`/`runtime.rs`/`supervisor.rs` = `crates/nest-runner/src/{agent,runtime,supervisor}.rs`, `seams` = `control-plane/test/agent-seams.test.ts`, `tla` = `AgentBrain.tla`.

## Table

| Model action / choice | Rule | Code at 82396b3 | Conforms | Detail |
|---|---|---|---|---|
| `SessOK`, `Hello` | 1 | agent.ts:426-429, 1308-1311, 1320-1327 | yes | Epoch-0 exception for a hands-less previous-release runner remains (428). **Removed on refactor/turn-state** (`isCurrent`: `epoch = brain.epoch` only), so `SessOK` now matches the model exactly |
| `ResolveReq`/`ResolveResp` | 1 | agent.ts:1216-1232 | yes | `current()` before and after the await; sandbox.ts unchanged since a38d3c0 |
| (platform calls, events) | 1 | agent.ts:920-924, 1901, 2014, 1590-1597 | yes | Unchanged |
| `RWake` | 2 | agent.ts:1031-1057, 2155-2166 | partly | As at 6073da7: a live brain without a session is condemned after 10 min |
| `RStart`, no brain | 2 | agent.ts:618-626, 644-680; fleet.ts:1273-1275 | yes | New: an old (`brain_epochs = 0`) target yields to a current host (674-677) |
| `RStart`, live brain (`NO_REISSUE`) | choice | agent.ts:600-616 | partly | `none` and the intent cleared, unless hint elsewhere, `avoid`, or `restart`. The model condemns when `~Healthy(ag.bh)` (tla:361, 374); the code waits for expiry or STONITH (N19) |
| `ROpRestart` | choice | agent.ts:504-517, 605-610; index.ts `POST /start {restart}` | partly | Condemn, keep the intent (seams:221). A concurrent plain start overwrites `reason` (N15) |
| condemn (move) | 2, N7 | agent.ts:605-610, 775-789 | yes | `unchanged()` and the condemn's write in one step; condemn names its epoch (779) |
| `Issue` / `IssueFail` | 2 | agent.ts:694-738 | yes | Record, intent and deadline in one step |
| `RKill`/`RKillFail`/`RKillAlarm` | A1 | agent.ts:775-813; fleet.ts:1409-1416 | yes | Dedupe by (host, agent, epoch) |
| `RDeadline` | assumed | agent.ts:2140-2154 | partly | Unchanged: fires whether or not the host is `Quiet` |
| `REscalate` | 4 | agent.ts:827-859; fleet.ts:1426-1437 | **no** | NULL rows release on a processed kill (N11); previous-release hosts never wedged and nothing ends the wait (N12); an await between the re-check and `hostWedged` (N13) |
| `RStatusRelease` | A2, A6 | agent.ts:592-595, 831-834, 866-869 | yes | `hostGone` = `lost` or no row |
| `RExited` | 3 | agent.ts:986-1003; fleet.ts:997-1009, 1154-1163 | partly | Epoch-less exit = the row's epoch; with no row, ignored (1160). Old nestd: a buffered exit can land on the next start's row (N4) |
| `RHostLost`, `LostSend/Deliver/Drop` | A2, A5 | agent.ts:1011-1022; fleet.ts:2045-2060 | yes | Declined notices keep the row (N6 fixed) |
| `StartResult` (code only) | D1 | fleet.ts:1246-1252; agent.ts:961-978 | yes | Condemns that epoch; row stays |
| `Deliver`/`Exec` kill | 6 | host.rs:862-869; runner_link.rs:279-316 | yes | Nothing at or below: nestd reports the exit itself (864) |
| `Deliver` (A3) | A3a | host.rs:347-385, 835, 876, 1159, 1404 | yes | One mutex over stamps and lapses (N5 fixed) |
| `RunnerStart` lease/tombstone | A3a, A4' | ragent.rs:77-126; runtime.rs:81-92 | yes | |
| `RunnerStart` running brain, `Register` | choice | ragent.rs:113-140 | yes | Ends the registered brain, registers after it; exit epoch fixed (runtime.rs:96-102). The model still adopts (tla:607-613): model lags (N18) |
| `ApplyKill`, `AccOut`, `OwedExit` | 6, A4 | runner_link.rs:279-338, 454-497 | yes | |
| (none) kill without exit drops the runner | M1 | runner_link.rs:295-310, 401, 426-445; host.rs:995-998 | not modelled | Every brain on the connection reported exited at once (N17) |
| `LeaseLapse` | 5, A3 | host.rs:1159; supervisor.rs:132-149 | yes | |
| `HostHello` | 5 | fleet.ts:753-829, 1025-1046; agent.ts:1065-1073 | partly | Renewal (793) before `expired → active, lost = 0` (814), which uses the pre-await `prior` (762) (N16). Orphan kill added |
| `ExpireRead`/`ExpireCommit` (`EXPIRE_RECHECK`) | 5, A3b | fleet.ts:1510-1520, 1991-2025 | yes | Re-read and write in one synchronous step (N1 fixed) |
| `ConfirmDead` | A6 | fleet.ts:2062-2074, 2109-2122, 1760 | yes | |
| `Drain`, `DrainRetire` | 5 | fleet.ts:1774-1796, 1704-1749 | yes | Retirement marks `dead`, never `lost`; the idle loop re-reads (1718) |
| wedge (`fWedged`) | 4, M1 | fleet.ts:1449-1457, 769-772, 1052, 1352, 1401, 1461, 1479 | yes | Socket closed, excluded from placement, STONITH only |
| `ResetAgentDO` | durability | agent.ts:612-615, 695-707, 777-787, 880-900 | yes | No new split in AgentDO |
| Version gating `brain_epochs` | choice | fleet.ts:785-786, 1467-1482; agent.ts:674-677, 849-853 | partly | Preference only: an old host is still used when no current one is free (N4, N12) |
| Release on `lost` ignores the epoch (`LOSS_EPOCH = FALSE`) | A3+A6 | agent.ts:592-595, 831-834 | yes | Sound while lost implies nothing runs; not on old nestd (N4). That was at 6073da7. On main@b2b9219, `onHostLost` is epoch-bounded and re-checks `lost` at delivery (agent.ts:1085-1087, tested at agent-seams.test.ts:918); the model's C6 shows both guards are needed |
| Tool calls keyed by call id | — | runtime.rs:526-531 | yes | 128-bit stems (N9 fixed) |

## Status of N1-N10 (and the D items left partly)

| Item | Status at 82396b3 | Where |
|---|---|---|
| N1 tick expiry from a stale snapshot | fixed | fleet.ts:1513-1520; expireSilent/expireHost write before their first await (2021, 1992-1995). Backstop agent.ts:1065-1073. seams:1371, 1397 |
| N2 adopt races the exit | fixed (moot) | No adopt: ragent.rs:127-138; runtime.rs:96-102 |
| N3 legacy exit strands a newer start | fixed for new nestd; partly for old | One start per (agent, host); epoch-less exit without a row ignored (fleet.ts:1160). New L gap on old hosts: N12 |
| N4 old nestd has no A3a | open (mixed window) | Only a placement preference (agent.ts:674-677). Plus a second trace below |
| N5 LapseGuard not atomic | fixed | host.rs:347-385 (unit test still sequential) |
| N6 declined loss notice deletes the row | fixed | agent.ts:1019; fleet.ts:2052-2055; seams:1456 |
| N7 condemn without an epoch | fixed | agent.ts:775-779; seams:1487 |
| N8 same-host re-issue unchecked | moot | No re-issue |
| N9 short call-id stems | fixed | runtime.rs:529 |
| N10 `lost` backfill | fixed | fleet.ts:976-981; seams:1496 |
| D5 wedged host released on its own watchdog | fixed | Wedged hosts reach `stonith_pending` only (fleet.ts:1518-1519, 2105) |
| D8 exits before an older brain has gone | fixed | runner_link.rs:331-338; ragent.rs:113-126 |

## New and remaining divergences, ranked

**Medium: mixed-version window only (a host still on the previous nestd, or rows it left)**

- **N11. M2 releases on a processed kill when the only row has no epoch (breaks S).** `brain-record@82396b3:control-plane/src/do/fleet.ts:1434` drops NULL rows from `indexed`, so `agent.ts:843-845` releases as soon as the kill has a result. Rule 4 releases only when no row is left, and the code's own comment says a NULL row "proves nothing either way; the host's next hello resolves it".
  - Interleaving: a brain started by the previous release (NULL row) runs on an old host H. A drain, a hinted start or a restart condemns it, and the kill goes out. Main's nestd treats every `agent_stop` as graceful (`main:crates/nestd/src/host.rs:1388-1389`) and answers at once. At kill + 60 s, escalation sees `processed && !indexed` and releases. The new brain starts on a current host while the old one finishes its turn. It is fenced on AgentDO, but it acts through its cached hands binding until that ages out (TTL unverified).
  - Fix: count NULL rows as indexed and accept the wait until the hello (or upgrade) resolves it, as the comment intends.
- **N4 (open). Old nestd keeps two S holes.**
  - (a) No A3a: as at 6073da7.
  - (b) New trace: a buffered epoch-less exit lands on the next start's row. `exitEpoch` (fleet.ts:997-1000) maps it to the row now there.
    - Interleaving: old host H (no live leases) is partitioned. Its lease lapses, and brain e dies with its exit buffered. FleetDO expires H and releases e. H reconnects; at 814 it is active, and AgentDO picks it (prev_host, no current controller free) and issues e+1.
    - The buffered exit then arrives (events wait behind the hello in the host queue) and is mapped to e+1. AgentDO releases the running e+1 and starts e+2 elsewhere. Nothing kills e+1 (brainGone deleted its row), so it acts through its hands binding until H's next hello.
    - Unverified: that main's nestd buffers and replays that exit.
  - Gate: no previous-release host may hold or receive brains, or deploy hosts first (unverified that main's control plane accepts the new nestd's fields).
- **N12. A condemned brain on a previous-release host can wait forever (breaks L).** `agent.ts:849-853` never wedges a host whose `brain_epochs` is 0; it logs and re-arms. "The host's next hello" never comes while the host stays connected. Reachable when the old nestd never reports an exit for that start, e.g. a start it answered with an error (rows stay on error, fleet.ts:1248-1252; which errors owe no exit is unverified). The same holds for a new nestd that has not said hello since the column was added (default 0). At 6073da7 this ended in a wedge at 15 min.

**Low**

- **N13. An await between escalation's re-check and the wedge (L: healthy host wedged).** The record is re-checked at `agent.ts:842`; then `hostStatus` is awaited (849) before `hostWedged` (856). If the kill is processed and the exit released the record during that RPC, a host that just proved it works is wedged, and every brain and sandbox on it restarts. Fix: return `current` from `killProgress`, or re-check after.
- **N14. A start during a graceful stop is dropped (L, operator-visible).** `stop()` keeps the record live (agent.ts:912-917). A start then answers `none` (612-616), and the brain exits `stopped`, which never restarts (`RESTART_ON_EXIT.stopped = false`, 58). Turns queued meanwhile wait for new input. The model restarts on any exit with work (`RRelease` sets `wake`, tla:193). Doc comments still describe re-issue (agent.ts:486-487, 573-577, 688-689, 909-911; fleet.ts:1155).
- **N15.** A `restart` intent merged with a concurrent plain start loses `reason: "restart"` (`setIntent`, agent.ts:532-538, newer wins). The run then answers `none` and the restart is gone.
- **N16. Hello writes split by awaits.** `fleet.ts:814` decides from `prior` (read at 762) and its `UPDATE` isn't guarded by `status = 'expired'`. An idle retirement (1729) or `confirmHostDead` (2113) during the hello's awaits is overwritten to `active, lost = 0`. A DO reset between the `hello_ack` (793, which renews the lease) and 814 leaves an expired, lost host with a renewed lease, and `onHeartbeat` keeps acking it (1053-1058). No S trace found: starts are refused there, and it holds no record.
- **N17. Wedge step 1 reports exits on nestd's word.** After 60 s without the exit, nestd drops the runner connection and reports every brain on it exited (`runner_link.rs:426-445`). AgentDO releases them all. A4's meaning ("nothing at or below e runs here") then rests on the runner's `kill_all` on disconnect (supervisor.rs:24), in exactly the case where its kill didn't take. It is safe if a brain can't act without its runner. That holds for sessions and hands RPC; unverified for a hung runner.
- **N18.** The runner's running-brain branch ends any registered brain without comparing epochs (ragent.rs:127-138), a same-epoch or newer one included. That is safe only because no stale or duplicate start reaches it (nestd caches results; FleetDO never resends an answered start). The model still adopts.
- **N19.** A start with no hint while the brain's host is unhealthy but not lost answers `none` (agent.ts:600-616). The model condemns and moves (tla:361, 374). This is L delay only: the turn waits for expiry (30 s) or STONITH.

**Checked and clean.** No orphan kill can hit the current brain. `hostReport` reads `agent_epoch` and the record in one synchronous step (agent.ts:1067-1072), and `issueStart` bumps the epoch and writes the record before its send (695-700). So a racing kill is always below any later start's epoch, and its synthesized exit (host.rs:864) releases nothing newer (rule 3). A hello reporting a dying brain on the record's own host is left to the runner's end-then-register. Other paths checked:
- `lost` cleared on hello vs. in-flight releases: every release passes its pre-await epoch, and `release` refuses a newer record (881).
- The `none` path's durability (612-615).
- `onHostLost`'s boolean.
- The idle loop's re-read.

## Transitions the code has and the model lacks

| Transition | Code | Risk |
|---|---|---|
| NULL rows not indexed (release on kill result) | fleet.ts:1434 | S, mixed window (N11) |
| Previous-release hosts never wedged | agent.ts:849-853 | L, mixed window (N12) |
| Epoch-less exit mapped to the row present now | fleet.ts:997-1000, 1158-1161 | S on old nestd (N4b) |
| Orphan kill at `agent_epoch` on a hello | agent.ts:1065-1073 | none found |
| nestd drops the runner connection 60 s after a kill | runner_link.rs:295-310 | N17 |
| Runner ends any registered brain, then registers | ragent.rs:127-138 | model adopts instead (N18) |
| `none` without a health check of the brain host | agent.ts:600-616 | L delay (N19) |
| Stopped exit never restarts | agent.ts:58, 897, 904 | L (N14) |
| Hello: renewal and `lost` clear split by awaits | fleet.ts:785-814 | N16 |
| `stonith_pending`, `lost` as a flag, `gone` rows | as at 6073da7 | none new |

## Untested load-bearing lines

By my reading, breaking these fails no test on the branch (unverified; I ran nothing).

- agent.ts:1019 `return false`. seams:917 checks only the record, and seams:1456 stubs AgentDO. Returning `true` deletes the row (N6 reopens).
- agent.ts:842-856: no test puts an exit inside escalation's `hostStatus` await (N13).
- agent.ts:1070-1072 with the record null (only the moved-record case is tested, seams:1397), and the orphan kill racing a start.
- fleet.ts:1718-1720: the idle loop's re-read. No hello is interleaved there.
- fleet.ts:1454: the close in `hostWedged`. seams:432 sees a 4408, which the expiry also sends.
- fleet.ts:1401, 1461: `wedged_ms IS NULL` in `otherHost`/`controllerHost`. Only `place` is tested (seams:1556).
- fleet.ts:814 guard: no retirement or confirm during a hello.
- runner_link.rs:304 `conn_gen` check: a stale timer after a reconnect.
- host.rs:358-385 under concurrency (the test is sequential; a mutex makes this low).

These are tested: agent.ts:605, 612-615, 674-677, 779, 849, 884; fleet.ts:814, 1160, 1434, 1513-1514, 2055; runner_link.rs:298-310; ragent.rs:127-138; runtime.rs:529.

## Verdict

**For S and L with every host on this nestd: yes, with low items** (N13, N14, N15, N16, N17, N18, N19). N1-N3 and N5-N10 are closed, and no orphan-kill or `none` path breaks S. **For a rollout with any previous-release host holding or receiving brains: no.** N11 (new, from M2) and N4 break S, and N12 breaks L. Blocking unless one of these holds:
- (a) M2 is reverted to count NULL rows until the hello or upgrade.
- (b) The deploy is gated so no previous-release nestd holds or receives brains.

## What the model should add

1. Per-host version (`brain_epochs`): no wedge, epoch-less exits mapped to the current row, and kill = graceful on old hosts. Expect `OneActingBrain` (N11, N4b) and `NoWedge` (N12).
2. Replace `RunnerStart`'s adopt branch (tla:607-613) with end-then-register, as built.
3. `REscalate` with its `hostStatus` read split from `hostWedged` (N13, `NoHealthyWedge`).
4. A stopped exit that doesn't wake (N14), and `RStart` answering `none` without a health check (N19).
5. The orphan kill on `HostHello` and nestd's runner drop with exits for every brain (N17).

## fb9b836 (merge gate)

**Head:** fb9b83666e349951dd546c724aa4cdd7bca74fec, one commit on 82396b3 (fetched 2026-10-26). I read only `git diff 82396b3 fb9b836` and ran nothing. Citations are `brain-record@fb9b836:path:line`, with the prefix and file abbreviations as above; `main:` marks the previous release.

| Item | Status | Where |
|---|---|---|
| N11 | closed | On an old host, escalation waits for the host's loss before `killProgress` (agent.ts:858-864). A NULL row on a host that later says `brain_epochs` is still not indexed (fleet.ts:1438). Its brain died with the nestd restart that upgraded the host: main's runner kills every brain when nestd goes (`main:crates/nest-runner/src/runtime.rs:115`) |
| N4a | closed, except a downgrade race (N23) | No start goes to an old host: agent.ts:513, 660-663, 688-692 |
| N4b | closed | An exit on an old host never releases: agent.ts:1011-1014 |
| N12 | partly | The wait ends only with the old host's loss: retired (fleet.ts:1745-1754) and then terminated per EC2 (1765), expired, or confirmed by an operator. Unbounded otherwise (N21) |
| N13 | closed | Re-checked after `hostStatus` (agent.ts:854-857) and `killProgress` (869); no await between 869 and `hostWedged` (878) |
| N14 | closed, side effect N20 | agent.ts:623-628 |
| N15 | closed | agent.ts:539 |
| N16 | partly | The guard is fixed (fleet.ts:814). A DO reset between `hello_ack` (793) and 814 still leaves an expired, lost host with a renewed lease. No S trace, as before |
| N17 | accepted (documented) | runner_link.rs:297-301. Behaviour unchanged; unverified for a hung runner |
| N18 | closed | ragent.rs:127. The equal-epoch case is still latent (N22) |
| N19 | closed, side effect N24 | agent.ts:613-616 |

**The gates.**
- **Gate 1 holds.** Every hello rewrites `brain_epochs` in its first synchronous step (fleet.ts:785-786), before any event from that process. A new process of another version, a rollback included, therefore resets it. Before its first hello a host keeps its last value, or 0 if it hasn't said hello since b3f7f68 (fleet.ts:226). Every placement path ends in a `current` check (agent.ts:513, 662, 690-691). Neither the commit nor FleetDO checks it again (N23).
- **Gate 2 is safe for S, not sufficient for L.**
  - Release needs `lost` (agent.ts:888-891). A retired host is only `dead`, and becomes `lost` once EC2 reports the instance terminated (fleet.ts:1765). So a brain still alive there, indexed or not, dies before any release.
  - Sandboxes leave by the forced-drain path (`sandbox_suspend` disk_only, fleet.ts:1783-1788), and retirement waits until no lease is left (1747).
  - Like the spot path, retirement checks neither pending uploads nor unsalvaged stale incarnations: the documented all-or-nothing gate is not in this loop. That gap predates this commit for burst drains; the commit extends it to every role.
- **Gate 3 has no bound of its own.** A brain on an old host ends only with the host's loss. That takes one of three things:
  - The host empties (every exit comes; main's kill is a graceful stop with no timeout, `main:crates/nest-runner/src/agent.rs:572-575`), and it has an `instance_id` and EC2 access.
  - It goes silent.
  - An operator confirms it dead.
- **Hello and the orphan kill.**
  - `reconcileAgents` (fleet.ts:825) runs before the drain (829). AgentDO ignores an old host's gone exits (agent.ts:1014), and FleetDO then deletes the rows (fleet.ts:1021), so the drain misses those agents. Their records wait for the no-session condemn (10 min), then the loss: L delay only.
  - The orphan kill (agent.ts:1091-1098) reaches an old host as a graceful stop. No S issue: AgentDO already fences that brain.

**New findings.**
- **N21 (L, mixed window, medium).** Gate 3 never ends when the old host never becomes lost:
  - (a) It was enrolled by token, so it has no `instance_id` and is never retired (fleet.ts:1746), or its cell has no EC2, so `lost` is never set (1756-1765).
  - (b) Its hello came while `stonith_pending`. `drain` writes nothing and returns (fleet.ts:1780-1781), and `stonithDoneIfClear` later makes the host `active` (2111), undrained until its next hello.
  - (c) A condemned brain whose graceful stop never ends keeps its row, so the host never empties.
  - Also, a drained host never returns to `active`, even after an in-place upgrade. With an `instance_id` it is retired anyway.
  - Fix: wedge an old host at `ESCALATION_CAP_MS`, as a current one. That is now safe: no start reaches an old host, so its lease lapse (main kills every brain on lapse, `main:crates/nestd/src/host.rs:1085`) and the expiry prove its brains gone. Also drain an old host when STONITH clears it.
- **N20 (low).** An operator's plain start on a healthy live brain leaves a dormant intent (agent.ts:623-628) that nothing clears; `stop()` doesn't (934-939). The next release runs it (918), so a later stop or an idle exit is followed by a fresh start.
- **N22 (low, latent).** The runner refuses an equal-epoch start and at once reports an exit at that epoch (ragent.rs:127-133). The registered brain of that epoch still runs, but nestd and AgentDO take the exit to mean nothing at or below it does. It is unreachable while each start reaches the runner once: a new nestd process gets no unacked resend (`control-plane/src/lib/reliable.ts:68-72`), and nestd dedups by seq. A strict `>`, or waiting for `older_gone`, is safe.
- **N23 (low, downgrade only).** Awaits separate `pickHost`'s `current` check (agent.ts:690) from the send (740), and `issueCommands` doesn't refuse an `agent_start` to a `brain_epochs = 0` host (fleet.ts:1277). A nestd rolled back in that gap gets the start, and the drain at its hello may not condemn it. That reopens N4a only if a lease lapse during a partition follows. Fix: refuse the start in FleetDO.
- **N24 (low).** N19 condemns a live brain on an operator's plain start whenever the host's socket is briefly gone (agent.ts:614-616), e.g. across a nestd or Worker restart: a restart nobody asked for.
- **Pre-existing, now on more paths.** A reset between drain's status write (fleet.ts:1780) and the `onHostDraining` calls (1793-1799: `waitUntil`, not retried) leaves those brains uncondemned, and no later hello redoes it (1780-1781).

**Untested load-bearing lines** (by reading):
- fleet.ts:1780-1781 (no drain unless `active`), and the 825-before-829 order.
- agent.ts:623 followed by a `stop` (N20). The N14 run after a `stopped` exit (seams:227 checks only that the intent stays).
- ragent.rs:127 with equal epochs (lifecycle tests only an older start).
- Retire → EC2 → release end to end for an old host (the gate-3 test calls `confirmHostDead` directly).

**Verdict at fb9b836.**
- **S: yes**, for an all-new fleet and in the mixed window (residual: N23, downgrade only).
- **L: yes with low items for an all-new fleet; no in the mixed window** without an operator, since N21 can strand an agent until someone confirms its old host dead or upgrades it.
- Blocking for L only. It is cleared by any of:
  - upgrading every host before the Worker deploy (unverified that main's control plane accepts the new hello);
  - the N21 wedge-at-cap fix;
  - a runbook step that runs `confirmHostDead` for every old host left draining.

## 36b60d5 (final merge gate)

**Head:** 36b60d517ab64ab65f72538c50cb19536dbb5a63, one commit on fb9b836 (fetched 2026-10-26). I read only `git diff fb9b836 36b60d5`, plus main's nestd and runner, and ran nothing. Citations are `brain-record@36b60d5:path:line`, abbreviated as above.

| Item | Status | Where |
|---|---|---|
| N21 | closed where EC2 can terminate the host; elsewhere an operator's confirm-dead, as for any wedge | Cap wedge agent.ts:860-871; hello order fleet.ts:829-830; re-drain after STONITH by fence fleet.ts:2154-2158; no-EC2 fleet.ts:2058-2059, 1767-1774 |
| N16 | partly, unchanged | fleet.ts:793 (`hello_ack` renews), 814 |
| N17 | documented only, unchanged | runner_link.rs:297-301 |
| N20 | partly | An idle or crash end drops the intent (agent.ts:915-919). A kept plain start still runs after any later graceful stop, however late |
| N22 | closed | ragent.rs:127-131. Residual: a same-epoch start that finds that epoch's brain of an earlier connection reports nothing; unreachable (nestd never replays a start) |
| N23 | closed | fleet.ts:1281-1286; a rolled-back process gets no resend (`rel.reset`, 784) |
| N24 | closed | agent.ts:615-616 |
| Hello-order delay | closed | `tellDraining` reads its rows synchronously (1836) before `reconcileAgents` (830). After a reset, a reconnect before the tick can delete untold gone rows: the 10-min no-session path, low |
| Drain notice lost on reset | closed | `drain_told` (995), retried by the tick (1549-1552), which stays armed while a host drains (1558) |
| Retirement guards | done | fleet.ts:1764-1766. The stale check matches `reapStale`'s (930, `cmd IS NULL`) by host |
| Drained host never active again | open, low | An in-place upgrade stays `draining`; a token-enrolled one only gets logged (1770-1773) |

**Checks.**
- **The wedge is S-safe.** It is the same sequence for an old host as for a current one: `hostWedged` accepts `draining` (1462); the socket is closed (1465); hellos are refused (769-772) and heartbeats too (1059); placement is excluded (status, and `wedged_ms IS NULL`). Its expiry always goes through STONITH (1532-1533, 2040-2060), so its brains are released only on a confirmed death. Main kills every brain on lapse twice: nestd's `self_fence` (`main:crates/nestd/src/host.rs:1085-1094`, verified) and the runner's own watchdog (`main:crates/nest-runner/src/supervisor.rs:122-138`).
- **The re-drain is clean.** The `active` write (2154) and `drainBrains`'s guarded `draining` write (1828) happen in one synchronous step, since an async function runs to its first await. Hellos are serialized per host (668).
- **`drain_told` is idempotent.** `onHostDraining` returns for a condemned brain or one elsewhere (agent.ts:977-981), and `setIntent` merges. The flag lives on the index row, so it goes when the row goes (`brainGone` 1010-1016, `brainsLost` 2104). Latent: the start upsert (1298-1300) doesn't reset it, and the update after the await (1840) is keyed by (agent, host), not `cmd`.
- **Awaits.**
  - Re-checked after: agent.ts:620 (`unchanged`) and 859, with no await between 859 and 867.
  - Guarded in SQL: fleet.ts:1828.
  - The retirement loop has no await.
  - Write order under a reset: `setIntent` writes before it arms (agent.ts:536-544). A reset there fails the call, so `drain_told` stays 0 and the tick retries.

**New finding.**
- **N25 (medium, mixed window: L, availability; not S). Every old host that holds a lease and had a brain is wedged and STONITHed at the cap.** The cause is three facts together:
  - An old host's exits never release a brain (agent.ts:1027), but they do delete its row (fleet.ts:1168-1169).
  - The drain no longer moves sandboxes (1827-1832), and only a spot notice calls `drain` (1160).
  - A host with any lease never retires (1764).

  So the condemned record waits until `kill.ms + 15 min` and then wedges the host (agent.ts:866-867), even when its brain exited cleanly in seconds. This is the previous release's usual placement (a worker beside its sandbox, as in seams `setup()`). Consequences:
  - Every sandbox there is placed again from its head (what wasn't committed is lost; whether main's salvage finishes in the ~10 s between the host's lapse and TerminateInstances is unverified).
  - Without EC2 or an instance, those sandboxes and agents wait for an operator.
  - It breaks L's "no healthy host wedges", by construction.
  - The doc's "sandboxes ... leave as they otherwise would" (`docs/control-plane/durable-objects/fleet/README.md:11`) is wrong.

  Fix, any one of:
  - Suspend an old host's sandboxes at its drain (fb9b836's full drain, now with the stale guard), so it retires before the cap.
  - At the cap, suspend its sandboxes before wedging.
  - Upgrade sandbox hosts before the Worker deploy.

**Untested load-bearing lines** (by reading):
- agent.ts:917 `phase !== "condemned"` and `!host_hint && !avoid` (the N20 test covers only `idle` and `stopped`).
- agent.ts:616 `!st.lost`, `!st.wedged` (the test sets only `draining`).
- fleet.ts:1828 `AND status = 'active'`, and an old host's hello while `stonith_pending` end to end (the test calls `stonithDoneIfClear` directly).
- fleet.ts:1298-1300 (`drain_told` on upsert).
- An old host's wedge past `wedged_ms`, with leases (N25).

Spot-checked claims that hold: reverting N24 fails the N19/N24 test, and dropping the stale guard fails the retirement test. The commit's "every mutation fails a test" doesn't hold for the agent.ts:917 sub-conditions.

**Verdict at 36b60d5.**
- **S: yes**, for an all-new fleet and in the mixed window.
- **L, all-new fleet: yes with low items:** N16, N17, N20 residual, the latent `drain_told` keying, and wedges needing an operator without EC2, as before.
- **L, mixed window: no, by N25:** agents end (with EC2), but healthy old sandbox hosts are wedged and STONITHed by design. N25 blocks a Worker deploy that precedes host upgrades. It doesn't block S. Cleared by any N25 fix above, or by the owner accepting the forced STONITH with a runbook.

## main b2b9219 (#32): `commands.answered_by`

The rule A6 assumes: a kill counts as processed only when the host answered it, so the brains of a host that is dead but not yet lost wait for `lost`. Checked on `main` at b2b9219 by reading the code (no runs). Citations are `main@b2b9219:control-plane/src/do/fleet.ts:line`.

| Path | Writes `answered_by = 'fleet'`? | Effect on `killProgress` (1557-1573) |
|---|---|---|
| A command issued to a dead or unknown host, answered at insert (1395-1407) | yes | Not processed. The brain waits for `lost` (conforms) |
| `hostDied` closing a dead host's open commands (2333-2341) | yes | Not processed (conforms) |
| `failPendingCommands` on a new nestd process (1309-1319, through `onCommandResult`) | no | A pending kill counts as processed. This is safe because the release also needs no indexed row, and the new process's hello reconciles its brains first (a reported brain keeps its row) |
| `failStarts` on expiry (2296-2299) | no | No kill is involved, but these answers count as `host_processing` evidence (1565), so a wedge for a host that processes nothing waits for the cap instead of 60 s. This delays L only (low) |
| `dropUnreported` (947) | no | Sandbox commands only. No kill |

**Verdict:** conforms for S. One low L delay (`failStarts` should set `answered_by = 'fleet'`), fixed on main in #33 (fe892c1). The model already treats FleetDO-written answers as not processed. The pilot's report says whether the model encodes this explicitly.

## brain-hosts fe7b0d0 (stream G merge gate)

**Head:** `origin/deferred/brain-hosts` at fe7b0d0d37c6cf726de703cd7fcea47a96a1fd64 (fetched 2026-10-29; main at f10eb75). I read `git diff origin/main...fe7b0d0` for agent.ts, fleet.ts, `lib/placement.ts`, `lib/cells.ts`, `protocol/model.ts` and nestd's `host_kind_refusal`, and ran nothing: every claim is **unverified by execution**. The agent.ts diff touches only `brainHostUsable`, `start()`'s hint check and `pickHost`; condemn, release, escalation, the wedge and the epoch code are byte-identical to main. Citations are `brain-hosts@fe7b0d0:path:line`, abbreviated as above; `placement.ts`/`cells.ts` = `control-plane/src/lib/`.

| Model action / invariant | Code at fe7b0d0 | Conforms | Detail |
|---|---|---|---|
| `RStart(h)`: `Healthy(h) /\ h # avoid` (tla:384) | agent.ts:714-722; fleet.ts:1628-1640; placement.ts:28-36 | yes | Code's set is a subset of the model's: active, connected, `brain_epochs = 1`, not wedged, role `brain`, never `avoid`, below `max_brains`. `prev` is a preference among those (not in the model; S-neutral) |
| `RStart`, live brain never moved by a hint (tla:385) | agent.ts:652-678 | yes, unchanged | `pickHost` runs only with no brain; a hint elsewhere condemns first and starts after release |
| Hint validity | agent.ts:260-263, 555-561, 715-717 | yes | `brainHostUsable` adds `role === "brain"` to main's check; wedged excluded via the closed socket, as on main |
| Gate 1 (`brain_epochs`) | agent.ts:262; fleet.ts:1632 | yes | Both paths require it. Legacy `controller` rows become `brain` (fleet.ts:303-305; model.ts alias) but keep `brain_epochs = 0` until a current hello |
| A3(c) and N23 at the send | fleet.ts:1397-1406 | yes | Expired/dead/unknown and `brain_epochs = 0` refusals intact; the role refusal is added after them, retryable |
| `Issue`, record commit after awaits | agent.ts:679-687, 749-760 | yes | `unchanged(snap)` at 686 follows every new await (`placeBrain`, sandbox `wake`); commit is one synchronous step |
| `IssueFail` | agent.ts:780-791 | yes, unchanged | A refused send condemns the committed epoch, intent kept |
| Drain moves (tla:937) | agent.ts:1022-1032 | yes, unchanged | Then `placeBrain(avoid)`; a draining host is not `active`, so excluded twice |
| No capacity | agent.ts:721, 801-806, 2275-2281 | yes (L conditional) | Retryable: intent kept, retried every 30 s (fixed interval, no cap); no record, so no `starting` deadline, no `start_attempts`, no `exit_restarts` |
| S, CondemnedFenced, KillTombstone, NoEpochRegression | (unchanged code) | unchanged | Placement only narrows targets; one agent's starts stay single-flight via the record |
| NoHealthyWedge | fleet.ts:1949-1971 | unchanged | Brain-host idle retirement marks `dead`, never wedged or `lost`; `busy` counts indexed brains (1959) |

**Findings, ranked.**
- **G1 (medium, rollout, L).** `brain` in `AWS_CELLS` is optional (cells.ts:58) and a cell without it launches nothing (fleet.ts:1880-1883, 1891-1895). After the Worker deploy, any agent whose brain exits in such a cell, with no current-release brain host, retries every 30 s forever; turns stay queued. By design and tested (`brain-hosts.test.ts:320`). Deploy order: brain section (or a brain host) per cell before the Worker. Brains already on sandbox hosts keep running until they exit (the live-brain health check, agent.ts:661-662, ignores role).
- **G2 (low, L delay).** Idle retirement can race a pick. `placeBrain` reserves nothing and leaves `idle_since` set. If FleetDO's tick retires the picked host (idle past `brain.idle_grace_ms`, no row yet) during AgentDO's awaits before the send, `issueCommands` refuses (dead), the committed epoch is condemned, and the record waits for EC2 to confirm the termination (`lost`). No S effect. Fix: clear `idle_since` in `placeBrain`, or pass the pick through as a short reservation.
- **G3 (low, accepted).** Soft cap: different agents racing may over-commit one host's last slot. One agent cannot (single-flight `runIntent`, `unchanged(snap)`). Over-commit only.
- **G4 (low, outside the model).** The `avoid` path now wakes the agent's sandbox (agent.ts:726-733); main deliberately did not. Sandbox-system effect only; unverified.
- Removed `controllerHost`, `otherHost`, `currentHost`: their only callers were `pickHost` (main agent.ts:722, 729, 737). No Discord singleton DO exists. A hands-less agent now uses `placeBrain` like any other. No safety check lost.

**Verdict at fe7b0d0.** S and the other safety invariants: **unchanged**. No modelled transition changes beyond a narrower target set. Liveness: **holds once a brain host can exist in the cell**. G1 blocks a Worker deploy to any cell without a `brain` section or a hand-added brain host. It blocks the merge only if the merge deploys. G2-G4 are low.

## channels (feat/channels, author's map, 2026-10-30)

**Head:** `feat/channels` after the review of 4dd3fb1 (ChannelDO). The author's map of each AgentDO change onto the model; the review of 4dd3fb1 checked the first version of these rows (all held for safety; it found the alarm-ordering delay fixed below). No modelled transition is added or changed: channel deliveries enter as model action Q1 (enqueue), exactly as an API turn or an inbox post does.

| Change | Code | Conforms (author) | Detail |
|---|---|---|---|
| Delivery admitted as a turn | agent.ts:2067-2134 | yes (Q1) | `enqueueTurn` (request id `chan/<channel>/<sub>/<up_to>`) → pump → wake; or a notice merged into a channel turn still `queued` (its input text only: no status, `ord` or `current_turn` change), **followed by `wake()`** (agent.ts:2128), so the merge has Q1's full effect, including Q6's fresh try for an `errored` agent (it was missing at 58635e3); or, past the merge cap, `defer` (nothing written); or `postInbox` mid-turn for a notice from the agent's own inbox only (the inbox, not modelled; it touches no modelled variable); mid-turn, another channel's notice takes the queued-turn path above. Reads `current_turn` only; writes `channel_subs`, `turns`/`inbox`. No brain record, intent or session write |
| `release` reports the exit | agent.ts:1027 | yes (A5/A6 unchanged) | After the record's commit, synchronous: one `chan_out` row and its deadline row. No await added before `armed`, no guard read or changed |
| `applyEvent` reports events | agent.ts:1791 | yes (Q3 unchanged) | Synchronous after the state update; `kv.last_text` and `chan_out` rows only. The per-event `current()` re-check (rule 1) is untouched |
| Turn completion requeues unseen notices | agent.ts:1779, 2049-2060 | yes (Q3 + Q1) | Inside Q3's synchronous completion step: channel notices pushed mid-turn whose `inbox_delivered` never came are inserted as one `queued` turn (Q1's effect), then `pump` runs as before. Nothing else in Q3 changes |
| Inline text taints the session | agent.ts:1833, 1898 | n/a | `kv.read_tainted` only |
| Channel tools | agent.ts:2446 | yes (rule 1) | Every write calls `live()` (the epoch fence) after its last await; mutation M15 removes it from `post` and the fence test fails |
| `chan_out` deadline | agent.ts:2658, 2675; reliable.ts:165; outbox.ts | **timing: bounded** | Posts to ChannelDO from the alarm; ChannelDO never calls back into AgentDO. `runDue` runs it after every other due key (so `intent`, `wake_after_exit`, `condemned`, `starting`, `no_session` due in the same alarm go first), and a run is bounded: at most 20 rows, no new post after 5 s, each row's owner lookup and post cut off together at 5 s. So it can delay a brain deadline falling due *during* a flush by about 10 s at most (the next alarm), where the review found it could precede every one of them by up to 50 unbounded calls |
| `load()` default | agent.ts:383 | n/a | `channel_grants ?? []`; brain fields untouched |

**Depends on the runner's Stop-hook inbox mirror:** a mid-turn notice whose `inbox` push is lost with a runner lineage (`rel.reset`) still stays `delivered` in AgentDO's inbox and reaches the model through the Stop hook's mirror (`runtime.rs`, the cache's `inbox`) in the recovery turn. A notice the runner refused to write (stopping) and never confirmed is requeued at the turn's completion (row above). A runner that wrote it to the model but whose `inbox_delivered` was lost gets it again as a turn (at least once).

## stop ends the intent (fix/discrepancies, author's map, 2026-10-30)

**Head:** `fix/discrepancies` (on main 653be20). The model's record design has no operator stop (`TOpStop` is main's, `~RECORD`; tla:351), and its intent waits for a healthy host without a capacity notion, so **"stop while waiting for a brain host" is not modelled.** The change only removes starts, so it can't add a brain. Unverified by a model run.

| Change | Code | Conforms (author) | Detail |
|---|---|---|---|
| `stop` clears any intent | agent.ts `stop` | yes (S-neutral) | Intent, `capacity_waits`, `stop_epoch := agent_epoch`, and the `intent`, `wake` and `wake_after_exit` alarms in one synchronous step, before any await. A run in flight re-reads at `unchanged(snap)` before `issueStart`'s commit and finds the intent changed, so it commits nothing. Was: dropped only an operator's non-move intent beside a live brain (N20), so a start waiting for capacity, or a move or restart behind a condemned brain, outlived the stop |
| `intentFailed` with no intent, or a newer one | agent.ts `intentFailed` | yes | Returns before keeping, backing off or marking `errored`: a failure of a run whose intent a stop ended arms nothing (and drops a capacity wait it recorded at FleetDO); one whose intent a newer start replaced leaves it to that start's run (`intentDirty`) |
| Committed start after a stop | agent.ts `issueStart` catch, `startFailed` | yes (S-neutral) | A start at or below `stop_epoch` whose send fails or which its host refuses is condemned (kill and escalation unchanged) without an intent (the first review's finding 1: the send-failure path restored the old intent) |
| A stopped brain's end (`stoppedBrain`) | agent.ts `release`, `onExited` (no epoch), `onHostDraining`, the `starting` and `no_session` deadlines (since refactor/turn-state: their rules in lib/brain.ts `brainRelease`, `epochlessExit`, `unresponsive`, `startFailure`) | yes (S-neutral) | A brain at or below `stop_epoch` ends as `stopped`: `release` arms no `wake`/`wake_after_exit` and wakes nothing inline, and counts no crash (an intent written after the stop still runs: N20 keeps an operator's start for a `stopped` end); a drain condemns it with no `drain` intent; an epoch-less exit and both deadlines condemn without counting, `errored` or `wake`. The second review's H1: a condemned stopped brain's `fenced` exit (or `host_lost`) went through `RESTART_ON_EXIT` and `wake()` started a new epoch, and a drain after the stop wrote a move intent |
| Work before vs. input after the stop (`stop_quiet`) | agent.ts `stop`, `wake` (lib/brain.ts `wakeDecision`, `quietSinceStop`), `inputArrived` (`enqueueTurn`, `postInbox` unless from `system`, the delivery merge), `release` | yes (S-neutral) | Set in the stop's update; cleared by input from outside the agent (the third review's M1: the platform's `system` notes, a move note or a background task's exit, cleared it and restarted pre-stop work, F1 and F2); quiet only while `stop_epoch >= agent_epoch`, so a start since the stop, including a previous release's that kept the flag, ends it. `wake()` returns while it is set, so no release, sandbox move or wake alarm starts a brain for work from before the stop (the second review's M1: a move notice from the cancelled start's placement restarted the agent). A stopped brain's release wakes once it is cleared (M2: input after the stop was stranded behind a graceful `stopped` exit, E1, or a drain's `fenced` one, E2). The delivery merge's clear has no test |
| FleetDO `brainWaitEnded` | fleet.ts `brainWaitEnded`; agent.ts `stop`, `intentFailed` | outside the model | Drops the agent's `brain_waiters` row, whatever its time (no comparison across two DOs' clocks), so the tick launches no brain host for it; best effort, the 12-minute TTL backs it. A `placeBrain` already in flight may still launch one itself (`scaleUp` inline); an unused brain host retires after its idle grace |
| Guards kept | `unchanged(snap)`, `release`'s N20 rule, `condemn`'s kill-with-alarm | unchanged | The condemned brain is still killed and released; only what starts after its release changes |

Tests: `brain-hosts.test.ts`, "a stop ends a start waiting for a brain host…", "a stop landing while a poked start is between finding room and committing…", "a start committed before a stop is never retried…", and the describe "a brain the operator stopped restarts nothing, however it ends" (scenarios D, A, B, the deadlines, an epoch-less exit, and a start after the stop still running). Mutations: the old `stop` condition fails the first two; dropping either `intentFailed` check, either `brainWaitEnded` call (or comparing its row's time again), `stop_epoch`'s write, its check in `issueStart`, `startFailed`, `release`, `onHostDraining`, `onExited`, either deadline, or the stop's clearing of wake alarms fails at least one each. Also `agent-seams.test.ts`, "a stopped agent's sandbox moving … doesn't restart it; new input does", and E1 and E2 in the describe above (mutations: dropping `wake`'s `stop_quiet` check, `release`'s wake for input after the stop, `inputArrived` in `enqueueTurn` or `postInbox`, or `quietSinceStop`'s epoch condition each fails one; counting `system` notes as input fails F1 and F2 (`agent-seams.test.ts`), and a stale flag past a later start is tested there too). Remaining cost, not a restart: a start run in flight still places or resumes the sandbox before its re-check, so a stop during it can leave a VM running until its idle suspend (11 minutes).

## refactor/turn-state (author's map, 2026-10-31)

**Head:** `refactor/turn-state` (on main abe3b65). Citations by function name. Unverified by a model run.

| Change | Code | Conforms (author) | Detail |
|---|---|---|---|
| A condemned brain's release restarts nothing of its own | agent.ts `release` | yes (S-neutral; **changes `RExited` for a condemned brain**) | Its exit reason describes the kill, so `RESTART_ON_EXIT` no longer applies to it: no wake, no `wake_after_exit`, no crash count (that last part unchanged). A stopped brain with input after the stop still wakes. Every condemn cause either keeps an intent (move, restart, drain, a failed send, a retried refusal) or wakes itself (the deadlines, an epoch-less exit), so only a refused start that ended `errored` behaves differently: it was restarted by its own `fenced` exit, without bound (B1, `StartResult` D1), and now stays `errored` until new input. Also an epoch-less `auth_failed` exit's kill no longer restarts the brain. `errored` survives the release while nothing will start a brain |
| Turn completion requeues every unconfirmed inbox message | turns.ts `TurnQueue.complete`, `requeuedTurn` | yes (Q3 + Q1) | Was channel notices only (the channels section's row); now any mirrored message without `inbox_delivered`, as one queued turn inside Q3's step (the owner's decision 2: AgentDO is the only source of turns) |
| `state` split into `lifecycle` and `activity` | agent.ts `agentState`, `splitState`, `load`, `save`; every former `state` write | yes (S-neutral) | The model's `state` is `agentState(lifecycle, activity)`. AgentDO's transitions (issue, hello, release, a refused start, the guard, the `starting` deadline, `intentFailed`) write `lifecycle`; runner events and `pump` write `activity`. One difference: a release clears the activity, so an `errored` the runner reported no longer survives a release (only AgentDO's does). No guard reads `state` except `working()` and the flush delay, which read the derived value |
| The brain lifecycle's rules move to lib/brain.ts | agent.ts `release` → `brainRelease`; the `starting`/`no_session` deadlines → `unresponsive`; `onExited` (no epoch) → `epochlessExit`; `startFailed` → `startFailure`; `wake` → `wakeDecision`; `setIntent` → `mergeIntent`; `processIntent`'s live-brain branch → `liveBrainStart`; `escalate`'s verdict → `escalation`; the phase deadlines of `issueStart`, `condemn`, `release`, `onHello` and `load` → `phaseDeadlines` (applied by `armPhase`). `RESTART_ON_EXIT`, `MAX_EXIT_RESTARTS`, `MAX_START_ATTEMPTS`, `stoppedBrain`, `quietSinceStop`, `moves` move with them | yes (S-neutral, no row's meaning changes) | Each handler keeps its awaits and re-checks; the decision is taken and its patch applied in the same synchronous `update`. Two steps became one: the crash count of the `starting`/`no_session` deadlines and of an epoch-less exit is written in the condemn's step (was a separate `update` just before it, with no await between), and `issueStart`'s failed send keeps its intent in the condemn's step likewise. `issueStart` now also clears a `condemned` row (none can exist: it issues only with no brain). Table tests: `test/brain.test.ts` |
