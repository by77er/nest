//! Shared guest state: identity, agent slots and their runtime; the control link's events.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nest_protocol::guest::{AgentSlot, error_code};
use nest_protocol::model::{AgentId, Epoch, ErrorBody, SandboxId};

use crate::cgroup::Cgroups;
use crate::events::Events;
use crate::exec::agent_env;
use crate::framed::err;
use crate::tasks::Task;
use crate::transport::ListenSpec;

/// Runtime configuration (CLI flags).
#[derive(Clone, Debug)]
pub struct Config {
    pub listen: ListenSpec,
    /// Holds `agents/<id>/{calls,tasks}/*.out` and `cwd` files. Default `/run/nest`.
    pub state_dir: PathBuf,
    /// cgroup v2 directory for agent subtrees. Default `/sys/fs/cgroup/nest`.
    pub cgroup_root: Option<PathBuf>,
    /// Unix socket for the in-sandbox `nest` CLI. Default `/run/nest/guest.sock`.
    pub cli_socket: Option<PathBuf>,
    pub port_poll: Duration,
    /// Run agent processes as this uid/gid (only meaningful when the guest agent is root).
    pub run_as: Option<(u32, u32)>,
    /// Mounts reported in `health`.
    pub disk_mounts: Vec<PathBuf>,
}

impl Config {
    pub fn for_listen(listen: ListenSpec) -> Config {
        let root = nix::unistd::geteuid().is_root();
        Config {
            listen,
            state_dir: PathBuf::from("/run/nest"),
            cgroup_root: Some(PathBuf::from("/sys/fs/cgroup/nest")),
            cli_socket: Some(PathBuf::from(nest_protocol::guest::GUEST_CLI_SOCKET)),
            port_poll: Duration::from_secs(1),
            run_as: if root { Some((1000, 1000)) } else { None },
            disk_mounts: vec![PathBuf::from("/"), PathBuf::from("/workspace")],
        }
    }
}

/// What a full (non-partial) `Read` saw, for Write/Edit staleness checks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadRecord {
    pub mtime_ns: i128,
    pub size: u64,
    pub sha256: [u8; 32],
}

pub struct AgentRt {
    pub slot: AgentSlot,
    pub cwd: String,
    pub reads: HashMap<PathBuf, ReadRecord>,
    pub tasks: HashMap<String, Arc<Task>>,
    pub running_calls: u32,
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub sandbox_id: SandboxId,
    pub epoch: Epoch,
    pub hostname: String,
}

/// What asks the guest's lifecycle to be let in.
#[derive(Clone, Copy, Debug)]
pub enum Gate<'a> {
    /// A hands call: configured, at the configured epoch, for an attached agent.
    Hands { epoch: Epoch, agent: &'a AgentId },
    /// An ingress PTY or the CLI's `whoami`: configured (TCP ingress is not gated).
    Configured,
}

impl Identity {
    /// The guest's `configure` fence: within one sandbox the epoch never goes down. A different
    /// sandbox id is a fork child taking over a restored parent's memory, at the child's own
    /// epoch: only nestd for this VM (CID 2) can send `configure`, so it can't be a stale parent.
    pub fn admit_configure(current: Option<&Identity>, next: &Identity) -> Result<(), ErrorBody> {
        match current {
            Some(cur) if cur.sandbox_id == next.sandbox_id && next.epoch < cur.epoch => {
                Err(err(error_code::STALE_EPOCH, "configure would lower the epoch", false))
            }
            _ => Ok(()),
        }
    }
}

/// An agent's slot, its current Bash cwd and the environment its processes get.
pub struct ExecCtx {
    pub slot: AgentSlot,
    pub cwd: String,
    pub env: Vec<(String, String)>,
}

pub struct Inner {
    pub identity: Option<Identity>,
    pub agents: HashMap<AgentId, AgentRt>,
}

pub struct Guest {
    pub config: Config,
    pub boot_id: String,
    /// Random per guest-agent process; with `boot_id`, lets the host tell a restore (both
    /// unchanged) from an agent restart (new `instance_id`).
    pub instance_id: String,
    pub started: Instant,
    pub cgroups: Cgroups,
    pub inner: Mutex<Inner>,
    pub events: Events,
}

impl Inner {
    /// The one admission rule ("Startup order" and "Fencing" in the host-guest contract):
    /// `busy` (retryable) before `configure`, then the call's own checks.
    pub fn admit(&self, gate: Gate<'_>) -> Result<&Identity, ErrorBody> {
        let Some(id) = &self.identity else { return Err(busy("guest not configured yet")) };
        if let Gate::Hands { epoch, agent } = gate {
            if epoch != id.epoch {
                return Err(err(error_code::STALE_EPOCH, format!("epoch {} != configured {}", epoch.0, id.epoch.0), false));
            }
            if !self.agents.contains_key(agent) {
                return Err(err(error_code::UNKNOWN_AGENT, format!("agent {agent} is not attached"), false));
            }
        }
        Ok(id)
    }
}

