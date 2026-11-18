//! VM processes that die with nestd.
//!
//! - **Death signal:** every VM process (the process driver's guest, an unjailed Firecracker, the
//!   jailer) is spawned with `PR_SET_PDEATHSIG = SIGKILL`. The signal follows the *thread* that
//!   forked, so all of them are forked by one spawner thread that lives as long as nestd; the
//!   child enters the sandbox netns itself (`setns` before exec) instead of being forked from a
//!   short-lived thread inside it. The jailer drops its uid, which clears the signal: jailed VMMs
//!   are covered by their cgroup instead (`cgroup.rs`). If the spawner thread ever ends or panics,
//!   nestd aborts (systemd restarts it; the children die with it) rather than run on with VM
//!   processes whose death signal is gone.
//! - **OOM score:** the child resets `oom_score_adj` to 0 before exec. nestd runs at -900 (the
//!   unit's `OOMScoreAdjust`), which children inherit; a guest VMM must be what the kernel kills
//!   under memory pressure, never nestd.
//! - **Pidfile:** `<vm_dir>/pid` holds the pid and its start time; a starting nestd kills any
//!   process still matching one ([`kill_leftovers`], through a pidfd so a reused pid is never hit)
//!   before it sweeps the VM directories.

use std::io;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

use crate::net::Netns;

type Request = (Command, Option<Arc<Netns>>, bool, mpsc::Sender<io::Result<Child>>);

fn spawner() -> &'static Mutex<mpsc::Sender<Request>> {
    static SPAWNER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
    SPAWNER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Request>();
        std::thread::Builder::new()
            .name("vm-spawner".into())
            .spawn(move || {
                // Never returns while nestd runs: the death signal of every child is tied to it.
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    for (cmd, netns, session, reply) in rx {
                        let _ = reply.send(spawn_here(cmd, netns.as_deref(), session));
                    }
                }));
                tracing::error!(panicked = r.is_err(), "the VM spawner thread ended: aborting nestd");
                std::process::abort();
            })
            .expect("spawn the VM spawner thread");
        Mutex::new(tx)
    })
}

/// Spawn `cmd` (in `netns`, if given) so it is SIGKILLed when nestd dies.
pub fn spawn(cmd: Command, netns: Option<Arc<Netns>>) -> io::Result<Child> {
    request(cmd, netns, false)
}

/// [`spawn`], the child leading a session of its own (`setsid`): what it starts keeps its session
/// id, even once init adopts it, so the process driver finds the guest's whole tree (`tree.rs`).
pub fn spawn_in_session(cmd: Command, netns: Option<Arc<Netns>>) -> io::Result<Child> {
    request(cmd, netns, true)
}

fn request(cmd: Command, netns: Option<Arc<Netns>>, session: bool) -> io::Result<Child> {
    let (tx, rx) = mpsc::channel();
    spawner().lock().expect("spawner").send((cmd, netns, session, tx)).map_err(|_| io::Error::other("VM spawner thread is gone"))?;
    rx.recv().map_err(|_| io::Error::other("VM spawner thread is gone"))?
}

