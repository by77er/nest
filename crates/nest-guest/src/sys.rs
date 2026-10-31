//! Lifecycle operations: resume fixups, snapshot preparation, health.

use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use base64::Engine;
use nest_protocol::guest::{AgentUsage, DiskUsage, ForkIdentity, HealthReport, error_code};
use nest_protocol::model::ErrorBody;
use tracing::{info, warn};

use crate::exec::which;
use crate::framed::err;
use crate::state::{Guest, now_ms};
use crate::transport::ListenSpec;

// _IOWR('X', 119, int) / _IOWR('X', 120, int)
const FIFREEZE: libc::c_ulong = 0xC004_5877;
const FITHAW: libc::c_ulong = 0xC004_5878;
// _IOW('R', 0x03, int[2])
const RNDADDENTROPY: libc::c_ulong = 0x4008_5203;

fn is_root() -> bool {
    nix::unistd::geteuid().is_root()
}

/// The hostname nestd names in `configure` (`sbx-…`), set inside a VM only: there the guest is root
/// and listens on vsock. Under the process driver (`--listen unix:`) it shares the host's UTS
/// namespace and must leave its hostname alone. Without it a sandbox's hostname was `(none)`.
pub fn configured_hostname(guest: &Guest, hostname: &str) {
    if !matches!(guest.config.listen, ListenSpec::Vsock) || !is_root() {
        return;
    }
    if nix::unistd::gethostname().is_ok_and(|h| h == hostname) {
        return;
    }
    if let Err(e) = nix::unistd::sethostname(hostname) {
        warn!(error = %e, "could not set hostname");
    }
}

/// Apply `resume`: step the clock, mix in entropy, and on a fork take the new identity.
/// Returns the clock step actually applied (0 when unprivileged).
pub fn resume(guest: &Guest, wall_clock_ms: i64, entropy_b64: &str, fork: Option<&ForkIdentity>) -> i64 {
    let step = wall_clock_ms - now_ms();
    let applied = if step.abs() < 5 {
        0
    } else {
        let ts = libc::timespec {
            tv_sec: wall_clock_ms.div_euclid(1000),
            tv_nsec: (wall_clock_ms.rem_euclid(1000) * 1_000_000) as libc::c_long,
        };
        // SAFETY: valid timespec.
        if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &ts) } == 0 {
            step
        } else {
            warn!(step_ms = step, "clock_settime not permitted; clock left as is");
            0
        }
    };
    if applied != 0 && is_root()
        && let Some(chronyc) = which("chronyc") {
            let _ = std::process::Command::new(chronyc).arg("makestep").output();
        }
    if let Ok(entropy) = base64::engine::general_purpose::STANDARD.decode(entropy_b64) {
        add_entropy(&entropy);
    }
    if let Some(f) = fork {
        if is_root() {
            if let Err(e) = std::fs::write("/etc/machine-id", format!("{}\n", f.machine_id)) {
                warn!(error = %e, "could not write /etc/machine-id");
            }
            if let Err(e) = nix::unistd::sethostname(&f.hostname) {
                warn!(error = %e, "could not set hostname");
            }
        } else {
            warn!("not root: fork identity recorded but machine-id/hostname unchanged");
        }
        guest.inner.lock().unwrap().forked_sandbox_id = Some(f.new_sandbox_id.clone());
        info!(sandbox = %f.new_sandbox_id, "took fork identity");
    }
    applied
}

/// RNDADDENTROPY when root (credits entropy); otherwise mix into the pool via /dev/urandom.
fn add_entropy(bytes: &[u8]) {
    if is_root()
        && let Ok(f) = std::fs::OpenOptions::new().write(true).open("/dev/random") {
            let mut buf = Vec::with_capacity(8 + bytes.len());
            buf.extend_from_slice(&((bytes.len() * 8) as i32).to_ne_bytes());
            buf.extend_from_slice(&(bytes.len() as i32).to_ne_bytes());
            buf.extend_from_slice(bytes);
            // SAFETY: struct rand_pool_info { int entropy_count; int buf_size; u32 buf[] }.
            if unsafe { libc::ioctl(f.as_raw_fd(), RNDADDENTROPY as _, buf.as_ptr()) } == 0 {
                return;
            }
        }
    let _ = std::fs::write("/dev/urandom", bytes);
}

