//! One incarnation's lifecycle (a sandbox at one epoch on this host) as a machine: its reported
//! state, its VM's condition and who holds a pause, and which steps follow which.
//!
//! **This is the table of what nestd does today, not yet what decides it.** `nestd::host` still
//! makes every decision itself and feeds this machine each step it takes ([`Input`]), beside its
//! own logic; a step the machine refuses, or a reported state that differs, is a logged and
//! counted mismatch (`docs/verification/nestd/`, "Incarnations"). Once a release has run on real
//! hosts with none, the machine starts deciding.
//!
//! So the table accepts what the shell does, known bugs included (the findings of the host
//! state-machine audit of 2026-11, listed in `docs/verification/nestd/`, "Incarnations"):
//! - H-B1: an archive whose commit fails has no exit: the row stays `archiving` with the VM
//!   paused. [`Input::ArchiveRolledBack`] is the declared exit; the shell doesn't take it yet.
//! - H-B2: a create at the epoch of a local row that is neither running nor fenced supersedes
//!   that row, fencing the host's own live epoch ([`admit_create`]).
//! - H-B4: a step that checked the fence before it awaited acts on the VM after the fence landed:
//!   it pauses a fenced VM ([`Input::Pause`], whose hold is then the fence's) or resumes one the
//!   fence paused ([`Input::Unpause`]). The fence's own stop of the VM follows either.
//!
//! The model (`verification/nestd/check`, `incarnation`) says which of the shell's ways break a
//! property: H-B1, H-B2, and H-B3 (a create admitted under a lapsed lease, which this table has
//! no part in).
//!
//! The table is stricter than the shell in two ways, on purpose; each shows as a mismatch where
//! the shell goes beyond it:
//! - **A pause is held by the step that took it.** That step may take it again (a retry), a
//!   fence takes any pause, and an archive takes a suspended VM's; no other step takes another's.
//!   The shell does where a step left a VM paused and nothing recorded it: a checkpoint after
//!   H-B1, and a suspend or archive after a checkpoint whose resume of the VM failed.
//! - **A suspend begins only from `running`, an archive only from `running` or `suspended`.** The
//!   shell begins both from any state that isn't fenced: a retried archive or a suspend on a row
//!   H-B1 left `archiving`, and a retried suspend or an archive on a row left `suspending` by a
//!   roll-back that couldn't finish.

/// The reported state: `nest_protocol::model::SandboxState`, member for member.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum State {
    Creating,
    Restoring,
    Running,
    Suspending,
    Suspended,
    Archiving,
    Archived,
    Fenced,
    Destroyed,
    Failed,
}

/// Every [`State`], for tables over them.
pub const STATES: [State; 10] =
    [State::Creating, State::Restoring, State::Running, State::Suspending, State::Suspended, State::Archiving, State::Archived, State::Fenced, State::Destroyed, State::Failed];

/// Who paused the VM, and so who may run it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Holder {
    /// A suspend: until a resume, or the suspend's roll-back.
    Suspend,
    /// An archive: until the VM is stopped.
    Archive,
    /// A checkpoint's read of the disk.
    Checkpoint,
    /// A fence: the VM never runs again.
    Fence,
}

/// The VM's condition.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Vm {
    /// None: not started yet, or stopped.
    Absent,
    Running,
    Paused(Holder),
}

/// One step the shell took.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Input {
    /// The VM was started (a create's boot, a resume's cold boot).
    Start,
    /// The VM was paused for `Holder`.
    Pause(Holder),
    /// The VM runs again after `Holder`'s pause.
    Unpause(Holder),
    /// The VM was stopped.
    Stop,
    /// A create's boot ended well: reported `running`.
    Ran,
    /// A create's boot failed: reported `failed`.
    BootFailed,
    /// A suspend began: reported `suspending`.
    Suspend,
    /// A suspend's commit landed: reported `suspended`.
    SuspendLanded,
    /// A suspend failed and was rolled back: reported `running` again.
    SuspendRolledBack,
    /// A resume ended well: reported `running`.
    Resume,
    /// An archive began: reported `archiving`.
    Archive,
    /// An archive's commit landed: reported `archived`.
    ArchiveLanded,
    /// An archive failed and was rolled back: reported as before it. Not taken by the shell yet
    /// (H-B1).
    ArchiveRolledBack,
    /// Fenced: reported `fenced`, final for this epoch.
    Fence,
    /// Destroyed: reported `destroyed`.
    Destroy,
}

