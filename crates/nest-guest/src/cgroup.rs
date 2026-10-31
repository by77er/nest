//! cgroup v2 layout: `<root>/agents/<agent_id>/{calls,tasks,pty}/<name>`.
//!
//! When the cgroup root isn't writable (unprivileged tests, no cgroupfs), every operation is a
//! no-op and callers fall back to process-group kills.

use std::path::{Path, PathBuf};

use tracing::warn;

#[derive(Clone, Debug)]
pub struct Cgroups {
    root: Option<PathBuf>,
}

impl Cgroups {
    /// Probe `root`: usable only if we can create `root/agents` and it is a cgroup v2 directory.
    pub fn probe(root: Option<&Path>) -> Cgroups {
        let Some(root) = root else { return Cgroups { root: None } };
        let agents = root.join("agents");
        let ok = std::fs::create_dir_all(&agents).is_ok() && agents.join("cgroup.procs").exists();
        if !ok {
            warn!(root = %root.display(), "cgroup v2 root not usable; falling back to process groups");
            return Cgroups { root: None };
        }
        // Best effort: let children use the memory and cpu controllers.
        let _ = std::fs::write(root.join("cgroup.subtree_control"), "+memory +cpu");
        let _ = std::fs::write(agents.join("cgroup.subtree_control"), "+memory +cpu");
        Cgroups { root: Some(root.to_path_buf()) }
    }

    pub fn enabled(&self) -> bool {
        self.root.is_some()
    }

    pub fn agent_dir(&self, agent: &str) -> Option<PathBuf> {
        self.root.as_ref().map(|r| r.join("agents").join(agent))
    }

    pub fn ensure_agent(&self, agent: &str, memory_max: Option<u64>) {
        let Some(dir) = self.agent_dir(agent) else { return };
        for sub in ["", "calls", "tasks", "pty"] {
            let _ = std::fs::create_dir_all(dir.join(sub));
        }
        let _ = std::fs::write(dir.join("cgroup.subtree_control"), "+memory +cpu");
        for sub in ["calls", "tasks", "pty"] {
            let _ = std::fs::write(dir.join(sub).join("cgroup.subtree_control"), "+memory +cpu");
        }
        let max = memory_max.map(|m| m.to_string()).unwrap_or_else(|| "max".into());
        let _ = std::fs::write(dir.join("memory.max"), max);
    }

    /// Create a leaf cgroup for one call / task / pty. `None` when cgroups are disabled.
    pub fn leaf(&self, agent: &str, kind: &str, name: &str) -> Option<PathBuf> {
        let dir = self.agent_dir(agent)?.join(kind).join(name);
        match std::fs::create_dir_all(&dir) {
            Ok(()) => Some(dir),
            Err(e) => {
                warn!(dir = %dir.display(), error = %e, "could not create cgroup");
                None
            }
        }
    }

    /// `cgroup.kill` the subtree. Returns false if unsupported.
    pub fn kill(path: &Path) -> bool {
        std::fs::write(path.join("cgroup.kill"), "1").is_ok()
    }

    /// Remove an (empty) leaf; retried briefly because processes take a moment to leave.
    pub async fn remove_later(path: PathBuf) {
        for _ in 0..50 {
            if std::fs::remove_dir(&path).is_ok() || !path.exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
    }

    /// (cpu usage_usec, memory.current) for an agent subtree.
    pub fn usage(&self, agent: &str) -> (u64, u64) {
        let Some(dir) = self.agent_dir(agent) else { return (0, 0) };
        let cpu = std::fs::read_to_string(dir.join("cpu.stat"))
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("usage_usec ").and_then(|v| v.trim().parse().ok()))
            })
            .unwrap_or(0);
        let mem = std::fs::read_to_string(dir.join("memory.current"))
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);
        (cpu, mem)
    }
}
