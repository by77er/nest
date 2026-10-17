//! Object-store GC, one pass (`docs/sandbox/state/object-store/#garbage-collection`).
//!
//! FleetDO decides when a pass runs and snapshots the roots (every live sandbox's generations'
//! manifests) at the mark; a burst host runs it because only hosts hold S3 credentials. The pass
//! marks every chunk those manifests name, lists the store's versions, and deletes the versions
//! of unmarked objects last uploaded more than the grace (24 h) before the mark, each by version
//! id so a racing re-upload survives. Commits reuse an object only if it was uploaded under 12 h
//! ago ([`crate::s3::REUSE_MS`]), and a pass deletes only until 12 h after its mark, so nothing a
//! commit relies on can be deleted under it.
//!
//! It fails closed: a root it can't read or parse, an entry it can't parse, or a key it doesn't
//! recognize stops the pass (or, for keys, is left alone).

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use nest_protocol::model::Manifest;
use serde::{Deserialize, Serialize};

use crate::s3::{ObjectVersion, S3Store};

/// What FleetDO hands a host for one pass (`POST /v1/hosts/gc/claim`).
#[derive(Clone, Debug, Deserialize)]
pub struct Claim {
    pub run: String,
    pub marked_ms: i64,
    pub dry_run: bool,
    pub roots: Vec<String>,
    pub grace_ms: i64,
    pub deadline_ms: i64,
    pub max_deletes: u64,
}

/// What the pass did (`POST /v1/hosts/gc/report`).
#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
pub struct Report {
    pub dry_run: bool,
    pub roots: usize,
    pub marked_chunks: usize,
    pub objects: usize,
    pub versions: usize,
    /// Unmarked objects past the grace, their versions and bytes: deleted, or (dry run) would be.
    pub sweep_objects: usize,
    pub sweep_versions: usize,
    pub sweep_bytes: u64,
    /// Unmarked but still inside the grace.
    pub young_unmarked: usize,
    /// Keys that aren't `chunks/<hex>` or `manifests/<hex>`: never touched.
    pub unrecognized: usize,
    pub deleted: u64,
    pub delete_errors: u64,
    /// A few of the keys swept, for review.
    pub sample: Vec<String>,
    /// Why the pass stopped early, if it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stopped: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Concurrent deletes.
const DELETE_PARALLELISM: usize = 16;

/// Run one pass. `now` is injected for tests.
pub fn run(store: &S3Store, claim: &Claim, now: &(dyn Fn() -> i64 + Sync)) -> Report {
    let mut report = Report { dry_run: claim.dry_run, roots: claim.roots.len(), ..Default::default() };
    if let Err(e) = sweep(store, claim, now, &mut report) {
        report.error = Some(e.to_string());
    }
    report
}

fn sweep(store: &S3Store, claim: &Claim, now: &(dyn Fn() -> i64 + Sync), report: &mut Report) -> io::Result<()> {
    // Mark. The roots' manifests themselves are kept too.
    let mut marked: HashSet<String> = HashSet::new();
    for root in &claim.roots {
        let hex = hex_of(root).ok_or_else(|| io::Error::other(format!("bad root {root}")))?;
        let data = store.manifest_verified(hex).map_err(|e| io::Error::other(format!("root {root}: {e}")))?;
        let manifest: Manifest = serde_json::from_slice(&data).map_err(|e| io::Error::other(format!("root {root}: {e}")))?;
        marked.insert(format!("manifests/{hex}"));
        for c in manifest.chunks.iter().flatten() {
            let chunk = hex_of(c).ok_or_else(|| io::Error::other(format!("root {root} names a bad chunk {c}")))?;
            marked.insert(format!("chunks/{chunk}"));
        }
    }
    report.marked_chunks = marked.iter().filter(|k| k.starts_with("chunks/")).count();

    // Sweep: group versions by key; a key goes only if unmarked and its newest version (of any
    // kind) is older than the grace.
    let cutoff = claim.marked_ms - claim.grace_ms;
    let mut by_key: BTreeMap<String, Vec<ObjectVersion>> = BTreeMap::new();
    for sub in ["chunks/", "manifests/"] {
        for v in store.list_versions(sub)? {
            by_key.entry(v.key.clone()).or_default().push(v);
        }
    }
    report.objects = by_key.len();
    report.versions = by_key.values().map(Vec::len).sum();
    let mut doomed: Vec<ObjectVersion> = Vec::new();
    for (key, versions) in &by_key {
        if !recognized(key) {
            report.unrecognized += 1;
            continue;
        }
        if marked.contains(key) {
            continue;
        }
        if versions.iter().map(|v| v.last_modified_ms).max().unwrap_or(i64::MAX) >= cutoff {
            report.young_unmarked += 1;
            continue;
        }
        report.sweep_objects += 1;
        report.sweep_versions += versions.len();
        report.sweep_bytes += versions.iter().map(|v| v.size).sum::<u64>();
        if report.sample.len() < 5 {
            report.sample.push(key.clone());
        }
        doomed.extend(versions.iter().cloned());
    }
    if claim.dry_run {
        return Ok(());
    }

    if doomed.len() as u64 > claim.max_deletes {
        report.stopped = Some(format!("capped at {} deletes of {}", claim.max_deletes, doomed.len()));
        doomed.truncate(claim.max_deletes as usize);
    }
    let next = AtomicUsize::new(0);
    let (deleted, errors) = (AtomicU64::new(0), AtomicU64::new(0));
    let late = Mutex::new(false);
    std::thread::scope(|scope| {
        for _ in 0..DELETE_PARALLELISM.min(doomed.len()) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    let Some(v) = doomed.get(i) else { return };
                    // The reuse rule only covers deletes within 12 h of the mark.
                    if now() >= claim.deadline_ms {
                        *late.lock().unwrap() = true;
                        return;
                    }
                    match store.delete_version(&v.key, &v.version_id) {
                        Ok(()) => deleted.fetch_add(1, Ordering::Relaxed),
                        Err(e) => {
                            tracing::warn!(key = %v.key, version = %v.version_id, "GC delete failed: {e}");
                            errors.fetch_add(1, Ordering::Relaxed)
                        }
                    };
                }
            });
        }
    });
    report.deleted = deleted.into_inner();
    report.delete_errors = errors.into_inner();
    if late.into_inner().unwrap() {
        report.stopped = Some("past the deadline (12 h after the mark)".into());
    }
    Ok(())
}

