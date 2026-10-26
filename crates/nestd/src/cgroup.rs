//! VMM supervision through cgroup v2, so no VM outlives the nestd that started it.
//!
//! The jailer puts each VMM in its own cgroup (`--cgroup-version 2`), by default under
//! `<cgroup root>/<exec file name>/<jail id>`, which is outside nestd's systemd unit: stopping or
//! restarting the unit would not kill it. With `delegated_cgroup` (the unit has `Delegate=yes`)
//! nestd moves itself into the leaf `<own>/supervisor` (the no-internal-processes rule: a cgroup
//! that hands controllers to its children holds no processes itself), enables the memory
//! controller for `<own>/vms`, and gives the jailer `--parent-cgroup <own>/vms`, so the unit's own
//! stop kills every VMM. Either way, a starting nestd kills whatever VMM cgroups it finds under
//! both parents first ([`kill_children`]), before it looks at any disk.
//!
//! Unverified on a real host: the delegated layout and `cgroup.kill` are exercised here only
//! against a fake cgroup directory.

use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// Prefix of a jailed VMM's cgroup (its jail id: the sandbox id with `_` as `-`).
pub const VM_PREFIX: &str = "sbx-";

/// nestd's own cgroup from the contents of `/proc/self/cgroup` (the v2 line `0::/path`), relative
/// to the cgroup root.
pub fn own_cgroup(proc_self_cgroup: &str) -> Option<String> {
    let path = proc_self_cgroup.lines().find_map(|l| l.strip_prefix("0::"))?;
    Some(path.trim().trim_start_matches('/').to_string())
}

/// The cgroups nestd uses when its unit delegates one: the leaf it lives in and the parent of
/// its VMMs, both relative to the cgroup root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delegated {
    pub supervisor: String,
    pub vms: String,
}

impl Delegated {
    pub fn under(own: &str) -> Delegated {
        let join = |leaf: &str| if own.is_empty() { leaf.to_string() } else { format!("{own}/{leaf}") };
        Delegated { supervisor: join("supervisor"), vms: join("vms") }
    }
}

/// Move this process into `<own>/supervisor` and prepare `<own>/vms` for the jailer: memory
/// controller enabled for `<own>`'s children and for `vms`' children. Idempotent (a restart finds
/// them made). Must run before nestd starts any child.
pub fn enter_delegated(root: &Path) -> io::Result<Delegated> {
    let own = own_cgroup(&std::fs::read_to_string("/proc/self/cgroup")?).ok_or_else(|| io::Error::other("no cgroup v2 entry in /proc/self/cgroup"))?;
    let d = Delegated::under(&own);
    let at = |rel: &str| root.join(rel);
    std::fs::create_dir_all(at(&d.supervisor))?;
    std::fs::write(at(&d.supervisor).join("cgroup.procs"), std::process::id().to_string())?;
    std::fs::write(at(&own).join("cgroup.subtree_control"), "+memory")?;
    std::fs::create_dir_all(at(&d.vms))?;
    std::fs::write(at(&d.vms).join("cgroup.subtree_control"), "+memory")?;
    Ok(d)
}

/// Kill every process in each `sbx-*` child cgroup of `dir` (`cgroup.kill`, or SIGKILL to each pid
/// in `cgroup.procs` on a kernel without it), wait up to `timeout` for each to empty
/// (`populated 0` in `cgroup.events`), and remove it. Returns how many cgroups were killed.
pub fn kill_children(dir: &Path, timeout: Duration) -> usize {
    let mut killed = 0;
    for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if !e.file_name().to_string_lossy().starts_with(VM_PREFIX) || !e.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let cg = e.path();
        if let Err(err) = kill(&cg) {
            tracing::error!(cgroup = %cg.display(), error = %err, "killing a leftover VMM cgroup");
            continue;
        }
        killed += 1;
        if !wait_empty(&cg, timeout) {
            tracing::error!(cgroup = %cg.display(), "a leftover VMM cgroup is still populated after the kill");
            continue;
        }
        if let Err(err) = std::fs::remove_dir(&cg) {
            tracing::warn!(cgroup = %cg.display(), error = %err, "removing a leftover VMM cgroup");
        }
    }
    killed
}

fn kill(cg: &Path) -> io::Result<()> {
    match std::fs::write(cg.join("cgroup.kill"), "1") {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            for pid in std::fs::read_to_string(cg.join("cgroup.procs"))?.split_whitespace().filter_map(|p| p.parse::<i32>().ok()) {
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), nix::sys::signal::Signal::SIGKILL);
            }
            Ok(())
        }
        Err(e) => Err(e),
    }
}

fn wait_empty(cg: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let events = std::fs::read_to_string(cg.join("cgroup.events")).unwrap_or_default();
        if events.lines().any(|l| l.trim() == "populated 0") {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The parent cgroups to sweep at start: the jailer's default (`<root>/<exec name>`) and, when
/// delegated, `<root>/<own>/vms`.
pub fn vm_parents(root: &Path, exec_name: &str, delegated: Option<&Delegated>) -> Vec<PathBuf> {
    let mut v = vec![root.join(exec_name)];
    if let Some(d) = delegated {
        v.push(root.join(&d.vms));
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_cgroup_reads_the_v2_line() {
        assert_eq!(own_cgroup("0::/system.slice/nestd.service\n").as_deref(), Some("system.slice/nestd.service"));
        assert_eq!(own_cgroup("12:pids:/x\n0::/\n").as_deref(), Some(""));
        assert_eq!(own_cgroup("12:pids:/x\n"), None);
        assert_eq!(Delegated::under("system.slice/nestd.service").vms, "system.slice/nestd.service/vms");
        assert_eq!(Delegated::under("").supervisor, "supervisor");
    }

    /// Against a fake cgroup directory: only `sbx-*` children are killed (`1` written to
    /// `cgroup.kill`), each is waited for until it reports `populated 0`, and others are left alone.
    /// Removal itself needs cgroupfs (rmdir of a cgroup with its interface files), so it is not
    /// asserted here.
    #[test]
    fn kills_only_vmm_cgroups_and_waits_for_them_to_empty() {
        let dir = tempfile::tempdir().unwrap();
        let vm = dir.path().join("sbx-1-ab12");
        let other = dir.path().join("supervisor");
        for d in [&vm, &other] {
            std::fs::create_dir_all(d).unwrap();
            std::fs::write(d.join("cgroup.kill"), "").unwrap();
            std::fs::write(d.join("cgroup.events"), "populated 1\nfrozen 0\n").unwrap();
        }
        // The kernel empties the cgroup a little after the kill.
        let events = vm.join("cgroup.events");
        let flip = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            std::fs::write(events, "populated 0\nfrozen 0\n").unwrap();
        });
        let started = Instant::now();
        assert_eq!(kill_children(dir.path(), Duration::from_secs(5)), 1);
        assert!(started.elapsed() >= Duration::from_millis(100), "returned before the cgroup emptied");
        flip.join().unwrap();
        assert_eq!(std::fs::read_to_string(vm.join("cgroup.kill")).unwrap(), "1");
        assert_eq!(std::fs::read_to_string(other.join("cgroup.kill")).unwrap(), "", "a non-VMM cgroup was killed");
    }
}
