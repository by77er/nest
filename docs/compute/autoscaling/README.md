# Autoscaling and spot

- **Scale to zero.** FleetDO launches hosts only when there's runnable work queued.
- **EC2 Fleet** spot requests across the 8i family (C8i, M8i, R8i, preferring `d` variants) with the **price-capacity-optimized** allocation strategy, as AWS recommends ([docs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-fleet-allocation-strategy.html)), falling back to on-demand.
- **Idle grace:** keep a host N minutes after its last activity so conversations with several turns stay fast.
- **Pack, then consolidate:** placement fills hosts before opening new ones (see [FleetDO](../../control-plane/durable-objects/fleet/)), so idle hosts empty out. An idle host is drained by suspending its sandboxes to S3, then terminated.
- **Drain:** suspend the sandboxes, flush them to S3, then terminate the host. Each host is capped so a full drain finishes in about 90 s at its measured upload bandwidth, inside the 2-minute spot notice.
- **Moves are checkpoint and restore,** like every sandbox provider; no one offers live migration.
- **Optional stopped warm host:** a stopped instance with the image already on disk, costing about $2/mo for EBS. Starting it is faster than a fresh launch. (Auto Scaling warm pools can't use spot in mixed-instance groups; [docs](https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html).)
- **Spot interruption** gives 2 minutes' notice. See [../../sandbox/state/](../../sandbox/state/).
- **The controller host is never scaled.** It's replaced if it fails.
