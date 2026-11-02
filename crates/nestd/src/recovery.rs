//! What a nestd process leaves on disk for the next one, and what the next one does with it.
//!
//! Each incarnation (a sandbox at one epoch) has its own directory,
//! `<state_dir>/sandboxes/<sandbox>/<epoch>/`, holding its disk (`disk.img`), any memory snapshot,
//! and, once that disk is complete (created, copied from the base image, or restored from a
//! generation, and synced), a `meta.json` naming the incarnation: sandbox, epoch, the generation
//! the disk last matched (salvage's parent), whether the disk is known to equal it, and a commit
//! request still waiting for its answer. It is written atomically and kept current. Incarnations
//! never share a file, so a newer epoch never waits on, or overwrites, an older one's disk.
//!
//! A restarted nestd runs nothing it finds: it has already killed every VM process the old one
//! left (`cgroup.rs`, `driver/supervise.rs`). An incarnation whose disk is known to equal its head
//! is deleted without a word (the control plane wakes a suspended sandbox from its head anyway);
//! every other one is reported `fenced` in the first fleet hello, salvaged, then deleted
//! (`host.rs`). An incarnation directory whose `meta.json` is missing or unreadable as JSON (a disk
//! still being prepared) is removed, never guessed at; one that can't be read for another reason,
//! or was written by a different `meta.json` version, is kept and logged.

use std::io::{self, Write};
use std::path::{Path, PathBuf};

use nest_protocol::model::{CommitReason, Epoch, GenerationId, GenerationKind, GenerationRecord, ManifestHash, RequestId, Resources, SandboxId, WorkstreamId};
use nestd_core::incarnation::{self, DELETING, Disposition, Entry, MetaRead, MetaVersion};
use serde::{Deserialize, Serialize};

pub const META_FILE: &str = "meta.json";
/// The `meta.json` layout this nestd reads and writes.
pub const META_VERSION: u32 = 1;

/// The incarnation a state directory belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxMeta {
    pub version: u32,
    pub sandbox: SandboxId,
    /// Compat: the `ws_` value the control plane sent (absent from a control plane that no longer
    /// sends one). Written while present, so a nestd of the previous release reads this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workstream: Option<WorkstreamId>,
    pub epoch: Epoch,
    pub image: String,
    pub resources: Resources,
    /// The generation this disk was restored from or last committed as: a salvage commit's parent,
    /// and what an unchanged disk is compared against (no salvage needed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<GenerationRecord>,
    /// The disk is known to equal `head`: a commit landed while the VM was stopped or paused (a
    /// suspend), and no VM has run on it since.
    #[serde(default)]
    pub clean: bool,
    /// A `commit_request` sent from this incarnation and not answered yet. The next commit (after a
    /// restart, too) asks again under the same request id first; SandboxDO answers a repeated id
    /// with its stored outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unanswered: Option<SentCommit>,
}

/// A `commit_request` as sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentCommit {
    pub request: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<GenerationId>,
    pub kind: GenerationKind,
    pub disk_manifest: ManifestHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_manifest: Option<ManifestHash>,
    pub reason: CommitReason,
}

/// Write `meta.json` into `dir` atomically: a temporary file, synced, renamed over the old one,
/// and the directory synced, so a crash leaves the old file or the new one, never a torn one.
/// A missing `dir` (the incarnation was deleted meanwhile) is an error, never re-created.
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

