# Drivers

A driver implements: create/boot, pause, snapshot, restore, fork, destroy, a vsock control channel, and attaching to a netns. It also defines the descriptor fields of its [restore ABI](../state/memory/#restore-abi), so a snapshot never matches a host running another driver.

| Driver | Use | Requires |
|---|---|---|
| [firecracker/](firecracker/) | Primary, on sandbox hosts | `/dev/kvm` (nested virtualization) |
| [gvisor/](gvisor/) | Optional: sandbox hosts in cells without KVM | Nothing special |
| [lambda-microvm/](lambda-microvm/) | Rejected: cost, 8-hour state cap, no egress control outside the guest | AWS |
