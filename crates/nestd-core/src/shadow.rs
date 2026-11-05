//! M3′ option 1: a cut that copies only what changed (`docs/sandbox/state/disk/`, M3′).
//!
//! Each incarnation keeps two shadow files beside its disk. A cut makes one of them equal to the
//! disk while the VM is paused, by cloning (`FICLONERANGE`) only the ranges whose extent mapping
//! differs between the disk and that shadow. The background commit then reads the shadow, and the
//! next cut writes the other one, so a shadow being read is never written.
//!
//! Why comparing mappings is sound (checked by `verification/nestd/check`, `shadow`):
//! - A shadow is written only by nestd's clones. So the blocks its map names stay referenced, and no
//!   other file can be given them while it holds them.
//! - When the disk maps an offset to the same physical block as the shadow does, that block is
//!   shared. XFS never overwrites a shared block in place: a write to it goes to a new block (copy on
//!   write). So the two files hold the same bytes there.
//! - So the cut compares the disk's map with the shadow's map **as it is now**, read after the
//!   shadow's last change. A map of the shadow read before a clone is stale: the clone dropped the
//!   blocks it named there, and a freed block is soon reused, so the disk can map the very same
//!   number again with other bytes. The model finds that counterexample in 8 steps.
//! - Where the maps differ, the range is cloned, and the shadow then maps the disk's blocks there.
//!   What the comparison can't vouch for (a delayed allocation, an extent of unknown placement or
//!   encoded data) counts as changed.
//! - An unwritten (preallocated) extent reads as zeros, as a hole does, and a clone maps it as a
//!   hole, so both count as holes. Otherwise every cut would clone them again.
//! - Every read of a map is taken after the disk's dirty pages are written back (`fdatasync`): a
//!   buffered write's block isn't allocated until then.
//!
//! Plain values only: nestd walks the maps (`FS_IOC_FIEMAP`), clones the ranges and passes what it
//! read in.

use alloc::vec::Vec;

/// `FIEMAP_EXTENT_*` flags (linux/fiemap.h) the comparison reads.
pub mod flags {
    pub const LAST: u32 = 0x0001;
    pub const UNKNOWN: u32 = 0x0002;
    pub const DELALLOC: u32 = 0x0004;
    pub const ENCODED: u32 = 0x0008;
    pub const DATA_ENCRYPTED: u32 = 0x0080;
    pub const NOT_ALIGNED: u32 = 0x0100;
    pub const DATA_INLINE: u32 = 0x0200;
    pub const DATA_TAIL: u32 = 0x0400;
    pub const UNWRITTEN: u32 = 0x0800;
    pub const MERGED: u32 = 0x1000;
    pub const SHARED: u32 = 0x2000;
}

/// One extent as FIEMAP reports it: byte offsets and length, and its flags.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Extent {
    pub logical: u64,
    pub physical: u64,
    pub length: u64,
    pub flags: u32,
}

/// A logical byte range `[start, end)` to clone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Range {
    pub start: u64,
    pub end: u64,
}

/// Flags that say nothing about which bytes an extent holds.
const IGNORED: u32 = flags::LAST | flags::SHARED | flags::MERGED;
/// Flags under which the mapping can't vouch for the bytes: such an extent always counts as changed.
const UNTRUSTED: u32 = flags::UNKNOWN | flags::DELALLOC | flags::ENCODED | flags::DATA_ENCRYPTED | flags::NOT_ALIGNED | flags::DATA_INLINE | flags::DATA_TAIL;

/// A map as the comparison reads it: unwritten extents dropped (holes), the flags that say nothing
/// about the bytes cleared, in logical order.
pub fn normalize(raw: impl IntoIterator<Item = Extent>) -> Vec<Extent> {
    let mut out: Vec<Extent> = raw
        .into_iter()
        .filter(|e| e.flags & flags::UNWRITTEN == 0 && e.length > 0)
        .map(|e| Extent { flags: e.flags & !IGNORED, ..e })
        .collect();
    out.sort_by_key(|e| e.logical);
    out
}

fn trusted_same(a: &Extent, b: &Extent) -> bool {
    a == b && a.flags & UNTRUSTED == 0
}

