//! One sandbox's incarnations on a host: nestd's REAL lifecycle table (`nestd_core::lifecycle`:
//! the machine and the create's admission) beside a model of the shell that feeds it
//! (`nestd::host`: `create_sandbox`, `suspend`, `resume`, `checkpoint`, `archive`, `destroy`,
//! `fence_sandbox`), step by step as the shell takes them, with what may interleave.
//!
//! The executor runs one command at a time, each a few steps with an await between them (a
//! command's fence check and its pause of the VM are two steps: the guest's snapshot preparation,
//! or a checkpoint's pre-copy, comes between them). Between any two steps a fence may land (it runs on arrival, beside the executor: it marks the row,
//! pauses the VM through its lock-free handle, and stops it once the command in flight lets go of
//! the sandbox) and the lease may lapse (nestd fences every row it has).
//!
//! The model keeps what the shell keeps: the row's state, whether a VM exists, and the shell's
//! own `paused` flag (set by a suspend, cleared by a resume, and by nothing else). Every step the
//! shell takes is fed to the machine, as `Inner::shadow` does; a step the machine refuses is a
//! mismatch, and the machine then follows the row again.
//!
//! [`Config::today`] is the shell as it is: it violates four properties (H-B1 twice, H-B2, H-B3
//! of the host state-machine audit). Each of the first three flags of [`Config::fixed`] is the
//! fix proposed for one of them; with all three the properties hold.
//!
//! Not modelled: commits and their answers beyond "landed or not", `meta.json`, crashes and
//! restarts, the retire loop, a pause or resume that fails, and the fence's lock-free pause
//! landing later than its mark (here they are one step; the table accepts the later orders, as
//! its unit tests show).

use nestd_core::lifecycle::{Admission, Holder, Incarnation, Input, State as Reported, Vm, admit_create};
use stateright::{Model, Property};

pub const AGREE: &str = "the_machine_accepts_what_nestd_does";
pub const OWN_EPOCH: &str = "a_create_never_fences_its_own_epoch";
pub const LAPSED: &str = "no_create_is_admitted_under_a_lapsed_lease";
pub const ARCHIVING: &str = "an_archiving_incarnation_is_being_archived";
pub const FENCED: &str = "a_fenced_vm_is_stopped_once_nothing_is_in_flight";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    /// H-B2's fix: a create at the epoch of a live local row answers "already here".
    pub refuse_same_epoch: bool,
    /// H-B1's fix: a failed archive lifts its pause and reports the state it began from.
    pub archive_rolls_back: bool,
    /// H-B3's fix: a create is refused while the lease is lapsed.
    pub admit_checks_lapse: bool,
    /// Commands the control plane sends, at most.
    pub max_cmds: u8,
    /// Fences it sends, at most.
    pub max_fences: u8,
    pub max_epoch: u8,
    /// Suspends release the VM (disk-only) instead of keeping it paused (memory).
    pub disk_only: bool,
    /// A resume refuses a fenced incarnation, as the shell does. Off, it shows the fenced-VM
    /// property failing (the property isn't vacuous).
    pub resume_checks_fence: bool,
}

impl Config {
    pub fn today() -> Self {
        Config { refuse_same_epoch: false, archive_rolls_back: false, admit_checks_lapse: false, max_cmds: 4, max_fences: 1, max_epoch: 2, disk_only: false, resume_checks_fence: true }
    }

    pub fn fixed() -> Self {
        Config { refuse_same_epoch: true, archive_rolls_back: true, admit_checks_lapse: true, ..Self::today() }
    }
}

/// The sandbox's row and what the shell keeps beside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Row {
    pub epoch: u8,
    /// `Summary.state`.
    pub state: Reported,
    /// `Sbx.vm.is_some()`.
    pub vm: bool,
    /// `Sbx.paused`.
    pub paused: bool,
    /// The machine, fed beside the shell.
    pub machine: Incarnation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Cmd {
    Create(u8),
    Suspend,
    Resume,
    Checkpoint,
    Archive,
    Destroy,
}

