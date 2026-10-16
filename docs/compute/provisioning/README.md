# Provisioning

**Burst host image (built with Packer):**
- Amazon Linux 2023 with kernel 6.18 (or 6.1), the host kernels Firecracker supports on 8i ([README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)); Ubuntu 24.04's 6.8 isn't one of them. Hugetlb needs 5.18+ and ublk needs 6.0+; whether AL2023 ships ublk is unverified.
- Firecracker from the 1.17 line, pinned by binary digest, patch level included ([driver](../../sandbox/drivers/firecracker/)).
- `bubblewrap`: Claude Code needs it for the subprocess environment scrub nest relies on (see [runner-claude](../../interfaces/host-internal/runner-claude/)). The controller host image installs it too.
- Firecracker and jailer, gVisor (`runsc`), nestd, nest-proxy, cloudflared, **Claude Code + the agent runner** (brains for local sandboxes). The image carries the runner's pinned Claude Code version, checked by SHA-256 ([runner](../../agents/runner/)).

**Launch template:**
- Nested virtualization enabled, restricted to the 8i family.
- Prefer `d` variants for local NVMe.
- Reserve a `vm.nr_hugepages` pool at boot. The remaining memory is for the host and the snapshot page cache.

**Network:**
- Public subnet with public IPv4, no NAT.
- **S3 gateway endpoint.** It's free, and it lets the bucket policy require `aws:SourceVpce`.
- Security group: outbound 443, plus 7844 TCP and UDP for cloudflared. No inbound rules.

**IAM:**
- **Host instance role:** S3 access scoped to the cell's bucket.
- **Control-plane IAM user:** `RunInstances` with our launch template only; `Terminate` and `Stop` only on instances tagged `nest=true`; `Describe*`; `kms:Sign` on the proxy root CA key only ([TLS](../../sandbox/networking/egress/tls/)).

**Controller host image:** nestd, Claude Code, the agent runner and the `nest` binary, bubblewrap and the Discord gateway client. No hypervisor, no hugepages, no S3 access.

**Host authentication:**
1. An AWS host presents its **signed instance identity document** (from IMDS).
2. FleetDO verifies AWS's signature and checks that **it launched that instance ID** (and account and region) and hasn't enrolled it already.
3. FleetDO issues a short-lived host token, which rotates over the control WebSocket.

No secrets go in user-data. A host outside AWS (e.g. the controller host on a VPS) enrolls once with a one-time token I mint myself.

**Instance metadata service (IMDS):** require IMDSv2 with hop limit 1. nest-proxy blocks link-local and private ranges for sandboxes, so a guest can never reach IMDS or the instance role's credentials. A kernel rule on nest-proxy's uid rejects non-public destinations too, so a proxy bug can't reach them either ([kernel backstop](../../sandbox/networking/egress/steering/#kernel-backstop)).

## Upgrades

Hosts are replaced, never updated in place. Not built; it needs the autoscaler.

- **Versions:** host binaries (nestd, nest-proxy, the runner, `nest`, the guest agent) and images are built per release into the cell's bucket.
- **Rollout:** FleetDO holds a desired host version per cell. New hosts boot it, and old hosts are [drained](../autoscaling/) and terminated one at a time. The controller host is replaced the same way; its brains move after 30 s, like a lost host's.
- **Rollback:** set the desired version back and replace again.
- **Restore ABI:** each release records the [restore ABIs](../../sandbox/state/memory/#restore-abi) its hosts create and load. A release that changes nestd, the proxy, the runner or the guest agent keeps the ABI; one that changes Firecracker, the host or guest kernel, the CPU template or the VM profile changes it.
- **ABI-changing upgrades** leave dormant memory generations unloadable on the new hosts. They resume disk-only, with "process state lost" in the rollback notice, and no old hosts are kept for them ([restore ABI](../../sandbox/state/memory/#restore-abi)). The rollout's drains skip memory snapshots no new host could load, and rolling back makes generations still at head loadable again.
- **Guests:** cold boots use the new rootfs. Memory generations keep their guest agent, and the host accepts a range of guest protocol versions ([host-guest](../../interfaces/host-guest/)), so the guest agent isn't part of the ABI.
