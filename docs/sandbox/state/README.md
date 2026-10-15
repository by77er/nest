# Sandbox state

## Generations

A sandbox's state is a chain of immutable generations. Each generation is a manifest of content-addressed chunks.

```
gen    { id, parent, epoch, disk_manifest, mem_manifest?, restore_abi?, session: {offset, last_tool_use}?, kind: disk-only | checkpoint, at }
chunks s3://<cell>/chunks/<blake3>    disk: 4 MB    memory: 2 MB (one hugepage)
```

- **Chunks are immutable.** Any host can upload them at any time without harm.
- **Manifests are content-addressed in S3.** SandboxDO stores only `head = manifest hash`.
- **Commit:** upload the chunks, upload the manifest, then `commit(epoch, parent, hash)` as a compare-and-set in the DO.

## Writeback cadence

| State | Committed | Recovery point |
|---|---|---|
| Disk | At each agent's `Stop` (rate-limited to about one per 10 s); every 60 s if dirty; immediately if dirty data exceeds 256 MB; on suspend, drain or spot notice | ≤60 s, usually at a turn boundary |
| Memory | **Only** on suspend, drain or spot notice. Never on a timer (a hugepage snapshot is always full and pauses the VM). | Last suspend |

## Restore rule

A memory snapshot is valid **only when it belongs to the head generation**. Restoring older memory over a newer disk corrupts the filesystem.
- **Head is a checkpoint:** do a memory restore (the fast path).
- **Head is disk-only** (after a crash): cold-boot with the newest disk and run `--resume`. Running processes are lost; at most 60 s of file changes are lost.
- **Rollback notice:** each generation records the session position it covers (`session`). After a disk-only restore, the agent's recovery context says the workspace went back to that point and which tool calls after it may be undone, so the model checks (e.g. `git status`) instead of trusting its transcript.

## Spot notice (2 minutes)

1. **Flip the disk epoch of every sandbox first** (milliseconds each), so none loses more than the notice's worth of file changes.
2. Then, in order of recent activity: pause, write a full memory snapshot to NVMe (`sync_snapshot_files=false`), upload with zstd compression, commit.
3. Anything that doesn't finish falls back to its disk-only generation.

A **rebalance recommendation** can arrive with the notice rather than before it, so it's polled every 5 s and means: stop placing on the host and flush idle sandboxes, not a full drain ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/rebalance-recommendations.html)).

## Volumes

- **Durable:** `/workspace` and `$HOME` (which contains harness session files).
- **Local only, never written back:** `/scratch`, package caches, build output. This removes most of the write churn.

## Components

- [memory/](memory/): hugepages, UFFD, prefetch, tiers
- [disk/](disk/): ublk lazy disk, copy-on-write epoch flips
- [object-store/](object-store/): S3 per cell, costs, garbage collection
