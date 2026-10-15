# Compute

Hosts, grouped into **cells**. A cell is compute plus its object store in one provider and region, such as AWS us-east-1 with S3. The control plane is global; sandbox state belongs to one cell.

## Host roles

| Role | Runs | Lifecycle |
|---|---|---|
| **[Controller](controller/)** | Brains without hands (agent runner), Discord gateway. **No sandboxes.** | Always on, small, stateless, any provider |
| **Burst** | **Every sandbox** (Firecracker) plus their workers' brains (agent runner, outside the VMs) | Spot, scales to zero |

## Choice of provider

- **DigitalOcean and most cheap VMs don't expose `/dev/kvm`.** That rules out Firecracker there, leaving gVisor as the only option.
- **AWS has supported nested virtualization since February 2026** on C7i/C8i, M7i/M8i, R7i/R8i, I7i, and their flex and `d` variants. It costs nothing extra and is enabled with `--cpu-options NestedVirtualization=enabled`.
- **GCP:** Intel series and N4D only. GCP quotes 10% or more overhead.
- **Cost:**
  - On-demand AWS costs about 1.5× DigitalOcean.
  - Spot costs 60–70% less than on-demand.
  - Scale-to-zero matters more than the unit price.
- **Lambda MicroVMs:** considered and rejected as the primary platform. See [../sandbox/drivers/lambda-microvm/](../sandbox/drivers/lambda-microvm/).

Approximate prices, us-east-1, 2026:

| Option | Price |
|---|---|
| c8i.large on-demand | $0.094/hr |
| c8i.large spot | ~$0.033/hr |
| DigitalOcean CPU-optimized, 2 vCPU / 4 GB | $42/mo |
| Lambda MicroVM, 2 vCPU / 4 GB | ~$0.25/hr |

## Cost traps

- **NAT gateway:** about $32/mo plus per-GB charges. Use public subnets instead.
- **Public IPv4:** about $3.60/mo per running host. It's still needed because some destinations, such as GitHub, are IPv4-only.
- **Cross-AZ traffic.**

## Components

- [controller/](controller/): the always-on, stateless host for brains without hands
- [nestd/](nestd/): the per-host daemon on burst hosts
- [autoscaling/](autoscaling/): spot capacity, scale-to-zero, interruptions
- [provisioning/](provisioning/): images, launch template, IAM, network

Sources: [EC2 nested virtualization](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html), [GCP nested virtualization](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview), [DO pricing](https://www.digitalocean.com/pricing/droplets)
