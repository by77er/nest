# Autoscaling and spot

- **Scale to zero.** FleetDO launches hosts only when there's runnable work queued.
- **EC2 Fleet** spot requests across several families (C7i, C8i, M7i, M8i, preferring `d` variants), falling back to on-demand.
- **Idle grace:** keep a host N minutes after its last activity so conversations with several turns stay fast.
- **Drain:** suspend the sandboxes, flush them to S3, then terminate the host.
- **Optional stopped warm worker:** a stopped instance with the image already on disk, costing about $2/mo for EBS. Starting it is faster than a fresh launch.
- **Spot interruption** gives 2 minutes' notice. See [../../sandbox/state/](../../sandbox/state/).
- **The controller host is never scaled.** It's replaced if it fails.