fn push(out: &mut Vec<Range>, start: u64, end: u64) {
    if let Some(last) = out.last_mut()
        && start <= last.end
    {
        if end > last.end {
            last.end = end;
        }
        return;
    }
    out.push(Range { start, end });
}

/// The logical ranges where the `disk`'s and the `shadow`'s normalized maps differ, merged and in
/// order. An extent is unchanged only where the other map has the very same extent (offset, block,
/// length, flags) and nothing about it is untrusted. Extents split differently in the two maps count
/// as changed: that clones some bytes again, never fewer.
pub fn changed(disk: &[Extent], shadow: &[Extent]) -> Vec<Range> {
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    while i < disk.len() || j < shadow.len() {
        match (disk.get(i), shadow.get(j)) {
            (Some(x), Some(y)) if trusted_same(x, y) => {
                i += 1;
                j += 1;
            }
            (Some(x), Some(y)) if y.logical < x.logical => {
                push(&mut out, y.logical, y.logical + y.length);
                j += 1;
            }
            (Some(x), y) => {
                push(&mut out, x.logical, x.logical + x.length);
                if let Some(y) = y
                    && y.logical == x.logical
                {
                    push(&mut out, y.logical, y.logical + y.length);
                    j += 1;
                }
                i += 1;
            }
            (None, Some(y)) => {
                push(&mut out, y.logical, y.logical + y.length);
                j += 1;
            }
            (None, None) => break,
        }
    }
    out
}

/// One of an incarnation's two shadow files.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Slot {
    A,
    B,
}

impl Slot {
    pub fn other(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B => Slot::A,
        }
    }
}

/// Which shadow a cut writes, for one incarnation.
///
/// A shadow is **held** from the moment a cut into it is queued until its commit is done with it
/// (read, failed, or dropped): a queued cut, and one a commit has taken, both name their shadow and
/// will read it later, so nothing may write it meanwhile (#159's review: a commit re-asking an
/// earlier request, the sandbox unlocked, read a newer cut written into its shadow). Cuts alternate
/// between the two shadows, so each one is at most two cuts behind the disk and pins only what the
/// disk rewrote since then.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Shadows {
    /// The shadow the newest cut left equal to the disk, if a cut has been taken.
    last: Option<Slot>,
    /// Which shadows a queued or taken cut names.
    held: [bool; 2],
}

fn idx(s: Slot) -> usize {
    match s {
        Slot::A => 0,
        Slot::B => 1,
    }
}

impl Shadows {
    pub fn new() -> Self {
        Self::default()
    }

    /// The shadow the next cut writes: the one the newest cut didn't (they alternate), or failing
    /// that the newest, whichever no cut holds. `None` when both are held (one cut queued, one taken
    /// by its commit): the caller drops the queued cut, which releases its shadow, and asks again.
    pub fn target(&self) -> Option<Slot> {
        let prefer = self.last.map_or(Slot::A, Slot::other);
        [prefer, prefer.other()].into_iter().find(|s| !self.held[idx(*s)])
    }

    /// A cut left `slot` equal to the disk and is queued: `slot` is held until [`Self::release`].
    pub fn cut(&mut self, slot: Slot) {
        debug_assert!(!self.held[idx(slot)], "a cut never writes a held shadow");
        self.held[idx(slot)] = true;
        self.last = Some(slot);
    }

    /// A cut into `slot` failed part way (it wasn't held, so no commit names it): its content is
    /// unknown, but its map still says what it holds, so the next comparison stays sound. (A shadow
    /// file that doesn't exist yet is made by the cut that targets it: the caller checks the file.)
    pub fn cut_failed(&mut self, slot: Slot) {
        if self.last == Some(slot) {
            self.last = None;
        }
    }

    /// The cut naming `slot` is done with it: committed, failed, or dropped.
    pub fn release(&mut self, slot: Slot) {
        self.held[idx(slot)] = false;
    }

    pub fn held(&self, slot: Slot) -> bool {
        self.held[idx(slot)]
    }

