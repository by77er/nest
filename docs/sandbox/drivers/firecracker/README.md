# Firecracker driver

- **Isolation:** each VM runs under the jailer with `--netns`, so it's in its own network namespace. Every tap device is named `tap0`, so a snapshot restores anywhere. See [../../networking/](../../networking/).
- **Memory:** backed by **2 MB hugetlbfs** pages. Restoring these snapshots **requires UFFD**; a file-backed restore fails with an error. See [../../state/memory/](../../state/memory/).
- **Full snapshots only.** Dirty-page tracking cancels the benefit of hugepages.
- **No traditional balloon,** because it can't free hugetlbfs memory. Use free page reporting or hinting, or no balloon.
- **Guest kernel** boots with `init_on_free=1`, so freed pages are zeroed and compress to nearly nothing.
- **VMGenID** reseeds randomness after a fork. vsock connections reset on restore, and the guest agent reconnects.
- **Nested-virtualization overhead** is 10% or more of CPU, and more for I/O. Hugepages reduce the cost of rebuilding page tables after a restore; Firecracker's docs report boot times up to 50% faster.

Sources: [hugepages.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/hugepages.md), [network-for-clones.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/network-for-clones.md)
