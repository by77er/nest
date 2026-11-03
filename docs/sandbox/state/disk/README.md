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

**Built; deploys on merge** (`crates/nestd/src/host.rs` `cut_checkpoint`, `commit_cut`; `storage.rs` `reflink`). **Decided (2026-11-03, the owner's): ship M2, cost approved, though it failed its gate (below), then build M3′ (the gate's fallback, below).** On a used disk its pause is seconds, but M1 reads a changed disk whole in the pause (33–39 s).

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
  - a fork waits for its own cut's generation;
  - **the command executor never waits on a fenced incarnation's lock** (review, 2026-11-03). Every command that takes the lock refuses a stale or fenced epoch before the wait and again after it. A retire releases the lock across its backoff, so a command that began waiting before the fence gets it after one salvage attempt at most, finds the fence and returns. Test: `a_checkpoint_of_a_fenced_incarnation_fails_at_once_while_its_salvage_holds_the_commit_lock`; a salvage's `commit_request` goes out only after the commit in flight is answered (`a_salvage_waits_for_the_checkpoints_answer`). A lock is forgotten at the incarnation's destroy, archive, failed create or retire.
- **The guard against an unbounded pause:** a guest can fragment its own disk. Before a cut, nestd counts the disk's extent records (FIEMAP, while the VM runs). Where the clone would take longer than reading the disk's allocated bytes, that cut reads the disk in the pause instead, as M1 does, and says so in the log. The prices are `cut_clone_ns_per_extent` (15,000) and `cut_read_bytes_per_s` (180 MB/s), from the measurement. At those prices a disk must average under about 2.7 KB a record before reading wins, which 4 KiB blocks can't do, so on a `c8id` the guard is for a slower clone, not a bound. The bound is M3′'s. Test: `a_cut_whose_clone_would_outlast_a_read_reads_the_disk_instead`.
- **`cut_ms`:** the commit request carries the cut's instant, and the generation records it (`GenerationRecord.cut_ms`, additive).
- **Clean only if no VM ran since the read:** a commit answered after a fence stopped a VM that had resumed past its read (a cut's, or since M1 a read checkpoint's) used to mark the disk clean, and the retire then skipped the salvage of what the VM wrote. Fixed with this milestone (`Sbx::runs`); test `a_commit_answered_after_a_fence_leaves_the_written_disk_to_salvage`.
- **The memo hands out passes:** a cut is recorded after newer cuts may have begun, and the sentinel reads the same for every cut, so only the newest pass begun may record (`nestd_core::checkpoint`).
- **Storage: sandbox state on instance-store NVMe** where the instance type has one (`c8id.large`, now first in the cell's launch types). At first boot the host bootstrap formats it XFS with `reflink=1` and mounts it at `/var/lib/nest/data`, and nestd's state, the kernel, the base images and the jailer's chroots go there. They must share one filesystem, because the jailer hard-links the kernel and the disk. Instance store dies with a spot host, as the root volume's sandbox state does today.
  - **Any step failing** (no `mkfs.xfs`, a format or a mount failing, no reflink) leaves the state on the root volume: the host still comes up.
  - **nestd, nest-proxy and the gateway require the mount** (`RequiresMountsFor=/var/lib/nest/data` drop-ins). After a reboot none starts before it, so nothing is written into the bare directory the mount would hide.
  - **After a stop and start,** the store comes back blank and user data doesn't run again. The mount fails (`nofail`, with a 10 s device timeout), so those units don't start and the host never enrolls. nestd also refuses to start without its guest kernel and images directory (`Config::check_paths`). The host fails loudly rather than enrolling broken. Nest never stops a host (it terminates them), so this is an operator's or AWS's doing.
- **Fallback:** nestd probes `FICLONE` on its sandboxes' filesystem at start. Without it (an EBS-only type, an AMI with `reflink=0`), it logs a warning and checkpoints pause the VM while they read the disk (M1).
- **Local cache:** committed chunks no longer go into the store's local write-through cache. A same-host fork's pass keeps every chunk it reads there for the child's restore (`ObjectStore::keep_local`); restores still cache what they fetch.
- **Host kernel:** ≥ 6.7, so reads proceed during a clone ([xfs 14a53798](https://github.com/torvalds/linux/commit/14a537983b228cb050ceca3a5b743d01315dc4aa); AL2023's 6.12 kernel), with the RefluXFS fix ([CVE-2026-64600](https://seclists.org/oss-sec/2026/q3/214)).
- **Gate before it ships:** `dev/measure-cut/run.sh` launches one disposable `c8id.large` and measures:
  - the clone's pause against the disk's extent records (fresh, after 1 GiB of churn, after a simulated month of turn ends);
  - reading a cut cold;
  - a guest's write stalls during the pause.

  If a month-old 32 GiB disk's p99 clone exceeds 200 ms, [M3′](#m3-the-pause-follows-what-a-turn-changed-designed-not-built-the-owner-to-choose) comes first: the pause follows what changed (options below). A clone's cost grows with the number of extent records: 50–100 M of them locked a file for over 30 minutes (xfs 14a53798).
- **Measured (2026-11-03, one `c8id.large` in us-east-1c, kernel 6.18.56, XFS `reflink=1` on the 118 GB instance store):** the gate fails. The owner shipped M2 anyway, with M3′ next (above).

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

## M3′: the pause follows what a turn changed (designed, not built; the owner to choose)

**The problem M2's measurement found:** `FICLONE` costs about 10–15 µs per extent record of the whole file: 2.4 s at 158 k records, 8.1 s at 819 k ([measured](#m2-a-reflink-cut-in-a-brief-pause-committed-in-the-background)). A turn changes tens of MB, but a used disk carries every record its past writes split it into. M3′ makes the in-pause work follow what changed since the last cut.

**What the `Sync` io_engine allows** (the constraints on every option below):
- **Only a paused VM is safe to cut.** With `Sync`, a guest write runs on the VMM thread and completes before the guest sees it complete. While the VM is paused, nothing lands; while it runs, a write can land at any moment, and one that hits a file locked by a clone blocks the thread, and the vsock and the network with it ([design.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)).
- **A clone of a range is atomic against concurrent writes** ([ioctl_ficlonerange(2)](https://man7.org/linux/man-pages/man2/ioctl_ficlonerange.2.html)). So small range clones may run while the VM runs, each blocking a write that arrives meanwhile only for its own length.
- **The drive is a raw file,** with no backing chain. `PATCH /drives` changes the path only with a cooperative guest that doesn't touch the device meanwhile, and it isn't atomic ([patch-block.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/api_requests/patch-block.md)), so a cut can't swap the VM onto a new file. Firecracker has no block dirty tracking (rejected below). Whether `path_on_host` may be a host block device isn't stated there (unverified).
- **Buffered writes:** `Sync` writes go through the host page cache, so a range written but not yet written back is delayed allocation. Its FIEMAP mapping isn't final until a sync (`FIEMAP_FLAG_SYNC`, [fiemap](https://docs.kernel.org/filesystems/fiemap.html)), and M2 already `fdatasync`s before the pause.

**Options:**
1. **Two persistent shadows, by FIEMAP diff (recommended to measure first).**
   - `shadow-a.img` and `shadow-b.img` are reflink copies of the disk, made once when a fresh disk has few records. Cuts alternate between them, so the one a background commit reads is never written.
   - **While the VM runs,** nestd syncs the disk and FIEMAPs it and the shadow. Every range whose physical mapping differs is cloned into the shadow (`FICLONERANGE`, range by range). Two frozen files that map an offset to the same block hold the same bytes there, which is M3's rule.
   - **In the pause:** sync the residue, FIEMAP again, clone the ranges that changed since the pre-copy, resume. The shadow then equals the disk at the pause, and is the cut.
   - **The commit** reads only the chunks the diff showed changed (M3's diff, done here), and takes every other entry from the previous manifest.
   - **The pause scales with** one full FIEMAP walk (O(records), but reading the extent map writes no metadata, so its constant should be far below the clone's: unverified), plus the clones of what changed since the pre-copy. A turn's last seconds of writes are usually a few ranges.
   - **Cost:** the shadows hold at most the blocks of the last two cuts' changes. No new kernel feature, device or dependency.
   - **Risk:** if a FIEMAP walk at 819 k records is itself above the gate, this only lowers the constant.
2. **A host dm-era layer tracking writes.**
   - The drive is `/dev/mapper/era-<sbx>`, over a loop device on `disk.img`. dm-era records which blocks were written in each era ([dm-era](https://docs.kernel.org/admin-guide/device-mapper/era.html): `checkpoint` starts a new era, and `take_metadata_snap` lets userspace read each block's era).
   - **In the pause:** `checkpoint`, read the blocks written since the shadow's era, clone those ranges into the shadow, resume. Nothing walks the whole file, so **the pause scales with the blocks written** since that shadow's last cut, at dm-era's block size.
   - **Cost:**
     - a loop device, a dm target and a metadata device per sandbox;
     - block device nodes in the jail (Firecracker and jailer support unverified);
     - reading dm-era's metadata (thin-provisioning-tools, or a parser of our own);
     - a device layer on every write, whose overhead is unmeasured.

   The doc rejects "dm-era alone (no cut)": here it is only the tracker, and the reflink is still the cut.
3. **Fewer extent records** (bounds M2's pause; doesn't make it follow the turn). Combinable with 1.
   - A larger CoW extent size hint on `disk.img` (`xfs_io -c cowextsize`, [xfs_io(8)](https://man7.org/linux/man-pages/man8/xfs_io.8.html)), so the copies a cut forces are allocated in larger runs. Its effect on records after scattered writes is unmeasured.
   - **Background defragmentation** with `XFS_IOC_EXCHANGE_RANGE` ([ioctl_xfs_exchange_range(2)](https://man7.org/linux/man-pages/man2/ioctl_xfs_exchange_range.2.html): atomic, even across a crash). A fragmented range is rewritten contiguously into a scratch file, then swapped in while the VM runs, a range at a time. It needs the filesystem's exchange feature: the measured host's `xfs_info` showed `exchange=0`, so bootstrap's `mkfs.xfs` would add `-i exchange=1` (unverified on AL2023's xfsprogs). It also unshares those blocks from the cuts' shadows.
   - **Already true:** a restore or a move writes a fresh disk with few records, so fragmentation resets when a sandbox moves.
4. **Not recommended:**
   - **The guest reporting its dirty ranges** (a dm-era in the guest, or the guest agent): it trusts the guest for its own checkpoint's content, needs a guest image change, and a guest root can bypass its own layer.
   - **Cut-while-running on `Async`:** deferred until it is GA (M2's decision).

**Also in M3′'s scope** (from #138's review, 2026-11-03):
- **The cut off the serial command executor.** M2's clone (and the M1 read its guard falls back to) runs inside the host's one command executor, so a long pause of one sandbox holds up every sandbox's commands on the host.
  - The pause, the cut and the resume could run as a per-incarnation task, with the command answering once the VM is paused, or once it has resumed. Other sandboxes' commands would then run meanwhile.
  - A suspend, archive or fork of the same sandbox already orders itself behind the cut through the commit lock.
- **A bound on extent records,** so that no disk, fragmented on purpose or not, can make any pause unbounded. M2 has only its guard (clone or read, whichever is cheaper), which doesn't bound either.
  - Option 3 above bounds records in the background.
  - Option 1's FIEMAP walk is itself O(records): to be bounded, it would need option 3 or a cap where a cut falls back.

**How to measure, with the same harness and its cleanup layers:** one `c8id.large`, about 40 minutes, about $0.08 on demand. It adds these phases to `dev/measure-cut/on-host.sh`, on the same fresh, churned and month-aged disks:
- FIEMAP (with `FIEMAP_FLAG_SYNC`) time against the record count;
- option 1 end to end: the pre-copy's time and range count, then the in-pause FIEMAP plus residue clone, after 2,000 scattered 4 KiB writes and after 1 GiB;
- option 3's hint at 1 and 4 MiB: records after the same churn, and M2's clone time;
- `mkfs.xfs -i exchange=1` accepted, and one range exchanged while a writer runs;
- the guest write-stall phase, now that it records whether the VM is up.

Option 2 gets its own run only if option 1's FIEMAP walk misses the gate: dm-era's write overhead (4 KiB `O_DSYNC` latency, with and without it) and its era read time. **The gate stays M2's:** p99 pause under 200 ms on the month-aged disk.

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
