//! Generation storage: content-addressed chunks and manifests in the cell's object store.
//!
//! Backends: [`LocalFsStore`] (a directory per cell) and `s3::S3Store`.
//! Disk images are chunked hole-aware (`SEEK_DATA`), so sparse images commit quickly and all-zero
//! chunks become `null` entries that are never stored. A commit's pass over the file
//! ([`scan_file`], or [`rescan_unchanged`] for a disk nestd knows is unchanged) runs while the file
//! is stable; what it holds back is uploaded by [`publish`] after the VM resumes.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use nest_protocol::model::{Manifest, ManifestHash, ManifestKind};

use crate::util::par_try_for_each;

/// 4 MiB disk chunks (`docs/sandbox/state/`).
pub const DISK_CHUNK: u32 = 4 << 20;
/// 2 MiB memory chunks (one hugepage).
pub const MEMORY_CHUNK: u32 = 2 << 20;

pub trait ObjectStore: Send + Sync {
    /// How many chunk transfers [`commit_file`] and [`restore_file`] run at once.
    fn parallelism(&self) -> usize {
        1
    }
    fn has_chunk(&self, hex: &str) -> io::Result<bool>;
    /// Whether this process already knows the store holds `hex` under the 12 h rule (`has_chunk`
    /// would say yes), without asking the store: a chunk it isn't sure of is held back for
    /// [`publish`] rather than asked about while the VM is paused.
    fn known_recent(&self, _hex: &str) -> bool {
        false
    }
    /// Keep a copy of `hex` on this host, if the store keeps one at all: a pass for a same-host fork
    /// asks for every chunk it reads, since the child restores from them next. Other commits keep
    /// nothing local (the store's cache holds what was fetched).
    fn keep_local(&self, _hex: &str, _data: &[u8]) {}
    fn put_chunk(&self, hex: &str, data: &[u8]) -> io::Result<()>;
    fn get_chunk(&self, hex: &str) -> io::Result<Vec<u8>>;
    fn put_manifest(&self, hex: &str, data: &[u8]) -> io::Result<()>;
    fn get_manifest(&self, hex: &str) -> io::Result<Vec<u8>>;
}

pub struct LocalFsStore {
    root: PathBuf,
}

impl LocalFsStore {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn new(root: impl Into<PathBuf>) -> io::Result<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("chunks"))?;
        fs::create_dir_all(root.join("manifests"))?;
        Ok(Self { root })
    }

    fn write_atomic(path: &Path, data: &[u8]) -> io::Result<()> {
        if path.exists() {
            return Ok(()); // content-addressed: same name ⇒ same bytes
        }
        // A name of its own: two threads may be storing the same chunk at once.
        let tmp = path.with_extension(format!("tmp-{}", crate::util::random_hex(8)));
        fs::write(&tmp, data)?;
        fs::rename(tmp, path)
    }
}

impl ObjectStore for LocalFsStore {
    fn has_chunk(&self, hex: &str) -> io::Result<bool> {
        Ok(self.root.join("chunks").join(hex).exists())
    }
    fn known_recent(&self, hex: &str) -> bool {
        self.has_chunk(hex).unwrap_or(false)
    }
    fn put_chunk(&self, hex: &str, data: &[u8]) -> io::Result<()> {
        Self::write_atomic(&self.root.join("chunks").join(hex), data)
    }
    fn get_chunk(&self, hex: &str) -> io::Result<Vec<u8>> {
        fs::read(self.root.join("chunks").join(hex))
    }
    fn put_manifest(&self, hex: &str, data: &[u8]) -> io::Result<()> {
        Self::write_atomic(&self.root.join("manifests").join(hex), data)
    }
    fn get_manifest(&self, hex: &str) -> io::Result<Vec<u8>> {
        fs::read(self.root.join("manifests").join(hex))
    }
}

/// The hex digest of a `blake3:<64 lowercase hex>` reference. Anything else (path separators,
/// `..`, wrong length) is rejected: manifests come from the shared store and are not trusted.
fn hex_of(hash: &str) -> io::Result<&str> {
    let hex = hash.strip_prefix("blake3:").ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("bad hash {hash}")))?;
    if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("bad hash {hash}")));
    }
    Ok(hex)
}

/// Check that `data` hashes to `hex` (content addressing is verified, never assumed).
fn verify(hex: &str, data: &[u8]) -> io::Result<()> {
    if blake3::hash(data).to_hex().as_str() != hex {
        return Err(io::Error::new(io::ErrorKind::InvalidData, format!("content of {hex} does not match its hash")));
    }
    Ok(())
}

/// Offset of the next data region at or after `pos`, or `None` if only a hole remains.
fn next_data(file: &File, pos: u64) -> io::Result<Option<u64>> {
    // SAFETY: plain lseek on an fd we own.
    let r = unsafe { libc::lseek(file.as_raw_fd(), pos as libc::off_t, libc::SEEK_DATA) };
    if r < 0 {
        let err = io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ENXIO) => Ok(None),
            // Filesystems without SEEK_DATA: treat everything as data.
            Some(libc::EINVAL) => Ok(Some(pos)),
            _ => Err(err),
        };
    }
    Ok(Some(r as u64))
}

/// A commit's pass over a file while it was stable: its manifest, and the chunks it found that
/// may need uploading but held back (in memory, within the pass's budget) so the upload can run
/// after the VM resumes. [`publish`] uploads those and the manifest.
pub struct Scanned {
    pub manifest: Manifest,
    pub hash: ManifestHash,
    /// The manifest's bytes (what `hash` names).
    bytes: Vec<u8>,
    /// Chunks not yet known to be in the store (by hex): `publish` stores each that isn't.
    deferred: Vec<(String, Vec<u8>)>,
    pub stats: ScanStats,
}

/// What a pass read and did, for the commit's log line.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScanStats {
    /// Chunks read from the file (all-zero ones included).
    pub chunks_read: u64,
    pub bytes_read: u64,
    /// Chunks the pass uploaded itself (its hold-back budget was spent).
    pub chunks_put: u64,
    /// Chunks held back for `publish`.
    pub chunks_deferred: u64,
    /// The previous pass's manifest was reused ([`rescan_unchanged`]).
    pub reused: bool,
}