/// The command in flight and where it is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Op {
    Idle,
    /// The VM's start is under way (the fence was checked before it).
    Starting,
    /// The VM started; the boot's last check and report are due.
    Booted,
    /// The command checked the fence (and reported, for a suspend or an archive); its pause of
    /// the VM is due.
    Pausing(Holder),
    /// Paused, the suspend's commit in flight.
    Suspending,
    /// The VM's resume (or cold start) is under way.
    Resuming,
    /// The disk is being read; `paused`: this checkpoint paused the VM.
    Cutting { paused: bool },
    /// The archive's commit is in flight.
    Archiving,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    pub row: Option<Row>,
    /// The highest epoch fenced here.
    pub tombstone: Option<u8>,
    pub op: Op,
    /// A fence's stop of the VM waits for the command in flight.
    pub fence_task: bool,
    pub lapsed: bool,
    pub cmds: u8,
    pub fences: u8,
    // What has happened (the properties and examples read these).
    pub mismatch: bool,
    pub fenced_own_epoch: bool,
    pub created_while_lapsed: bool,
    pub resumed: bool,
    pub archived: bool,
    pub fenced_while_booting: bool,
    pub fenced_before_a_pause: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// The executor takes the next command.
    Issue(Cmd),
    /// The command in flight takes its next step; `ok`: what it awaited ended well (a commit
    /// landed, a boot came up).
    Step { ok: bool },
    /// A fence command arrives.
    Fence,
    /// The lease lapses: nestd fences what it has.
    Lapse,
    /// The fence's task gets the sandbox and stops the VM.
    FenceStops,
}

pub struct IncarnationModel {
    pub cfg: Config,
}

impl State {
    /// `Inner::shadow`: the machine takes the step the shell took; a refusal, or a state other
    /// than the row's, is a mismatch, and the machine follows the row again.
    fn feed(&mut self, input: Input) {
        let Some(row) = &mut self.row else { return };
        let refused = row.machine.step(input).is_err();
        if refused || row.machine.state() != row.state {
            self.mismatch = true;
            row.machine.follow(row.state, input);
        }
    }

    fn fenced(&self) -> bool {
        self.row.is_none_or(|r| r.state == Reported::Fenced)
    }

    /// `set_state` and the step's feed: refused out of `fenced`.
    fn report(&mut self, state: Reported, input: Input) -> bool {
        if self.fenced() {
            return false;
        }
        if let Some(row) = &mut self.row {
            row.state = state;
        }
        self.feed(input);
        true
    }

    /// `fence_sandbox`: mark the row, tombstone the epoch, pause through the lock-free handle (a
    /// VM that started has one), and leave the stop to the fence's task.
    fn fence(&mut self) {
        let Some(row) = &mut self.row else { return };
        if row.state == Reported::Fenced {
            return;
        }
        row.state = Reported::Fenced;
        let (epoch, vm) = (row.epoch, row.vm);
        self.feed(Input::Fence);
        self.tombstone = Some(self.tombstone.map_or(epoch, |t| t.max(epoch)));
        if vm {
            self.feed(Input::Pause(Holder::Fence));
        }
        self.fence_task = true;
        if matches!(self.op, Op::Starting | Op::Booted) {
            self.fenced_while_booting = true;
        }
        if matches!(self.op, Op::Pausing(_)) && vm {
            self.fenced_before_a_pause = true;
        }
    }

    /// `stop_vm`.
    fn stop(&mut self) {
        if let Some(row) = &mut self.row
            && row.vm
        {
            row.vm = false;
            row.paused = false;
            self.feed(Input::Stop);
        }
    }

    fn issue(&mut self, cfg: &Config, cmd: Cmd) {
        match cmd {
            Cmd::Create(epoch) => self.create(cfg, epoch),
            Cmd::Suspend => {
                // `lock_live`, then "already suspended".
                if self.fenced() || self.row.is_some_and(|r| r.state == Reported::Suspended) {
                    return;
                }
                self.report(Reported::Suspending, Input::Suspend);
                self.op = Op::Pausing(Holder::Suspend);
            }
            Cmd::Resume => {
                let resumable = |r: Row| r.state == Reported::Suspended || (!cfg.resume_checks_fence && r.state == Reported::Fenced);
                if (cfg.resume_checks_fence && self.fenced()) || self.row.is_none_or(|r| !resumable(r)) {
                    return;
                }
                self.op = Op::Resuming;
            }
            Cmd::Checkpoint => {
                if self.fenced() {
                    return;
                }
                self.op = Op::Pausing(Holder::Checkpoint);
            }
            Cmd::Archive => {
                if self.fenced() {
                    return;
                }
                self.report(Reported::Archiving, Input::Archive);
                self.op = Op::Pausing(Holder::Archive);
            }
            Cmd::Destroy => {
                let Some(row) = self.row else { return };
                // Destroy is the one report `fenced` doesn't refuse.
                if let Some(r) = &mut self.row {
                    r.state = Reported::Destroyed;
                }
                self.feed(Input::Destroy);
                self.stop();
                self.row = None;
                self.fence_task = false;
                if self.tombstone.is_some_and(|t| t <= row.epoch) {
                    self.tombstone = None;
                }
            }
        }
    }

