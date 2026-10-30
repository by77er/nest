//! Decisions over one incarnation's lifetime (a sandbox at one epoch on this host): its fenced-epoch
//! tombstone, the scan a starting nestd makes of what the last one left, what it does with each
//! incarnation found, and how retiring one salvages it (`docs/compute/nestd/README.md`, "Restarts"
//! and "Retiring an incarnation"). Plain values only; `nestd` keeps the maps, files and timers and
//! calls these for the decision.

use alloc::collections::BTreeMap;
use core::marker::PhantomData;
use core::time::Duration;

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

/// The map a [`TombstoneMap`] keeps, sandbox → fenced epoch: a `BTreeMap` in nestd. It exists so
/// the Kani harnesses can swap in a fixed array, as [`crate::results`] does: see their docs.
pub trait EpochMap<K>: Default {
    fn get(&self, key: &K) -> Option<u64>;
    fn insert(&mut self, key: K, epoch: u64);
    fn remove(&mut self, key: &K);
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<K: Ord> EpochMap<K> for BTreeMap<K, u64> {
    fn get(&self, key: &K) -> Option<u64> {
        BTreeMap::get(self, key).copied()
    }

    fn insert(&mut self, key: K, epoch: u64) {
        BTreeMap::insert(self, key, epoch);
    }

    fn remove(&mut self, key: &K) {
        BTreeMap::remove(self, key);
    }

    fn len(&self) -> usize {
        BTreeMap::len(self)
    }
}

/// Every sandbox's tombstone: the highest fenced epoch per sandbox, nothing at or below it accepted.
/// `nestd::tombstones::Tombstones` shares one behind a lock; this is all of its logic. An entry
/// lives from a fence until a destroy at or above it, or a newer epoch running here, lets it go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TombstoneMap<K, M = BTreeMap<K, u64>> {
    map: M,
    _keys: PhantomData<K>,
}

impl<K, M: Default> Default for TombstoneMap<K, M> {
    fn default() -> Self {
        TombstoneMap { map: M::default(), _keys: PhantomData }
    }
}

impl<K: Clone, M: EpochMap<K>> TombstoneMap<K, M> {
    /// `sandbox@epoch` was fenced: refuse it and every older epoch from now on.
    pub fn fence(&mut self, sandbox: &K, epoch: u64) {
        let fenced = fenced_after(self.map.get(sandbox), epoch);
        self.map.insert(sandbox.clone(), fenced);
    }

    /// Whether `sandbox@epoch` is at or below a fenced epoch.
    pub fn refuses(&self, sandbox: &K, epoch: u64) -> bool {
        refuses(self.map.get(sandbox), epoch)
    }

    /// The sandbox was destroyed at `epoch`: drop its tombstone if it is at or below that.
    pub fn prune_up_to(&mut self, sandbox: &K, epoch: u64) {
        if self.map.get(sandbox).is_some_and(|f| destroy_prunes(f, epoch)) {
            self.map.remove(sandbox);
        }
    }

    /// `epoch` of the sandbox now runs here: drop its tombstone if it is below that.
    pub fn prune_below(&mut self, sandbox: &K, epoch: u64) {
        if self.map.get(sandbox).is_some_and(|f| run_prunes(f, epoch)) {
            self.map.remove(sandbox);
        }
    }

