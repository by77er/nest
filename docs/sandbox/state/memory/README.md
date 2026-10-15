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

A snapshot must be restored on identical hardware and software ([snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)). Each memory generation records its **restore ABI**: CPU family, CPU template, host kernel and Firecracker version. Memory restores run only on a matching host; anywhere else the sandbox cold-boots from the same generation's disk.

## Tiers

| Tier | Location | Resume |
|---|---|---|
| Hot | Host page cache | Near-instant |
| Warm | Local NVMe (`d` instance families) | ~0.2–1 s |
| Cold | S3 (Express One Zone for recent generations) | Prefetch the working set, then load lazily |

## Shrinking snapshots

Before each snapshot, the guest agent runs `drop_caches`. Because the guest kernel uses `init_on_free=1`, freed pages are zero. zstd then compresses them to nearly nothing. Keep guests at 2–4 GB.

Agents without hands have no sandbox, so they never need memory snapshots.
