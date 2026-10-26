//! What a nestd process leaves on disk for the next one, and what the next one does with it.
//!
//! Each sandbox's state directory (`<state_dir>/sandboxes/<id>/`) holds its disk (`disk.img`) and,
//! once that disk is complete (created, copied from the base image, or restored from a
//! generation), a `meta.json` naming the incarnation: sandbox, epoch, and the generation the disk
//! last matched (salvage's parent). It is written atomically, and rewritten whenever a commit moves
//! the head.
//!
//! A restarted nestd runs nothing it finds: every VM died with the old process (systemd stops the
//! unit's whole cgroup), so each incarnation found is reported `fenced` in the first fleet hello,
//! salvaged if its disk differs from its head, then deleted (`host.rs`). A directory without a
//! readable `meta.json` naming it (a disk that was still being prepared, or one left by a nestd
//! from before `meta.json` existed) is logged and removed, never guessed at. The per-VM runtime
//! directories are swept too, and the netns bind mounts in `net.rs`.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use nest_protocol::model::{Epoch, GenerationRecord, Resources, SandboxId, WorkstreamId};
use serde::{Deserialize, Serialize};

pub const META_FILE: &str = "meta.json";

/// The incarnation a sandbox state directory belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxMeta {
    pub sandbox: SandboxId,
    pub workstream: WorkstreamId,
    pub epoch: Epoch,
    pub image: String,
    pub resources: Resources,
    /// The generation this disk was restored from or last committed as: a salvage commit's parent,
    /// and what an unchanged disk is compared against (no salvage needed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<GenerationRecord>,
}

/// Write `meta.json` into `dir` atomically: a temporary file, synced, renamed over the old one,
/// and the directory synced, so a crash leaves the old file or the new one, never a torn one.
pub fn write_meta(dir: &Path, meta: &SandboxMeta) -> io::Result<()> {
    let tmp = dir.join(format!("{META_FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(meta).map_err(io::Error::other)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dir.join(META_FILE))?;
    std::fs::File::open(dir)?.sync_all()
}

/// Remove `meta.json` (a newer incarnation is about to prepare its disk in this directory).
pub fn remove_meta(dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(dir.join(META_FILE)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub fn read_meta(dir: &Path) -> io::Result<SandboxMeta> {
    let bytes = std::fs::read(dir.join(META_FILE))?;
    serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// An incarnation a previous nestd process left in `state_dir`.
#[derive(Debug)]
pub struct Found {
    pub meta: SandboxMeta,
    pub state_dir: PathBuf,
}

/// Scan `<state_dir>/sandboxes`. Every directory whose `meta.json` reads and names that directory's
/// sandbox is returned; anything else there is logged and removed.
pub fn scan(sandboxes_dir: &Path) -> Vec<Found> {
    let mut found = vec![];
    let entries = match std::fs::read_dir(sandboxes_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return found,
        Err(e) => {
            tracing::error!(dir = %sandboxes_dir.display(), error = %e, "cannot scan sandbox state directories");
            return found;
        }
    };
    for e in entries.flatten() {
        let path = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if !e.file_type().is_ok_and(|t| t.is_dir()) {
            tracing::warn!(path = %path.display(), "removing a stray file among sandbox state directories");
            let _ = std::fs::remove_file(&path);
            continue;
        }
        match read_meta(&path) {
            Ok(meta) if meta.sandbox.0 == name && meta.sandbox.is_valid() => found.push(Found { meta, state_dir: path }),
            Ok(meta) => {
                tracing::warn!(path = %path.display(), names = %meta.sandbox, "removing a sandbox state directory whose meta.json names another sandbox");
                remove_dir(&path);
            }
            Err(err) => {
                tracing::warn!(path = %path.display(), error = %err, "removing a sandbox state directory without a readable meta.json (nothing is salvaged from it)");
                remove_dir(&path);
            }
        }
    }
    found.sort_by(|a, b| a.meta.sandbox.cmp(&b.meta.sandbox));
    found
}

/// Remove every per-VM runtime directory under `<run_dir>/vm` (sockets, snapshots): no VM
/// outlives the nestd process that started it. Returns how many were removed.
pub fn sweep_vm_dirs(dir: &Path) -> usize {
    let mut n = 0;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = e.path();
        let r = if e.file_type().is_ok_and(|t| t.is_dir()) { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        match r {
            Ok(()) => n += 1,
            Err(err) => tracing::warn!(path = %path.display(), error = %err, "removing a leftover VM runtime directory"),
        }
    }
    n
}

fn remove_dir(path: &Path) {
    if let Err(e) = std::fs::remove_dir_all(path) {
        tracing::error!(path = %path.display(), error = %e, "removing a sandbox state directory");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::{CommitReason, GenerationId, GenerationKind, ManifestHash};

    fn meta(id: &str) -> SandboxMeta {
        SandboxMeta {
            sandbox: SandboxId(id.into()),
            workstream: WorkstreamId("ws_1".into()),
            epoch: Epoch(4),
            image: "base".into(),
            resources: Resources { vcpus: 1, memory_mib: 256, disk_gib: 1 },
            head: Some(GenerationRecord {
                id: GenerationId("gen_1".into()),
                sandbox: SandboxId(id.into()),
                parent: None,
                epoch: Epoch(3),
                kind: GenerationKind::DiskOnly,
                disk_manifest: ManifestHash(format!("blake3:{}", "0".repeat(64))),
                mem_manifest: None,
                reason: CommitReason::TurnEnd,
                created_ms: 1,
            }),
        }
    }

    /// The scan returns what `write_meta` wrote, and removes what it can't trust: a directory
    /// without meta.json (a disk still being prepared), a torn or foreign meta.json, a stray file.
    #[test]
    fn scan_returns_named_incarnations_and_removes_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sandboxes");
        let mk = |name: &str| {
            let d = root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("disk.img"), b"data").unwrap();
            d
        };
        let good = mk("sbx_good");
        write_meta(&good, &meta("sbx_good")).unwrap();
        assert!(!good.join("meta.json.tmp").exists());
        let _bare = mk("sbx_bare");
        let torn = mk("sbx_torn");
        std::fs::write(torn.join(META_FILE), b"{\"sandbox\":").unwrap();
        let foreign = mk("sbx_foreign");
        write_meta(&foreign, &meta("sbx_other")).unwrap();
        std::fs::write(root.join("stray"), b"x").unwrap();

        let found = scan(&root);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].meta, meta("sbx_good"));
        assert_eq!(found[0].state_dir, good);
        let left: Vec<String> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["sbx_good".to_string()]);
        assert!(scan(&dir.path().join("missing")).is_empty());
    }

    /// A sandbox never committed has no `head`: none is written, and the file reads back.
    #[test]
    fn meta_without_head_reads() {
        let dir = tempfile::tempdir().unwrap();
        let mut m = meta("sbx_a");
        m.head = None;
        write_meta(dir.path(), &m).unwrap();
        let text = std::fs::read_to_string(dir.path().join(META_FILE)).unwrap();
        assert!(!text.contains("head"));
        assert_eq!(read_meta(dir.path()).unwrap(), m);
        remove_meta(dir.path()).unwrap();
        remove_meta(dir.path()).unwrap();
        assert!(read_meta(dir.path()).is_err());
    }
}
