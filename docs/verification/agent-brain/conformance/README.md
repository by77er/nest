# Conformance: the brain-record code against the model

**Head checked:** `origin/deferred/brain-record` at **6073da7** (6073da7b2069792f56b5cc57ea7768b6f8d115b0, fetched 2026-10-25). **Design:** `BRAIN-RECORD-DESIGN.md`: invariant S, liveness L, rules 1-6, amendments A1-A6. **Model:** `verification/tla/agent-brain/AgentBrain.tla` as it stood when this was written (another agent is still editing it). Background: [../README.md](../README.md), [../pilot/](../pilot/README.md).

**History.**

| Head | Result |
|---|---|
| a38d3c0 | First check: D1-D13 (D1-D5 high). A3 not implemented. |
| 4bc2c3f | A3: nestd `LapseGuard`, the runner's fence generation, FleetDO `failStarts`, no resend of an answered start, `issueCommands` refuses starts to expired or dead hosts. |
| 6073da7 | A4', A5, A6 (`hosts.lost`), D1-D13 fixes, the fifth review's fixes, call-id idempotency, adopt on a same-host re-issue. This check. |

**Method.** I read the branch without checking it out (`git show`, `git diff a38d3c0 6073da7`). Each model action, design rule, amendment and implementer choice was mapped to code and checked for awaits that skip a re-check, write groups a DO reset can split, stale reads, and transitions the model lacks. I ran no tests and no TLC. Every scenario below comes from reading the code and is **unverified by execution**. Citations are `brain-record@6073da7:path:line`. In the tables the prefix is left out and paths are short: `agent.ts`/`fleet.ts` = `control-plane/src/do/`, `host.rs`/`runner_link.rs` = `crates/nestd/src/`, `agent.rs`/`runtime.rs`/`supervisor.rs` = `crates/nest-runner/src/`, `seams` = `control-plane/test/agent-seams.test.ts`.

## Table

