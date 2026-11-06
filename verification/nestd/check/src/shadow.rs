//! M3′ option 1's cut (`docs/sandbox/state/disk/`, M3′): nestd's REAL comparison
//! (`nestd_core::shadow::{normalize, changed}`) driven the way `host.rs` drives it, against a model
//! of a copy-on-write filesystem with a guest writing the disk.
//!
//! The filesystem: a few physical blocks, each with a value and a reference count; the disk and the
//! shadow map logical blocks to them (or a hole). A write to a block only the disk references
//! overwrites it in place; a write to a shared block (or a hole) allocates the lowest free block
//! (copy on write), so a freed block's number is soon reused for other bytes. A clone of a range
//! makes the shadow reference the disk's blocks there. A map read (FIEMAP) is a snapshot of the
//! mapping, block numbers only.
//!
//! The cut, as nestd takes it:
//! 1. while the VM runs: read the disk's map and the shadow's, compare them, clone the ranges that
//!    differ one at a time (the guest writing in between), then read the shadow's map again;
//! 2. pause the VM, read the disk's map, compare it with the shadow's map from step 1, clone what
//!    differs, check, resume.
//!
//! Property: when a cut ends, the shadow holds exactly the disk's bytes.
//!
//! Variant, expected to fail: `stale_shadow_map`: step 2 compares the disk's map with the shadow's
//! map from **before** the pre-copy's clones instead of after them. A clone drops the shadow's old
//! block; freed, it can be reused by the disk's next copy on write at the same offset, and then the
//! stale map says "unchanged" where the bytes differ.
//!
//! (Comparing with the disk's own map from step 1, `live_base`, holds here: every block that map
//! names is either shared with the shadow already or cloned into it during the pre-copy, so the
//! shadow holds it and it can't be reused. It is checked too, so an optimization that skips the
//! pre-copy's clones can't keep using it unnoticed.)

use nestd_core::shadow::{Extent, Range, changed, normalize};
use stateright::{Model, Property};

/// Logical blocks in the disk, and physical blocks in the filesystem.
const LOGICAL: usize = 2;
const PHYSICAL: usize = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub max_writes: u8,
    pub max_cuts: u8,
    /// Compare the in-pause map with the disk's map from the pre-copy, not the shadow's.
    pub live_base: bool,
    /// Compare the in-pause map with the shadow's map from before the pre-copy's clones (a bug).
    pub stale_shadow_map: bool,
}

impl Config {
    pub fn fixed() -> Self {
        Config { max_writes: 4, max_cuts: 2, live_base: false, stale_shadow_map: false }
    }
}

type Map = [Option<u8>; LOGICAL];

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    Idle,
    /// The disk's map read while the VM runs.
    DiskRead(Map),
    /// Both maps read; the ranges that differ, to clone.
    Cloning { d0: Map, s0: Map, todo: Vec<Range> },
    /// Pre-copy done: the shadow's map read again.
    PreCopied { d0: Map, s0: Map, s1: Map },
    /// Paused, residue cloned: the check is due.
    Paused,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    value: [u8; PHYSICAL],
    refs: [u8; PHYSICAL],
    disk: Map,
    shadow: Map,
    phase: Phase,
    writes: u8,
    cuts: u8,
    /// A cut ended with the shadow's bytes not the disk's.
    unequal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Write(usize, u8),
    ReadDisk,
    ReadShadowAndCompare,
    CloneNext,
    ReadShadowAgain,
    PauseAndClone,
    CheckAndResume,
}

pub struct ShadowModel {
    pub cfg: Config,
}

fn extents(m: &Map) -> Vec<Extent> {
    normalize(m.iter().enumerate().filter_map(|(l, p)| p.map(|p| Extent { logical: l as u64, physical: u64::from(p), length: 1, flags: 0 })))
}

fn bytes(s: &State, m: &Map) -> [u8; LOGICAL] {
    let mut out = [0; LOGICAL];
    for (l, p) in m.iter().enumerate() {
        out[l] = p.map_or(0, |p| s.value[p as usize]);
    }
    out
}

fn unref(s: &mut State, p: Option<u8>) {
    if let Some(p) = p {
        s.refs[p as usize] -= 1;
    }
}

