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
//!   member is the guest, a process in its session, or a descendant of a member ([`members`]).
//! - **Freeze first.** [`Tree::freeze`] stops the guest, then every member, pass after pass, and
//!   stops again any member that runs again (a SIGCONT from inside, a job-control SIGCONT), until a
//!   pass finds no new member and every member is stopped: a stopped process can't fork, so the set
//!   can only grow while some still run. It gives up after [`FREEZE_BUDGET`] with an error.
//! - **Never another process.** A pidfd is opened for each member when it is found, after its
//!   parent or session was read and before it is signalled, and kept: every later signal goes
//!   through it, so a pid that exited and was reused is never hit, and a member whose parent
//!   exited is still reached.
//! - **Resume is transparent.** [`Tree::thaw`] continues exactly the processes the freezes
//!   stopped; one an agent had stopped itself (`kill -STOP`, a suspended job) stays stopped.
//! - **The limit:** a process that leaves both the tree and the session (a PTY's own session whose
//!   leader exited, a daemon that calls `setsid` and whose parent exited) escapes. Containing that
//!   needs a cgroup or a pid namespace, which the process driver doesn't have. It is for
//!   development and the e2e harness only (`config::unconfined_driver_refusal`); a cell host runs
//!   Firecracker under the jailer, whose VMM cgroup holds everything.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;

/// How long a freeze keeps trying before it says which processes it couldn't stop.
pub const FREEZE_BUDGET: Duration = Duration::from_secs(1);

/// What `/proc/<pid>/stat` says of one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub state: char,
    pub ppid: i32,
    pub session: i32,
}

/// Every member of `root`'s tree in `table` but `root`: its session's processes, and every
/// descendant of `root` or of one of them, parents before their children. Pure.
pub fn members(root: i32, table: &BTreeMap<i32, Stat>) -> Vec<i32> {
    let mut children: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for (&pid, s) in table {
        if pid != s.ppid {
            children.entry(s.ppid).or_default().push(pid);
        }
    }
    let mut out = vec![];
    let mut seen = BTreeSet::from([root]);
    let mut todo = VecDeque::from([root]);
    let in_session = table.iter().filter(|(pid, s)| s.session == root && **pid != root).map(|(pid, _)| *pid);
    for start in std::iter::once(None).chain(in_session.map(Some)) {
        if let Some(p) = start {
            if !seen.insert(p) {
                continue;
            }
            out.push(p);
            todo.push_back(p);
        }
        while let Some(p) = todo.pop_front() {
            for &c in children.get(&p).map(Vec::as_slice).unwrap_or_default() {
                if seen.insert(c) {
                    out.push(c);
                    todo.push_back(c);
                }
            }
        }
    }
    out
}

/// One process's state, parent and session. The command name (field 2) may hold spaces and
/// parentheses: fields are counted from the last `)`.
fn stat(pid: i32) -> Option<Stat> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut rest = text.rsplit_once(')')?.1.split_whitespace();
    let state = rest.next()?.chars().next()?;
    let ppid = rest.next()?.parse().ok()?;
    let _pgrp = rest.next()?;
    let session = rest.next()?.parse().ok()?;
    Some(Stat { state, ppid, session })
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
    if fd < 0 {
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
}

impl Member {
    /// Stopped, dead or gone: it runs no more. Checked through the pidfd first, so a pid reused
    /// after an exit never reads as this member.
    fn halted(&self) -> bool {
        exited(&self.fd) || stat(self.pid).is_none_or(|s| matches!(s.state, 'T' | 't' | 'Z' | 'X' | 'x')) || exited(&self.fd)
    }
}

/// One guest's process tree, as the driver has seen it.
pub struct Tree {
    root: i32,
    /// Every member found, the guest first and parents before children, each pinned by its pidfd.
    members: Vec<Member>,
    /// The members a freeze stopped (and no thaw has continued since).
    stopped: BTreeSet<i32>,
}

impl Tree {
    /// The tree of the guest `root` (a child of nestd, not yet reaped).
    pub fn new(root: i32) -> io::Result<Tree> {
        Ok(Tree { root, members: vec![Member { pid: root, fd: pidfd_open(root)? }], stopped: BTreeSet::new() })
    }

