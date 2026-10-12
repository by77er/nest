# Provisioning

**Burst host image (built with Packer):**
- Ubuntu 24.04 (kernel 6.8). Hugetlb needs 5.18+ and ublk needs 6.0+.
- Firecracker and jailer, gVisor (`runsc`), nestd, nest-proxy, cloudflared, **Claude Code + the agent runner** (brains for local sandboxes).

**Launch template:**
- Nested virtualization enabled, restricted to supported families.
- Prefer `d` variants for local NVMe.
- Reserve a `vm.nr_hugepages` pool at boot. The remaining memory is for the host and the snapshot page cache.

**Network:**
- Public subnet with public IPv4, no NAT.
- **S3 gateway endpoint.** It's free, and it lets the bucket policy require `aws:SourceVpce`.
- Security group: outbound 443, plus 7844 TCP and UDP for cloudflared. No inbound rules.

**IAM:**
- **Host instance role:** S3 access scoped to the cell's bucket.
- **Control-plane IAM user:** `RunInstances` with our launch template only; `Terminate` and `Stop` only on instances tagged `nest=true`; `Describe*`.

**Controller host image:** Claude Code, the agent runner, nest-mcp and the Discord gateway client. No hypervisor, no hugepages, no S3 access.

**Host authentication:**
1. An AWS host presents its **signed instance identity document** (from IMDS).
2. FleetDO verifies AWS's signature and checks that **it launched that instance ID** (and account and region) and hasn't enrolled it already.
3. FleetDO issues a short-lived host token, which rotates over the control WebSocket.

No secrets go in user-data. A host outside AWS (e.g. the controller host on a VPS) enrolls once with a one-time token I mint myself.

**Instance metadata service (IMDS):** require IMDSv2 with hop limit 1. nest-proxy blocks link-local and private ranges for sandboxes, so a guest can never reach IMDS or the instance role's credentials.
