//! A process-driver guest's processes: the guest, everything descended from it, and everything in
//! its session.
//!
//! The guest starts each Bash call in a process group of its own (`setpgid`), and each PTY in a
//! session of its own (`setsid`), so a signal to the guest's pid, or its process group, reached
//! none of them: a "stopped" guest's agents ran on as root, writing the loop-mounted disk, after
//! a suspend, fence or destroy, and a "paused" one's kept writing while a commit read the disk.
//! The driver acts on the whole tree instead.
//!
//! - **Membership.** The guest is spawned as a session leader (`supervise::spawn_in_session`), so
//!   every process it starts that doesn't start a session of its own carries its session id, and
//!   keeps it when its parent exits and init adopts it (`cmd &` in a Bash call that returns). A
//!   member is the guest, a process in its session, a process pinned as a member that has since
//!   left both (a `setsid` server whose call returned), or a descendant of a member ([`members`]).
//! - **Freeze first, parents before children.** [`Tree::freeze`] stops the guest, then members
//!   pass after pass: each pass stops what [`stop_now`] allows (a process whose parent, if in the
//!   tree, has already stopped, so no parent waiting with WUNTRACED sees its child's stop as its
//!   job stopping) and stops again any that runs again, until no new member appears and every
//!   member, every thread of it, is stopped (a stopped process can't fork). It gives up after
//!   [`FREEZE_BUDGET`] with an error, and continues what it stopped. A fence's [`Tree::halt`]
//!   instead keeps what it stopped and passes over what it can't stop: a fenced guest must not run
//!   on.
//! - **Never another process.** A pidfd is opened for each member when it is found, then its
//!   parent or session is read, and the pidfd is kept: every later signal goes through it, so a
//!   pid that exited and was reused is never hit, and a member whose parent exited is still
//!   reached. (A pid reused by a new member within one freeze, which takes wraparound within a
//!   second, could hide that member until the next freeze.)
//! - **Never nestd's own.** Whatever the rules above made of the process table, [`refusal`] keeps
//!   some processes from ever being pinned, and so signalled: no process id (0 and negative pids
//!   name process groups, -1 every process), init, nestd, nestd's ancestors, and any process
//!   older than the guest. A bug in finding members then never reaches those; a process younger
//!   than the guest (another guest started later) has no such protection.
//! - **Resume is transparent.** [`Tree::thaw`] continues exactly the processes the freezes
//!   stopped, deepest first ([`deepest_first`]); one an agent had stopped itself (`kill -STOP`, a
//!   suspended job) stays stopped.
//! - **A kill goes on regardless.** It passes over a process it can't pin or stop (reported) and
//!   keeps looking for what comes after it in the tree.
//! - **Quiescence is per thread, not per I/O.** A process counts as stopped once every thread of
//!   it is, and one in an uninterruptible wait with SIGSTOP pending (a write throttled on dirty
//!   pages) counts as stopped though that write may still finish. In a multithreaded process whose
//!   other thread took the SIGSTOP, a thread in such a wait shows no pending signal, so the freeze
//!   waits for it (and fails after the budget) rather than count it stopped. A
//!   commit that must not race a guest's writes needs the disk's own quiescence, which a VM's
//!   pause gives and this driver only approximates.
//! - **The limits:** a process that leaves both the tree and the session before any freeze has
//!   pinned it (a PTY's own session whose leader exited, a daemon that calls `setsid` and whose
//!   parent exited, between two pauses) escapes, with its descendants. Containing that needs a
//!   cgroup or a pid namespace, which the process driver doesn't have. Each live member holds a
//!   pidfd in nestd until it exits, so a guest with about a thousand processes nears the default
//!   1024-descriptor limit. It is for development and the e2e harness only
//!   (`config::unconfined_driver_refusal`); a cell host runs Firecracker under the jailer, whose
//!   VMM cgroup holds everything.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use nestd_core::tree::{Failure, Stat, deepest_first, members, pin_failure, refusal, runs_no_more, signallable, still_member, stop_failure, stop_now, stop_pending_in};
use nix::sys::signal::Signal;

/// How long a freeze keeps trying before it says which processes it couldn't stop.
pub const FREEZE_BUDGET: Duration = Duration::from_secs(1);

