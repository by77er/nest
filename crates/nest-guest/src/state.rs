//! Shared guest state: identity, agent slots and their runtime, buffered control events.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nest_protocol::guest::{
    AgentSlot, CliCommand, CliResult, ControlBody, ControlFrame, ListeningPort, TaskInfo, error_code,
};
use nest_protocol::model::{AgentId, Epoch, ErrorBody, SandboxId};
use tokio::sync::{mpsc, oneshot};

use crate::cgroup::Cgroups;
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
    /// A hands call: configured, not frozen, at the configured epoch, for an attached agent.
    Hands { epoch: Epoch, agent: &'a AgentId },
    /// An ingress PTY: configured and not frozen (TCP ingress is not gated).
    Pty,
    /// The CLI's `whoami`: configured.
    Whoami,
}

pub struct Inner {
    pub identity: Option<Identity>,
    /// Set by a fork `resume`; reported by `whoami` until the next `configure`.
    pub forked_sandbox_id: Option<SandboxId>,
    pub agents: HashMap<AgentId, AgentRt>,
    /// Mounts currently frozen by `prepare_snapshot`; hands calls are `busy` while non-empty.
    pub frozen: Vec<PathBuf>,
}

/// Control-channel event plumbing. Events are buffered while no configured control connection
/// exists: latest `ports` only, and up to 1000 `task_exited`.
#[derive(Default)]
pub struct EventSink {
    tx: Option<mpsc::UnboundedSender<ControlFrame>>,
    ready: bool,
    conn_gen: u64,
    ports: Option<ControlFrame>,
    tasks: VecDeque<ControlFrame>,
    pending_cli: HashMap<u64, oneshot::Sender<CliResult>>,
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
    pub events: Mutex<EventSink>,
    /// Latest port scan (also re-announced after every `configure`).
    pub ports: Mutex<Vec<ListeningPort>>,
    next_id: AtomicU64,
}

const MAX_BUFFERED_TASK_EVENTS: usize = 1000;

impl Inner {
    /// The one admission rule ("Startup order" and "Fencing" in the host-guest contract):
    /// `busy` (retryable) before `configure` and while frozen, then the call's own checks.
    pub fn admit(&self, gate: Gate<'_>) -> Result<&Identity, ErrorBody> {
        let Some(id) = &self.identity else { return Err(busy("guest not configured yet")) };
        if !matches!(gate, Gate::Whoami) && !self.frozen.is_empty() {
            return Err(busy("filesystems are frozen for a snapshot"));
        }
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
                forked_sandbox_id: None,
                agents: HashMap::new(),
                frozen: Vec::new(),
            }),
            events: Mutex::new(EventSink::default()),
            ports: Mutex::new(Vec::new()),
            next_id: AtomicU64::new(1),
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

    pub fn set_cwd(&self, agent: &AgentId, cwd: &str) {
        let dir = self.agent_dir(agent);
        let _ = std::fs::write(dir.join("cwd"), cwd);
        if let Some(rt) = self.inner.lock().unwrap().agents.get_mut(agent) {
            rt.cwd = cwd.to_string();
        }
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    // --- events --------------------------------------------------------------------------------

    /// A new control connection: returns its generation number. Not ready until `configure`.
    pub fn attach_control(&self, tx: mpsc::UnboundedSender<ControlFrame>) -> u64 {
        let mut ev = self.events.lock().unwrap();
        ev.conn_gen += 1;
        ev.tx = Some(tx);
        ev.ready = false;
        ev.conn_gen
    }

    /// The control connection with this generation went away.
    pub fn detach_control(&self, generation: u64) {
        let mut ev = self.events.lock().unwrap();
        if ev.conn_gen != generation {
            return;
        }
        ev.tx = None;
        ev.ready = false;
        for (_, waiter) in ev.pending_cli.drain() {
            let _ = waiter.send(CliResult::Error {
                error: err(error_code::BUSY, "control connection to the host was lost", true),
            });
        }
    }

    /// `configure` succeeded on connection `generation`: flush buffered events, re-announce ports.
    pub fn control_ready(&self, generation: u64) {
        let ports = self.ports.lock().unwrap().clone();
        let mut ev = self.events.lock().unwrap();
        if ev.conn_gen != generation {
            return;
        }
        ev.ready = true;
        ev.ports = None;
        let tx = ev.tx.clone();
        let tasks: Vec<_> = ev.tasks.drain(..).collect();
        drop(ev);
        if let Some(tx) = tx {
            for f in tasks {
                let _ = tx.send(f);
            }
            let _ = tx.send(event(ControlBody::Ports { listening: ports, ts_ms: now_ms() }));
        }
    }

    /// Send an unsolicited event, or buffer it until a configured control connection exists.
    pub fn emit(&self, body: ControlBody) {
        let frame = event(body);
        let mut ev = self.events.lock().unwrap();
        if ev.ready
            && let Some(tx) = &ev.tx
                && tx.send(frame.clone()).is_ok() {
                    return;
                }
        match frame.body {
            ControlBody::Ports { .. } => ev.ports = Some(frame),
            _ => {
                if ev.tasks.len() >= MAX_BUFFERED_TASK_EVENTS {
                    ev.tasks.pop_front();
                }
                ev.tasks.push_back(frame);
            }
        }
    }

    /// Relay a CLI command to the host and wait for `cli_result` (or `timeout`).
    pub async fn relay_cli(&self, agent_id: Option<AgentId>, command: CliCommand, timeout: Duration) -> CliResult {
        let id = self.next_id();
        let (tx_res, rx_res) = oneshot::channel();
        {
            let mut ev = self.events.lock().unwrap();
            let Some(tx) = ev.tx.clone().filter(|_| ev.ready) else {
                return CliResult::Error { error: err(error_code::BUSY, "not connected to the host", true) };
            };
            ev.pending_cli.insert(id, tx_res);
            let frame = ControlFrame { id: Some(id), reply_to: None, body: ControlBody::Cli { agent_id, command } };
            if tx.send(frame).is_err() {
                ev.pending_cli.remove(&id);
                return CliResult::Error { error: err(error_code::BUSY, "not connected to the host", true) };
            }
        }
        match tokio::time::timeout(timeout, rx_res).await {
            Ok(Ok(r)) => r,
            _ => {
                self.events.lock().unwrap().pending_cli.remove(&id);
                CliResult::Error { error: err(error_code::INTERNAL, "host did not answer in time", true) }
            }
        }
    }

    /// A reply (`cli_result` or `error`) to one of our CLI relays.
    pub fn resolve_cli(&self, reply_to: u64, result: CliResult) {
        if let Some(w) = self.events.lock().unwrap().pending_cli.remove(&reply_to) {
            let _ = w.send(result);
        }
    }

    pub fn emit_task_exited(&self, agent_id: &AgentId, task: TaskInfo) {
        self.emit(ControlBody::TaskExited { agent_id: agent_id.clone(), task });
    }
}

