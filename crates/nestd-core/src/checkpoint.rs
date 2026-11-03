//! The unchanged-disk short-circuit of a commit (`docs/sandbox/state/disk/`, "Unchanged disk"):
//! when a pass over a sandbox's disk is made while nothing can write it, nestd sets the disk file's
//! modification time to [`SENTINEL`] and remembers the pass's manifest with the file as `stat`
//! then reads it. A later commit that finds the file exactly so, again while nothing can write it,
//! reuses that manifest instead of reading the disk.
//!
//! Why it is sound (checked by `verification/nestd/check`, `sentinel`):
//! - Every write to the file sets its modification time to the current time (the kernel's write
//!   path updates it before the data is copied), and the current time is never the sentinel, a
//!   moment in 1970. So a file whose modification time still reads as the sentinel has had no write
//!   start since nestd set it.
//! - Both reads happen while no writer runs: the VM is paused or stopped. Firecracker's `Sync`
//!   engine completes each write before the guest sees it complete, so a paused VM has none in
//!   flight. An engine that completes writes after a pause (`Async`) breaks that, and the model
//!   shows it: such a host must not use this.
//! - The memo lives in one nestd process's memory, per incarnation: a restart forgets it, and the
//!   sentinel left on a file means nothing without it.
//!
//! Plain values only: `nestd` does the `stat`, sets the time, and passes what it read.

/// A file's identity, length and modification time, as `stat` read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DiskStamp {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub mtime_sec: i64,
    pub mtime_nsec: u32,
}

/// The modification time nestd gives a disk after a pass (1970-01-01T00:00:01.000004242Z), as
/// (seconds, nanoseconds) since the Unix epoch. A write sets the current time, never this.
pub const SENTINEL: (i64, u32) = (1, 4242);

impl DiskStamp {
    /// The modification time is [`SENTINEL`].
    pub fn is_sentinel(&self) -> bool {
        (self.mtime_sec, self.mtime_nsec) == SENTINEL
    }
}

/// A pass [`ScanMemo::begin`] started, to hand back to [`ScanMemo::scanned`]. Passes overlap with
/// a reflink cut (M2): one is begun at each cut, while the VM is paused, and recorded when its cut
/// has been read in the background, by which time a newer cut may have begun another.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Pass(u64);

/// The last pass over one incarnation's disk that a later commit may reuse.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ScanMemo<M> {
    last: Option<(DiskStamp, M)>,
    /// How many passes have begun: only the newest may record.
    begun: u64,
}

impl<M> Default for ScanMemo<M> {
    fn default() -> Self {
        ScanMemo { last: None, begun: 0 }
    }
}

