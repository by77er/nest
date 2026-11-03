//! The unchanged-disk short-circuit: nestd's REAL memo (`nestd_core::checkpoint::ScanMemo`)
//! driven the way `host.rs` drives it, against a disk file written by a VM, with both kinds of
//! commit nestd makes:
//! - **a read** (`Inner::scan`, M1, and every suspend, archive or salvage): with the VM paused or
//!   gone, take the memo (`begin`) and reuse or read the disk; then, as separate steps, set the
//!   sentinel and record the pass. A pass may fail after its read or after its sentinel, recording
//!   nothing (a memory snapshot that can't be read, in a suspend that then rolls back).
//! - **a cut** (`Inner::cut_checkpoint`, M2): in one pause, take the memo, reuse or clone the disk,
//!   and set the sentinel; the VM may resume at once. The cut is read and recorded later, in the
//!   background (`Inner::commit_cut`), by which time the guest may have written and newer cuts may
//!   have been taken. Cuts queue one deep behind the one in flight (a newer one replaces the
//!   queued one) and commit in order; a read drops the queued cut and waits for the one in flight.
//!
//! The disk is two chunks of one bit each, with a modification time that every write moves to the
//! current time (a tick of an abstract clock) and that nestd sets to the sentinel. The VM runs, is
//! paused, or is gone (after a nestd restart, which also forgets the memo and every cut).
//!
//! Property: a reused manifest is the disk's content at that moment.
//!
//! Variants, each a way the shell could get it wrong, and each expected to fail:
//! - `async_engine`: a write whose time moved at submission can land after the VM is paused (as
//!   Firecracker's `Async` io_engine allows), between the read and the sentinel.
//! - `trust_running`: the shell calls the memo `stable` while the VM runs.
//! - `keep_on_begin`: a read peeks at the memo (`unchanged`) and takes it only to record, so a pass
//!   that fails after its sentinel leaves the previous pass's memo, whose stamp the sentinel matches
//!   again (the bug the review of #122 found).
//! - `stale_records`: a cut is recorded under the newest pass begun instead of its own, so an older
//!   cut, read in the background after a newer cut set the same sentinel, records its manifest over
//!   content it doesn't describe (why M2 gave the memo passes).

use nestd_core::checkpoint::{DiskStamp, Pass, SENTINEL, ScanMemo};
use stateright::{Model, Property};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub max_writes: u8,
    /// Reads and cuts together.
    pub max_commits: u8,
    pub max_restarts: u8,
    /// Writes may land after their time moved, even while paused.
    pub async_engine: bool,
    /// The shell passes `stable` for a running VM too (a bug).
    pub trust_running: bool,
    /// A read peeks at the memo instead of taking it (a bug).
    pub keep_on_begin: bool,
    /// A cut records under the newest pass, not its own (a bug).
    pub stale_records: bool,
}

impl Config {
    pub fn fixed() -> Self {
        Config { max_writes: 4, max_commits: 4, max_restarts: 1, async_engine: false, trust_running: false, keep_on_begin: false, stale_records: false }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Vm {
    Running,
    Paused,
    /// Killed with a restarted nestd: nothing writes the disk again.
    Gone,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mtime {
    Sentinel,
    At(u8),
}

/// A cut waiting for its background read: (the disk as cut, its pass, the stamp read after its
/// sentinel).
type Cut = ([bool; 2], Pass, DiskStamp);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    disk: [bool; 2],
    mtime: Mtime,
    clock: u8,
    vm: Vm,
    /// A write submitted (its time moved) whose data hasn't landed (`async_engine` only).
    inflight: Option<(usize, bool)>,
    memo: ScanMemo<[bool; 2]>,
    /// A read in progress: (manifest, its pass, stable, sentinel set). `None` pass: `keep_on_begin`.
    read: Option<([bool; 2], Option<Pass>, bool, bool)>,
    /// The cut in flight, then the one queued.
    cuts: Vec<Cut>,
    /// The newest pass begun (what `stale_records` records under).
    newest: Option<Pass>,
    writes: u8,
    commits: u8,
    restarts: u8,
    /// A reused manifest differed from the disk.
    wrong: bool,
    reused: bool,
    /// A cut was recorded after a newer one was taken (the case passes exist for).
    overlapped: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Write(usize, bool),
    Land,
    Pause,
    Resume,
    /// A read: take the memo; reuse, or read the disk.
    Read,
    /// The read's sentinel.
    Sentinel,
    /// Record the read.
    Record,
    /// The read fails: nothing recorded.
    Fail,
    /// A cut, in one pause: take the memo, reuse or clone, set the sentinel.
    Cut,
    /// The cut in flight is read and recorded.
    RecordCut,
    /// The cut in flight fails (its read or its commit): nothing recorded.
    FailCut,
    Restart,
}

pub struct SentinelModel {
    pub cfg: Config,
}

fn stamp(m: Mtime) -> DiskStamp {
    let (mtime_sec, mtime_nsec) = match m {
        Mtime::Sentinel => SENTINEL,
        Mtime::At(t) => (1_000_000_000 + i64::from(t), 0),
    };
    DiskStamp { dev: 1, ino: 1, size: 2, mtime_sec, mtime_nsec }
}

/// What a commit reuses, if anything; flags a wrong reuse.
fn reuse(n: &mut State, reused: Option<[bool; 2]>) -> [bool; 2] {
    match reused {
        Some(m) => {
            n.reused = true;
            if m != n.disk {
                n.wrong = true;
            }
            m
        }
        None => n.disk,
    }
}

impl Model for SentinelModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        vec![State {
            disk: [false, false],
            mtime: Mtime::At(0),
            clock: 0,
            vm: Vm::Running,
            inflight: None,
            memo: ScanMemo::new(),
            read: None,
            cuts: vec![],
            newest: None,
            writes: 0,
            commits: 0,
            restarts: 0,
            wrong: false,
            reused: false,
            overlapped: false,
        }]
    }