pub fn event(body: ControlBody) -> ControlFrame {
    ControlFrame { id: None, reply_to: None, body }
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

    fn slot(agent: &str) -> AgentSlot {
        AgentSlot { agent_id: AgentId(agent.into()), proxy_port: 3129, cwd: "/".into(), env: Default::default(), memory_max_bytes: None }
    }

    /// Every gate against every lifecycle state: the contract's table, not the code's.
    #[test]
    fn admission_by_gate_and_lifecycle() {
        let agent = AgentId("agt_a".into());
        let other = AgentId("agt_b".into());
        let inner = |configured: bool, frozen: bool| Inner {
            identity: configured.then(|| Identity { sandbox_id: SandboxId("sbx_a".into()), epoch: Epoch(7), hostname: "h".into() }),
            forked_sandbox_id: None,
            agents: [(agent.clone(), AgentRt { slot: slot("agt_a"), cwd: "/".into(), reads: HashMap::new(), tasks: HashMap::new(), running_calls: 0 })].into(),
            frozen: if frozen { vec!["/".into()] } else { vec![] },
        };
        let gates = [
            Gate::Hands { epoch: Epoch(7), agent: &agent },
            Gate::Hands { epoch: Epoch(6), agent: &agent },
            Gate::Hands { epoch: Epoch(7), agent: &other },
            Gate::Pty,
            Gate::Whoami,
        ];
        for gate in gates {
            for (configured, frozen) in [(false, false), (true, true), (true, false)] {
                let got = inner(configured, frozen).admit(gate).map(|_| ()).map_err(|e| e.code);
                let want: Result<(), String> = match gate {
                    _ if !configured => Err("busy".into()),
                    Gate::Hands { .. } | Gate::Pty if frozen => Err("busy".into()),
                    Gate::Hands { epoch, .. } if epoch != Epoch(7) => Err("stale_epoch".into()),
                    Gate::Hands { agent: a, .. } if *a != agent => Err("unknown_agent".into()),
                    Gate::Hands { .. } | Gate::Pty | Gate::Whoami => Ok(()),
                };
                assert_eq!(got, want, "{gate:?} configured={configured} frozen={frozen}");
            }
        }
    }
}
