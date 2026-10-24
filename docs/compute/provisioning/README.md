# Provisioning

Two host images, one per [host kind](../). Neither contains a secret ([identity](../../security/identity/)).

**Sandbox host image (EC2 Image Builder):**
- Amazon Linux 2023 with kernel 6.18 (or 6.1), the host kernels Firecracker supports on 8i ([README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)); Ubuntu 24.04's 6.8 isn't one of them. Hugetlb needs 5.18+ and ublk needs 6.0+; whether AL2023 ships ublk is unverified.
- Firecracker from the 1.17 line, pinned by binary digest, patch level included ([driver](../../sandbox/drivers/firecracker/)).
- Firecracker and jailer, gVisor (`runsc`), nestd, nest-proxy, cloudflared, the [gateway](../../sandbox/gateway/), and the guest kernel and `nest-base` image. The target has no Claude Code, no agent runner and no bubblewrap: nothing on a sandbox host runs a brain. **Today,** until [brain hosts](../brain-hosts/) exist, `deploy/host/install.sh` installs Claude Code, the runner and bubblewrap on every host too, and a burst host runs brains beside its sandboxes; the subscription token is in the brain's process environment on the host, never in a VM.
- **Built by the cell's Image Builder pipeline,** managed in the cell stack: AWS-native, no build host of ours. One install script runs in two places:
  - at build time, baked into the AMI;
  - at every boot, where it only fills what the AMI lacks.

  Booting a stale AMI, or stock AL2023, therefore still works. It is only slower.
