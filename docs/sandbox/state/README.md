# Sandbox state

## Generations

A sandbox's state is a chain of immutable generations. Each generation is a manifest of content-addressed chunks.

```
gen    { id, parent, epoch, disk_manifest, mem_manifest?, restore_abi?, session: {offset, last_tool_use}?, kind: disk-only | checkpoint, reason, state: ready | deleting, at }
chunks s3://<cell>/chunks/<blake3>    disk: 4 MB    memory: 2 MB (one hugepage)
```

- **Chunks are immutable.** Any host can upload them at any time without harm.
- **Manifests are content-addressed in S3.** SandboxDO stores only `head = manifest hash`.
- **Commit:** flush the guest ([disk](disk/#flush-before-commit)), upload the chunks, verify them, upload the manifest, then `commit(epoch, parent, hash)` as a compare-and-set in the DO.
- **Verified before commit:** every chunk a generation adds over its parent must have been uploaded less than 12 h before the commit, by this commit's PUT or as a HEAD shows, with the manifest's length; anything older is uploaded again ([GC](object-store/#garbage-collection)). The parent's chunks are protected as a GC root. A committed generation is therefore `ready`: every chunk is present.
- **`reason`:** `turn_end`, `periodic`, `pressure`, `pause`, `suspend`, `drain`, `spot`, `fork` or `salvage`. Retention and rollback notices read it.
- **`deleting` is one-way.** A generation is marked `deleting` before any of its bytes can go, and never returns to `ready`, because a previous pass may already have removed some of them.

## Writeback cadence

| State | Committed | Recovery point |
|---|---|---|
| Disk | At each agent's `Stop` (rate-limited to about one per 10 s); every 60 s if dirty; immediately if dirty data exceeds 256 MB; on pause, suspend, drain or spot notice | ≤60 s, usually at a turn boundary |

**Built:** turn-end commits (SandboxDO asks for a `turn_end` checkpoint when an agent's turn completes; one sooner than 10 s after the last is deferred, not dropped), and suspend, drain and spot notice. **Not built:** the 60 s timer and the 256 MB threshold, so for now the recovery point is the last turn end. A sandbox's first commit uploads its base image's chunks (about 700 MB for `nest-base`, roughly 30 s), until base generations exist.
| Memory | **Only** on suspend, drain or spot notice. Never on a timer (a hugepage snapshot is always full and pauses the VM). | Last suspend |

The cadence is the RPO: a lost host loses at most the work since its last commit, and the loss is recorded ([SandboxDO](../../control-plane/durable-objects/sandbox/#losses)).

## Restore sources

**One predicate, `isRestoreSource(gen)`, decides both "load this" and "never delete this".** It's true when the generation is `ready` and is exactly (by id) one of:
- the sandbox's head;
- a generation pinned by an in-flight resume, fork or restore (the claim records the id; the pin ends at completion or abandon);
- the head of an orphaned sibling that hasn't expired.

Its users:
- **Resume selection** loads only a restore source.
- **The drain gate** terminates a host only when, for each resident, the host's last committed generation is the head ([FleetDO](../../control-plane/durable-objects/fleet/)).
- **Retention and GC** never delete one ([object store](object-store/#garbage-collection)).

If these drifted apart, GC could delete exactly what a resume would load. It compares generation ids, never timestamps: an upload that lands late is still a different generation.

**Not built:** there is no single predicate in code yet. Nothing is deleted, so nothing can drift: retention isn't built, SandboxDO's `gcRoots` returns every generation it records, and placement restores the head.

## Restore rule

A memory snapshot is valid **only when it belongs to the head generation**. Restoring older memory over a newer disk corrupts the filesystem.
- **Head is a checkpoint:** do a memory restore (the fast path) on a host that loads its [restore ABI](memory/#restore-abi).
- **Head is disk-only** (after a crash): cold-boot with the newest disk and run `--resume`. Running processes are lost; at most 60 s of file changes are lost.
- **Head is a checkpoint no host can load** (its ABI is gone, or its memory restore failed): cold-boot the same generation's disk. Files are intact; process state is lost.
- **Rollback notice:** each generation records the session position it covers (`session`). After a disk-only restore, the agent's recovery context says the workspace went back to that point, which tool calls after it may be undone, and whether process state was lost, so the model checks (e.g. `git status`) instead of trusting its transcript.

## Retention

Restore sources and turn ends are kept; everything else is thinned by age.

| Generations | Kept |
|---|---|
| Restore sources (above) | Always |
| Turn ends (`reason: turn_end`) | Always: they're the rewind points and carry the session offset |
| Orphaned sibling heads | 30 days, like other parked work |
| Everything else | Newest 5 at 1-min spacing, then 1 at 5 min, 6 at 10 min, 6 hourly and 4 six-hourly; older ones go (about 24 h). SPACE uses the same tiers ([snapshot_scheduler.rs](https://github.com/perplexityai/space/blob/main/crates/libs/sbx/mgr/server/src/snapshot_scheduler.rs)) |
| The memory of a checkpoint that's no longer a restore source | Not kept: the restore rule never loads it, so it stops being a GC root |

SandboxDO runs retention from its alarm, in the same single writer that admits forks and destroys the sandbox, so a fork can't pin a generation that retention is deleting. **Not built:** every generation is kept. **Built:** a whole sandbox nobody uses goes: dormant (no agent attached, no VM up) for its idle TTL, 30 days by default, it is destroyed, and its generations stop being roots ([lifetime](../../control-plane/durable-objects/sandbox/#lifetime)).

## Spot notice (2 minutes)

**Built:** the notice suspends every running sandbox, in no order ([autoscaling](../../compute/autoscaling/)). **Designed, not built:** the order below.

1. **Cut the disk of every sandbox first:** flush all guests in parallel with a 5 s budget, then flip every disk epoch (milliseconds each) whether or not its flush finished, so none loses more than the notice's worth of file changes. A cut without a flush is crash-consistent (`reason: spot`).
2. Then, in order of recent activity: pause, write a full memory snapshot to NVMe (`sync_snapshot_files=false`), upload with zstd compression, commit.
3. Anything that doesn't finish falls back to its disk-only generation, and the loss is recorded.

A **rebalance recommendation** can arrive with the notice rather than before it, so it's polled every 5 s and means: stop placing on the host and flush idle sandboxes, not a full drain ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/rebalance-recommendations.html)).

## Volumes

- **Durable:** `/workspace` and `$HOME`.
- **Local only, never written back:** `/scratch`, package caches, build output. This removes most of the write churn.

## Components

- [memory/](memory/): hugepages, UFFD, prefetch, tiers, restore ABI, base generations
- [disk/](disk/): ublk lazy disk, copy-on-write epoch flips, flush before commit, I/O limits
- [object-store/](object-store/): S3 per cell, costs, garbage collection
