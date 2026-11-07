# Drivers

A driver implements: create/boot, pause, snapshot, restore, fork, destroy, a vsock control channel, and attaching to a netns. It also defines the descriptor fields of its [restore ABI](../state/memory/#restore-abi), so a snapshot never matches a host running another driver.

| Driver | Use | Requires |
|---|---|---|
| [firecracker/](firecracker/) | Primary, on sandbox hosts | `/dev/kvm` (nested virtualization) |
| [gvisor/](gvisor/) | Optional: sandbox hosts in cells without KVM | Nothing special |
| [lambda-microvm/](lambda-microvm/) | Rejected: cost, 8-hour state cap, no egress control outside the guest | AWS |
| process (`crates/nestd/src/driver/process.rs`) | Development and the e2e harness only | Nothing; the guest runs as a child of nestd, with its privileges |

**A cell host runs guests only in Firecracker under the jailer (decided 2026-11-06).** The process driver runs every guest, and so agents' Bash, as root on the host, with only a mount namespace and a netns around it; an unjailed Firecracker runs its VMM with nestd's privileges. So:
- the sandbox bootstrap refuses the role on a host without `/dev/kvm`, or without Firecracker and the jailer in the release: it writes no config, enables nothing, never enrolls and shuts the instance down (the launch template terminates on shutdown), and FleetDO's enroll timeout ends the launch. It used to fall back to the process driver;
- nestd refuses either driver at start unless its config sets `unconfined_driver` (`Config::validate`, `unconfined_driver_refusal`), whatever the enrollment: an AWS identity, or an operator's token for a host outside AWS. Development and the e2e harness set it; `static` enrollment, for tests, is exempt.

Every type a cell launches has nested virtualization on a CPU Firecracker supports, which the cell stack proves (`launch_types_sound`, [provisioning](../../compute/provisioning/)), so the refusal costs a cell nothing while its types are right. If a host loses KVM at run time anyway (a template that lost `NestedVirtualization`, an AMI kernel without kvm), the cell gets no sandbox host: each launch is refused, and FleetDO holds scale-up while one is pending (up to `enroll_timeout_ms`, 10 min) and then tries again. That is the intended failure, loud and costless, rather than a working host that runs agents as root; `dev/cloud-checks/new_host_check.py` names it (`refused_sandbox_role`).
