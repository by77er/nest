//! Lifecycle operations: resume fixups, snapshot preparation, health.

use std::os::fd::AsRawFd;

use base64::Engine;
use nest_protocol::guest::{AgentUsage, DiskUsage, ForkIdentity, HealthReport, error_code};
use nest_protocol::model::ErrorBody;
use tracing::{info, warn};

use crate::exec::which;
use crate::framed::err;
use crate::state::{Guest, now_ms};
use crate::transport::ListenSpec;

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

/// Host entropy mixed in on every resume (the contract's `entropy_b64`).
const RESUME_ENTROPY_BYTES: usize = 64;

/// Apply `resume`: step the clock, mix in entropy, and on a fork take the new identity.
/// Returns the clock step actually applied (0 when unprivileged). Fails, rather than reporting
/// success, when the RNG could not be reseeded: two clones of one snapshot would share its state.
pub fn resume(guest: &Guest, wall_clock_ms: i64, entropy_b64: &str, fork: Option<&ForkIdentity>) -> Result<i64, ErrorBody> {
    let entropy = base64::engine::general_purpose::STANDARD
        .decode(entropy_b64)
        .ok()
        .filter(|e| e.len() == RESUME_ENTROPY_BYTES)
        .ok_or_else(|| err(error_code::BAD_REQUEST, format!("entropy_b64 must be {RESUME_ENTROPY_BYTES} bytes of base64"), false))?;
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
        if let Some(id) = guest.inner.lock().unwrap().identity.as_mut() {
            id.sandbox_id = f.new_sandbox_id.clone();
        }
        info!(sandbox = %f.new_sandbox_id, "took fork identity");
    }
    add_entropy(&entropy).map_err(|e| err(error_code::INTERNAL, format!("could not mix entropy into the RNG: {e}"), false))?;
    Ok(applied)
}

/// RNDADDENTROPY when root (credits entropy); otherwise mix into the pool via /dev/urandom.
fn add_entropy(bytes: &[u8]) -> std::io::Result<()> {
    if is_root()
        && let Ok(f) = std::fs::OpenOptions::new().write(true).open("/dev/random") {
            let mut buf = Vec::with_capacity(8 + bytes.len());
            buf.extend_from_slice(&((bytes.len() * 8) as i32).to_ne_bytes());
            buf.extend_from_slice(&(bytes.len() as i32).to_ne_bytes());
            buf.extend_from_slice(bytes);
            // SAFETY: struct rand_pool_info { int entropy_count; int buf_size; u32 buf[] }.
            if unsafe { libc::ioctl(f.as_raw_fd(), RNDADDENTROPY as _, buf.as_ptr()) } == 0 {
                return Ok(());
            }
        }
    std::fs::write("/dev/urandom", bytes)
}

/// Before a snapshot: `sync`, then optionally `drop_caches`.
pub fn prepare_snapshot(drop_caches: bool) {
    // SAFETY: plain syscall.
    unsafe { libc::sync() };
    if drop_caches && std::fs::write("/proc/sys/vm/drop_caches", "3").is_err() {
        warn!("drop_caches not permitted");
    }
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
    caps
}