/// Why the machine refuses a step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Refusal {
    /// The step doesn't follow from this reported state.
    NotFrom(State),
    /// The step needs another VM condition.
    VmIs(Vm),
    /// Someone else holds the pause.
    HeldBy(Holder),
}

/// One incarnation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Incarnation {
    state: State,
    vm: Vm,
    /// What an archive rolls back to: the state it began from.
    before_archive: State,
}

impl Incarnation {
    /// A create was accepted: `restoring` from a generation, else `creating`; no VM yet.
    pub fn new(restoring: bool) -> Self {
        let state = if restoring { State::Restoring } else { State::Creating };
        Incarnation { state, vm: Vm::Absent, before_archive: state }
    }

    /// An incarnation as it is found: by a starting nestd (fenced, no VM), or to follow the shell
    /// again after a mismatch.
    pub fn at(state: State, vm: Vm) -> Self {
        Incarnation { state, vm, before_archive: state }
    }

    /// Follow the shell after a step the machine refused, or after which its state differed:
    /// take the row's `state`, and the VM's condition the step itself left (a VM that was just
    /// paused is paused by that step, one that was just resumed or started runs, one that was
    /// stopped is gone; any other step leaves it as the machine had it).
    pub fn follow(&mut self, state: State, input: Input) {
        let vm = match input {
            Input::Pause(by) => Vm::Paused(by),
            Input::Unpause(_) | Input::Start => Vm::Running,
            Input::Stop => Vm::Absent,
            _ => self.vm,
        };
        *self = Incarnation::at(state, vm);
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn vm(&self) -> Vm {
        self.vm
    }

    /// Take one step, or refuse it and stay as it was.
    pub fn step(&mut self, input: Input) -> Result<(), Refusal> {
        let (state, vm) = (self.state, self.vm);
        let not_from = Err(Refusal::NotFrom(state));
        let vm_is = Err(Refusal::VmIs(vm));
        match input {
            Input::Start => match (state, vm) {
                // `Fenced`: a start under way when the fence landed still ends, and the shell
                // stops that VM at its next step (no pause handle exists before the start ends).
                (State::Creating | State::Restoring | State::Suspended | State::Fenced, Vm::Absent) => self.vm = Vm::Running,
                (State::Creating | State::Restoring | State::Suspended | State::Fenced, _) => return vm_is,
                _ => return not_from,
            },
            Input::Pause(by) => self.vm = paused(state, vm, by)?,
            Input::Unpause(by) => match vm {
                // Over a fence's pause too: what the shell does today (H-B4).
                Vm::Paused(held) if held == by || held == Holder::Fence => self.vm = Vm::Running,
                Vm::Paused(held) => return Err(Refusal::HeldBy(held)),
                _ => return vm_is,
            },
            Input::Stop => self.vm = Vm::Absent,
            Input::Ran => match (state, vm) {
                (State::Creating | State::Restoring, Vm::Running) => self.state = State::Running,
                (State::Creating | State::Restoring, _) => return vm_is,
                _ => return not_from,
            },
            Input::BootFailed => match state {
                State::Creating | State::Restoring => self.state = State::Failed,
                _ => return not_from,
            },
            Input::Suspend => match state {
                State::Running => self.state = State::Suspending,
                _ => return not_from,
            },
            Input::SuspendLanded => match (state, vm) {
                (State::Suspending, Vm::Paused(Holder::Suspend) | Vm::Absent) => self.state = State::Suspended,
                (State::Suspending, _) => return vm_is,
                _ => return not_from,
            },
            Input::SuspendRolledBack => match (state, vm) {
                (State::Suspending, Vm::Running) => self.state = State::Running,
                (State::Suspending, _) => return vm_is,
                _ => return not_from,
            },
            Input::Resume => match (state, vm) {
                (State::Suspended, Vm::Running) => self.state = State::Running,
                (State::Suspended, _) => return vm_is,
                _ => return not_from,
            },
            Input::Archive => match state {
                State::Running | State::Suspended => {
                    self.before_archive = state;
                    self.state = State::Archiving;
                }
                _ => return not_from,
            },
            Input::ArchiveLanded => match state {
                State::Archiving => self.state = State::Archived,
                _ => return not_from,
            },
            Input::ArchiveRolledBack => match (state, vm) {
                (State::Archiving, Vm::Running) if self.before_archive == State::Running => self.state = State::Running,
                // A suspended VM's pause, which the archive took, is the suspend's again.
                (State::Archiving, Vm::Paused(Holder::Suspend | Holder::Archive)) if self.before_archive == State::Suspended => {
                    self.state = State::Suspended;
                    self.vm = Vm::Paused(Holder::Suspend);
                }
                (State::Archiving, Vm::Absent) if self.before_archive == State::Suspended => self.state = State::Suspended,
                (State::Archiving, _) => return vm_is,
                _ => return not_from,
            },
            Input::Fence => match state {
                State::Fenced => return not_from,
                _ => self.state = State::Fenced,
            },
            Input::Destroy => self.state = State::Destroyed,
        }
        Ok(())
    }
}

/// The VM's condition once `by` has paused it, or why `by` may not.
fn paused(state: State, vm: Vm, by: Holder) -> Result<Vm, Refusal> {
    match (vm, by) {
        // A fence's lock-free pause may come after its stop: nothing left to pause.
        (Vm::Absent, Holder::Fence) => Ok(Vm::Absent),
        (Vm::Absent, _) => Err(Refusal::VmIs(vm)),
        // A fenced incarnation's VM never runs again, whoever pauses it: a step that checked the
        // fence before it awaited (H-B4) pauses it too, and the hold is the fence's.
        (_, _) if state == State::Fenced => Ok(Vm::Paused(Holder::Fence)),
        (Vm::Running, _) => Ok(Vm::Paused(by)),
        // The step that holds the pause may take it again (a retry); a fence takes any pause; an
        // archive takes a suspended VM's.
        (Vm::Paused(held), _) if held == by => Ok(vm),
        (Vm::Paused(_), Holder::Fence) | (Vm::Paused(Holder::Suspend), Holder::Archive) => Ok(Vm::Paused(by)),
        (Vm::Paused(held), _) => Err(Refusal::HeldBy(held)),
    }
}

/// What a `sandbox_create` at `epoch` does, given the sandbox's tombstone and its local row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Admission {
    /// Nothing of it here: create it.
    Create,
    /// It already runs here at this epoch: answer ok.
    AlreadyRunning,
    /// This epoch was fenced here: `stale_epoch`.
    FencedHere,
    /// A newer epoch (the value) is here: `stale_epoch`.
    NewerHere(u64),
    /// Fence and retire the local incarnation at the epoch given, then create this one.
    Supersede(u64),
}

