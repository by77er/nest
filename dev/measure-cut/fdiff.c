// M3' option 1 compiled (dev/measure-cut/on-host.sh builds and runs it; docs/sandbox/state/disk/, M3').
// Each command prints one JSON object.
//
//   fdiff walk <file>                          the FIEMAP walk alone
//   fdiff opt1 <disk> <shadow> <turn> <res>    no VM: scattered writes, pre-copy, residue, checked
//   fdiff vm <disk> <shadow> <sock> <cycles>   a VM writing: pre-copy while it runs, then pause,
//                                              residue, resume (Firecracker's API through curl)
//   fdiff defrag <file> <tmp> <chunk_mib> <max> rewrite each chunk with more than <max> extents
//                                              into <tmp> and swap it in (XFS_IOC_EXCHANGE_RANGE)
//
// The diff compares two maps sorted by logical offset: an extent is unchanged when the other map
// has the same (logical, physical, length, flags) one; flags "last" and "shared" are ignored, and an
// unwritten extent counts as a hole (a clone maps it as one).
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/fiemap.h>
#include <linux/fs.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

struct ext { uint64_t lo, ph, ln; uint32_t fl; };
struct map { struct ext *e; size_t n, cap; double kernel_ms; };
struct range { uint64_t s, e; };
struct ranges { struct range *r; size_t n, cap; uint64_t bytes; };

struct xfs_exchange_range { int32_t file1_fd; uint32_t pad; uint64_t file1_offset, file2_offset, length, flags; };
#define XFS_IOC_EXCHANGE_RANGE _IOW('X', 129, struct xfs_exchange_range)

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static void die(const char *what) { fprintf(stderr, "%s: %s\n", what, strerror(errno)); exit(1); }

#define BATCH 16384
static void fiemap_range(int fd, uint64_t from, uint64_t len, struct map *m) {
  size_t sz = sizeof(struct fiemap) + BATCH * sizeof(struct fiemap_extent);
  struct fiemap *f = malloc(sz);
  uint64_t start = from, end = from + len;
  m->n = 0;
  m->kernel_ms = 0;
  for (;;) {
    memset(f, 0, sizeof(*f));
    f->fm_start = start;
    f->fm_length = end - start;
    f->fm_extent_count = BATCH;
    double a = now_ms();
    if (ioctl(fd, FS_IOC_FIEMAP, f) < 0) die("FIEMAP");
    m->kernel_ms += now_ms() - a;
    int last = 0;
    for (uint32_t i = 0; i < f->fm_mapped_extents; i++) {
      struct fiemap_extent *x = &f->fm_extents[i];
      if (x->fe_flags & FIEMAP_EXTENT_LAST) last = 1;
      if (x->fe_flags & FIEMAP_EXTENT_UNWRITTEN) continue;
      if (m->n == m->cap) { m->cap = m->cap ? m->cap * 2 : 1 << 16; m->e = realloc(m->e, m->cap * sizeof(struct ext)); }
      m->e[m->n++] = (struct ext){x->fe_logical, x->fe_physical, x->fe_length, x->fe_flags & ~(FIEMAP_EXTENT_LAST | FIEMAP_EXTENT_SHARED)};
    }
    if (f->fm_mapped_extents == 0 || last) break;
    struct fiemap_extent *x = &f->fm_extents[f->fm_mapped_extents - 1];
    start = x->fe_logical + x->fe_length;
    if (start >= end) break;
  }
  free(f);
}
static void fiemap_all(int fd, struct map *m) { fiemap_range(fd, 0, UINT64_MAX, m); }

static void add(struct ranges *r, uint64_t s, uint64_t e) {
  if (r->n && s <= r->r[r->n - 1].e) {
    if (e > r->r[r->n - 1].e) r->r[r->n - 1].e = e;
    return;
  }
  if (r->n == r->cap) { r->cap = r->cap ? r->cap * 2 : 1 << 12; r->r = realloc(r->r, r->cap * sizeof(struct range)); }
  r->r[r->n++] = (struct range){s, e};
}

static int same(const struct ext *a, const struct ext *b) { return a->lo == b->lo && a->ph == b->ph && a->ln == b->ln && a->fl == b->fl; }

// The logical ranges where `a` and `b` differ, merged, in order.
static void diff(const struct map *a, const struct map *b, struct ranges *r) {
  size_t i = 0, j = 0;
  r->n = 0;
  while (i < a->n || j < b->n) {
    const struct ext *x = i < a->n ? &a->e[i] : NULL, *y = j < b->n ? &b->e[j] : NULL;
    if (x && y && same(x, y)) { i++; j++; continue; }
    // Take the one that starts first (both when they start together): it differs.
    if (x && (!y || x->lo <= y->lo)) {
      add(r, x->lo, x->lo + x->ln);
      if (y && y->lo == x->lo) { add(r, y->lo, y->lo + y->ln); j++; }
      i++;
    } else {
      add(r, y->lo, y->lo + y->ln);
      j++;
    }
  }
  r->bytes = 0;
  for (size_t k = 0; k < r->n; k++) r->bytes += r->r[k].e - r->r[k].s;
}