/// A byte budget shared by a pass's workers.
struct Budget(Mutex<usize>);

impl Budget {
    fn take(&self, n: usize) -> bool {
        let mut left = self.0.lock().expect("budget");
        if *left < n {
            return false;
        }
        *left -= n;
        true
    }
}

/// Whether `buf` is all zeros (compared a block at a time, which the compiler turns into `memcmp`).
pub fn is_zero(buf: &[u8]) -> bool {
    const BLOCK: usize = 64 << 10;
    static ZEROS: [u8; BLOCK] = [0; BLOCK];
    buf.chunks(BLOCK).all(|b| b == &ZEROS[..b.len()])
}

/// One non-zero chunk a pass read: it is in the store already (as far as this process knows), held
/// back within `budget`, or else stored now (the pre-hold-back behaviour, while the file is still
/// stable).
fn place(store: &dyn ObjectStore, hex: String, bytes: Vec<u8>, budget: &Budget, deferred: &Mutex<Vec<(String, Vec<u8>)>>, stats: &Mutex<ScanStats>) -> io::Result<String> {
    if store.known_recent(&hex) {
        return Ok(hex);
    }
    if budget.take(bytes.len()) {
        stats.lock().expect("stats").chunks_deferred += 1;
        deferred.lock().expect("deferred").push((hex.clone(), bytes));
        return Ok(hex);
    }
    if !store.has_chunk(&hex)? {
        store.put_chunk(&hex, &bytes)?;
        stats.lock().expect("stats").chunks_put += 1;
    }
    Ok(hex)
}

fn finish(manifest: Manifest, deferred: Vec<(String, Vec<u8>)>, stats: ScanStats) -> io::Result<Scanned> {
    let bytes = serde_json::to_vec(&manifest).map_err(io::Error::other)?;
    let hash = ManifestHash(format!("blake3:{}", blake3::hash(&bytes).to_hex()));
    Ok(Scanned { manifest, hash, bytes, deferred, stats })
}

/// Read `path` (which must not change meanwhile) into a manifest: hole-aware (`SEEK_DATA`), each
/// chunk read once, sequentially; zero checks, hashing and any uploads run on
/// `store.parallelism()` workers. Non-zero chunks the store isn't known to hold are held back up to
/// `hold_back` bytes, for [`publish`]; past that they are stored now.
pub fn scan_file(store: &dyn ObjectStore, path: &Path, kind: ManifestKind, hold_back: usize) -> io::Result<Scanned> {
    scan_file_keeping(store, path, kind, hold_back, false)
}

/// [`scan_file`], also keeping every non-zero chunk on this host when `keep_local` (a same-host
/// fork's pass: [`ObjectStore::keep_local`]).
pub fn scan_file_keeping(store: &dyn ObjectStore, path: &Path, kind: ManifestKind, hold_back: usize, keep_local: bool) -> io::Result<Scanned> {
    let chunk_size = match kind {
        ManifestKind::Disk => DISK_CHUNK,
        ManifestKind::Memory => MEMORY_CHUNK,
    } as u64;
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let chunks: Mutex<Vec<Option<String>>> = Mutex::new(vec![None; size.div_ceil(chunk_size) as usize]);
    let stats = Mutex::new(ScanStats::default());
    let deferred = Mutex::new(Vec::new());
    let budget = Budget(Mutex::new(hold_back));
    // The file is read sequentially (the reader runs under par_try_for_each's lock); the workers
    // check for zeros, so the reader only reads.
    let mut pos = 0u64;
    let mut read_next = || -> io::Result<Option<(usize, Vec<u8>)>> {
        if pos >= size {
            return Ok(None);
        }
        let Some(data) = next_data(&file, pos)? else {
            pos = size;
            return Ok(None);
        };
        if data >= size {
            pos = size;
            return Ok(None);
        }
        let idx = data / chunk_size;
        let start = idx * chunk_size;
        let mut buf = vec![0u8; chunk_size.min(size - start) as usize];
        file.seek(SeekFrom::Start(start))?;
        file.read_exact(&mut buf)?;
        pos = start + chunk_size;
        Ok(Some((idx as usize, buf)))
    };
    let items = std::iter::from_fn(|| read_next().transpose());
    par_try_for_each(items, store.parallelism(), |(idx, bytes)| {
        {
            let mut s = stats.lock().expect("stats");
            s.chunks_read += 1;
            s.bytes_read += bytes.len() as u64;
        }
        if is_zero(&bytes) {
            return Ok(());
        }
        let hex = blake3::hash(&bytes).to_hex().to_string();
        if keep_local {
            store.keep_local(&hex, &bytes);
        }
        let hex = place(store, hex, bytes, &budget, &deferred, &stats)?;
        chunks.lock().expect("chunks")[idx] = Some(format!("blake3:{hex}"));
        Ok(())
    })?;
    let chunks = chunks.into_inner().expect("chunks");
    let manifest = Manifest { format: 1, kind, chunk_size: chunk_size as u32, size_bytes: size, chunks, prefetch: vec![] };
    finish(manifest, deferred.into_inner().expect("deferred"), stats.into_inner().expect("stats"))
}