    /// The fenced epoch recorded for `sandbox`, if any.
    pub fn get(&self, sandbox: &K) -> Option<u64> {
        self.map.get(sandbox)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
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

/// First wait before a failed salvage is retried. Retries go on, doubling up to the max, until the
/// salvage lands or the incarnation is destroyed (FleetDO destroys a dirty one after its salvage
/// window).
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

    /// The map `Tombstones` wraps, call by call: per sandbox, a fence never lowers its tombstone, a
    /// destroy lets go only at or above it, a run only above it, and other sandboxes are untouched.
    #[test]
    fn the_tombstone_map_keeps_each_sandbox_apart() {
        let mut t: TombstoneMap<&str> = TombstoneMap::default();
        assert!(t.is_empty() && !t.refuses(&"a", 0));
        t.fence(&"a", 3);
        t.fence(&"a", 2);
        t.fence(&"b", 7);
        assert_eq!((t.get(&"a"), t.get(&"b"), t.len()), (Some(3), Some(7), 2));
        assert!(t.refuses(&"a", 3) && t.refuses(&"a", 0) && !t.refuses(&"a", 4) && !t.refuses(&"c", 0));
        t.prune_below(&"a", 3);
        t.prune_up_to(&"a", 2);
        assert_eq!(t.get(&"a"), Some(3), "a run at it or a destroy below it keeps it");
        t.prune_below(&"a", 4);
        assert_eq!((t.get(&"a"), t.get(&"b")), (None, Some(7)), "a newer run lets go of only its own");
        t.prune_up_to(&"b", 7);
        assert!(t.is_empty(), "a destroy at the fenced epoch lets go");
        t.fence(&"b", 1);
        t.fence(&"b", 9);
        assert_eq!(t.get(&"b"), Some(9), "a fence raises it");
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

/// Kani harnesses (`cargo kani -p nestd-core --harness <name> --exact`). Each runs shipped code
/// over symbolic inputs: epochs range over every `u64` and flags over both values unless a harness
/// says otherwise; the bounds of the bounded ones are in their docs. Functions of one expression
/// (the tombstone comparisons, the scan's disposition, the retry and salvage predicates) have no
/// harness of their own: the table tests pin them, and the tombstone map proves them in use.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Sandboxes the tombstone harnesses use (ids `0..SANDBOXES`).
    const SANDBOXES: u8 = 2;
    /// Calls after the tracked fence.
    const CALLS: usize = 4;

    /// A map indexed by the sandbox id itself, the stand-in for `BTreeMap` (see the harnesses).
    #[derive(Default)]
    struct SlotEpochs([Option<u64>; SANDBOXES as usize]);

    impl EpochMap<u8> for SlotEpochs {
        fn get(&self, key: &u8) -> Option<u64> {
            self.0[*key as usize]
        }

        fn insert(&mut self, key: u8, epoch: u64) {
            self.0[key as usize] = Some(epoch);
        }

        fn remove(&mut self, key: &u8) {
            self.0[*key as usize] = None;
        }

        fn len(&self) -> usize {
            self.0.iter().filter(|e| e.is_some()).count()
        }
    }

    fn any_sandbox() -> u8 {
        kani::any_where(|s: &u8| *s < SANDBOXES)
    }

    fn snapshot<M: EpochMap<u8>>(t: &TombstoneMap<u8, M>) -> [Option<u64>; SANDBOXES as usize] {
        let mut out = [None; SANDBOXES as usize];
        for s in 0..SANDBOXES {
            out[s as usize] = t.get(&s);
        }
        out
    }

    /// The tombstone map as `nestd::tombstones::Tombstones` drives it: a fence of sandbox `k` at
    /// epoch `e` (over any earlier tombstone of `k`), then `CALLS` calls, each a fence, a destroy
    /// (`prune_up_to`) or a run (`prune_below`) of any sandbox at any epoch. After every call:
    /// - `k@e` is refused until a destroy of `k` at or above `e`, or a run of `k` above `e`;
    /// - a fence records the higher of the old tombstone and its epoch (never lower than either);
    /// - a destroy keeps exactly a tombstone above its epoch, and a run exactly one that refuses it;
    /// - no call touches another sandbox's tombstone;
    /// - `refuses` agrees with the recorded epoch for any epoch, and `len` counts the tombstones.
    fn tombstones_hold<M: EpochMap<u8>>() {
        let mut t: TombstoneMap<u8, M> = TombstoneMap::default();
        let (k, e): (u8, u64) = (any_sandbox(), kani::any());
        if kani::any() {
            t.fence(&k, kani::any());
        }
        t.fence(&k, e);
        let mut released = false;
        for _ in 0..CALLS {
            let (s, at, call): (u8, u64, u8) = (any_sandbox(), kani::any(), kani::any_where(|c: &u8| *c < 3));
            let before = snapshot(&t);
            let was = before[s as usize];
            match call {
                0 => t.fence(&s, at),
                1 => t.prune_up_to(&s, at),
                _ => t.prune_below(&s, at),
            }
            let now = t.get(&s);
            match call {
                0 => {
                    assert!(now == Some(was.map_or(at, |f| if f > at { f } else { at })));
                }
                1 => {
                    assert!(now == was.filter(|f| *f > at));
                }
                _ => {
                    assert!(now == was.filter(|f| *f >= at));
                }
            }
            let after = snapshot(&t);
            for o in 0..SANDBOXES {
                if o != s {
                    assert!(after[o as usize] == before[o as usize]);
                }
            }
            if s == k {
                released |= (call == 1 && at >= e) || (call == 2 && at > e);
            }
            assert!(released || t.refuses(&k, e));
            let probe: u64 = kani::any();
            assert!(t.refuses(&s, probe) == now.is_some_and(|f| probe <= f));
            assert!(t.len() == after.iter().filter(|f| f.is_some()).count());
        }
    }

    /// [`tombstones_hold`] over the fixed-array stand-in, so the map's own logic is proved for
    /// every epoch; the `BTreeMap` is trusted to be a map (as in `results::proofs`). Over the real
    /// `BTreeMap<u8, u64>` (unwind 13) Kani 0.68 was still in symbolic execution after 15 min at
    /// 3.2 GB, with these same bounds.
    #[kani::proof]
    #[kani::unwind(5)]
    fn the_tombstone_map_refuses_a_fenced_epoch_until_a_destroy_or_newer_run_reaches_it() {
        tombstones_hold::<SlotEpochs>();
    }

    /// Every entry name (bounded: up to 6 ASCII bytes) ending in `.del` is a deletion to finish
    /// (removed), whatever its type, never an incarnation; nothing but a directory is an
    /// incarnation.
    #[kani::proof]
    #[kani::unwind(8)]
    fn a_deleting_entry_is_always_removed() {
        let bytes: [u8; 6] = kani::any();
        let len: usize = kani::any_where(|l| *l <= 6);
        kani::assume(bytes[..len].is_ascii());
        let name = core::str::from_utf8(&bytes[..len]).unwrap();
        let is_dir: bool = kani::any();
        let entry = classify_entry(name, is_dir);
        if name.ends_with(DELETING) {
            assert!(entry == Entry::Deleting);
        }
        if let Entry::Incarnation(_) = entry {
            assert!(is_dir && !name.ends_with(DELETING));
        }
    }

    /// From any wait between the first and the max, the next is no shorter, never past the max,
    /// double unless capped; and within 9 steps every wait has reached the max and stays there.
    #[kani::proof]
    #[kani::unwind(10)]
    fn the_retire_backoff_grows_to_the_max_and_stays() {
        let start = Duration::from_nanos(kani::any_where(|n: &u64| *n >= RETIRE_RETRY_FIRST.as_nanos() as u64 && *n <= RETIRE_RETRY_MAX.as_nanos() as u64));
        let next = retire_backoff(start);
        assert!(next >= start && next <= RETIRE_RETRY_MAX);
        assert!(next == RETIRE_RETRY_MAX || next == start * 2);
        let mut b = start;
        for _ in 0..9 {
            b = retire_backoff(b);
        }
        assert!(b == RETIRE_RETRY_MAX && retire_backoff(b) == RETIRE_RETRY_MAX);
    }
}
