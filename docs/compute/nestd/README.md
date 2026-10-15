# nestd

The per-host daemon. It's trusted, but it's fenced.

- **Brains:** hosts the [agent runner](../../agents/runner/) for agents whose sandboxes are here. Hands RPC goes over local vsock.
- **Sandboxes:** runs them through [drivers](../../sandbox/drivers/), and sets up each one's netns (tap0, nft, **listening sockets handed to nest-proxy**), ublk daemon and UFFD handler. See [../../sandbox/networking/egress/steering/](../../sandbox/networking/egress/steering/).
- **Privilege split:** nestd is the only privileged component. nest-proxy, the preview router and the agent runner run unprivileged.
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
- **Spot interruptions** (planned): poll instance metadata for the 2-minute notice, then run a prioritized checkpoint and commit.
- **Process supervision** (planned): VMs in systemd scopes with `BindsTo=nestd`, and `WatchdogSec` on nestd, so if nestd dies its VMs die with it.
- **Credentials:** S3 access comes from the instance role. nestd has no R2 credentials; it reads R2 only through Worker-signed URLs from DOs.
- **Runs alongside** [nest-proxy](../../sandbox/networking/egress/) and cloudflared plus the preview router ([ingress](../../sandbox/networking/ingress/), which uses vsock).