/// `prev` again for a file known to be unchanged since the pass that made it (nestd's mtime
/// sentinel; `nestd_core::checkpoint`). Nothing is read but the non-zero chunks the store isn't
/// known to hold (the 12 h rule: every chunk of a new generation is verified, never assumed), and
/// each of those must still hash to its entry. `Ok(None)`: the file doesn't match `prev` (its size,
/// or a chunk read back), so the caller reads it whole.
pub fn rescan_unchanged(store: &dyn ObjectStore, path: &Path, prev: &Manifest, hold_back: usize) -> io::Result<Option<Scanned>> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let chunk_size = prev.chunk_size as u64;
    if size != prev.size_bytes || chunk_size == 0 || prev.chunks.len() as u64 != size.div_ceil(chunk_size) {
        return Ok(None);
    }
    let todo: Vec<(usize, &str)> = prev
        .chunks
        .iter()
        .enumerate()
        .filter_map(|(i, c)| c.as_deref().map(|c| hex_of(c).map(|h| (i, h))))
        .collect::<io::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, h)| !store.known_recent(h))
        .collect();
    let stats = Mutex::new(ScanStats { reused: true, ..ScanStats::default() });
    let deferred = Mutex::new(Vec::new());
    let budget = Budget(Mutex::new(hold_back));
    let mismatch = Mutex::new(false);
    par_try_for_each(todo.into_iter().map(Ok::<_, io::Error>), store.parallelism(), |(i, hex)| {
        let start = i as u64 * chunk_size;
        let mut buf = vec![0u8; chunk_size.min(size - start) as usize];
        file.read_exact_at(&mut buf, start)?;
        {
            let mut s = stats.lock().expect("stats");
            s.chunks_read += 1;
            s.bytes_read += buf.len() as u64;
        }
        if blake3::hash(&buf).to_hex().as_str() != hex {
            *mismatch.lock().expect("mismatch") = true;
            return Err(io::Error::other("changed"));
        }
        place(store, hex.to_string(), buf, &budget, &deferred, &stats).map(|_| ())
    })
    .or_else(|e| if *mismatch.lock().expect("mismatch") { Ok(()) } else { Err(e) })?;
    if mismatch.into_inner().expect("mismatch") {
        return Ok(None);
    }
    finish(prev.clone(), deferred.into_inner().expect("deferred"), stats.into_inner().expect("stats")).map(Some)
}

/// Store what a pass held back (each chunk the store doesn't hold under the 12 h rule), then the
/// manifest. Runs after the VM resumes: nothing here reads the file.
pub fn publish(store: &dyn ObjectStore, scanned: &Scanned) -> io::Result<()> {
    // Equal chunks held back twice are stored once.
    let mut seen = std::collections::BTreeSet::new();
    let todo: Vec<&(String, Vec<u8>)> = scanned.deferred.iter().filter(|(hex, _)| seen.insert(hex.as_str())).collect();
    par_try_for_each(todo.into_iter().map(Ok::<_, io::Error>), store.parallelism(), |(hex, bytes)| {
        if !store.has_chunk(hex)? {
            store.put_chunk(hex, bytes)?;
        }
        Ok(())
    })?;
    let hex = scanned.hash.0.strip_prefix("blake3:").expect("made by finish");
    store.put_manifest(hex, &scanned.bytes)
}

/// Chunk `path` into `store` and write its manifest. Returns the manifest and its hash.
/// Unchanged chunks already present in the store are not rewritten (content addressing). The file
/// is read sequentially; hashing and uploads run on `store.parallelism()` threads.
pub fn commit_file(store: &dyn ObjectStore, path: &Path, kind: ManifestKind) -> io::Result<(Manifest, ManifestHash)> {
    let scanned = scan_file(store, path, kind, 0)?;
    publish(store, &scanned)?;
    Ok((scanned.manifest, scanned.hash))
}

/// Materialize a manifest into a (sparse) file at `dest`.
pub fn restore_file(store: &dyn ObjectStore, manifest_hash: &ManifestHash, dest: &Path) -> io::Result<Manifest> {
    let mhex = hex_of(&manifest_hash.0)?;
    let bytes = store.get_manifest(mhex)?;
    verify(mhex, &bytes)?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let chunk_size = manifest.chunk_size as u64;
    if chunk_size == 0 || (manifest.chunks.len() as u64) != manifest.size_bytes.div_ceil(chunk_size) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "manifest chunk count does not match its size"));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    let f = OpenOptions::new().create(true).write(true).truncate(true).open(dest)?;
    f.set_len(manifest.size_bytes)?;
    // Every chunk name is checked before any download.
    let todo: Vec<(usize, &str)> =
        manifest.chunks.iter().enumerate().filter_map(|(i, c)| c.as_deref().map(|c| hex_of(c).map(|h| (i, h)))).collect::<io::Result<_>>()?;
    par_try_for_each(todo.into_iter().map(Ok), store.parallelism(), |(i, hex)| {
        let offset = i as u64 * chunk_size;
        let data = store.get_chunk(hex)?;
        verify(hex, &data)?;
        if data.len() as u64 > chunk_size || offset + data.len() as u64 > manifest.size_bytes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("chunk {i} exceeds the manifest bounds")));
        }
        f.write_all_at(&data, offset)
    })?;
    f.sync_all()?;
    Ok(manifest)
}

/// Cut `src` into a new file `dst` with a reflink (`FICLONE`): `dst` shares every block `src` has
/// now, and later writes to `src` copy-on-write. The clone takes `src`'s inode lock, so it is atomic
/// against writes, and flushes `src`'s dirty pages first (`fs/remap_range.c`); its cost grows with
/// `src`'s extent records, not its size. `ErrorKind::Unsupported`: the filesystem can't reflink
/// (ext4, tmpfs, another filesystem): never a fallback to copying.
pub fn reflink(src: &Path, dst: &Path) -> io::Result<()> {
    let from = File::open(src)?;
    let to = OpenOptions::new().write(true).create_new(true).open(dst)?;
    // SAFETY: FICLONE takes the source fd as its argument; both fds are ours and open.
    let r = unsafe { libc::ioctl(to.as_raw_fd(), libc::FICLONE, from.as_raw_fd()) };
    if r < 0 {
        let e = io::Error::last_os_error();
        let _ = fs::remove_file(dst);
        return Err(match e.raw_os_error() {
            Some(libc::EOPNOTSUPP) | Some(libc::EXDEV) | Some(libc::EINVAL) | Some(libc::ENOTTY) => io::Error::new(io::ErrorKind::Unsupported, format!("reflink: {e}")),
            _ => e,
        });
    }
    Ok(())
}

/// `struct fsxattr` (linux/fs.h), what `FS_IOC_FSGETXATTR` fills.
#[repr(C)]
#[derive(Default)]
struct FsXattr {
    xflags: u32,
    extsize: u32,
    nextents: u32,
    projid: u32,
    cowextsize: u32,
    pad: [u8; 8],
}

