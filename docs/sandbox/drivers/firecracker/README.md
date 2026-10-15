# Firecracker driver

- **Isolation:** each VM runs under the jailer with `--netns`, so it's in its own network namespace. Every tap device is named `tap0`, so a snapshot restores anywhere. See [../../networking/](../../networking/).
- **Memory:** backed by **2 MB hugetlbfs** pages. Restoring these snapshots **requires UFFD**; a file-backed restore fails with an error. See [../../state/memory/](../../state/memory/).
- **Full snapshots only.** Dirty-page tracking cancels the benefit of hugepages.
- **No traditional balloon,** because it can't free hugetlbfs memory. Free page reporting works at 2 MiB, with the UFFD handler processing `UFFD_EVENT_REMOVE`; or no balloon.
- **Guest kernel** boots with `init_on_free=1`, so freed pages are zeroed and compress to nearly nothing.
- **VMGenID** reseeds randomness after a fork. vsock connections reset on restore, and the guest agent reconnects.
- **Nested virtualization is outside Firecracker's tested matrix** (it tests `.metal` instances; 8i hosts are supported on host kernels 6.1 and 6.18, per its [README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)). The overhead on AWS is unmeasured; "10% or more" is GCP's figure, and AWS recommends bare metal for performance-sensitive work ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)). The first spike measures nested against `.metal`.
- **Hugepages** reduce the cost of rebuilding page tables after a restore; Firecracker's docs report boot times up to 50% faster.
- **Version:** 1.17 or later, for `huge_pages` on snapshot load and `sync_snapshot_files` ([changelog](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md)).

Sources: [hugepages.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/hugepages.md), [network-for-clones.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md)
