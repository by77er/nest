# nestd

The privileged per-host daemon (`docs/compute/nestd/`). It speaks the fleet channel to FleetDO and owns sandboxes, network namespaces, the nest-proxy listener handoff, the guest control connection, leases and fencing.

```
cargo build -p nestd
nestd --config /etc/nest/nestd.json          # RUST_LOG=debug for detail
```

## Modules

| Module | What |
|---|---|
| `config` | JSON config: role, cell, enrollment, driver, network, timings |
| `enroll` | Enrollment: an IMDSv2 identity document with its `rsa2048` signature, or a one-time token. Sends a CSR for the proxy's intermediate CA; the key stays local |
| `fleet` | Fleet WebSocket. Hello/hello_ack, a reliable seq'd `events` outbox with resend, `commands` dedup and heartbeats. Lease renewal is measured from the send time of the acknowledged heartbeat, on monotonic and `CLOCK_BOOTTIME` clocks. Heartbeat keys strictly increase. Liveness reconnect, reconnect and resend on retryable errors, and a bounded outbox that merges and drops low-value events first |
| `host` | Core: in-order command executor (exactly one `command_result` per command, deduplicated by `cmd`), sandbox lifecycle, commit compare-and-set (lock released while waiting), fencing and self-fencing, event relay, CA renewal, capacity reports |
| `limits` | Per-sandbox token buckets for guest- and proxy-originated events |
| `net` | Netns with no uplink: `unshare(CLONE_NEWNET)` in a helper thread, tap0 plus the nft ruleset, listeners bound inside the namespace via `setns` on a fresh thread |
| `proxy_link` | nestd ↔ nest-proxy over SEQPACKET + `SCM_RIGHTS`. A state mirror plus sequence-tagged ops gives a full resync on every reconnect with nothing lost or duplicated. `apply` never blocks: queued ops carry duplicated fds, and sends have a timeout. Also: ping watchdog, resync count check, refusal of fenced epochs, socket access control |
| `runner_link` | nestd ↔ agent runner. Keeps the desired set of brains and re-issues `agent_start` on reconnect. Drops stale `agent_exited{fenced}` queued before the reconnect. Socket access control, one runner at a time |
| `guest` | Guest control connection (vsock 1024): hello, configure (complete slot set), resume after restores, prepare_snapshot/thaw, attach/detach; relays ports, CLI and task events |
| `vsock` | Hybrid-vsock `CONNECT` client and the unix-socket emulator (test transport) |
| `driver` | `Driver`/`Vm`/`Pauser` traits; every VM has a pause handle that works without the sandbox lock. `process` runs the guest agent as a child (in the netns, SIGSTOP/SIGCONT pause). `firecracker` uses the API over its unix socket (2M hugepages, tap0, vsock CID 3, pause/snapshot); the jailer path takes uid/gid/chroot and uses jail-relative paths |
| `storage` | Content-addressed chunks and manifests. Hole-aware disk chunking (`SEEK_DATA`), `LocalFsStore` backend. On restore, chunk names and every chunk's and manifest's hash are verified |

## Example config

```json
{
  "role": "burst",
  "cell": "aws-us-east-1",
  "control_url": "https://nest.example.com",
  "enrollment": {"type": "aws_imds"},
  "driver": {"type": "process", "guest_command": ["/usr/lib/nest/nest-guest"]},
  "network": {"type": "netns", "persist_dir": "/run/netns"},
  "sockets": {"gid": 990, "proxy_uids": [991], "runner_uids": [992]}
}
```

`sockets`: who may connect to `proxy.sock`/`runner.sock`. Empty lists allow only nestd's own euid and root. With the Firecracker driver in production, also set `"jailer_bin"` and `"jailer": {"uid": …, "gid": …, "chroot_base_dir": "/srv/jailer"}`. Without the jailer, Firecracker runs with nestd's privileges, which is for development only and is logged as a warning.

Development without a control plane: `"enrollment": {"type": "static", "host": "hst_dev", "host_token": "…", "fleet_ws_url": "ws://…"}`.

## Tests