    fn actions(&self, s: &State, out: &mut Vec<Action>) {
        if s.vm == Vm::Running && s.writes < self.cfg.max_writes && s.inflight.is_none() {
            for i in 0..2 {
                out.push(Action::Write(i, !s.disk[i]));
            }
        }
        if s.inflight.is_some() {
            out.push(Action::Land);
        }
        if s.read.is_none() {
            match s.vm {
                Vm::Running => out.push(Action::Pause),
                Vm::Paused => out.push(Action::Resume),
                Vm::Gone => {}
            }
        }
        let may_commit = s.vm != Vm::Running || self.cfg.trust_running;
        // A read waits for the cut in flight (its queued one is dropped when the read begins).
        if s.read.is_none() && s.cuts.len() <= 1 && may_commit && s.commits < self.cfg.max_commits {
            out.push(Action::Read);
        }
        // A cut is taken with the VM paused (a checkpoint of a running VM).
        if s.read.is_none() && s.vm == Vm::Paused && s.commits < self.cfg.max_commits {
            out.push(Action::Cut);
        }
        if let Some((_, _, _, sentinel)) = s.read {
            out.push(if sentinel { Action::Record } else { Action::Sentinel });
            out.push(Action::Fail);
        }
        if !s.cuts.is_empty() {
            out.push(Action::RecordCut);
            out.push(Action::FailCut);
        }
        if s.restarts < self.cfg.max_restarts {
            out.push(Action::Restart);
        }
    }

    fn next_state(&self, s: &State, a: Action) -> Option<State> {
        let mut n = s.clone();
        match a {
            Action::Write(i, v) => {
                n.clock += 1;
                n.mtime = Mtime::At(n.clock);
                n.writes += 1;
                if self.cfg.async_engine {
                    n.inflight = Some((i, v));
                } else {
                    n.disk[i] = v;
                }
            }
            Action::Land => {
                let (i, v) = n.inflight.take().expect("enabled");
                n.disk[i] = v;
            }
            Action::Pause => n.vm = Vm::Paused,
            Action::Resume => n.vm = Vm::Running,
            Action::Read => {
                // `Inner::scan`: the queued cut is dropped; what the shell calls stable, then the
                // memo's answer.
                n.cuts.truncate(1);
                let stable = s.vm != Vm::Running || self.cfg.trust_running;
                n.commits += 1;
                let now = stamp(s.mtime);
                let (reused, pass) = if self.cfg.keep_on_begin {
                    (n.memo.unchanged(stable, Some(&now)).copied(), None)
                } else {
                    let (r, p) = n.memo.begin(stable, Some(&now));
                    n.newest = Some(p);
                    (r, Some(p))
                };
                let manifest = reuse(&mut n, reused);
                n.read = Some((manifest, pass, stable, false));
            }
            Action::Sentinel => {
                n.mtime = Mtime::Sentinel;
                n.read.as_mut().expect("enabled").3 = true;
            }
            Action::Record => {
                let (manifest, pass, stable, _) = n.read.take().expect("enabled");
                let pass = match pass {
                    Some(p) => p,
                    // `keep_on_begin`: the memo is taken only now.
                    None => {
                        let p = n.memo.begin(stable, None).1;
                        n.newest = Some(p);
                        p
                    }
                };
                n.memo.scanned(pass, stable, Some(stamp(n.mtime)), manifest);
            }
            Action::Fail => n.read = None,
            Action::Cut => {
                // `Inner::cut_checkpoint`, in its pause: the stamp, the memo, the clone (or reuse),
                // then the sentinel. A newer cut replaces the queued one.
                n.commits += 1;
                let now = stamp(s.mtime);
                let (reused, pass) = n.memo.begin(true, Some(&now));
                n.newest = Some(pass);
                let manifest = reuse(&mut n, reused);
                n.mtime = Mtime::Sentinel;
                let cut = (manifest, pass, stamp(n.mtime));
                if n.cuts.len() == 2 {
                    n.cuts[1] = cut;
                } else {
                    n.cuts.push(cut);
                }
            }
            Action::RecordCut => {
                // `Inner::commit_cut`: the cut in flight, read in the background.
                let (manifest, pass, at) = n.cuts.remove(0);
                let pass = if self.cfg.stale_records { n.newest.expect("a cut began a pass") } else { pass };
                if Some(pass) != n.newest || !n.cuts.is_empty() {
                    n.overlapped = true;
                }
                n.memo.scanned(pass, true, Some(at), manifest);
            }
            Action::FailCut => {
                n.cuts.remove(0);
            }
            Action::Restart => {
                // The restart kills the VM; the new nestd's memo is empty and its cuts are gone
                // (`recovery::scan` removes the files). A write in flight is lost with the VMM or
                // lands; either way nothing writes after.
                n.restarts += 1;
                n.vm = Vm::Gone;
                n.memo = ScanMemo::new();
                n.read = None;
                n.cuts.clear();
                n.newest = None;
            }
        }
        Some(n)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::<Self>::always("a_reused_manifest_is_the_disk", |_, s| !s.wrong),
            Property::<Self>::sometimes("a_commit_reused_a_manifest", |_, s| s.reused),
            Property::<Self>::sometimes("a_cut_was_recorded_behind_a_newer_one", |_, s| s.overlapped),
        ]
    }
}

pub const SAFETY: &str = "a_reused_manifest_is_the_disk";
pub const REUSED: &str = "a_commit_reused_a_manifest";
pub const OVERLAPPED: &str = "a_cut_was_recorded_behind_a_newer_one";
