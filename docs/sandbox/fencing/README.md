# Fencing

Ensures that only one copy of a sandbox runs and commits at any time.

## 1. Storage: epoch plus compare-and-set

Each lease grant increments the epoch. SandboxDO accepts `commit(epoch, parent, manifest)` only when the epoch is current and the parent is the head. A stale host can do no harm: chunks are immutable, and the head moves only through the DO.

## 2. Execution: leases and self-fencing

- **Heartbeat** every 5 s.
- **The host** treats its lease as expired **20 s after it *sent*** the renewal.
- **The DO** waits **30 s** before treating it as expired. The gap absorbs clock drift, and both sides measure durations, not timestamps.
- **On local expiry,** nestd pauses the VMs, drops their proxy listeners and netns, and stops every agent runner process (brain) on the host. The deadline is also checked on `CLOCK_BOOTTIME`, so a host that was suspended notices the lapse when it wakes.
- **Fencing is authoritative and never waits:**
  - **Immediate:** a `fence` command (or a revoked lease) takes effect when it arrives, not behind slow commands. The command result is still reported in order.
  - **Terminal per epoch:** an in-flight create, resume or suspend that finishes after a fence can't move the sandbox back to `running`. Long operations re-check for a fence after every await.
  - **Proxy:** nest-proxy refuses to re-add an epoch it dropped for fencing.
  - **Without the sandbox lock:** vCPUs are frozen through a pause handle that doesn't need it, egress is dropped through a proxy link that never blocks, and brains are fenced through the runner.
- **If nestd crashes,** its VMs should die with it (systemd `BindsTo` plus a watchdog; planned, not implemented yet).

## 3. STONITH before reassigning

Before granting a new epoch, FleetDO terminates the old instance through the cloud provider's API and waits for confirmation. **If termination can't be confirmed, the sandbox is not run twice:** we wait or ask me.

## 4. External side effects

- Every event, tool call and brokered action carries `(sandbox, epoch)`, and stale ones are rejected.
- Brokered actions use an idempotency key of `(agent, epoch, call_id)`.
- A `PreToolUse` gate blocks, for example, `git push` from a stale epoch.
- Workstream pushes use `--force-with-lease`.

## 5. Salvage

If a host that was fenced off comes back with uncommitted work, it commits that work as a **sibling branch** off its last parent. The captain gets an `orphaned_work` event. No agent work is silently lost.

The same happens when a newer epoch of a sandbox is created on a host that still has an older, dirty incarnation: the old work is salvaged before the new one reuses the disk. A commit rejected for a stale epoch fences the sandbox and offers its work as salvage too. Salvage holds the sandbox lock only while chunking, never while waiting for the control plane.

## Failover timeline

```
t=0    last heartbeat
t=20s  host self-fences (if alive)
t=30s  DO lease expires → terminate the instance → confirmed
t≈35s  epoch+1 → place on another host → lazy restore of head (disk-only → cold boot + --resume)
```
