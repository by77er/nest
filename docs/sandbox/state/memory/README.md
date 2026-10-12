# Memory snapshots

**2 MB hugepages plus UFFD.** Firecracker requires UFFD for hugetlbfs, and 2 MB pages mean 512× fewer faults, so the per-fault cost of UFFD stops mattering. A 400 MB working set is about 200 faults: tens of milliseconds from page cache, a few hundred milliseconds from NVMe.

**Why not 4 KB pages:**
- With the file-backed mmap backend, faults on EBS are capped by IOPS (the gp3 baseline of 3,000 IOPS means about 3k faults/s). That's tens of seconds per resume.
- With UFFD and 4 KB pages, the per-fault userspace round trip dominates.

## UFFD handler (Rust, a few hundred lines; Firecracker's example handlers are a starting point)

- **Lazy path:** answer each fault with a 2 MB `UFFDIO_COPY` from the mmapped source.
- **Eager path:** a background task copies the working set recorded during the previous resume first, then everything else. When the two paths race on a page, `EEXIST` is harmless.
- **Sources:** page cache, local NVMe, or S3 (2 MB range GETs, fetched in parallel).
- **Full hydration is required before the next snapshot,** because creating a snapshot reads all guest memory.
- **Dedup without dirty tracking:** pages that were never faulted in since resume are unchanged, so they reuse the previous generation's chunk hashes. Faulted pages are hashed, and only new hashes are uploaded.

## Tiers

| Tier | Location | Resume |
|---|---|---|
| Hot | Host page cache | Near-instant |
| Warm | Local NVMe (`d` instance families) | ~0.2–1 s |
| Cold | S3 (Express One Zone for recent generations) | Prefetch the working set, then load lazily |

## Shrinking snapshots

Before each snapshot, the guest agent runs `drop_caches`. Because the guest kernel uses `init_on_free=1`, freed pages are zero. zstd then compresses them to nearly nothing. Keep guests at 2–4 GB.

Captains don't use sandboxes, so they never need memory snapshots.
