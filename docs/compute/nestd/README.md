# nestd

The per-host daemon. It's trusted, but it's fenced.

- **Brains:** hosts the [agent runner](../../agents/runner/) for agents whose sandboxes are here. Hands RPC goes over local vsock.
- **Sandboxes:** runs them through [drivers](../../sandbox/drivers/), and sets up each one's netns (tap0, nft, **listening sockets handed to nest-proxy**), and (planned) its ublk daemon and UFFD handler. See [../../sandbox/networking/egress/steering/](../../sandbox/networking/egress/steering/).
- **Privilege split:** nestd is the only privileged component. nest-proxy, the preview router (planned) and the agent runner run unprivileged.
- **Control plane connections:**
  - one control WebSocket to FleetDO, with a 5 s heartbeat that acts as the lease
  - one WebSocket per active agent to its AgentDO, carrying session streams (from the runner)
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
- **Ingress guards** (with the preview router): counts each sandbox's in-flight responses and open WebSockets and terminals, and reports changes to SandboxDO as evidence. A stream whose client stops reading stops counting until it reads again, and stops for good after 2 h ([idle rule](../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Idle re-check:** before a pause or suspend, re-checks running turns and ingress guards under the sandbox lock and answers `busy` rather than freezing work.
- **Disk rate limits:** sets each drive's Firecracker rate limiter from the sandbox's limits ([I/O limits](../../sandbox/state/disk/#io-limits)).
- **Base generations:** prepares one in a scratch VM when FleetDO asks ([base generations](../../sandbox/state/memory/#base-generations)).
- **Self-fences** when its local lease expires: stops the runner processes, pauses the VMs, tells the proxy to drop their listeners and removes their netns. See [../../sandbox/fencing/](../../sandbox/fencing/).
- **Fencing doesn't wait on anything:**
  - `fence` commands take effect when they arrive, not behind slow commands.
  - `Fenced` is terminal for its epoch.
  - VMs are paused through a pause handle that doesn't need the sandbox lock.
  - The link to nest-proxy never blocks: sends time out, and a ping watchdog catches a wedged proxy.
  - The sandbox lock is never held while waiting for a commit result.
- **Per-sandbox rate limits** apply to everything a sandbox can make nestd emit: egress denials and alerts (deduplicated), audit records, port reports (merged), `nest` CLI relays (with a concurrency cap) and task exits. See `crates/nestd/src/limits.rs`.
- **Control sockets** (`proxy.sock`, `runner.sock`) carry secrets. They're mode `0660` with an optional group, the peer uid is checked with `SO_PEERCRED`, and only one peer is served at a time.
- **Housekeeping:** renews nest-proxy's intermediate CA (new key and CSR) when less than 48 h remain, and reports `capacity` when it changes (at least every 10 min).
- **Spot interruptions** (planned): poll instance metadata for the 2-minute notice, then cut every disk and run a prioritized checkpoint and commit ([spot notice](../../sandbox/state/#spot-notice-2-minutes)).
- **Process supervision** (planned): VMs in systemd scopes with `BindsTo=nestd`, and `WatchdogSec` on nestd, so if nestd dies its VMs die with it.
- **Credentials:** S3 access comes from the instance role. nestd has no R2 credentials; it reads R2 only through Worker-signed URLs from DOs.
- **Runs alongside** [nest-proxy](../../sandbox/networking/egress/) and cloudflared plus the preview router (planned; [ingress](../../sandbox/networking/ingress/), which uses vsock).
