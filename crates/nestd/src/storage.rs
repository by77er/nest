//! Generation storage: content-addressed chunks and manifests in the cell's object store.
//!
//! Backends: [`LocalFsStore`] (a directory per cell) and `s3::S3Store`.
//! Disk images are chunked hole-aware (`SEEK_DATA`), so sparse images commit quickly and all-zero
//! chunks become `null` entries that are never stored.

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
        let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
        fs::write(&tmp, data)?;
        fs::rename(tmp, path)
    }
}

impl ObjectStore for LocalFsStore {
    fn has_chunk(&self, hex: &str) -> io::Result<bool> {
        Ok(self.root.join("chunks").join(hex).exists())
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

/// Chunk `path` into `store` and write its manifest. Returns the manifest and its hash.
/// Unchanged chunks already present in the store are not rewritten (content addressing). The file
/// is read sequentially; hashing and uploads run on `store.parallelism()` threads.
pub fn commit_file(store: &dyn ObjectStore, path: &Path, kind: ManifestKind) -> io::Result<(Manifest, ManifestHash)> {
    let chunk_size = match kind {
        ManifestKind::Disk => DISK_CHUNK,
        ManifestKind::Memory => MEMORY_CHUNK,
    } as u64;
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let chunks: Mutex<Vec<Option<String>>> = Mutex::new(vec![None; size.div_ceil(chunk_size) as usize]);
    // The file is read sequentially (the reader runs under par_try_for_each's lock); all-zero
    // chunks are skipped.
    let mut pos = 0u64;
    let mut read_next = || -> io::Result<Option<(usize, Vec<u8>)>> {
        while pos < size {
            let Some(data) = next_data(&file, pos)? else { break };
            let idx = data / chunk_size;
            let start = idx * chunk_size;
            let mut buf = vec![0u8; chunk_size.min(size - start) as usize];
            file.seek(SeekFrom::Start(start))?;
            file.read_exact(&mut buf)?;
            pos = start + chunk_size;
            if buf.iter().any(|&b| b != 0) {
                return Ok(Some((idx as usize, buf)));
            }
        }
        Ok(None)
    };
    let items = std::iter::from_fn(|| read_next().transpose());
    par_try_for_each(items, store.parallelism(), |(idx, bytes)| {
        let hex = blake3::hash(&bytes).to_hex().to_string();
        if !store.has_chunk(&hex)? {
            store.put_chunk(&hex, &bytes)?;
        }
        chunks.lock().expect("chunks")[idx] = Some(format!("blake3:{hex}"));
        Ok(())
    })?;
    let chunks = chunks.into_inner().expect("chunks");
    let manifest = Manifest { format: 1, kind, chunk_size: chunk_size as u32, size_bytes: size, chunks, prefetch: vec![] };
    let bytes = serde_json::to_vec(&manifest).map_err(io::Error::other)?;
    let hex = blake3::hash(&bytes).to_hex().to_string();
    store.put_manifest(&hex, &bytes)?;
    Ok((manifest, ManifestHash(format!("blake3:{hex}"))))
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

    /// A commit whose uploads all fail returns the error. It used to deadlock: every worker stopped
    /// on its error, and the reader blocked forever sending the next chunk into the full queue,
    /// holding the sandbox lock and the host's command executor with it.
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