impl<M> ScanMemo<M> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Pass `pass` produced `manifest`: the disk's content when `stamp` was read. `stable`: nothing
    /// could write the disk from before the pass's read (or cut) until `stamp` was read. `stamp`: the
    /// file as read after nestd set the sentinel (`None`: setting it or reading it back failed).
    /// Remembered only when this is the newest pass begun, it was stable, and the stamp shows the
    /// sentinel; an older pass records nothing (the sentinel a newer cut set reads the same, over
    /// content this manifest doesn't describe), and a newest pass that can't be vouched for leaves
    /// nothing remembered.
    pub fn scanned(&mut self, pass: Pass, stable: bool, stamp: Option<DiskStamp>, manifest: M) {
        if pass.0 != self.begun {
            return;
        }
        self.last = match stamp {
            Some(s) if stable && s.is_sentinel() => Some((s, manifest)),
            _ => None,
        };
    }

    /// Start a pass: the remembered manifest if [`ScanMemo::unchanged`] says the disk still is as
    /// it left it, and forget it either way. A pass in progress has nothing to reuse, so whatever
    /// fails before [`ScanMemo::scanned`] records the new pass (a sentinel set over content the
    /// memo doesn't describe included) leaves nothing a later commit could wrongly reuse.
    pub fn begin(&mut self, stable: bool, stamp: Option<&DiskStamp>) -> (Option<M>, Pass) {
        let reuse = self.unchanged(stable, stamp).is_some();
        let last = self.last.take();
        self.begun += 1;
        (if reuse { last.map(|(_, m)| m) } else { None }, Pass(self.begun))
    }

    /// The remembered manifest, when the disk, read (`stamp`) while nothing can write it
    /// (`stable`), is still exactly as the remembered pass left it.
    pub fn unchanged(&self, stable: bool, stamp: Option<&DiskStamp>) -> Option<&M> {
        match (&self.last, stamp) {
            (Some((was, m)), Some(now)) if stable && was == now => Some(m),
            _ => None,
        }
    }

    /// Forget the remembered pass (the disk was replaced, or nestd can no longer vouch for it).
    pub fn forget(&mut self) {
        self.last = None;
    }

    /// Whether a pass is remembered.
    pub fn remembers(&self) -> bool {
        self.last.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp(mtime: (i64, u32)) -> DiskStamp {
        DiskStamp { dev: 1, ino: 2, size: 3, mtime_sec: mtime.0, mtime_nsec: mtime.1 }
    }

    /// A whole pass: begun, then recorded.
    fn pass<M>(m: &mut ScanMemo<M>, stable: bool, st: Option<DiskStamp>, man: M) {
        let (_, p) = m.begin(stable, None);
        m.scanned(p, stable, st, man);
    }

    #[test]
    fn a_stable_pass_with_the_sentinel_is_reused_while_the_disk_reads_the_same() {
        let mut m = ScanMemo::new();
        let s = stamp(SENTINEL);
        pass(&mut m, true, Some(s), "m1");
        assert!(m.remembers());
        assert_eq!(m.unchanged(true, Some(&s)), Some(&"m1"));
        // Reading doesn't consume it.
        assert_eq!(m.unchanged(true, Some(&s)), Some(&"m1"));
    }

    #[test]
    fn nothing_is_reused_unless_the_disk_is_stable_now() {
        let mut m = ScanMemo::new();
        let s = stamp(SENTINEL);
        pass(&mut m, true, Some(s), "m1");
        assert_eq!(m.unchanged(false, Some(&s)), None);
        assert_eq!(m.unchanged(true, None), None);
    }

    #[test]
    fn any_difference_in_the_stamp_defeats_reuse() {
        let mut m = ScanMemo::new();
        let s = stamp(SENTINEL);
        pass(&mut m, true, Some(s), "m1");
        for other in [
            DiskStamp { dev: 9, ..s },
            DiskStamp { ino: 9, ..s },
            DiskStamp { size: 9, ..s },
            DiskStamp { mtime_sec: 9, ..s },
            DiskStamp { mtime_nsec: 9, ..s },
        ] {
            assert_eq!(m.unchanged(true, Some(&other)), None, "{other:?}");
        }
    }

    #[test]
    fn an_unstable_or_unstamped_pass_forgets_what_was_remembered() {
        let s = stamp(SENTINEL);
        for (stable, st) in [(false, Some(s)), (true, None), (true, Some(stamp((1_800_000_000, 0)))), (true, Some(stamp((SENTINEL.0, 0)))), (true, Some(stamp((0, SENTINEL.1))))] {
            let mut m = ScanMemo::new();
            pass(&mut m, true, Some(s), "m1");
            pass(&mut m, stable, st, "m2");
            assert!(!m.remembers(), "{stable} {st:?}");
            assert_eq!(m.unchanged(true, Some(&s)), None);
            if let Some(st) = st {
                assert_eq!(m.unchanged(true, Some(&st)), None);
            }
        }
    }

    #[test]
    fn forget_forgets_and_a_new_memo_remembers_nothing() {
        let s = stamp(SENTINEL);
        let mut m = ScanMemo::new();
        assert!(!m.remembers());
        assert_eq!(m.unchanged(true, Some(&s)), None);
        pass(&mut m, true, Some(s), "m1");
        m.forget();
        assert!(!m.remembers());
        assert_eq!(m.unchanged(true, Some(&s)), None);
        assert_eq!(ScanMemo::<u8>::default(), ScanMemo::new());
    }

    #[test]
    fn a_pass_begun_forgets_the_memo_whether_or_not_it_reuses() {
        let s = stamp(SENTINEL);
        let mut m = ScanMemo::new();
        pass(&mut m, true, Some(s), "m1");
        assert_eq!(m.begin(true, Some(&s)).0, Some("m1"));
        assert!(!m.remembers(), "a pass in progress has nothing to reuse");
        assert_eq!(m.begin(true, Some(&s)).0, None);
        pass(&mut m, true, Some(s), "m2");
        assert_eq!(m.begin(false, Some(&s)).0, None, "not stable now");
        assert!(!m.remembers());
        pass(&mut m, true, Some(s), "m3");
        assert_eq!(m.begin(true, Some(&stamp((7, 7)))).0, None, "another stamp");
        assert!(!m.remembers());
        pass(&mut m, true, Some(s), "m4");
        assert_eq!(m.begin(true, None).0, None);
        assert!(!m.remembers());
    }

    /// Two cuts' passes overlap: the older one, recorded after the newer began, records nothing,
    /// though its stamp (the sentinel) reads the same as the newer cut's.
    #[test]
    fn only_the_newest_pass_begun_records() {
        let s = stamp(SENTINEL);
        let mut m = ScanMemo::new();
        let (_, old) = m.begin(true, None);
        let (_, new) = m.begin(true, None);
        m.scanned(old, true, Some(s), "older cut");
        assert!(!m.remembers(), "an older pass records nothing");
        m.scanned(new, true, Some(s), "newer cut");
        assert_eq!(m.unchanged(true, Some(&s)), Some(&"newer cut"));
        m.scanned(old, true, Some(s), "older cut");
        assert_eq!(m.unchanged(true, Some(&s)), Some(&"newer cut"), "nor overwrites the newer");
        assert_ne!(old, new);
    }

    #[test]
    fn the_sentinel_is_only_the_sentinel() {
        assert!(stamp(SENTINEL).is_sentinel());
        assert!(!stamp((SENTINEL.0, SENTINEL.1 + 1)).is_sentinel());
        assert!(!stamp((SENTINEL.0 + 1, SENTINEL.1)).is_sentinel());
    }
}