fn hex_of(hash: &str) -> Option<&str> {
    let hex = hash.strip_prefix("blake3:")?;
    is_hex64(hex).then_some(hex)
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn recognized(key: &str) -> bool {
    key.strip_prefix("chunks/").or_else(|| key.strip_prefix("manifests/")).is_some_and(is_hex64)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use nest_protocol::model::ManifestKind;

    use super::*;
    use crate::s3::tests::{fake_s3, image, store};
    use crate::storage;

    const H: i64 = 3_600_000;

    fn claim(roots: Vec<String>, dry_run: bool, now: i64) -> Claim {
        Claim { run: "gc_t".into(), marked_ms: now, dry_run, roots, grace_ms: 24 * H, deadline_ms: now + 12 * H, max_deletes: 1000 }
    }

    /// Two generations; the second is dropped. Its chunks go once they're past the grace, the
    /// first's stay, a fresh unmarked upload stays, and the dry run deletes nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn sweeps_only_old_unmarked_versions() {
        let fake = fake_s3().await;
        fake.page.store(3, Ordering::SeqCst); // exercise paging
        let dir = tempfile::tempdir().unwrap();
        let (url, d) = (fake.url.clone(), dir.path().to_path_buf());
        let f2 = fake.clone();
        tokio::task::spawn_blocking(move || {
            let (keep_img, drop_img) = (d.join("keep.img"), d.join("drop.img"));
            image(&keep_img, 2);
            image(&drop_img, 5); // shares chunks 0 and 1 with keep
            let s = store(&url, &d.join("cache"));
            let (_, keep) = storage::commit_file(&s, &keep_img, ManifestKind::Disk).unwrap();
            let (_, dropped) = storage::commit_file(&s, &drop_img, ManifestKind::Disk).unwrap();
            f2.age_all(30 * H);
            // Unmarked but uploaded an hour ago: inside the grace.
            s.put_young("chunks/".to_string() + &"ab".repeat(32), b"young");
            // Something else under the prefix: never touched.
            s.put_young("chunks/not-a-hash".into(), b"?");
            let now = crate::util::now_ms();

            let dry = run(&s, &claim(vec![keep.0.clone()], true, now), &crate::util::now_ms);
            assert_eq!(dry.error, None);
            assert_eq!((dry.sweep_objects, dry.young_unmarked, dry.unrecognized, dry.deleted), (4, 1, 1, 0), "{dry:?}"); // 3 chunks + 1 manifest
            assert_eq!(f2.objects.lock().unwrap().len(), 9);

            let real = run(&s, &claim(vec![keep.0.clone()], false, now), &crate::util::now_ms);
            assert_eq!((real.deleted, real.delete_errors, real.stopped.clone()), (4, 0, None), "{real:?}");
            let left: Vec<String> = f2.objects.lock().unwrap().keys().cloned().collect();
            assert_eq!(left.len(), 5, "{left:?}");
            assert!(!left.iter().any(|k| k.ends_with(dropped.0.strip_prefix("blake3:").unwrap())));
            // What's kept still restores.
            storage::restore_file(&store(&url, &d.join("other")), &keep, &d.join("out.img")).unwrap();
            assert_eq!(std::fs::read(&keep_img).unwrap(), std::fs::read(d.join("out.img")).unwrap());
        })
        .await
        .unwrap();
    }

    /// A missing root stops the pass before it deletes anything; so does a pass past its window.
    #[tokio::test(flavor = "multi_thread")]
    async fn fails_closed() {
        let fake = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let (url, d) = (fake.url.clone(), dir.path().to_path_buf());
        let f2 = fake.clone();
        tokio::task::spawn_blocking(move || {
            image(&d.join("a.img"), 3);
            let s = store(&url, &d.join("cache"));
            storage::commit_file(&s, &d.join("a.img"), ManifestKind::Disk).unwrap();
            f2.age_all(30 * H);
            let now = crate::util::now_ms();
            let missing = format!("blake3:{}", "cd".repeat(32));
            let r = run(&s, &claim(vec![missing], false, now), &crate::util::now_ms);
            assert!(r.error.as_deref().unwrap().contains("root"), "{r:?}");
            assert_eq!(f2.objects.lock().unwrap().len(), 4);
            // Past the deadline: nothing deleted.
            let late = || crate::util::now_ms() + 13 * H;
            let r = run(&s, &claim(vec![], false, now), &late);
            assert_eq!((r.sweep_objects, r.deleted), (4, 0));
            assert!(r.stopped.unwrap().contains("deadline"));
            // Capped.
            let mut c = claim(vec![], false, now);
            c.max_deletes = 2;
            let r = run(&s, &c, &crate::util::now_ms);
            assert_eq!(r.deleted, 2);
            assert_eq!(f2.objects.lock().unwrap().len(), 2);
        })
        .await
        .unwrap();
    }

    /// The reuse rule: an object last uploaded over 12 h ago is uploaded again (a new version,
    /// fresh to GC); a younger one is reused, by this host or another.
    #[tokio::test(flavor = "multi_thread")]
    async fn commits_reupload_objects_older_than_twelve_hours() {
        let fake = fake_s3().await;
        let dir = tempfile::tempdir().unwrap();
        let (url, d) = (fake.url.clone(), dir.path().to_path_buf());
        let f2 = fake.clone();
        tokio::task::spawn_blocking(move || {
            image(&d.join("a.img"), 2);
            let puts = || *f2.calls.lock().unwrap().get("PUT").unwrap_or(&0);
            storage::commit_file(&store(&url, &d.join("c1")), &d.join("a.img"), ManifestKind::Disk).unwrap();
            assert_eq!(puts(), 3);
            f2.age_all(11 * H);
            // Another host, cache cold: 11 h old is reusable.
            storage::commit_file(&store(&url, &d.join("c2")), &d.join("a.img"), ManifestKind::Disk).unwrap();
            assert_eq!(puts(), 3);
            f2.age_all(2 * H);
            // 13 h: uploaded again, even by a host whose cache has every chunk.
            storage::commit_file(&store(&url, &d.join("c1")), &d.join("a.img"), ManifestKind::Disk).unwrap();
            assert_eq!(puts(), 6);
            assert!(f2.versions.lock().unwrap().values().all(|v| v.len() == 2));
        })
        .await
        .unwrap();
    }
}