/// Read `meta.json`. A file that isn't this version's JSON is `InvalidData`, except one written by
/// a different version, which is `Unsupported` (kept: a newer nestd's, after a downgrade).
pub fn read_meta(dir: &Path) -> io::Result<SandboxMeta> {
    let bytes = std::fs::read(dir.join(META_FILE))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    match incarnation::meta_version(value.get("version").and_then(|v| v.as_u64()), u64::from(META_VERSION)) {
        MetaVersion::Current => {}
        MetaVersion::Other(v) => return Err(io::Error::new(io::ErrorKind::Unsupported, format!("meta.json version {v}, this nestd reads {META_VERSION}"))),
        MetaVersion::Missing => return Err(io::Error::new(io::ErrorKind::InvalidData, "meta.json without a version")),
    }
    serde_json::from_value(value).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

/// An incarnation a previous nestd process left in `state_dir`.
#[derive(Debug)]
pub struct Found {
    pub meta: SandboxMeta,
    pub state_dir: PathBuf,
}

/// Scan `<state_dir>/sandboxes/<sandbox>/<epoch>/`. Every incarnation whose `meta.json` reads and
/// names that sandbox and epoch is returned (by sandbox, then epoch). A directory whose
/// `meta.json` is missing, isn't valid JSON or names something else is removed, and so is
/// anything that is not an incarnation directory (the flat layout of a nestd from before
/// per-epoch directories had no `meta.json` either, so nothing in it can be trusted). A
/// `meta.json` that can't be read for any other reason, or has another version, is kept and
/// logged.
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
    for sbx in entries.flatten() {
        let name = sbx.file_name().to_string_lossy().into_owned();
        if !sbx.file_type().is_ok_and(|t| t.is_dir()) {
            tracing::warn!(path = %sbx.path().display(), "removing a stray file among sandbox state directories");
            remove(&sbx.path());
            continue;
        }
        for inc in std::fs::read_dir(sbx.path()).into_iter().flatten().flatten() {
            let path = inc.path();
            let epoch = match incarnation::classify_entry(&inc.file_name().to_string_lossy(), inc.file_type().is_ok_and(|t| t.is_dir())) {
                Entry::Incarnation(epoch) => epoch,
                Entry::Deleting => {
                    tracing::info!(path = %path.display(), "finishing the deletion of an incarnation");
                    remove(&path);
                    continue;
                }
                Entry::Other => {
                    tracing::warn!(path = %path.display(), "removing what is not an incarnation directory (an older nestd's flat layout, without meta.json)");
                    remove(&path);
                    continue;
                }
            };
            let meta = read_meta(&path);
            let read = match &meta {
                Ok(meta) if meta.sandbox.0 == name && meta.sandbox.is_valid() && meta.epoch == Epoch(epoch) => MetaRead::ThisIncarnation,
                Ok(_) => MetaRead::AnotherIncarnation,
                Err(err) if matches!(err.kind(), io::ErrorKind::NotFound | io::ErrorKind::InvalidData) => MetaRead::Unusable,
                Err(_) => MetaRead::Unreadable,
            };
            match (incarnation::disposition(read), meta) {
                (Disposition::Found, Ok(meta)) => found.push(Found { meta, state_dir: path }),
                (Disposition::Remove, Ok(meta)) => {
                    tracing::warn!(path = %path.display(), names = %meta.sandbox, epoch = meta.epoch.0, "removing an incarnation directory whose meta.json names another incarnation");
                    remove(&path);
                }
                (Disposition::Remove, Err(err)) => {
                    tracing::warn!(path = %path.display(), error = %err, "removing an incarnation directory without a usable meta.json (nothing is salvaged from it)");
                    remove(&path);
                }
                // `Found` only ever comes from a meta.json that read.
                (Disposition::Keep | Disposition::Found, meta) => {
                    let error = meta.err().map(|e| e.to_string()).unwrap_or_default();
                    tracing::error!(path = %path.display(), %error, "keeping an incarnation directory whose meta.json can't be read; it is not salvaged or deleted");
                }
            }
        }
        let _ = std::fs::remove_dir(sbx.path()); // only if now empty
    }
    found.sort_by(|a, b| (&a.meta.sandbox, a.meta.epoch).cmp(&(&b.meta.sandbox, b.meta.epoch)));
    found
}


/// Remove the incarnation directories `<root>/<sandbox>/<epoch>` at or below `up_to` (a destroy),
/// and `<root>/<sandbox>` once empty.
pub fn remove_up_to(root: &Path, sandbox: &SandboxId, up_to: Epoch) {
    let dir = root.join(&sandbox.0);
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        if e.file_name().to_string_lossy().parse::<u64>().is_ok_and(|n| n <= up_to.0) {
            delete_atomically(&e.path());
        }
    }
    let _ = std::fs::remove_dir(&dir);
}

/// Remove one incarnation directory, and its sandbox's directory once empty.
pub fn remove_incarnation(dir: &Path) {
    delete_atomically(dir);
    if let Some(parent) = dir.parent() {
        let _ = std::fs::remove_dir(parent);
    }
}

/// Rename `<epoch>` to `<epoch>.del`, then remove that: a crash midway leaves a `.del` directory
/// the next scan removes, never a half-deleted incarnation whose `meta.json` still names it.
fn delete_atomically(dir: &Path) {
    let Some(name) = dir.file_name() else { return };
    let doomed = dir.with_file_name(format!("{}{DELETING}", name.to_string_lossy()));
    remove(&doomed); // a previous attempt's
    match std::fs::rename(dir, &doomed) {
        Ok(()) => remove(&doomed),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::warn!(path = %dir.display(), error = %e, "renaming an incarnation for deletion; deleting it in place");
            remove(dir);
        }
    }
}

/// Remove every per-VM runtime directory under `<run_dir>/vm` (sockets, pidfiles): no VM outlives
/// the nestd process that started it. Returns how many were removed.
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

