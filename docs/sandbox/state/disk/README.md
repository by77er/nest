# Disk

A sandbox's disk is a raw sparse file (`disk.img`, a copy of `nest-base` or a restored generation) attached to Firecracker as its root drive. A commit turns it into a manifest of 4 MB content-addressed chunks ([object store](../object-store/)).

**Decided (2026-11-02, revised 2026-11-03): a commit's cost follows what changed, not the disk's size, and the VM never waits for an upload or the control plane; it pauses only for a reflink clone (M2).** Reading a 32 GiB disk whole, allocated but unchanged data included, from the gp3 root volume at its 125 MiB/s baseline paused its VM for 33–39 s per turn-end checkpoint in production ([gp3](https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html); the allocated size is inferred, not recorded). It ships in three milestones, each measured before the next.

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

## M2: a reflink cut in a brief pause, committed in the background

**Built, not deployed:** it waits for the owner's review of the instance-type cost and for the measurement below (`crates/nestd/src/host.rs` `cut_checkpoint`, `commit_cut`; `storage.rs` `reflink`).

**Decided (2026-11-03): pause the VM only for the clone, on the `Sync` io_engine.** A cut taken while the VM runs needs Firecracker's `Async` engine: with `Sync`, a guest write that arrives during the clone blocks the VMM thread, and the vsock and the network with it ([design.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md): one event loop for all device emulation). Firecracker's own docs say `Async` "is not yet suitable for production use" ([v1.17.0 block-io-engine.md](https://raw.githubusercontent.com/firecracker-microvm/firecracker/v1.17.0/docs/api_requests/block-io-engine.md), the line nest pins). **Cut-while-running is deferred until `Async` is GA**; under it the M1 memo would have to go, since a write can land after the pause.

- **The cut:**
  - while the VM runs, the guest flushes and nestd `fdatasync`s the disk file, so the clone's own flush has little left;
  - then the VM is paused (the gateway marks it `busy`), and `FICLONE` copies the disk to `cut-<n>.img` in its directory, in O(extent records) of metadata;
  - the M1 sentinel is set, and the VM resumes.

  A clone is atomic against writes (XFS serializes it with each write), and it flushes the source's dirty pages first ([remap_range.c](https://github.com/torvalds/linux/blob/master/fs/remap_range.c)). So the cut is a crash image in write-completion order, and ext4 recovers from those. A disk unchanged since the last pass isn't cut: M1's check runs in the pause.
- **The command returns once the cut is taken** (`{"cut": n}`), so the host's one command queue never waits for a read, an upload or the control plane. A background task reads the cut, uploads as it reads, commits it as any commit is (asking again for a lost answer first), and deletes the file.
- **Order:**
  - commits leave an incarnation one at a time and in order (a commit lock per incarnation, held through the answer);
  - cuts queue one deep behind the commit in flight, and a newer cut replaces the queued one (coalescing; SandboxDO already asks for one turn-end checkpoint at a time: [one at a time](../#one-turn-end-checkpoint-at-a-time));
  - a suspend, archive or salvage drops the queued cut, since it reads a newer disk, and waits for the commit in flight;
  - a fork waits for its own cut's generation.
- **`cut_ms`:** the commit request carries the cut's instant, and the generation records it (`GenerationRecord.cut_ms`, additive).
- **Clean only if no VM ran since the read:** a commit answered after a fence stopped a VM that had resumed past its read (a cut's, or since M1 a read checkpoint's) used to mark the disk clean, and the retire then skipped the salvage of what the VM wrote. Fixed with this milestone (`Sbx::runs`); test `a_commit_answered_after_a_fence_leaves_the_written_disk_to_salvage`.
- **The memo hands out passes:** a cut is recorded after newer cuts may have begun, and the sentinel reads the same for every cut, so only the newest pass begun may record (`nestd_core::checkpoint`).
- **Storage: sandbox state on instance-store NVMe** where the instance type has one (`c8id.large`, now first in the cell's launch types). At first boot the host bootstrap formats it XFS with `reflink=1` and mounts it at `/var/lib/nest/data`, and nestd's state, the kernel, the base images and the jailer's chroots go there. They must share one filesystem, because the jailer hard-links the kernel and the disk. Instance store dies with a spot host, as the root volume's sandbox state does today.
- **Fallback:** nestd probes `FICLONE` on its sandboxes' filesystem at start. Without it (an EBS-only type, an AMI with `reflink=0`), it logs a warning and checkpoints pause the VM while they read the disk (M1).
- **Local cache:** committed chunks no longer go into the store's local write-through cache. A same-host fork's pass keeps every chunk it reads there for the child's restore (`ObjectStore::keep_local`); restores still cache what they fetch.
- **Host kernel:** ≥ 6.7, so reads proceed during a clone ([xfs 14a53798](https://github.com/torvalds/linux/commit/14a537983b228cb050ceca3a5b743d01315dc4aa); AL2023's 6.12 kernel), with the RefluXFS fix ([CVE-2026-64600](https://seclists.org/oss-sec/2026/q3/214)).
- **Gate before it ships:** `dev/measure-cut/run.sh` launches one disposable `c8id.large` and measures:
  - the clone's pause against the disk's extent records (fresh, after 1 GiB of churn, after a simulated month of turn ends);
  - reading a cut cold;
  - a guest's write stalls during the pause.

  If a month-old 32 GiB disk's p99 clone exceeds 200 ms, M3′ comes first: an incremental shadow that clones only the ranges FIEMAP shows changed (`FICLONERANGE`). A clone's cost grows with the number of extent records: 50–100 M of them locked a file for over 30 minutes (xfs 14a53798).
- **Measured (2026-11-03, one `c8id.large` in us-east-1c, kernel 6.18.56, XFS `reflink=1` on the 118 GB instance store):** the gate fails, so M3′ comes first.

  | 32 GiB disk | Extent records | `FICLONE`, 5 runs |
  |---|---|---|
  | fresh (`nest-base`, grown) | 44 | 13–14 ms |
  | after 1 GiB of random 4 KiB churn over a cut | 157,649 | 1.6–2.9 s (median 2.4 s) |
  | after 300 rounds of cut, 2,000 scattered writes, drop (a simulated month) | 818,954 | 8.0–11.0 s (median 8.1 s) |

  - The clone costs about 10–15 µs per extent record. The records scattered writes add stay until the disk is rewritten, so on a disk in use a pause for a whole-file clone lasts seconds, not the milliseconds option 1 assumed.
  - Reading a cut cold: 6.69 GB of data extents in 37.0 s, about 181 MB/s.
  - Guest write stalls weren't measured: the test VM wasn't running when the pauses began. Twelve pause-clone-resume cycles on the month-aged disk took 5.06–5.14 s each. The harness now records whether the VM is up, and its console.
  - Results: `dev/measure-cut/results-i-08370229efb01aa08.json`.
- **Checked:** `verification/nestd/check` `sentinel` drives reads and cuts together (a cut recorded behind a newer one included), and fails for a cut recorded under the newest pass instead of its own. Tests:
  - host tests use a test cut (`disk_cut: locked_copy`): a copy under an exclusive `flock`, since the test filesystems have no reflink;
  - the e2e harness cuts that way during sustained writes, restores the generation from the store, and finds an exact prefix of the writes.

## M3: read only what changed (designed, not built)

- **Base:** the frozen file whose content equals a known manifest (the last cut chunked, or the disk just restored), named by `base.json`. A new base is recorded before the old file is deleted, so a crash always leaves a `base.json` that names an existing file. A previous-release nestd ignores both files, and they are deleted with the incarnation.
- **Diff:** a chunk is read, hashed and uploaded only when its FIEMAP mapping in the new cut differs from the base's over its whole range. If two frozen files map an offset to the same physical block, they hold the same bytes there: XFS never overwrites a shared block in place, and the base keeps its blocks referenced. Anything unusual counts as changed. `FIEMAP_EXTENT_SHARED` alone says nothing: every disk shares blocks with the base image.
- **The 12 h rule is unchanged:** every non-null entry of a new manifest is verified at prepare. A stale one is uploaded again from the cut. Manifests stay self-contained, `format: 1`.
- **Expected:** a no-change turn reads nothing and commits in milliseconds after the cut. A 32 GiB disk with 1 GiB changed reads about 1 GiB from the cut in the background, about 8 s at gp3's baseline and less on NVMe.

## Later

- **ublk** (designed, not next): lazy reads for restore and fork on another host, fetching 4 MB chunks into a local NVMe cache and prefetching the working set recorded during the previous run. It is not the cut mechanism.
- **`nest diff <a> <b> [path]`:** mounts both generations read-only on the host and diffs the files.
- **Rejected:** a Firecracker block dirty bitmap (dirty tracking is for memory only); vhost-user-blk (developer preview, no snapshots, no rate limiter: [block-vhost-user.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-vhost-user.md)); qcow2 (Firecracker drives are raw); dm-era alone (no cut); NBD (ublk is the better userspace block device). dm-thin is the fallback if neither M2 nor M3′ meets the gate: a pool that fills fails every sandbox on its host.

## Flush before commit

Writes still in the guest's page cache aren't in a cut, and writes the guest has flushed may not be either: Firecracker's default `Unsafe` cache mode doesn't offer the guest a flush, so a guest `syncfs` ends once the data reaches the host, without an `fsync` ([block caching](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/block-caching.md)). So every commit, pause and suspend (**designed, not built**, guest protocol v2; today nestd asks the guest to `sync` through `prepare_snapshot`, ignores a failure, and reads the disk while the VM is paused, as in M1):

1. asks the guest agent to `syncfs` every filesystem (its `flush` request; [host-guest](../../../interfaces/host-guest/)), within a **30 s** budget (SPACE uses the same budget; [guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md));
2. `fdatasync`s the disk file on the host, so the clone's own flush is short (M2);
3. pauses the VM and cuts the disk with a reflink (M2), or, without one, reads it while paused (M1).

- **No flush, no commit.** A failed or late flush fails the commit, pause or suspend; nothing is cut. A turn-end or periodic commit tries again at its next trigger; a failed pause or suspend backs off ([SandboxDO](../../../control-plane/durable-objects/sandbox/#activity-and-idle)).
- **Two crash-consistent exceptions,** because neither can retry: a spot notice cuts every disk after a 5 s flush budget ([spot notice](../#spot-notice-2-minutes)), and salvage cuts a fenced VM it may not resume ([fencing](../../fencing/#5-salvage)). Their `reason` (`spot`, `salvage`) marks them.
- **A paused VM isn't flushed again:** it was flushed before it paused and hasn't run since.

## I/O limits

**Decided: every sandbox's drive gets Firecracker's rate limiter:** 10,000 operations/s and 100 MiB/s, each bucket holding 30 s of its rate as burst, the same defaults SPACE uses ([guest-io.md](https://github.com/perplexityai/space/blob/main/docs/space/design/guest-io.md)). Placement packs only memory and vCPUs, so without a cap one sandbox's builds could starve every other sandbox on the host. Not built.
- **Per sandbox:** the operator can set other limits; they're part of the sandbox's resources and survive restores and moves.
- **The ops bucket counts guest requests,** cached or not. At 4 KiB per request, 10,000 ops/s is about 39 MiB/s.
- **Not fair on a dense host:** idle sandboxes all bank their burst, and nothing bounds many spending it at once (SPACE notes the same gap).
