# Sandbox lease, epoch, fencing and salvage: inventory

The protocol between SandboxDO, FleetDO and nestd that decides which host runs a sandbox, at which epoch, and whose commits move its head. Written as a reference for a model (TLA+ or similar). Every claim about code cites `file:line` on main (`edf6829`); `sandbox.ts` is `control-plane/src/do/sandbox.ts`, `fleet.ts` is `control-plane/src/do/fleet.ts`, `host.rs` is `crates/nestd/src/host.rs`. Design intent is in [fencing](../../sandbox/fencing/), [SandboxDO](../../control-plane/durable-objects/sandbox/), [FleetDO](../../control-plane/durable-objects/fleet/) and [nestd](../../compute/nestd/).

> **Since** (checked on `main` at b63c0a3): the bugs in §8 that the pilot confirmed (the no-capacity epoch rollback, destroy during placement, the double run after a lapse, L1 and L2) are still in the code. Salvage is now authorized against SandboxDO's full `epochs` table (#32), which doesn't change the rollback case: the rolled-back epoch is the current one.

## 1. Scope and actors

| Actor | Instances | State it holds (modelled variables) | Code |
|---|---|---|---|
| SandboxDO | one per sandbox | `info` blob in DO SQLite `kv`: `epoch` (int, 0 before first claim), `placing` (epoch or null), `placing_ms`, `host` (or null), `state` (`SandboxState`), `head` (generation id or null), `history` [(epoch, host)] capped at `HISTORY_MAX = 50`, `lost_from` (host or null), `working` [agent], `create_attempts`; tables `generations(id, record, orphaned)`, `commits(request → outcome)`; deadlines `place`, `idle`, ... | `sandbox.ts:38-71`, `94`, `124-130` |
| FleetDO | one per cell | `leases(sandbox PK, host, epoch, expired, state, guest, ...)`; `hosts(host, status ∈ active/draining/expired/stonith_pending/dead, last_rx, instance_id, nestd_instance)`; `reassign_queue(sandbox PK, host, epoch, host_dead, attempts)`; `stale_incarnations((sandbox, host, epoch) PK, first_seen_ms, clean, cmd)`; `evictions((sandbox, host, epoch) PK)`; `commands(cmd, host, type, sandbox, epoch, purpose, result)` plus the reliable channel per host | `fleet.ts:30`, `180-236` |
| nestd | one process per host (a restart is a new process, new `instance_id`) | `summary`: one row per sandbox = its newest local incarnation `(epoch, state, head, dirty)`; older incarnations live only in retire tasks; `tombstones`: fenced epochs per sandbox; `lease_deadline` (monotonic, boottime) for the whole host; per-incarnation dirs `sandboxes/<id>/<epoch>/` with `meta.json` (survive restarts) | `host.rs:261-271`, `311-341`, `464-488` |
| EC2 | oracle | instance state; `terminate`, `state` | `control-plane/src/lib/ec2.ts:45`, `114-118` |
| Alarms | per DO | `Deadlines`: key → at, persisted in SQLite, a handler that throws keeps its key (regression `#20`) | `control-plane/src/lib/reliable.ts:97-119` |

Out of scope: agent epochs and brain hosts, attach/bindings (except where an epoch bump revokes them), drains' commit gate (not built), egress.

## 2. State machines

### 2.1 SandboxDO (`info.state`, `host`, `placing`, `epoch`)

`SandboxState` = creating, restoring, running, suspending, suspended, archiving, archived, fenced, destroyed, failed (`control-plane/src/protocol/model.ts:84-87`). There is no `paused`. The placement table in the SandboxDO doc (`unplaced/placing/placed/evacuating`) is not built; the code derives it: unplaced = `host = null ∧ placing = null`, placing = `placing ≠ null`, placed = `host ≠ null`. `ACTIVE_STATES` = creating, restoring, running, suspending, suspended (`sandbox.ts:82`).

