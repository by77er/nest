//! Spawning processes in an agent's context: environment, process group, cgroup, user. Also the
//! per-thread filesystem identity used by the in-process file tools.

use std::ffi::CString;
use std::io::Read;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nest_protocol::guest::AgentSlot;
use nix::sys::signal::{Signal, killpg};
use nix::unistd::{Pid, Uid, User};
use tokio::process::{Child, Command};

use crate::cgroup::Cgroups;

/// `HOME`/`USER`/`LOGNAME`/`SHELL` for `uid` from the passwd database.
pub fn user_env(uid: u32) -> Vec<(String, String)> {
    let Ok(Some(u)) = User::from_uid(Uid::from_raw(uid)) else {
        return vec![("HOME".into(), "/".into())];
    };
    let shell = u.shell.to_string_lossy().into_owned();
    vec![
        ("HOME".into(), u.dir.to_string_lossy().into_owned()),
        ("USER".into(), u.name.clone()),
        ("LOGNAME".into(), u.name),
        ("SHELL".into(), if shell.is_empty() { "/bin/sh".into() } else { shell }),
    ]
}

/// Environment for anything run on an agent's behalf: our own env (the image base env), then the
/// user identity when we drop privileges, then the slot env, then the nest variables.
pub fn agent_env(slot: &AgentSlot, run_as: Option<(u32, u32)>) -> Vec<(String, String)> {
    let mut env = base_env(run_as);
    for (k, v) in &slot.env {
        set(&mut env, k, v.clone());
    }
    let proxy = format!("http://172.16.0.1:{}", slot.proxy_port);
    let fixed = [
        ("NEST_AGENT_ID", slot.agent_id.0.clone()),
        ("HTTP_PROXY", proxy.clone()),
        ("HTTPS_PROXY", proxy.clone()),
        ("http_proxy", proxy.clone()),
        ("https_proxy", proxy),
        ("NO_PROXY", "localhost,127.0.0.1,::1".to_string()),
        ("no_proxy", "localhost,127.0.0.1,::1".to_string()),
    ];
    for (k, v) in fixed {
        set(&mut env, k, v);
    }
    env
}

/// Our own environment with the user identity of `run_as` (when dropping privileges).
pub fn base_env(run_as: Option<(u32, u32)>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    if let Some((uid, _)) = run_as {
        for (k, v) in user_env(uid) {
            set(&mut env, &k, v);
        }
    }
    env
}

fn set(env: &mut Vec<(String, String)>, k: &str, v: String) {
    env.retain(|(ek, _)| ek != k);
    env.push((k.to_string(), v));
}

/// What to do in the child between fork and exec.
#[derive(Clone, Default)]
pub struct PreExec {
    /// New process group (pgid = pid), so the fallback kill reaches the whole tree.
    pub new_pgrp: bool,
    /// Join this cgroup (writes `0` to `cgroup.procs`).
    pub cgroup: Option<PathBuf>,
    /// Install this fd as fd 3.
    pub fd3: Option<RawFd>,
    /// Drop to this uid/gid (when the guest agent runs as root).
    pub run_as: Option<(u32, u32)>,
}

impl PreExec {
    /// The closure for `pre_exec`. Buffers are prepared here, before forking.
    fn closure(&self) -> impl FnMut() -> std::io::Result<()> + Send + Sync + 'static {
        let procs = self.cgroup.as_ref().map(|p| CString::new(p.join("cgroup.procs").as_os_str().as_bytes()).unwrap());
        let (new_pgrp, fd3, run_as) = (self.new_pgrp, self.fd3, self.run_as);
        move || {
            // SAFETY: only async-signal-safe libc calls between fork and exec.
            unsafe {
                if new_pgrp && libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(path) = &procs {
                    let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                    if fd >= 0 {
                        libc::write(fd, b"0".as_ptr().cast(), 1);
                        libc::close(fd);
                    }
                }
                if let Some(fd) = fd3 {
                    if fd == 3 {
                        libc::fcntl(3, libc::F_SETFD, 0);
                    } else if libc::dup2(fd, 3) < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                if let Some((uid, gid)) = run_as {
                    let groups = [gid];
                    if libc::setgroups(1, groups.as_ptr()) != 0 || libc::setgid(gid) != 0 || libc::setuid(uid) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
            }
            Ok(())
        }
    }

    pub fn apply_tokio(&self, cmd: &mut Command) {
        let f = self.closure();
        // SAFETY: see `closure`.
        unsafe {
            cmd.pre_exec(f);
        }
    }

    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        use std::os::unix::process::CommandExt;
        let f = self.closure();
        // SAFETY: see `closure`.
        unsafe {
            cmd.pre_exec(f);
        }
    }
}

