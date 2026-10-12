# Disk

- **ublk** (a userspace block device, Linux 6.0+). Firecracker sees an ordinary block device.
- **Reads** fetch 4 MB chunks lazily into a local NVMe cache, prefetching the working set recorded during the previous run.
- **Writes** go to local copy-on-write chunks and are tracked in a dirty set.
- **Consistent cuts:** at commit time, the ublk daemon **flips a copy-on-write epoch**. Writes from that instant go to fresh chunks, and the frozen set uploads in the background. Any cut in write-completion order is a valid crash image, and ext4 recovers from those. The guest pauses for only milliseconds and doesn't need to cooperate. `fsfreeze` through the guest agent is optional, for clean images that skip journal replay.
- **`nest diff <a> <b> [path]`:** mounts both generations read-only on the host and diffs the files. It works for any content.