/// One process's state, parent and session. The command name (field 2) may hold spaces and
/// parentheses: fields are counted from the last `)`.
fn stat(pid: i32) -> Option<Stat> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut rest = text.rsplit_once(')')?.1.split_whitespace();
    let state = rest.next()?.chars().next()?;
    let ppid = rest.next()?.parse().ok()?;
    let _pgrp = rest.next()?;
    let session = rest.next()?.parse().ok()?;
    // Fields 7 to 21 lie between the session and the start time (field 22).
    let start = rest.nth(15)?.parse().ok()?;
    Some(Stat { state, ppid, session, start })
}

/// Every process now.
fn table() -> BTreeMap<i32, Stat> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(|pid| Some((pid, stat(pid)?)))
        .collect()
}

fn pidfd_open(pid: i32) -> io::Result<OwnedFd> {
    // SAFETY: a plain syscall on an integer; a non-negative result is a new fd we own.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd == -1 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` was just returned by pidfd_open and is owned by nothing else.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

fn send(fd: &OwnedFd, sig: Signal) -> io::Result<()> {
    // SAFETY: a plain syscall on a pidfd we own; a null siginfo is allowed.
    let r = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd.as_raw_fd(), sig as libc::c_int, std::ptr::null::<libc::siginfo_t>(), 0) };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Whether the process behind `fd` has exited (its pidfd is readable).
