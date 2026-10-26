//! Decisions over one incarnation's lifetime (a sandbox at one epoch on this host): its fenced-epoch
//! tombstone, the scan a starting nestd makes of what the last one left, what it does with each
//! incarnation found, and how retiring one salvages it (`docs/compute/nestd/README.md`, "Restarts"
//! and "Retiring an incarnation"). Plain values only; `nestd` keeps the maps, files and timers and
//! calls these for the decision.

use std::time::Duration;

// Tombstones (`nestd::tombstones`): the highest fenced epoch per sandbox; nothing at or below it is
// accepted.

/// The tombstone after fencing `epoch` over `fenced` (none yet, or the epoch recorded): never lower
/// than either.
pub fn fenced_after(fenced: Option<u64>, epoch: u64) -> u64 {
    fenced.map_or(epoch, |f| f.max(epoch))
}

/// Whether a tombstone at `fenced` refuses `epoch`: it is at or below the fenced epoch.
pub fn refuses(fenced: Option<u64>, epoch: u64) -> bool {
    fenced.is_some_and(|f| epoch <= f)
}

/// Whether destroying the sandbox at `destroyed` lets go of its tombstone at `fenced`: only one at
/// or below the destroyed epoch (a fence above it stays).
pub fn destroy_prunes(fenced: u64, destroyed: u64) -> bool {
    fenced <= destroyed
}

/// Whether running the sandbox at `running` here lets go of its tombstone at `fenced`: only one
/// strictly below it (a create at the fenced epoch itself never clears it).
pub fn run_prunes(fenced: u64, running: u64) -> bool {
    fenced < running
}

// The scan of `<state_dir>/sandboxes/<sandbox>/` (`nestd::recovery::scan`).

/// Suffix an incarnation directory takes while it is being deleted.
pub const DELETING: &str = ".del";

/// What an entry under a sandbox's state directory is, by its name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    /// An incarnation directory, `<epoch>`.
    Incarnation(u64),
    /// An incarnation whose deletion a crash interrupted, `<epoch>.del`: finished off.
    Deleting,
    /// Anything else (an older nestd's flat layout, a stray file): removed.
    Other,
}

/// Classify the entry `name` (`is_dir`: it is a directory).
pub fn classify_entry(name: &str, is_dir: bool) -> Entry {
    match name.parse::<u64>() {
        Ok(epoch) if is_dir => Entry::Incarnation(epoch),
        _ if name.ends_with(DELETING) => Entry::Deleting,
        _ => Entry::Other,
    }
}

/// How an incarnation directory's `meta.json` read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaRead {
    /// It reads, and names the sandbox and epoch of the directory holding it.
    ThisIncarnation,
    /// It reads, but names another incarnation.
    AnotherIncarnation,
    /// Missing, or not this version's JSON (a disk still being prepared, a torn write).
    Unusable,
    /// Unreadable for any other reason (permissions, I/O, another `meta.json` version).
    Unreadable,
}

/// What the scan does with an incarnation directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    /// Returned as found: deleted or reported by the starting nestd ([`deletes_unreported`]).
    Found,
    /// Removed: nothing in it can be trusted, so nothing is salvaged from it.
    Remove,
    /// Kept as it is and logged: neither salvaged nor deleted.
    Keep,
}

/// What the scan does with an incarnation directory whose `meta.json` read as `read`.
pub fn disposition(read: MetaRead) -> Disposition {
    match read {
        MetaRead::ThisIncarnation => Disposition::Found,
        MetaRead::AnotherIncarnation | MetaRead::Unusable => Disposition::Remove,
        MetaRead::Unreadable => Disposition::Keep,
    }
}

/// What a `meta.json`'s `version` field means to a nestd that reads version `current`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MetaVersion {
    /// This nestd's layout: read on.
    Current,
    /// Another version's (a newer nestd's, after a downgrade): unsupported, so kept.
    Other(u64),
    /// No version: not a `meta.json` at all, so unusable.
    Missing,
}

/// Judge the parsed `version` field (`None`: absent or not an unsigned integer).
pub fn meta_version(version: Option<u64>, current: u64) -> MetaVersion {
    match version {
        Some(v) if v == current => MetaVersion::Current,
        Some(v) => MetaVersion::Other(v),
        None => MetaVersion::Missing,
    }
}

// A starting nestd and the incarnations it finds.

/// Whether a starting nestd deletes an incarnation it found without a word: only when its disk is
/// known to equal its head (`clean`) and no commit request from it is still unanswered (the
/// control plane wakes a suspended sandbox from its head anyway). Every other one is reported
/// `fenced` and retired.
pub fn deletes_unreported(clean: bool, unanswered: bool) -> bool {
    clean && !unanswered
}

// Retiring an incarnation (`Host::retire`).

/// First wait before a failed salvage is retried.
pub const RETIRE_RETRY_FIRST: Duration = Duration::from_secs(1);
/// The longest wait between salvage retries.
pub const RETIRE_RETRY_MAX: Duration = Duration::from_secs(300);

/// The wait after `backoff` before the next salvage retry: doubled, up to [`RETIRE_RETRY_MAX`].
pub fn retire_backoff(backoff: Duration) -> Duration {
    backoff.saturating_mul(2).min(RETIRE_RETRY_MAX)
}

/// Whether a failed salvage may succeed if tried again: a timeout or store error (`retryable`), or
/// a `parent_mismatch`. Any other refusal (`stale_epoch`, `invalid_message`) is SandboxDO's final
/// word on that work.
pub fn salvage_retryable(retryable: bool, parent_mismatch: bool) -> bool {
    retryable || parent_mismatch
}