fn remove(path: &Path) {
    let r = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    match r {
        Err(e) if e.kind() != io::ErrorKind::NotFound => tracing::error!(path = %path.display(), error = %e, "removing sandbox state"),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(id: &str, epoch: u64) -> SandboxMeta {
        SandboxMeta {
            version: META_VERSION,
            sandbox: SandboxId(id.into()),
            workstream: Some(WorkstreamId("ws_1".into())),
            epoch: Epoch(epoch),
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
            clean: false,
            unanswered: Some(SentCommit {
                request: RequestId("req_1".into()),
                parent: Some(GenerationId("gen_1".into())),
                kind: GenerationKind::DiskOnly,
                disk_manifest: ManifestHash(format!("blake3:{}", "1".repeat(64))),
                mem_manifest: None,
                reason: CommitReason::Salvage,
            }),
        }
    }

    /// The scan returns what `write_meta` wrote, and removes what it can't trust: an incarnation
    /// without meta.json (a disk still being prepared), a torn one, one naming another
    /// incarnation, the flat layout of an older nestd, a stray file. It keeps one written by
    /// another meta.json version.
    #[test]
    fn scan_returns_named_incarnations_and_removes_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sandboxes");
        let mk = |rel: &str| {
            let d = root.join(rel);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("disk.img"), b"data").unwrap();
            d
        };
        let good = mk("sbx_good/4");
        write_meta(&good, &meta("sbx_good", 4)).unwrap();
        assert!(!good.join("meta.json.tmp").exists());
        let older = mk("sbx_good/2");
        write_meta(&older, &meta("sbx_good", 2)).unwrap();
        mk("sbx_bare/1");
        let torn = mk("sbx_torn/1");
        std::fs::write(torn.join(META_FILE), b"{\"version\":1,\"sandbox\":").unwrap();
        let foreign = mk("sbx_foreign/1");
        write_meta(&foreign, &meta("sbx_foreign", 9)).unwrap();
        let flat = mk("sbx_flat");
        std::fs::create_dir_all(flat.join("snapshot")).unwrap();
        let future = mk("sbx_future/1");
        let mut v2 = serde_json::to_value(meta("sbx_future", 1)).unwrap();
        v2["version"] = 2.into();
        std::fs::write(future.join(META_FILE), serde_json::to_vec(&v2).unwrap()).unwrap();
        std::fs::write(root.join("stray"), b"x").unwrap();
        // An incarnation whose deletion a crash interrupted: its meta.json must not revive it.
        let half_deleted = mk("sbx_good/7.del");
        write_meta(&half_deleted, &meta("sbx_good", 7)).unwrap();

        let found = scan(&root);
        let names: Vec<(String, u64)> = found.iter().map(|f| (f.meta.sandbox.0.clone(), f.meta.epoch.0)).collect();
        assert_eq!(names, vec![("sbx_good".into(), 2), ("sbx_good".into(), 4)]);
        assert_eq!(found[1].meta, meta("sbx_good", 4));
        assert_eq!(found[1].state_dir, good);
        let mut left: Vec<String> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        left.sort();
        assert_eq!(left, vec!["sbx_future".to_string(), "sbx_good".to_string()]);
        assert!(future.join(META_FILE).exists(), "another version's incarnation is kept");
        assert!(!half_deleted.exists(), "a half-deleted incarnation is finished off");
        assert!(scan(&dir.path().join("missing")).is_empty());
    }

    /// An incarnation whose meta.json can't be read for a reason other than missing or garbled
    /// (here: no permission) is kept, not deleted.
    #[test]
    fn an_unreadable_meta_keeps_its_incarnation() {
        if nix::unistd::geteuid().is_root() {
            eprintln!("NEST-TEST-SKIP: an_unreadable_meta_keeps_its_incarnation: root reads any file");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let inc = dir.path().join("sbx_a/1");
        std::fs::create_dir_all(&inc).unwrap();
        write_meta(&inc, &meta("sbx_a", 1)).unwrap();
        std::fs::set_permissions(inc.join(META_FILE), std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(scan(dir.path()).is_empty());
        assert!(inc.join(META_FILE).exists(), "an unreadable meta.json's incarnation was deleted");
    }

    /// A destroy at an epoch removes that incarnation and older ones, never a newer one.
    #[test]
    fn remove_up_to_spares_newer_epochs() {
        let dir = tempfile::tempdir().unwrap();
        for e in ["1", "2", "3"] {
            std::fs::create_dir_all(dir.path().join("sbx_a").join(e)).unwrap();
        }
        remove_up_to(dir.path(), &SandboxId("sbx_a".into()), Epoch(2));
        let left: Vec<String> = std::fs::read_dir(dir.path().join("sbx_a")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left, vec!["3".to_string()]);
        remove_up_to(dir.path(), &SandboxId("sbx_a".into()), Epoch(3));
        assert!(!dir.path().join("sbx_a").exists());
    }
}