#[cfg(test)]
mod real {
    use nest_protocol::model::ManifestKind;

    use super::*;
    use crate::s3::tests::{image, real_store};
    use crate::storage;

    /// Against the real bucket, under a throwaway prefix, with no grace: ListObjectVersions
    /// parsing and paging, and exact versioned deletes. `NEST_S3_TEST_BUCKET=… cargo test -p nestd
    /// real_gc -- --ignored`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs a real bucket and credentials"]
    async fn real_gc() {
        let (s, bucket, prefix) = real_store();
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_path_buf();
        tokio::task::spawn_blocking(move || {
            image(&d.join("keep.img"), 2);
            image(&d.join("drop.img"), 4);
            let (_, keep) = storage::commit_file(&s, &d.join("keep.img"), ManifestKind::Disk).unwrap();
            storage::commit_file(&s, &d.join("drop.img"), ManifestKind::Disk).unwrap();
            // A second version of a doomed key: both go.
            let extra = format!("chunks/{}", "ef".repeat(32));
            s.put_young(extra.clone(), b"one");
            s.put_young(extra, b"two");
            std::thread::sleep(std::time::Duration::from_secs(2));
            let now = crate::util::now_ms();
            let claim = |dry_run| Claim {
                run: "gc_real".into(),
                marked_ms: now,
                dry_run,
                roots: vec![keep.0.clone()],
                grace_ms: 0,
                deadline_ms: now + 600_000,
                max_deletes: 100,
            };
            let dry = run(&s, &claim(true), &crate::util::now_ms);
            assert_eq!(dry.error, None, "{dry:?}");
            // keep: 2 chunks + manifest; drop adds 2 chunks + manifest; plus the 2-version extra.
            assert_eq!((dry.objects, dry.versions, dry.sweep_objects, dry.sweep_versions), (7, 8, 4, 5), "{dry:?}");
            let r = run(&s, &claim(false), &crate::util::now_ms);
            assert_eq!((r.deleted, r.delete_errors), (5, 0), "{r:?}");
            let left = s.list_versions("").unwrap();
            assert_eq!(left.len(), 3, "{left:?}");
            storage::restore_file(&s, &keep, &d.join("out.img")).unwrap();
            assert_eq!(std::fs::read(d.join("keep.img")).unwrap(), std::fs::read(d.join("out.img")).unwrap());
            for v in left {
                s.delete_version(&v.key, &v.version_id).unwrap();
            }
            assert!(s.list_versions("").unwrap().is_empty());
        })
        .await
        .unwrap();
        eprintln!("real GC ok under s3://{bucket}/{prefix}");
    }
}