    /// Stop every member (see the module docs). An error when the guest can't be signalled, or
    /// when [`FREEZE_BUDGET`] ran out with members still running; whatever was found is kept, so
    /// a kill after a failed freeze still reaches it. Blocking.
    pub fn freeze(&mut self) -> io::Result<()> {
        let deadline = Instant::now() + FREEZE_BUDGET;
        let root = &self.members[0];
        let was_halted = root.halted();
        send(&root.fd, Signal::SIGSTOP).map_err(|e| io::Error::new(e.kind(), format!("stopping the guest: {e}")))?;
        if !was_halted {
            self.stopped.insert(self.root);
        }
        let mut known: BTreeSet<i32> = self.members.iter().map(|m| m.pid).collect();
        loop {
            let t = table();
            let mut found = false;
            for pid in members(self.root, &t) {
                if known.contains(&pid) {
                    continue;
                }
                // Pinned first, then checked: what the pidfd names is a member now.
                let Ok(fd) = pidfd_open(pid) else { continue };
                let ours = |s: Stat| s.session == self.root || self.members.iter().any(|m| m.pid == s.ppid);
                let Some(s) = stat(pid).filter(|s| ours(*s)) else { continue };
                let m = Member { pid, fd };
                let was_halted = matches!(s.state, 'T' | 't');
                if send(&m.fd, Signal::SIGSTOP).is_ok() && !was_halted {
                    self.stopped.insert(pid);
                }
                known.insert(pid);
                self.members.push(m);
                found = true;
            }
            // A member that runs again (a SIGCONT from inside the tree, a job-control SIGCONT) is
            // stopped again.
            let mut running = 0;
            for m in &self.members {
                if !m.halted() {
                    running += 1;
                    if send(&m.fd, Signal::SIGSTOP).is_ok() {
                        self.stopped.insert(m.pid);
                    }
                }
            }
            if !found && running == 0 {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, format!("{running} of the guest's {} processes didn't stop", self.members.len())));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Continue what the freezes stopped, and forget the members that have exited.
    pub fn thaw(&mut self) {
        for m in &self.members {
            if self.stopped.contains(&m.pid) {
                let _ = send(&m.fd, Signal::SIGCONT);
            }
        }
        self.stopped.clear();
        let root = self.root;
        self.members.retain(|m| m.pid == root || !exited(&m.fd));
    }

    /// Freeze (as far as it goes), then kill every member, children first, so a parent never
    /// sees a child die before it has its own signal.
    pub fn kill(&mut self) {
        if let Err(e) = self.freeze() {
            tracing::warn!(guest = self.root, error = %e, "killing a guest's processes not all of which stopped");
        }
        for m in self.members.iter().rev() {
            let _ = send(&m.fd, Signal::SIGKILL);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ppid: i32, session: i32) -> Stat {
        Stat { state: 'S', ppid, session }
    }

    #[test]
    fn members_are_the_subtree_parents_first() {
        // 1 ─ 10 ─ 11 ─ 12      (10 and 20 in session 10's, so not 1's)
        //   └ 20        └ 13
        // 30 ─ 31 (another tree, another session)
        let t = BTreeMap::from([(1, s(0, 1)), (10, s(1, 10)), (11, s(10, 10)), (12, s(11, 10)), (13, s(11, 10)), (20, s(1, 1)), (30, s(0, 30)), (31, s(30, 30))]);
        assert_eq!(members(10, &t), [11, 12, 13]);
        assert_eq!(members(1, &t), [10, 20, 11, 12, 13]);
        assert!(members(12, &t).is_empty());
        assert!(members(99, &t).is_empty(), "not in the table");
    }

    #[test]
    fn an_orphan_in_the_guests_session_is_a_member_with_its_children() {
        // The guest 5 started a call 6, which started 7 and exited: init (1) adopted 7, still in
        // session 5. 8 is 7's child. 9 is init's child in another session: not a member.
        let t = BTreeMap::from([(1, s(0, 1)), (5, s(1, 5)), (7, s(1, 5)), (8, s(7, 5)), (9, s(1, 9))]);
        assert_eq!(members(5, &t), [7, 8]);
    }

    #[test]
    fn a_member_in_another_session_is_found_through_its_parent() {
        // A PTY: 6 is the guest's child in a session of its own, 7 its child.
        let t = BTreeMap::from([(5, s(1, 5)), (6, s(5, 6)), (7, s(6, 6))]);
        assert_eq!(members(5, &t), [6, 7]);
    }

    #[test]
    fn a_self_parented_entry_never_loops() {
        let t = BTreeMap::from([(1, s(1, 1)), (2, s(1, 2)), (3, s(2, 2))]);
        assert_eq!(members(1, &t), [2, 3]);
    }
}
