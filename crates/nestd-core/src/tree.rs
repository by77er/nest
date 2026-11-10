//! The pure rules of a process-driver guest's process tree (`nestd::driver::tree`, which reads
//! `/proc`, holds the pidfds and sends the signals): which processes are members, which of them a
//! freeze's pass may stop, the order a thaw continues them in, when a process runs no more, and
//! which processes are never signalled whatever the rest decided.

use alloc::collections::{BTreeMap, BTreeSet, VecDeque};
use alloc::vec;
use alloc::vec::Vec;

/// What `/proc/<pid>/stat` says of one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stat {
    pub state: char,
    pub ppid: i32,
    pub session: i32,
    /// When it started, in clock ticks since boot.
    pub start: u64,
}

/// Why `pid` (which `table` says started at `start`) is never signalled as a member of a guest
/// that started at `guest_start`, whatever the membership rules said: it is no process id, init,
/// nestd itself (`own`) or an ancestor of it, or a process older than the guest (a member is the
/// guest or was started after it). A bug in finding members then costs a refusal, not the host's
/// own processes. Pure.
pub fn refusal(pid: i32, start: u64, own: i32, guest_start: u64, table: &BTreeMap<i32, Stat>) -> Option<&'static str> {
    if pid <= 0 {
        return Some("not a process id");
    }
    if pid == 1 {
        return Some("init");
    }
    if pid == own {
        return Some("nestd itself");
    }
    let mut seen = BTreeSet::from([own]);
    let mut p = own;
    while let Some(parent) = table.get(&p).map(|s| s.ppid).filter(|pp| seen.insert(*pp)) {
        if parent == pid {
            return Some("an ancestor of nestd");
        }
        p = parent;
    }
    if start < guest_start {
        return Some("older than the guest");
    }
    None
}