/// `statfs(2)`'s `f_type` for XFS (linux/magic.h).
const XFS_SUPER_MAGIC: u64 = 0x5846_5342;

/// `FS_IOC_FSGETXATTR`: `_IOR('X', 31, struct fsxattr)`.
const FS_IOC_FSGETXATTR: libc::Ioctl = libc::_IOR::<FsXattr>(b'X' as u32, 31);

/// How many extent records `path` has now: what a [`reflink`] of it costs, in metadata
/// ([`clone_slower_than_read`]). On XFS, the inode's own count (`fsx_nextents`, O(1), no lock that
/// a writer waits on); elsewhere, FIEMAP asking for no extents, which walks them all. Blocking: call
/// it off the async runtime.
pub fn extent_count(path: &Path) -> io::Result<u64> {
    let f = File::open(path)?;
    // XFS_SUPER_MAGIC by value: nix names it on glibc only, and `f_type`'s width differs by libc.
    #[allow(clippy::unnecessary_cast)]
    let xfs = nix::sys::statfs::fstatfs(&f).is_ok_and(|st| st.filesystem_type().0 as u64 == XFS_SUPER_MAGIC);
    if xfs {
        let mut x = FsXattr::default();
        // SAFETY: FS_IOC_FSGETXATTR writes one `struct fsxattr` we own.
        let r = unsafe { libc::ioctl(f.as_raw_fd(), FS_IOC_FSGETXATTR, &mut x as *mut FsXattr) };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        return Ok(u64::from(x.nextents));
    }
    fiemap_extent_count(&f)
}

/// FIEMAP's count of `f`'s extents (`fm_extent_count` 0: the kernel answers only the count).
fn fiemap_extent_count(f: &File) -> io::Result<u64> {
    /// `struct fiemap` (linux/fiemap.h) with no extent array.
    #[repr(C)]
    struct Fiemap {
        start: u64,
        length: u64,
        flags: u32,
        mapped_extents: u32,
        extent_count: u32,
        reserved: u32,
    }
    let mut m = Fiemap { start: 0, length: u64::MAX, flags: 0, mapped_extents: 0, extent_count: 0, reserved: 0 };
    // SAFETY: FS_IOC_FIEMAP reads and writes a `struct fiemap` we own; with `extent_count` 0 the
    // kernel writes no extent array past it.
    let r = unsafe { libc::ioctl(f.as_raw_fd(), libc::_IOWR::<Fiemap>(b'f' as u32, 11), &mut m as *mut Fiemap) };
    if r < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(m.mapped_extents))
}

/// Every extent of `path`, as FIEMAP reports it (raw: `nestd_core::shadow::normalize` reads it), in
/// batches. Blocking, and it walks the whole map: call it off the async runtime.
pub fn fiemap(path: &Path) -> io::Result<Vec<nestd_core::shadow::Extent>> {
    const BATCH: usize = 16384;
    const HDR: usize = 32;
    const EXT: usize = 56;
    let f = File::open(path)?;
    let mut out = Vec::new();
    let mut start = 0u64;
    let mut buf = vec![0u8; HDR + BATCH * EXT];
    loop {
        buf.fill(0);
        buf[0..8].copy_from_slice(&start.to_ne_bytes());
        buf[8..16].copy_from_slice(&(u64::MAX - start).to_ne_bytes());
        buf[24..28].copy_from_slice(&(BATCH as u32).to_ne_bytes());
        // SAFETY: FS_IOC_FIEMAP reads a `struct fiemap` header and writes at most `fm_extent_count`
        // extents after it; `buf` holds the header and that many.
        let r = unsafe { libc::ioctl(f.as_raw_fd(), libc::_IOWR::<[u8; HDR]>(b'f' as u32, 11), buf.as_mut_ptr()) };
        if r < 0 {
            return Err(io::Error::last_os_error());
        }
        let n = u32::from_ne_bytes(buf[20..24].try_into().expect("4 bytes")) as usize;
        let mut last = false;
        for i in 0..n {
            let e = &buf[HDR + i * EXT..HDR + (i + 1) * EXT];
            let word = |o: usize| u64::from_ne_bytes(e[o..o + 8].try_into().expect("8 bytes"));
            let flags = u32::from_ne_bytes(e[40..44].try_into().expect("4 bytes"));
            out.push(nestd_core::shadow::Extent { logical: word(0), physical: word(8), length: word(16), flags });
            last |= flags & nestd_core::shadow::flags::LAST != 0;
        }
        if n == 0 || last {
            return Ok(out);
        }
        let e = out.last().expect("n > 0");
        start = e.logical + e.length;
    }
}