    fn create(&mut self, cfg: &Config, epoch: u8) {
        if cfg.admit_checks_lapse && self.lapsed {
            return;
        }
        let tombstoned = self.tombstone.is_some_and(|t| epoch <= t);
        let local = self.row.map(|r| (u64::from(r.epoch), r.state));
        if cfg.refuse_same_epoch && !tombstoned && local.is_some_and(|(at, s)| at == u64::from(epoch) && s != Reported::Fenced) {
            return; // "already here"
        }
        match admit_create(tombstoned, local, u64::from(epoch)) {
            Admission::AlreadyRunning | Admission::FencedHere | Admission::NewerHere(_) => return,
            Admission::Create => {}
            Admission::Supersede(old) => {
                if old == u64::from(epoch) {
                    self.fenced_own_epoch = true;
                }
                self.fence();
                // `teardown`: the old incarnation's VM stops and its row goes (it retires apart).
                self.stop();
                self.row = None;
                self.fence_task = false;
                // The proxy refuses a tombstoned epoch: this create fails while it sets up its
                // network, before any VM. (The shell has a `creating` row meanwhile and reports
                // `failed`; the table takes those two steps, and they are left out here.)
                if self.tombstone.is_some_and(|t| epoch <= t) {
                    return;
                }
            }
        }
        // A lapse that comes while this boots fences the row, and the start under way is stopped
        // like any fenced boot's; one that came before is what the admission should have seen.
        if self.lapsed {
            self.created_while_lapsed = true;
        }
        self.row = Some(Row { epoch, state: Reported::Creating, vm: false, paused: false, machine: Incarnation::new(false) });
        // `start_vm` checks the fence, then starts: nothing is fenced yet.
        self.op = Op::Starting;
    }

    fn step(&mut self, cfg: &Config, ok: bool) {
        let op = std::mem::replace(&mut self.op, Op::Idle);
        match op {
            Op::Idle => {}
            Op::Starting => {
                if !ok {
                    // The start failed: `failed`, torn down (a fenced row stays for its fence).
                    if self.report(Reported::Failed, Input::BootFailed) {
                        self.row = None;
                    }
                    return;
                }
                if let Some(row) = &mut self.row {
                    row.vm = true;
                }
                self.feed(Input::Start);
                self.op = Op::Booted;
            }
            Op::Booted => {
                // Fenced since the start, or the guest never came up: `launch` stops the VM it
                // started; a boot that failed is `failed` and torn down (a fenced row stays).
                if self.fenced() || !ok {
                    self.stop();
                    if !ok && self.report(Reported::Failed, Input::BootFailed) {
                        self.row = None;
                    }
                    return;
                }
                self.report(Reported::Running, Input::Ran);
            }
            // The pause, whatever came since the check (the shell doesn't look again).
            Op::Pausing(by) => {
                let Some(row) = &mut self.row else { return };
                match by {
                    Holder::Suspend => {
                        let vm = row.vm;
                        row.paused = true;
                        if vm {
                            self.feed(Input::Pause(by));
                        }
                        self.op = Op::Suspending;
                    }
                    Holder::Checkpoint => {
                        // `running = vm.is_some() && !paused`, by the shell's own flag.
                        let running = row.vm && !row.paused;
                        if running {
                            self.feed(Input::Pause(by));
                        }
                        self.op = Op::Cutting { paused: running };
                    }
                    Holder::Archive | Holder::Fence => {
                        if row.vm {
                            self.feed(Input::Pause(by));
                        }
                        self.op = Op::Archiving;
                    }
                }
            }
            Op::Suspending => {
                if ok {
                    if self.fenced() {
                        return;
                    }
                    if cfg.disk_only {
                        self.stop();
                    }
                    self.report(Reported::Suspended, Input::SuspendLanded);
                } else if !self.fenced() {
                    // `roll_back_suspend`.
                    if self.row.is_some_and(|r| r.vm) {
                        self.feed(Input::Unpause(Holder::Suspend));
                    }
                    if let Some(row) = &mut self.row {
                        row.paused = false;
                    }
                    self.report(Reported::Running, Input::SuspendRolledBack);
                }
            }
            Op::Resuming => {
                // The fence was checked before this await; the VM runs again whatever came since,
                // unless the resume or the cold boot itself failed (nothing changes then).
                if !ok {
                    return;
                }
                let Some(row) = &mut self.row else { return };
                if row.vm {
                    row.paused = false;
                    self.feed(Input::Unpause(Holder::Suspend));
                } else {
                    row.vm = true;
                    self.feed(Input::Start);
                }
                if self.report(Reported::Running, Input::Resume) {
                    self.resumed = true;
                }
            }
            Op::Cutting { paused } => {
                // Never resume a VM fenced meanwhile.
                if paused && !self.fenced() {
                    self.feed(Input::Unpause(Holder::Checkpoint));
                }
            }
            Op::Archiving => {
                if ok {
                    if self.fenced() {
                        return;
                    }
                    self.report(Reported::Archived, Input::ArchiveLanded);
                    self.stop();
                    self.row = None;
                    self.archived = true;
                } else if cfg.archive_rolls_back && !self.fenced() {
                    let Some(row) = self.row else { return };
                    // Back to what it was: the archive's own pause lifted, a suspend's kept.
                    let back = if row.paused || !row.vm { Reported::Suspended } else { Reported::Running };
                    if back == Reported::Running {
                        self.feed(Input::Unpause(Holder::Archive));
                    }
                    self.report(back, Input::ArchiveRolledBack);
                }
                // Today: the error returns, and nothing else happens (H-B1).
            }
        }
    }
}