| Model action | Rule | Code at 6073da7 | Conforms | Detail |
|---|---|---|---|---|
| `SessOK`, `Hello` | 1 | agent.ts:426-429, 1274-1277, 1285-1300 | yes | The epoch-0 exception for a hands-less previous-release runner remains (428) |
| `ResolveReq`/`ResolveResp` | 1 | agent.ts:1182-1199 | yes | `current()` before and after the await. sandbox.ts is unchanged since a38d3c0 |
| (platform calls) | 1 | agent.ts:1764, 1865-1868 | yes | `assertEpoch(fence)` before every write |
| (events) | 1 | agent.ts:1556-1563 | yes | Re-checked before each event and before the ack (D7 fixed) |
| `RWake` | 2 | agent.ts:1005-1031, 2121-2132 | partly | A live brain with no session isn't re-issued in place (model); it is condemned after 10 min and restarted (D9 fix). Same end, slower |
| `RStart` no brain | 2 | agent.ts:606-614, 632-664 | yes | Health is checked before the awaits. A host that expired meanwhile is refused by `issueCommands` (fleet.ts:1263-1267), condemned, then released by `hostGone` |
| `RStart` same host | 2 | agent.ts:600, 606 | partly | Still no `Healthy(bh)` check. Expired or dead hosts are now refused (A3c), but draining or disconnected ones are not (low) |
| `RStart` condemn | 2 | agent.ts:600-605, 759-772 | yes | `unchanged()` and the condemn's write are in one synchronous step |
| `Issue` / `IssueFail` | 2 | agent.ts:678-722 | yes | Record, intent and `starting` deadline are written in one step (D3 fixed). A failed send condemns and keeps the intent |
| `RKill`/`RKillFail`/`RKillAlarm` | A1 | agent.ts:759-796, 818-821; fleet.ts:1404-1411 | yes | The kill is owed by the record. The alarm is armed with the condemn, and FleetDO deduplicates by (host, agent, epoch) |
| `RDeadline` | (assumed) | agent.ts:41-42, 667-669, 2106-2120 | partly | 4 min, doubling to 16 min (D10 fixed). Still fires whether or not the host is `Quiet` |
| `REscalate` | rule 4 | agent.ts:810-837; fleet.ts:1421-1448 | yes | A wedge only when nothing has been processed since the kill and nothing older is pending, or at the 15 min cap. Re-checked after `killProgress` (825) |
| `RStatusRelease` | A2, A6 | agent.ts:592-595, 814-817, 844-847 | yes | `hostGone` = the `lost` flag, or no host row |
| `RExited` | rule 3 | agent.ts:963-980; fleet.ts:1148-1156, 985-1003 | partly | An exit without an epoch maps to `min_epoch` (the oldest outstanding start); a row with a NULL epoch condemns. See N3 |
| `RHostLost`, `LostSend/Deliver/Drop` | A2, A5 | agent.ts:988-996; fleet.ts:2016-2031, 1508 | yes | Carries the row's epoch and re-checks `lost` at delivery. The ack deletes by `cmd`. See N6 |
| `StartResult` (code only) | D1 | fleet.ts:1238-1245; agent.ts:938-955 | yes | Condemns that epoch and records a retry. Never releases, and the row stays |
| `Deliver` (kill on arrival) | rule 6 | host.rs:852-859 | yes | As before |
| `Deliver` (A3, start while lapsed) | A3a | host.rs:345-375, 824-826, 1149, 1393-1396 | partly | Stamped on arrival and refused at exec. The stamp is not atomic with the lapse (N5) |
| `Exec` (start, tombstone) | rule 6, A4 | host.rs:1980-1996; runner_link.rs:303-310 | yes | The exit is owed. The `Err` result now only condemns |
| `RunnerStart` lease/tombstone/register | A3a, A4' | agent.rs:72-138, 177-186; runtime.rs:81-93, 145-155 | yes | Refusals for a forbidden built-in or no lease supersede the older brain and report only once it is gone (D8 fixed). The fence generation drops a waiting start |
| `RunnerStart` adopt | choice 3 | agent.rs:139-151; runtime.rs:441-448 | **no** | Not atomic with the brain's deregistration (agent.rs:848-849): N2 |
| `ApplyKill`, `AccOut`/`AccSet`, `OwedExit` | rule 6, A4 | runner_link.rs:272-310, 395-466 | yes | A runner exit without an epoch maps to the oldest entry (431) |
| `LeaseLapse` | rule 5, A3 | host.rs:1145-1155; supervisor.rs:133-152 | yes | |
| `HostHello` | rule 5 | fleet.ts:753-826, 1019-1040 | partly | Clears `lost` (811). Answered starts are not resent (718-724). Reconcile marks rows `gone` and retries delivery (D4 fixed) |
| `Expire` | rule 5, A3b | fleet.ts:1485-1496, 1962-2007 | **no** | Decides on a host-row snapshot read before awaits (N1). Wedged hosts or hosts with leases go to `stonith_pending`, which the model doesn't have |
| `ConfirmDead` | A6 | fleet.ts:2080-2093, 1728-1732 | yes | Sets `lost` |
| `Drain`, `DrainRetire` | rule 5 | fleet.ts:1745-1767, 1711-1720 | yes | A retirement marks the host `dead`, not `lost` |
| `ResetAgentDO` | durability | agent.ts:333-335, 685-689, 768, 869-875, 945-953 | yes | Every transition writes its deadline row before its first await (`Deadlines.set` writes synchronously) |
| Choice 1: release on a lost host ignores the epoch | A3+A6 | agent.ts:592-595, 814-817 | partly | Sound only while "lost" implies nothing runs. N1, N5 and N4 break that |
| Choice 2: an exit without an epoch condemns; `min_epoch` | rule 3 | fleet.ts:985-1003, 1278-1285; agent.ts:970-979 | partly | Safe, but a single legacy exit strands a newer start (N3) |
| Choice 3: adopt on a same-host re-issue | rule 2 | agent.rs:139-151 | partly | N2 |
| Choice 4: tool calls keyed by call id | — | agent.ts:1772-1775, 1821-1824, 1862 | yes | Tested (seams:1094). Low residual: N9 |

