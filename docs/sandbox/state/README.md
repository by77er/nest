# Sandbox state

## Generations

A sandbox's state is a chain of immutable generations. Each generation is a manifest of content-addressed chunks.

```
gen    { id, parent, epoch, disk_manifest, mem_manifest?, restore_abi?, session: {offset, last_tool_use}?, kind: disk-only | checkpoint, reason, state: ready | deleting, at }
chunks s3://<cell>/chunks/<blake3>    disk: 4 MB    memory: 2 MB (one hugepage)
```

- **Chunks are immutable.** Any host can upload them at any time without harm.
- **Manifests are content-addressed in S3.** SandboxDO stores only `head = manifest hash`.
- **Commit:** flush the guest ([disk](disk/#flush-before-commit)), read the disk while nothing writes it, upload and verify the chunks, upload the manifest, then `commit(epoch, parent, hash)` as a compare-and-set in the DO. How the read is cut and what it skips is [disk](disk/)'s.
- **Verified before commit:** every chunk a generation adds over its parent must have been uploaded less than 12 h before the commit, by this commit's PUT or as a HEAD shows, with the manifest's length; anything older is uploaded again ([GC](object-store/#garbage-collection)). The rule is applied to every non-zero chunk of the file, not only to those that differ from the parent (`storage.rs` `scan_file` and `publish`, `s3.rs` `recent`), so a commit never relies on its parent still being a GC root: retention may have dropped it (a salvage's parent may even be pruned). A committed generation is therefore `ready`: every chunk is present.
- **`reason`:** `turn_end`, `periodic`, `pressure`, `pause`, `suspend`, `drain`, `spot`, `fork` or `salvage`. Retention and rollback notices read it.
- **`deleting` is one-way.** A generation is marked `deleting` before any of its bytes can go, and never returns to `ready`, because a previous pass may already have removed some of them.
- **A manifest is self-contained.** It lists every chunk of its file (`null` for an all-zero one), not a delta over its parent, and a restore reads only that manifest (`storage.rs` `scan_file`, `restore_file`). So a kept generation never needs its parent: retention can drop a parent and keep the child.

## Writeback cadence

| State | Committed | Recovery point |
|---|---|---|
| Disk | At each agent's `Stop` (rate-limited to about one per 10 s); every 60 s if dirty; immediately if dirty data exceeds 256 MB; on pause, suspend, drain or spot notice | ≤60 s, usually at a turn boundary |
| Memory | **Only** on suspend, drain or spot notice. Never on a timer (a hugepage snapshot is always full and pauses the VM). | Last suspend |

**Built:** turn-end commits (SandboxDO asks for a `turn_end` checkpoint when an agent's turn completes, [one at a time](#one-turn-end-checkpoint-at-a-time); one sooner than 10 s after the last landed is deferred, not dropped), and suspend, drain and spot notice. **Not built:** the 60 s timer and the 256 MB threshold, so for now the recovery point is the last turn end. A sandbox's first commit uploads its base image's chunks (about 700 MB for `nest-base`, roughly 30 s), until base generations exist.

The cadence is the RPO: a lost host loses at most the work since its last commit, and the loss is recorded ([SandboxDO](../../control-plane/durable-objects/sandbox/#losses)).

### One turn-end checkpoint at a time

**Decided (2026-11-02).** Without the reflink cut ([disk](disk/#m2-a-reflink-cut-in-a-brief-pause-committed-in-the-background); built, not deployed), a checkpoint pauses the VM while it reads a changed disk, so a second one queued right behind the first only doubles the pause (two back-to-back checkpoints of a 32 GiB disk held one VM paused 33–39 s each).
- **At most one in flight.** SandboxDO records the `turn_end` checkpoint it asked for (kv `turn_checkpoint_inflight`: epoch, when, turns that ended meanwhile) until it **lands**: its `sandbox_checkpoint` command's result, ok or not (FleetDO passes it on, keyed by the command, so a late result of an older checkpoint lands nothing), or, sooner, its `turn_end` commit decided (any outcome, a replay of a stored one included). The command's result covers a checkpoint that sent no new commit: nestd asked again for an unanswered commit of another reason and found nothing new, or found no disk. One out longer than 5 min (its pause plus nestd's 60 s commit timeout, with room for a large disk) no longer counts.
- **Turns that end while one is in flight share one follow-up,** 10 s after it lands, instead of each queueing a checkpoint behind it. One that never lands gets them theirs when its 5 min window ends.
- **The follow-up is never skipped.** The in-flight checkpoint's cut is the guest's `sync` (`prepare_snapshot`; the guest freezes nothing), not the pause, so a call answered between the two may have left writes in the guest's page cache that it lacks.
- **Residual: a replay can land one early.** A replayed stored `turn_end` commit (nestd asking again for an earlier one before chunking the current one) lands the checkpoint in flight before that checkpoint's own pause (nestd asks again first, with the VM running), so a turn ending after that can queue a checkpoint right behind it: a back-to-back pause, rarer than before and short since M1, which the runner's 120 s paused budget still covers.
- **The 10 s interval counts from the landing,** not the request, so the VM runs at least 10 s between two turn-end pauses.
- **Retention is unchanged:** it reads only reasons and ages, and every checkpoint is still a `turn_end` generation ([retention](#retention)); fewer of them are made.
- **During the pause** the [gateway](../gateway/) answers binds `busy`, which the runner waits out; an unchanged disk isn't read at all ([disk](disk/#m1-pause-only-to-read-and-never-read-an-unchanged-disk)). SandboxDO's `dirty` flag can't stand in for that check: it means "a VM ran since the last commit".

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

**Built** (`control-plane/src/lib/retention.ts`, pure, with SandboxDO as its shell):
- **One function, `isRestoreSource(gen, view)`**, over the head, the live pins and every orphan's parent. An orphan is its branch's head when no orphan (even a `deleting` one) names it as parent; it expires 30 days after its commit.
- **Pins:** the only in-flight claim built is a placement's. It pins the head it restores by id, in the same synchronous step that claims the epoch (`restore_pin`), and the pin lasts while that epoch is being placed or its VM is being created or restored; running, suspending, failing, a destroy or a newer claim end it. Forks aren't built.
- **Resume and placement** restore the head only through the predicate: a head that isn't a restore source is refused (an error, logged), never restored and never replaced by an older generation. It can't happen: only a commit moves the head, to a new generation.
- **Retention** marks only what the predicate rejects: a generation `deleting`, or a checkpoint's memory unrooted (`mem_unrooted_ms`, one-way like `deleting`). **GC's roots** follow those durable marks only, never the mode or the clock, so switching retention back never roots again what a sweep may already have taken.
- **The drain gate** doesn't use it yet: the gate built is "suspended, then evicted" ([FleetDO](../../control-plane/durable-objects/fleet/)), and a suspended sandbox's last commit is its head by construction.
- **A restore source never becomes one again once it stops being one** (the head moves only to a new generation; a pin takes the head; an orphan head's child is newer and expires later). That makes unrooting memory safe; it is property-tested, not proved.

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
| Turn ends (`reason: turn_end`) | The newest 20 always, and up to the newest 200 while under 7 days old: they're the rewind points and carry the session offset |
| Orphaned sibling heads | 30 days, like other parked work |
| Everything else | Newest 5 at 1-min spacing, then 1 at 5 min, 6 at 10 min, 6 hourly and 4 six-hourly; older ones go (about 24 h). SPACE uses the same tiers ([snapshot_scheduler.rs](https://github.com/perplexityai/space/blob/main/crates/libs/sbx/mgr/server/src/snapshot_scheduler.rs)) |
| An orphan that isn't its branch's head | Not kept: nothing loads it |
| The memory of a checkpoint that's no longer a restore source | Not kept: the restore rule never loads it, so it stops being a GC root |

SandboxDO runs retention from its alarm, in the same single writer that admits forks and destroys the sandbox, so a fork can't pin a generation that retention is deleting.

**Turn ends are bounded** (decided 2026-11-01; the owner confirmed it 2026-11-02, with an orphan's non-head generations dropped at once and a sparse sandbox's newest 6 kept): kept "always", a sandbox that lives for months would root every turn's dirty chunks forever. A turn dirties whole 4 MB chunks, so a generation's own bytes are likely tens of MB (unverified); at Standard's $0.023/GB-month ([S3 pricing](https://aws.amazon.com/s3/pricing/), us-east-1, first 50 TB), 200 of 50 MB is about $0.23 a month per sandbox, where 50 turns a day kept for a year would be over $20 and growing. Rewinding isn't built, git keeps the code's history, and a week matches the commit records' retention. The newest 20 stay at any age, so a sandbox idle for a while keeps its recent turns.

**The tiers** follow SPACE: each tier keeps its own newest slots and the tiers overlap. A slot is a wall-clock interval of the tier's spacing, aligned to the Unix epoch (so slots nest), represented by its newest generation; the slots counted are those with a generation. A busy sandbox keeps about 18 tier generations spanning 24 h; a sparse one keeps its newest 6 at any age. Orphans take no main-chain slot.

**Built** (`retention()` in `control-plane/src/lib/retention.ts`; SandboxDO's `retention` deadline):
- A pass runs a minute after a commit, every 6 hours while the sandbox lives, and from the lifetime check for a sandbox that never commits again. It reads the ready rows, decides, and marks at most 500 `deleting` in one synchronous step (no await between), so a claim's pin and a commit's new head are always seen; more continue a second later.
- It is stable: what it drops never changes what it keeps, and a generation it stops keeping is never kept again, so a second pass marks nothing new.
- Bytes go only through GC, after its grace and its dry run. A main-chain `deleting` row is pruned a week after it was marked, with its commit record. An orphan's row is never pruned: a salvage has no parent check, so a late re-ask must find its first answer rather than make a second orphan from manifests GC may have swept; orphans are few.
- **`SANDBOX_RETENTION`:** `on` (the default) marks, and records each pass (`kv.retention_report`, a log line; `retained` in `GET /v1/sandboxes/<id>/generations` says why a generation is kept); `off` is an emergency stop that marks nothing more. Marks already made stay in either mode. There is no report-only mode (the owner's call, 2026-11-01). FleetDO records when it first sees `on` and counts only GC runs marked after that as proven, so the first GC run after it turns on (or on again) is dry ([dev/deploy.md](../../../dev/deploy.md)).
- Destroyed sandboxes are unchanged: no pass runs, and all their generations stopped being roots at the destroy.
- Proved over the GC model ([commit-gc](../../verification/commit-gc/#retention)), which treats a generation's disk and memory as one key set: a pass never deletes a key of a generation that isn't `deleting`, and the head and pinned generations never are. Memory unrooting is argued by hand and property-tested there, not proved.

**Also built:** a whole sandbox nobody uses goes: dormant (no agent attached, no VM up) for its idle TTL, a day by default, it is destroyed, and its generations stop being roots ([lifetime](../../control-plane/durable-objects/sandbox/#lifetime)).

## Spot notice (2 minutes)

**Built:** the notice suspends every running sandbox, in no order ([autoscaling](../../compute/autoscaling/)). **Designed, not built:** the order below.

1. **Cut the disk of every sandbox first:** flush all guests in parallel with a 5 s budget, then reflink-cut every disk in a brief pause each ([disk](disk/#m2-a-reflink-cut-in-a-brief-pause-committed-in-the-background)) whether or not its flush finished, so none loses more than the notice's worth of file changes. A cut without a flush is crash-consistent (`reason: spot`).
2. Then, in order of recent activity: pause, write a full memory snapshot to NVMe (`sync_snapshot_files=false`), upload with zstd compression, commit.
3. Anything that doesn't finish falls back to its disk-only generation, and the loss is recorded.

A **rebalance recommendation** can arrive with the notice rather than before it, so it's polled every 5 s and means: stop placing on the host and flush idle sandboxes, not a full drain ([AWS](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/rebalance-recommendations.html)).

## Volumes

- **Durable:** `/workspace` and `$HOME`.
- **Local only, never written back:** `/scratch`, package caches, build output. This removes most of the write churn.

## Components

- [memory/](memory/): hugepages, UFFD, prefetch, tiers, restore ABI, base generations
- [disk/](disk/): pausing only to read, the unchanged-disk check, reflink cuts in a brief pause (built, not deployed), extent diffs (designed), flush before commit, I/O limits, the ublk lazy disk (later)
- [object-store/](object-store/): S3 per cell, costs, garbage collection