fn exited(fd: &OwnedFd) -> bool {
    let mut p = libc::pollfd { fd: fd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
    // SAFETY: one pollfd we own, no wait.
    unsafe { libc::poll(&mut p, 1, 0) > 0 }
}

/// A member, pinned by its pidfd.
struct Member {
    pid: i32,
    fd: OwnedFd,
    /// A freeze stopped it (and no thaw has continued it since).
    stopped: bool,
}

/// Whether SIGSTOP is pending in a task's `status` (`SigPnd`, or the process-wide `ShdPnd`): it
/// stops the moment it leaves the kernel, so it runs no user code again.
fn stop_pending(status_path: &str) -> bool {
    std::fs::read_to_string(status_path).is_ok_and(|status| stop_pending_in(&status))
}

/// One task's state letter, from `<dir>/stat`.
fn task_state(dir: &str) -> Option<char> {
    let text = std::fs::read_to_string(format!("{dir}/stat")).ok()?;
    text.rsplit_once(')')?.1.split_whitespace().next()?.chars().next()
}

/// Whether `pid` runs no user code again, every thread of it (tests read a freeze's outcome with it).
#[cfg(test)]
pub(crate) fn halted_pid(pid: i32) -> bool {
    all_threads_halted(pid)
}

/// Whether every thread of `pid` [`runs_no_more`]: a process whose main thread stopped (or
/// exited) while another runs still runs. Gone reads as halted.
fn all_threads_halted(pid: i32) -> bool {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else { return true };
    tasks.flatten().all(|t| {
        let dir = t.path().display().to_string();
        task_state(&dir).is_none_or(|state| runs_no_more(state, || stop_pending(&format!("{dir}/status"))))
    })
}

impl Member {
    /// Gone, or [`runs_no_more`]. Checked through the pidfd first and last, so a pid reused after
    /// an exit never reads as this member.
    fn halted(&self) -> bool {
        exited(&self.fd) || all_threads_halted(self.pid) || exited(&self.fd)
    }
}

/// One guest's process tree, as the driver has seen it.
pub struct Tree {
    root: i32,
    /// When the guest started: no member is older.
    root_start: u64,
    /// Every member found, the guest first and parents before children, each pinned by its pidfd.
    members: Vec<Member>,
    /// Killed: the guest is reaped next, and nothing may be frozen or continued any more (its pid
    /// and session id may be reused).
    dead: bool,
    /// How long a freeze or a halt keeps trying ([`FREEZE_BUDGET`]; tests shorten it).
    budget: Duration,
}

impl Tree {
    /// The tree of the guest `root` (a child of nestd, not yet reaped).
    pub fn new(root: i32) -> io::Result<Tree> {
        let refused = |why: &str| io::Error::new(io::ErrorKind::InvalidInput, format!("{root} can't be a guest: {why}"));
        if root <= 1 {
            return Err(refused("not a child's process id"));
        }
        let fd = pidfd_open(root)?;
        let root_start = stat(root).ok_or_else(|| refused("it has exited"))?.start;
        if let Some(why) = refusal(root, root_start, std::process::id() as i32, root_start, &table()) {
            return Err(refused(why));
        }
        Ok(Tree { root, root_start, members: vec![Member { pid: root, fd, stopped: false }], dead: false, budget: FREEZE_BUDGET })
    }

    /// The same tree with another budget for its freezes and halts.
    #[cfg(test)]
    pub(crate) fn with_budget(self, budget: Duration) -> Tree {
        Tree { budget, ..self }
    }

    /// Stop every member (see the module docs). An error when the guest can't be signalled, when
    /// a member can't be pinned, or when [`FREEZE_BUDGET`] ran out with members still running: then
    /// what this freeze stopped is continued again, so a failed pause leaves the guest running, as
    /// before it. Blocking.
    pub fn freeze(&mut self) -> io::Result<()> {
        self.freeze_within(self.budget)
    }

    /// [`Tree::freeze`] with its own budget.
    fn freeze_within(&mut self, budget: Duration) -> io::Result<()> {
        if self.dead {
            return Ok(());
        }
        let before = self.stopped();
        let r = self.freeze_keeping(budget, false);
        if r.is_err() {
            let undo: Vec<i32> = self.stopped().difference(&before).copied().collect();
            self.continue_(&undo);
            for m in self.members.iter_mut().filter(|m| undo.contains(&m.pid)) {
                m.stopped = false;
            }
        }
        r
    }

    /// For a fence: stop what can be stopped and keep it stopped, passing over (and reporting) what
    /// can't be, so a fenced guest runs no more than it must. The descendants of a member that
    /// can't be stopped run on too (each waits for its parent to stop) until the stop that follows
    /// a fence kills them. [`Tree::freeze`] undoes a failed freeze instead, since a commit's failed
    /// pause must leave the guest as it was. Blocking.
    pub fn halt(&mut self) -> io::Result<()> {
        self.halt_within(self.budget)
    }

    /// [`Tree::halt`] with its own budget.
    fn halt_within(&mut self, budget: Duration) -> io::Result<()> {
        if self.dead {
            return Ok(());
        }
        self.freeze_keeping(budget, true)
    }

    /// The members a freeze stopped (and no thaw has continued since).
    fn stopped(&self) -> BTreeSet<i32> {
        self.members.iter().filter(|m| m.stopped).map(|m| m.pid).collect()
    }

    /// A member that has exited goes (its pid may name another process next time); the guest
    /// stays, unreaped until the tree is dead.
    fn forget_exited(&mut self) {
        let root = self.root;
        self.members.retain(|m| m.pid == root || !exited(&m.fd));
    }

    /// SIGCONT to `pids` (members), deepest first, as `thaw` does.
    fn continue_(&self, pids: &[i32]) {
        for p in deepest_first(pids, |p| stat(p).map(|s| s.ppid)) {
            if let Some(m) = self.members.iter().find(|m| m.pid == p) {
                let _ = send(&m.fd, Signal::SIGCONT);
            }
        }
    }

    /// [`Tree::freeze`], keeping whatever it stopped when it fails. `killing` (a kill follows, or
    /// this is a fence's halt): a process that can't be pinned or stopped is passed over (and reported) instead of ending
    /// the discovery of what comes after it.
    fn freeze_keeping(&mut self, budget: Duration, killing: bool) -> io::Result<()> {
        let deadline = Instant::now() + budget;
        let root = self.root;
        self.forget_exited();
        let mut known: BTreeSet<i32> = self.members.iter().map(|m| m.pid).collect();
        let mut passed_over: Option<io::Error> = None;
        loop {
            // The snapshot of what has stopped comes first, the table after it: a child a member
            // forked before it stopped is in the table, so it can't be missed by a pass that sees
            // that member stopped.
            let halted: BTreeSet<i32> = self.members.iter().filter(|m| m.halted()).map(|m| m.pid).collect();
            // Membership is found among the processes nestd may signal at all: a refused one is
            // no candidate, nor is what hangs off it alone.
            let all = table();
            let t = signallable(std::process::id() as i32, self.root_start, &all);
            let running = self.members.len() - halted.len();
            // Pin what is new, before deciding: what a pidfd names is a member from now on, and so
            // are its descendants, wherever it went (seeded by the pinned members still alive
            // after the table was read, so a pid in it is still theirs).
            let live: BTreeSet<i32> = self.members.iter().filter(|m| !exited(&m.fd)).map(|m| m.pid).collect();
            let candidates = members(root, &live, &t);
            let candidate_set: BTreeSet<i32> = candidates.iter().copied().collect();
            let before = self.members.len();
            let mut found = false;
            for pid in candidates {
                if known.contains(&pid) {
                    continue;
                }
                let fd = match pidfd_open(pid) {
                    Ok(fd) => fd,
                    Err(e) => {
                        let failure = pin_failure(e.raw_os_error(), killing);
                        let e = io::Error::new(e.kind(), format!("pinning the guest's process {pid}: {e}"));
                        match failure {
                            Failure::Ignore => {}
                            Failure::Fail => return Err(e),
                            Failure::PassOver => {
                                known.insert(pid);
                                passed_over.get_or_insert(e);
                            }
                        }
                        continue;
                    }
                };
                // Read again once pinned: the pid still names a process of the tree (its session,
                // or a parent in the tree), not one that took a freed pid since the table was read.
                let Some(now) = stat(pid).filter(|now| still_member(now, root, &known, &candidate_set)) else { continue };
                // As it is now, pinned (the table's row may be an earlier holder of the pid): never
                // one nestd must not signal, and never a parent its children are found through.
                if let Some(why) = refusal(pid, now.start, std::process::id() as i32, self.root_start, &all) {
                    tracing::error!(guest = root, pid, why, "refusing to treat a process as a guest's");
                    continue;
                }
                known.insert(pid);
                self.members.push(Member { pid, fd, stopped: false });
                found = true;
            }
            let pinned: BTreeSet<i32> = live.iter().copied().chain(self.members.iter().skip(before).map(|m| m.pid)).collect();
            for pid in stop_now(root, &t, &pinned, &halted) {
                let Some(m) = self.members.iter_mut().find(|m| m.pid == pid) else { continue };
                let was_halted = task_state(&format!("/proc/{pid}")).is_some_and(|s| matches!(s, 'T' | 't'));
                match send(&m.fd, Signal::SIGSTOP) {
                    Ok(()) if !was_halted => m.stopped = true,
                    Ok(()) => {}
                    Err(e) => {
                        let failure = stop_failure(e.raw_os_error(), killing);
                        let e = io::Error::new(e.kind(), format!("the guest's process {pid} can't be stopped: {e}"));
                        match failure {
                            Failure::Ignore => {}
                            Failure::Fail => return Err(e),
                            Failure::PassOver => {
                                passed_over.get_or_insert(e);
                            }
                        }
                    }
                }
            }
            if !found && running == 0 {
                return passed_over.map_or(Ok(()), Err);
            }
            if Instant::now() >= deadline {
                return Err(passed_over.unwrap_or_else(|| io::Error::new(io::ErrorKind::TimedOut, format!("{running} of the guest's {} processes didn't stop", self.members.len()))));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Continue what the freezes stopped, deepest first: the kernel tells a parent waiting with
    /// `WUNTRACED` (an interactive shell) that its job stopped until the child itself is
    /// continued, so a parent continued first could see its foreground job as stopped. Then
    /// forget the members that have exited.
    pub fn thaw(&mut self) {
        if self.dead {
            return;
        }
        let stopped: Vec<i32> = self.stopped().into_iter().collect();
        self.continue_(&stopped);
        for m in &mut self.members {
            m.stopped = false;
        }
        self.forget_exited();
    }

    /// Freeze (as far as it goes, keeping what it stopped and passing over what it can't hold),
    /// then kill every member, parents first, so no parent outlives the scan that found its
    /// children; then look again, and kill what a parent that wasn't stopped started meanwhile,
    /// until nothing new is found (bounded). After a freeze that failed, a child that a member in a
    /// session of its own started after the last look, and that the member's death orphaned, is
    /// missed. The tree is dead afterwards: the caller reaps the guest.
    pub fn kill(&mut self) {
        if self.dead {
            return;
        }
        if let Err(e) = self.freeze_keeping(FREEZE_BUDGET, true) {
            tracing::warn!(guest = self.root, error = %e, "killing a guest's processes not all of which stopped");
        }
        let mut killed = BTreeSet::new();
        for _ in 0..10 {
            let mut more = false;
            for m in &self.members {
                if killed.insert(m.pid) {
                    let _ = send(&m.fd, Signal::SIGKILL);
                    more = true;
                }
            }
            if !more {
                break;
            }
            // Members started since (only possible if the freeze failed) are found and pinned.
            let _ = self.freeze_keeping(FREEZE_BUDGET, true);
        }
        self.dead = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shell refuses them as a root too: a tree is never rooted at init, at no pid, at this
    /// process or at its parent.
    #[test]
    fn a_tree_is_never_rooted_at_a_process_nestd_must_not_signal() {
        let own = std::process::id() as i32;
        let parent = stat(own).unwrap().ppid;
        for pid in [0, -1, 1, own, parent] {
            let e = Tree::new(pid).err().unwrap_or_else(|| panic!("{pid} became a guest"));
            assert_eq!(e.kind(), io::ErrorKind::InvalidInput, "{pid}: {e}");
        }
    }

    /// A child process, killed and reaped however the test ends.
    struct Reaped(std::process::Child);
    impl Drop for Reaped {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    impl Reaped {
        /// Whether the child has exited within 2 s (reaped if so): a test never waits for ever on
        /// a process a broken kill left stopped.
        fn exits(&mut self) -> bool {
            for _ in 0..200 {
                if matches!(self.0.try_wait(), Ok(Some(_))) {
                    return true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            false
        }
    }

    /// SIGKILLs a pid when dropped: a process the test's tree should have killed, however the test
    /// ends (a stopped process never exits by itself).
    struct Killed(i32);
    impl Drop for Killed {
        fn drop(&mut self) {
            let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(self.0), Signal::SIGKILL);
        }
    }

    /// A child shell that starts `sleep 20` and writes its pid, as the tree's root; the pid.
    fn tree_with_a_child() -> (std::process::Child, i32) {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("pid");
        let mut root = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("exec >/dev/null 2>&1; sleep 20 & echo $! > {}; exec sleep 20", f.display()))
            .spawn()
            .unwrap();
        for _ in 0..250 {
            if let Some(p) = std::fs::read_to_string(&f).ok().and_then(|s| s.trim().parse().ok()) {
                return (root, p);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = root.kill();
        let _ = root.wait();
        panic!("no child");
    }

    fn state(pid: i32) -> Option<char> {
        stat(pid).map(|s| s.state)
    }

    /// A freeze that fails (here its budget is spent before the members it found have stopped)
    /// continues what it stopped: a failed pause leaves the guest running, as before it, never
    /// stopped with nothing to resume it. A kill after it still finds and kills every member.
    #[test]
    fn a_failed_freeze_continues_what_it_stopped() {
        let (root, child) = tree_with_a_child();
        let (mut root, _child) = (Reaped(root), Killed(child));
        let mut t = Tree::new(root.0.id() as i32).unwrap();
        assert!(t.freeze_within(Duration::ZERO).is_err(), "no budget: the members found aren't all stopped yet");
        std::thread::sleep(Duration::from_millis(50));
        for p in [root.0.id() as i32, child] {
            assert!(!matches!(state(p), Some('T' | 't')), "{p} left stopped by a failed freeze");
        }
        assert!(t.stopped().is_empty());
        t.freeze().unwrap();
        assert!(matches!(state(child), Some('T' | 't')));
        t.kill();
        assert!(root.exits(), "the guest outlived the kill");
        std::thread::sleep(Duration::from_millis(50));
        assert!(state(child).is_none_or(|s| s == 'Z'), "the child outlived the kill");
        assert!(t.freeze().is_ok() && t.dead, "a dead tree freezes nothing");
    }

    /// A member that exited is forgotten by the next freeze: its pid may name another process by
    /// then, whose children would be found through it, pinned, stopped and killed.
    #[test]
    fn a_member_that_exited_is_forgotten_by_the_next_freeze() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("pid");
        // The guest reaps its child (`wait`), so the child's pid is free once it has died.
        let root = std::process::Command::new("/bin/sh").arg("-c").arg(format!("exec >/dev/null 2>&1; sleep 20 & echo $! > {}; wait; exec sleep 20", f.display())).spawn().unwrap();
        let mut root = Reaped(root);
        let mut child = None;
        for _ in 0..250 {
            child = std::fs::read_to_string(&f).ok().and_then(|s| s.trim().parse::<i32>().ok());
            if child.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let child = child.expect("the guest's child");
        let _child = Killed(child);
        let mut t = Tree::new(root.0.id() as i32).unwrap();
        t.freeze().unwrap();
        assert!(t.members.iter().any(|m| m.pid == child) && t.stopped().contains(&child), "the child is a member, stopped by the freeze");
        assert!(matches!(state(child), Some('T' | 't')));
        t.thaw();
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(child), Signal::SIGKILL);
        for _ in 0..200 {
            if state(child).is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(state(child), None, "the guest reaped its child");
        t.freeze().unwrap();
        assert!(!t.members.iter().any(|m| m.pid == child), "a dead member is still held");
        t.kill();
        assert!(root.exits(), "the guest outlived the kill");
    }

    /// A task whose `status` can't be read (it is gone) has no SIGSTOP pending.
    #[test]
    fn a_task_that_is_gone_has_nothing_pending() {
        assert!(!stop_pending("/proc/self/task/0/status"));
        assert!(!stop_pending(&format!("/proc/self/task/{}/status", std::process::id())), "this thread runs: nothing pending");
    }

    /// A pid that names no process can't be pinned: an error, never a descriptor.
    #[test]
    fn a_process_that_is_gone_cant_be_pinned() {
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let pid = gone.id() as i32;
        gone.wait().unwrap();
        assert_eq!(pidfd_open(pid).err().and_then(|e| e.raw_os_error()), Some(libc::ESRCH));
        assert!(pidfd_open(std::process::id() as i32).is_ok());
    }

    /// A fence's halt that fails keeps what it stopped (the guest here, its child not yet: no
    /// budget left for a second pass): a fenced guest must not run on. A thaw still continues it.
    #[test]
    fn a_failed_halt_keeps_what_it_stopped() {
        let (root, child) = tree_with_a_child();
        let (mut root, _child) = (Reaped(root), Killed(child));
        let pid = root.0.id() as i32;
        let mut t = Tree::new(pid).unwrap();
        assert!(t.halt_within(Duration::ZERO).is_err(), "no budget: the child isn't stopped yet");
        std::thread::sleep(Duration::from_millis(50));
        assert!(matches!(state(pid), Some('T' | 't')), "the guest left running by a failed halt");
        assert!(t.stopped().contains(&pid));
        t.thaw();
        std::thread::sleep(Duration::from_millis(50));
        assert!(!matches!(state(pid), Some('T' | 't')));
        t.kill();
        assert!(root.exits(), "the guest outlived the kill");
        std::thread::sleep(Duration::from_millis(50));
        assert!(state(child).is_none_or(|s| s == 'Z'), "the kill killed the child");
    }

    /// A freeze that lands while a member spawns children with vfork (`posix_spawn`, as Python,
    /// glibc and Rust do) succeeds: a parent waiting on a stopped vfork child is in `D` with SIGSTOP
    /// pending, which counts as halted (it used to spin the whole budget and fail).
    #[test]
    fn a_freeze_during_a_vfork_loop_succeeds() {
        if std::process::Command::new("python3").arg("-c").arg("import os; os.posix_spawn").output().map(|o| !o.status.success()).unwrap_or(true) {
            eprintln!("NEST-TEST-SKIP: a_freeze_during_a_vfork_loop_succeeds: no python3 with posix_spawn");
            return;
        }
        let root = std::process::Command::new("python3")
            .arg("-c")
            .arg("import os, time\nend = time.time() + 20\nwhile time.time() < end:\n    pid = os.posix_spawn('/bin/true', ['true'], {})\n    os.waitpid(pid, 0)")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let mut root = Reaped(root);
        let mut t = Tree::new(root.0.id() as i32).unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let mut failed = 0;
        for _ in 0..30 {
            if t.freeze().is_err() {
                failed += 1;
            }
            t.thaw();
        }
        t.kill();
        assert!(root.exits(), "the guest outlived the kill");
        assert_eq!(failed, 0, "freezes failed during the vfork loop");
    }

}