/// The shadow references the disk's blocks over `r` (a clone of that range).
fn clone_range(s: &mut State, r: Range) {
    for l in r.start as usize..(r.end as usize).min(LOGICAL) {
        let (from, old) = (s.disk[l], s.shadow[l]);
        if let Some(p) = from {
            s.refs[p as usize] += 1;
        }
        unref(s, old);
        s.shadow[l] = from;
    }
}

impl Model for ShadowModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        // A disk of two blocks, its shadow a clone of it (both reference both blocks).
        let mut s = State { value: [0; PHYSICAL], refs: [0; PHYSICAL], disk: [Some(0), Some(1)], shadow: [Some(0), Some(1)], phase: Phase::Idle, writes: 0, cuts: 0, unequal: false };
        s.value[0] = 1;
        s.value[1] = 2;
        s.refs[0] = 2;
        s.refs[1] = 2;
        vec![s]
    }

    fn actions(&self, s: &State, out: &mut Vec<Action>) {
        // The guest writes whenever the VM runs (everywhere but the pause).
        if s.writes < self.cfg.max_writes && s.phase != Phase::Paused {
            for l in 0..LOGICAL {
                for v in [3u8, 4] {
                    out.push(Action::Write(l, v));
                }
            }
        }
        match &s.phase {
            Phase::Idle if s.cuts < self.cfg.max_cuts => out.push(Action::ReadDisk),
            Phase::Idle => {}
            Phase::DiskRead(_) => out.push(Action::ReadShadowAndCompare),
            Phase::Cloning { todo, .. } if !todo.is_empty() => out.push(Action::CloneNext),
            Phase::Cloning { .. } => out.push(Action::ReadShadowAgain),
            Phase::PreCopied { .. } => out.push(Action::PauseAndClone),
            Phase::Paused => out.push(Action::CheckAndResume),
        }
    }

    fn next_state(&self, s: &State, a: Action) -> Option<State> {
        let mut n = s.clone();
        match a {
            Action::Write(l, v) => {
                n.writes += 1;
                match n.disk[l] {
                    // Only the disk references it: overwritten in place.
                    Some(p) if n.refs[p as usize] == 1 => n.value[p as usize] = v,
                    old => {
                        // Copy on write (or a write into a hole): the lowest free block.
                        let q = (0..PHYSICAL).find(|&q| n.refs[q] == 0)? as u8;
                        n.value[q as usize] = v;
                        n.refs[q as usize] = 1;
                        unref(&mut n, old);
                        n.disk[l] = Some(q);
                    }
                }
            }
            Action::ReadDisk => n.phase = Phase::DiskRead(n.disk),
            Action::ReadShadowAndCompare => {
                let Phase::DiskRead(d0) = n.phase else { return None };
                let s0 = n.shadow;
                let todo = changed(&extents(&d0), &extents(&s0));
                n.phase = Phase::Cloning { d0, s0, todo };
            }
            Action::CloneNext => {
                let Phase::Cloning { d0, s0, mut todo } = n.phase.clone() else { return None };
                let r = todo.remove(0);
                clone_range(&mut n, r);
                n.phase = Phase::Cloning { d0, s0, todo };
            }
            Action::ReadShadowAgain => {
                let Phase::Cloning { d0, s0, .. } = n.phase.clone() else { return None };
                n.phase = Phase::PreCopied { d0, s0, s1: n.shadow };
            }
            Action::PauseAndClone => {
                let Phase::PreCopied { d0, s0, s1 } = n.phase.clone() else { return None };
                let base = if self.cfg.stale_shadow_map { s0 } else if self.cfg.live_base { d0 } else { s1 };
                for r in changed(&extents(&n.disk), &extents(&base)) {
                    clone_range(&mut n, r);
                }
                n.phase = Phase::Paused;
            }
            Action::CheckAndResume => {
                if bytes(&n, &n.shadow) != bytes(&n, &n.disk) {
                    n.unequal = true;
                }
                n.cuts += 1;
                n.phase = Phase::Idle;
            }
        }
        Some(n)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always("a_cut_leaves_the_shadow_equal_to_the_disk", |_, s: &State| !s.unequal),
            Property::sometimes("a_cut_cloned_what_a_write_changed_during_the_pre_copy", |_, s: &State| s.cuts >= 1 && s.writes >= 2),
        ]
    }
}