impl Model for IncarnationModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        vec![State {
            row: None,
            tombstone: None,
            op: Op::Idle,
            fence_task: false,
            lapsed: false,
            cmds: 0,
            fences: 0,
            mismatch: false,
            fenced_own_epoch: false,
            created_while_lapsed: false,
            resumed: false,
            archived: false,
            fenced_while_booting: false,
            fenced_before_a_pause: false,
        }]
    }

    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        let c = &self.cfg;
        if s.op == Op::Idle {
            if s.cmds < c.max_cmds {
                a.extend((1..=c.max_epoch).map(|e| Action::Issue(Cmd::Create(e))));
                if s.row.is_some() {
                    a.extend([Cmd::Suspend, Cmd::Resume, Cmd::Checkpoint, Cmd::Archive, Cmd::Destroy].map(Action::Issue));
                }
            }
            if s.fence_task {
                a.push(Action::FenceStops);
            }
        } else {
            a.push(Action::Step { ok: true });
            if matches!(s.op, Op::Starting | Op::Booted | Op::Suspending | Op::Resuming | Op::Archiving) {
                a.push(Action::Step { ok: false });
            }
        }
        if s.row.is_some_and(|r| r.state != Reported::Fenced) {
            if s.fences < c.max_fences {
                a.push(Action::Fence);
            }
            if !s.lapsed {
                a.push(Action::Lapse);
            }
        } else if !s.lapsed && s.row.is_none() && s.cmds < c.max_cmds {
            // A lapse with nothing here: what a create queued before it then finds.
            a.push(Action::Lapse);
        }
    }

    fn next_state(&self, last: &State, action: Action) -> Option<State> {
        let mut s = last.clone();
        match action {
            Action::Issue(cmd) => {
                s.cmds += 1;
                s.issue(&self.cfg, cmd);
            }
            Action::Step { ok } => s.step(&self.cfg, ok),
            Action::Fence => {
                s.fences += 1;
                s.fence();
            }
            Action::Lapse => {
                s.lapsed = true;
                s.fence();
            }
            Action::FenceStops => {
                s.fence_task = false;
                s.stop();
            }
        }
        Some(s)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always(AGREE, |_, s: &State| !s.mismatch),
            Property::always(OWN_EPOCH, |_, s: &State| !s.fenced_own_epoch),
            Property::always(LAPSED, |_, s: &State| !s.created_while_lapsed),
            Property::always(ARCHIVING, |_, s: &State| s.row.is_none_or(|r| r.state != Reported::Archiving) || matches!(s.op, Op::Archiving | Op::Pausing(Holder::Archive))),
            Property::always(FENCED, |_, s: &State| s.op != Op::Idle || s.fence_task || s.row.is_none_or(|r| r.state != Reported::Fenced || (!r.vm && r.machine.vm() == Vm::Absent))),
            Property::sometimes("a_suspended_sandbox_ran_again", |_, s: &State| s.resumed),
            Property::sometimes("an_archive_landed", |_, s: &State| s.archived),
            Property::sometimes("a_fence_landed_during_a_boot", |_, s: &State| s.fenced_while_booting),
            Property::sometimes("a_fence_landed_between_a_check_and_its_pause", |_, s: &State| s.fenced_before_a_pause),
        ]
    }
}