- **The guest image is baked compressed and expanded on first boot.** EBS loads an AMI's blocks from its snapshot on first read. Sandbox disks are reflinked copies of the base image (XFS), so with a baked, expanded base every first commit read cold blocks: on EC2 the first turn-end commit hit its 60 s timeout.
- **Builds run on demand.** The pipeline writes the new AMI's ID to an SSM parameter, and the launch template resolves that parameter at each launch (`resolve:ssm:`). A new image therefore needs no stack change.
- **The builder runs in the cell's subnet.** Its role can only read the release, and it is not tagged `nest=true`, so STONITH can't reach it.
- cloudflared is pinned in `deploy/host/install.sh` by release version and SHA-256 (downloaded from the cloudflared GitHub release at image build, and at boot only when the installed binary's checksum differs; never committed), installed as `/opt/nest/bin/cloudflared`; bootstrap names it in nestd.json (`cloudflared_bin`).
- **Old images are pruned by an Image Builder lifecycle policy** (in the cell stack): the two newest images of the host recipe stay, the rest are deleted with their AMIs and snapshots, except an AMI that launched an instance in the last seven days, so failed builds cannot remove the AMI the launch template resolves to. Image Builder evaluates it on its own daily schedule.
- **Not built:** gVisor.

**Brain host image:** nestd, Claude Code, the agent runner and the `nest` binary, `bubblewrap` (Claude Code needs it for the subprocess environment scrub nest relies on; see [runner-claude](../../interfaces/host-internal/runner-claude/)) and the Discord gateway client. The image carries the runner's pinned Claude Code version, checked by SHA-256 ([runner](../../agents/runner/)). No hypervisor, no hugepages, no S3 access, no cloudflared. Built by the same pipeline from an ARM-capable AL2023 base, for the cheapest class that runs Claude Code ([brain hosts](../brain-hosts/)). **Not built.**

**Launch templates,** one per host kind:
- **Sandbox hosts:** nested virtualization enabled, restricted to the 8i family (the IAM policy allows `c8i*.*`, `m8i*.*`, `r8i*.*`; the instance types the autoscaler picks are a list in the cell stack, proved to fall inside those patterns, and written with the rest of `AWS_CELLS`). Prefer `d` variants for local NVMe. No hugepage pool: guest memory is regular pages, and bootstrap clears any pool an older AMI reserved ([memory](../../sandbox/state/memory/)).
- **Brain hosts:** the brain-host AMI, the cheapest class that runs Claude Code (`t4g.medium`-class), no hugepages, no nested virtualization. **Not built.**

**Network:**
- Public subnet with public IPv4, no NAT.
- **S3 gateway endpoint.** It's free, and it lets the bucket policy require `aws:SourceVpce`.
- Security group: outbound 443, plus 7844 TCP and UDP for cloudflared on sandbox hosts ([tunnel ports](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/tunnel-with-firewall/)). No inbound rules on either kind: brains reach sandboxes through each sandbox host's tunnel, and hosts dial the control plane out ([gateway](../../sandbox/gateway/)).

**IAM:**
- **Sandbox host instance role:** S3 access scoped to the cell's bucket.
- **Brain host instance role:** nothing. A brain host holds no S3 access; enrollment needs only IMDS, which is local.
- **Control-plane IAM user:** `RunInstances` with our launch template only; `Terminate` and `Stop` only on instances tagged `nest=true`; `Describe*`; `kms:Sign` on the proxy root CA key only ([TLS](../../sandbox/networking/egress/tls/)).
- **Deploy role** (`nest-<cell>-deploy`): assumed from GitHub Actions over OIDC, only by the repo's `production` environment; administrator-equivalent, because applying the stack manages IAM ([deploys](../../../dev/deploy.md)).

**Host authentication:**
1. An AWS host presents its **signed instance identity document** (from IMDS).
2. FleetDO verifies AWS's signature and checks that **it launched that instance ID** (and account and region) and hasn't enrolled it already.
3. FleetDO issues a short-lived host token, which rotates over the control WebSocket.
4. For a sandbox host, the Worker also creates the host's Cloudflare Tunnel and its DNS record through the Cloudflare API ([remote tunnel API](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel-api/); an API token with Account › Cloudflare One Connector: cloudflared › Edit and Zone › DNS › Edit, a Worker secret) and returns the tunnel token with the host token and the `wss://` URL clients will use. nestd keeps the token in its credentials file and runs cloudflared with it in the environment. A brain host gets none, and so does a cell missing any of the three Cloudflare inputs [FleetDO](../../control-plane/durable-objects/fleet/) names ([gateway](../../sandbox/gateway/)). FleetDO deletes the tunnel and record when the host dies and sweeps leaks daily ([FleetDO](../../control-plane/durable-objects/fleet/)).

No secrets go in user-data.

**Restarts resume, they don't re-enroll:** an instance enrolls once (its identity document is never replayable), so nestd keeps what enrollment gave it (host id, host token, fleet URL, proxy intermediate) root-only in `<state_dir>/host-credentials.json`, rewritten on every token rotation and CA renewal. A restarted nestd reconnects with it while the token is less than 23 h past expiry (the fleet channel's grace is 24 h; it rotates the token at hello); after that the host is replaced. The control plane treats leases a new nestd process doesn't report as gone with the old one: suspended sandboxes are evicted, the rest placed again from head. Verified on EC2 by rebooting a host: the same host reconnected 20 s later with no new enrollment and took new work. A host down longer than the 30 s lease expiry while holding leases is fenced by STONITH as before. A host outside AWS (a brain host on a VPS, for example) enrolls once with a one-time token I mint myself.

**Instance metadata service (IMDS):** require IMDSv2 with hop limit 1. nest-proxy blocks link-local and private ranges for sandboxes, so a guest can never reach IMDS or the instance role's credentials. A kernel rule on nest-proxy's uid rejects non-public destinations too, so a proxy bug can't reach them either ([kernel backstop](../../sandbox/networking/egress/steering/#kernel-backstop)).

## Upgrades

Hosts are replaced, never updated in place. The two host kinds roll separately, brain hosts before sandbox hosts, and the [gateway protocol](../../interfaces/gateway/) lets a brain host and a sandbox host be one release apart in either direction. Not built; it needs the autoscaler.