fn spawn_here(mut cmd: Command, netns: Option<&Netns>, session: bool) -> io::Result<Child> {
    let ns_fd = netns.map(|n| n.as_fd().as_raw_fd());
    let parent = std::process::id() as libc::pid_t;
    // SAFETY: between fork and exec only async-signal-safe syscalls (setns, setsid, prctl, getppid,
    // open, write, close), no allocation.
    unsafe {
        cmd.pre_exec(move || {
            if let Some(fd) = ns_fd
                && libc::setns(fd, libc::CLONE_NEWNET) != 0
            {
                return Err(io::Error::last_os_error());
            }
            if session && libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL as libc::c_ulong, 0, 0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            // nestd died between fork and prctl: the signal would never come.
            if libc::getppid() != parent {
                return Err(io::Error::from_raw_os_error(libc::ESRCH));
            }
            // Raising oom_score_adj needs no privilege; best effort (a failure keeps nestd's).
            let fd = libc::open(c"/proc/self/oom_score_adj".as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
            if fd >= 0 {
                let _ = libc::write(fd, b"0".as_ptr().cast(), 1);
                libc::close(fd);
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

/// How a VM process ended, read without reaping it (`waitid` with `WNOWAIT`): the driver's own
/// `wait` still collects it at stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Exit {
    /// It exited with this status (a guest that halted or rebooted: Firecracker exits 0).
    Status(i32),
    /// A signal killed it (9 from the kernel's OOM killer, among others).
    Signal(i32),
    /// It is gone, and how was not readable.
    Unknown,
}

impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Exit::Status(s) => write!(f, "exited with status {s}"),
            Exit::Signal(s) => write!(f, "killed by signal {s}"),
            Exit::Unknown => write!(f, "exited"),
        }
    }
}

/// A handle on a VM process that tells when it has exited. A pidfd, opened while the driver holds
/// the unreaped child, so it is that process and never a reused pid.
pub struct ExitWatch(std::os::fd::OwnedFd);

impl ExitWatch {
    pub fn of(child: &Child) -> io::Result<ExitWatch> {
        // SAFETY: a plain syscall on our own child's pid; a non-negative result is a new fd.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, child.id() as libc::pid_t, libc::PIDFD_NONBLOCK) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` was just returned by pidfd_open and is owned by nothing else.
        Ok(ExitWatch(unsafe { std::os::fd::FromRawFd::from_raw_fd(fd as i32) }))
    }

    /// A future that ends when the process has exited (a stopped process has not), with how. It
    /// owns a duplicate of the pidfd, so it outlives this handle and the driver's VM.
    pub fn exited(&self) -> io::Result<std::pin::Pin<Box<dyn Future<Output = Exit> + Send>>> {
        // SAFETY: the AsyncFd takes ownership of an `OwnedFd` (a duplicate of the pidfd): the
        // descriptor stays open and refers to the same process until the AsyncFd drops it
        // (RUSTSEC-2026-0386).
        let fd = unsafe { tokio::io::unix::AsyncFd::register_with_interest(self.0.try_clone()?, tokio::io::Interest::READABLE) }.map_err(io::Error::from)?;
        Ok(Box::pin(async move {
            // A pidfd turns readable when its process terminates, and stays so. An error says
            // nothing about the process (the runtime is going down): never an exit.
            match fd.readable().await {
                Ok(_) => exit_of(fd.get_ref()),
                Err(_) => std::future::pending().await,
            }
        }))
    }
}

fn exit_of(fd: &std::os::fd::OwnedFd) -> Exit {
    // SAFETY: zeroed is a valid siginfo_t for waitid to fill.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    // SAFETY: a pidfd we own; WNOWAIT leaves the child for its owner to reap.
    let r = unsafe { libc::waitid(libc::P_PIDFD, fd.as_raw_fd() as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    if r != 0 {
        return Exit::Unknown;
    }
    // SAFETY: waitid filled a SIGCHLD siginfo, whose status field this reads.
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Exit::Status(status),
        libc::CLD_KILLED | libc::CLD_DUMPED => Exit::Signal(status),
        _ => Exit::Unknown,
    }
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
        // Gone, or the pid now names another process: `kill_exact` leaves it alone.
        if kill_exact(pid, start) {
            tracing::warn!(pid, dir = %inc.path().display(), "killed a VM process left by a previous nestd");
            killed += 1;
        }
    }
    killed
}

/// SIGKILL `pid` only if it is still the process that started at `start`, and wait (up to 5 s)
/// for it to go. A pidfd pins the process, so the start time checked after opening it is the
/// killed process's own (no window for the pid to be reused in between).
fn kill_exact(pid: u32, start: u64) -> bool {
    // SAFETY: plain syscalls on integers we own; the fd is closed below.
    let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) } as libc::c_int;
    if pidfd < 0 {
        return false; // gone (or a kernel without pidfds, < 5.3)
    }
    let ok = start_time(pid) == Some(start) && unsafe { libc::syscall(libc::SYS_pidfd_send_signal, pidfd, libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0) } == 0;
    if ok {
        // Readable once the process has exited.
        let mut pfd = libc::pollfd { fd: pidfd, events: libc::POLLIN, revents: 0 };
        let _ = unsafe { libc::poll(&mut pfd, 1, 5000) };
    }
    unsafe { libc::close(pidfd) };
    ok
}