`cargo test -p nestd` runs everything **unprivileged**: no root, no KVM. The netns tests need unprivileged user namespaces, `ip` (iproute2) and `nft` (nftables). They re-execute themselves under `unshare`, and the child must acknowledge that it ran the named test, so a renamed test fails instead of matching nothing. Without `unshare` they skip with a `NEST-TEST-SKIP:` line; CI sets `NEST_CI_REQUIRE_USERNS=1`, which turns a skip into a failure.

- **Unit tests:**
  - config parsing, rate limiter, vsock emulator handshake
  - sparse chunk/restore round trip; **untrusted manifests rejected** (path traversal, tampered chunk or manifest, inconsistent sizes)
  - proxy link:
    - resync and live fd handoff, including reconnect
    - **a stalled proxy never blocks `apply`**
    - **a bad or oversized packet is dropped, not the link**
    - **a resync count mismatch closes the connection**
    - **a second concurrent proxy is refused**, socket mode 0660
    - **fenced epochs can't be re-added**
  - runner link: replay on reconnect; **stale fenced exits after a replay are dropped**; a second concurrent runner is refused
  - guest control:
    - configure/attach and reconnect with `resume`
    - **CLI and task frames during the resume handshake are routed**
  - Firecracker: API request bodies, HTTP over a unix socket, **jailed paths and jailer argv**
  - enrollment against a mock IMDS and Worker, **using the `rsa2048` signature**
- **`net::tests::netns_redirect_reaches_listener`** re-executes itself under `unshare --user --map-root-user --net`. The traffic from a "guest" netns to an arbitrary IP on `:443` is redirected to the gateway listener, and `:22` is dropped.
- **`tests/host.rs`** uses a mock FleetDO that accepts reconnects and can simulate a partition, a fake driver whose guest sits behind the vsock emulator, and fake runner and proxy:
  - `host_lifecycle_commit_and_self_fence`:
    - create, agent start with hands, guest CLI relay, task exit, port events
    - checkpoint compare-and-set
    - stale epoch rejection, and that a redelivered command isn't re-executed
    - self-fence about 500 ms into a partition (proxy drop, **a single runner fence**)
    - once the partition heals: `fenced` and the salvage commit are reported
  - **`fence_during_create_is_terminal`** (review #3): the lease lapses mid-boot. The create fails with `stale_epoch`, there's no `running` after `fenced`, nothing re-arms the proxy, and heartbeats stop claiming the sandbox.
  - **`fence_applies_on_arrival_behind_slow_commands`** (review #8)
  - **`retryable_fleet_error_resends_the_failed_batch`** (review #7)
  - **`proxy_ca_is_renewed_before_expiry`** (review #10)
  - **`newer_epoch_create_salvages_old_work_first`** (review #17)
  - `netns_listeners_handed_to_proxy` (in a user namespace): real netns, tap0 and nft; five listeners reach the fake proxy, and its copy of `:443` accepts a connection made inside the sandbox netns.

## Not implemented yet (TODO)

- **ublk lazy disk and the copy-on-write epoch flip.** Checkpoints currently pause the VM while chunking.
- **UFFD memory restore.** Restores from `checkpoint` generations cold-boot from the disk.
- **The S3 `ObjectStore`.**
- **Spot interruption handling** (IMDS polling, `spot_notice`).
- **The preview router.** `port_expose` is recorded only. Nothing on the host uses ingress port 10000 yet: no terminal attach, no `nest port-forward`.
- **Live forks.** They're disk-only.
- **Firecracker itself has never run** here (no `/dev/kvm` access): the driver's API calls are unit-tested only.
- **Jailer path untested against a real jailer.** The chroot hard-links require the disk and kernel on the same filesystem as the chroot base.
- **systemd supervision** (`BindsTo=nestd` scopes for VMs, `WatchdogSec`) and **per-agent `DynamicUser` ownership** of config dirs.
- **`capacity.warm`**, `drain` ending with nestd exiting, and the control `health` probe to the guest.
- **Remaining review items:**
  - **Clock-step heartbeat keys (#14):** handled by construction (keys strictly increase), but not tested.
  - **Rate limits (#6):** unit-tested in `limits`, not end-to-end.
