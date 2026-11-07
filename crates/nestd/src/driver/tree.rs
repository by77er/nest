//! A process-driver guest's process tree: the guest and everything descended from it.
//!
//! The guest starts each Bash call, task and PTY in a session of its own (`setsid`), so signalling
//! the guest's pid, or its process group, reaches none of them: a "stopped" guest's agents ran on
//! as root, writing the loop-mounted disk, after a suspend, fence or destroy. The driver acts on the
//! whole tree instead.
//!
//! - **Freeze first.** [`freeze`] stops the guest, then every descendant, pass after pass, until a
//!   pass finds no new one and every process found is stopped (a stopped process can't fork, so
//!   the set can only grow while some are still running). Then [`signal_all`] sends the real
//!   signal (`SIGKILL`, `SIGCONT`) to exactly that set.
//! - **Never another process.** Each signal goes through a pidfd, after re-reading that the pid's
//!   parent is still in the tree, so a pid that exited and was reused is never hit. While its
//!   parent is stopped a process that exits stays a zombie, and its pid can't be reused.
//! - **The limit:** a process that leaves the tree (a daemon that double-forks, whose middle
//!   process exits before the freeze, is reparented to init) escapes. Containing that needs a
//!   cgroup or a pid namespace, which the process driver doesn't have. It is for development and
//!   the e2e harness only: a cell host runs Firecracker under the jailer
//!   (`config::cell_host_refusal`), whose VMM cgroup holds everything.

use std::collections::{BTreeMap, BTreeSet};

use nix::sys::signal::Signal;

/// Every process below `root` in `parents` (pid → parent pid), parents before their children.
/// Pure: the caller reads the table.
pub fn descendants(root: i32, parents: &BTreeMap<i32, i32>) -> Vec<i32> {
    let mut children: BTreeMap<i32, Vec<i32>> = BTreeMap::new();
    for (&pid, &ppid) in parents {
        if pid != ppid {
            children.entry(ppid).or_default().push(pid);
        }
    }
    let mut out = vec![];
    let mut seen = BTreeSet::from([root]);
    let mut todo = std::collections::VecDeque::from([root]);
    while let Some(p) = todo.pop_front() {
        for &c in children.get(&p).map(Vec::as_slice).unwrap_or_default() {
            if seen.insert(c) {
                out.push(c);
                todo.push_back(c);
            }
        }
    }
    out
}

/// One process's state and parent, from `/proc/<pid>/stat`. The command name (field 2) may hold
/// spaces and parentheses: fields are counted from the last `)`.
fn stat(pid: i32) -> Option<(char, i32)> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut rest = text.rsplit_once(')')?.1.split_whitespace();
    let state = rest.next()?.chars().next()?;
    let ppid = rest.next()?.parse().ok()?;
    Some((state, ppid))
}

/// pid → parent pid for every process now.
pub fn table() -> BTreeMap<i32, i32> {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(|pid| Some((pid, stat(pid)?.1)))
        .collect()
}

/// Stopped (`T`, `t`), dead or gone: it runs no more.
fn halted(pid: i32) -> bool {
    stat(pid).is_none_or(|(s, _)| matches!(s, 'T' | 't' | 'Z' | 'X' | 'x'))
}

/// Send `sig` to `pid` only while its parent is in `tree` (or it is `root`), through a pidfd so
/// the check and the signal name the same process. False if it is gone or no longer ours.
fn signal_ours(pid: i32, root: i32, tree: &BTreeSet<i32>, sig: Signal) -> bool {
    // SAFETY: plain syscalls on integers we own; the fd is closed below.
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
    if fd < 0 {
        return false;
    }
    let ours = pid == root || stat(pid).is_some_and(|(_, ppid)| tree.contains(&ppid));
    let sent = ours && unsafe { libc::syscall(libc::SYS_pidfd_send_signal, fd, sig as libc::c_int, std::ptr::null::<libc::siginfo_t>(), 0) } == 0;
    unsafe { libc::close(fd) };
    sent
}

/// Stop `root` and every process descended from it, until the tree is whole and halted. Returns
/// the tree, `root` first. Blocking (at most about a second for a tree that keeps forking).
pub fn freeze(root: i32) -> Vec<i32> {
    let mut tree = BTreeSet::from([root]);
    let mut order = vec![root];
    signal_ours(root, root, &tree, Signal::SIGSTOP);
    for _ in 0..500 {
        let new: Vec<i32> = descendants(root, &table()).into_iter().filter(|p| !tree.contains(p)).collect();
        if new.is_empty() && order.iter().all(|&p| halted(p)) {
            break;
        }
        for p in new {
            // Parents come first, so `p`'s parent is already in the tree.
            if signal_ours(p, root, &tree, Signal::SIGSTOP) {
                tree.insert(p);
                order.push(p);
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    order
}

/// Send `sig` to every process of a frozen `tree` (as [`freeze`] returned it), children first, so
/// a parent never sees a child's death before it has its own signal.
pub fn signal_all(tree: &[i32], sig: Signal) {
    let Some(&root) = tree.first() else { return };
    let set: BTreeSet<i32> = tree.iter().copied().collect();
    for &p in tree.iter().rev() {
        signal_ours(p, root, &set, sig);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn descendants_are_the_subtree_parents_first() {
        // 1 ─ 10 ─ 11 ─ 12
        //   └ 20        └ 13
        // 30 ─ 31 (another tree)
        let t = BTreeMap::from([(1, 0), (10, 1), (11, 10), (12, 11), (13, 11), (20, 1), (30, 0), (31, 30)]);
        assert_eq!(descendants(10, &t), [11, 12, 13]);
        assert_eq!(descendants(1, &t), [10, 20, 11, 12, 13]);
        assert!(descendants(12, &t).is_empty());
        assert!(descendants(99, &t).is_empty(), "not in the table");
    }

    #[test]
    fn a_self_parented_entry_never_loops() {
        let t = BTreeMap::from([(1, 1), (2, 1), (3, 2)]);
        assert_eq!(descendants(1, &t), [2, 3]);
    }
}