/// Kani harnesses (`cargo kani -p nestd-core --harness <name> --exact`): shipped code over every
/// sequence of three calls with arbitrary stamps.
#[cfg(kani)]
mod proofs {
    use super::*;

    fn any_stamp() -> DiskStamp {
        // Few values per field, so equal stamps are as reachable as different ones.
        DiskStamp {
            dev: kani::any_where(|v: &u64| *v < 2),
            ino: kani::any_where(|v: &u64| *v < 2),
            size: kani::any_where(|v: &u64| *v < 2),
            mtime_sec: kani::any_where(|v: &i64| *v == SENTINEL.0 || *v == 7),
            mtime_nsec: kani::any_where(|v: &u32| *v == SENTINEL.1 || *v == 7),
        }
    }

    fn any_opt_stamp() -> Option<DiskStamp> {
        if kani::any() { Some(any_stamp()) } else { None }
    }

    /// Whatever the history (passes begun, recorded in any order, including passes no longer the
    /// newest, or forgotten), a reused manifest is the one the newest pass begun recorded, from a
    /// stable pass, with exactly the stamp seen now, which is the sentinel; and the disk is stable
    /// now. `begin` reuses exactly what `unchanged` would and leaves nothing behind.
    #[kani::proof]
    #[kani::unwind(5)]
    fn reuse_only_of_the_newest_stable_sentinel_pass_with_the_same_stamp() {
        let mut m: ScanMemo<u8> = ScanMemo::new();
        // Passes begun (up to 2), newest last; and what the newest recorded, if it did.
        let mut passes: [Option<Pass>; 2] = [None, None];
        let mut recorded: Option<(bool, Option<DiskStamp>, u8)> = None;
        for _ in 0..4 {
            match kani::any_where(|c: &u8| *c < 3) {
                0 => {
                    let (stable, now) = (kani::any(), any_opt_stamp());
                    let (_, p) = m.begin(stable, now.as_ref());
                    assert!(!m.remembers(), "a pass begun leaves nothing to reuse");
                    passes = [passes[1], Some(p)];
                    recorded = None;
                }
                1 => {
                    // Record any pass begun so far: the newest, or an older one.
                    let which: bool = kani::any();
                    if let Some(p) = if which { passes[1] } else { passes[0] } {
                        let (stable, stamp, man): (bool, Option<DiskStamp>, u8) = (kani::any(), any_opt_stamp(), kani::any());
                        m.scanned(p, stable, stamp, man);
                        if Some(p) == passes[1] {
                            recorded = Some((stable, stamp, man));
                        }
                    }
                }
                _ => {
                    m.forget();
                    recorded = None;
                }
            }
        }
        let (stable, now) = (kani::any(), any_opt_stamp());
        let peeked = m.unchanged(stable, now.as_ref()).copied();
        if let Some(got) = m.begin(stable, now.as_ref()).0 {
            let (was_stable, was, man) = recorded.expect("a reuse names the newest pass's recording");
            assert!(stable && was_stable);
            assert_eq!(was, now);
            assert!(now.expect("reused against a stamp").is_sentinel());
            assert_eq!(got, man);
            assert_eq!(peeked, Some(man));
        } else {
            assert_eq!(peeked, None);
        }
        assert!(!m.remembers());
    }

    /// Reuse isn't vacuous: right after a stable sentinel pass, the same stamp reuses it.
    #[kani::proof]
    fn a_stable_sentinel_pass_is_reused() {
        let mut m: ScanMemo<u8> = ScanMemo::new();
        let mut s = any_stamp();
        s.mtime_sec = SENTINEL.0;
        s.mtime_nsec = SENTINEL.1;
        let man: u8 = kani::any();
        let (_, p) = m.begin(true, None);
        m.scanned(p, true, Some(s), man);
        assert_eq!(m.unchanged(true, Some(&s)), Some(&man));
    }
}