- **Versions:** host binaries (nestd, nest-proxy, the gateway, the runner, the hands client, `nest`, the guest agent) and images are built per release into the cell's bucket, versioned by commit. FleetDO holds **three desired versions per cell:** the brain-host version, the sandbox-host version and the guest image.
- **One release, in order,** each stage gated before the next ([deploys](../../../dev/deploy.md)):
  1. **Control plane:** deploy at 100%, then the 10-minute health window; host reconnection is the free canary. Rollback is `wrangler rollback`, except across a Durable Object class change, which is one-way and ships alone ([control plane](../../control-plane/#upgrades)).
  2. **Brain hosts:** set the desired brain-host version. One canary host launches, enrolls and runs a **probe turn**: a real Claude Code turn with the Python task against a probe sandbox through the gateway. Then the old brain hosts [drain gently](../autoscaling/): no new brains are placed, running brains finish their turn and exit at idle (120 s), and after 30 min the drain is forced: the brains are killed and AgentDO starts them elsewhere with `--resume`, exactly like a brain-host loss. No sandbox is touched.
  3. **Sandbox hosts:** set the desired sandbox-host version. One canary host launches, cold-boots a **probe sandbox**, a hands call round-trips through its gateway and a commit lands. Then the old hosts drain gently: residents suspend at their next idle point, forced after 30 min, one host at a time. A brain whose sandbox moves keeps running; its next hands call re-resolves and sees the new epoch.
  4. **Done** when no host reports the old version in its `hello`. FleetDO's [metrics](../../control-plane/metrics/) show the version mix throughout, so a stuck drain is visible.
- **Rollback:** set the desired version back; the same replacement rolls the old version forward again. A canary that fails its probe never gets a second host.
- **What rides with which kind:**

  | Change | Kind | Gate | One-way when |
  |---|---|---|---|
  | nestd, nest-proxy, the gateway, cloudflared, Firecracker, the host kernel | Sandbox host | The probe sandbox | The restore ABI changes, once memory snapshots exist |
  | The guest image `nest-base` (guest agent, rootfs, packages) | Sandbox host, as the image version | The probe sandbox. Cold boots use the new image, so a sandbox picks it up at its next cold boot; the host serves a range of guest versions ([host-guest](../../interfaces/host-guest/)), so old and new guests coexist | Raising the guest `min_supported`; harmless with disk-only restores |
  | The agent runner, the hands client, `nest mcp`, the Discord gateway client | Brain host | The probe turn | Raising the gateway protocol's `min_supported` |
  | The Claude Code baseline (version and SHA-256) | Brain host | The existing gate: `claude-verify` probes, the hands fidelity eval, resuming sessions written by the previous baseline ([runner](../../agents/runner/)) | Rolling back may leave sessions the newer binary wrote unreadable; those agents start fresh from memory |
  | Worker and Durable Objects | Cloudflare | The health window | A Durable Object class change |

- **Compatibility:** the control plane and hosts may differ by one version, with additive optional fields only ([control plane](../../control-plane/#upgrades)). A brain host and a sandbox host may differ by one release through the gateway protocol's `[min_supported, current]` range with capabilities; the release gate runs the previous release's hands client against the new gateway and the previous release's gateway against the new client, from the fixtures at `min_supported` up. The runner and Claude Code are pinned to each other exactly.
- **Restore ABI:** each release records the [restore ABIs](../../sandbox/state/memory/#restore-abi) its sandbox hosts create and load. A release that changes nestd, the proxy, the gateway or the guest agent keeps the ABI; one that changes Firecracker, the host or guest kernel, the CPU template or the VM profile changes it. **ABI-changing upgrades** leave dormant memory generations unloadable on the new hosts: they resume disk-only, with "process state lost" in the rollback notice, and no old hosts are kept for them. The rollout's drains skip memory snapshots no new host could load, and rolling back makes generations still at head loadable again. Dormant while cold boot is the only restore ([memory](../../sandbox/state/memory/)).
- **Scale to zero makes many rollouts free:** a cell with no hosts running takes the new version at its next launch. The canary still launches one host of each kind, so a release is never first exercised by real work.