/// The create's admission, as `nestd` decides it today. `tombstoned`: the sandbox's tombstone
/// refuses `epoch`. `local`: the sandbox's row here, if any.
///
/// Known bug (H-B2), kept as it is until the machine decides: a row at this very epoch that is
/// neither `running` nor `fenced` (say `suspended`) is superseded like an older one, so the host
/// fences its own live epoch.
pub fn admit_create(tombstoned: bool, local: Option<(u64, State)>, epoch: u64) -> Admission {
    if tombstoned {
        return Admission::FencedHere;
    }
    match local {
        None => Admission::Create,
        Some((at, State::Running)) if at == epoch => Admission::AlreadyRunning,
        Some((at, State::Fenced)) if at == epoch => Admission::FencedHere,
        Some((at, _)) if at > epoch => Admission::NewerHere(at),
        Some((at, _)) => Admission::Supersede(at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(start: Incarnation, inputs: &[Input]) -> Incarnation {
        let mut i = start;
        for input in inputs {
            i.step(*input).unwrap_or_else(|r| panic!("{input:?} refused from {i:?}: {r:?}"));
        }
        i
    }

    /// `input` taken from `i`, which is left as it was.
    fn try_step(mut i: Incarnation, input: Input) -> Result<(), Refusal> {
        i.step(input)
    }

    fn running() -> Incarnation {
        after(Incarnation::new(false), &[Input::Start, Input::Ran])
    }

    fn shape(i: &Incarnation) -> (State, Vm) {
        (i.state(), i.vm())
    }

    #[test]
    fn a_create_boots_and_runs_or_fails() {
        assert_eq!(shape(&Incarnation::new(false)), (State::Creating, Vm::Absent));
        assert_eq!(shape(&Incarnation::new(true)), (State::Restoring, Vm::Absent));
        for restoring in [false, true] {
            let i = after(Incarnation::new(restoring), &[Input::Start, Input::Ran]);
            assert_eq!(shape(&i), (State::Running, Vm::Running));
            // A boot that failed before or after the VM started.
            assert_eq!(shape(&after(Incarnation::new(restoring), &[Input::BootFailed])), (State::Failed, Vm::Absent));
            assert_eq!(shape(&after(Incarnation::new(restoring), &[Input::Start, Input::Stop, Input::BootFailed])), (State::Failed, Vm::Absent));
            // Never `running` without a VM that runs, nor a second start.
            assert_eq!(Incarnation::new(restoring).step(Input::Ran), Err(Refusal::VmIs(Vm::Absent)));
            assert_eq!(after(Incarnation::new(restoring), &[Input::Start]).step(Input::Start), Err(Refusal::VmIs(Vm::Running)));
        }
        assert_eq!(running().step(Input::Ran), Err(Refusal::NotFrom(State::Running)));
        assert_eq!(running().step(Input::BootFailed), Err(Refusal::NotFrom(State::Running)));
        assert_eq!(running().step(Input::Start), Err(Refusal::NotFrom(State::Running)));
    }

    #[test]
    fn a_suspend_pauses_commits_and_keeps_or_releases_the_vm() {
        // Memory mode: the VM stays paused, and a resume continues it.
        let kept = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::SuspendLanded]);
        assert_eq!(shape(&kept), (State::Suspended, Vm::Paused(Holder::Suspend)));
        assert_eq!(shape(&after(kept, &[Input::Unpause(Holder::Suspend), Input::Resume])), (State::Running, Vm::Running));
        // Disk-only: the VM is released, and a resume boots it cold.
        let released = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::Stop, Input::SuspendLanded]);
        assert_eq!(shape(&released), (State::Suspended, Vm::Absent));
        assert_eq!(shape(&after(released, &[Input::Start, Input::Resume])), (State::Running, Vm::Running));
        // A failed suspend runs again.
        let back = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::Unpause(Holder::Suspend), Input::SuspendRolledBack]);
        assert_eq!(shape(&back), (State::Running, Vm::Running));
    }

    #[test]
    fn a_suspend_and_a_resume_follow_only_from_their_states() {
        let suspending = after(running(), &[Input::Suspend]);
        // `suspended` only once the VM is paused by the suspend or gone; `running` only once it runs.
        assert_eq!(try_step(suspending, Input::SuspendLanded), Err(Refusal::VmIs(Vm::Running)));
        let paused = after(suspending, &[Input::Pause(Holder::Suspend)]);
        assert_eq!(try_step(paused, Input::SuspendRolledBack), Err(Refusal::VmIs(Vm::Paused(Holder::Suspend))));
        let suspended = after(paused, &[Input::SuspendLanded]);
        assert_eq!(try_step(suspended, Input::Resume), Err(Refusal::VmIs(Vm::Paused(Holder::Suspend))));
        assert_eq!(try_step(suspended, Input::Start), Err(Refusal::VmIs(Vm::Paused(Holder::Suspend))));
        for s in STATES {
            let i = Incarnation::at(s, Vm::Running);
            assert_eq!(try_step(i, Input::Suspend).is_ok(), s == State::Running, "suspend from {s:?}");
            assert_eq!(try_step(i, Input::Resume).is_ok(), s == State::Suspended, "resume from {s:?}");
            assert_eq!(try_step(i, Input::SuspendLanded), Err(if s == State::Suspending { Refusal::VmIs(Vm::Running) } else { Refusal::NotFrom(s) }));
            assert_eq!(try_step(i, Input::SuspendRolledBack).is_ok(), s == State::Suspending, "roll-back from {s:?}");
        }
    }

    #[test]
    fn an_archive_runs_from_running_or_suspended_and_lands_or_rolls_back() {
        let landed = after(running(), &[Input::Archive, Input::Pause(Holder::Archive), Input::ArchiveLanded, Input::Stop]);
        assert_eq!(shape(&landed), (State::Archived, Vm::Absent));
        // Of a suspended VM, paused or released: the archive takes the suspend's pause.
        let kept = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::SuspendLanded, Input::Archive, Input::Pause(Holder::Archive)]);
        assert_eq!(shape(&kept), (State::Archiving, Vm::Paused(Holder::Archive)));
        let released = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::Stop, Input::SuspendLanded, Input::Archive, Input::ArchiveLanded]);
        assert_eq!(shape(&released), (State::Archived, Vm::Absent));
        for s in STATES {
            let i = Incarnation::at(s, Vm::Running);
            assert_eq!(try_step(i, Input::Archive).is_ok(), matches!(s, State::Running | State::Suspended), "archive from {s:?}");
            assert_eq!(try_step(i, Input::ArchiveLanded).is_ok(), s == State::Archiving, "landed from {s:?}");
            // (Rolling back to `archiving` itself is no state to return to.)
            assert_eq!(try_step(i, Input::ArchiveRolledBack), Err(if s == State::Archiving { Refusal::VmIs(Vm::Running) } else { Refusal::NotFrom(s) }), "{s:?}");
        }
        // The declared exit: back to what it was, once the archive's own pause is lifted.
        let archiving = after(running(), &[Input::Archive, Input::Pause(Holder::Archive)]);
        assert_eq!(try_step(archiving, Input::ArchiveRolledBack), Err(Refusal::VmIs(Vm::Paused(Holder::Archive))));
        assert_eq!(shape(&after(archiving, &[Input::Unpause(Holder::Archive), Input::ArchiveRolledBack])), (State::Running, Vm::Running));
        let suspended = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::Stop, Input::SuspendLanded, Input::Archive]);
        assert_eq!(shape(&after(suspended, &[Input::ArchiveRolledBack])), (State::Suspended, Vm::Absent));
        // A suspended VM kept paused: the pause the archive took is the suspend's again.
        assert_eq!(shape(&after(kept, &[Input::ArchiveRolledBack])), (State::Suspended, Vm::Paused(Holder::Suspend)));
        let untaken = after(running(), &[Input::Suspend, Input::Pause(Holder::Suspend), Input::SuspendLanded, Input::Archive]);
        assert_eq!(shape(&after(untaken, &[Input::ArchiveRolledBack])), (State::Suspended, Vm::Paused(Holder::Suspend)));
        let cut = Incarnation { state: State::Archiving, vm: Vm::Paused(Holder::Checkpoint), before_archive: State::Suspended };
        assert_eq!(try_step(cut, Input::ArchiveRolledBack), Err(Refusal::VmIs(Vm::Paused(Holder::Checkpoint))));
        // Never to `running` with a VM that doesn't run, nor to `suspended` with one that does.
        let stopped = after(running(), &[Input::Archive, Input::Stop]);
        assert_eq!(try_step(stopped, Input::ArchiveRolledBack), Err(Refusal::VmIs(Vm::Absent)));
        let woke = Incarnation { state: State::Archiving, vm: Vm::Running, before_archive: State::Suspended };
        assert_eq!(try_step(woke, Input::ArchiveRolledBack), Err(Refusal::VmIs(Vm::Running)));
    }

    /// Audit H-B1, as the shell behaves today: an archive whose commit fails takes no further
    /// step, so the row stays `archiving` with the VM paused by the archive. The checkpoint that
    /// then pauses and resumes that VM is refused here (the pause is the archive's): the one
    /// mismatch the shadow reports by design.
    #[test]
    fn a_failed_archive_stays_archiving_and_its_pause_is_not_a_checkpoints() {
        let mut stuck = after(running(), &[Input::Archive, Input::Pause(Holder::Archive)]);
        assert_eq!(shape(&stuck), (State::Archiving, Vm::Paused(Holder::Archive)));
        assert_eq!(stuck.step(Input::Pause(Holder::Checkpoint)), Err(Refusal::HeldBy(Holder::Archive)));
        assert_eq!(stuck.step(Input::Unpause(Holder::Checkpoint)), Err(Refusal::HeldBy(Holder::Archive)));
        assert_eq!(shape(&stuck), (State::Archiving, Vm::Paused(Holder::Archive)), "a refused step changes nothing");
    }

    #[test]
    fn a_pause_is_held_by_one_step_and_a_fence_takes_any() {
        let holders = [Holder::Suspend, Holder::Archive, Holder::Checkpoint, Holder::Fence];
        for held in holders {
            for by in holders {
                let mut i = Incarnation::at(State::Running, Vm::Paused(held));
                let takes = by == held || by == Holder::Fence || (held, by) == (Holder::Suspend, Holder::Archive);
                assert_eq!(i.step(Input::Pause(by)), if takes { Ok(()) } else { Err(Refusal::HeldBy(held)) }, "{by:?} over {held:?}");
                assert_eq!(i.vm(), Vm::Paused(if takes { by } else { held }));
                // Running again: by its holder, and (H-B4, today) by anyone over a fence's pause.
                let mut i = Incarnation::at(State::Running, Vm::Paused(held));
                let runs = by == held || held == Holder::Fence;
                assert_eq!(i.step(Input::Unpause(by)), if runs { Ok(()) } else { Err(Refusal::HeldBy(held)) }, "{by:?} resumes {held:?}'s");
                assert_eq!(i.vm(), if runs { Vm::Running } else { Vm::Paused(held) });
            }
        }
        // Nothing to pause or resume without a VM; a VM that runs isn't resumed.
        let mut none = Incarnation::new(false);
        assert_eq!(none.step(Input::Pause(Holder::Checkpoint)), Err(Refusal::VmIs(Vm::Absent)));
        assert_eq!(none.step(Input::Unpause(Holder::Checkpoint)), Err(Refusal::VmIs(Vm::Absent)));
        assert_eq!(running().step(Input::Unpause(Holder::Checkpoint)), Err(Refusal::VmIs(Vm::Running)));
        // A checkpoint's pause and resume leave it running.
        assert_eq!(shape(&after(running(), &[Input::Pause(Holder::Checkpoint), Input::Unpause(Holder::Checkpoint)])), (State::Running, Vm::Running));
    }

    #[test]
    fn fenced_is_final_and_a_fenced_vms_pause_is_the_fences() {
        for s in STATES {
            let mut i = Incarnation::at(s, Vm::Running);
            assert_eq!(i.step(Input::Fence), if s == State::Fenced { Err(Refusal::NotFrom(s)) } else { Ok(()) }, "fence from {s:?}");
            assert_eq!(i.state(), State::Fenced);
        }
        let fenced = after(running(), &[Input::Fence]);
        for input in [Input::Ran, Input::BootFailed, Input::Suspend, Input::SuspendLanded, Input::SuspendRolledBack, Input::Resume, Input::Archive, Input::ArchiveLanded, Input::ArchiveRolledBack] {
            assert_eq!(try_step(fenced, input), Err(Refusal::NotFrom(State::Fenced)), "{input:?} out of fenced");
        }
        // A step that checked the fence before it awaited pauses the fenced VM (H-B4, today): the
        // hold is the fence's, whether its own pause came first or not, and that step doesn't
        // resume it by a pause of its own.
        for by in [Holder::Suspend, Holder::Archive, Holder::Checkpoint, Holder::Fence] {
            assert_eq!(shape(&after(fenced, &[Input::Pause(by)])), (State::Fenced, Vm::Paused(Holder::Fence)), "{by:?} pauses a fenced VM");
            assert_eq!(shape(&after(fenced, &[Input::Pause(Holder::Fence), Input::Pause(by)])), (State::Fenced, Vm::Paused(Holder::Fence)));
            assert_eq!(try_step(Incarnation::at(State::Fenced, Vm::Absent), Input::Pause(by)).is_ok(), by == Holder::Fence, "no VM: only the fence's late pause is nothing");
        }
        // The fence pauses it (again, after a step resumed it) and stops it; a pause that comes
        // after the stop does nothing; a destroy ends it.
        let i = after(fenced, &[Input::Pause(Holder::Fence), Input::Pause(Holder::Fence), Input::Stop, Input::Pause(Holder::Fence)]);
        assert_eq!(shape(&i), (State::Fenced, Vm::Absent));
        assert_eq!(shape(&after(i, &[Input::Destroy])), (State::Destroyed, Vm::Absent));
        // An incarnation a starting nestd found: fenced, no VM, and it stays so.
        let found = Incarnation::at(State::Fenced, Vm::Absent);
        assert_eq!(shape(&found), (State::Fenced, Vm::Absent));
        // A start under way when the fence landed ends (once), and is stopped.
        let booting = after(Incarnation::new(false), &[Input::Fence, Input::Start]);
        assert_eq!(shape(&booting), (State::Fenced, Vm::Running));
        assert_eq!(try_step(booting, Input::Start), Err(Refusal::VmIs(Vm::Running)));
        assert_eq!(try_step(booting, Input::Ran), Err(Refusal::NotFrom(State::Fenced)));
        assert_eq!(shape(&after(booting, &[Input::Stop])), (State::Fenced, Vm::Absent));
    }

    /// After a mismatch the machine follows the shell: the row's state, and the VM's condition
    /// the refused step itself left.
    #[test]
    fn following_the_shell_takes_its_state_and_what_the_step_left_of_the_vm() {
        let stuck = after(running(), &[Input::Archive, Input::Pause(Holder::Archive)]);
        for (input, vm) in [
            (Input::Pause(Holder::Checkpoint), Vm::Paused(Holder::Checkpoint)),
            (Input::Unpause(Holder::Checkpoint), Vm::Running),
            (Input::Start, Vm::Running),
            (Input::Stop, Vm::Absent),
            (Input::Suspend, Vm::Paused(Holder::Archive)),
            (Input::Fence, Vm::Paused(Holder::Archive)),
        ] {
            let mut i = stuck;
            i.follow(State::Suspending, input);
            assert_eq!(shape(&i), (State::Suspending, vm), "{input:?}");
        }
        // And from there it agrees again: the checkpoint that ran the archive's VM, then the next.
        let mut i = stuck;
        i.follow(State::Archiving, Input::Unpause(Holder::Checkpoint));
        assert_eq!(shape(&after(i, &[Input::Pause(Holder::Checkpoint), Input::Unpause(Holder::Checkpoint)])), (State::Archiving, Vm::Running));
    }

    /// Audit H-B4, as the shell behaves today: a step that checked the fence before it awaited
    /// resumes the VM the fence paused meanwhile; the shell then freezes it again.
    #[test]
    fn a_fenced_vm_is_resumed_by_a_step_that_began_before_the_fence() {
        let i = after(running(), &[Input::Pause(Holder::Checkpoint), Input::Fence, Input::Pause(Holder::Fence), Input::Unpause(Holder::Checkpoint)]);
        assert_eq!(shape(&i), (State::Fenced, Vm::Running), "a fenced VM runs");
        assert_eq!(shape(&after(i, &[Input::Pause(Holder::Fence)])), (State::Fenced, Vm::Paused(Holder::Fence)));
    }

    #[test]
    fn a_destroy_and_a_stop_follow_from_anything() {
        for s in STATES {
            for vm in [Vm::Absent, Vm::Running, Vm::Paused(Holder::Suspend)] {
                let i = after(Incarnation::at(s, vm), &[Input::Stop, Input::Destroy]);
                assert_eq!(shape(&i), (State::Destroyed, Vm::Absent));
            }
        }
    }

    /// The create's admission over every state of a local row. Audit H-B2, as the shell behaves
    /// today: a row at this very epoch that is neither running nor fenced is superseded.
    #[test]
    fn a_creates_admission_over_every_local_state() {
        assert_eq!(admit_create(false, None, 3), Admission::Create);
        for s in STATES {
            assert_eq!(admit_create(true, Some((3, s)), 3), Admission::FencedHere, "a tombstone refuses, whatever is here ({s:?})");
            assert_eq!(admit_create(false, Some((4, s)), 3), Admission::NewerHere(4), "{s:?} at a newer epoch");
            assert_eq!(admit_create(false, Some((2, s)), 3), Admission::Supersede(2), "{s:?} at an older epoch");
            let same = match s {
                State::Running => Admission::AlreadyRunning,
                State::Fenced => Admission::FencedHere,
                // H-B2: the host fences its own live epoch.
                _ => Admission::Supersede(3),
            };
            assert_eq!(admit_create(false, Some((3, s)), 3), same, "{s:?} at this epoch");
        }
        assert_eq!(admit_create(true, None, 3), Admission::FencedHere);
    }
}