## Status of D1-D13 at 6073da7

| D | Status | Where now |
|---|---|---|
| D1 a refused start's error releases | fixed | agent.ts:938-955 condemns; fleet.ts:1240-1244 keeps the row; seams:869-891 |
| D2 host loss without an epoch; delete by (agent, host) | fixed | agent.ts:988-996; fleet.ts:2016-2031. N1 reopens the trace by another route |
| D3 deadline armed after an await | fixed | agent.ts:679-689; seams:923 |
| D4 reconcile deletes before calling | fixed | fleet.ts:1036, 1006-1016, 1509; seams:961 |
| D5 wedged host released on its own watchdog | fixed for a host AgentDO declared wedged | fleet.ts:1493-1494, 2076, 1980-1982. A silent, un-wedged host without leases is still released on lease expiry (A6 allows this) |
| D6 a redelivered epoch-less exit finds no row | fixed | fleet.ts:1152-1154 (AgentDO is told first); seams:986 |
| D7 events not re-checked mid-batch | fixed | agent.ts:1559, 1563; seams:1013 |
| D8 exits before an older brain has gone | fixed in new binaries (partly: N3) | agent.rs:177-186; runner_link.rs:431; fleet.ts:985-990 |
| D9 no watchdog for a live brain without a session | fixed | agent.ts:1239-1242, 2121-2132; seams:1031 |
| D10 2 min start deadline | fixed | agent.ts:41-42, 667-669; seams:1048 |
| D11 a graceful stop has no epoch | fixed | agent.ts:893; runner_link.rs:219-226; supervisor.rs:104 |
| D12 follow-up alarms after awaits | fixed | agent.ts:869-875, 945-953; seams:944 |
| D13 migrated record without an alarm | fixed | agent.ts:328-336; seams:257 |

## New and remaining divergences, ranked

**High (break S or L)**

- **N1. Tick expiry from a stale snapshot (breaks S; reopens the A3 trace).** `brain-record@6073da7:control-plane/src/do/fleet.ts:1488-1495` reads every active host once, then awaits `expireHost`/`expireSilent` (and their `brainsLost` RPCs) host by host. `expireSilent` (1991-1996) writes `expired, lost = 1` without re-reading `last_rx` or status.
  - Interleaving: h1 and h2 go silent together. `start{e}` sits unanswered for h2. The tick snapshots both. While it awaits h1's `brainsLost`, h2 says hello (785 refreshes `last_rx`; the `hello_ack` renews its lease). `start{e}` is resent (807, still unanswered) and is stamped after the renewal, so it runs (host.rs:1394 passes). Brain e helloes and resolves hands.
  - The tick resumes with h2's stale row: `expireSilent(h2)` sets it lost and `brainsLost` → `onHostLost(h2, e)` → `hostGone` is true → release. Brain e+1 starts elsewhere.
  - h2 reconnects. Its hello sets `lost = 0` and renews the lease. Nothing ever kills brain e: its row was deleted on the ack, and `hostReport` ignores an agent recorded elsewhere (agent.ts:1034-1039). Two brains: e acts through its cached hands target until the binding ages out (TTL unverified), and its process lives on.
  - Fix: re-check `status` and `now - last_rx >= expiry` in the same synchronous step as the write. Also kill any agent a hello reports that the record doesn't name (`reconcileAgents`).

**Medium**

- **N2. The adopt races the brain's own exit (breaks L: a healthy host is wedged).** The start task finds the brain registered (`brain-record@6073da7:crates/nest-runner/src/agent.rs:115`, `Refused::Running`) and adopts outside the registry lock (139-151). Meanwhile the actor deregisters, reads the epoch and reports `exit{N}` (848-849).
  - If the report reads N before `adopt_epoch(N+1)` runs, AgentDO ignores exit N. nestd's entry N+1 is never cleared (runner_link.rs:450-457), so FleetDO's row N+1 stays.
  - After 4 min the start deadline condemns N+1. The kill is processed but the row is still indexed, so at 15 min `hostWedged` sends a healthy host to STONITH: every brain restarts and every sandbox is re-placed.
  - The window is microseconds, but the trigger is any same-host re-issue racing a crash or an exit. Fix: adopt under the registry lock, refusing a deregistered brain, or read the exit epoch under that lock.
