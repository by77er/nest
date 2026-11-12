# fencing audit (docs/sandbox/fencing/README.md)

## Corrections
| doc:line | what it said | what the code says | evidence file:line |
|---|---|---|---|
| docs/sandbox/fencing/README.md:14 | `sandbox_destroy` sent "once the sandbox lives elsewhere" | sent once the lease is no longer that (host, epoch), including while unplaced; dropped if superseded on the same host | control-plane/src/do/fleet.ts:1194-1210 (`reapStale`) |
| docs/sandbox/fencing/README.md:25 | STONITH = FleetDO terminates via cloud API and waits for confirmation, before granting a new epoch | Two proofs: EC2 confirms the instance dead (`pollStonith` -> `confirmHostDead`), or a reconnected host's successful `stonith_fence` of every expired lease (then `queueReassign`); a silent host with no live lease gets no STONITH (`expireSilent`). SandboxDO, not FleetDO, issues the new epoch | control-plane/src/do/fleet.ts:2874-2907, 2967-3011, 1497-1511; lib/host-lifecycle.ts:47-54 |
| docs/sandbox/fencing/README.md:27 | Every STONITH records each sandbox's loss, which reaches agents with the move notice | Not built: `leaseLost` writes no loss record; `onSandboxMoved(sandbox, epoch, host)` carries no loss. SandboxDO doc already says loss records aren't built | control-plane/src/do/sandbox.ts:862-891; docs/control-plane/durable-objects/sandbox/README.md:110 |
| docs/sandbox/fencing/README.md:32 | natural idempotency key e.g. `(repo, head_sha)` | `github.create_pr` key is `pr:repo:head:base` | control-plane/src/lib/brokered.ts:367-378 |
| docs/sandbox/fencing/README.md:33 | `PreToolUse` gate blocks `git push` from a stale sandbox epoch | Not built: runner hooks apply tool rules only; no epoch check. Gateway refuses stale bindings | crates/nest-runner/src/hooks.rs; crates/nest-gateway/src/verify.rs:117 |
| docs/sandbox/fencing/README.md:40 | commit rejected for a stale epoch fences | `stale_epoch` or `parent_mismatch` rejection fences | crates/nestd/src/host.rs:2886-2888 (`rejection_fences`) |
| docs/sandbox/fencing/README.md:42 | on reconnect, VMs with epoch below SandboxDO's current epoch are fenced at hello | FleetDO fences every reported sandbox its lease doesn't honor (other host/epoch, or expired), records it stale, destroys after salvage | control-plane/src/do/fleet.ts:1126-1148 (`reconcileSandboxes`) |
| docs/sandbox/fencing/README.md:49-51 | timeline: loss recorded; told what was lost; completion CAS | marked not built (loss records, evidence-checked completion); STONITH-by-fence alternative added | as above; docs/control-plane/durable-objects/sandbox/README.md:110 |

Confirmed (no change): heartbeat 5 s, host fence 20 s after *sent*, CP expiry 30 s (crates/nest-protocol/src/control.rs:22-27, control-plane/src/protocol/control.ts:13-15, nestd-core/src/fleet.rs:609-615); CLOCK_BOOTTIME + monotonic watchdog, 250 ms recheck (nestd-core/src/lease.rs, nestd/src/host.rs:1255-1285); fence path: lock-free pause, tombstone, proxy drop, stop VM, drop netns, retire/salvage with backoff, `incarnation_retired` (host.rs:1288-1445); Fenced terminal per epoch (host.rs:867-875); proxy refuses re-add of a fenced epoch (nest-proxy/src/state.rs:73,125,138); guest and gateway refuse other epochs (nest-guest/src/state.rs:126; nest-gateway/src/state.rs:155, verify.rs:117); 11 min salvage window (fleet.ts:271,1207); restart recovery deletes clean incarnations unreported, reports others fenced (host.rs:500-530, nestd-core incarnation.rs:218); decideCommit orphan salvage (lib/sandbox-lease.ts:226-237); brokered key (agent, epoch, call) (do/agent.ts:3398); --force-with-lease in projects/src/catalog.ts:81. All relative links/anchors resolve.

## Parent summary lines to update
- docs/architecture/README.md:87 — current: "The host self-fences at 20 s (pauses VMs); at 30 s FleetDO expires its leases and terminates the instance (STONITH), then each sandbox is claimed again ... its next tool result says the sandbox moved and what was lost". Suggested: "The host self-fences at 20 s (freezes then stops its VMs, keeping disks for salvage); at 30 s FleetDO expires its leases and terminates the instance (STONITH; a host that reconnects first proves it with a fence), then each sandbox is claimed again under a new epoch (loss records are designed), restoring from its last committed generation. ... its next tool result says the sandbox moved (what was lost: designed)".

## Unconfirmed claims
- docs/sandbox/fencing/README.md:20 — nestd crash kills VMs via death signal + delegated cgroup — already marked "unverified on a real host"; code exists (crates/nestd/src/driver/supervise.rs, cgroup.rs).
- docs/sandbox/fencing/README.md:50 — "t≈35s new claim" — an estimate; actual depends on EC2 terminate confirmation latency; no measurement record found.
- docs/sandbox/fencing/README.md:40 — "Salvage holds the sandbox lock only while chunking" — per host.rs:1362 comment; did not trace `commit` internals.

## Suspected code bugs
- None found in fencing logic.

## Drift outside the area
- control-plane/src/do/fleet.ts:268-270 comment: "nestd gives a salvage commit 600 s (`SALVAGE_TIMEOUT`)". No `SALVAGE_TIMEOUT` exists; nestd's salvage uses `commit_timeout` (default 60 s, crates/nestd/src/config.rs:421-423) and retries with backoff until destroyed. The 11 min window's rationale comment is stale (code comment, not doc).
- crates/nestd/src/host.rs:14 header comment says "brains are fenced through the runner" in the fence context; `fence_sandbox` touches no brains (only `self_fence` does). Minor.

## Docs with no drift
- (none besides the confirmed parts above)
