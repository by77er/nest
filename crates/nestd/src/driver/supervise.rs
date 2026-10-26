//! VM processes that die with nestd.
//!
//! - **Death signal:** every VM process (the process driver's guest, an unjailed Firecracker, the
//!   jailer) is spawned with `PR_SET_PDEATHSIG = SIGKILL`. The signal follows the *thread* that
//!   forked, so all of them are forked by one spawner thread that lives as long as nestd; the
//!   child enters the sandbox netns itself (`setns` before exec) instead of being forked from a
//!   short-lived thread inside it. The jailer drops its uid, which clears the signal: jailed VMMs
//!   are covered by their cgroup instead (`cgroup.rs`).
//! - **Pidfile:** `<vm_dir>/pid` holds the pid and its start time; a starting nestd kills any
//!   process still matching one ([`kill_leftovers`]) before it sweeps the VM directories.

use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::net::Netns;

type Request = (Command, Option<Arc<Netns>>, mpsc::Sender<io::Result<Child>>);

fn spawner() -> &'static Mutex<mpsc::Sender<Request>> {
    static SPAWNER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
    SPAWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::Builder::new()
            .name("vm-spawner".into())
            .spawn(move || {
                // Never returns while nestd runs: the death signal of every child is tied to it.
                for (cmd, netns, reply) in rx {
                    let _ = reply.send(spawn_here(cmd, netns.as_deref()));
                }
            })
            .expect("spawn the VM spawner thread");
        Mutex::new(tx)
    })
}

/// Spawn `cmd` (in `netns`, if given) so it is SIGKILLed when nestd dies.
pub fn spawn(cmd: Command, netns: Option<Arc<Netns>>) -> io::Result<Child> {
    let (tx, rx) = mpsc::channel();
    spawner().lock().expect("spawner").send((cmd, netns, tx)).map_err(|_| io::Error::other("VM spawner thread is gone"))?;
    rx.recv().map_err(|_| io::Error::other("VM spawner thread is gone"))?
}

fn spawn_here(mut cmd: Command, netns: Option<&Netns>) -> io::Result<Child> {
    let ns_fd = netns.map(|n| n.as_fd().as_raw_fd());
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: only async-signal-safe calls (setns, prctl, getppid) between fork and exec.
    unsafe {
        cmd.pre_exec(move || {
            if let Some(fd) = ns_fd
                && libc::setns(fd, libc::CLONE_NEWNET) != 0
            {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // nestd died between fork and prctl: the signal would never come.
            if libc::getppid() != parent {
                return Err(io::Error::other("parent exited during spawn"));
            }
            Ok(())
        });
    }
    cmd.spawn()
}

/// Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot): with the pid it names one
/// process, so a reused pid is never killed.
fn start_time(pid: u32) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name (field 2) may contain spaces and parentheses: count from the last ')'.
    stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
}

/// Record a VM process in `<vm_dir>/pid`.
pub fn write_pidfile(vm_dir: &Path, pid: u32) -> io::Result<()> {
    let start = start_time(pid).ok_or_else(|| io::Error::other(format!("no /proc entry for pid {pid}")))?;
    std::fs::write(vm_dir.join("pid"), format!("{pid} {start}\n"))
}

/// Kill every process named by a `pid` file under `vms_dir/<sandbox>/<epoch>/` that is still the
/// same process (pid and start time), and wait for each to go. Returns how many were killed.
pub fn kill_leftovers(vms_dir: &Path) -> usize {
    let mut killed = 0;
    let incarnations = std::fs::read_dir(vms_dir).into_iter().flatten().flatten().flat_map(|s| std::fs::read_dir(s.path()).into_iter().flatten().flatten());
    for inc in incarnations {
        let Ok(text) = std::fs::read_to_string(inc.path().join("pid")) else { continue };
        let mut it = text.split_whitespace().map(|f| f.parse::<u64>().ok());
        let (Some(Some(pid)), Some(Some(start))) = (it.next(), it.next()) else { continue };
        let pid = pid as u32;
        if start_time(pid) != Some(start) {
            continue; // gone, or the pid was reused
        }
        tracing::warn!(pid, dir = %inc.path().display(), "killing a VM process left by a previous nestd");
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGKILL);
        killed += 1;
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive(pid, start) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    killed
}