| Transition | Trigger | Guard | Effect | Code |
|---|---|---|---|---|
| Create | operator | no `info` | epoch 0, `creating`, then Claim | `sandbox.ts:176-208` |
| Claim | `placeCurrentEpoch` (create, wake, leaseLost, evicted with work, alarm `place`, retryPlacement) | after `reconcilePlacing`; not destroyed/archived; `host = null`; `placing = null` | `epoch := epoch+1; placing := epoch; placing_ms := now`; arm `place` at +60 s; **await** `FleetDO.place` | `259-297` |
| Placed | place returned host h | `placing = e` | `placing := null; host := h; state := restoring/creating; history += (e, h)`; clear `place` | `304-319`, `325-330` |
| NoCapacity | place returned null | `placing = e` | `placing := null`; **`epoch := e-1` if still e**; `place` at +30 s | `311-312`, `332` |
| Refused | place threw FORBIDDEN | `placing = e` | as NoCapacity, but `place` cleared, error rethrown | `302-303`, `312`, `322` |
| Unknown | place threw anything else, or this DO reset, or the answer was lost | — | marker stays; `place` deadline reconciles | `306-308` |
| Reconcile | alarm `place`, `wake`, next Claim | `placing = e`, older than 60 s; else re-arm | **await** `leaseOf`; then if `placing` still e: clear it; adopt if lease `(h, e, ¬expired)`: `host := h; state := lease.state ?? ...; history += (e, h)` | `220-253` |
| Report | `reportState(h, e, s)` via FleetDO | `e = epoch ∧ h = host` | `state := s` (any state, `fenced` included) | `361-374` |
| LeaseLost | FleetDO `processReassign` | not destroyed/archived; `(epoch = e ∧ (host = h ∨ (host = null ∧ placing = null)))`, or already handled `(host = null ∧ lost_from = h)` | `host := null; working := []; lost_from := h`; Claim excluding h if `hostIsDead` | `460-478` |
| Evicted | FleetDO `processEvictions` | `host = h ∧ epoch = e` | `host := null; state := suspended`; Claim (excluding h) if anyone works | `407-417` |
| CreateFailed | `commandFailed(h, sandbox_create, e)` | `e = epoch ∧ h = host` | re-issue create at the **same** epoch up to 3 times, then `state := failed` | `435-454` |
| Retry | operator `POST /place` | `state = failed ∧ host` | `fence` to old host, `releaseLease(e)` (not waiting for the fence), `host := null`, Claim | `341-355` |
| Destroy | operator | — | `sandbox_destroy` if host; **await** `releaseLease` (all epochs); `state := destroyed; host := null`; clear `place`. `placing` is not cleared | `507-519` |
| Commit | `commit(h, ev)` via FleetDO | see 2.4 | may move `head` | `552-611` |

### 2.2 FleetDO lease row and host status

| Transition | Trigger | Guard | Effect | Code |
|---|---|---|---|---|
| Grant | `place(sbx, e)` | no lease (same e live: return its host; any other row, or same e expired: FORBIDDEN); a `burst` host `active` with a helloed socket that fits | insert `(sbx, h, e, expired 0)`, queue `sandbox_create(e)` (same synchronous block) | `fleet.ts:1191-1260` |
| Expire | `tick` | host `active/draining`, `now - last_rx ≥ 30 s`, a live lease | all its leases `expired := 1`; host `stonith_pending`; close sockets; EC2 terminate + poll | `1304-1309`, `1749-1765` |
| StonithFence | hello, every tick with a socket, failed fence | expired leases not queued and not covered by a pending `stonith_fence` | `fence{sandboxes}` with purpose `stonith_fence` | `795`, `1317`, `1805-1825` |
| FenceOk | `command_result` ok of a `stonith_fence` | — | `recordStale`; host `active` if no other expired lease and a socket, and FleetDO isn't terminating it (EC2 and an instance id; the model's `StonithClear` needs `ec2[h] = "running"`, refactor/fleet); `queueReassign` | `1107-1121`, `1827-1830`; `stonithDoneIfClear` |
| HostDead | EC2 `isDead` (`null`, `shutting-down`, `terminated`) or operator | — | host `dead`; `queueReassign` every lease | `1787-1803`, `1833-1842` |
| HolderFenced | holder's `sandbox_state{fenced}` (event or hello) | lease `(h, e, ¬expired)` | forward to SandboxDO, `recordStale`, `queueReassign` | `1003-1016`, `842`, `860-864` |
| Unreported | hello of a new nestd process | live lease not in the report | suspended: Evict; else `queueReassign` | `790`, `804-816` |
| Reassign | `processReassign` (after enqueue, every tick) | per row | delete lease if it is still `(h, e)`; **await** `leaseLost(h, e, dead)`; delete row; on error `attempts++`, row kept | `1845-1873` |
| Evict | drain, idle retire, Unreported | lease on h whose last reported `state = suspended` | delete lease; `evictions` row → `SandboxDO.evicted` (retried) | `1548`, `1505-1511`, `1561-1589` |
| Release | SandboxDO destroy / retry | — | delete lease (all epochs, or one) | `1263-1266` |
| Hello | host reconnects | not dead | `last_rx := now`; `expired` → `active` (controllers); **`stonith_pending` stays**; unhonored reported sandboxes fenced and recorded stale | `729-797`, `822-844` |

