# Host drain

The forced drain of a sandbox host ([autoscaling](../../compute/autoscaling/), [hosts inventory §2.5](../hosts/#25-drain)): a spot notice or an operator's `POST /v1/admin/hosts/<id>/drain`, until the instance ends. Model: [verification/tla/host-drain/](../../../verification/tla/host-drain/). The gentle drain and the drain gate aren't built, so they aren't modelled.

- **Actors:**
  - FleetDO: the drain, evictions, stale-incarnation records, and the retirement of an empty draining host;
  - nestd: the suspend commit, the fence of an incarnation whose lease a heartbeat revoked, and its salvage;
  - SandboxDO: the wake, and what it does when told of an eviction;
  - AWS: the instance taken at the notice's deadline.
- **Safety:**
  - `NoLossByRetire`: FleetDO's own termination never destroys work. What a retired host held was committed or salvaged.
  - `NoRefusedLoss`: nothing a guest wrote is dropped by a salvage refused because the sandbox moved on.
  - `EvictedClean`: a sandbox off its lease and not yet recorded stale holds nothing uncommitted.
- **Timeliness:** `DrainsInTime`: a host FleetDO emptied is retired by FleetDO, not left for AWS to take. It assumes the system does everything it can before the clock moves (so every commit that doesn't fail fits the notice, the docs' size rule).
- **Lost by design:** a resident whose suspend commit fails keeps running, and at the deadline loses what it wrote since its last commit (`MC_reach_kill_loss`). Nothing but an operator asks again.
- **Past bugs** (found 2026-11-18, each fixed in FleetDO with a test in `control-plane/test/fleet.test.ts` that failed before its fix):
  - **A destroyed sandbox's stale incarnation waited out the salvage window.** Observed on use1 at 16:03 UTC: `sbx_01m7qkd3a1ccj1mf9ey9qyqzgn` was destroyed at 15:58:21 and its host fenced it on a heartbeat at 15:58:22, before its `sandbox_destroy` ran. FleetDO recorded the `fenced` as a stale incarnation; the destroy then deleted the incarnation under its retire, which reports nothing in that case (`retire_now`, "a destroy took it"), so the row stayed unsalvaged for 11 minutes. A spot notice at 16:03:36 suspended both residents in 21 s, the host couldn't be retired, and AWS took it. `MC_old_destroyed`. Fix: `reapStale` doesn't wait for a destroyed sandbox's incarnation. That the destroy deleted the incarnation mid-retire is inferred from the code and the log's timing, not seen in the log.
  - **A wake resumed a VM off its lease.** Drain evicts a suspended lease; before SandboxDO is told, a wake sends `sandbox_resume` to the old host; the VM runs and writes; the host, with no lease and no stale record yet, is retired (`MC_old_wake`: Drain, Wake, HostResume, Write, Retire), or the sandbox is placed elsewhere and the old incarnation's salvage refused (`MC_old_wake_refused`). The same with the wake first: the lease still reads `suspended` when the drain evicts it (`MC_wake_lease_only`). Found by the model; reproduced against the Durable Objects, not seen in production. Fix: `issueCommands` refuses a resume for a sandbox its host holds no lease on, and a lease with a resume unanswered is suspended, not evicted. The idle retirement had the same hole (hosts inventory B8) and takes the same rule.

## Results

TLC v1.7.4, 2026-11-18. **Bounds:** one host, two sandboxes, a 2-tick notice, a 4-tick salvage window, two writes, and at most one failed suspend, one wake and one repeated operator drain. Each result is exhaustive within them.

| Config | Result | Meaning |
|---|---|---|
| `MC_spot`, `MC_operator` | hold | As built: a spot drain and an operator's lose nothing by retirement or a refused salvage and finish in time, with a wake and a failed suspend. |
| `MC_spot_stale`, `MC_spot_destroyed` | hold | A stale incarnation doesn't delay the drain: one FleetDO hears retired is reaped at once, and so is a destroyed sandbox's, which it never hears of. |
| `MC_old_destroyed` | violates `DrainsInTime` | Before the fix (above). |
| `MC_old_wake`, `MC_old_wake_refused` | violate `NoLossByRetire`, `NoRefusedLoss` | Before the fix (above). |
| `MC_wake_busy_only`, `MC_wake_lease_only` | violate `NoLossByRetire` | Each half of the wake fix alone leaves a loss. |
| `MC_wake_stale`, `MC_wake_stale_refused` | holds; violates `NoRefusedLoss` | A fix shape not taken: recording the evicted incarnation stale in the eviction's step stops the retirement loss but not the refused salvage. |
| `MC_mut_*` | violate `NoLossByRetire` | Each guard is load-bearing: evicting only suspended leases, reporting `suspended` after the commit, retiring only with no lease, and retiring only with no unsalvaged stale incarnation. |
| `MC_reach_*` | violate | Retirement, a kill while holding a lease, a kill that loses work, a re-placement, a resume, and (before the fix) a resume off the lease are all reached. |

## Conformance

**Dated pass: 2026-11-18**, the fixes' change on `main` at `e655ace`. Paths: `fleet.ts` and `sandbox.ts` are in `control-plane/src/do/`, `host.rs` in `crates/nestd/src/`. The verdicts mean what they mean in [sandbox-lease](../sandbox-lease/conformance/).

| Action | Code | Conforms | Notes |
|---|---|---|---|
| Drain, DrainAgain | `drain` `fleet.ts:2575`, from `spot_notice` `1485` and `drainHost` `2565` | yes | The status, the evictions (`recordEvictions` `2629`) and the suspends are one synchronous step; `processEvictions` is awaited after. `ResumeIsBusy`: `resumesUnanswered` `1261`, read in that step. Brains (`tellDraining`) aren't modelled. |
| ReportSuspended | `handleEvent` `sandbox_state` `fleet.ts:1458` | partly | The code awaits `SandboxDO.reportState` before the eviction; the model takes them as one step. |
| Evicted, Replace | `processEvictions` `fleet.ts:2660`, `evicted` `sandbox.ts:854` | partly | Whether an evicted sandbox is placed again is a free choice in the model; in the code it follows from an agent mid-turn. |
| Wake | `wake` `sandbox.ts:797`, `command` `1024`; the refusal in `issueCommands` `fleet.ts:1697` | yes | The command goes to `info.host`; `ResumeNeedsLease` is `holds(host, sandbox, epoch)`. The refusal is retryable, and a later wake finds the sandbox unplaced. |
| HostResume, ReportRunning, ResumeAnswered | `resume` `host.rs:2106`; `handleEvent` `sandbox_state`, `command_result` | yes | nestd resumes unless the incarnation is fenced, and emits `running` before the command returns, so the report precedes the result on the ordered channel. |
| HostSuspend, SuspendFail | `suspend` `host.rs:2026` | not checked | Taken from the docs and `drainHost`'s comment: `suspended` is reported after the commit, and a failed commit leaves the VM running. That a host runs a sandbox's commands in the order issued is assumed. |
| HostFence | `host.rs:1088` | yes | |
| ReportFenced | `handleEvent` `sandbox_state` from a non-holder `fleet.ts:1448` | yes | |
| Salvage, ReportRetired | `retire_now` `host.rs:1421`, `1480`; `incarnation_retired` `fleet.ts:1439` | partly | The salvage's acceptance is abstracted to "the sandbox hasn't been placed elsewhere" (`decideCommit` isn't modelled). `RetiredReported = FALSE` is `retire_now`'s early return when a destroy deleted the incarnation. |
| WindowPass, Reap, HostDestroy | `reapStale` `fleet.ts:1271`, `SALVAGE_WINDOW_MS` `287`, `sandboxDestroyedHere` `1251` | yes | `ReapDestroyed`. |
| Retire | `scaleDown`'s draining loop `fleet.ts:2515` | partly | The loop also waits for the host's brains (`host_agents`), which aren't modelled. The idle retirement (`2500`) isn't modelled; it has a test. |
| AwsKill | EC2 | n/a | After it, the lease expiry, STONITH and reassignment are [SandboxLease](../sandbox-lease/)'s subject. |

**Abstracted:** one host; epochs; lost messages, resets and reconnects (the reliable channel is [nestd/](../nestd/)'s subject); the host going silent while draining (hosts inventory B5); memory snapshots (the drain suspends `disk_only`).