/// Clone each of `ranges` of `src` into `dst` at the same offsets (`FICLONERANGE`): `dst` then shares
/// `src`'s blocks there. A range is clipped to `src`'s size (its tail extent may run past it).
pub fn clone_ranges(src: &Path, dst: &Path, ranges: &[nestd_core::shadow::Range]) -> io::Result<()> {
    #[repr(C)]
    struct FileCloneRange {
        src_fd: i64,
        src_offset: u64,
        src_length: u64,
        dest_offset: u64,
    }
    let from = File::open(src)?;
    let to = OpenOptions::new().write(true).open(dst)?;
    let size = from.metadata()?.len();
    for r in ranges {
        let end = r.end.min(size);
        if end <= r.start {
            continue;
        }
        let a = FileCloneRange { src_fd: i64::from(from.as_raw_fd()), src_offset: r.start, src_length: end - r.start, dest_offset: r.start };
        // SAFETY: FICLONERANGE reads one `struct file_clone_range` we own; both fds are ours and open.
        if unsafe { libc::ioctl(to.as_raw_fd(), libc::_IOW::<FileCloneRange>(0x94, 13), &a as *const FileCloneRange) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Whether the filesystem of `dir` supports the shadow cut: a range clone and a map read (two
/// scratch files, removed again).
pub fn shadow_cut_works(dir: &Path) -> bool {
    let a = dir.join(format!(".shadow-probe-{}", crate::util::random_hex(8)));
    let b = a.with_extension("b");
    let ok = (|| -> io::Result<bool> {
        fs::write(&a, vec![7u8; 8192])?;
        File::open(&a)?.sync_all()?;
        reflink(&a, &b)?;
        File::open(&b)?.sync_all()?;
        clone_ranges(&a, &b, &[nestd_core::shadow::Range { start: 0, end: 4096 }])?;
        let (ma, mb) = (fiemap(&a)?, fiemap(&b)?);
        Ok(!ma.is_empty() && !mb.is_empty())
    })()
    .unwrap_or(false);
    let _ = fs::remove_file(&a);
    let _ = fs::remove_file(&b);
    ok
}

/// Tests and the e2e harness only, where the filesystem has no reflink: a stand-in for [`fiemap`]
/// whose "physical" address of each 4 KiB block is a hash of its bytes, so two files compare equal
/// exactly where their bytes are, as two reflinked files do. Holes are left out.
pub fn sim_fiemap(path: &Path) -> io::Result<Vec<nestd_core::shadow::Extent>> {
    let f = File::open(path)?;
    let size = f.metadata()?.len();
    let mut out = Vec::new();
    let mut buf = vec![0u8; 4096];
    let mut pos = 0u64;
    while pos < size {
        let Some(data) = next_data(&f, pos)? else { break };
        // SAFETY: lseek on an fd we own.
        let hole = unsafe { libc::lseek(f.as_raw_fd(), data as libc::off_t, libc::SEEK_HOLE) };
        let end = if hole < 0 { size } else { (hole as u64).min(size) };
        let mut at = data - data % 4096;
        while at < end {
            let n = (end - at).min(4096) as usize;
            f.read_exact_at(&mut buf[..n], at)?;
            let h = blake3::hash(&buf[..n]);
            let physical = u64::from_le_bytes(h.as_bytes()[..8].try_into().expect("8 bytes"));
            out.push(nestd_core::shadow::Extent { logical: at, physical, length: n as u64, flags: 0 });
            at += n as u64;
        }
        pos = end;
    }
    Ok(out)
}

/// The stand-in for [`clone_ranges`] beside [`sim_fiemap`]: copies the bytes.
pub fn sim_clone_ranges(src: &Path, dst: &Path, ranges: &[nestd_core::shadow::Range]) -> io::Result<()> {
    let from = File::open(src)?;
    let to = OpenOptions::new().write(true).open(dst)?;
    let size = from.metadata()?.len();
    to.set_len(size)?;
    let mut buf = vec![0u8; 1 << 20];
    for r in ranges {
        let mut at = r.start;
        let end = r.end.min(size);
        while at < end {
            let n = (end - at).min(buf.len() as u64) as usize;
            from.read_exact_at(&mut buf[..n], at)?;
            to.write_all_at(&buf[..n], at)?;
            at += n as u64;
        }
    }
    to.sync_data()
}

/// Whether two files hold the same bytes (the shadow cut's check, in tests and when configured).
pub fn same_bytes(a: &Path, b: &Path) -> io::Result<bool> {
    let (fa, fb) = (File::open(a)?, File::open(b)?);
    let size = fa.metadata()?.len();
    if fb.metadata()?.len() != size {
        return Ok(false);
    }
    let (mut x, mut y) = (vec![0u8; 1 << 20], vec![0u8; 1 << 20]);
    let mut at = 0u64;
    while at < size {
        let n = (size - at).min(x.len() as u64) as usize;
        fa.read_exact_at(&mut x[..n], at)?;
        fb.read_exact_at(&mut y[..n], at)?;
        if x[..n] != y[..n] {
            return Ok(false);
        }
        at += n as u64;
    }
    Ok(true)
}

/// Whether cloning a file of `extents` records (at `clone_ns_per_extent` each) would pause a VM
/// longer than reading its `allocated` bytes (at `read_bytes_per_s`) would. M2's measurement put a
/// clone at 10-15 us a record and a cold read at about 180 MB/s on a `c8id.large`
/// (`docs/sandbox/state/disk/`), so a file has to average under about 2.7 KB a record for this to
/// hold there: a guard against a slower clone, not the bound M3' is for.
pub fn clone_slower_than_read(extents: u64, allocated: u64, clone_ns_per_extent: u64, read_bytes_per_s: u64) -> bool {
    let clone_ns = u128::from(extents) * u128::from(clone_ns_per_extent);
    let read_ns = u128::from(allocated) * 1_000_000_000 / u128::from(read_bytes_per_s.max(1));
    clone_ns > read_ns
}

/// Whether files in `dir` can be reflinked (two scratch files, removed again).
pub fn reflink_works(dir: &Path) -> bool {
    let probe = dir.join(format!(".reflink-probe-{}", crate::util::random_hex(8)));
    let clone = probe.with_extension("clone");
    let ok = fs::write(&probe, b"nest reflink probe").is_ok() && reflink(&probe, &clone).is_ok();
    let _ = fs::remove_file(&probe);
    let _ = fs::remove_file(&clone);
    ok
}

/// A stand-in for [`reflink`] where the filesystem has none, for tests and the e2e harness only: a
/// hole-preserving copy of `src` taken under an exclusive `flock` on it, which a cooperating writer
/// (holding a shared one per write) can't interleave with, as no write can with a real clone.
pub fn locked_copy(src: &Path, dst: &Path) -> io::Result<()> {
    let from = File::open(src)?;
    // SAFETY: flock on an fd we own; released when `from` closes.
    if unsafe { libc::flock(from.as_raw_fd(), libc::LOCK_EX) } < 0 {
        return Err(io::Error::last_os_error());
    }
    let size = from.metadata()?.len();
    let to = OpenOptions::new().write(true).create_new(true).open(dst)?;
    to.set_len(size)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut pos = 0u64;
    while pos < size {
        let Some(data) = next_data(&from, pos)? else { break };
        if data >= size {
            break;
        }
        // SAFETY: lseek on an fd we own.
        let hole = unsafe { libc::lseek(from.as_raw_fd(), data as libc::off_t, libc::SEEK_HOLE) };
        let end = if hole < 0 { size } else { (hole as u64).min(size) };
        let mut at = data;
        while at < end {
            let n = (end - at).min(buf.len() as u64) as usize;
            from.read_exact_at(&mut buf[..n], at)?;
            to.write_all_at(&buf[..n], at)?;
            at += n as u64;
        }
        pos = end;
    }
    to.sync_all()
}

/// `fdatasync` the file at `path`: what the guest flushed to the host's page cache reaches the
/// disk, so a clone's own flush of `path` (inside a commit's pause) has little left to write.
pub fn sync_data(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_data()
}

/// Create an empty sparse disk image of `gib` GiB.
pub fn create_sparse(path: &Path, bytes: u64) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let f = OpenOptions::new().create(true).write(true).truncate(true).open(path)?;
    f.set_len(bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn extent_count_counts_a_files_extent_records() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f");
        let f = OpenOptions::new().write(true).create_new(true).open(&p).unwrap();
        f.set_len(8 << 20).unwrap();
        f.write_all_at(&[1u8; 4096], 0).unwrap();
        f.write_all_at(&[2u8; 4096], 4 << 20).unwrap();
        f.sync_all().unwrap();
        match extent_count(&p) {
            // Two writes with a hole between them: two records.
            Ok(n) => assert_eq!(n, 2),
            // tmpfs and some others can't say: a skip locally, a failure in CI (no silent skips).
            Err(e) => {
                assert!(matches!(e.raw_os_error(), Some(libc::EOPNOTSUPP) | Some(libc::ENOTTY)), "{e}");
                assert!(std::env::var_os("NEST_CI_REQUIRE_USERNS").is_none(), "no FIEMAP on {}, and CI forbids skipping", dir.path().display());
                eprintln!("NEST-TEST-SKIP: extent_count_counts_a_files_extent_records: no FIEMAP on {}", dir.path().display());
            }
        }
    }

    /// The XFS path's ABI: the request number and layout the kernel's `FS_IOC_FSGETXATTR` has
    /// (linux/fs.h: `_IOR('X', 31, struct fsxattr)`, 28 bytes). The count itself is checked on a host,
    /// where the cut's log line carries it (CI has no XFS).
    #[test]
    fn the_xfs_extent_count_asks_the_kernels_fsgetxattr() {
        assert_eq!(std::mem::size_of::<FsXattr>(), 28);
        assert_eq!(std::mem::offset_of!(FsXattr, nextents), 8);
        // `Ioctl` is `c_ulong` on glibc and `c_int` on musl (the hosts' build): the cast is needed there.
        #[allow(clippy::unnecessary_cast)]
        let request = FS_IOC_FSGETXATTR as u64 & 0xffff_ffff;
        assert_eq!(request, 0x801c_581f);
    }

    #[test]
    fn a_clone_is_slower_than_a_read_only_past_the_measured_ratio() {
        // 819 k records of a 6.7 GB disk at 15 us and 180 MB/s: 12 s against 37 s, so clone.
        assert!(!clone_slower_than_read(818_954, 6_690_762_752, 15_000, 180_000_000));
        // A disk of 4 KiB records the clone still wins; past 2.7 KB a record on average it loses.
        assert!(!clone_slower_than_read(1_000, 4_096_000, 15_000, 180_000_000));
        assert!(clone_slower_than_read(1_000, 2_000_000, 15_000, 180_000_000));
        // A slower clone (another kernel, a busier disk) turns it.
        assert!(clone_slower_than_read(818_954, 6_690_762_752, 60_000, 180_000_000));
    }

    use std::io::Write;

    use super::*;

    #[test]
    fn commit_and_restore_sparse_image() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalFsStore::new(dir.path().join("store")).unwrap();
        let img = dir.path().join("disk.img");
        create_sparse(&img, 64 << 20).unwrap();
        {
            let mut f = OpenOptions::new().write(true).open(&img).unwrap();
            f.seek(SeekFrom::Start(10 << 20)).unwrap();
            f.write_all(b"hello generation").unwrap();
        }
        let (m, h) = commit_file(&store, &img, ManifestKind::Disk).unwrap();
        assert_eq!(m.chunks.len(), 16);
        assert_eq!(m.chunks.iter().filter(|c| c.is_some()).count(), 1);
        assert!(m.chunks[2].is_some());
        assert!(h.0.starts_with("blake3:"));

        // Committing again is idempotent (same manifest hash).
        let (_, h2) = commit_file(&store, &img, ManifestKind::Disk).unwrap();
        assert_eq!(h, h2);

        let out = dir.path().join("restored.img");
        restore_file(&store, &h, &out).unwrap();
        let a = fs::read(&img).unwrap();
        let b = fs::read(&out).unwrap();
        assert_eq!(a, b);
    }

    /// A local store that never vouches for a chunk without asking (as an S3 store that hasn't
    /// seen it this process), and counts what is stored.
    struct Asking {
        inner: LocalFsStore,
        puts: Mutex<Vec<String>>,
    }
    impl ObjectStore for Asking {
        fn parallelism(&self) -> usize {
            4
        }
        fn has_chunk(&self, hex: &str) -> io::Result<bool> {
            self.inner.has_chunk(hex)
        }
        fn put_chunk(&self, hex: &str, data: &[u8]) -> io::Result<()> {
            self.puts.lock().unwrap().push(hex.to_string());
            self.inner.put_chunk(hex, data)
        }
        fn get_chunk(&self, hex: &str) -> io::Result<Vec<u8>> {
            self.inner.get_chunk(hex)
        }
        fn put_manifest(&self, hex: &str, data: &[u8]) -> io::Result<()> {
            self.inner.put_manifest(hex, data)
        }
        fn get_manifest(&self, hex: &str) -> io::Result<Vec<u8>> {
            self.inner.get_manifest(hex)
        }
    }

    fn asking(dir: &Path) -> Asking {
        Asking { inner: LocalFsStore::new(dir.join("store")).unwrap(), puts: Mutex::new(vec![]) }
    }

    /// A 64 MiB sparse image with distinct data in chunks 1, 3 and 5, and chunk 7 written as zeros.
    fn image(dir: &Path) -> PathBuf {
        let img = dir.join("disk.img");
        create_sparse(&img, 16 * DISK_CHUNK as u64).unwrap();
        let f = OpenOptions::new().write(true).open(&img).unwrap();
        for i in [1u64, 3, 5] {
            f.write_all_at(&vec![i as u8; 4096], i * DISK_CHUNK as u64 + 100).unwrap();
        }
        f.write_all_at(&vec![0u8; DISK_CHUNK as usize], 7 * DISK_CHUNK as u64).unwrap();
        img
    }

    /// A pass holds back what it would upload, within its budget, until `publish`; the result is
    /// what `commit_file` makes. Zeros written as data are read (by the workers) and stay `null`.
    #[test]
    fn a_pass_holds_back_its_uploads_until_publish() {
        let dir = tempfile::tempdir().unwrap();
        let img = image(dir.path());
        let store = asking(dir.path());
        let s = scan_file(&store, &img, ManifestKind::Disk, 64 << 20).unwrap();
        assert!(store.puts.lock().unwrap().is_empty(), "nothing stored before publish");
        assert_eq!(s.stats, ScanStats { chunks_read: 4, bytes_read: 4 * DISK_CHUNK as u64, chunks_put: 0, chunks_deferred: 3, reused: false });
        assert_eq!(s.manifest.chunks.iter().filter(|c| c.is_some()).count(), 3);
        assert!(s.manifest.chunks[7].is_none(), "a chunk of zeros is null");
        publish(&store, &s).unwrap();
        assert_eq!(store.puts.lock().unwrap().len(), 3);
        let local = LocalFsStore::new(dir.path().join("plain")).unwrap();
        let (m, h) = commit_file(&local, &img, ManifestKind::Disk).unwrap();
        assert_eq!((m, h), (s.manifest.clone(), s.hash.clone()));
        let out = dir.path().join("restored.img");
        restore_file(&store, &s.hash, &out).unwrap();
        assert_eq!(fs::read(&img).unwrap(), fs::read(&out).unwrap());
    }

    /// Past its budget a pass stores chunks itself, while the file is still stable.
    #[test]
    fn past_its_budget_a_pass_uploads_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let img = image(dir.path());
        let store = asking(dir.path());
        let s = scan_file(&store, &img, ManifestKind::Disk, DISK_CHUNK as usize).unwrap();
        assert_eq!((s.stats.chunks_deferred, s.stats.chunks_put), (1, 2));
        assert_eq!(store.puts.lock().unwrap().len(), 2);
        publish(&store, &s).unwrap();
        assert_eq!(store.puts.lock().unwrap().len(), 3);
        // A chunk the store holds isn't stored again by either.
        let again = scan_file(&store, &img, ManifestKind::Disk, 0).unwrap();
        assert_eq!(again.stats.chunks_put, 0);
        publish(&store, &again).unwrap();
        assert_eq!(store.puts.lock().unwrap().len(), 3);
    }

    /// The unchanged path reads only the chunks the store isn't known to hold, checks each against
    /// its entry, and gives up (for a full pass) on any difference.
    #[test]
    fn an_unchanged_file_is_read_only_where_the_store_is_in_doubt() {
        let dir = tempfile::tempdir().unwrap();
        let img = image(dir.path());
        let local = LocalFsStore::new(dir.path().join("store")).unwrap();
        let (prev, h) = commit_file(&local, &img, ManifestKind::Disk).unwrap();

        // Everything known: nothing read, the same manifest.
        let s = rescan_unchanged(&local, &img, &prev, 64 << 20).unwrap().expect("reused");
        assert_eq!((s.hash.clone(), s.stats.bytes_read, s.stats.reused), (h.clone(), 0, true));

        // A chunk gone from the store: read back, checked, stored again at publish.
        let hex = prev.chunks[3].as_deref().unwrap().strip_prefix("blake3:").unwrap().to_string();
        fs::remove_file(dir.path().join("store/chunks").join(&hex)).unwrap();
        let s = rescan_unchanged(&local, &img, &prev, 64 << 20).unwrap().expect("reused");
        assert_eq!((s.stats.chunks_read, s.stats.chunks_deferred), (1, 1));
        assert!(!local.has_chunk(&hex).unwrap());
        publish(&local, &s).unwrap();
        assert!(local.has_chunk(&hex).unwrap());

        // A doubted chunk that no longer matches: not reused.
        fs::remove_file(dir.path().join("store/chunks").join(&hex)).unwrap();
        OpenOptions::new().write(true).open(&img).unwrap().write_all_at(b"changed", 3 * DISK_CHUNK as u64).unwrap();
        assert!(rescan_unchanged(&local, &img, &prev, 64 << 20).unwrap().is_none());

        // Another size: not reused, nothing read.
        OpenOptions::new().write(true).open(&img).unwrap().set_len(17 * DISK_CHUNK as u64).unwrap();
        assert!(rescan_unchanged(&local, &img, &prev, 64 << 20).unwrap().is_none());
    }

    /// Where the filesystem can't reflink (the test machine's ext4 or tmpfs), a cut says so and
    /// leaves nothing behind; it never copies instead. Where it can, the clone has the source's bytes.
    #[test]
    fn a_reflink_is_a_clone_or_unsupported_never_a_copy() {
        let dir = tempfile::tempdir().unwrap();
        let img = image(dir.path());
        let dst = dir.path().join("cut-1.img");
        match reflink(&img, &dst) {
            Ok(()) => {
                assert!(reflink_works(dir.path()));
                assert_eq!(fs::read(&img).unwrap(), fs::read(&dst).unwrap());
            }
            Err(e) => {
                assert_eq!(e.kind(), io::ErrorKind::Unsupported, "{e}");
                assert!(!dst.exists(), "a failed cut leaves no file");
                assert!(!reflink_works(dir.path()));
            }
        }
        assert!(!fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with(".reflink-probe")), "the probe cleans up");
    }

    /// The test cut copies the data and keeps the holes (a 64 MiB image of four data chunks stays
    /// sparse), and a writer holding a shared `flock` waits for it.
    #[test]
    fn the_locked_copy_keeps_holes_and_excludes_a_locking_writer() {
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        let img = image(dir.path());
        let dst = dir.path().join("cut-1.img");
        locked_copy(&img, &dst).unwrap();
        assert_eq!(fs::read(&img).unwrap(), fs::read(&dst).unwrap());
        assert!(fs::metadata(&dst).unwrap().blocks() * 512 < 8 * DISK_CHUNK as u64, "holes kept");
        // A shared lock held elsewhere makes the copy wait.
        let held = File::open(&img).unwrap();
        // SAFETY: flock on an fd we own.
        assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_SH) }, 0);
        let (img2, dst2) = (img.clone(), dir.path().join("cut-2.img"));
        let t = std::thread::spawn(move || locked_copy(&img2, &dst2));
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!t.is_finished(), "the copy waits for the writer's lock");
        drop(held);
        t.join().unwrap().unwrap();
    }

    #[test]
    fn is_zero_checks_every_byte() {
        assert!(is_zero(&[]));
        for len in [1usize, 4095, 64 << 10, (64 << 10) + 1, 3 << 20] {
            let mut v = vec![0u8; len];
            assert!(is_zero(&v), "{len}");
            for at in [0, len / 2, len - 1] {
                v[at] = 1;
                assert!(!is_zero(&v), "{len} {at}");
                v[at] = 0;
            }
        }
    }

    /// A store whose every upload fails, slowly enough that the reader is ahead of the uploads.
    struct FailingStore;
    impl ObjectStore for FailingStore {
        fn has_chunk(&self, _: &str) -> io::Result<bool> {
            Ok(false)
        }
        fn put_chunk(&self, _: &str, _: &[u8]) -> io::Result<()> {
            std::thread::sleep(std::time::Duration::from_millis(200));
            Err(io::Error::other("put refused"))
        }
        fn get_chunk(&self, _: &str) -> io::Result<Vec<u8>> {
            Err(io::Error::other("get refused"))
        }
        fn put_manifest(&self, _: &str, _: &[u8]) -> io::Result<()> {
            Err(io::Error::other("put refused"))
        }
        fn get_manifest(&self, _: &str) -> io::Result<Vec<u8>> {
            Err(io::Error::other("get refused"))
        }
    }

    /// A commit whose uploads all fail returns the error, rather than leave the reader blocked on
    /// workers that stopped (holding the sandbox lock and the command executor).
    #[test]
    fn commit_whose_uploads_all_fail_returns_the_error() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("mem.img");
        // More non-zero chunks than the readahead queue (2 per worker) plus the one worker holds.
        let chunks = 8u64;
        create_sparse(&img, chunks * MEMORY_CHUNK as u64).unwrap();
        let f = OpenOptions::new().write(true).open(&img).unwrap();
        for i in 0..chunks {
            f.write_all_at(&[1], i * MEMORY_CHUNK as u64).unwrap();
        }
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || tx.send(commit_file(&FailingStore, &img, ManifestKind::Memory).map(|_| ()).map_err(|e| e.to_string())));
        // The work is a few hashes of 2 MiB; 10 s is a hang, not a slow machine.
        let r = rx.recv_timeout(std::time::Duration::from_secs(10)).expect("commit_file hung");
        assert_eq!(r.unwrap_err(), "put refused");
    }

    /// Two threads storing one chunk at once (a commit with two equal chunks) both succeed.
    #[test]
    fn concurrent_puts_of_one_chunk_both_succeed() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalFsStore::new(dir.path().join("store")).unwrap();
        let data = vec![7u8; 256 << 10];
        for round in 0..100 {
            let hex = format!("{round:064x}");
            let barrier = std::sync::Barrier::new(2);
            std::thread::scope(|scope| {
                let put = || {
                    barrier.wait();
                    store.put_chunk(&hex, &data)
                };
                let (a, b) = (scope.spawn(put), scope.spawn(put));
                a.join().unwrap().unwrap();
                b.join().unwrap().unwrap();
            });
        }
    }

    /// Review #18: manifests from the shared store are untrusted. Path-traversing chunk names,
    /// tampered chunks and tampered manifests are refused.
    #[test]
    fn restore_rejects_untrusted_manifests() {
        let dir = tempfile::tempdir().unwrap();
        let store = LocalFsStore::new(dir.path().join("store")).unwrap();
        let out = dir.path().join("out.img");
        let put_manifest = |m: &Manifest| {
            let bytes = serde_json::to_vec(m).unwrap();
            let hex = blake3::hash(&bytes).to_hex().to_string();
            store.put_manifest(&hex, &bytes).unwrap();
            ManifestHash(format!("blake3:{hex}"))
        };
        let base = Manifest { format: 1, kind: ManifestKind::Disk, chunk_size: DISK_CHUNK, size_bytes: DISK_CHUNK as u64, chunks: vec![None], prefetch: vec![] };

        // Traversal in a chunk name.
        let h = put_manifest(&Manifest { chunks: vec![Some("blake3:../../../../etc/passwd".into())], ..base.clone() });
        assert_eq!(restore_file(&store, &h, &out).unwrap_err().kind(), io::ErrorKind::InvalidData);

        // A chunk whose bytes don't match its name.
        let fake = "a".repeat(64);
        store.put_chunk(&fake, b"not the content you are looking for").unwrap();
        let h = put_manifest(&Manifest { chunks: vec![Some(format!("blake3:{fake}"))], ..base.clone() });
        assert_eq!(restore_file(&store, &h, &out).unwrap_err().kind(), io::ErrorKind::InvalidData);

        // A manifest whose bytes don't match its hash.
        let good = put_manifest(&base);
        let ghex = good.0.strip_prefix("blake3:").unwrap();
        fs::write(dir.path().join("store/manifests").join(ghex), br#"{"format":1}"#).unwrap();
        assert_eq!(restore_file(&store, &good, &out).unwrap_err().kind(), io::ErrorKind::InvalidData);

        // Chunk count inconsistent with the size.
        let h = put_manifest(&Manifest { size_bytes: 3 * DISK_CHUNK as u64, ..base });
        assert_eq!(restore_file(&store, &h, &out).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
}