    pub fn last(&self) -> Option<Slot> {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(logical: u64, physical: u64, length: u64) -> Extent {
        Extent { logical, physical, length, flags: 0 }
    }

    #[test]
    fn equal_maps_differ_nowhere() {
        let m = [e(0, 100, 10), e(10, 200, 10)];
        assert!(changed(&m, &m).is_empty());
    }

    #[test]
    fn a_moved_block_a_split_and_a_missing_extent_all_count() {
        // The disk's second extent moved (copy on write); the shadow has one the disk lacks (a hole
        // on the disk); and the first is split differently but the same blocks.
        let disk = [e(0, 100, 5), e(5, 105, 5), e(10, 999, 10)];
        let shadow = [e(0, 100, 10), e(10, 200, 10), e(40, 400, 8)];
        assert_eq!(changed(&disk, &shadow), [Range { start: 0, end: 20 }, Range { start: 40, end: 48 }]);
    }

    #[test]
    fn unwritten_is_a_hole_and_last_or_shared_say_nothing() {
        let raw = [
            Extent { logical: 0, physical: 1, length: 4, flags: flags::SHARED },
            Extent { logical: 4, physical: 9, length: 4, flags: flags::UNWRITTEN },
            Extent { logical: 8, physical: 5, length: 4, flags: flags::LAST },
        ];
        assert_eq!(normalize(raw), [e(0, 1, 4), e(8, 5, 4)]);
        assert!(changed(&normalize(raw), &[e(0, 1, 4), e(8, 5, 4)]).is_empty());
    }

    #[test]
    fn an_untrusted_extent_always_counts() {
        let d = Extent { logical: 0, physical: 0, length: 4096, flags: flags::DELALLOC };
        assert_eq!(changed(&[d], &[d]), [Range { start: 0, end: 4096 }]);
    }

    #[test]
    fn cuts_alternate_and_never_write_a_held_shadow() {
        let mut s = Shadows::new();
        assert_eq!(s.target(), Some(Slot::A));
        s.cut(Slot::A); // queued: A held
        assert_eq!(s.target(), Some(Slot::B));
        // The commit takes cut A and waits (A still held); a newer cut goes to B.
        s.cut(Slot::B);
        // Both held (A taken, B queued): no target until the queued cut is dropped.
        assert_eq!(s.target(), None);
        s.release(Slot::B); // the queued cut is dropped for a newer one
        assert_eq!(s.target(), Some(Slot::B));
        s.release(Slot::A); // A's commit is done
        s.cut(Slot::B);
        assert_eq!(s.target(), Some(Slot::A), "they alternate");
        s.cut_failed(Slot::B);
        s.release(Slot::B);
        assert_eq!(s.target(), Some(Slot::A), "with no newest, A");
    }

    /// Exhaustive over a small domain, in place of a Kani harness (CBMC on the growing `Vec` ran
    /// past 40 minutes and 20 GB): every pair of two-extent maps over offsets 0..8, each extent 1 or
    /// 2 blocks on one of four physical blocks, trusted or not, the first at 0 (or 1 for the shadow)
    /// and the second right after or a block later. `changed` covers every offset where they name
    /// different blocks or one is untrusted.
    #[test]
    fn exhaustive_changed_covers_every_differing_offset() {
        let mut all = Vec::new();
        for len in [1u64, 2] {
            for physical in 0..4u64 {
                for f in [0, flags::DELALLOC] {
                    all.push((len, physical, f));
                }
            }
        }
        let maps = |starts: &[u64]| {
            let mut out = Vec::new();
            for &s0 in starts {
                for &(l0, p0, f0) in &all {
                    for gap in [0u64, 1] {
                        for &(l1, p1, f1) in &all {
                            let a0 = Extent { logical: s0, physical: p0, length: l0, flags: f0 };
                            let a1 = Extent { logical: s0 + l0 + gap, physical: p1, length: l1, flags: f1 };
                            out.push([a0, a1]);
                        }
                    }
                }
            }
            out
        };
        let (disks, shadows) = (maps(&[0]), maps(&[0, 1]));
        let block = |m: &[Extent; 2], o: u64| m.iter().find(|x| x.logical <= o && o < x.logical + x.length).map(|x| (x.physical + (o - x.logical), x.flags));
        let mut pairs = 0u64;
        for a in &disks {
            for b in &shadows {
                let r = changed(a, b);
                for o in 0..8 {
                    let (x, y) = (block(a, o), block(b, o));
                    if x != y || x.is_some_and(|x| x.1 & UNTRUSTED != 0) {
                        assert!(r.iter().any(|g| g.start <= o && o < g.end), "offset {o}: {a:?} {b:?} {r:?}");
                    }
                }
                pairs += 1;
            }
        }
        assert_eq!(pairs, 512 * 1024);
    }

    /// Property, over small random maps: `changed` covers every offset where the two maps name
    /// different blocks (or either is untrusted), and only offsets one of them maps.
    #[test]
    fn property_changed_covers_every_differing_offset() {
        let mut seed = 7u64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..2000 {
            let make = |next: &mut dyn FnMut() -> u64| {
                let mut m = Vec::new();
                let mut at = 0;
                while at < 64 {
                    at += next() % 4;
                    let len = 1 + next() % 6;
                    if at + len > 64 {
                        break;
                    }
                    let flags = if next().is_multiple_of(9) { flags::DELALLOC } else { 0 };
                    m.push(Extent { logical: at, physical: 1000 + (next() % 8) * 8 + at % 3, length: len, flags });
                    at += len;
                }
                m
            };
            let a = make(&mut next);
            let b = make(&mut next);
            let r = changed(&a, &b);
            let block = |m: &[Extent], o: u64| m.iter().find(|x| x.logical <= o && o < x.logical + x.length).map(|x| (x.physical + (o - x.logical), x.flags));
            for o in 0..64 {
                let (x, y) = (block(&a, o), block(&b, o));
                let differs = x != y || x.is_some_and(|x| x.1 & UNTRUSTED != 0);
                let covered = r.iter().any(|g| g.start <= o && o < g.end);
                if differs {
                    assert!(covered, "offset {o} differs but isn't cloned: {a:?} {b:?} {r:?}");
                }
                if covered {
                    assert!(x.is_some() || y.is_some(), "offset {o} is a hole in both but cloned");
                }
            }
            for w in r.windows(2) {
                assert!(w[0].end < w[1].start, "ranges merged and in order: {r:?}");
            }
        }
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// Driven as `host.rs` drives it (a cut queues, replacing a queued one; a commit takes the queued
    /// cut, reads its shadow later, then releases it; cuts fail), over any six
    /// steps: a shadow a queued or taken cut names is always held, and never a cut's target.
    #[kani::proof]
    #[kani::unwind(8)]
    fn a_cut_never_targets_a_shadow_a_queued_or_taken_cut_names() {
        let mut s = Shadows::new();
        let mut queued: Option<Slot> = None;
        let mut taken: Option<Slot> = None;
        for _ in 0..6 {
            match kani::any::<u8>() % 4 {
                // A cut: if both shadows are held, the queued cut is dropped first (its shadow
                // released); the newer cut replaces any queued one.
                0 => {
                    if s.target().is_none() {
                        if let Some(q) = queued.take() {
                            s.release(q);
                        }
                    }
                    // A cut always finds a shadow (one commit takes at most one).
                    let t = s.target().expect("a free shadow");
                    assert!(Some(t) != queued && Some(t) != taken);
                    if kani::any() {
                        s.cut_failed(t);
                    } else {
                        if let Some(q) = queued.take() {
                            s.release(q);
                        }
                        s.cut(t);
                        queued = Some(t);
                    }
                }
                // The commit takes the queued cut (one commit at a time).
                1 => {
                    if taken.is_none() {
                        taken = queued.take();
                    }
                }
                // The taken cut's commit ends (read, failed, fenced).
                2 => {
                    if let Some(t) = taken.take() {
                        s.release(t);
                    }
                }
                // The queued cut is dropped (a suspend, an archive, a salvage).
                _ => {
                    if let Some(q) = queued.take() {
                        s.release(q);
                    }
                }
            }
            for r in [queued, taken].into_iter().flatten() {
                assert!(s.held(r));
                assert!(s.target() != Some(r));
            }
        }
    }
}