Revocation: `heartbeat_ack.revoked` lists every claim whose lease is absent, on another host, at another epoch, or expired (`944-948`).

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

### 2.4 Commit decision (`sandbox.ts:571-597`, synchronous, no await before the decision)

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
| Fleet channel, host → FleetDO events | In order per host (serial queue), resent until acked; a processing failure closes the socket and the batch is resent | `fleet.ts:962-983` |
| Heartbeat / ack | Unreliable, every 5 s; ack renews the host's deadline from the heartbeat's **send** instant; hello ack renews from the hello's send instant | `crates/nestd/src/fleet.rs:286`, `373-392` |
| EC2 | `terminate` and `state` may fail (retried each tick); `state` returning `null` (the instance doesn't exist) counts as dead; an answer `state` can't read throws | `ec2.ts` `isDead`, `AwsEc2.state` |

## 4. Timing

Constants: heartbeat 5 s, host fence 20 s, control-plane expiry 30 s (`crates/nest-protocol/src/control.rs:23-27`; asserted `heartbeat·3 < host_fence < cp_expiry`, `control.rs:1087`). FleetDO checks expiry on its 5 s tick, so expiry lands in [30 s, 35 s + alarm delay) after `last_rx`.

Let `s_a` be the send instant of the last heartbeat whose ack the host processed, `r_last ≥ s_a` the real time FleetDO processed its last heartbeat (or hello) from that host. The host fences by real time `s_a + 20/(1-ρ) + ε_w + ε_f` (ρ: host monotonic rate error; `ε_w ≤ 250 ms` watchdog granularity, `host.rs:1075`; `ε_f`: fence execution, network side immediate, vCPU pause spawned). FleetDO marks expiry no earlier than `r_last + 30 - σ`, σ the skew between the Cloudflare machines that stamped `last_rx` and read `Date.now()` (a reset DO can move machines; `last_rx` is a stored wall-clock value, so FleetDO does compare timestamps, contrary to "both sides measure durations"). Self-fence precedes expiry iff `20/(1-ρ) + ε_w + ε_f < 30 - σ + (r_last - s_a)`; with `r_last ≥ s_a` it suffices that `ρ < 1/3` and `ε_w + ε_f + σ` stays well under 10 s. Boottime covers a suspended host (`host.rs:1066`).

What depends on it: not lease reassignment (that waits for fence-ok or EC2), but (a) treating EC2 `shutting-down` and `null` as dead, (b) the windows in bug B5, (c) brain hosts (out of scope). Placement RPCs add a second timing assumption: a `place(sbx, e)` call is delivered and executed within `PLACING_STALE_MS = 60 s` of its claim, or S3' below can fail.

## 5. Safety properties

Notation: `SB` = SandboxDO info, `L` = FleetDO lease row, `I(h, e)` = incarnation of the sandbox at epoch e on host h.

| Id | Property | Holds? |
|---|---|---|
| S1 single committer | Every head-moving commit has `ev.epoch = SB.epoch ∧ h = SB.host ≠ null` at decision time, so at most one `(h, e)` can move the head at a time | Holds by construction (`sandbox.ts:585-597`, synchronous) |
| S2 single runner | No two incarnations of a sandbox on different hosts are both unfenced in a state that runs a VM, except within bounded windows | Holds when reassignment follows fence-ok, EC2 dead or holder `fenced`. Violated transiently by the paths in B5; "fence ok" means marked fenced and network-cut, not yet stopped (`host.rs:1124-1158`) |
| S3 epoch monotone | `SB.epoch` never decreases | **Violated by design**: NoCapacity/Refused set `epoch := e-1` (`sandbox.ts:312`, asserted by `control-plane/test/regressions.test.ts:155-171`), contrary to the settled "an epoch is never retried" (`docs/README.md:154`, SandboxDO doc "Placement"); the doc's Built section says "spends no epoch" |
| S3' no reuse of a leased epoch | No epoch number is passed to `place` with a non-null result twice | Holds iff no `place` RPC executes > 60 s after its claim (a reconcile can clear a marker whose request is still in flight; then a NoCapacity rollback reissues that number) |
| S4 fenced reassignment | A lease row is deleted (and so a newer epoch grantable) only after STONITH confirmed, a fence of that lease acknowledged, or the holder reported `fenced` | Holds for `processReassign` from expiry and holder-fenced; not for `retryPlacement`, evictions and Unreported (B5) |
| S5 salvage authorization | An orphan for epoch e is recorded only from the host SandboxDO placed at e, never moves head | Holds for "never moves head" and "only that host"; over-refuses: epochs beyond 50 placements back, leases granted but never adopted, and salvage at the current epoch while unplaced (B1). The deferred branch replaces `history` with an `epochs` table (`origin/deferred/retention-enums:control-plane/src/do/sandbox.ts:152-202`) |
| S6 chain | Head only moves to a generation whose parent is the old head | Holds (`sandbox.ts:587`) |
| S7 terminal fence | Once `I(h, e)` is fenced it never runs again (no transition out of `fenced`; a create at a tombstoned e is refused) | Holds in nestd (`host.rs:674-694`, `1416-1426`) |
| S8 lease ↔ claim | If `L = (h, e, ¬expired)` and `SB.host ≠ null` then `SB = (h, e)` | Can fail after B2 (destroyed DO adopts a host) and B7 |
| S9 destroyed is final | `SB.state = destroyed` is never left | **Violated**, B2 |

## 6. Liveness properties

| Id | Property | Fairness / conditions | Holds? |
|---|---|---|---|
| L1 | A sandbox whose lease is lost, with work, is eventually placed again | capacity eventually; EC2 reachable, or the host reconnects, or an operator confirms; weak fairness on alarms and `processReassign` | Fails in B3 (fenced/failed state never retried by the alarm), B4, and the Refused state (lease at another epoch: `place` deadline cleared, no automatic repair, `sandbox.ts:322`) |
| L2 | Every `placing` marker is eventually cleared or adopted | the `place` deadline fires (written in the same synchronous block as the claim, `reliable.ts:117`); FleetDO eventually answers `leaseOf` | Holds |
| L3 | Every `reassign_queue` row is eventually deleted | `leaseLost` eventually returns | Holds; but rows can be silently not inserted (B4) |
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

**B2 (real; high confidence on the interleaving): `destroy` racing an in-flight placement resurrects the sandbox.** `placeCurrentEpoch` awaits `FleetDO.place` with `placing = e` (`287`); `destroy` runs in that gap (input gate open), does not clear `placing`, sets `destroyed` (`507-519`). The placement's continuation checks only `placing === e` (`305`) and writes `host := h; state := creating/restoring` (`313-317`), then pushes secrets and attaches. `reconcilePlacing` has the same gap (`231-243`). FleetDO has already been told `sandboxDestroyed` (GC stops rooting its generations, `fleet.ts:1597-1601`). If `releaseLease` executes before the `place` insert, a lease and a VM for a destroyed sandbox also leak. Broken: S9, S8. Repro: `const p = stub.wake(); await stub.destroy(); await p; expect(info().state).toBe("destroyed")` on a fresh unplaced sandbox with one host connected.

**B3 (suspected; medium): a `fenced` or `failed` sandbox that found no capacity is never re-placed by its alarm.** A holder's `fenced` report sets `SB.state = fenced` (`368`); `leaseLost` then tries once; NoCapacity arms `place` (`332`), but the alarm places only `ACTIVE_STATES` (`82`, `674`). Only `wake()` (an agent start) recovers it; `leaseLost` cleared `working` (`469`). Confirm: holder reports `fenced` with no host fitting, connect host B, force the `place` deadline, run the alarm; predicted host stays null.

**B4 (suspected; low; confirmed and fixed on refactor/fleet by a vitest that injects one lost `leaseLost` answer: rows are keyed by the lease): `reassign_queue` is keyed by sandbox alone.** `INSERT OR IGNORE` (`fleet.ts:195`, `1849`) drops a loss `(B, e+1)` while a failing row `(A, e)` for the same sandbox is pending; that row then no-ops (`leaseLost` returns at `sandbox.ts:472-473`) and is deleted, so the `(B, e+1)` lease of a fenced holder is never reassigned (no expiry: B is alive; no revocation: fenced rows aren't claimed). Needs `leaseLost(A, e)` to fail once, the marker adopted on B, and B to fence before the next tick. Confirm with a model (2 hosts, 3 epochs) or a vitest that injects one `leaseLost` failure.

**B5 (deviation from S4/S2; suspected windows of seconds):** lease deletion without a fence acknowledgement: `retryPlacement` sends `fence` and releases the lease without waiting (`sandbox.ts:345-352`); evictions trust the lease's last reported `suspended` (`fleet.ts:1548`, `1499-1511`, `814`) although a `sandbox_resume` may be in flight (`sandbox.ts:392-393`); Unreported relies on "no VM outlives nestd", unverified on a real host. The old incarnation runs until its next revoked heartbeat (~5 s) or self-fence (≤ 20 s); commits are refused (S1), but an agent holding a still-valid binding for the old epoch reaches the old gateway meanwhile.

**B6 (suspected; low; fixed on refactor/fleet: an unreadable answer throws, only NotFound or an empty reservation set is `null`): STONITH falls open on a parse failure.** `isDead(null)` is true and `state()` returns `null` for any 200 response the regex does not match (`ec2.ts:45`, `114-118`). Safety then rests on the self-fence margin (§4), not on STONITH.

**B7 (suspected; low): a stale placement continuation acts on current state.** If the marker was reconciled while `place` was still running, a later host answer still clears the current `place` deadline and notifies agents of a host the DO doesn't hold (`sandbox.ts:325-329`); together with S3', needs a `place` call slower than 60 s.

**B8 (real; minor): a lost `orphaned_work` notice.** The orphan and its stored outcome are written before the `ingest` await (`sandbox.ts:580-598`); if `ingest` throws, the resent commit returns the stored outcome and the notice is never posted.

## 9. Modelling notes

**Keep:** one sandbox, two hosts (A, B), epochs ≤ 4, generations ≤ 3 (head, one orphan). SandboxDO and FleetDO as separate processes whose handlers are split into atomic steps at every cross-DO await (marked **await** in §2), with a nondeterministic "reset" (drop the continuation) and "lost reply" at each. Reliable FIFO channels per host both ways; heartbeats as an unreliable channel; host crash (VMs die, disks and `meta.json` survive), partition, reconnect; EC2 as an oracle that eventually answers dead after terminate (and, as a fault, answers dead early: B6). A capacity flag per host (to reach NoCapacity). Host-reported `fenced` forwarded into `SB.state`.

**Drop:** bindings and attach (keep only "epoch bump revokes"), policy and secrets, packing arithmetic (capacity is a boolean), tunnels, GC, agents beyond a `working` bit, idle suspend (keep suspend/resume as host actions for B5), timing values (replace by the ordering "self-fence before expiry" as an assumption toggle, and the 60 s marker staleness as a nondeterministic "stale" predicate).

| Model action | Code |
|---|---|
| `Claim`, `PlaceReply`, `PlaceFail` | `SandboxDO.placeCurrentEpoch` (`sandbox.ts:259-335`) |
| `Grant` | `FleetDO.place` (`fleet.ts:1191-1260`) |
| `Reconcile` | `SandboxDO.reconcilePlacing` + `FleetDO.leaseOf` (`sandbox.ts:220-253`, `fleet.ts:1268-1275`) |
| `Expire`, `Terminate`, `Ec2Dead` | `tick`, `expireHost`, `pollStonith`, `confirmHostDead` (`fleet.ts:1304-1332`, `1749-1842`) |
| `StonithFence`, `FenceResult` | `ensureStonithFence`, `onCommandResult` (`fleet.ts:1805-1825`, `1099-1121`) |
| `Enqueue`, `Reassign`, `LeaseLost` | `queueReassign`, `processReassign`, `SandboxDO.leaseLost` (`fleet.ts:1845-1873`, `sandbox.ts:460-478`) |
| `Hello` | `onHello`, `reconcileSandboxes`, `dropUnreported` (`fleet.ts:729-844`) |
| `Heartbeat`, `Revoke` | `onHeartbeat` (`fleet.ts:941-956`), nestd `Revoked` (`host.rs:812-819`) |
| `HostCreate`, `HostFence`, `SelfFence`, `Salvage`, `Retire`, `HostDestroy`, `HostCrash` | `host.rs:1404-1491`, `1097-1160`, `1056-1094`, `1170-1221`, `1825-1846`, `395-488` |
| `Commit` | `SandboxDO.commit` (`sandbox.ts:552-611`) |
| `Evict` | `evict`, `processEvictions`, `SandboxDO.evicted` (`fleet.ts:1561-1589`, `sandbox.ts:407-417`) |
| `Destroy`, `Retry` | `sandbox.ts:507-519`, `341-355` |
| `ReapStale` | `fleet.ts:890-912` |

**Invariants worth checking now, in code or tests:**
- Runtime: in `placeCurrentEpoch` and `reconcilePlacing` continuations, refuse to write when `state = destroyed` (B2); in `FleetDO.place`, log an error if `req.epoch ≤` the highest epoch this cell ever leased for the sandbox (needs a column; detects S3' failures); in `queueReassign`, log when `INSERT OR IGNORE` skipped a row with a different `(host, epoch)` (B4).
- Tests: B1 (salvage after a NoCapacity rollback), B2 (destroy during a placement), B3 (fenced + no capacity + alarm), and a nestd test that a `fence` command result is emitted only after the pause landed, or a doc change saying it isn't.
