//! The unchanged-disk short-circuit: nestd's REAL memo (`nestd_core::checkpoint::ScanMemo`)
//! driven the way `host.rs` drives it (`Inner::scan`), against a disk file written by a VM.
//!
//! The disk is two chunks of one bit each, with a modification time that every write moves to the
//! current time (a tick of an abstract clock) and that nestd sets to the sentinel after a pass. The
//! VM runs, is paused, or is gone (after a nestd restart, which also forgets the memo). A commit,
//! while the VM is paused or gone, reads the file's stamp and either reuses the memo's manifest or
//! reads the disk; then, as a separate step, sets the sentinel and records the pass.
//!
//! Property: a reused manifest is the disk's content at that moment.
//!
//! Variants, each a way the shell could get it wrong, and each expected to fail:
//! - `async_engine`: a write whose time moved at submission can land after the VM is paused (as
//!   Firecracker's `Async` io_engine allows), between the read and the sentinel.
//! - `trust_running`: the shell calls the memo `stable` while the VM runs.

use nestd_core::checkpoint::{DiskStamp, SENTINEL, ScanMemo};
use stateright::{Model, Property};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub max_writes: u8,
    pub max_commits: u8,
    pub max_restarts: u8,
    /// Writes may land after their time moved, even while paused.
    pub async_engine: bool,
    /// The shell passes `stable` for a running VM too (a bug).
    pub trust_running: bool,
}

impl Config {
    pub fn fixed() -> Self {
        Config { max_writes: 5, max_commits: 5, max_restarts: 1, async_engine: false, trust_running: false }
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

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    disk: [bool; 2],
    mtime: Mtime,
    clock: u8,
    vm: Vm,
    /// A write submitted (its time moved) whose data hasn't landed (`async_engine` only).
    inflight: Option<(usize, bool)>,
    memo: ScanMemo<[bool; 2]>,
    /// A pass's manifest, read, before the sentinel is set: (manifest, stable).
    read: Option<([bool; 2], bool)>,
    writes: u8,
    commits: u8,
    restarts: u8,
    /// A reused manifest differed from the disk.
    wrong: bool,
    reused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    Write(usize, bool),
    Land,
    Pause,
    Resume,
    /// Read the stamp; reuse, or read the disk.
    Commit,
    /// Set the sentinel and record the pass.
    Sentinel,
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
            writes: 0,
            commits: 0,
            restarts: 0,
            wrong: false,
            reused: false,
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
        if s.read.is_none() && may_commit && s.commits < self.cfg.max_commits {
            out.push(Action::Commit);
        }
        if s.read.is_some() {
            out.push(Action::Sentinel);
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
            Action::Commit => {
                // `Inner::scan`: what the shell calls stable, then the memo's answer.
                let stable = s.vm != Vm::Running || self.cfg.trust_running;
                n.commits += 1;
                let manifest = match s.memo.unchanged(stable, Some(&stamp(s.mtime))) {
                    Some(m) => {
                        n.reused = true;
                        if *m != s.disk {
                            n.wrong = true;
                        }
                        *m
                    }
                    None => s.disk,
                };
                n.read = Some((manifest, stable));
            }
            Action::Sentinel => {
                let (manifest, stable) = n.read.take().expect("enabled");
                n.mtime = Mtime::Sentinel;
                n.memo.scanned(stable, Some(stamp(n.mtime)), manifest);
            }
            Action::Restart => {
                // The restart kills the VM; the new nestd's memo is empty. A write in flight is
                // lost with the VMM or lands; either way nothing writes after.
                n.restarts += 1;
                n.vm = Vm::Gone;
                n.memo = ScanMemo::new();
                n.read = None;
            }
        }
        Some(n)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::<Self>::always("a_reused_manifest_is_the_disk", |_, s| !s.wrong),
            Property::<Self>::sometimes("a_commit_reused_a_manifest", |_, s| s.reused),
        ]
    }
}

pub const SAFETY: &str = "a_reused_manifest_is_the_disk";
pub const REUSED: &str = "a_commit_reused_a_manifest";
