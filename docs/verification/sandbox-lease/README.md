# Sandbox lease, epoch, fencing and salvage: inventory

The protocol between SandboxDO, FleetDO and nestd that decides which host runs a sandbox, at which epoch, and whose commits move its head. Written as a reference for a model (TLA+ or similar). Every claim about code cites `file:line` on main (`edf6829`), except SandboxDO's transitions, which cite the function in `control-plane/src/lib/sandbox-lease.ts` (the pure core, one function per action, checked by a seeded random walk in `control-plane/test/sandbox-lease-core.test.ts`); `sandbox.ts` is `control-plane/src/do/sandbox.ts`, `fleet.ts` is `control-plane/src/do/fleet.ts`, `host.rs` is `crates/nestd/src/host.rs`. Design intent is in [fencing](../../sandbox/fencing/), [SandboxDO](../../control-plane/durable-objects/sandbox/), [FleetDO](../../control-plane/durable-objects/fleet/) and [nestd](../../compute/nestd/).

**Pilot:** [pilot/](pilot/), the TLA+ model checked with TLC.

> **Status** (by reading `main`, 2026-11-02): B2, B3, B4, B6, B7 and B8 are fixed (§8, mostly #62). B1 and the epoch rollback are open, waiting on the owner's decision. STONITH waits for `terminated` (#63), which closes the double run on the control-plane side. Salvage is authorized against SandboxDO's full `epochs` table (#32), which doesn't change B1: the rolled-back epoch is the current one.
>
> **Re-dated 2026-11-06** (`main` at `9fd147ff` plus #187): §2.1 and §2.2 cite functions (FleetDO's `file:line` moved everywhere; the [conformance pass](conformance/) has this head's lines). New since `edf6829`: the claim pins its restore source (`restore_pin`); a new placement resets its slots in its own step and owes the rest (`afterPlaced`) to a `placed` deadline (#187, the sweep's bug 3); a command result's follow-ups are owed until they've run (#187, bug 2, §3); `reassignments` replaced `reassign_queue`; evictions also come from a host's `die` (idle, drained) and a draining host's `suspended` report; the turn-checkpoint machine (not inventoried: it moves no lease). Still open: B1, B5, L1 "Refused" (a refused re-placement is never retried by SandboxDO, and from `leaseLost` retries every tick; #191 bounds both), S3' (no runtime check of the highest leased epoch). Models: [SandboxLease and SlotFollowups](../../../verification/tla/sandbox-lease/).

## 1. Scope and actors

| Actor | Instances | State it holds (modelled variables) | Code |
|---|---|---|---|
| SandboxDO | one per sandbox | `info` blob in DO SQLite `kv`: `epoch` (int, 0 before first claim), `placing` (epoch or null), `placing_ms`, `host` (or null), `state` (`SandboxState`), `head` (generation id or null), `history` [(epoch, host)] capped at `HISTORY_MAX = 50`, `lost_from` (host or null), `working` [agent], `create_attempts`; tables `generations(id, record, orphaned)`, `commits(request → outcome)`; deadlines `place`, `idle`, ... | `sandbox.ts:38-71`, `94`, `124-130` |
| FleetDO | one per cell | `leases(sandbox PK, host, epoch, expired, state, guest, ...)`; `hosts(host, status ∈ active/draining/expired/stonith_pending/dead, last_rx, instance_id, nestd_instance)`; `reassignments((sandbox, host, epoch) PK, host_dead, attempts)` (was `reassign_queue`, keyed by sandbox: B4); `stale_incarnations((sandbox, host, epoch) PK, first_seen_ms, clean, cmd)`; `evictions((sandbox, host, epoch) PK)`; `commands(cmd, host, type, sandbox, epoch, purpose, result, followup_ms)` plus the reliable channel per host | `fleet.ts` schema in the constructor |
| nestd | one process per host (a restart is a new process, new `instance_id`) | `summary`: one row per sandbox = its newest local incarnation `(epoch, state, head, dirty)`; older incarnations live only in retire tasks; `tombstones`: fenced epochs per sandbox; `lease_deadline` (monotonic, boottime) for the whole host; per-incarnation dirs `sandboxes/<id>/<epoch>/` with `meta.json` (survive restarts) | `host.rs:261-271`, `311-341`, `464-488` |
| EC2 | oracle | instance state; `terminate`, `state` | `control-plane/src/lib/ec2.ts:45`, `114-118` |
| Alarms | per DO | `Deadlines`: key → at, persisted in SQLite, a handler that throws keeps its key (regression `#20`) | `Deadlines` (`control-plane/src/lib/reliable.ts`) |

Out of scope: agent epochs and brain hosts, attach/bindings (except where an epoch bump revokes them), drains' commit gate (not built), egress.

## 2. State machines

### 2.1 SandboxDO (`info.state`, `host`, `placing`, `epoch`)

`SandboxState` = creating, restoring, running, suspending, suspended, archiving, archived, fenced, destroyed, failed (`control-plane/src/protocol/model.ts:84-87`). There is no `paused`. The placement table in the SandboxDO doc (`unplaced/placing/placed/evacuating`) is not built; the code derives it: unplaced = `host = null ∧ placing = null`, placing = `placing ≠ null`, placed = `host ≠ null`. `gone` = destroyed or archived (`lib/sandbox-lease.ts`): final, and the alarm places any unplaced sandbox that isn't gone (a suspended one only while someone works, `placeWanted`).

| Transition | Trigger | Guard | Effect | Code |
|---|---|---|---|---|
| Create | operator | no `info` | epoch 0, `creating`, then Claim | `create` |
| Claim | `placeCurrentEpoch` (create, wake, leaseLost, evicted with work, alarm `place`, retryPlacement) | after `reconcilePlacing`; not destroyed/archived; `host = null`; `placing = null` | `epoch := epoch+1; placing := epoch; placing_ms := now`; pin the restore source (`restore_pin`); arm `place` at +60 s; **await** `FleetDO.place` | `claim` |
| Placed | place returned host h | `placing = e`, not destroyed/archived | `placing := null; host := h; state := restoring/creating; history += (e, h)`; in the same step the slots reset (`placedStep`) and the `placed` deadline is owed; clear `place`; then `afterPlaced` (secrets, `agent_attach`, move notices, idle), which clears `placed` once it ran to the end for this epoch. Guard false: no effect and no follow-ups (B7), or Destroy's cleanup | `placeAnswered`, `placedStep`; shell `afterPlaced`, alarm `placed` |
| NoCapacity | place returned null | `placing = e` | `placing := null`; **`epoch := e-1` if still e**; `place` at +30 s | `placeAnswered` |
| Refused | place threw FORBIDDEN | `placing = e` | as NoCapacity, but `place` cleared, error rethrown | `placeAnswered` |
| Unknown | place threw anything else, or this DO reset, or the answer was lost | — | marker stays; `place` deadline reconciles | `placeAnswered` |
| Reconcile | alarm `place`, `wake`, next Claim | `placing = e`, older than 60 s; else re-arm | **await** `leaseOf`; then if `placing` still e: clear it; adopt if lease `(h, e, ¬expired)`: `host := h; state := lease.state ?? ...; history += (e, h)`, slots reset and `placed` owed as in Placed; a gone sandbox clears the marker and adopts nothing | `reconciled`, `placedStep` |
| Report | `reportState(h, e, s)` via FleetDO | `e = epoch ∧ h = host` | `state := s` (any state, `fenced` included) | `reported` |
| LeaseLost | FleetDO `processReassign` | not destroyed/archived; `(epoch = e ∧ (host = h ∨ (host = null ∧ placing = null)))`, or already handled `(host = null ∧ lost_from = h)` | `host := null; lost_from := h` (`working` kept: brains run elsewhere); Claim excluding h if `hostIsDead` | `leaseLost` |
| Evicted | FleetDO `processEvictions` | `host = h ∧ epoch = e` | `host := null; state := suspended`; Claim (excluding h) if anyone works | `evicted` |
| CreateFailed | `commandFailed(h, sandbox_create, e)` | `e = epoch ∧ h = host` | re-issue create at the **same** epoch up to 3 times, then `state := failed` | `createFailed` |
| Retry | operator `POST /place` | `state = failed ∧ host` | `fence` to old host, `releaseFailedLease(h, e)` (not waiting for the fence; the lease deleted and its incarnation recorded stale in one step, since 2026-11-10), `host := null`, `epoch := e + 1` (spent, since 2026-11-09: the incarnation left on the host is then an older epoch's, its salvage an orphan), Claim | `failedHolder`, `retried` |
| Destroy | operator | — | `state := destroyed; host := null; placing := null` first (no await before it); then **await** `FleetDO.sandboxDestroyed` (from then on Grant refuses), `sandbox_destroy` to the old host if any, **await** `releaseLease` (all epochs); clear `place`. A Placed or Reconcile continuation that then finds the sandbox gone releases the lease it got at e and sends `sandbox_destroy(e)` to its host (`discardPlacement`) | `destroy`, `discardPlacement` |
| Commit | `commit(h, ev)` via FleetDO | see 2.4 | may move `head` | `decideCommit` |

### 2.2 FleetDO lease row and host status

| Transition | Trigger | Guard | Effect | Code |
|---|---|---|---|---|
| Grant | `place(sbx, e)` | no lease (same e live: return its host; any other row, or same e expired: FORBIDDEN); not destroyed in the registry (FORBIDDEN; #62; one never registered is registered, logged); a sandbox host `active`, not wedged, with a helloed socket, that fits | insert `(sbx, h, e, expired 0)`, queue `sandbox_create(e)` (same synchronous block) | `place` |
| Expire | `tick` | host `active/draining`, `now - last_rx ≥ 30 s`, a live lease | all its leases `expired := 1`; host `stonith_pending`; close sockets; EC2 terminate + poll. A silent host with no live lease is `expire_silent` instead (no STONITH) | `tick` + `expiryVerdict` (`lib/host-lifecycle.ts`), `expireHost` |
| StonithFence | hello, every tick with a socket, failed fence | expired leases not queued and not covered by a pending `stonith_fence` | `fence{sandboxes}` with purpose `stonith_fence` | `ensureStonithFence` (from `onHello`, `tick`, a failed fence's result) |
| FenceOk | `command_result` ok of a `stonith_fence` | — | `recordStale`; host `active` if no other expired lease and a socket, and FleetDO isn't terminating it (EC2 and an instance id; the model's `StonithClear` and fence result need `ec2[h] = "running"`, an over-approximation: the code never clears such a host, even before EC2 accepts the termination); `queueReassign` | `onCommandResult`; `stonithDoneIfClear`, `move` → `hostStep` |
| HostDead | EC2 `isDead` (`null`, `terminated`; at `edf6829` also `shutting-down`) or operator | — | host `dead`; its unanswered commands answered by FleetDO; `queueReassign` every lease (or evict, for an idle or drained host's `die`) | `pollStonith`, `confirmHostDead` → `die` |
| HolderFenced | holder's `sandbox_state{fenced}` (event or hello) | lease `(h, e, ¬expired)` | forward to SandboxDO, `recordStale`, `queueReassign` | `handleEvent`, `reconcileSandboxes`, `holderFenced` |
| Unreported | hello of a new nestd process | live lease not in the report | captured in the reset's step (`kv`); then suspended: Evict; else `queueReassign` | `onHello`, `dropUnreported` |
| Reassign | `processReassign` (after enqueue, every tick) | per `reassignments` row `(sbx, h, e)` | delete lease if it is still `(h, e)`; **await** `leaseLost(h, e, dead)`; delete row; on error `attempts++`, row kept | `queueReassign`, `processReassign` |
| Evict | drain (a draining host's `suspended` report), idle retire, `die(idle/drained)`, Unreported | lease on h whose last reported `state = suspended` | delete lease; `evictions` row → `SandboxDO.evicted` (retried) | `evict`, `processEvictions` |
| Release | SandboxDO destroy, or a placement discarded | — | delete lease (all epochs, or one) | `releaseLease` |
| ReleaseFailed | SandboxDO's failed release, or an operator's retry of a failed sandbox | lease `(h, e)` | delete it and record `I(h, e)` stale, not clean, in one step | `releaseFailedLease` |
| Hello | host reconnects | not dead, not wedged | `last_rx := now`; `expired` → `active` (`hello_back`); **`stonith_pending` stays**; unhonored reported sandboxes fenced and recorded stale | `onHello`, `reconcileSandboxes` |

Revocation: `heartbeat_ack.revoked` lists every claim whose lease is absent, on another host, at another epoch, or expired (`onHeartbeat`).

### 2.3 nestd incarnation `(sandbox, epoch)` on one host

| Transition | Trigger | Guard | Effect | Code |
|---|---|---|---|---|
| Create | `sandbox_create(e)` | e not tombstoned; row not `(e, running)` (idempotent ok), not `(e, fenced)`, not newer | older local row: fence it (no salvage), teardown, retire (salvage) in background; insert row `(e, creating/restoring)`; boot; re-check fence; `running` | `host.rs:1404-1491` |
| Suspend / Resume | commands | `check_epoch`, not fenced, re-checked after awaits | `running → suspending → suspended → running` | `1661-1771` |
| Fence | `fence` command (no epoch: fences the **current** row, on arrival and again in order), `revoked` claim at its epoch, self-fence, commit rejected (`stale_epoch`/`parent_mismatch`) | row at that epoch, not already fenced | `state := fenced` (terminal: `set_state` refuses leaving it, `674-694`); tombstone; proxy drop; gateway forget; lock-free pause (spawned); then under the lock stop VM, drop netns, retire | `779-819`, `1097-1160`, `2150-2175` |
| SelfFence | watchdog: `now ≥ deadline` on monotonic or boottime | — | fence every row in a lease-holding state | `1056-1094`, `339-341` |
| Retire | after fence / supersede / restart recovery | once per incarnation | salvage commit (`reason: salvage`, epoch e, parent = local head) unless the disk equals the head; transient error or `parent_mismatch`: retry 1 s..5 min; `stale_epoch`/`invalid_message`: **drop the work**; delete dirs; report `incarnation_retired` | `1170-1221`, `2216` |
| Destroy | `sandbox_destroy(e)` | local epoch ≤ e | teardown row, delete every incarnation ≤ e, prune tombstones ≤ e | `1825-1846` |
| Restart | new nestd | — | VMs killed; clean incarnations deleted unreported; others: `fenced` row (newest per sandbox), tombstoned, retired | `395-488` |

Lease claims sent in each heartbeat: rows in creating, restoring, running, suspending, suspended, archiving (`328-341`). A fence command's result is `ok` whether or not it fenced anything (`1393-1398`), and it is emitted before the pause and the VM stop finish.

### 2.4 Commit decision (`decideCommit` in `lib/sandbox-lease.ts`, synchronous, no await before the decision)

1. Stored outcome for `request`: return it.
2. `kind` disagrees with `mem_manifest`: rejected `invalid_message`.
3. `reason = salvage ∧ ev.epoch < epoch`: orphan iff `history` has `(ev.epoch, h)` (first match), else `stale_epoch`.
4. `ev.epoch ≠ epoch ∨ h ≠ host`: `stale_epoch`.
5. `parent ≠ head`: `parent_mismatch`.
6. Else head := new generation (a salvage at the current epoch from the current holder lands here too).

FleetDO forwards commits without checking the lease (`fleet.ts:1139-1142`): SandboxDO's `(host, epoch)` is the only authority.

## 3. Messages and delivery

| Channel | Assumption to model | Evidence |
|---|---|---|
| DO → DO RPC | The callee runs atomically between its own awaits; the caller's input gate opens at every await on another DO, so any other request to the caller may run there. Either side may be reset at any await (in-memory state lost, synchronous SQLite writes before the await kept). A reply may be lost (caller sees an error, callee's effects stand). | `sandbox.ts:5-7`; `place` is idempotent per `(sbx, e)` |
| Fleet channel, FleetDO → host commands | Persisted, delivered in order, resent after reconnect, exactly one result per command; `fence` also acts on arrival, ahead of queued commands | `fleet.ts:1152-1173`, `778`; `host.rs:779-805` |
| Fleet channel, host → FleetDO events | In order per host (serial queue), resent until acked; a processing failure closes the socket and the batch is resent. A `command_result` is recorded with its follow-ups owed (`followup_ms`) in one step; a follow-up that fails or is cut by a reset runs again on the redelivery or from the `followups` deadline (since #187; before, a redelivered result was ignored and the follow-up lost) | `onCommandResult`, `runFollowups`, `followupsDue`; `lib/command-result.ts` |
| Heartbeat / ack | Unreliable, every 5 s; ack renews the host's deadline from the heartbeat's **send** instant; hello ack renews from the hello's send instant | `crates/nestd/src/fleet.rs:286`, `373-392` |
| EC2 | `terminate` and `state` may fail (retried each tick); `state` returning `null` (the instance doesn't exist) counts as dead; an answer `state` can't read throws | `ec2.ts` `isDead`, `AwsEc2.state` |

## 4. Timing

Constants: heartbeat 5 s, host fence 20 s, control-plane expiry 30 s (`crates/nest-protocol/src/control.rs:23-27`; asserted `heartbeat·3 < host_fence < cp_expiry`, `control.rs:1087`). FleetDO checks expiry on its 5 s tick, so expiry lands in [30 s, 35 s + alarm delay) after `last_rx`.

Let `s_a` be the send instant of the last heartbeat whose ack the host processed, `r_last ≥ s_a` the real time FleetDO processed its last heartbeat (or hello) from that host. The host fences by real time `s_a + 20/(1-ρ) + ε_w + ε_f` (ρ: host monotonic rate error; `ε_w ≤ 250 ms` watchdog granularity, `host.rs:1075`; `ε_f`: fence execution, network side immediate, vCPU pause spawned). FleetDO marks expiry no earlier than `r_last + 30 - σ`, σ the skew between the Cloudflare machines that stamped `last_rx` and read `Date.now()` (a reset DO can move machines; `last_rx` is a stored wall-clock value, so FleetDO does compare timestamps, contrary to "both sides measure durations"). Self-fence precedes expiry iff `20/(1-ρ) + ε_w + ε_f < 30 - σ + (r_last - s_a)`; with `r_last ≥ s_a` it suffices that `ρ < 1/3` and `ε_w + ε_f + σ` stays well under 10 s. Boottime covers a suspended host (`host.rs:1066`).

What depends on it: not lease reassignment (that waits for fence-ok or EC2), but (a) treating EC2 `null` as dead (and, at `edf6829`, `shutting-down`), (b) the windows in bug B5, (c) brain hosts (out of scope). Placement RPCs add a second timing assumption: a `place(sbx, e)` call is delivered and executed within `PLACING_STALE_MS = 60 s` of its claim, or S3' below can fail.

## 5. Safety properties

Notation: `SB` = SandboxDO info, `L` = FleetDO lease row, `I(h, e)` = incarnation of the sandbox at epoch e on host h.

| Id | Property | Holds? |
|---|---|---|
| S1 single committer | Every head-moving commit has `ev.epoch = SB.epoch ∧ h = SB.host ≠ null` at decision time, so at most one `(h, e)` can move the head at a time | Holds by construction (`sandbox.ts:585-597`, synchronous) |
| S2 single runner | No two incarnations of a sandbox on different hosts are both unfenced in a state that runs a VM, except within bounded windows | Holds when reassignment follows fence-ok, EC2 dead or holder `fenced`. Violated transiently by the paths in B5; "fence ok" means marked fenced and network-cut, not yet stopped (`host.rs:1124-1158`) |
| S3 epoch monotone | `SB.epoch` never decreases | **Violated by design**: NoCapacity/Refused set `epoch := e-1` (`sandbox.ts:312`, asserted by `control-plane/test/regressions.test.ts:155-171`), contrary to the settled "an epoch is never retried" (`docs/README.md:154`, SandboxDO doc "Placement"); the doc's Built section says "spends no epoch" |
| S3' no reuse of a leased epoch | No epoch number is passed to `place` with a non-null result twice | Holds iff no `place` RPC executes > 60 s after its claim (a reconcile can clear a marker whose request is still in flight; then a NoCapacity rollback reissues that number) |
| S4 fenced reassignment | A lease row is deleted (and so a newer epoch grantable) only after STONITH confirmed, a fence of that lease acknowledged, or the holder reported `fenced` | Holds for `processReassign` from expiry and holder-fenced; not for `retryPlacement`, evictions and Unreported (B5) |
| S5 salvage authorization | An orphan for epoch e is recorded only from the host SandboxDO placed at e, never moves head | Holds for "never moves head" and "only that host"; over-refuses: epochs beyond 50 placements back, leases granted but never adopted, and salvage at the current epoch while unplaced (B1). Since #32 the full `epochs` table authorizes salvage, so the 50-placement limit is gone |
| S6 chain | Head only moves to a generation whose parent is the old head | Holds (`sandbox.ts:587`) |
| S7 terminal fence | Once `I(h, e)` is fenced it never runs again (no transition out of `fenced`; a create at a tombstoned e is refused) | Holds in nestd (`host.rs:674-694`, `1416-1426`) |
| S8 lease ↔ claim | If `L = (h, e, ¬expired)` and `SB.host ≠ null` then `SB = (h, e)` | Can fail after B2 (destroyed DO adopts a host) and B7 |
| S9 destroyed is final | `SB.state = destroyed` is never left | **Violated**, B2 |

## 6. Liveness properties

| Id | Property | Fairness / conditions | Holds? |
|---|---|---|---|
| L1 | A sandbox whose lease is lost, with work, is eventually placed again | capacity eventually; EC2 reachable, or the host reconnects, or an operator confirms; weak fairness on alarms and `processReassign` | Fails in B3 (fenced/failed state never retried by the alarm), B4, and the Refused state (lease at another epoch: `place` deadline cleared, no automatic repair, `sandbox.ts:322`) |
| L2 | Every `placing` marker is eventually cleared or adopted | the `place` deadline fires (written in the same synchronous block as the claim: `Deadlines.set` writes its row before its first await); FleetDO eventually answers `leaseOf` | Holds |
| L3 | Every `reassign_queue` row is eventually deleted | `leaseLost` eventually returns | Holds, except a row that gave up after refusals (since 2026-11-06, conformance below); but rows can be silently not inserted (B4) |
| L4 | Every stale incarnation is eventually destroyed or retired | host reachable | Mostly: `sandbox_destroy` is sent once; if the host restarts before running it the row keeps `cmd` set and is skipped for 24 h (`fleet.ts:893`, `1324`); nestd's own retire usually deletes it first |
| L5 | STONITH eventually resolves | EC2 or reconnect or operator | By design waits forever otherwise ("we wait or ask me") |
| L6 | Every salvage terminates | — | Holds since `77b3b30` (final refusals end it); `parent_mismatch` retries until destroy |

## 7. Past bugs in this area

| Commit | Bug | Property | Needs in the model |
|---|---|---|---|
| `4f85ffd` | STONITH by fence left the sandbox `fenced` with no lease: nestd reports `fenced` before the fence's ok, FleetDO forwarded it although the lease was expired, `leaseLost` ignored `fenced` | L1 | host-reported state forwarded into `SB.state`, event order (state before `command_result`); include |
| `4f85ffd` | `placing` marker from a cut-off placement never cleared | L2 | DO reset and lost replies at the `place` await; include |
| `4f85ffd` | hello reset `stonith_pending`: a host reconnecting while being terminated and dying before its fence result was never polled | L5, S4 | host status, hello, EC2 poll; include |
| `4f85ffd` | stale incarnations leaked on old hosts | L4 | `stale_incarnations`, `reapStale`; include |
| `a9d3ce0` | a restarted nestd ignored disks with uncommitted work; re-placement overwrote it on the same host | salvage completeness (S5 dual) | durable per-incarnation disk across crash; include as a `dirty` bit per `I(h, e)` |
| `11def7f` H1 | jailed VMMs outlived nestd | S2 | an assumption flag "crash kills VMs"; keep as a parameter |
| `77b3b30` M1 | an older epoch's late fence took the newer epoch's pause handle; an old rejection fenced a newer incarnation | S2/S7 per epoch | two epochs of one sandbox on one host, fences carrying the epoch; include |
| `77b3b30` M2 | final salvage refusals retried forever | L6 | salvage outcomes; include |
| `e76fe31` (nestd) | a timed-out commit resent with a stale parent → `parent_mismatch` → fence | spurious fence (liveness) | lost commit replies plus request-id idempotency; include |
| `fdf121d` (deferred) | salvage authorized against the 50-entry history | S5 | needs > 50 epochs: drop (state as an abstract bound) |

## 8. Real and suspected bugs

**B1 (real; likelihood low-medium): salvage at the lost epoch is refused for good while SandboxDO is unplaced at that epoch.** `leaseLost` sets `host := null` (`sandbox.ts:467-471`); if the placement finds no host, NoCapacity rolls `epoch` back to the lost epoch e (`312`). A salvage from the old holder at e then fails step 3 (`ev.epoch < epoch` is false, `575`) and gets `stale_epoch` at step 4 (`585`); nestd treats that as final and deletes the disk (`host.rs:1193-1196`, `2164`). Broken: "no agent work is silently lost" (fencing doc §5). Trigger: a live host's lease is lost (self-fence + `fenced` report, STONITH by fence, nestd restart) when no host fits, e.g. the host is still `stonith_pending` in a one-host cell or the cell is full; the self-fenced host's `fenced` event precedes its `commit_request` in the same ordered stream. Repro (vitest): create on A (epoch 1), report `running`; `releaseLease`, then `sandboxStub.leaseLost(A, 1, true)` with no other host (NoCapacity, epoch stays 1, host null); `sandboxStub.commit(A, {reason: "salvage", epoch: 1, parent: head, kind: "disk_only", ...})` → expect `orphaned`, get `rejected stale_epoch`. Fix direction: authorize salvage for `ev.epoch ≤ epoch` unless `(ev.epoch, h) = (epoch, host)`.

**B2 (fixed, #62): `destroy` racing an in-flight placement resurrects the sandbox.** `placeCurrentEpoch` awaits `FleetDO.place` with `placing = e` (`287`); `destroy` runs in that gap (input gate open), does not clear `placing`, sets `destroyed` (`507-519`). The continuation checks only `placing === e` (`305`) and writes `host := h; state := creating/restoring` (`313-317`); `reconcilePlacing` has the same gap (`231-243`). If `releaseLease` executes before the `place` insert, a lease and a VM for a destroyed sandbox also leak. Broken: S9, S8. **Fix:** `destroy` clears `placing`, both continuations adopt nothing for a gone sandbox, and a lease granted meanwhile is released with its VM destroyed (`discardPlacement`). That alone left a lease and a VM when a request reached FleetDO after the release and SandboxDO lost the continuation (a reset), so `destroy` tells FleetDO first and `place` refuses a destroyed sandbox. Regression tests in `control-plane/test/lifecycle.test.ts` ("the lease's guards"); the model's `FixDestroy` is this fix as built (`MCFixedB2`).

**B3 (fixed, #62; was confirmed by vitest): a `fenced` or `failed` sandbox that found no capacity is never re-placed by its alarm.** A holder's `fenced` report sets `SB.state = fenced` (`368`); `leaseLost` then tries once; NoCapacity arms `place` (`332`), but the alarm places only `ACTIVE_STATES` (`82`, `674`). Only `wake()` (an agent start) recovers it; `leaseLost` cleared `working` (`469`). **Fix:** the alarm places any sandbox that isn't destroyed or archived (a suspended one only while someone works), and `leaseLost` keeps `working`; regression tests in `control-plane/test/lifecycle.test.ts`.

**B4 (fixed, #62: `reassignments` is keyed by the lease, confirmed by a vitest that injects one lost `leaseLost` answer; the pilot's L2): `reassign_queue` is keyed by sandbox alone.** `INSERT OR IGNORE` (`fleet.ts:195`, `1849`) drops a loss `(B, e+1)` while a failing row `(A, e)` for the same sandbox is pending; that row then no-ops (`leaseLost` returns at `sandbox.ts:472-473`) and is deleted, so the `(B, e+1)` lease of a fenced holder is never reassigned (no expiry: B is alive; no revocation: fenced rows aren't claimed). Needs `leaseLost(A, e)` to fail once, the marker adopted on B, and B to fence before the next tick.

**B5 (deviation from S4/S2; suspected windows of seconds):** lease deletion without a fence acknowledgement: `retryPlacement` sends `fence` and releases the lease without waiting (`sandbox.ts:345-352`); evictions trust the lease's last reported `suspended` (`fleet.ts:1548`, `1499-1511`, `814`) although a `sandbox_resume` may be in flight (`sandbox.ts:392-393`); Unreported relies on "no VM outlives nestd", unverified on a real host. The old incarnation runs until its next revoked heartbeat (~5 s) or self-fence (≤ 20 s); commits are refused (S1), but an agent holding a still-valid binding for the old epoch reaches the old gateway meanwhile.

**B6 (fixed, #62: an unreadable answer throws, only NotFound or an empty reservation set is `null`): STONITH falls open on a parse failure.** `isDead(null)` is true and `state()` returns `null` for any 200 response the regex does not match (`ec2.ts:45`, `114-118`). Safety then rests on the self-fence margin (§4), not on STONITH.

**B7 (fixed, #62): a stale placement continuation acts on current state.** If the marker was reconciled while `place` was still running, a later host answer still clears the current `place` deadline and notifies agents of a host the DO doesn't hold (`sandbox.ts:325-329`); together with S3', needs a `place` call slower than 60 s. **Fixed:** a continuation whose marker is gone runs none of its follow-ups (`placeCurrentEpoch`); regression test in `control-plane/test/lifecycle.test.ts`.

**B8 (fixed, #62): a lost `orphaned_work` notice.** The orphan and its stored outcome are written before the `ingest` await (`sandbox.ts:580-598`); if `ingest` throws, the resent commit returns the stored outcome and the notice is never posted. **Fix:** the notice is given again whenever a stored orphaned outcome is returned (`noticeOrphan`, today a log line).

## 9. Modelling notes

**Keep:** one sandbox, two hosts (A, B), epochs ≤ 4, generations ≤ 3 (head, one orphan). SandboxDO and FleetDO as separate processes whose handlers are split into atomic steps at every cross-DO await (marked **await** in §2), with a nondeterministic "reset" (drop the continuation) and "lost reply" at each. Reliable FIFO channels per host both ways; heartbeats as an unreliable channel; host crash (VMs die, disks and `meta.json` survive), partition, reconnect; EC2 as an oracle that eventually answers dead after terminate (and, as a fault, answers dead early: B6). A capacity flag per host (to reach NoCapacity). Host-reported `fenced` forwarded into `SB.state`.

**Drop:** bindings and attach (keep only "epoch bump revokes"), policy and secrets, packing arithmetic (capacity is a boolean), tunnels, GC, agents beyond a `working` bit, idle suspend (keep suspend/resume as host actions for B5), timing values (replace by the ordering "self-fence before expiry" as an assumption toggle, and the 60 s marker staleness as a nondeterministic "stale" predicate).

| Model action | Code |
|---|---|
| `Claim`, `PlaceReply`, `PlaceFail` | `claim`, `placeAnswered` in `control-plane/src/lib/sandbox-lease.ts`; the shell `SandboxDO.placeCurrentEpoch` |
| `Grant` | `FleetDO.place` (`fleet.ts:1191-1260`) |
| `Reconcile` | `reconcileAt`, `reconciled` (`lib/sandbox-lease.ts`); the shell `SandboxDO.reconcilePlacing` + `FleetDO.leaseOf` (`fleet.ts:1268-1275`) |
| `Expire`, `Terminate`, `Ec2Dead` | `tick`, `expireHost`, `pollStonith`, `confirmHostDead` (`fleet.ts:1304-1332`, `1749-1842`) |
| `StonithFence`, `FenceResult` | `ensureStonithFence`, `onCommandResult` (`fleet.ts:1805-1825`, `1099-1121`) |
| `Enqueue`, `Reassign`, `LeaseLost` | `queueReassign`, `processReassign` (`fleet.ts:1845-1873`); `leaseLost` (`lib/sandbox-lease.ts`) |
| `Hello` | `onHello`, `reconcileSandboxes`, `dropUnreported` (`fleet.ts:729-844`) |
| `Heartbeat`, `Revoke` | `onHeartbeat` (`fleet.ts:941-956`), nestd `Revoked` (`host.rs:812-819`) |
| `HostCreate`, `HostFence`, `SelfFence`, `Salvage`, `Retire`, `HostDestroy`, `HostCrash` | `host.rs:1404-1491`, `1097-1160`, `1056-1094`, `1170-1221`, `1825-1846`, `395-488` |
| `Commit` | `decideCommit` (`lib/sandbox-lease.ts`); shell `SandboxDO.commit` |
| `Evict` | `evict`, `processEvictions` (`fleet.ts:1561-1589`); `evicted` (`lib/sandbox-lease.ts`) |
| `Destroy`, `Retry` | `destroyed`, `failedHolder` + `retried` (`lib/sandbox-lease.ts`); shells `SandboxDO.destroy`, `retryPlacement` |
| `Report`, `CreateFailed`, alarm `place` | `reported`, `createFailed`, `placeWanted` (`lib/sandbox-lease.ts`); every host-event guard is `holds`, every finality check `gone` |
| `ReapStale` | `fleet.ts:890-912` |

**Invariants worth checking now, in code or tests:**
- Runtime: in `FleetDO.place`, log an error if `req.epoch ≤` the highest epoch this cell ever leased for the sandbox (needs a column; detects S3' failures).
- Tests: B1 (salvage after a NoCapacity rollback), and a nestd test that a `fence` command result is emitted only after the pause landed, or a doc change saying it isn't.

## Conformance: bounded retries of a refused placement (fix/refused-placement, 2026-11-06)

**Head:** `fix/refused-placement` (on main 9fd147ff). No lease decision changed (`placeAnswered`, `leaseLost`, `claim` are as they were). Only who tries again, and when. Checked since by `PlacementRetry.tla` ([conformance](conformance/#placementretrytla-and-failedreleasetla), 2026-11-09), which also reproduces this branch's first version (giving up on a call that never landed) as a violation.

| Model action | Code | Conforms (author) | Detail |
|---|---|---|---|
| `PlaceFail` (Refused) | `SandboxDO.placeCurrentEpoch`, "unplaced" refused | partly | Still clears `placing`, rolls the epoch back and rethrows. It now also re-arms the `place` deadline with backoff (`PLACE_REFUSED_RETRY`), so the alarm `place` action (`placeWanted`) runs again, as after NoCapacity, up to 6 times. The spec's Refused leaves no retry, so L1's "Refused" failure is now bounded rather than permanent. The spec doesn't model the retry; it is the same transition NoCapacity already takes |
| `Reassign` | `FleetDO.processReassign` | partly | A failed `leaseLost` is retried with backoff. It gives up (`gave_up_ms`) only after 10 refusals, each of which means `LeaseLost` was taken (SandboxDO no longer names the host) and the placement after it was refused. A call that never landed is retried without bound, as the spec's `Reassign` is under weak fairness. So L3 ("every row is eventually deleted") fails only for a row that gave up after refusals; it stays until a placement or the destroy of the sandbox deletes it, and the sandbox shows `placement_refused` |

Tests: `control-plane/test/placement-refused.test.ts`. Mutations run, each killed:
- no backoff;
- never giving up (reassignments or refusals);
- a call that never landed counting toward giving up;
- given-up rows retried, arming the tick (either place) or keeping their dead host's record;
- FleetDO's tries using up the sandbox's own count;
- the operator's retry keeping the refusal count;
- a destroyed sandbox's rows kept;
- a refusal clearing the deadline (the old behaviour);
- the note kept once placed;
- the given-up row left after a placement;
- no note.

## Policy and conformance: a failed sandbox releases its lease (fix/failed-releases-host, 2026-11-06)

**Policy (the owner's default):** a sandbox `failed` on its host keeps the lease for 15 minutes, then gives it up, so the host can retire. The record stays `failed` and unplaced, with its head, until an operator or client retries or destroys it. An attached agent no longer pins the host.

**Head:** `fix/failed-releases-host` (on main 9fd147ff). Checked since by `FailedRelease.tla` ([conformance](conformance/#placementretrytla-and-failedreleasetla), 2026-11-09): the release's own properties hold. It found that an operator's retry between the release's two steps left the sandbox unplaced at the released epoch, where the incarnation's salvage was refused; `lease.retried` now spends an epoch too.

| Model action | Code | Conforms (author) | Detail |
|---|---|---|---|
| (new) `FailedRelease` | `failedReleased`, `failedReleaseDue` (`lib/sandbox-lease.ts`); the shell `SandboxDO.releaseFailed`; `FleetDO.releaseFailedLease` | not in the spec | A `fence` to the holder; FleetDO deletes the lease at that epoch and records the incarnation as stale in one step; then, if the sandbox is still failed on that host at that epoch, `host := null` and `epoch := epoch + 1`. No claim follows. The spent epoch makes the incarnation's salvage an older epoch's, so `decideCommit` takes it as an orphan from that epoch's host: this release doesn't meet B1 (a salvage refused at an unplaced sandbox's own epoch), which stays open for the NoCapacity rollback. The lease is deleted without waiting for the fence's acknowledgement, as in `Retry` (B5's window, unchanged). Hosts B9 (idle retirement ignoring incarnations still salvaging) is closed by the idle path's new check |
| alarm `place` | `placeWanted` | changed | False for a `failed` sandbox, so an unplaced failed one is never claimed by the alarm. This narrows B3's fix (#62) to `fenced`: a failed sandbox that loses its host and finds no room now stays failed until retried |
| `Retry` | `retriedReleased` + `claim` (shell `retryPlacement`) | extends | For a failed sandbox with no host: `state := creating`, then the usual claim. With a host, unchanged |

Tests: `control-plane/test/sandbox-lease-core.test.ts` (the decisions, by table) and `test/fleet.test.ts` (the host retires; the sandbox stays failed until retried).