/// How to start one process.
pub struct Spawn<'a> {
    pub argv: Vec<String>,
    pub cwd: &'a Path,
    pub env: Vec<(String, String)>,
    /// Combined stdout+stderr destination (write end of a pipe). `None` = inherit null.
    pub output: Option<OwnedFd>,
    /// Extra fd installed as fd 3 in the child (used to report `$PWD`).
    pub fd3: Option<OwnedFd>,
    /// Join this cgroup (writes `0` to `cgroup.procs` before exec).
    pub cgroup: Option<PathBuf>,
    /// Drop to this uid/gid before exec (when the guest agent runs as root).
    pub run_as: Option<(u32, u32)>,
}

/// Spawn in a new process group (pgid = pid), so the fallback kill can reach the whole tree.
pub fn spawn(s: Spawn<'_>) -> std::io::Result<Child> {
    let mut cmd = Command::new(&s.argv[0]);
    cmd.args(&s.argv[1..]).current_dir(s.cwd).env_clear().envs(s.env).stdin(Stdio::null()).kill_on_drop(false);
    match s.output {
        Some(out) => {
            let err = out.try_clone()?;
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        None => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    PreExec { new_pgrp: true, cgroup: s.cgroup, fd3: s.fd3.as_ref().map(|f| f.as_raw_fd()), run_as: s.run_as }.apply_tokio(&mut cmd);
    let child = cmd.spawn();
    drop(s.fd3);
    child
}

/// Kill everything started for one call/task: `cgroup.kill` if available, else the process group.
pub fn kill_tree(cgroup: Option<&Path>, pgid: Option<u32>) {
    if let Some(cg) = cgroup
        && Cgroups::kill(cg)
    {
        return;
    }
    if let Some(pgid) = pgid {
        let _ = killpg(Pid::from_raw(pgid as i32), Signal::SIGKILL);
    }
}

/// `pipe2(O_CLOEXEC)` → (read, write).
pub fn pipe() -> std::io::Result<(OwnedFd, OwnedFd)> {
    nix::unistd::pipe2(nix::fcntl::OFlag::O_CLOEXEC).map_err(std::io::Error::from)
}

/// Locate an executable on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Output of a bounded helper run ([`run_helper`]).
pub struct HelperOutput {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: String,
    /// Killed at the deadline or the output cap.
    pub cut_off: bool,
}

/// Run a helper (pdftotext, vips, …) synchronously as the agent's user, with a deadline and an
/// output cap; the helper's process group is killed when either is hit. Called from blocking
/// threads only.
pub fn run_helper(
    argv: &[&str],
    stdin: Option<std::fs::File>,
    env: Vec<(String, String)>,
    pre: PreExec,
    timeout: Duration,
    max_stdout: usize,
) -> std::io::Result<HelperOutput> {
    let mut cmd = std::process::Command::new(argv[0]);
    cmd.args(&argv[1..]).env_clear().envs(env).stdout(Stdio::piped()).stderr(Stdio::piped());
    match stdin {
        Some(f) => cmd.stdin(Stdio::from(f)),
        None => cmd.stdin(Stdio::null()),
    };
    PreExec { new_pgrp: true, ..pre }.apply_std(&mut cmd);
    let mut child = cmd.spawn()?;
    let pid = child.id();
    let done = Arc::new(AtomicBool::new(false));
    let fired = Arc::new(AtomicBool::new(false));
    let killer = {
        let (done, fired) = (done.clone(), fired.clone());
        std::thread::spawn(move || {
            let step = Duration::from_millis(50);
            let mut waited = Duration::ZERO;
            while waited < timeout {
                if done.load(Ordering::SeqCst) {
                    return;
                }
                std::thread::sleep(step);
                waited += step;
            }
            if !done.load(Ordering::SeqCst) {
                fired.store(true, Ordering::SeqCst);
                let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
            }
        })
    };
    let mut stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(e) = stderr_pipe.as_mut() {
            let _ = e.take(64 * 1024).read_to_end(&mut s);
        }
        String::from_utf8_lossy(&s).into_owned()
    });
    let mut stdout = Vec::new();
    let mut capped = false;
    if let Some(mut out) = child.stdout.take() {
        let mut buf = [0u8; 64 * 1024];
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if stdout.len() + n > max_stdout {
                        capped = true;
                        let _ = killpg(Pid::from_raw(pid as i32), Signal::SIGKILL);
                        break;
                    }
                    stdout.extend_from_slice(&buf[..n]);
                }
            }
        }
    }
    let status = child.wait()?;
    done.store(true, Ordering::SeqCst);
    let _ = killer.join();
    let stderr = stderr_reader.join().unwrap_or_default();
    let cut_off = capped || fired.load(Ordering::SeqCst);
    Ok(HelperOutput { success: status.success() && !cut_off, stdout, stderr, cut_off })
}