/// The process is there and not a zombie (a killed orphan is reaped by init soon after).
fn alive(pid: u32, start: u64) -> bool {
    start_time(pid) == Some(start)
        && !std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|s| s.lines().any(|l| l.starts_with("State:") && l.contains('Z')))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A child spawned from a thread that then exits keeps running: the death signal follows the
    /// spawner thread, not the caller (forking from a short-lived thread would kill it at once).
    #[test]
    fn a_child_outlives_the_thread_that_asked_for_it() {
        let child = std::thread::spawn(|| {
            let mut c = Command::new("sleep");
            c.arg("30");
            spawn(c, None).unwrap()
        })
        .join()
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let pid = child.id();
        let start = start_time(pid).unwrap();
        assert!(alive(pid, start), "the child died with the thread that requested it");
        let mut child = child;
        let _ = child.kill();
        let _ = child.wait();
    }

    /// When the nestd process dies, its VM processes die too. The test re-executes itself as a
    /// stand-in nestd that spawns a child and exits; the child must be gone soon after.
    #[test]
    fn a_child_dies_with_nestd() {
        const MARK: &str = "NESTD_PDEATH_STANDIN";
        if let Some(out) = std::env::var_os(MARK) {
            let mut c = Command::new("sleep");
            c.arg("30");
            let child = spawn(c, None).unwrap();
            std::fs::write(out, child.id().to_string()).unwrap();
            std::process::exit(0); // no destructors: like a crash
        }
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("pid");
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "driver::supervise::tests::a_child_dies_with_nestd", "--nocapture", "--test-threads=1"])
            .env(MARK, &out)
            .status()
            .unwrap();
        assert!(status.success());
        let pid: u32 = std::fs::read_to_string(&out).expect("the stand-in ran this test").trim().parse().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while start_time(pid).is_some_and(|s| alive(pid, s)) {
            assert!(Instant::now() < deadline, "the child outlived its nestd");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// A VM process starts inside the sandbox netns (it enters it itself, before exec).
    #[test]
    fn a_child_starts_in_the_sandbox_netns() {
        if !crate::net::reexec_in_userns("driver::supervise::tests::a_child_starts_in_the_sandbox_netns") {
            return;
        }
        let ns = Arc::new(Netns::create(None).unwrap());
        let want = ns.run(|| std::fs::read_link("/proc/thread-self/ns/net")).unwrap();
        let mut c = Command::new("readlink");
        c.arg("/proc/self/ns/net").stdout(std::process::Stdio::piped());
        let out = spawn(c, Some(ns)).unwrap().wait_with_output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), want.display().to_string());
        assert_ne!(std::fs::read_link("/proc/self/ns/net").unwrap(), want, "the test itself is in another netns");
    }

    /// A pidfile naming a live process (same start time) gets it killed; one whose pid now names
    /// a different process (start time differs) is left alone.
    #[test]
    fn leftovers_are_killed_by_pid_and_start_time() {
        let dir = tempfile::tempdir().unwrap();
        let mut victim = Command::new("sleep").arg("30").spawn().unwrap();
        let mut bystander = Command::new("sleep").arg("30").spawn().unwrap();
        let a = dir.path().join("sbx_a/1");
        let b = dir.path().join("sbx_b/3");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        write_pidfile(&a, victim.id()).unwrap();
        let start = start_time(bystander.id()).unwrap();
        std::fs::write(b.join("pid"), format!("{} {}\n", bystander.id(), start + 1)).unwrap();
        assert_eq!(kill_leftovers(dir.path()), 1);
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(victim.wait().unwrap().signal(), Some(libc::SIGKILL), "the leftover was not killed");
        assert!(bystander.try_wait().unwrap().is_none(), "a reused pid was killed");
        let _ = bystander.kill();
        let _ = bystander.wait();
    }
}