static double clone(int src, int dst, const struct ranges *r) {
  double a = now_ms();
  for (size_t k = 0; k < r->n; k++) {
    struct file_clone_range c = {.src_fd = src, .src_offset = r->r[k].s, .src_length = r->r[k].e - r->r[k].s, .dest_offset = r->r[k].s};
    if (ioctl(dst, FICLONERANGE, &c) < 0) die("FICLONERANGE");
  }
  return now_ms() - a;
}

static void scatter(int fd, long n, uint64_t span) {
  static char buf[4096];
  for (int i = 0; i < 4096; i++) buf[i] = (char)rand();
  for (long k = 0; k < n; k++) {
    uint64_t off = ((uint64_t)rand() * (uint64_t)rand()) % (span / 4096) * 4096;
    if (pwrite(fd, buf, 4096, (off_t)off) != 4096) die("pwrite");
  }
}

// Pre-copy: the disk's map and the shadow's, their difference cloned into the shadow. `before` keeps
// the disk's map for the residue.
static void precopy(int d, int s, struct map *before, FILE *o) {
  struct map sm = {0};
  struct ranges r = {0};
  double a = now_ms();
  fdatasync(d);
  double b = now_ms();
  fiemap_all(d, before);
  double c = now_ms();
  fiemap_all(s, &sm);
  double e = now_ms();
  diff(before, &sm, &r);
  double f = now_ms();
  double cl = clone(d, s, &r);
  fprintf(o, "{\"sync_ms\": %.2f, \"fiemap_disk_ms\": %.2f, \"fiemap_shadow_ms\": %.2f, \"diff_ms\": %.2f, \"ranges\": %zu, \"bytes\": %lu, \"clone_ms\": %.2f, \"total_ms\": %.2f, \"extents\": %zu}",
          b - a, c - b, e - c, f - e, r.n, (unsigned long)r.bytes, cl, now_ms() - a, before->n);
  free(sm.e);
  free(r.r);
}

// The in-pause step: sync, the disk's map, its difference from the pre-copy's, cloned.
static void residue(int d, int s, const struct map *before, FILE *o) {
  struct map dm = {0};
  struct ranges r = {0};
  double a = now_ms();
  fdatasync(d);
  double b = now_ms();
  fiemap_all(d, &dm);
  double c = now_ms();
  diff(&dm, before, &r);
  double e = now_ms();
  double cl = clone(d, s, &r);
  fprintf(o, "{\"sync_ms\": %.2f, \"fiemap_ms\": %.2f, \"fiemap_kernel_ms\": %.2f, \"diff_ms\": %.2f, \"ranges\": %zu, \"bytes\": %lu, \"clone_ms\": %.2f, \"total_ms\": %.2f, \"extents\": %zu}",
          b - a, c - b, dm.kernel_ms, e - c, r.n, (unsigned long)r.bytes, cl, now_ms() - a, dm.n);
  free(dm.e);
  free(r.r);
}

static int same_bytes(int a, int b, uint64_t size) {
  static char x[4096], y[4096];
  for (int k = 0; k < 20000; k++) {
    uint64_t off = ((uint64_t)rand() * (uint64_t)rand()) % (size / 4096) * 4096;
    if (pread(a, x, 4096, (off_t)off) != 4096 || pread(b, y, 4096, (off_t)off) != 4096) return 0;
    if (memcmp(x, y, 4096)) return 0;
  }
  return 1;
}

static void api(const char *sock, const char *state) {
  char cmd[512];
  snprintf(cmd, sizeof cmd, "curl -s --unix-socket %s -X PATCH http://localhost/vm -H 'Content-Type: application/json' -d '{\"state\": \"%s\"}' >/dev/null", sock, state);
  if (system(cmd) != 0) fprintf(stderr, "api %s failed\n", state);
}

