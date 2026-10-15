# Lambda MicroVM (rejected)

AWS launched Lambda MicroVMs in June 2026. Each is a Firecracker VM per session, started from a snapshot of your image, that **resumes automatically on its next HTTPS request**.

**Limits:**
- ARM64 only
- Up to 16 vCPU / 32 GB RAM / 32 GB disk
- Five regions
- **State kept for at most 8 hours**

**Pricing:** about $0.10 per vCPU-hour plus $0.013 per GB-hour while running. Suspended state is billed as snapshot storage at $0.08/GB-month.

**Why it isn't the primary platform:**
- It costs about 7–8× spot.
- The 8-hour cap conflicts with sandboxes waiting days.
- **Egress can't be enforced outside the guest** without an always-on VPC proxy.
- Snapshot and fork control is limited.

Agents without hands don't need it either: they need no machine at all (see [backends](../../../agents/backends/)).

Sources: [AWS blog](https://aws.amazon.com/blogs/aws/run-isolated-sandboxes-with-full-lifecycle-control-aws-lambda-introduces-microvms/), [Lambda pricing](https://aws.amazon.com/lambda/pricing/)
