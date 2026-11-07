# nestd

The privileged per-host daemon (`docs/compute/nestd/`). It speaks the fleet channel to FleetDO and owns sandboxes, network namespaces, the nest-proxy listener handoff, the sandbox gateway's view of the host (keys, sandboxes, clients, guest versions), the guest control connection, leases and fencing; with the brain role (`controller`, or `brain`) it runs no sandboxes and only supervises the runner (a brain host, `docs/compute/brain-hosts/`): its config may name no `driver`, netns `network`, S3 `storage`, `cloudflared_bin` or `gateway_url` (`Config::validate`), it binds no proxy or gateway socket, sends no proxy CSR, and refuses every sandbox command. A sandbox host needs a `driver`. It carries nothing about hands to the runner: a brain reaches a guest through the gateway with a binding from AgentDO.

```
cargo build -p nestd
nestd --config /etc/nest/nestd.json          # RUST_LOG=debug for detail
nestd --features                             # what install scripts check for, one per line (`nestd::FEATURES`): `gateway-user`
```

## Modules

| Module | What |
|---|---|
| `config` | JSON config: role, cell, enrollment, driver, network, timings |
| `enroll` | Enrollment: an IMDSv2 identity document with its `rsa2048` signature, or a one-time token. Sends a CSR for the proxy's intermediate CA; the key stays local |
| `fleet` | Fleet WebSocket: the I/O shell around `nestd_core::fleet`, which decides everything below. Hello/hello_ack, a reliable seq'd `events` outbox with resend, `commands` taken strictly in order from the hello_ack's baseline (a gap reconnects) and deduplicated, and heartbeats. Lease renewal is measured from the send time of the acknowledged heartbeat, on monotonic and `CLOCK_BOOTTIME` clocks. Heartbeat keys strictly increase. Liveness reconnect, reconnect and resend on retryable errors, and a bounded outbox that merges and drops low-value events first |
| `host` | Core: in-order command executor (exactly one `command_result` per command, deduplicated by `cmd`), sandbox lifecycle, commit compare-and-set (lock released while waiting), fencing and self-fencing, event relay, CA renewal, capacity reports |
| `limits` | Per-sandbox token buckets for guest- and proxy-originated events |
| `net` | Netns with no uplink: `unshare(CLONE_NEWNET)` in a helper thread, tap0 plus the nft ruleset, listeners bound inside the namespace via `setns` on a fresh thread |
| `proxy_link` | nestd ↔ nest-proxy over SEQPACKET + `SCM_RIGHTS`. A state mirror plus sequence-tagged ops gives a full resync on every reconnect with nothing lost or duplicated. `apply` never blocks: queued ops carry duplicated fds, and sends have a timeout. Also: ping watchdog, resync count check, refusal of tombstoned (fenced) epochs, socket access control |
| `tombstones` | The host's one map of fenced epochs, written by the host core's fence and consulted by the proxy and gateway links; pruned when a newer epoch runs here or the sandbox is destroyed |
| `recovery` | Per-incarnation directories (`sandboxes/<id>/<epoch>/`) and their versioned `meta.json` (sandbox, epoch, head, whether the disk equals it, an unanswered commit request; written atomically), and the start-up scan of what a previous nestd left |
| `cgroup` | The delegated unit cgroup (`<unit>/supervisor`, `<unit>/vms` for the jailer) and the start-up kill of leftover VMM cgroups |
| `runner_link` | nestd ↔ agent runner, lifecycle only. One brain table keyed by (agent, agent epoch); never replays a start: when the runner connection drops, each start sent on it is reported `agent_exited{crashed}` (or `fenced`) and AgentDO restarts it. Drops stale `agent_exited{fenced}` from an earlier connection. Socket access control, one runner at a time |
| `gateway_link` | nestd ↔ sandbox gateway (`gateway.sock`). A mirror of the binding verification keys and, per sandbox, the epoch, the vsock socket, the attached clients and the guest's version; replayed in full on every (re)connection and closed with `resync_done`, then deltas on attach, detach, boot, resume, the guest's hello, fence and teardown. Ping every 5 s, a silent gateway is dropped after 15 s. Socket access control, one gateway at a time |
| `guest` | Guest control connection (vsock 1024): hello (the guest's version and capabilities are kept and reported with `running`), configure (complete slot set), resume after restores, prepare_snapshot/thaw, attach/detach; relays ports, CLI and task events |
| `vsock` | Hybrid-vsock `CONNECT` client and the unix-socket emulator (test transport) |
| `driver` | `Driver`/`Vm`/`Pauser` traits; `supervise` forks every VM process from one long-lived thread with a death signal, records a pidfile, and kills leftovers at start; every VM has a pause handle that works without the sandbox lock. `process` runs the guest agent as a child (in the netns, leading a session of its own); its pause, resume and stop act on the guest's whole process tree, its session and descendants, through pidfds (`tree`: a freeze stops every member until none runs, resume continues only what the freeze stopped, stop kills them all). `firecracker` uses the API over its unix socket (regular pages unless `huge_pages` is set, tap0, vsock CID 3, pause/snapshot); the jailer path takes uid/gid/chroot and uses jail-relative paths; `access` gives the gateway's group each VM's vsock socket (`0660`) and, jailed, search on the jail root (`0710`) once the VM has started, through `O_PATH \| O_NOFOLLOW` descriptors checked for kind and owner (a jailed VMM owns its chroot); the API socket is `0600` and the jailed disk `0600` |
| `storage` | Content-addressed chunks and manifests. Hole-aware disk chunking (`SEEK_DATA`) in two phases: `scan_file` (or `rescan_unchanged` for a disk known unchanged) while the disk is stable, holding back uploads, then `publish` after the VM resumes. `LocalFsStore` backend. On restore, chunk names and every chunk's and manifest's hash are verified |
| `s3` | The cell's S3 store: SigV4 with the instance role, a capped write-through cache, parallel transfers, retries, multipart, and the 12 h reuse rule (`REUSE_MS`) |
| `gc` | One object-store GC pass for FleetDO: mark from the roots it snapshots, sweep unmarked versions past the 24 h grace, fail closed |
| `credentials` | What enrollment gave the host (host id, token, fleet URL, proxy intermediate, tunnel token), kept root-only so a restart reconnects without re-enrolling |
| `cloudflared` | The host's Cloudflare Tunnel as nestd's child, and its `/ready` poll (`none`, `connecting`, `connected`) |

## Example config

```json
{
  "role": "sandbox",
  "cell": "use1",
  "control_url": "https://nest.example.com",
  "enrollment": {"type": "aws_imds"},
  "driver": {"type": "process", "guest_command": ["/usr/lib/nest/nest-guest"]},
  "network": {"type": "netns", "persist_dir": "/run/netns"},
  "sockets": {"gid": 990, "proxy_uids": [991], "runner_uids": [992], "gateway_uids": [993], "gateway_gid": 993},
  "gateway_url": "ws://127.0.0.1:18790",
  "cloudflared_bin": "/opt/nest/bin/cloudflared",
  "cloudflared_user": "nest-cf"
}
```

`sockets`: who may connect to `proxy.sock`/`runner.sock`/`gateway.sock`. Empty lists allow only nestd's own euid and root. `gateway_gid` is the gateway's own group (`nest-gw` on a host): it owns `gateway.sock` in place of `gid`, and each VM's vsock socket and jail root (`driver/access.rs`), so a gateway running as its own user can dial the guests; unset, the vsock sockets keep the VMM's umask mode and only root can reach them. `gateway_url`: where clients reach this host's sandbox gateway, reported in the fleet hello (the e2e harness uses `ws://127.0.0.1:18790`); omit it on a host that runs no sandboxes. `cloudflared_bin` and `cloudflared_user`: the cloudflared binary and the system user it runs as (`cloudflared.rs`). When the binary is set and enrollment handed the host a tunnel token, nestd runs `cloudflared --no-autoupdate tunnel --metrics <cloudflared_metrics> run` (default `127.0.0.1:18791`) as a child of its own: as `cloudflared_user` (a different user from nestd; a name that does not exist fails startup), with its environment cleared down to `PATH`, `HOME` (a directory under `state_dir`) and the token in `TUNNEL_TOKEN`. The token is never on a command line, where `/proc/<pid>/cmdline` is world-readable; `/proc/<pid>/environ` is readable only by that user and root, like the credentials file. The child's output goes to nestd's log at info; on every exit it is restarted with a backoff of 1 s doubling to 30 s (a revoked token makes cloudflared exit at once, so that loop warns every 30 s until the host is re-enrolled); at shutdown it gets SIGTERM, then SIGKILL after 5 s. Enrollment saves the token and the control plane's URL for the host in the credentials file whether or not `cloudflared_bin` is set, so a restart brings the tunnel back without re-enrolling; a token without a binary is logged every minute, because the control plane already advertises a tunnel URL for the host. Without a token, no tunnel. With the Firecracker driver in production, also set `"jailer_bin"` and `"jailer": {"uid": …, "gid": …, "chroot_base_dir": "/srv/jailer"}`. Without the jailer, Firecracker runs with nestd's privileges, which is for development only and is logged as a warning.

A brain host's config is the rest: `{"role": "controller", "cell": …, "control_url": …, "enrollment": …, "versions": …}`.

Development without a control plane: `"enrollment": {"type": "static", "host": "hst_dev", "host_token": "…", "fleet_ws_url": "ws://…"}`.

## Tests

`cargo test -p nestd` runs everything **unprivileged**: no root, no KVM. The netns tests need unprivileged user namespaces, `ip` (iproute2) and `nft` (nftables). They re-execute themselves under `unshare`, and the child must acknowledge that it ran the named test, so a renamed test fails instead of matching nothing. Without `unshare` they skip with a `NEST-TEST-SKIP:` line; CI sets `NEST_CI_REQUIRE_USERNS=1`, which turns a skip into a failure.

- **Unit tests:**
  - config parsing, rate limiter, vsock emulator handshake
  - sparse chunk/restore round trip; **untrusted manifests rejected** (path traversal, tampered chunk or manifest, inconsistent sizes)
  - a pass holds back its uploads until `publish` (and uploads at once past its budget); an unchanged file is read only where the store is in doubt, and a doubted chunk that no longer matches defeats the reuse; an S3 pass asks S3 nothing
  - proxy link:
    - resync and live fd handoff, including reconnect
    - **a stalled proxy never blocks `apply`**
    - **a bad or oversized packet is dropped, not the link**
    - **a resync count mismatch closes the connection**
    - **a second concurrent proxy is refused**, socket mode 0660
    - **fenced epochs can't be re-added**
  - runner link: replay on reconnect; **stale fenced exits after a replay are dropped**; a second concurrent runner is refused
  - gateway link: the replay (keys, sandboxes, `resync_done`) on connect and reconnect; deltas sent once, identical upserts not resent; **a second concurrent gateway is refused**; **a silent gateway is dropped after the pong timeout** (the test waits the real 15 s)
  - guest control:
    - configure/attach and reconnect with `resume`
    - **CLI and task frames during the resume handshake are routed**
  - Firecracker: API request bodies, HTTP over a unix socket, **jailed paths and jailer argv**
  - enrollment against a mock IMDS and Worker, **using the `rsa2048` signature**
- **`net::tests::netns_redirect_reaches_listener`** re-executes itself under `unshare --user --map-root-user --net`. The traffic from a "guest" netns to an arbitrary IP on `:443` is redirected to the gateway listener, and `:22` is dropped.
- **`tests/fleet.rs`** plays FleetDO frame by frame over a real WebSocket against the fleet link (the shell around `nestd_core::fleet`): the hello and resend after the peer's baseline, command forwarding and ack-after-results, re-forwarding at a reconnect, retryable errors and token rotation, heartbeat keys and lease renewal, the liveness drop, a foreign protocol version, offline shedding, and **a batch that overtakes a lower one makes the host reconnect**. The core's own step-level tests, its model checks, Kani proofs and mutation testing are in `crates/nestd-core` and `verification/nestd/` (`docs/verification/nestd/`).
- **`tests/host.rs`** uses a mock FleetDO that accepts reconnects and can simulate a partition, a fake driver whose guest sits behind the vsock emulator, and fake runner and proxy. The mock grants a 60 s lease, so load never self-fences a test (a loaded CI runner did, with the 500 ms one), except to the four tests about a lapse (`mock_fleet_lapsing`, `start_host_lapsing`); like FleetDO, it closes the connection on a failed or out-of-order events batch:
  - `host_lifecycle_commit_and_self_fence`:
    - create (`running` carries the guest's version), agent start (ids only to the runner, no guest slot), `agent_attach`/`agent_detach` (guest slot, the gateway's client set, idempotent re-attach, a stale epoch refused, detaching twice is `ok`), the gateway link's replay and the binding keys FleetDO pushes, guest CLI relay, task exit, port events
    - checkpoint compare-and-set
    - stale epoch rejection, and that a redelivered command isn't re-executed
    - self-fence about 500 ms into a partition (proxy drop, **a single runner fence**)
    - once the partition heals: `fenced` and the salvage commit are reported
  - **`fence_during_create_is_terminal`** (review #3): the lease lapses mid-boot. The create fails with `stale_epoch`, there's no `running` after `fenced`, nothing re-arms the proxy, and heartbeats stop claiming the sandbox.
  - **`fence_applies_on_arrival_behind_slow_commands`** (review #8)
  - **`retryable_fleet_error_resends_the_failed_batch`** (review #7)
  - **`an_unchanged_disk_is_committed_without_reading_it`** and **`a_reused_manifest_still_stores_every_chunk_it_names`** (M1): a checkpoint leaves the sentinel on the disk; bytes changed with the time put back show the next one didn't read; a write is always read; a chunk gone from the store is read back and stored again
  - M2, with the test cut (`disk_cut: locked_copy`): **`a_cut_answers_at_once_and_commits_the_disk_as_cut`** (the command answers before its commit is answered; the commit carries `cut_ms` and the disk as cut), **`cuts_coalesce_behind_a_commit_in_flight`** (three cuts, two commits, in order), **`a_suspend_waits_for_the_commit_in_flight_and_drops_the_queued_cut`**, **`a_commit_answered_after_a_fence_leaves_the_written_disk_to_salvage`** (both modes: the M1 path had this bug too), **`an_unchanged_disk_is_not_cut`**, **`a_fork_waits_for_its_cut_and_the_child_has_the_disk_as_cut`**
  - **`a_commit_answered_after_a_fence_leaves_the_written_disk_dirty`**: a checkpoint's VM resumes past its read; a fence stops it while the answer is awaited; the `committed` answer leaves the disk dirty (no VM may have run since the read: `Sbx::runs`), and the retire salvages what it wrote
  - **`a_failed_pass_leaves_nothing_to_reuse`** (review of #122: a memory suspend whose snapshot can't be read, then an unwritten disk, is read again), **`a_leaky_pause_never_reuses_a_manifest`** (a driver whose pause doesn't stop every write), **`a_replaced_disk_file_is_read`** (same size and sentinel time, another inode), **`a_fence_during_a_checkpoints_resume_freezes_the_vm_again`**
  - **`a_rejected_commit_never_resumes_its_vm`**: a rejected suspend never resumes; a rejected checkpoint's VM (resumed before the answer) is frozen through its pause handle and stopped
  - **`proxy_ca_is_renewed_before_expiry`** (review #10)
  - **`newer_epoch_create_salvages_old_work_first`** (review #17)
  - **`a_restarted_nestd_reports_salvages_and_deletes_what_it_left`** (nestd review #7): three processes on one state directory, each dying with its runtime. The second deletes a suspended (clean) incarnation unreported, removes an incarnation without `meta.json` and the old flat layout, reports the rest `fenced`, skips the salvage of a disk equal to its head (whose head has memory), and dies with a salvage answer lost; the third asks again under the persisted request id. The later processes run the process driver and boot nothing.
  - **`a_newer_create_races_the_salvage_of_what_a_dead_nestd_left`**, **`a_failed_salvage_is_retried_until_it_lands`**, **`a_final_salvage_refusal_ends_the_retire`**, **`a_fenced_incarnation_is_salvaged_once_even_when_superseded`**, **`a_newer_epoch_is_frozen_through_its_own_pause_handle`**
  - **`a_fenced_epoch_stays_stale_until_a_newer_epoch_runs`** (nestd review #12)
  - `a_restarted_nestd_tears_down_leftover_netns_mounts` (in a user namespace): a netns bind mount left under `persist_dir` is gone when `Host::start` returns
  - `netns_listeners_handed_to_proxy` (in a user namespace): real netns, tap0 and nft; five listeners reach the fake proxy, and its copy of `:443` accepts a connection made inside the sandbox netns.

## Not implemented yet (TODO)

- **The reflink cut and the extent diff** (M2, M3 in [disk](../../docs/sandbox/state/disk/)). A checkpoint pauses the VM while it reads a changed disk (uploads and the answer come after the resume; an unchanged disk isn't read). The ublk lazy disk is for restores only, later.
- **UFFD memory restore.** Restores from `checkpoint` generations cold-boot from the disk.
- **S3 Inventory** for the GC sweep (it lists object versions), and generation retention (every generation is a GC root).
- **Gateway features** beyond hands (`docs/sandbox/gateway/`): `port_expose` is recorded only; nothing on the host uses ingress port 10000 yet: no terminal attach, no `nest port-forward`. (Built: the gateway and `gateway.sock`, and cloudflared as nestd's child when configured, with its `/ready` polled so the fleet hello and `tunnel_state` events say whether the tunnel is `none`, `connecting` or `connected`.)
- **Live forks.** They're disk-only.
- **Firecracker** runs on EC2 sandbox hosts with nested virtualization and is verified there end to end ([driver](../../docs/sandbox/drivers/firecracker/)); this dev environment has no `/dev/kvm`, so locally the driver is unit-tested only.
- **The jailer's chroot hard-links** require the disk and kernel on the same filesystem as the chroot base.
- **`WatchdogSec`** on nestd, and **per-agent `DynamicUser` ownership** of config dirs. The delegated cgroup and the start-up VMM kill are built but unverified on a real host.
- **`capacity.warm`**, `drain` ending with nestd exiting, and the control `health` probe to the guest.
- **Remaining review items:**
  - **Clock-step heartbeat keys (#14):** handled by construction (keys strictly increase), but not tested.
  - **Rate limits (#6):** unit-tested in `limits`, not end-to-end.
