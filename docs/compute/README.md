# Compute

Hosts, grouped into **[cells](cells/)**. A cell is compute plus its object store in one provider and region, such as AWS us-east-1 with S3. The control plane is global; sandbox state belongs to one cell, and so does everything AWS: resources, settings, credentials and the proxy root CA.

## Host kinds

Two kinds, placed and scaled independently. A brain never runs on a sandbox host, a sandbox host never holds the subscription token, and a brain reaches a sandbox only through its [gateway](../sandbox/gateway/), so the two kinds share nothing but the cell.

| Kind | Runs | Lifecycle |
|---|---|---|
| **Sandbox host** | **Every sandbox** (Firecracker), nestd, nest-proxy, cloudflared and the gateway. No brains. | Spot with nested virtualization, scales to zero |
| **[Brain host](brain-hosts/)** | nestd (enrollment, lease, runner supervision), the agent runner with one Claude Code process per active agent, and `nest mcp`. No sandboxes, no KVM; in S3 it may read the release (`releases/*`) only. | The cheapest instance class that runs Claude Code, spot or on-demand; idle for 30 min, then terminated; scales to zero |

Both kinds boot one host AMI; a host's kind is its nestd config's `role`, written by the user data of the launch template FleetDO launched it from ([provisioning](provisioning/)). On the wire and in storage this release still names them `burst` and `controller` and reads `sandbox` and `brain` too; the next release switches ([deploy](../../dev/deploy.md#host-role-names-expandcontract)). Both kinds run on AWS in `use1` (brain hosts since 2026-10-29: [brain hosts](brain-hosts/)).

## Choice of provider

- **DigitalOcean and most cheap VMs don't expose `/dev/kvm`.** That rules out Firecracker there, leaving gVisor as the only option for sandboxes. Brain hosts need no KVM, so any provider can run them.
- **AWS has supported nested virtualization since February 16, 2026,** launched on C8i, M8i and R8i ([what's new](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)); the user guide now also lists the 7i families, I7i/I7ie and X8i. The only `d` (local NVMe) variants are C8id, M8id and R8id. It costs nothing extra and is enabled with `--cpu-options NestedVirtualization=enabled`.
- **The AWS sandbox fleet is the 8i family only** (C8i, M8i, R8i, with their `d` and flex variants): memory snapshots restore only on the same CPU model (see [restore ABI](../sandbox/state/memory/#restore-abi)), and Firecracker supports 8i hosts. That every 8i variant has the same CPU model, so the fleet shares one ABI, is unverified.
- **GCP:** Intel series and N4D only. GCP quotes 10% or more overhead.
- **Cost:**
  - On-demand AWS costs about 1.5× DigitalOcean.
  - Spot costs 60–70% less than on-demand.
  - Scale-to-zero matters more than the unit price.
- **Lambda MicroVMs:** considered and rejected as the primary platform. See [../sandbox/drivers/lambda-microvm/](../sandbox/drivers/lambda-microvm/).

Approximate prices, us-east-1, 2026:

| Option | Price |
|---|---|
| c8i.large on-demand (sandbox host) | $0.094/hr |
| c8i.large spot (sandbox host) | ~$0.033/hr |
| t3a.medium on-demand (brain host, 2 vCPU / 4 GB, x86) | ~$27/mo (unverified) |
| DigitalOcean CPU-optimized, 2 vCPU / 4 GB | $42/mo |
| Lambda MicroVM, 2 vCPU / 4 GB | ~$0.25/hr |

## Cost traps

- **NAT gateway:** about $32/mo plus per-GB charges. Use public subnets instead.
- **Public IPv4:** about $3.60/mo per running host. It's still needed because some destinations, such as GitHub, are IPv4-only.
- **Cross-AZ traffic.**

## Components

- [brain-hosts/](brain-hosts/): the hosts that run brains: cheap, stateless, no KVM, placed without regard to where sandboxes are
- [nestd/](nestd/): the per-host daemon on both kinds (sandboxes, the gateway and cloudflared on sandbox hosts; runner supervision on brain hosts)
- [autoscaling/](autoscaling/): spot capacity, scale-to-zero, interruptions, both kinds
- [provisioning/](provisioning/): images, launch templates, IAM, network, host rollout

Sources: [EC2 nested virtualization](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html), [GCP nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview), [DO pricing](https://www.digitalocean.com/pricing/droplets)