/// Every member of `root`'s tree in `table` but `root`: its session's processes, the `pinned`
/// members still in the table (one that left the tree and the session after it was found is still
/// a member), and every descendant of `root` or of one of them, parents before their children.
/// Pure.
pub fn members(root: i32, pinned: &BTreeSet<i32>, table: &BTreeMap<i32, Stat>) -> Vec<i32> {
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
    let still_pinned = pinned.iter().copied().filter(|p| table.contains_key(p));
    for start in core::iter::once(None).chain(in_session.chain(still_pinned).map(Some)) {
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

/// `table` without the processes [`refusal`] names for a guest that started at `guest_start`
/// under the nestd `own`. Membership is found over this table, so a refused process is never a
/// candidate, and neither is anything reached only through it (its other children). Pure.
pub fn signallable(own: i32, guest_start: u64, table: &BTreeMap<i32, Stat>) -> BTreeMap<i32, Stat> {
    table.iter().filter(|(pid, s)| refusal(**pid, s.start, own, guest_start, table).is_none()).map(|(pid, s)| (*pid, *s)).collect()
}

/// SIGSTOP's number on Linux (every architecture nestd runs on).
const SIGSTOP: u32 = 19;

/// Whether SIGSTOP is pending in a task's `/proc/<pid>/task/<tid>/status` text (`SigPnd`, the
/// thread's own, or `ShdPnd`, the process-wide set): it stops the moment it leaves the kernel, so
/// it runs no user code again. Pure.
pub fn stop_pending_in(status: &str) -> bool {
    let bit = 1u64 << (SIGSTOP - 1);
    status
        .lines()
        .filter_map(|l| l.strip_prefix("SigPnd:").or_else(|| l.strip_prefix("ShdPnd:")))
        .any(|v| u64::from_str_radix(v.trim(), 16).is_ok_and(|m| m & bit != 0))
}

/// Whether a process in `state` runs no user code again: stopped, dead, or in an uninterruptible
/// wait with SIGSTOP pending (a vfork parent whose child is stopped, a write throttled on dirty
/// pages: it stops the moment it leaves the kernel). `stop_pending` is read only for `D`. Pure.
pub fn runs_no_more(state: char, stop_pending: impl FnOnce() -> bool) -> bool {
    matches!(state, 'T' | 't' | 'Z' | 'X' | 'x') || (state == 'D' && stop_pending())
}

/// Which processes a freeze's pass may stop now, in order: each candidate ([`members`] of
/// `root`'s tree in `table`, given what is `pinned`) that isn't `halted` yet, but only once its
/// parent has stopped, unless the parent is outside the tree (init, for an orphan or a member that
/// left the guest's session). A child stopped while its parent still runs (its SIGSTOP not yet
/// taken) would show a parent waiting with WUNTRACED its job stopping; it waits for a later pass.
/// `halted` is a snapshot taken before the pass. Pure.
pub fn stop_now(root: i32, table: &BTreeMap<i32, Stat>, pinned: &BTreeSet<i32>, halted: &BTreeSet<i32>) -> Vec<i32> {
    let found = members(root, pinned, table);
    let tree: BTreeSet<i32> = core::iter::once(root).chain(found.iter().copied()).collect();
    core::iter::once(root)
        .chain(found)
        .filter(|p| !halted.contains(p))
        .filter(|p| match table.get(p) {
            Some(s) if *p != root => !tree.contains(&s.ppid) || halted.contains(&s.ppid),
            _ => true,
        })
        .collect()
}

/// `pids` ordered deepest first by their parents within the set (`parent`), so a child is
/// continued before its parent. Pure.
pub fn deepest_first(pids: &[i32], parent: impl Fn(i32) -> Option<i32>) -> Vec<i32> {
    let set: BTreeSet<i32> = pids.iter().copied().collect();
    let depth = |mut p: i32| {
        let mut d = 0usize;
        let mut seen = BTreeSet::new();
        while let Some(pp) = parent(p).filter(|pp| set.contains(pp) && seen.insert(*pp)) {
            d += 1;
            p = pp;
        }
        d
    };
    let mut out: Vec<(usize, i32)> = pids.iter().map(|&p| (depth(p), p)).collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    out.into_iter().map(|(_, p)| p).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ppid: i32, session: i32) -> Stat {
        Stat { state: 'S', ppid, session, start: 100 }
    }

    fn none() -> BTreeSet<i32> {
        BTreeSet::new()
    }

    /// Each process a bug in finding members could name and that must never be signalled: no
    /// process id, init, nestd, nestd's ancestors, and anything older than the guest.
    #[test]
    fn some_processes_are_never_a_guests() {
        // init ─ 50 (a shell) ─ 60 (nestd) ─ 70 (the guest, started at 100) ─ 71
        //      └ 40 (another sandbox's guest, started at 90)
        let t = BTreeMap::from([(1, s(0, 1)), (50, s(1, 50)), (60, s(50, 50)), (70, s(60, 70)), (71, s(70, 70)), (40, s(1, 40))]);
        let refusal = |pid, start| refusal(pid, start, 60, 100, &t);
        assert_eq!(refusal(0, 100), Some("not a process id"), "0 would signal nestd's own process group");
        assert_eq!(refusal(-1, 100), Some("not a process id"), "-1 would signal every process");
        assert_eq!(refusal(-70, 100), Some("not a process id"), "a negative pid is a process group");
        assert_eq!(refusal(1, 100), Some("init"));
        assert_eq!(refusal(60, 100), Some("nestd itself"));
        assert_eq!(refusal(50, 100), Some("an ancestor of nestd"));
        assert_eq!(refusal(40, 90), Some("older than the guest"));
        assert_eq!(refusal(70, 100), None, "the guest");
        assert_eq!(refusal(71, 105), None, "its child");
        // A parent chain that loops (a table read mid-change) ends.
        let looped = BTreeMap::from([(60, s(61, 60)), (61, s(60, 60))]);
        assert_eq!(super::refusal(70, 100, 60, 100, &looped), None);
        assert_eq!(super::refusal(61, 100, 60, 100, &looped), Some("an ancestor of nestd"));
    }

    /// The parent-first rule over a snapshot: guest 1 (stopped) → A 2 (a member still running)
    /// → B 3 → C 4, all in the guest's session, plus an orphan 5 (init's child, in the session)
    /// and its child 6. Only what has no running parent in the tree may be stopped now.
    #[test]
    fn a_pass_stops_a_process_only_once_its_parent_has() {
        let t = BTreeMap::from([(1, s(0, 1)), (2, s(1, 1)), (3, s(2, 1)), (4, s(3, 1)), (5, s(0, 1)), (6, s(5, 1)), (9, s(0, 9))]);
        let none = BTreeSet::new();
        let halted = BTreeSet::from([1]);
        assert_eq!(stop_now(1, &t, &none, &halted), [2, 5], "A (its parent stopped) and the orphan (init's child); not B, C or 6 yet");
        let halted = BTreeSet::from([1, 2, 5]);
        assert_eq!(stop_now(1, &t, &none, &halted), [3, 6], "a level further down each pass");
        let halted = BTreeSet::from([1, 2, 3, 5, 6]);
        assert_eq!(stop_now(1, &t, &none, &halted), [4]);
        assert_eq!(stop_now(1, &t, &none, &BTreeSet::new()), [1, 5], "the guest first; never 9, outside the tree");
        // 9 was pinned while in the tree, then left it (its parent exited, its own session): still
        // stopped, as an orphan, or it would count as running for ever.
        assert_eq!(stop_now(1, &t, &BTreeSet::from([1, 9]), &BTreeSet::from([1, 2, 3, 4, 5, 6])), [9]);
    }

    #[test]
    fn continuing_goes_deepest_first() {
        let parent = |p: i32| BTreeMap::from([(2, 1), (3, 2), (4, 3), (6, 5), (5, 0), (1, 0)]).get(&p).copied();
        assert_eq!(deepest_first(&[1, 2, 3, 4, 5, 6], parent), [4, 3, 2, 6, 1, 5]);
        assert_eq!(deepest_first(&[2, 4], parent), [2, 4], "depth counts only parents in the set");
        let cycle = |p: i32| Some(if p == 1 { 2 } else { 1 });
        assert_eq!(deepest_first(&[1, 2], cycle).len(), 2, "a cycle ends");
    }

    #[test]
    fn a_process_runs_no_more_once_stopped_dead_or_stopping_in_the_kernel() {
        for s in ['T', 't', 'Z', 'X', 'x'] {
            assert!(runs_no_more(s, || panic!("read only for D")), "{s}");
        }
        assert!(runs_no_more('D', || true), "an uninterruptible wait with SIGSTOP pending");
        assert!(!runs_no_more('D', || false), "an uninterruptible wait that will run on");
        for s in ['R', 'S', 'I', 'W', 'P'] {
            assert!(!runs_no_more(s, || true), "{s} runs, whatever is pending");
        }
    }

    #[test]
    fn members_are_the_subtree_parents_first() {
        // 1 ─ 10 ─ 11 ─ 12      (10 and 20 in session 10's, so not 1's)
        //   └ 20        └ 13
        // 30 ─ 31 (another tree, another session)
        let t = BTreeMap::from([(1, s(0, 1)), (10, s(1, 10)), (11, s(10, 10)), (12, s(11, 10)), (13, s(11, 10)), (20, s(1, 1)), (30, s(0, 30)), (31, s(30, 30))]);
        assert_eq!(members(10, &none(), &t), [11, 12, 13]);
        assert_eq!(members(1, &none(), &t), [10, 20, 11, 12, 13]);
        assert!(members(12, &none(), &t).is_empty());
        assert!(members(99, &none(), &t).is_empty(), "not in the table");
    }

    #[test]
    fn an_orphan_in_the_guests_session_is_a_member_with_its_children() {
        // The guest 5 started a call 6, which started 7 and exited: init (1) adopted 7, still in
        // session 5. 8 is 7's child. 9 is init's child in another session: not a member.
        let t = BTreeMap::from([(1, s(0, 1)), (5, s(1, 5)), (7, s(1, 5)), (8, s(7, 5)), (9, s(1, 9))]);
        assert_eq!(members(5, &none(), &t), [7, 8]);
    }

    /// A member that left the tree and the session after it was pinned (a `setsid` server whose
    /// call returned: init's child, session 9) is still a member, and so is what it forks; a pinned
    /// pid no longer in the table is not.
    #[test]
    fn a_pinned_member_that_left_brings_its_descendants() {
        let t = BTreeMap::from([(1, s(0, 1)), (5, s(1, 5)), (9, s(1, 9)), (10, s(9, 9)), (11, s(10, 9)), (20, s(1, 20))]);
        assert_eq!(members(5, &none(), &t), Vec::<i32>::new(), "unpinned, 9 is out of reach");
        assert_eq!(members(5, &BTreeSet::from([5, 9, 42]), &t), [9, 10, 11]);
        // Parents first among them too: 10 waits for 9, 11 for 10.
        let pinned = BTreeSet::from([5, 9]);
        assert_eq!(stop_now(5, &t, &pinned, &BTreeSet::from([5])), [9]);
        assert_eq!(stop_now(5, &t, &pinned, &BTreeSet::from([5, 9])), [10]);
        assert_eq!(stop_now(5, &t, &pinned, &BTreeSet::from([5, 9, 10])), [11]);
    }

    #[test]
    fn a_member_in_another_session_is_found_through_its_parent() {
        // A PTY: 6 is the guest's child in a session of its own, 7 its child.
        let t = BTreeMap::from([(5, s(1, 5)), (6, s(5, 6)), (7, s(6, 6))]);
        assert_eq!(members(5, &none(), &t), [6, 7]);
    }

    #[test]
    fn a_self_parented_entry_never_loops() {
        let t = BTreeMap::from([(1, s(1, 1)), (2, s(1, 2)), (3, s(2, 2))]);
        assert_eq!(members(1, &none(), &t), [2, 3]);
        assert_eq!(stop_now(1, &t, &BTreeSet::new(), &BTreeSet::new()), [1], "the guest goes first, whatever its parent");
    }

    /// A refused process is no candidate, and neither is what is reached only through it. Here a
    /// bug has pinned 50, an ancestor of nestd (60): over the whole table its subtree would be
    /// members, nestd and nestd's other children (another guest, 80) included.
    #[test]
    fn a_refused_process_and_what_hangs_off_it_are_never_candidates() {
        // init ─ 50 ─ 60 (nestd) ─ 70 (the guest) ─ 71
        //           │            └ 80 (another guest, younger) ─ 81
        //           └ 55
        let young = |ppid, session| Stat { start: 200, ..s(ppid, session) };
        let t = BTreeMap::from([(1, s(0, 1)), (50, s(1, 50)), (60, s(50, 50)), (55, young(50, 50)), (70, s(60, 70)), (71, young(70, 70)), (80, young(60, 80)), (81, young(80, 80))]);
        let pinned = BTreeSet::from([70, 50]);
        assert_eq!(members(70, &pinned, &t), [71, 50, 55, 60, 80, 81], "over the whole table: nestd, and all it runs");
        let ok = signallable(60, 100, &t);
        assert_eq!(ok.keys().copied().collect::<Vec<_>>(), [55, 70, 71, 80, 81], "init, nestd and its ancestor are gone");
        assert_eq!(members(70, &pinned, &ok), [71], "the guest's own child, nothing else");
        assert_eq!(stop_now(70, &ok, &pinned, &none()), [70]);
        // A process older than the guest goes too, with what hangs off it alone.
        let t = BTreeMap::from([(60, s(1, 60)), (70, s(60, 70)), (40, Stat { start: 90, ..s(70, 70) }), (41, young(40, 40))]);
        assert_eq!(members(70, &none(), &signallable(60, 100, &t)), Vec::<i32>::new());
        assert_eq!(members(70, &none(), &t), [40, 41]);
    }

    #[test]
    fn a_pending_sigstop_is_read_from_the_threads_or_the_process_set() {
        let status = |sig: &str, shd: &str| alloc::format!("Name:\tsleep\nSigQ:\t0/1\nSigPnd:\t{sig}\nShdPnd:\t{shd}\nSigBlk:\t0000000000040000\n");
        assert!(stop_pending_in(&status("0000000000040000", "0000000000000000")), "the thread's own set");
        assert!(stop_pending_in(&status("0000000000000000", "0000000000040000")), "the process-wide set");
        assert!(stop_pending_in(&status("0000000000000000", "00000000000c0100")), "among other signals");
        assert!(!stop_pending_in(&status("0000000000000000", "0000000000000000")));
        // Its neighbours (SIGCHLD 17, SIGCONT 18, SIGTSTP 20) and a blocked SIGSTOP are not it.
        assert!(!stop_pending_in(&status("0000000000010000", "00000000000a0000")));
        assert!(!stop_pending_in("SigBlk:\t0000000000040000\nSigCgt:\t0000000000040000\n"), "only the pending sets count");
        assert!(!stop_pending_in("SigPnd:\tnot hex\n"));
        assert!(!stop_pending_in(""));
    }
}
