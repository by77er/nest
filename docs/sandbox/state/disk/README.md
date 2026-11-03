# Disk

A sandbox's disk is a raw sparse file (`disk.img`, a copy of `nest-base` or a restored generation) attached to Firecracker as its root drive. A commit turns it into a manifest of 4 MB content-addressed chunks ([object store](../object-store/)).

**Decided (2026-11-02): a commit's cost follows what changed, not the disk's size, and the VM never waits for an upload or the control plane.** A turn-end checkpoint of a 32 GiB disk paused its VM for 33–39 s in production, re-reading allocated but unchanged data from the gp3 root volume at its 125 MiB/s baseline, while every hands call failed ([gp3](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html); the allocated size is inferred, not recorded). It ships in three milestones, each measured before the next.

## M1: pause only to read, and never read an unchanged disk

**Built** (`host.rs` `checkpoint`, `scan`, `publish_and_send`; `storage.rs` `scan_file`, `rescan_unchanged`, `publish`; `nestd_core::checkpoint`).

- **Order:** a lost answer is asked about again, then the guest flushes, the VM pauses, the disk is read, and the VM resumes. Uploads held back during the read, the manifest's upload and the control plane's answer come after the resume. A checkpoint never marks the disk clean, so resuming before the answer changes nothing a restart reads. A commit rejected after the resume fences the VM through its pause handle, as any fence of a running VM does.
- **Held back:** while the VM is paused, the read asks the store nothing. A non-zero chunk this process can't vouch for under the [12 h rule](../#generations) is kept in memory, up to 64 MiB, and uploaded after the resume. Past that budget it is uploaded at once, as before. A turn changes tens of MB, usually.
- **Unchanged disk:** a read made while nothing can write the disk (the VM paused or stopped) sets the file's modification time to a sentinel in 1970 and remembers its manifest. If the next commit, again with nothing writing, finds the file with the same identity, size and sentinel time, it reuses that manifest without reading. The 12 h rule still applies to every chunk the manifest names: one the store isn't known to hold is read back, checked against its entry and stored again.
  - **Why it holds:** every write sets the file's modification time to the current time, before its data lands, and only nestd sets the sentinel (assumed, from the kernel's write path; unverified on a host: [open questions](../../../README.md#open-questions-and-watch-items)). Firecracker's default `Sync` io_engine completes a write before the guest sees it complete, and a paused VM polls no device, so nothing lands between the read and the sentinel ([snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)).
  - **Restarts:** the memo is per incarnation and in memory only, so a restarted nestd reads every disk it salvages. The process driver trusts it only without `mount_disk`, since host-kernel writeback can reach a loop-mounted image after the guest stops.
  - **A failed pass leaves nothing to reuse:** a pass takes the memo when it begins, and the sentinel is its last step, after every read (a memory snapshot's included) has succeeded.
  - **Checked:** `verification/nestd/check` `sentinel` holds for the shipped memo as nestd drives it, passes that fail included, and finds the counterexample for a write that lands after the pause (the `Async` engine), for a memo trusted while the VM runs, and for a memo peeked at rather than taken when a pass begins. Kani proves the memo reuses only a stable sentinel pass with the same stamp.
- **Zero checks** run on the hashing workers, not the single reader.

M1 removes the wait for the store and the control plane from the pause, and the whole read when nothing changed. A disk that changed is still read whole while the VM is paused.

## M2: cut with a reflink while the VM runs (designed, not built)

- **Cut while the VM runs, no pause.** The guest flushes; nestd `fdatasync`s the disk file, so the clone's own flush is short; then `FICLONE` copies the disk to a cut file in O(extent records) of metadata. A clone is atomic against writes, because XFS serializes it with each write, so the cut is a crash image in write-completion order, and ext4 recovers from those. The clone flushes the source's dirty pages first ([remap_range.c](https://github.com/torvalds/linux/blob/master/fs/remap_range.c)).
  - **Needs Firecracker's `Async` io_engine:** with `Sync`, a guest write that arrives mid-clone blocks the VMM thread, and with it vsock and the network, for the clone's duration. Its production status is to check. Under `Async` the M1 sentinel is unsound (the model's counterexample), so that driver reports `pause_quiesces_disk() = false`, and unchanged disks are found by M3.
- **Background:** one commit per incarnation in flight. The checkpoint command returns once the cut is taken, so a commit never holds the host's one command executor.
  - **Coalescing:** a turn end during an in-flight commit replaces any queued turn-end cut, newest wins. SandboxDO already asks for one turn-end checkpoint at a time, so nestd's queue only guards other callers ([one at a time](../#one-turn-end-checkpoint-at-a-time)). A fork's cut is never replaced.
  - **`cut_ms`:** the commit request carries it, and the generation records when its disk was cut, not when its commit landed.
- **Storage: sandbox state on instance-store NVMe**, formatted XFS with `reflink=1` at boot by the host bootstrap, on instance types that have it (`c8id`; the cell stack's launch types). The disk, its cuts and the jail's hard links share that filesystem. A host without reflink keeps M1. Instance store dies with a spot host, as the root volume's sandbox state does today.
- **Local cache:** committed chunks stop going into the store's local write-through cache. The cut and the base are the host's local copy, and a same-host fork clones them.
- **Host kernel:** ≥ 6.7, so reads proceed during a clone ([xfs 14a53798](https://github.com/torvalds/linux/commit/14a537983b228cb050ceca3a5b743d01315dc4aa), on AL2023's 6.12 kernel), with the RefluXFS fix ([CVE-2026-64600](https://seclists.org/oss-sec/2026/q3/214)).
- **Gate before it ships:** measured on a real host (not production). If a month-old 32 GiB image's p99 `FICLONE` exceeds 200 ms, M3′ comes first: an incremental shadow that clones only the ranges FIEMAP shows changed (`FICLONERANGE`). A clone's cost grows with the number of extent records: 50–100 M of them locked a file for over 30 minutes (xfs 14a53798).

## M3: read only what changed (designed, not built)

- **Base:** the frozen file whose content equals a known manifest (the last cut chunked, or the disk just restored), named by `base.json`. A new base is recorded before the old file is deleted, so a crash always leaves a `base.json` that names an existing file. A previous-release nestd ignores both files, and they are deleted with the incarnation.
- **Diff:** a chunk is read, hashed and uploaded only when its FIEMAP mapping in the new cut differs from the base's over its whole range. If two frozen files map an offset to the same physical block, they hold the same bytes there: XFS never overwrites a shared block in place, and the base keeps its blocks referenced. Anything unusual counts as changed. `FIEMAP_EXTENT_SHARED` alone says nothing: every disk shares blocks with the base image.
- **The 12 h rule is unchanged:** every non-null entry of a new manifest is verified at prepare. A stale one is uploaded again from the cut. Manifests stay self-contained, `format: 1`.
- **Expected:** a no-change turn reads nothing and commits in milliseconds after the cut. A 32 GiB disk with 1 GiB changed reads about 1 GiB from the cut in the background, about 8 s at gp3's baseline and less on NVMe.

## Later

- **ublk** (designed, not next): lazy reads for restore and fork on another host, fetching 4 MB chunks into a local NVMe cache and prefetching the working set recorded during the previous run. It is no longer the cut mechanism.
- **`nest diff <a> <b> [path]`:** mounts both generations read-only on the host and diffs the files.
- **Rejected:** a Firecracker block dirty bitmap (dirty tracking is for memory only); vhost-user-blk (developer preview, no snapshots, no rate limiter: [block-vhost-user.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-vhost-user.md)); qcow2 (Firecracker drives are raw); dm-era alone (no cut); NBD (ublk is the better userspace block device). dm-thin is the fallback if neither M2 nor M3′ meets the gate: a pool that fills fails every sandbox on its host.

## Flush before commit

Writes still in the guest's page cache aren't in a cut, and writes the guest has flushed may not be either: Firecracker's default `Unsafe` cache mode doesn't offer the guest a flush, so a guest `syncfs` ends once the data reaches the host, without an `fsync` ([block caching](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-caching.md)). So every commit, pause and suspend:

**Designed, not built** (guest protocol v2): today nestd asks the guest to `sync` through `prepare_snapshot`, ignores a failure, and pauses the VM while it reads the disk (M1, above; [nestd](../../../compute/nestd/)).

1. asks the guest agent to `syncfs` every filesystem (its `flush` request; [host-guest](../../../interfaces/host-guest/)), within a **30 s** budget (SPACE uses the same budget; [guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md));
2. `fdatasync`s the disk file on the host, so the clone's own flush is short (M2);
3. cuts it with a reflink (M2; today, pauses the VM and reads it).

- **No flush, no commit.** A failed or late flush fails the commit, pause or suspend; nothing is cut. A turn-end or periodic commit tries again at its next trigger; a failed pause or suspend backs off ([SandboxDO](../../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Two crash-consistent exceptions,** because neither can retry: a spot notice cuts every disk after a 5 s flush budget ([spot notice](../#spot-notice-2-minutes)), and salvage cuts a fenced VM it may not resume ([fencing](../../fencing/#5-salvage)). Their `reason` (`spot`, `salvage`) marks them.
- **A paused VM isn't flushed again:** it was flushed before it paused and hasn't run since.

## I/O limits

**Decided: every sandbox's drive gets Firecracker's rate limiter:** 10,000 operations/s and 100 MiB/s, each bucket holding 30 s of its rate as burst, the same defaults SPACE uses ([guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md)). Placement packs only memory and vCPUs, so without a cap one sandbox's builds could starve every other sandbox on the host. Not built.
- **Per sandbox:** the operator can set other limits; they're part of the sandbox's resources and survive restores and moves.
- **The ops bucket counts guest requests,** cached or not. At 4 KiB per request, 10,000 ops/s is about 39 MiB/s.
- **Not fair on a dense host:** idle sandboxes all bank their burst, and nothing bounds many spending it at once (SPACE notes the same gap).
