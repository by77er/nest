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

## Results

TLC v1.7.4, 2026-11-18, the code as read at `e655ace`. **Bounds:** one host, two sandboxes, a 2-tick notice, a 4-tick salvage window, two writes, and at most one failed suspend, one wake and one repeated operator drain. Each result is exhaustive within them.

| Config | Result | Meaning |
|---|---|---|
| `MC_spot`, `MC_spot_fail`, `MC_operator` | hold | With no wake and no stale incarnation, a spot drain and an operator's lose nothing by retirement and finish in time, a failed suspend included. |
| `MC_spot_stale_reported` | holds | A stale incarnation whose retirement reaches FleetDO is reaped at once and doesn't delay the drain. |
| `MC_spot_stale` | violates `DrainsInTime` | **Observed** (use1, 2026-11-18 16:03 UTC): a stale incarnation FleetDO never heard retired is kept for the 11-minute salvage window, which outlasts the 2-minute notice. Both residents were suspended in 21 s, AWS took the host, and FleetDO retired its record 16 minutes later as idle. |
| `MC_wake` | violates `NoLossByRetire` | **Suspected, not reproduced against the code:** Drain evicts a suspended lease; before SandboxDO is told, a wake sends `sandbox_resume` to the old host; the VM runs and writes; the host, with no lease and no stale record yet, is retired. Trace: Drain, Wake, HostResume, Write, Retire. |
| `MC_wake_refused` | violates `NoRefusedLoss` | The same wake, when the host fences first: the sandbox is placed elsewhere, and the old incarnation's salvage is refused for good. |
| `MC_wake_busy` | violates `NoLossByRetire` | Counting an unanswered resume as busy at the drain (the fix shape proposed for [B8](../hosts/)) doesn't close it: the wake can follow the drain. |
| `MC_wake_stale`, `MC_wake_stale_refused` | holds; violates `NoRefusedLoss` | Recording the evicted incarnation stale in the eviction's step (as `releaseFailedLease` does) keeps the host until it is fenced and retired, and the drain still finishes in time. The refused salvage remains: it needs the resume not to run off its lease. |
| `MC_mut_*` | violate `NoLossByRetire` | Each guard is load-bearing: evicting only suspended leases, reporting `suspended` after the commit, retiring only with no lease, and retiring only with no unsalvaged stale incarnation. |
| `MC_reach_*` | violate | Retirement, a kill while holding a lease, a kill that loses work, a re-placement and a resume off the lease are all reached. |

## Open

- **Why FleetDO never heard the 15:58 incarnation retired.** `sbx_01m7qkd3a1ccj1mf9ey9qyqzgn` was destroyed at 15:58:21; its host fenced it at 15:58:22 and logged "salvage refused for good" at 15:58:43; FleetDO issued its `sandbox_destroy` only at 16:09:24, the window's end. `retire_now` emits `incarnation_retired` after a refused salvage unless the state directory is already gone, and FleetDO's handler marks the row clean, so one of the two didn't happen. Not traced. The model takes it as a switch (`RetiredReported`).
- **The wake race** needs a vitest reproduction against the real Durable Objects before it counts as a bug in the code (start from `verification/repro/`), and a decision on the fix.

## Conformance

**Dated pass: 2026-11-18**, `main` at `e655ace`. Paths: `fleet.ts` and `sandbox.ts` are in `control-plane/src/do/`, `host.rs` in `crates/nestd/src/`. The verdicts mean what they mean in [sandbox-lease](../sandbox-lease/conformance/).

| Action | Code | Conforms | Notes |
|---|---|---|---|
| Drain, DrainAgain | `drain` `fleet.ts:2549`, from `spot_notice` `1467` and `drainHost` `2539` | yes | The status, the evictions (`recordEvictions` `2597`) and the suspends are one synchronous step; `processEvictions` is awaited after. Brains (`tellDraining`) aren't modelled. |
| ReportSuspended | `handleEvent` `sandbox_state` `fleet.ts:1440` | partly | The code awaits `SandboxDO.reportState` before the eviction; the model takes them as one step. |
| Evicted, Replace | `processEvictions` `fleet.ts:2628`, `evicted` `sandbox.ts:854` | partly | Whether an evicted sandbox is placed again is a free choice in the model; in the code it follows from an agent mid-turn. |
| Wake, HostResume | `wake` `sandbox.ts:797`, `command` `1024`; `resume` `host.rs:2106` | yes | The command goes to `info.host`, whatever FleetDO's lease says, and nestd resumes unless the incarnation is fenced. |
| HostSuspend, SuspendFail | `suspend` `host.rs:2026` | not checked | Taken from the docs and `drainHost`'s comment: `suspended` is reported after the commit, and a failed commit leaves the VM running. |
| HostFence | `host.rs:1088` | yes | |
| ReportFenced | `handleEvent` `sandbox_state` from a non-holder `fleet.ts:1430` | yes | |
| Salvage, ReportRetired | `retire_now` `host.rs:1421`, `1480`; `incarnation_retired` `fleet.ts:1421` | partly | The salvage's acceptance is abstracted to "the sandbox hasn't been placed elsewhere" (`decideCommit` isn't modelled). |
| WindowPass, Reap, HostDestroy | `reapStale` `fleet.ts:1256`, `SALVAGE_WINDOW_MS` `287` | yes | |
| Retire | `scaleDown`'s draining loop `fleet.ts:2489` | partly | The loop also waits for the host's brains (`host_agents`), which aren't modelled. |
| AwsKill | EC2 | n/a | After it, the lease expiry, STONITH and reassignment are [SandboxLease](../sandbox-lease/)'s subject. |

**Abstracted:** one host; epochs; lost messages, resets and reconnects (the reliable channel is [nestd/](../nestd/)'s subject); the host going silent while draining (hosts inventory B5); memory snapshots (the drain suspends `disk_only`).
