# nestd

The per-host daemon. It's trusted, but it's fenced.

- **Both host kinds.** On sandbox hosts it runs sandboxes and everything beside them; on [brain hosts](../brain-hosts/) it enrolls, holds the lease, delivers lifecycle commands to the [agent runner](../../agents/runner/) and self-fences. nestd knows nothing about hands: a brain reaches a sandbox through the sandbox's [gateway](../../sandbox/gateway/), and the nestd ↔ runner link carries lifecycle only ([nestd-runner](../../interfaces/host-internal/nestd-runner/)).
- **Sandboxes:** runs them through [drivers](../../sandbox/drivers/), and sets up each one's netns (tap0, nft, **listening sockets handed to nest-proxy**), and (planned) its ublk daemon and UFFD handler. It starts or resumes a VM only after nest-proxy acknowledges the sandbox's policy ([policy changes](../../sandbox/networking/egress/policy/#changes)), and it installs the root-namespace rule that rejects nest-proxy's non-public egress ([kernel backstop](../../sandbox/networking/egress/steering/#kernel-backstop)). See [../../sandbox/networking/egress/steering/](../../sandbox/networking/egress/steering/).
- **The gateway and cloudflared** (sandbox hosts): nestd launches both. It hands the gateway the cell's binding verification key and every binding revocation over `/run/nest/gateway.sock`, restarts a crashed gateway (its open calls are cancelled; bindings are verified, not stored, so none is lost), and starts cloudflared with the tunnel token enrollment returned ([gateway](../../sandbox/gateway/), [ingress](../../sandbox/networking/ingress/)). **Not built:** the gateway, cloudflared and `gateway.sock`; today nestd passes the runner a sandbox's vsock path for hands.
- **Privilege split:** nestd is the only privileged component. nest-proxy, the gateway and the agent runner run unprivileged.
- **Control plane connections:**
  - one control WebSocket to FleetDO, with a 5 s heartbeat that acts as the lease
  - on brain hosts, one WebSocket per active agent from the runner to its AgentDO, carrying the session stream
  - events batched every 1–2 s
- **Fleet channel resilience:**
  - **Liveness:** no inbound message for about 2.5 heartbeat intervals means the connection is presumed dead, and nestd reconnects.
  - **Retryable errors:** a retryable error from FleetDO also triggers a reconnect, which resends every unacknowledged batch.
  - **Bounded outbox:** audit batches are merged, and when the outbox overflows while offline, low-value events (audit, capacity, egress-denied, port-opened) are dropped first.
  - **Heartbeat timing:** heartbeat keys strictly increase, and the lease deadline is checked on both `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME`, so a host waking from suspend notices that its lease has lapsed.
- **Stamps** sandbox and epoch on everything that comes from a guest.
- **Flushes before every cut:** asks the guest agent to `syncfs` (30 s budget), `fsync`s the ublk device, then flips the disk epoch. A failed flush fails the commit, pause or suspend ([disk](../../sandbox/state/disk/#flush-before-commit)).
- **Pending uploads:** frozen sets cut but not yet committed, per sandbox. A drain's list is all-or-nothing: if any entry can't be read, the whole answer is an error ([drain gate](../../control-plane/durable-objects/fleet/)).
- **Restore ABIs:** computes the ABIs it can create and load from the bytes it runs (never from version strings) and advertises them in `hello` and `capacity` ([restore ABI](../../sandbox/state/memory/#restore-abi)).
- **Ingress guards** (with the gateway): counts each sandbox's in-flight responses and open WebSockets and terminals, and reports changes to SandboxDO as evidence. A stream whose client stops reading stops counting until it reads again, and stops for good after 2 h ([idle rule](../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Idle re-check:** before a pause or suspend, re-checks running turns and ingress guards under the sandbox lock and answers `busy` rather than freezing work.
- **Disk rate limits:** sets each drive's Firecracker rate limiter from the sandbox's limits ([I/O limits](../../sandbox/state/disk/#io-limits)).
- **Base generations:** prepares one in a scratch VM when FleetDO asks ([base generations](../../sandbox/state/memory/#base-generations)).
- **Self-fences** when its local lease expires. On a sandbox host: pauses the VMs, tells the proxy to drop their listeners, tells the gateway to refuse their bindings and removes their netns. On a brain host: stops the runner's brains. See [../../sandbox/fencing/](../../sandbox/fencing/).
- **Fencing doesn't wait on anything:**
  - `fence` commands take effect when they arrive, not behind slow commands.
  - `Fenced` is terminal for its epoch.
  - VMs are paused through a pause handle that doesn't need the sandbox lock.
  - The link to nest-proxy never blocks: sends time out, and a ping watchdog catches a wedged proxy.
  - The sandbox lock is never held while waiting for a commit result.
- **Per-sandbox rate limits** apply to everything a sandbox can make nestd emit: egress denials and alerts (deduplicated), audit records, port reports (merged), `nest` CLI relays (with a concurrency cap) and task exits. See `crates/nestd/src/limits.rs`.
- **Control sockets** (`proxy.sock`, `runner.sock`, `gateway.sock`) carry secrets. They're mode `0660` with an optional group, the peer uid is checked with `SO_PEERCRED`, and only one peer is served at a time.
- **Housekeeping:** renews nest-proxy's intermediate CA (new key and CSR) when less than 48 h remain, and reports `capacity` when it changes (at least every 10 min).
- **Spot interruptions** (planned): poll instance metadata for the 2-minute notice, then cut every disk and run a prioritized checkpoint and commit ([spot notice](../../sandbox/state/#spot-notice-2-minutes)).
- **Process supervision** (planned): VMs in systemd scopes with `BindsTo=nestd`, and `WatchdogSec` on nestd, so if nestd dies its VMs die with it.
- **Credentials:** S3 access comes from the instance role. nestd has no R2 credentials; it reads R2 only through Worker-signed URLs from DOs.
- **Runs alongside** [nest-proxy](../../sandbox/networking/egress/), cloudflared and the [gateway](../../sandbox/gateway/) on sandbox hosts, and the agent runner on brain hosts.