/// Run file operations on this thread with the agent user's filesystem identity
/// (`setfsuid`/`setfsgid` and supplementary groups are per-thread at the kernel level; the raw
/// syscalls avoid glibc broadcasting them to every thread). Permission checks, created files and
/// directories then behave exactly as for the sandbox user, and the root-only filesystem
/// capabilities are dropped while the guard lives. A no-op when `run_as` is `None`.
pub struct AsUser {
    restore: Option<(u32, u32, Vec<libc::gid_t>)>,
}

impl AsUser {
    pub fn enter(run_as: Option<(u32, u32)>) -> std::io::Result<AsUser> {
        let Some((uid, gid)) = run_as else { return Ok(AsUser { restore: None }) };
        // SAFETY: plain syscalls on the calling thread's credentials.
        unsafe {
            let n = libc::getgroups(0, std::ptr::null_mut());
            let mut groups = vec![0 as libc::gid_t; n.max(0) as usize];
            if n > 0 && libc::getgroups(n, groups.as_mut_ptr()) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let prev_gid = libc::setfsgid(u32::MAX) as u32; // invalid id: query only
            let prev_uid = libc::setfsuid(u32::MAX) as u32;
            let mine = [gid];
            if libc::syscall(libc::SYS_setgroups, 1usize, mine.as_ptr()) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let guard = AsUser { restore: Some((prev_uid, prev_gid, groups)) };
            libc::setfsgid(gid);
            libc::setfsuid(uid);
            if libc::setfsuid(u32::MAX) as u32 != uid || libc::setfsgid(u32::MAX) as u32 != gid {
                return Err(std::io::Error::other("could not switch the filesystem identity"));
            }
            Ok(guard)
        }
    }
}

impl Drop for AsUser {
    fn drop(&mut self) {
        if let Some((uid, gid, groups)) = self.restore.take() {
            // SAFETY: restores this thread's credentials.
            unsafe {
                libc::setfsuid(uid);
                libc::setfsgid(gid);
                libc::syscall(libc::SYS_setgroups, groups.len(), groups.as_ptr());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_helper_caps_output_and_deadline() {
        let out = run_helper(&["sh", "-c", "head -c 100000 /dev/zero"], None, base_env(None), PreExec::default(), Duration::from_secs(5), 1000)
            .unwrap();
        assert!(out.cut_off && !out.success && out.stdout.len() <= 1000);
        let t = std::time::Instant::now();
        let out = run_helper(&["sleep", "30"], None, base_env(None), PreExec::default(), Duration::from_millis(300), 1000).unwrap();
        assert!(out.cut_off && t.elapsed() < Duration::from_secs(5));
        let out = run_helper(&["echo", "hi"], None, base_env(None), PreExec::default(), Duration::from_secs(5), 1000).unwrap();
        assert!(out.success && out.stdout == b"hi\n");
    }

    #[test]
    fn as_user_noop_without_run_as() {
        let g = AsUser::enter(None).unwrap();
        drop(g);
    }

    #[test]
    fn as_user_same_identity_round_trips() {
        // Unprivileged: switching to our own ids is permitted and must restore cleanly.
        let (uid, gid) = (nix::unistd::getuid().as_raw(), nix::unistd::getgid().as_raw());
        let before = nix::unistd::getgroups().unwrap();
        {
            let g = AsUser::enter(Some((uid, gid)));
            // setgroups needs CAP_SETGID; unprivileged runs report an error instead of switching.
            if let Ok(g) = g {
                drop(g);
            }
        }
        assert_eq!(nix::unistd::getgroups().unwrap(), before);
        unsafe {
            assert_eq!(libc::setfsuid(u32::MAX) as u32, uid);
        }
    }

    #[test]
    fn user_env_has_home() {
        let env = user_env(nix::unistd::getuid().as_raw());
        assert!(env.iter().any(|(k, _)| k == "HOME"));
    }
}
