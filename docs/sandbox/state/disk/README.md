# Disk

- **ublk** (a userspace block device, Linux 6.0+). Firecracker sees an ordinary block device.
- **Reads** fetch 4 MB chunks lazily into a local NVMe cache, prefetching the working set recorded during the previous run.
- **Writes** go to local copy-on-write chunks and are tracked in a dirty set.
- **Consistent cuts:** at commit time, the ublk daemon **flips a copy-on-write epoch**. Writes from that instant go to fresh chunks, and the frozen set uploads in the background. Any cut in write-completion order is a valid crash image, and ext4 recovers from those. A cut holds only what reached the ublk daemon, so every commit flushes first (below).
- **`nest diff <a> <b> [path]`:** mounts both generations read-only on the host and diffs the files. It works for any content.

## Flush before commit

Writes still in the guest's page cache aren't in a cut, and writes the guest has flushed may not be either: Firecracker's default `Unsafe` cache mode doesn't offer the guest a flush, so a guest `syncfs` ends once the data reaches the host, without an `fsync` ([block caching](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-caching.md)). So every commit, pause and suspend:

1. asks the guest agent to `syncfs` every filesystem (its `flush` request; [host-guest](../../../interfaces/host-guest/)), within a **30 s** budget (SPACE uses the same budget; [guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md));
2. `fsync`s the ublk device on the host, so the ublk daemon has every write (that Firecracker's writes pass through the host page cache on their way to ublk is unverified; the `fsync` is cheap either way);
3. flips the epoch.

- **No flush, no commit.** A failed or late flush fails the commit, pause or suspend; nothing is cut. A turn-end or periodic commit tries again at its next trigger; a failed pause or suspend backs off ([SandboxDO](../../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Two crash-consistent exceptions,** because neither can retry: a spot notice cuts every disk after a 5 s flush budget ([spot notice](../#spot-notice-2-minutes)), and salvage cuts a fenced VM it may not resume ([fencing](../../fencing/#5-salvage)). Their `reason` (`spot`, `salvage`) marks them.
- **A paused VM isn't flushed again:** it was flushed before it paused and hasn't run since.

## I/O limits

**Decided: every sandbox's drive gets Firecracker's rate limiter:** 10,000 operations/s and 100 MiB/s, each bucket holding 30 s of its rate as burst, the same defaults SPACE uses ([guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md)). Placement packs only hugepages and vCPUs, so without a cap one sandbox's builds could starve every other sandbox on the host.
- **Per sandbox:** the operator can set other limits; they're part of the sandbox's resources and survive restores and moves.
- **The ops bucket counts guest requests,** cached or not. At 4 KiB per request, 10,000 ops/s is about 39 MiB/s.
- **Not fair on a dense host:** idle sandboxes all bank their burst, and nothing bounds many spending it at once (SPACE notes the same gap).