/// The process is there and not a zombie (a killed orphan is reaped by init soon after).
#[cfg(test)]
fn alive(pid: u32, start: u64) -> bool {
    start_time(pid) == Some(start)
        && !std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|s| s.lines().any(|l| l.starts_with("State:") && l.contains('Z')))
}

#[cfg(test)]
mod tests {

    use super::*;

    /// The exit watch ends when the child exits, with how, and leaves it for its owner to reap.
    #[tokio::test]
    async fn an_exit_watch_ends_with_how_the_child_ended_and_does_not_reap_it() {
        for (script, want) in [("exit 7", super::Exit::Status(7)), ("kill -9 $$", super::Exit::Signal(9))] {
            let mut child = Command::new("/bin/sh").args(["-c", script]).spawn().unwrap();
            let watch = super::ExitWatch::of(&child).unwrap();
            let exit = tokio::time::timeout(std::time::Duration::from_secs(10), watch.exited().unwrap()).await.expect("the child exited");
            assert_eq!(exit, want, "{script}");
            assert_eq!(exit.to_string(), if script == "exit 7" { "exited with status 7" } else { "killed by signal 9" });
            let status = child.wait().expect("still the owner's to reap");
            assert_eq!((status.code(), std::os::unix::process::ExitStatusExt::signal(&status)), if script == "exit 7" { (Some(7), None) } else { (None, Some(9)) });
        }
    }

    /// A stopped process (a paused VM of the process driver) has not exited: the watch waits on.
    #[tokio::test]
    async fn an_exit_watch_does_not_end_for_a_stopped_child() {
        let mut child = Command::new("/bin/sleep").arg("600").spawn().unwrap();
        let watch = super::ExitWatch::of(&child).unwrap();
        let mut exited = watch.exited().unwrap();
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGSTOP).unwrap();
        assert!(tokio::time::timeout(std::time::Duration::from_millis(300), &mut exited).await.is_err(), "a stopped child counted as exited");
        child.kill().unwrap();
        assert_eq!(tokio::time::timeout(std::time::Duration::from_secs(10), exited).await.expect("the child was killed"), super::Exit::Signal(9));
        child.wait().unwrap();
    }
    use std::time::{Duration, Instant};

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

    /// A VM process doesn't inherit nestd's low OOM score: under memory pressure the kernel kills
    /// a guest VMM, never nestd. A re-executed stand-in raises its own score (what an unprivileged
    /// test can do; nestd itself runs at -900) and spawns a child that reports its score.
    #[test]
    fn a_child_does_not_inherit_nestds_oom_score() {
        const MARK: &str = "NESTD_OOM_STANDIN";
        if let Some(out) = std::env::var_os(MARK) {
            if std::fs::write("/proc/self/oom_score_adj", "500").is_err() {
                std::fs::write(out, "skip").unwrap();
                return;
            }
            let mut c = Command::new("cat");
            c.arg("/proc/self/oom_score_adj").stdout(std::process::Stdio::piped());
            let child = spawn(c, None).unwrap().wait_with_output().unwrap();
            std::fs::write(out, child.stdout).unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("score");
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "driver::supervise::tests::a_child_does_not_inherit_nestds_oom_score", "--nocapture", "--test-threads=1"])
            .env(MARK, &out)
            .status()
            .unwrap();
        assert!(status.success());
        let got = std::fs::read_to_string(&out).expect("the stand-in ran this test");
        if got == "skip" {
            eprintln!("NEST-TEST-SKIP: a_child_does_not_inherit_nestds_oom_score: cannot raise oom_score_adj here");
            return;
        }
        assert_eq!(got.trim(), "0");
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
