# Memory snapshots

**2 MB hugepages plus UFFD.** Firecracker requires UFFD for hugetlbfs, and 2 MB pages mean 512× fewer faults, so the per-fault cost of UFFD stops mattering. A 400 MB working set is about 200 faults: by estimate (unverified; no public benchmark of 2 MB UFFD restores exists), tens of milliseconds from page cache and a few hundred from NVMe. The first spike measures it.

**Why not 4 KB pages:**
- With the file-backed mmap backend, faults on EBS are capped by IOPS (the gp3 baseline of 3,000 IOPS means about 3k faults/s). That's tens of seconds per resume.
- With UFFD and 4 KB pages, the per-fault userspace round trip dominates.

## UFFD handler (Rust, a few hundred lines; Firecracker's example handlers are a starting point)

- **Lazy path:** answer each fault with a 2 MB `UFFDIO_COPY` from the mmapped source.
- **Eager path:** a background task copies the working set recorded during the previous resume first, then everything else. When the two paths race on a page, `EEXIST` is harmless.
- **Sources:** page cache, local NVMe, or S3 (2 MB range GETs, fetched in parallel).
- **Full hydration is required before the next snapshot,** because creating a snapshot reads all guest memory.
- **Every page is hashed at snapshot time.** "Not faulted since resume" doesn't mean unchanged: a page the eager path filled never faults, so later guest writes to it go unseen. Hashing runs after the VM resumes, from the snapshot file, off the pause path; only new hashes are uploaded. UFFD write-protect could cut the hashing later (whether it works on hugetlbfs is unverified).
- **Free page reporting** (2 MiB granularity) is optional. If it's on, the handler must process `UFFD_EVENT_REMOVE` ([Firecracker changelog](https://github.com/firecracker-microvm/firecracker/blob/main/CHANGELOG.md)).
- **Rejected:** transparent hugepages (they don't integrate with UFFD) and diff snapshots (dirty tracking cancels the hugepage benefit; [hugepages.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/hugepages.md)).

## Restore ABI

A snapshot must be restored on identical hardware and software ([snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)). A memory generation's **restore ABI** says exactly which: a SHA-256 over a canonical, schema-versioned descriptor.

| Field | Why it's in |
|---|---|
| Firecracker binary digest | The VMM that writes and loads the snapshot, pinned with its patch level ([driver](../../drivers/firecracker/)) |
| Snapshot format version | Firecracker checks it on load |
| Host kernel digest | KVM state is saved and restored by the host kernel |
| Host CPU (vendor, family, model), CPU template, and a digest of the CPUID and MSRs the guest sees | Firecracker restores only on the CPU model the snapshot was taken on |
| Hugepage size | The memory layout and the UFFD path |
| Guest platform (OS, architecture) and guest kernel digest | The snapshot holds the running guest kernel, and qualification is per (Firecracker, guest kernel) pair |
| VM profile version | nest's VM shape: the device set (drives, `tap0`, vsock, entropy, VMGenID, VMClock, free page reporting) and the memory manifest format |

**Not in it:** the guest agent (the host accepts a range of guest protocol versions; see [host-guest](../../../interfaces/host-guest/)), nestd and the rest of the host software, the image, the sandbox's size (placement checks capacity separately), instance type names, and every version string.

- **Canonical:** fixed field order and spellings, lowercase `sha256:` digests. The canonical bytes are hashed, never a JSON or wire encoding.
- **Never inferred.** A host computes its ABIs from the bytes it runs, never from version strings. Adding a required field means a new schema version, so an old reader can't take a new descriptor for one it knows.
- **Hosts advertise** the ABIs they can **create** and those they can **load** (in `hello` and `capacity`). A host creates only with a (Firecracker, guest kernel) pair qualified for memory restore, and otherwise makes disk-only generations. It loads what it creates, plus the ABI of any older Firecracker its image keeps for loading (none today).
- **Placement:** a memory generation is placed only on a host that loads its ABI ([FleetDO](../../../control-plane/durable-objects/fleet/)). If no connected host with room loads it and the cell's desired host version doesn't either, the sandbox cold-boots the same generation's disk, and the rollback notice says process state was lost.
- **Qualification:** SPACE qualifies memory restore per (Firecracker, guest kernel) pair and runs its Firecracker 1.17.0 / guest kernel 6.18.44 pair as cold execution only ([execution-environments.md](https://github.com/perplexityai/space/blob/main/docs/execution-environments.md)). nest's first spike qualifies nest's pair the same way; until it does, hosts create no memory generations.
- **Upgrades:** a host upgrade that changes the ABI makes dormant memory generations unloadable. **Decided: they resume disk-only**, with "process state lost" in the rollback notice, rather than keeping old hosts until those generations age out. Memory is a cache over a complete disk generation, sandboxes may sleep for days, and old hosts kept for them would defeat scale-to-zero. See [provisioning](../../../compute/provisioning/#upgrades).

## Base generations

**One base memory generation per (image digest, restore ABI)** makes creating a sandbox a restore instead of a boot.
- **Made** by booting the image cold until the guest agent is ready, dropping caches and taking a full snapshot. The first cold boot of an image on an ABI without a base prepares one in a scratch VM in the background. After a failure, preparation backs off per image digest (1 h, doubling to 24 h).
- **Used like a live fork:** many sandboxes resume the same snapshot, so every create runs the post-fork fixes (randomness, clock, machine-id, hostname; see [fork](../../#fork)).
- **Cold boot is the fallback and must always work:** a missing, unloadable or failing base means a cold boot, never an error.
- **No warm pools of idle VMs.** nest has one owner, so demand is sparse; pooled VMs would hold hugepages and keep spot hosts from scaling to zero. A base costs only S3.
- **Indexed by FleetDO** per cell, and a GC root until its image is retired ([GC](../object-store/#garbage-collection)).

## Tiers

| Tier | Location | Resume |
|---|---|---|
| Hot | Host page cache | Near-instant |
| Warm | Local NVMe (`d` instance families) | ~0.2–1 s |
| Cold | S3 (Express One Zone for recent generations) | Prefetch the working set, then load lazily |

## Shrinking snapshots

Before each snapshot, the guest agent runs `drop_caches`. Because the guest kernel uses `init_on_free=1`, freed pages are zero. zstd then compresses them to nearly nothing. Keep guests at 2–4 GB.

Agents without hands have no sandbox, so they never need memory snapshots.