/// Whether a commit has nothing to send: a salvage of a disk whose manifest is its head's (nothing
/// written since; a head's memory doesn't matter to a salvage, which has none). A disk with no head
/// is always salvaged, and any other commit is always sent.
pub fn nothing_to_salvage<M: PartialEq>(salvage: bool, head_disk: Option<&M>, disk: &M) -> bool {
    salvage && head_disk.is_some_and(|h| h == disk)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Characterization of `Tombstones` before the extraction (`fence`, `refuses`, `prune_up_to`,
    /// `prune_below`), as a table of (recorded, epoch) cases.
    #[test]
    fn tombstone_decisions_match_the_tombstone_map() {
        // (fenced, epoch, fenced_after, refuses, destroy_prunes, run_prunes)
        let cases = [
            (None, 3, 3, false, None, None),
            (Some(3), 2, 3, true, Some(false), Some(false)),
            (Some(3), 3, 3, true, Some(true), Some(false)),
            (Some(3), 4, 4, false, Some(true), Some(true)),
            (Some(0), 0, 0, true, Some(true), Some(false)),
            (Some(u64::MAX), 0, u64::MAX, true, Some(false), Some(false)),
            (Some(0), u64::MAX, u64::MAX, false, Some(true), Some(true)),
        ];
        for (fenced, epoch, after, refused, destroy, run) in cases {
            assert_eq!(fenced_after(fenced, epoch), after, "fence {epoch} over {fenced:?}");
            assert_eq!(refuses(fenced, epoch), refused, "refuses {epoch} under {fenced:?}");
            assert_eq!(fenced.map(|f| destroy_prunes(f, epoch)), destroy, "destroy at {epoch} of {fenced:?}");
            assert_eq!(fenced.map(|f| run_prunes(f, epoch)), run, "run at {epoch} of {fenced:?}");
        }
    }

    /// Characterization of `recovery::scan`'s naming rules: a directory named by a decimal epoch
    /// is an incarnation; `<epoch>.del` is a deletion to finish; anything else goes.
    #[test]
    fn entries_are_classified_by_name() {
        let cases = [
            ("4", true, Entry::Incarnation(4)),
            ("0", true, Entry::Incarnation(0)),
            ("18446744073709551615", true, Entry::Incarnation(u64::MAX)),
            ("18446744073709551616", true, Entry::Other),
            ("4", false, Entry::Other),
            ("7.del", true, Entry::Deleting),
            ("7.del", false, Entry::Deleting),
            ("disk.img", false, Entry::Other),
            ("snapshot", true, Entry::Other),
            ("-1", true, Entry::Other),
            ("", true, Entry::Other),
        ];
        for (name, is_dir, want) in cases {
            assert_eq!(classify_entry(name, is_dir), want, "{name:?} (dir: {is_dir})");
        }
    }

    /// Every `meta.json` outcome the scan can meet, and what it does with the directory.
    #[test]
    fn a_meta_read_decides_the_directory() {
        for read in [MetaRead::ThisIncarnation, MetaRead::AnotherIncarnation, MetaRead::Unusable, MetaRead::Unreadable] {
            let want = match read {
                MetaRead::ThisIncarnation => Disposition::Found,
                MetaRead::AnotherIncarnation => Disposition::Remove,
                MetaRead::Unusable => Disposition::Remove,
                MetaRead::Unreadable => Disposition::Keep,
            };
            assert_eq!(disposition(read), want, "{read:?}");
        }
    }

    #[test]
    fn only_the_current_meta_version_reads_on() {
        assert_eq!(meta_version(Some(1), 1), MetaVersion::Current);
        assert_eq!(meta_version(Some(2), 1), MetaVersion::Other(2));
        assert_eq!(meta_version(Some(0), 1), MetaVersion::Other(0));
        assert_eq!(meta_version(None, 1), MetaVersion::Missing);
    }

    /// Characterization of `Host::start`: only a clean incarnation with nothing unanswered is
    /// deleted unreported.
    #[test]
    fn only_a_clean_settled_incarnation_is_deleted_unreported() {
        for (clean, unanswered, want) in [(true, false, true), (true, true, false), (false, false, false), (false, true, false)] {
            assert_eq!(deletes_unreported(clean, unanswered), want, "clean {clean}, unanswered {unanswered}");
        }
    }

    /// The retire backoff waits 1, 2, 4, ... 256 s, then 300 s from then on.
    #[test]
    fn the_retire_backoff_doubles_to_five_minutes() {
        let mut b = RETIRE_RETRY_FIRST;
        let mut waits = vec![];
        for _ in 0..12 {
            waits.push(b.as_secs());
            b = retire_backoff(b);
        }
        assert_eq!(waits, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);
    }

    /// Characterization of `salvage_retryable` in host.rs (its test there uses the error codes).
    #[test]
    fn a_salvage_is_retried_when_retryable_or_a_parent_mismatch() {
        for (retryable, parent_mismatch, want) in [(true, false, true), (false, true, true), (true, true, true), (false, false, false)] {
            assert_eq!(salvage_retryable(retryable, parent_mismatch), want);
        }
    }

    /// Characterization of `prepare_commit`'s check: only a salvage of a disk equal to its head's
    /// disk has nothing to send.
    #[test]
    fn only_a_salvage_of_the_heads_disk_is_skipped() {
        let (a, b) = ("blake3:a", "blake3:b");
        assert!(nothing_to_salvage(true, Some(&a), &a));
        assert!(!nothing_to_salvage(true, Some(&b), &a));
        assert!(!nothing_to_salvage(true, None, &a), "a disk with no head is salvaged");
        assert!(!nothing_to_salvage(false, Some(&a), &a), "only a salvage is skipped");
    }
}
