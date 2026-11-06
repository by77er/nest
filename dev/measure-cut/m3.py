#!/usr/bin/env python3
"""M3' measurements on the instance store (dev/measure-cut/on-host.sh runs it; docs/sandbox/state/disk/,
M3'). Each subcommand prints one JSON object.

  walk <file>                                   FIEMAP's full walk and XFS's inode count, timed
  opt1 <disk> <shadow> <turn> <residue> <span>  option 1 with no VM: a turn's scattered writes,
                                                the pre-copy, then the residue and the "pause"
  opt1vm <disk> <shadow> <sock> <cycles>        option 1 with a VM writing: pre-copy while it
                                                runs, then pause, residue, resume
  exchange <dir>                                XFS_IOC_EXCHANGE_RANGE while a writer runs

Option 1 keeps a shadow file equal to the disk as of the last cut: the pre-copy clones, while the
VM runs, every extent whose mapping differs from the shadow's; the pause walks the disk's map once
more, compares it with the pre-copy's, and clones only what changed since.
"""

import fcntl
import json
import os
import random
import struct
import subprocess
import sys
import threading
import time

FIEMAP = 0xC020660B  # _IOWR('f', 11, struct fiemap)
FIEMAP_FLAG_SYNC = 0x1
FIEMAP_EXTENT_LAST = 0x1
FIEMAP_EXTENT_SHARED = 0x2000
FIEMAP_EXTENT_UNWRITTEN = 0x800
FICLONERANGE = 0x4020940D  # _IOW(0x94, 13, struct file_clone_range)
FS_IOC_FSGETXATTR = 0x801C581F  # _IOR('X', 31, struct fsxattr)
XFS_IOC_EXCHANGE_RANGE = 0x40285881  # _IOW('X', 129, struct xfs_exchange_range)
HDR, EXT, BATCH = 32, 56, 16384


def ms(a, b):
    return round((b - a) * 1000, 2)


def fiemap(fd, sync=False):
    """Every extent of `fd`, as (logical, physical, length, flags), and the time spent in the kernel."""
    out, start, kernel, calls = [], 0, 0.0, 0
    while True:
        buf = bytearray(struct.pack("=QQIIII", start, (1 << 64) - 1 - start, FIEMAP_FLAG_SYNC if sync and not calls else 0, 0, BATCH, 0))
        buf += bytes(EXT * BATCH)
        a = time.perf_counter()
        fcntl.ioctl(fd, FIEMAP, buf, True)
        kernel += time.perf_counter() - a
        calls += 1
        n = struct.unpack_from("=I", buf, 20)[0]
        last = False
        for i in range(n):
            lo, ph, ln, _, _, fl, _, _, _ = struct.unpack_from("=QQQQQIIII", buf, HDR + i * EXT)
            last = last or bool(fl & FIEMAP_EXTENT_LAST)
            # An unwritten extent reads as zeros, as a hole does, and a clone maps it as a hole: left
            # out, or every pre-copy clones it again (2026-11-03: 8,978 ranges, 421 MB, every cycle).
            if fl & FIEMAP_EXTENT_UNWRITTEN:
                continue
            # Neither "last" nor "shared" says anything about the bytes: a clone makes an extent shared.
            out.append((lo, ph, ln, fl & ~(FIEMAP_EXTENT_LAST | FIEMAP_EXTENT_SHARED)))
        if n == 0 or last:
            break
        lo, _, ln, _, _, _, _, _, _ = struct.unpack_from("=QQQQQIIII", buf, HDR + (n - 1) * EXT)
        start = lo + ln
    return out, kernel, calls


def nextents(fd):
    buf = bytearray(28)
    fcntl.ioctl(fd, FS_IOC_FSGETXATTR, buf, True)
    return struct.unpack_from("=I", buf, 8)[0]


def changed(a, b):
    """The logical ranges where two maps differ (extents of either not in the other), merged."""
    sa, sb = set(a), set(b)
    rs = sorted([(e[0], e[0] + e[2]) for e in a if e not in sb] + [(e[0], e[0] + e[2]) for e in b if e not in sa])
    merged = []
    for s, e in rs:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def clone_ranges(src_fd, dst_fd, ranges):
    for s, e in ranges:
        fcntl.ioctl(dst_fd, FICLONERANGE, struct.pack("=qQQQ", src_fd, s, e - s, s))


