# Drivers

A driver implements: create/boot, pause, snapshot, restore, fork, destroy, a vsock control channel, and attaching to a netns. It also defines the descriptor fields of its [restore ABI](../state/memory/#restore-abi), so a snapshot never matches a host running another driver.

| Driver | Use | Requires |
|---|---|---|
| [firecracker/](firecracker/) | Primary, on sandbox hosts | `/dev/kvm` (nested virtualization) |
| [gvisor/](gvisor/) | Optional: sandbox hosts in cells without KVM | Nothing special |
| [lambda-microvm/](lambda-microvm/) | Rejected: cost, 8-hour state cap, no egress control outside the guest | AWS |
| process (`nestd/src/driver/process.rs`) | Development and the e2e harness only | Nothing; the guest runs as a child of nestd, with its privileges |

**A cell host runs guests only in Firecracker under the jailer (decided 2026-11-06).** The process driver runs every guest, and so agents' Bash, as root on the host, with only a mount namespace and a netns around it; an unjailed Firecracker runs its VMM with nestd's privileges. So:
- the sandbox bootstrap refuses the role on a host without `/dev/kvm` or without Firecracker in the release: it writes no config, enables nothing and never enrolls, and FleetDO's enroll timeout ends the instance. It used to fall back to the process driver;
- nestd refuses either driver at start on a host that enrolls with its AWS identity (`Config::validate`, `cell_host_refusal`). Development and the e2e harness enroll with a token file or static credentials and keep both.

Every type a cell launches has nested virtualization on a CPU Firecracker supports, which the cell stack proves (`launch_types_sound`, [provisioning](../../compute/provisioning/)), so the refusal costs a cell nothing while its types are right.