- **N3. Mixed version: a single legacy exit strands a newer start (breaks L).** An old runner doesn't adopt; it reports `already_running` and one epoch-less exit per process. nestd maps that exit to the oldest entry (`brain-record@6073da7:crates/nestd/src/runner_link.rs:431`), and FleetDO does the same with an old nestd (`control-plane/src/do/fleet.ts:985-990`). After a same-host re-issue N→N+1, the one exit clears N only. Then: start deadline, kill, row N+1 still indexed, 15-min cap, wedge. a38d3c0 released here (but unsafely, by the newest mapping). Also, a spurious epoch-less exit with no row condemns whatever brain is on that host (agent.ts:970-979).
- **N4. Mixed version: an old nestd has no A3a (breaks S).** Main's nestd has no `LapseGuard` (none existed at a38d3c0 either). A start it held across a lapse runs after the renewal. FleetDO meanwhile failed that start and released the record through `brainsLost`: the pilot's TLC trace. Old runners also lack the fence generation. Gate: treat the expiry of a host whose hello reports an old nestd as non-proof (STONITH path), or deploy hosts first. Unverified: the exact main-branch behaviour.

**Low**

- **N5. `LapseGuard` stamps are not atomic with a lapse.** `brain-record@6073da7:crates/nestd/src/host.rs:355-363`: `arrived` loads `lapsed` (false), then `lapsed()` sets the flag and bumps the count, then `arrived` loads the new count. A start arriving at the lapse instant is stamped as post-lapse. If FleetDO expires the host and the hello renews the lease before exec, the N1 outcome follows (S). Fix: one atomic word, or a mutex.
- **N6. `lost` is cleared on hello (`fleet.ts:811`).** Every release re-checks `lost` at delivery (agent.ts:994, 592, 814), so a stale notice alone doesn't break S. But `brainsLost` deletes the row after AgentDO declined because the host came back (2023-2026). The record then waits for the start deadline, `no_session` (10 min) or a kill's exit (L delay only).
- **N7.** `startFailed` condemns whatever brain is current after an await (`agent.ts:953-954`; `condemn()` takes no epoch). Safe today only because that await is a storage operation, which doesn't open the input gate.
- **N8.** A same-host re-issue has no health check (`agent.ts:606`), carried over from a38d3c0.
- **N9.** A call id outside a turn is `cal_x<8 hex>-<n>`, with `n` per brain (`runtime.rs:524-531`). With call-id keying, a collision across brains returns another call's stored outcome (rows are kept 7 days).
- **N10.** The `lost` migration marks every previous-release `dead` host lost (`fleet.ts:222-226`), including drain and idle retirements that A6 says prove nothing. Mixed version only.

## Transitions the code has and the model lacks