static uint64_t nextents(int fd) {
  struct fsxattr x;
  return ioctl(fd, FS_IOC_FSGETXATTR, &x) < 0 ? 0 : x.fsx_nextents;
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  srand(42);
  const char *cmd = argv[1];
  if (!strcmp(cmd, "walk")) {
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) die("open");
    struct map m = {0};
    double a = now_ms();
    fiemap_all(fd, &m);
    double b = now_ms();
    struct map m2 = {0}, m3 = {0};
    struct ranges r = {0};
    fiemap_all(fd, &m2);
    double c = now_ms();
    diff(&m, &m2, &r);
    double e = now_ms();
    (void)m3;
    printf("{\"extents\": %zu, \"walk_ms\": %.2f, \"walk_kernel_ms\": %.2f, \"walk2_ms\": %.2f, \"diff_of_equal_maps_ms\": %.2f, \"nextents\": %lu}\n",
           m.n, b - a, m.kernel_ms, c - b, e - c, (unsigned long)nextents(fd));
    return 0;
  }
  if (!strcmp(cmd, "opt1") && argc == 6) {
    int d = open(argv[2], O_RDWR), s = open(argv[3], O_RDWR);
    if (d < 0 || s < 0) die("open");
    struct stat st;
    fstat(d, &st);
    scatter(d, atol(argv[4]), 16ULL << 30);
    struct map before = {0};
    printf("{\"turn_writes\": %s, \"residue_writes\": %s, \"precopy\": ", argv[4], argv[5]);
    precopy(d, s, &before, stdout);
    scatter(d, atol(argv[5]), 16ULL << 30);
    printf(", \"pause\": ");
    residue(d, s, &before, stdout);
    printf(", \"shadow_equals_disk\": %s}\n", same_bytes(d, s, (uint64_t)st.st_size) ? "true" : "false");
    return 0;
  }
  if (!strcmp(cmd, "vm") && argc == 6) {
    int d = open(argv[2], O_RDWR), s = open(argv[3], O_RDWR);
    if (d < 0 || s < 0) die("open");
    int n = atoi(argv[5]);
    printf("[");
    for (int k = 0; k < n; k++) {
      struct map before = {0};
      struct timespec w;
      clock_gettime(CLOCK_REALTIME, &w);
      printf("%s{\"precopy\": ", k ? ", " : "");
      precopy(d, s, &before, stdout);
      clock_gettime(CLOCK_REALTIME, &w);
      double a = now_ms();
      api(argv[4], "Paused");
      printf(", \"at_ms\": %ld, \"residue\": ", (long)(w.tv_sec * 1000 + w.tv_nsec / 1000000));
      residue(d, s, &before, stdout);
      api(argv[4], "Resumed");
      printf(", \"pause_ms\": %.2f}", now_ms() - a);
      fflush(stdout);
      free(before.e);
      sleep(5);
    }
    printf("]\n");
    return 0;
  }
  if (!strcmp(cmd, "defrag") && argc == 6) {
    int d = open(argv[2], O_RDWR), t = open(argv[3], O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (d < 0 || t < 0) die("open");
    struct stat st;
    fstat(d, &st);
    ftruncate(t, st.st_size);
    uint64_t chunk = (uint64_t)atol(argv[4]) << 20, max = (uint64_t)atol(argv[5]), size = (uint64_t)st.st_size;
    uint64_t before = nextents(d), rewritten = 0, copied = 0, swaps = 0;
    char *buf = malloc(chunk);
    double a = now_ms(), xch = 0;
    struct map m = {0};
    for (uint64_t off = 0; off < size; off += chunk) {
      uint64_t len = off + chunk > size ? size - off : chunk;
      fiemap_range(d, off, len, &m);
      if (m.n <= max) continue;
      // Copy the chunk's data (holes stay holes) into the scratch file at the same offset.
      uint64_t pos = off;
      while (pos < off + len) {
        off_t dat = lseek(d, (off_t)pos, SEEK_DATA);
        if (dat < 0 || (uint64_t)dat >= off + len) break;
        off_t hole = lseek(d, dat, SEEK_HOLE);
        uint64_t e = (uint64_t)hole > off + len ? off + len : (uint64_t)hole;
        ssize_t got = pread(d, buf, e - (uint64_t)dat, dat);
        if (got < 0 || pwrite(t, buf, (size_t)got, dat) != got) die("copy");
        copied += (uint64_t)got;
        pos = e;
      }
      fdatasync(t);
      struct xfs_exchange_range x = {.file1_fd = t, .file1_offset = off, .file2_offset = off, .length = len};
      double b = now_ms();
      if (ioctl(d, XFS_IOC_EXCHANGE_RANGE, &x) < 0) die("XFS_IOC_EXCHANGE_RANGE");
      xch += now_ms() - b;
      swaps++;
      rewritten += len;
      // The scratch file now holds the old, fragmented blocks: free them.
      fallocate(t, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE, (off_t)off, (off_t)len);
    }
    double total = now_ms() - a;
    printf("{\"chunk_mib\": %s, \"max_extents\": %s, \"records_before\": %lu, \"records_after\": %lu, \"chunks_rewritten\": %lu, \"bytes_rewritten\": %lu, \"bytes_copied\": %lu, \"total_ms\": %.2f, \"exchange_ms\": %.2f}\n",
           argv[4], argv[5], (unsigned long)before, (unsigned long)nextents(d), (unsigned long)swaps, (unsigned long)rewritten, (unsigned long)copied, total, xch);
    return 0;
  }
  return 2;
}
