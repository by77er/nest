# Fencing

Ensures that only one copy of a sandbox runs and commits at any time.

## 1. Storage: epoch plus compare-and-set

SandboxDO issues a new epoch with every [placement claim](../../control-plane/durable-objects/sandbox/#placement), and FleetDO grants the host's lease at that epoch. SandboxDO accepts `commit(epoch, parent, manifest)` only when the epoch is current and the parent is the head. A stale host can do no harm: chunks are immutable, and the head moves only through the DO.

## 2. Execution: leases and self-fencing

- **Heartbeat** every 5 s.
- **The host** treats its lease as expired **20 s after it *sent*** the renewal.
- **The DO** waits **30 s** before treating it as expired. The gap absorbs clock drift, and both sides measure durations, not timestamps.
- **On local expiry,** nestd freezes the VMs, then stops them so their memory goes back to the host, keeping each disk for the salvage commit, and drops their proxy listeners and netns. Once a salvage lands (or SandboxDO refuses it for good) nestd deletes that disk and reports the incarnation retired. The control plane sends that host `sandbox_destroy` at the fenced epoch once the lease has moved off that incarnation and the incarnation is clean or the salvage window (11 min) has passed, which reaps whatever is left and the summary row ([FleetDO](../../control-plane/durable-objects/fleet/)). A sandbox fence never touches brains, and sandbox hosts run none ([brain hosts](../../compute/brain-hosts/)): a brain host whose lease lapses kills its brains the same way, and AgentDO restarts them elsewhere under a new agent epoch once FleetDO expires the host at 30 s ([runner](../../agents/runner/)). The deadline is also checked on `CLOCK_BOOTTIME`, so a host that was suspended notices the lapse when it wakes.
- **Fencing is authoritative and never waits:**
  - **Immediate:** a `fence` command (or a revoked lease) takes effect when it arrives, not behind slow commands. The command result is still reported in order.
  - **Terminal per epoch:** an in-flight create, resume or suspend that finishes after a fence can't move the sandbox back to `running`. Long operations re-check for a fence after every await.
  - **Proxy:** nest-proxy refuses to re-add an epoch it dropped for fencing.
  - **Without the sandbox lock:** vCPUs are frozen through a pause handle that doesn't need it, and egress is dropped through a proxy link that never blocks. Bindings die with the epoch: the [gateway](../gateway/) and the guest refuse hands calls for any other, so no brain needs to be told.
- **If nestd crashes,** its VMs die with it: a death signal on every VM process, and jailed VMMs in a cgroup under nestd's delegated unit cgroup, which systemd kills on the restart; the next nestd also kills any leftover before it looks at a disk (unverified on a real host; [nestd](../../compute/nestd/)). It never runs what it finds: an incarnation whose disk equals its head is deleted unreported, every other one is reported `fenced` in its first hello, salvaged, then deleted.
- **Heartbeats are evidence, not authority.** They renew leases, and their silence lets FleetDO expire them; they never move a sandbox's placement. Only a claim and its epoch do.

## 3. STONITH before reassigning

Before a sandbox on a host whose lease expired is placed again, FleetDO terminates the old instance through the cloud provider's API and waits for EC2 to confirm it dead. A host that reconnects first proves it instead with a successful `fence` of every expired lease (STONITH by fence); its fenced incarnations are salvaged and destroyed as below. A silent host holding no live lease gets no STONITH: nothing of it can run twice. **If termination can't be confirmed, the sandbox is not run twice:** we wait or ask me. An unreachable host means defer, never destroy: nothing of its sandboxes' state or generations is deleted because it went quiet.

Every STONITH is to record each sandbox's loss explicitly ("work since generation G at T lost") ([losses](../../control-plane/durable-objects/sandbox/#losses)), which reaches its attached agents with the move notice (not built: the move notice carries only the new epoch and host). The loss is bounded by the [commit cadence](../state/#writeback-cadence); salvage may still recover it (below).

## 4. External side effects

- Every sandbox event and commit carries `(sandbox, epoch)`, every hands call carries the sandbox epoch inside its binding, and platform tool calls carry the agent epoch; stale ones are rejected. A superseded brain is gone before its agent's next brain starts elsewhere ([AgentDO](../../control-plane/durable-objects/agent/)).
- Brokered actions carry `(agent, epoch, call_id)`, rejected when stale, and use a natural idempotency key for the external effect (e.g. `(repo, head, base)` for a PR).
- A `PreToolUse` gate blocks, for example, `git push` from a stale sandbox epoch; the runner knows the epoch from its binding (not built: the gateway's refusal of a stale binding stops such a push today).
- Pushes use `--force-with-lease` (a template convention).

## 5. Salvage

If a host that was fenced off comes back with uncommitted work, it commits that work as a **sibling branch** off its last parent, which SandboxDO keeps as an orphan and logs (no [owner event](../../control-plane/api/clients/#events-to-the-owner) carries it). No agent work is silently lost.

The same happens when a newer epoch of a sandbox is created on a host that still has an older, dirty incarnation: the old work is salvaged in the background from its own directory (incarnations never share a disk), and the new one doesn't wait. A salvage that fails transiently is retried with backoff until it lands or the incarnation is destroyed; one refused for good is dropped and logged. A commit rejected for a stale epoch or a parent that isn't the head fences the sandbox and offers its work as salvage too. Salvage holds the sandbox lock only while chunking, never while waiting for the control plane. Salvage can't flush the guest (a fenced VM never runs again), so its cut is crash-consistent ([disk](../state/disk/#flush-before-commit)).

**On reconnect,** every VM FleetDO's lease doesn't honor (another host or epoch, or expired) is fenced at `hello`, salvaged if dirty, then destroyed. It never resumes.

## Failover timeline

```
t=0    last heartbeat
t=20s  host self-fences (if alive)
t=30s  DO lease expires → terminate the instance → confirmed (or the host reconnects and fences) → loss recorded ("work since G at T"; not built)
t≈35s  new claim, epoch+1 → place on another host → lazy restore of head (disk-only → cold boot); the brain, on its brain host, re-resolves its binding and is told what was lost (not built)
       → completion CAS once the host reports the VM running, guest hello and agent ready (evidence-checked completion not built)
```