def scatter(fd, n, span):
    buf = os.urandom(4096)
    for _ in range(n):
        os.pwrite(fd, buf, random.randrange(span // 4096) * 4096)


def same_bytes(a_fd, b_fd, size, samples=20000):
    for _ in range(samples):
        off = random.randrange(size // 4096) * 4096
        if os.pread(a_fd, 4096, off) != os.pread(b_fd, 4096, off):
            return False
    return True


def walk(path):
    fd = os.open(path, os.O_RDONLY)
    a = time.perf_counter()
    m, kernel, calls = fiemap(fd)
    b = time.perf_counter()
    m2, kernel_sync, _ = fiemap(fd, sync=True)
    c = time.perf_counter()
    x = time.perf_counter()
    n = nextents(fd)
    y = time.perf_counter()
    return {"extents": len(m), "fiemap_kernel_ms": ms(0, kernel), "fiemap_total_ms": ms(a, b), "calls": calls,
            "fiemap_sync_kernel_ms": ms(0, kernel_sync), "fiemap_sync_total_ms": ms(b, c),
            "nextents": n, "nextents_ms": ms(x, y)}


def precopy(disk_fd, shadow_fd):
    a = time.perf_counter()
    os.fdatasync(disk_fd)
    b = time.perf_counter()
    dm, dk, _ = fiemap(disk_fd)
    c = time.perf_counter()
    sm, sk, _ = fiemap(shadow_fd)
    d = time.perf_counter()
    rs = changed(dm, sm)
    e = time.perf_counter()
    clone_ranges(disk_fd, shadow_fd, rs)
    f = time.perf_counter()
    return dm, {"sync_ms": ms(a, b), "fiemap_disk_ms": ms(b, c), "fiemap_disk_kernel_ms": ms(0, dk), "fiemap_shadow_ms": ms(c, d),
                "fiemap_shadow_kernel_ms": ms(0, sk), "diff_ms": ms(d, e), "ranges": len(rs),
                "bytes": sum(e2 - s for s, e2 in rs), "clone_ms": ms(e, f), "total_ms": ms(a, f), "extents": len(dm)}


def residue(disk_fd, shadow_fd, before):
    """The in-pause step: sync, walk the disk's map, compare with the pre-copy's, clone the difference."""
    a = time.perf_counter()
    os.fdatasync(disk_fd)
    b = time.perf_counter()
    dm, dk, _ = fiemap(disk_fd)
    c = time.perf_counter()
    rs = changed(dm, before)
    d = time.perf_counter()
    clone_ranges(disk_fd, shadow_fd, rs)
    e = time.perf_counter()
    return {"sync_ms": ms(a, b), "fiemap_ms": ms(b, c), "fiemap_kernel_ms": ms(0, dk), "diff_ms": ms(c, d), "ranges": len(rs),
            "bytes": sum(e2 - s for s, e2 in rs), "clone_ms": ms(d, e), "total_ms": ms(a, e), "extents": len(dm)}


def opt1(disk, shadow, turn, res, span_gib):
    span = span_gib << 30
    dfd, sfd = os.open(disk, os.O_RDWR), os.open(shadow, os.O_RDWR)
    scatter(dfd, turn, span)
    before, pre = precopy(dfd, sfd)
    scatter(dfd, res, span)
    pause = residue(dfd, sfd, before)
    ok = same_bytes(dfd, sfd, os.fstat(dfd).st_size)
    return {"turn_writes": turn, "residue_writes": res, "precopy": pre, "pause": pause, "shadow_equals_disk": ok}


def api(sock, method, path, body):
    r = subprocess.run(["curl", "-s", "--unix-socket", sock, "-X", method, f"http://localhost{path}", "-H", "Content-Type: application/json", "-d", json.dumps(body)],
                       capture_output=True, text=True)
    return r.stdout


def opt1vm(disk, shadow, sock, cycles):
    dfd, sfd = os.open(disk, os.O_RDWR), os.open(shadow, os.O_RDWR)
    out = []
    for _ in range(cycles):
        before, pre = precopy(dfd, sfd)
        a = time.time()
        r1 = api(sock, "PATCH", "/vm", {"state": "Paused"})
        res = residue(dfd, sfd, before)
        r2 = api(sock, "PATCH", "/vm", {"state": "Resumed"})
        b = time.time()
        out.append({"at_ms": int(a * 1000), "pause_ms": ms(a, b), "precopy": pre, "residue": res, "api": [r1, r2]})
        time.sleep(5)
    return out


def exchange(d):
    f1, f2 = os.path.join(d, "x1"), os.path.join(d, "x2")
    size = 64 << 20
    for p, ch in ((f1, b"A"), (f2, b"B")):
        with open(p, "wb") as f:
            f.write(ch * size)
            os.fsync(f.fileno())
    fd1, fd2 = os.open(f1, os.O_RDWR), os.open(f2, os.O_RDWR)
    stop, writes = threading.Event(), [0]

    def writer():
        buf = b"W" * 4096
        while not stop.is_set():
            os.pwrite(fd1, buf, (48 << 20) + random.randrange(4096) * 4096)
            writes[0] += 1

    t = threading.Thread(target=writer)
    t.start()
    time.sleep(0.2)
    a = time.perf_counter()
    try:
        fcntl.ioctl(fd2, XFS_IOC_EXCHANGE_RANGE, struct.pack("=iIQQQQ", fd1, 0, 0, 0, 16 << 20, 0))
        err = None
    except OSError as e:
        err = f"{e.errno} {e.strerror}"
    b = time.perf_counter()
    stop.set()
    t.join()
    ok = err is None and os.pread(fd1, 4096, 0) == b"B" * 4096 and os.pread(fd2, 4096, 0) == b"A" * 4096
    return {"error": err, "ms": ms(a, b), "swapped": ok, "concurrent_writes": writes[0]}


if __name__ == "__main__":
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "walk":
        r = walk(args[0])
    elif cmd == "opt1":
        r = opt1(args[0], args[1], int(args[2]), int(args[3]), int(args[4]))
    elif cmd == "opt1vm":
        r = opt1vm(args[0], args[1], args[2], int(args[3]))
    elif cmd == "exchange":
        r = exchange(args[0])
    else:
        raise SystemExit(f"unknown {cmd}")
    print(json.dumps(r))