impl Guest {
    pub fn new(config: Config) -> Arc<Guest> {
        let cgroups = Cgroups::probe(config.cgroup_root.as_deref());
        Arc::new(Guest {
            boot_id: boot_id(),
            instance_id: random_hex(8),
            started: Instant::now(),
            cgroups,
            inner: Mutex::new(Inner {
                identity: None,
                agents: HashMap::new(),
            }),
            events: Events::default(),
            config,
        })
    }

    pub fn agent_dir(&self, agent: &AgentId) -> PathBuf {
        self.config.state_dir.join("agents").join(&agent.0)
    }

    /// Install or replace an agent slot, keeping existing runtime state (cwd, reads, tasks).
    pub fn upsert_agent(&self, slot: AgentSlot) {
        let dir = self.agent_dir(&slot.agent_id);
        let _ = std::fs::create_dir_all(dir.join("calls"));
        let _ = std::fs::create_dir_all(dir.join("tasks"));
        self.cgroups.ensure_agent(&slot.agent_id.0, slot.memory_max_bytes);
        let persisted = std::fs::read_to_string(dir.join("cwd")).ok().map(|s| s.trim().to_string());
        let mut inner = self.inner.lock().unwrap();
        match inner.agents.get_mut(&slot.agent_id) {
            Some(rt) => rt.slot = slot,
            None => {
                let cwd = persisted.filter(|p| Path::new(p).is_dir()).unwrap_or_else(|| slot.cwd.clone());
                inner.agents.insert(
                    slot.agent_id.clone(),
                    AgentRt { slot, cwd, reads: HashMap::new(), tasks: HashMap::new(), running_calls: 0 },
                );
            }
        }
    }

    /// What a process started on `agent`'s behalf runs with, read once from its slot.
    pub fn exec_ctx(&self, agent: &AgentId) -> Result<ExecCtx, ErrorBody> {
        let inner = self.inner.lock().unwrap();
        let rt = inner.agents.get(agent).ok_or_else(|| err(error_code::UNKNOWN_AGENT, format!("agent {agent} is not attached"), false))?;
        Ok(ExecCtx { env: agent_env(&rt.slot, self.config.run_as), slot: rt.slot.clone(), cwd: rt.cwd.clone() })
    }

    pub fn set_cwd(&self, agent: &AgentId, cwd: &str) {
        let dir = self.agent_dir(agent);
        let _ = std::fs::write(dir.join("cwd"), cwd);
        if let Some(rt) = self.inner.lock().unwrap().agents.get_mut(agent) {
            rt.cwd = cwd.to_string();
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Random hex string from the kernel RNG.
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn boot_id() -> String {
    // The kernel's boot id survives a memory-snapshot restore and changes on reboot, which is
    // exactly the hello semantics. Fall back to a random id per process.
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| random_hex(16))
}

fn busy(msg: &str) -> ErrorBody {
    err(error_code::BUSY, msg, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configure_fence_is_per_sandbox() {
        let id = |sbx: &str, epoch: u64| Identity { sandbox_id: SandboxId(sbx.into()), epoch: Epoch(epoch), hostname: "h".into() };
        let cur = id("sbx_a", 7);
        for (current, next, ok) in [
            (None, id("sbx_a", 1), true),
            (Some(&cur), id("sbx_a", 6), false),
            (Some(&cur), id("sbx_a", 7), true),
            (Some(&cur), id("sbx_a", 8), true),
            (Some(&cur), id("sbx_child", 1), true),
        ] {
            assert_eq!(Identity::admit_configure(current, &next).is_ok(), ok, "{current:?} -> {next:?}");
        }
    }

    fn slot(agent: &str) -> AgentSlot {
        AgentSlot { agent_id: AgentId(agent.into()), proxy_port: 3129, cwd: "/".into(), env: Default::default(), memory_max_bytes: None }
    }

    /// Every gate against every lifecycle state: the contract's table, not the code's.
    #[test]
    fn admission_by_gate_and_lifecycle() {
        let agent = AgentId("agt_a".into());
        let other = AgentId("agt_b".into());
        let inner = |configured: bool| Inner {
            identity: configured.then(|| Identity { sandbox_id: SandboxId("sbx_a".into()), epoch: Epoch(7), hostname: "h".into() }),
            agents: [(agent.clone(), AgentRt { slot: slot("agt_a"), cwd: "/".into(), reads: HashMap::new(), tasks: HashMap::new(), running_calls: 0 })].into(),
        };
        let gates = [
            Gate::Hands { epoch: Epoch(7), agent: &agent },
            Gate::Hands { epoch: Epoch(6), agent: &agent },
            Gate::Hands { epoch: Epoch(7), agent: &other },
            Gate::Configured,
        ];
        for gate in gates {
            for configured in [false, true] {
                let got = inner(configured).admit(gate).map(|_| ()).map_err(|e| e.code);
                let want: Result<(), String> = match gate {
                    _ if !configured => Err("busy".into()),
                    Gate::Hands { epoch, .. } if epoch != Epoch(7) => Err("stale_epoch".into()),
                    Gate::Hands { agent: a, .. } if *a != agent => Err("unknown_agent".into()),
                    Gate::Hands { .. } | Gate::Configured => Ok(()),
                };
                assert_eq!(got, want, "{gate:?} configured={configured}");
            }
        }
    }
}