| Transition | Code | Risk |
|---|---|---|
| Tick expiry on a stale snapshot | fleet.ts:1488-1495 | S (N1) |
| A brain a hello reports but no record names is never killed | agent.ts:1034-1039; fleet.ts:1019-1040 | S (N1's orphan) |
| Adopt is not atomic with deregistration | agent.rs:139-151, 848-849 | L (N2) |
| A start error condemns (the model's `START_FAIL` releases) | fleet.ts:1238-1245; agent.ts:938-955 | The fix: check that it neither wedges nor releases early |
| `stonith_pending`: a wedged host, or one with leases; `lost` only on confirmed death | fleet.ts:1962-1983, 2073-2093 | L waits for EC2 or an operator (by design) |
| `lost` flag separate from status, cleared on hello | fleet.ts:219-226, 811, 1463-1466 | N1, N6 |
| `gone` rows and delivery retried by the tick | fleet.ts:1006-1016, 1509 | none found |
| `min_epoch` mapping for epoch-less exits | fleet.ts:985-1003, 1278-1285 | L in the mixed window (N3) |
| `no_session` condemn | agent.ts:1239-1242, 2121-2132 | none found |
| New nestd process: unanswered commands fail and become `startFailed` (condemn) | fleet.ts:816-821 | as before: relies on the runner killing on disconnect (supervisor.rs:24) |
| Legacy record migration | agent.ts:302-336 | none found |

## Untested load-bearing lines

By my reading, removing or breaking each of these fails no test on the branch (unverified; I ran nothing). The commit says every *listed* mutation fails a test; these lines are not on its list.

- fleet.ts:811 `lost = 0` on hello. Without it, a host that came back stays lost, so a brain later started there is released while it runs (S). The A3 test (seams:804-850) never starts a brain on the returned host.
- fleet.ts:1488-1495: no test lets a hello interleave the tick (N1).
- fleet.ts:2021: the per-agent `hostLost` check in `brainsLost`. The A5 test (seams:1200) keeps `lost = 1` throughout.
- fleet.ts:1731: an EC2-confirmed retirement sets `lost`. The A6 test (seams:1223) uses `confirmHostDead`.
- fleet.ts:1966: `failStarts` in `expireHost` (L only). The tests expire hosts without leases.
- host.rs:355-363 ordering: the unit test (host.rs, `a_start_never_outlives_a_lease_lapse`) is sequential.
- agent.rs:139-151 against 848-849: lifecycle.rs `a_live_brain_adopts_a_reissued_epoch` adopts only a healthy brain.
- fleet.ts:2076 `wedged_ms IS NULL`: defensive. A wedged host's hello is refused, so it has no socket.

These are tested: agent.ts:592, 685-689, 825, 870-875, 942, 994, 1559, 1772-1775; fleet.ts:718-724, 1001, 1153-1154, 1263-1267, 1424-1426, 1494, 2026; host.rs:1394; runtime.rs:84; supervisor.rs:104.

## Inventory issues on brain-record

| Issue | Status at 6073da7 |
|---|---|
| A-1 drained host made dead with a brain on it | Fixed (fleet.ts:1714) |
| A-2 the runner keeps no tombstone | Fixed (runtime.rs:81-110; supervisor.rs:92-99) |
| A-3 a killed brain is still current | Fixed (agent.ts:428) |
| A-4 stale `awaiting_exit` | Fixed (record, `unchanged()`) |
| A-5 a silent host without a lease is never expired | Fixed (fleet.ts:1488-1495; but see N1) |
| A-6 wedged host released without STONITH | Fixed for declared wedges (D5) |
| M-1 a hinted start sends no stop | Fixed (condemn) |
| M-2 the stop's `ok` drops the row | Fixed (fleet.ts:1232-1233) |
| M-3 rows deleted before AgentDO is called | Fixed (D4) |
| M-4 two `agent_start`s | Fixed |
| M-5 no watchdog for a vanished brain | Fixed (D9) |

## What the model should add

1. Split `Expire` into a read and a commit, with `HostHello` (and a resent start) enabled between them. This should reproduce N1 as a `OneActingBrain` violation. The fix to check: re-check silence at the commit.
2. A host's report of an agent the record doesn't name, and a kill for it. Without one, any lost-release race leaves an orphan.
3. A non-atomic adopt: split `Die` into deregister and report, with `RunnerStart`'s adopt between them. Expect `NoHealthyWedge` (N2).
4. Replace `START_FAIL`'s release with a condemn (`StartResult`), and check S and L for the code as it is.
5. `stonith_pending` distinct from `expired`. A wedged host always goes through STONITH, and `lost` is a flag cleared by `HostHello`.
6. The mixed window per host: a runner or nestd that sends one exit without an epoch and doesn't adopt (N3, `NoHealthyWedge`), and a nestd without A3a (N4, `OneActingBrain`).
7. Optionally, `Deliver` reading the lapse flag and the lapse count in two steps (N5).
