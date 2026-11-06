//! M3′ option 1's two shadows (`docs/sandbox/state/disk/`, M3′): nestd's REAL slot choice
//! (`nestd_core::shadow::Shadows`) driven the way `host.rs` drives it, with commits that take a
//! queued cut and read its shadow later, the sandbox unlocked.
//!
//! A shadow's content is abstract: the disk generation a finished cut left in it, or torn (a cut's
//! pre-copy or pause has started writing it and not finished). The disk's generation moves with
//! every guest write.
//!
//! The host, as `host.rs` is:
//! - a cut (with the sandbox locked throughout) asks `target()`; with no shadow free it drops the
//!   queued cut (releasing its shadow) and asks again; its pre-copy and pause write the shadow
//!   (torn), and then it either fails (`cut_failed`) or ends: the shadow holds the disk, the cut is
//!   queued (`cut`), replacing any queued one (released);
//! - a commit takes the queued cut (one commit at a time, with the lock) and, later, ends: it has
//!   read the shadow, failed or been fenced, and releases it;
//! - a suspend, archive or salvage drops the queued cut.
//!
//! Property: a shadow a queued or taken cut names holds exactly that cut's generation, in every
//! state (a commit reads it at any moment while it holds it).
//!
//! Variant, expected to fail: `unheld_queue`: a queued cut's shadow isn't held (as #159 first had
//! it: only the commit's read held it, after its re-ask), so a newer cut can write it.

use nestd_core::shadow::{Shadows, Slot};
use stateright::{Model, Property};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub max_writes: u8,
    pub max_cuts: u8,
    pub unheld_queue: bool,
}

impl Config {
    pub fn fixed() -> Self {
        Config { max_writes: 3, max_cuts: 5, unheld_queue: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Content {
    Missing,
    Torn,
    Gen(u8),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    disk: u8,
    slots: [Content; 2],
    shadows: Shadows,
    /// A cut writing this shadow (its pre-copy or pause), the sandbox locked.
    cutting: Option<Slot>,
    queued: Option<(Slot, u8)>,
    taken: Option<(Slot, u8)>,
    writes: u8,
    cuts: u8,
    /// A cut found both shadows held and dropped the queued cut.
    dropped_for_room: bool,
    /// A cut failed after writing its shadow while another cut was queued.
    failed_beside_a_queued_cut: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Write,
    CutBegins,
    CutFails,
    CutEnds,
    CommitTakes,
    CommitEnds,
    DropQueued,
}

pub struct SlotsModel {
    pub cfg: Config,
}

fn i(s: Slot) -> usize {
    match s {
        Slot::A => 0,
        Slot::B => 1,
    }
}

impl Model for SlotsModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        vec![State {
            disk: 0,
            slots: [Content::Missing; 2],
            shadows: Shadows::new(),
            cutting: None,
            queued: None,
            taken: None,
            writes: 0,
            cuts: 0,
            dropped_for_room: false,
            failed_beside_a_queued_cut: false,
        }]
    }

    fn actions(&self, s: &State, out: &mut Vec<Action>) {
        if s.writes < self.cfg.max_writes {
            out.push(Action::Write);
        }
        match s.cutting {
            Some(_) => out.extend([Action::CutFails, Action::CutEnds]),
            None => {
                if s.cuts < self.cfg.max_cuts {
                    out.push(Action::CutBegins);
                }
                if s.taken.is_none() && s.queued.is_some() {
                    out.push(Action::CommitTakes);
                }
                if s.taken.is_some() {
                    out.push(Action::CommitEnds);
                }
                if s.queued.is_some() {
                    out.push(Action::DropQueued);
                }
            }
        }
    }

    fn next_state(&self, s: &State, a: Action) -> Option<State> {
        let mut n = s.clone();
        match a {
            Action::Write => {
                n.writes += 1;
                n.disk += 1;
            }
            Action::CutBegins => {
                n.cuts += 1;
                let slot = match n.shadows.target() {
                    Some(t) => t,
                    None => {
                        let (q, _) = n.queued.take()?;
                        n.shadows.release(q);
                        n.dropped_for_room = true;
                        n.shadows.target()?
                    }
                };
                n.slots[i(slot)] = Content::Torn;
                n.cutting = Some(slot);
            }
            Action::CutFails => {
                let slot = n.cutting.take()?;
                n.shadows.cut_failed(slot);
                if n.queued.is_some() {
                    n.failed_beside_a_queued_cut = true;
                }
            }
            Action::CutEnds => {
                let slot = n.cutting.take()?;
                n.slots[i(slot)] = Content::Gen(n.disk);
                if let Some((q, _)) = n.queued.take() {
                    n.shadows.release(q);
                }
                n.shadows.cut(slot);
                if self.cfg.unheld_queue {
                    n.shadows.release(slot);
                }
                n.queued = Some((slot, n.disk));
            }
            Action::CommitTakes => n.taken = n.queued.take(),
            Action::CommitEnds => {
                let (t, _) = n.taken.take()?;
                n.shadows.release(t);
            }
            Action::DropQueued => {
                let (q, _) = n.queued.take()?;
                n.shadows.release(q);
            }
        }
        Some(n)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always("a_named_shadow_holds_its_cut", |_, s: &State| [s.queued, s.taken].into_iter().flatten().all(|(slot, g)| s.slots[i(slot)] == Content::Gen(g))),
            Property::sometimes("a_cut_dropped_the_queued_cut_for_room", |_, s: &State| s.dropped_for_room),
            Property::sometimes("a_cut_failed_beside_a_queued_cut", |_, s: &State| s.failed_beside_a_queued_cut),
        ]
    }
}
