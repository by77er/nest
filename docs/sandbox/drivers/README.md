# Drivers

A driver implements: create/boot, pause, snapshot, restore, fork, destroy, a vsock control channel, and attaching to a netns.

| Driver | Use | Requires |
|---|---|---|
| [firecracker/](firecracker/) | Primary, on burst hosts | `/dev/kvm` (nested virtualization) |
| [gvisor/](gvisor/) | Optional: burst hosts in cells without KVM | Nothing special |
| [lambda-microvm/](lambda-microvm/) | Rejected: cost, 8-hour state cap, no egress control outside the guest | AWS |