/// `sync`, optional `drop_caches`, then freeze the listed mounts.
pub fn prepare_snapshot(guest: &Guest, drop_caches: bool, fsfreeze: &[String]) -> Result<(), ErrorBody> {
    // SAFETY: plain syscall.
    unsafe { libc::sync() };
    if drop_caches && std::fs::write("/proc/sys/vm/drop_caches", "3").is_err() {
        warn!("drop_caches not permitted");
    }
    for mount in fsfreeze {
        let path = PathBuf::from(mount);
        if guest.inner.lock().unwrap().frozen.contains(&path) {
            continue;
        }
        // Mark busy before freezing so no new hands call starts writing.
        guest.inner.lock().unwrap().frozen.push(path.clone());
        if let Err(e) = ioctl_dir(&path, FIFREEZE) {
            guest.inner.lock().unwrap().frozen.retain(|p| p != &path);
            return Err(err(error_code::INTERNAL, format!("fsfreeze {mount}: {e}"), false));
        }
    }
    Ok(())
}

/// Thaw everything we froze. Idempotent.
pub fn thaw(guest: &Guest) {
    let frozen: Vec<PathBuf> = std::mem::take(&mut guest.inner.lock().unwrap().frozen);
    for p in frozen {
        if let Err(e) = ioctl_dir(&p, FITHAW) {
            warn!(mount = %p.display(), error = %e, "thaw failed");
        }
    }
}

fn ioctl_dir(path: &Path, req: libc::c_ulong) -> std::io::Result<()> {
    let f = std::fs::File::open(path)?;
    let mut zero: libc::c_int = 0;
    // SAFETY: FIFREEZE/FITHAW take an int argument we own.
    if unsafe { libc::ioctl(f.as_raw_fd(), req as _, &mut zero) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

pub fn health(guest: &Guest) -> HealthReport {
    let uptime_ms = std::fs::read_to_string("/proc/uptime")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse::<f64>().ok()))
        .map(|s| (s * 1000.0) as u64)
        .unwrap_or_else(|| guest.started.elapsed().as_millis() as u64);
    let load1 = std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse().ok()))
        .unwrap_or(0.0);
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mem = |key: &str| {
        meminfo
            .lines()
            .find_map(|l| l.strip_prefix(key).and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse().ok()))
            .unwrap_or(0)
    };
    let disks = guest
        .config
        .disk_mounts
        .iter()
        .filter_map(|m| {
            let s = nix::sys::statvfs::statvfs(m).ok()?;
            Some(DiskUsage {
                mount: m.display().to_string(),
                total_bytes: s.blocks() as u64 * s.fragment_size() as u64,
                avail_bytes: s.blocks_available() as u64 * s.fragment_size() as u64,
            })
        })
        .collect();
    let agents = {
        let inner = guest.inner.lock().unwrap();
        let mut v: Vec<AgentUsage> = inner
            .agents
            .iter()
            .map(|(id, rt)| {
                let (cpu, mem) = guest.cgroups.usage(&id.0);
                AgentUsage {
                    agent_id: id.clone(),
                    running_calls: rt.running_calls,
                    background_tasks: rt.tasks.values().filter(|t| t.is_running()).count() as u32,
                    cpu_usage_usec: cpu,
                    memory_current_bytes: mem,
                }
            })
            .collect();
        v.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
        v
    };
    HealthReport {
        uptime_ms,
        load1,
        mem_total_kb: mem("MemTotal:"),
        mem_available_kb: mem("MemAvailable:"),
        disks,
        agents,
    }
}

/// Capabilities advertised in `hello`.
pub fn capabilities(guest: &Guest) -> Vec<String> {
    let mut caps = vec!["pty".to_string()];
    if guest.cgroups.enabled() {
        caps.push("cgroup_v2".into());
    }
    if which("pdftotext").is_some() {
        caps.push("pdf".into());
    }
    if is_root() {
        caps.push("fsfreeze".into());
    }
    caps
}
