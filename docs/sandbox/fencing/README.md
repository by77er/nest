# Fencing

Ensures that only one copy of a sandbox runs and commits at any time.

## 1. Storage: epoch plus compare-and-set

SandboxDO issues a new epoch with every [placement claim](../../control-plane/durable-objects/sandbox/#placement), and FleetDO grants the host's lease at that epoch. SandboxDO accepts `commit(epoch, parent, manifest)` only when the epoch is current and the parent is the head. A stale host can do no harm: chunks are immutable, and the head moves only through the DO.

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
- **Heartbeats are evidence, not authority.** They renew leases, and their silence lets FleetDO expire them; they never move a sandbox's placement. Only a claim and its epoch do.

## 3. STONITH before reassigning

Before granting a new epoch, FleetDO terminates the old instance through the cloud provider's API and waits for confirmation. **If termination can't be confirmed, the sandbox is not run twice:** we wait or ask me. An unreachable host means defer, never destroy: nothing of its sandboxes' state or generations is deleted because it went quiet.

Every STONITH records each sandbox's loss explicitly ("work since generation G at T lost"), as a rollback notice on its `events` channel ([losses](../../control-plane/durable-objects/sandbox/#losses)). The loss is bounded by the [commit cadence](../state/#writeback-cadence); salvage may still recover it (below).

## 4. External side effects

- Every event, tool call and brokered action carries `(sandbox, epoch)`, and stale ones are rejected.
- Brokered actions carry `(agent, epoch, call_id)`, rejected when stale, and use a natural idempotency key for the external effect (e.g. `(repo, head_sha)`).
- A `PreToolUse` gate blocks, for example, `git push` from a stale epoch.
- Pushes use `--force-with-lease` (a template convention).

## 5. Salvage

If a host that was fenced off comes back with uncommitted work, it commits that work as a **sibling branch** off its last parent. An `orphaned_work` message is posted to the sandbox's `events` channel. No agent work is silently lost.

The same happens when a newer epoch of a sandbox is created on a host that still has an older, dirty incarnation: the old work is salvaged before the new one reuses the disk. A commit rejected for a stale epoch fences the sandbox and offers its work as salvage too. Salvage holds the sandbox lock only while chunking, never while waiting for the control plane. Salvage can't flush the guest (a fenced VM never runs again), so its cut is crash-consistent ([disk](../state/disk/#flush-before-commit)).

**On reconnect,** every VM whose epoch is below SandboxDO's current epoch is fenced at `hello`, salvaged if dirty, then destroyed. It never resumes.

## Failover timeline

```
t=0    last heartbeat
t=20s  host self-fences (if alive)
t=30s  DO lease expires → terminate the instance → confirmed → loss recorded ("work since G at T")
t≈35s  new claim, epoch+1 → place on another host → lazy restore of head (disk-only → cold boot + --resume)
       → completion CAS once the host reports the VM running, guest hello and agent ready
```
