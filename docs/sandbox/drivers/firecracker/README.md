# Firecracker driver

- **Isolation:** each VM runs under the jailer with `--netns`, so it's in its own network namespace. Every tap device is named `tap0`, so a snapshot restores anywhere. See [../../networking/](../../networking/).
- **Memory:** backed by **2 MB hugetlbfs** pages. Restoring these snapshots **requires UFFD**; a file-backed restore fails with an error. See [../../state/memory/](../../state/memory/).
- **Full snapshots only.** Dirty-page tracking cancels the benefit of hugepages.
- **No traditional balloon,** because it can't free hugetlbfs memory. Free page reporting works at 2 MiB, with the UFFD handler processing `UFFD_EVENT_REMOVE`; or no balloon.
- **Guest kernel** boots with `init_on_free=1` once memory snapshots exist, so freed pages are zeroed and compress to nearly nothing. Until then it's off: on a nested 8i host it made a 1-vCPU guest zero all its memory at boot, and boots stalled past a minute (soft lockups in `pgdatinit`, 2026-10-18). Whether it's affordable with snapshots on nested hosts is open.
- **VMGenID** reseeds randomness after a fork. vsock connections reset on restore, and the guest agent reconnects.
- **Nested virtualization is outside Firecracker's tested matrix** (it tests `.metal` instances; 8i hosts are supported on host kernels 6.1 and 6.18, per its [README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)). The overhead on AWS is unmeasured; "10% or more" is GCP's figure, and AWS recommends bare metal for performance-sensitive work ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)). The first spike measures nested against `.metal`.
- **Hugepages** reduce the cost of rebuilding page tables after a restore; Firecracker's docs report boot times up to 50% faster.
- **Version:** the 1.17 line, for `huge_pages` on snapshot load and `sync_snapshot_files` ([changelog](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md)), **pinned by binary digest, patch level included.** A patch release can change the snapshot format: SPACE reports that 1.16.2 writes format 11.0.0 and can't restore the format-10 snapshots of 1.16.0 and 1.16.1 ([runtime-manager-catalog.md](https://github.com/perplexityai/space/blob/main/docs/runtime-manager-catalog.md)). The digest is part of the [restore ABI](../../state/memory/#restore-abi).
- **Memory restore is qualified per (Firecracker, guest kernel) pair.** A pair that boots isn't thereby fit for snapshots; until the first spike qualifies nest's pair, hosts make disk-only generations ([restore ABI](../../state/memory/#restore-abi)).
- **Drives** keep the default `Unsafe` cache mode, so a guest flush stops at the host page cache; nestd `fsync`s the ublk device before each cut ([disk](../../state/disk/#flush-before-commit)).
- **Rate limiter** on every drive: 10,000 ops/s and 100 MiB/s with a 30 s burst by default ([I/O limits](../../state/disk/#io-limits)).

Sources: [hugepages.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/hugepages.md), [network-for-clones.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md)
