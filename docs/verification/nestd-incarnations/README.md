# nestd incarnations, fenced-epoch tombstones and restart recovery

Inventory for modelling: per-(sandbox, epoch) state on a sandbox host, `Fenced` as terminal, salvage and retire, the tombstone map, restart reconciliation, and FleetDO's reap of stale incarnations. Code is cited at main `edf6829` (PR #27); rows changed since cite functions. Design: [nestd](../../compute/nestd/README.md), [fencing](../../sandbox/fencing/README.md).

> **Since:** the pure decisions here (tombstones, the scan, `meta.json` versions, salvage retry, retire backoff) are extracted into `nestd_core::incarnation` and proved with Kani; the machine itself is phase 2 of [nestd/](../nestd/#phase-2-design).

## Scope and actors

| Actor | State (exact) | Code |
|---|---|---|
| nestd summary (one row per sandbox) | `{epoch, state, head, dirty, ...}`; `state ∈ {Creating, Restoring, Running, Suspending, Suspended, Archiving, Archived, Failed, Fenced, Destroyed}` | `crates/nestd/src/host.rs:84-93` |
| nestd `sandboxes` map | `sandbox → Arc<Mutex<Sbx>>` (live incarnation only; recovered and superseded ones are held by their retire task) | `host.rs:95-134` |
| Sbx | `{epoch, head, disk_clean, retiring, vm?, paused, unanswered?, state_dir, vm_dir}` | `host.rs:95-134` |
| Disk | `<state_dir>/sandboxes/<s>/<e>/{disk.img, snapshot/, meta.json, meta.json.tmp}`, `<e>.del`; `<run_dir>/vm/<s>/<e>/` | `crates/nestd/src/recovery.rs:1-17` |
| meta.json | `{version=1, sandbox, epoch, head?, clean, unanswered?, ...}` | `recovery.rs:29-66` |
| Tombstones (in memory, shared by both links) | `sandbox → highest fenced epoch` | `crates/nestd/src/tombstones.rs:17-52` |
| Pausers | `(sandbox, epoch) → lock-free pause handle` | `host.rs:211-226` |
| FleetDO | `stale_incarnations(sandbox, host, epoch PK, first_seen_ms, clean, cmd?)`; `leases`; `SALVAGE_WINDOW_MS = 11 min` | `control-plane/src/do/fleet.ts:115-118`, `:222-223` |

## State machines

### Incarnation lifecycle on a host (key `(s, e)`)

| Transition | Actor | Guard | Effect | Ref |
|---|---|---|---|---|
| Create | executor | `¬tomb(s) ≥ e`; row is not `(e, Fenced)`; row epoch ≤ e | an older row is fenced (no salvage), torn down and retired in the background; `mkdir state_dir`; row `(e, Creating)` | `host.rs:1404-1446` |
| DiskReady | boot | — | restore, copy or create `disk.img`; **fsync**; `clean := true`; write meta | `:1514-1538` |
| VmStart | boot | not fenced (checked before the await) | `clean := false`; write meta **before** `vm.start` | `:1541-1560` |
| Running | create | `set_state` refuses leaving `Fenced` | `dirty := true`; `prune_below(s, e)` | `:1472-1480`, `:674-692` |
| CreateFail | create | not fenced | `Failed`; teardown; delete dirs (via `.del`) | `:1482-1488` |
| Suspend | executor | `lock_live` (epoch and fence checked before and after the lock) | pause (`paused := true`), commit; `Committed ⇒ clean := vm none ∨ paused`; any failure: unless fenced or a fencing rejection (`rejection_fences`), `clean := false` (meta written), resume, `Running` | `suspend`, `roll_back_suspend`, `apply_commit` |
| Resume | executor | `Suspended`, `lock_live` | `clean := false`, write meta **before** resuming (a cold resume: `launch`, which stops the VM on any error) | `resume`, `launch` |
| Checkpoint | executor | `lock_live` | pause the VM (`paused` untouched, so `clean` stays false); commit; resume unless fenced or a fencing rejection; `dirty := true` | `checkpoint` |
| Fence | any (command, self-fence, rejection, reconcile) | row is `(e, ¬Fenced)` | under the summary lock `state := Fenced`; fence brains; lock-free pause; `tomb ⊔= e`; proxy `Drop(Fence)`; gateway forget; report; then under the Sbx lock stop the VM and drop the netns; retire when `salvage` is set | `:1110-1159` |
| Retire | spawned once per Sbx (`retiring`) | — | loop while `(¬clean ∨ unanswered) ∧ state_dir exists` (`may_hold_work`, read under the Sbx lock): commit(salvage). Landed, or nothing to commit, or a non-retryable error: break. Retryable or `parent_mismatch`: sleep 1 s doubling to 5 min. Then delete dirs; if not destroyed meanwhile, `row(e).dirty := false` and emit `incarnation_retired(s, e)` | `retire_now`, `commit` |
| Destroy | executor | row epoch ≤ e | `Destroyed`; teardown (removes row and map entry); delete every dir ≤ e; `prune_up_to(s, e)` | `:1825-1846` |
| Archive | executor | `lock_live` | commit if `may_hold_work` or no head; delete dir; teardown | `archive` |

### Restart (Host::start, `host.rs:345-547`), strictly in this order

1. Kill leftover VMMs (cgroup `cgroup.kill` under both parents) and pidfile processes, with a pid and start-time check (`:360-387`).
2. Tear down `ns-sbx_*` netns, sweep VM dirs (`:389-398`).
3. `scan`: remove stray files, `*.del`, non-epoch dirs, dirs with missing or invalid-JSON `meta.json`, and a meta naming another incarnation. Keep, and never retire, a dir whose meta has another version or an I/O error (`recovery.rs:111-160`).
4. `clean ∧ unanswered = none` ⇒ delete unreported (`host.rs:402-408`). Otherwise build a row `(e, Fenced, dirty=true)` keyed by sandbox (the newest epoch wins, since the scan sorts), `tomb.fence(s, e)` for every found epoch (`:466-487`).
5. Start the links, the fleet (the hello reports the `Fenced` rows) and `retire(entry)` for each found incarnation (its meta's `clean` decides the salvage); its commit queues behind the hello (`:520-547`).

### FleetDO stale incarnations (`fleet.ts:822-913`, `:996-1015`, `:1113-1119`)

| Transition | Trigger | Effect |
|---|---|---|
| RecordStale | hello row not honored (no lease, or a lease at another host or epoch); `sandbox_state{fenced}` from a non-holder; STONITH fence ok; holder reports `fenced` (`holderFenced`, then reassign) | upsert `(s, h, e)`, `clean := max(clean, new)`, `first_seen_ms` kept |
| MarkClean | `incarnation_retired(s, e)` | `clean := 1`, then reap |
| Reap | every alarm and the above | skip while the lease is `(h, e)`; **drop** if the host is gone or dead, or `lease.epoch < e`, or the lease is on the same host at another epoch; otherwise once `clean ∨ age ≥ 11 min`, claim `cmd` and send one `sandbox_destroy(s, e)` |
| Prune | alarm | delete rows with `cmd` set after `COMMAND_RETENTION_MS` (`:1324`) |

## Assumptions

- **Crash:** nestd may crash at any instruction. Files written via `write_meta` (tmp, fsync, rename, fsync dir: `recovery.rs:68-82`) are atomic. A rename is atomic and durable only after a directory fsync. `delete_atomically` doesn't fsync the parent before removing (`recovery.rs:186-198`), so after a power loss a removed `.del` may reappear; the scan deletes it again.
- **No VM outlives nestd:** PDEATHSIG for unjailed children, cgroup kill for jailed ones (only with `delegated_cgroup`), plus the startup kill. Unverified on a real host ([nestd](../../compute/nestd/README.md)). Without delegation a jailed VMM survives until step 1 of the next start, which kills it before any disk is read.
- **Commands** run one at a time in order (`host.rs:549-560`); `fence` bypasses the queue. Host events are lost on crash (in-memory outbox, `crates/nestd/src/fleet.rs:5-16`).
- **Control plane:** epochs per sandbox strictly increase; a destroyed sandbox is never placed again; the host id is stable across restarts (saved credentials, `crates/nestd/src/enroll.rs:107`, `:146-148`; a re-enrollment would make every salvage fail the history check, `sandbox.ts:576-578`; unverified how long the token lasts).

## Safety

- **S1 (no VM outlives nestd):** after step 1 of a start, no process from a previous nestd runs a guest. A `Fenced` incarnation never has a VM once its fence task has run (`:1146-1150`).
- **S2 (dirty work kept or reported):** a dirty incarnation's directory is deleted only if (a) a salvage or commit landed (head or orphan), (b) SandboxDO refused for good (logged), (c) a `sandbox_destroy` ≥ e arrived (FleetDO: clean, or 11 min elapsed), or (d) the sandbox was archived after its commit. Holds since B1 and B2 were fixed.
- **S3 (clean may go silently):** `meta.clean ⇒ disk.img = disk(meta.head)`, or the base image when `head = none`. Holds: `clean` is set only at DiskReady and on `Committed` with no running VM, and is cleared durably before every VM start or resume (`:1557-1559`, `:1726-1727`). `checkpoint` never sets `paused`, so `clean` stays false.
- **S4 (Fenced is terminal):** `row = (e, Fenced) ⇒` it never leaves `Fenced` except to `Destroyed` or removal (`set_state`, `:681-684`; `check_epoch`, `:771`). **Execution caveat:** the VM can run for a bounded time after `Fenced` when a lock-holding operation checked before the fence and resumes after it (B2).
- **S5 (no re-creation):** `create(s, e)` is refused if `tomb(s) ≥ e` or the row is `(e, Fenced)` (`:1416-1426`). After `prune_*`, protection comes from the summary epoch (`s.epoch > e`) or from the control plane's monotonic epochs. Tombstones are not persisted: across a restart only epochs with surviving `meta.json` are re-tombstoned.
- **S6 (safe pruning):** `prune_below(s, e')` runs only after `(s, e')` is `Running`, and `prune_up_to(s, e)` only after every dir ≤ e is gone. Safe iff every older-epoch writer to the links is gated by a summary-epoch check under the Sbx lock. The proxy mirror itself accepts an epoch regression (`proxy_link.rs:221-229`; it consults only tombstones), and so does nestd's gateway mirror (`gateway_link.rs:146-159`). The gateway process refuses older epochs (`e76fe31`).
- **S7 (epoch isolation):** an older incarnation never mutates a newer one's row, pause handle or fence (`with_row`, `:655-657`; `fence_sandbox`'s epoch check, `:1113-1116`; per-epoch pausers).
- **S8 (one directory per incarnation):** `state_dir(s, e)` is written only by `(s, e)`, so a newer create never touches an older disk.

### Crash points (write order and deletion)

| Crash after | On disk | Restart does | OK? |
|---|---|---|---|
| `mkdir state_dir` | dir without meta | removed | yes: nothing ran |
| disk written, before fsync or meta | dir without meta | removed | yes |
| meta `clean=true` | disk = head or base | deleted unreported | yes |
| `clean=false` written, VM not started | dirty meta | `Fenced`, salvage (the disk equals head, so nothing is committed) | yes |
| VM running | dirty meta | salvage | yes |
| `unanswered` persisted, event not yet flushed | dirty meta + unanswered | re-ask, then salvage (a refused re-ask of a non-salvage request doesn't end it) | yes (was B1) |
| commit landed, meta not yet rewritten | stale `head` or `unanswered` | re-ask adopts the stored outcome | yes (S4 of [commit-gc](../commit-gc/README.md)) |
| rename to `.del` | `<e>.del` | removed by scan | yes |
| `meta.json.tmp` written | tmp beside the old meta | old meta used | yes |

## Liveness

- **L1:** every found or fenced dirty incarnation is eventually retired (salvaged, finally refused, or destroyed). Fairness needed: the fleet link eventually stays connected, the store eventually succeeds, and FleetDO's alarm runs `reapStale`.
- **L2:** every `stale_incarnations` row is eventually dropped or gets one `sandbox_destroy`.
- **Gaps:** a dir whose `meta.json` has another version or can't be read is kept forever. A retire that keeps failing transiently after FleetDO dropped its row (same-host re-placement, `fleet.ts:899`) retries without bound and gets no destroy.

## Past bugs and the property that catches each

| Bug (PR #27 review) | Fix | Property |
|---|---|---|
| A restart ignored leftover disks and netns; work overwritten or leaked | `edf6829` part 1: meta.json, scan, salvage | S2, L1 |
| Jailed VMMs outlived nestd | spawner thread, cgroups, startup kill | S1 |
| Tombstones lived twice, were never pruned, and a create at a tombstoned epoch failed as a retryable internal | one map, `stale_epoch`, pruning | S5, S6 |
| A newer create overwrote or waited on an older disk | per-epoch dirs | S8 |
| A suspended sandbox's disk was salvaged needlessly | `clean` flag | S3 |
| An older epoch's late fence took a newer pause handle; an old rejection fenced a newer incarnation | per-epoch pausers, epoch-checked `fence_sandbox` | S7 |
| A final refusal retried forever | `salvage_retryable` | L1 |
| A half-deleted dir revived by its meta | rename to `.del` | crash table |

## Bugs

**B1 (fixed: `reask_failure_ends_commit`; test `a_refused_unanswered_checkpoint_still_lets_the_salvage_run`; was real by code reading): re-asking a non-salvage `unanswered` request that is answered `stale_epoch` ends the retire without salvaging.** `commit()` re-sends `unanswered` first and returns its error immediately (`host.rs:2052-2058`). The rejection is `stale_epoch`, not retryable (`:2163-2173`), so `retire_now` takes it as SandboxDO's final word on the salvage (`:1193-1196`). It deletes the disk and reports the incarnation clean (`:1206-1219`). No salvage commit is ever prepared. Trigger: nestd persists `unanswered` (a `turn_end`, `suspend` or `archive` request) before emitting it (`:2084`) and crashes before the outbox flushes (about 1 s window). On restart the incarnation is recovered with `unanswered`. The hello reports it `Fenced`, so FleetDO reassigns at `e+1` (`fleet.ts:836-841`, `:857-861`). The re-ask is then evaluated fresh: `stale_epoch` (`sandbox.ts:585-586`). Broken: S2, and the docs' "no agent work is silently lost". The existing test covers only a `salvage` `unanswered` (`crates/nestd/tests/host.rs:1717-1805`). Repro: same harness, with meta `unanswered.reason = turn_end` at epoch 1, MockFleet answering it `rejected(stale_epoch)`; assert a `reason=salvage` request follows (it won't), and that the disk was deleted. Fix direction (not applied): treat any outcome of the re-ask other than `Committed` as "not captured" and continue to the salvage.

**B2 (fixed: retire and archive decide from `Sbx::may_hold_work`, the durable `clean` plus `unanswered`, read under the lock; test `a_fence_during_a_checkpoints_resume_still_salvages`; was suspected, low impact): fence vs. checkpoint or resume.** `checkpoint` checks `!fenced` and then awaits `vm.resume()` and `thaw()` (`host.rs:1786-1793`). A fence that lands after the check sees `dirty = false`, because `apply_commit` cleared it on `Committed` (`:2157-2160`) and `dirty := true` comes only after the resume. Its lock-free pause can run before the resume, so the VM runs again until the fence task gets the lock. The retire then skips the salvage (`dirty = false`), losing writes made after the thaw. The same check-then-await pattern is in `resume` (`:1729-1731`). Confirm by injecting a fence between the check and `vm.resume()` with the process driver. Mitigation idea: retire always runs `prepare_commit`, which already skips when the disk equals the head (`:2141-2143`).

**B3 (docs and code disagree): the 11 min window is tied to nothing.** `fleet.ts:115-118` says nestd gives a salvage 600 s (`SALVAGE_TIMEOUT`). No such constant exists. nestd uses `commit_timeout` = 60 s per attempt and retries without bound (`host.rs:62-63`, `config.rs:275-277`). A salvage still retrying at 11 min (a store outage, a large disk) is destroyed. The loss is recorded only as the lease loss (`sandbox.ts:466-470`), never as `orphaned_work`.

**B4 (low):** with two found incarnations of one sandbox, only the newest gets a summary row (`host.rs:466-483`). FleetDO's `sandbox_destroy` for the older one is refused `stale_epoch` (`:1829-1833`). That is harmless because its retire deletes it anyway.

## Modelling notes

- **Abstraction:** one host, one sandbox, epochs 1..3, a disk content token (`head` or `dirty_k`), meta as a record, the outbox as a lossy FIFO, SandboxDO's `commit` as an oracle with `epoch` and `history`. Model `crash` as resetting all memory (summary, tombstones, Sbx, outbox) and keeping the files.
- **Actions to code:** `Create`, `DiskReady`, `VmStart` (`host.rs:1404-1560`); `Fence` (`:1110-1159`); `RetireStep` (`:1184-1219`); `Commit/ReAsk` (`:2040-2121`); `Destroy` (`:1825-1846`); `Scan` (`recovery.rs:111-160`, `host.rs:400-487`); `Reap` (`fleet.ts:890-913`); `Crash`; `ReplaceAtNewEpoch` (`sandbox.ts:256-320`).
- **Check:** S2 as "no `dirty_k` token is discarded unless it reached SandboxDO or a destroy ≥ e or a logged final refusal happened"; S4, S5 and S7 as state invariants; L1 under weak fairness of `RetireStep` and `Reap`. Expect B1 to appear with `Crash` between `persist` and `flush`.

## Runtime assertions and tests to add now

- `retire_now`: assert that a non-retryable error comes from a `reason=salvage` request before deleting the disk. Add the B1 test.
- `create_sandbox`: `debug_assert!` that `state_dir` doesn't exist before `mkdir` (S8). After `Running`, assert `tomb(s) < e`.
- `set_state`: count refused transitions out of `Fenced` (S4 evidence).
- Proxy mirror: refuse an `Upsert` or `AddListeners` with an epoch below the mirrored one (makes S6 local).
- FleetDO: a test that a dirty stale row is never destroyed before 11 min unless `incarnation_retired` arrived. Fix the `SALVAGE_TIMEOUT` comment.
