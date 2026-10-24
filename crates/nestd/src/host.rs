//! The host core: command execution, sandbox lifecycle, commits, fencing, and event relay.
//!
//! Flow: [`FleetNotice::Commands`] → commit results are resolved immediately (a commit waiting in
//! the executor must not deadlock behind its own answer) → the batch goes to a single executor
//! task that applies commands **in order**, each yielding exactly one `command_result`
//! (deduplicated by `cmd`) → `CommandsDone(seq)` lets the fleet client ack the batch.
//!
//! Locking: a cheap `summary` map (std mutex) serves reports, lease claims and fencing decisions;
//! each sandbox's heavy state (VM, netns, guest connection) sits behind its own async mutex, which
//! is **never held while waiting on the control plane** (commit results are awaited unlocked).
//!
//! Fencing is authoritative and immediate: `fence` commands are applied on arrival (and again,
//! idempotently, in order); the sandbox's state becomes `Fenced` for that epoch and nothing moves it
//! back (`set_state` refuses, long operations re-check after every await); brains are fenced
//! through the runner, egress through the proxy (which also refuses to re-add a fenced epoch), and
//! vCPUs are frozen through a lock-free [`Pauser`] — none of these wait for the sandbox mutex or for
//! nest-proxy.

use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use nest_protocol::control::{
    AgentReport, Capacity, Command, CommandBody, CommandOutcome, CommitOutcome, ComponentVersions, DEFAULT_CWD, EgressAuditRecord,
    EgressVerdict, HostEvent, HostEventBody, HostHeaderMode, LeaseClaim, SandboxReport,
};
use nest_protocol::guest::{AgentSlot, CliCommand, CliResult, ForkIdentity};
use nest_protocol::host::proxy::{DropReason, ListenerPurpose, ListenerSpec, ProxyEvent, Transport, EXPLICIT_BASE_PORT, TCP_EXCEPTION_BASE_PORT};
use nest_protocol::gateway::GuestInfo;
use nest_protocol::host::runner::{AgentStart as RunnerAgentStart, ExitReason, RunnerEvent, StopMode};
use nest_protocol::host::Secret;
use nest_protocol::model::{
    error_codes, AgentId, CommitReason, EgressPolicy, Epoch, ErrorBody, ForkMode, GenerationId, GenerationKind,
    GenerationRecord, HostId, ManifestHash, ManifestKind, RequestId, Resources, SandboxId, SandboxState, Seq, SuspendMode, WorkstreamEvent,
    WorkstreamEventKind, WorkstreamId,
};
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{Config, DriverConfig, NetworkConfig, StorageConfig};
use crate::s3::{CredentialSource, S3Options, S3Store};
use crate::driver::{Driver, Pauser, Vm, VmSpec};
use crate::enroll::Enrolled;
use crate::fleet::{self, FleetInput, FleetNotice, FleetParams, FleetReporter};
use crate::gateway_link::{Entry as GatewayEntry, GatewayLink, GatewayNotice};
use crate::guest::{GuestCtl, GuestEvent};
use crate::net::{GATEWAY_IP, Netns};
use crate::limits::{self, Limiter};
use crate::proxy_link::{Access, HeldListener, ProxyLink, ProxyNotice, ProxyOp};
use crate::runner_link::{RunnerLink, RunnerNotice};
use crate::storage::{self, ObjectStore};
use crate::util::{error, new_id, now_ms};

const MAX_AGENT_SLOTS: u16 = 64;
const GUEST_READY_TIMEOUT: Duration = Duration::from_secs(60);
const SALVAGE_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a non-`ask` guest CLI relay waits for `guest_cli_result`. The guest gives up after
/// 30 s; nestd answers 3 s earlier so the caller gets nestd's error, not a bare guest timeout.
const CLI_RELAY_TIMEOUT_S: u64 = 27;
/// Extra time beyond an `ask`'s `wait_s` for the control plane to answer `pending` (the guest
/// allows `wait_s + 15`).
const CLI_RELAY_SLACK_S: u64 = 12;
/// Renew the proxy intermediate CA when less than this remains.
const CA_RENEW_BEFORE_MS: i64 = 48 * 3600 * 1000;
/// Retry a CA renewal that got no answer after this long.
const CA_RENEW_RETRY: Duration = Duration::from_secs(600);
/// How often capacity is re-evaluated (emitted when it changed, or every 10 minutes).
const CAPACITY_EVERY: Duration = Duration::from_secs(30);
/// GC: first offer a few minutes after start, then hourly.
const GC_FIRST_CHECK: Duration = Duration::from_secs(180);
const GC_CHECK_EVERY: Duration = Duration::from_secs(3600);
/// Coalescing window for guest port reports.
const PORTS_COALESCE: Duration = Duration::from_millis(500);
/// Bound on the (sandbox, host, port) dedup map for egress denials.
const MAX_DENIED_SEEN: usize = 10_000;

#[derive(Clone, Debug)]
struct Summary {
    workstream: WorkstreamId,
    epoch: Epoch,
    state: SandboxState,
    head: Option<GenerationId>,
    dirty: bool,
    resources: Resources,
    /// The guest's version and capabilities, cached from its last hello (reported with `running`).
    guest: Option<GuestInfo>,
}

struct Sbx {
    id: SandboxId,
    workstream: WorkstreamId,
    epoch: Epoch,
    image: String,
    resources: Resources,
    policy: EgressPolicy,
    head: Option<GenerationRecord>,
    vm: Option<Box<dyn Vm>>,
    /// The VM is paused (not stopped): resume continues processes.
    paused: bool,
    netns: Option<Arc<Netns>>,
    guest: Option<GuestCtl>,
    next_listener: u32,
    /// agent → (slot, listener id)
    slots: BTreeMap<AgentId, (u16, Option<u32>)>,
    /// agent → initial Bash cwd (`agent_attach.cwd`, default `/workspace`)
    slot_cwds: BTreeMap<AgentId, String>,
    /// tcp exception rule (`host:port`) → (listener id, port)
    tcp_listeners: BTreeMap<String, (u32, u16)>,
    known_ports: BTreeSet<u16>,
    exposed: BTreeMap<u16, HostHeaderMode>,
    vm_dir: PathBuf,
    state_dir: PathBuf,
    /// The guest's version and capabilities from its last hello (what the gateway tells clients).
    guest_info: Option<GuestInfo>,
    /// A `commit_request` whose answer never came (timed out). The next commit asks again under
    /// the same request id first: SandboxDO answers a repeated id with its stored outcome.
    unanswered: Option<SentCommit>,
}

/// A `commit_request` as sent.
#[derive(Clone, Debug)]
struct SentCommit {
    request: RequestId,
    parent: Option<GenerationId>,
    kind: GenerationKind,
    disk_manifest: ManifestHash,
    mem_manifest: Option<ManifestHash>,
    reason: CommitReason,
}

impl Sbx {
    fn disk_path(&self) -> PathBuf {
        self.state_dir.join("disk.img")
    }
}

/// Bounded `cmd` → outcome cache for redelivered commands.
#[derive(Default)]
struct Results {
    map: HashMap<String, CommandOutcome>,
    order: VecDeque<String>,
}

impl Results {
    fn insert(&mut self, cmd: &str, o: CommandOutcome) {
        if self.map.insert(cmd.to_string(), o).is_none() {
            self.order.push_back(cmd.to_string());
            if self.order.len() > 4096
                && let Some(old) = self.order.pop_front() {
                    self.map.remove(&old);
                }
        }
    }
}

type CmdResult = Result<Option<serde_json::Value>, ErrorBody>;

pub struct Inner {
    cfg: Config,
    host_id: HostId,
    driver: Arc<dyn Driver>,
    store: Arc<dyn ObjectStore>,
    /// The same store when it's S3: burst hosts run its GC.
    s3: Option<Arc<S3Store>>,
    /// The current host token (rotated over the fleet channel), for HTTP calls to the control plane.
    host_token: Mutex<Secret>,
    proxy: ProxyLink,
    runner: RunnerLink,
    gateway: GatewayLink,
    fleet: mpsc::UnboundedSender<FleetInput>,
    guest_events: mpsc::UnboundedSender<(SandboxId, GuestEvent)>,
    summary: Mutex<BTreeMap<SandboxId, Summary>>,
    sandboxes: Mutex<BTreeMap<SandboxId, Arc<tokio::sync::Mutex<Sbx>>>>,
    pending_commits: Mutex<HashMap<RequestId, oneshot::Sender<CommitOutcome>>>,
    /// Guest `nest` CLI relays awaiting `guest_cli_result`.
    pending_cli: Mutex<HashMap<RequestId, oneshot::Sender<CliResult>>>,
    results: Mutex<Results>,
    lease_deadline: watch::Sender<Option<(Instant, Duration)>>,
    denied_seen: Mutex<HashMap<(SandboxId, String, u16), Instant>>,
    alerts_seen: Mutex<HashMap<(SandboxId, String, String), Instant>>,
    proxy_ca: Mutex<CaState>,
    /// Lock-free pause handles of running VMs (fencing freezes vCPUs without the sandbox lock).
    pausers: Mutex<HashMap<SandboxId, Arc<dyn Pauser>>>,
    limiter: Limiter,
    /// In-flight guest CLI relays per sandbox.
    cli_inflight: Mutex<HashMap<SandboxId, u32>>,
    /// Latest port report per sandbox awaiting the coalescing window.
    latest_ports: Mutex<HashMap<SandboxId, Vec<nest_protocol::guest::ListeningPort>>>,
}

/// The proxy intermediate CA: current key and expiry, and a renewal in flight.
#[derive(Default)]
struct CaState {
    key: Option<Secret>,
    expires_ms: Option<i64>,
    /// Key of an outstanding renewal CSR and when it was sent.
    pending: Option<(Secret, Instant)>,
}

/// Running nestd instance.
pub struct Host {
    pub inner: Arc<Inner>,
    /// The tunnel's supervisor (`cloudflared.rs`), when this host has one. Dropping it terminates
    /// cloudflared in the background; [`Host::shutdown`] waits for that.
    cloudflared: Option<crate::cloudflared::Supervisor>,
}

impl Host {
    /// Stop what must not outlive nestd: cloudflared gets SIGTERM, then SIGKILL after 5 s.
    pub async fn shutdown(mut self) {
        if let Some(s) = self.cloudflared.take() {
            s.stop().await;
        }
    }
}

impl FleetReporter for Inner {
    fn report(&self) -> (Vec<SandboxReport>, Vec<AgentReport>, Capacity) {
        let summary = self.summary.lock().expect("summary");
        let sandboxes = summary
            .iter()
            .map(|(id, s)| SandboxReport {
                sandbox: id.clone(),
                epoch: s.epoch,
                state: s.state,
                head: s.head.clone(),
                dirty: s.dirty,
                guest: if s.state == SandboxState::Running { s.guest.clone() } else { None },
            })
            .collect();
        let agents: Vec<AgentReport> = self.runner.report();
        (sandboxes, agents, self.capacity(&summary))
    }

    fn lease_claims(&self) -> Vec<LeaseClaim> {
        self.summary
            .lock()
            .expect("summary")
            .iter()
            .filter(|(_, s)| holds_lease(s.state))
            .map(|(id, s)| LeaseClaim { sandbox: id.clone(), epoch: s.epoch })
            .collect()
    }
}

fn holds_lease(s: SandboxState) -> bool {
    matches!(s, SandboxState::Creating | SandboxState::Restoring | SandboxState::Running | SandboxState::Suspending | SandboxState::Suspended | SandboxState::Archiving)
}

impl Host {
    /// Start every subsystem. `driver` overrides the configured driver (tests).
    pub async fn start(cfg: Config, enrolled: Enrolled, driver: Option<Arc<dyn Driver>>) -> anyhow::Result<Host> {
        // The host's tunnel, when the control plane gave it one and cloudflared is installed.
        // Decided here, started last, so a failure below leaves no child behind.
        let tunnel = crate::cloudflared::plan(&cfg, &enrolled)?;
        let (tunnel_tx, tunnel_rx) = crate::cloudflared::channel(&tunnel);
        if let crate::cloudflared::Plan::Run(t) = &tunnel {
            let user = t.user.map(|(uid, _)| uid.as_raw());
            tracing::info!(bin = %t.bin.display(), ?user, tunnel_url = enrolled.gateway_url.as_deref().unwrap_or("-"), "this host runs a tunnel");
        }
        std::fs::create_dir_all(&cfg.run_dir).with_context(|| format!("create {}", cfg.run_dir.display()))?;
        std::fs::create_dir_all(&cfg.state_dir).with_context(|| format!("create {}", cfg.state_dir.display()))?;
        std::fs::create_dir_all(cfg.agents_dir())?;
        let driver: Arc<dyn Driver> = match driver {
            Some(d) => d,
            None => match &cfg.driver {
                DriverConfig::Process { guest_command, mount_disk } => {
                    Arc::new(crate::driver::process::ProcessDriver { guest_command: guest_command.clone(), mount_disk: *mount_disk })
                }
                DriverConfig::Firecracker(fc) => {
                    if let (Some(_), Some(j)) = (&fc.jailer_bin, &fc.jailer) {
                        match crate::driver::firecracker::remove_stale_jails(fc, j) {
                            Ok(0) => {}
                            Ok(n) => tracing::info!(n, "removed jails left by a crash or reboot"),
                            Err(e) => tracing::warn!("removing stale jails: {e}"),
                        }
                    }
                    Arc::new(crate::driver::firecracker::FirecrackerDriver { cfg: fc.clone() })
                }
            },
        };
        let cache = storage::LocalFsStore::new(cfg.store_dir())?;
        let (store, s3): (Arc<dyn ObjectStore>, Option<Arc<S3Store>>) = match &cfg.storage {
            StorageConfig::Local => (Arc::new(cache), None),
            StorageConfig::S3 { bucket, region, prefix, imds_url, parallelism, cache_max_gib } => {
                let options = S3Options { parallelism: *parallelism, cache_max_bytes: cache_max_gib << 30, ..S3Options::default() };
                let s3 = Arc::new(S3Store::new(bucket, region, prefix, None, CredentialSource::Imds(imds_url.clone()), cache, options)?);
                (s3.clone(), Some(s3))
            }
        };
        // Random per nestd process: the fleet hello's `instance_id` and the proxy's `nestd_boot_id`.
        let instance_id = crate::util::random_hex(8);

        let (proxy_tx, mut proxy_rx) = mpsc::unbounded_channel();
        let proxy_access = Access { gid: cfg.sockets.gid, allowed_uids: cfg.sockets.proxy_uids.clone() };
        let proxy = ProxyLink::start(&cfg.proxy_sock(), enrolled.host.clone(), instance_id.clone(), proxy_access, proxy_tx)?;
        let (runner_tx, mut runner_rx) = mpsc::unbounded_channel();
        let runner_access = Access { gid: cfg.sockets.gid, allowed_uids: cfg.sockets.runner_uids.clone() };
        let runner = RunnerLink::start(&cfg.runner_sock(), enrolled.host.clone(), cfg.role, runner_access, runner_tx)?;
        let (gateway_tx, mut gateway_rx) = mpsc::unbounded_channel();
        let gateway_access = Access { gid: cfg.sockets.gid, allowed_uids: cfg.sockets.gateway_uids.clone() };
        let gateway = GatewayLink::start(&cfg.gateway_sock(), enrolled.host.clone(), gateway_access, gateway_tx)?;
        let (fleet_tx, fleet_rx) = mpsc::unbounded_channel();
        let (notice_tx, mut notice_rx) = mpsc::unbounded_channel();
        let (guest_tx, mut guest_rx) = mpsc::unbounded_channel();
        let (lease_tx, lease_rx) = watch::channel(None);

        if let Some((ca, key)) = &enrolled.proxy_ca {
            proxy.apply(ProxyOp::CaInstall { ca: ca.clone(), key_pem: key.clone() });
        }
        runner.host_token(enrolled.host_token.clone(), enrolled.host_token_expires_ms);

        let inner = Arc::new(Inner {
            host_id: enrolled.host.clone(),
            driver,
            store,
            s3,
            host_token: Mutex::new(enrolled.host_token.clone()),
            proxy,
            runner,
            gateway,
            fleet: fleet_tx,
            guest_events: guest_tx,
            summary: Mutex::new(BTreeMap::new()),
            sandboxes: Mutex::new(BTreeMap::new()),
            pending_commits: Mutex::new(HashMap::new()),
            pending_cli: Mutex::new(HashMap::new()),
            results: Mutex::new(Results::default()),
            lease_deadline: lease_tx,
            denied_seen: Mutex::new(HashMap::new()),
            alerts_seen: Mutex::new(HashMap::new()),
            proxy_ca: Mutex::new(CaState {
                key: enrolled.proxy_ca.as_ref().map(|(_, k)| k.clone()),
                expires_ms: enrolled.proxy_ca.as_ref().map(|(c, _)| c.expires_ms),
                pending: None,
            }),
            pausers: Mutex::new(HashMap::new()),
            limiter: Limiter::default(),
            cli_inflight: Mutex::new(HashMap::new()),
            latest_ports: Mutex::new(HashMap::new()),
            cfg,
        });

        fleet::spawn(
            FleetParams {
                url: enrolled.fleet_ws_url.clone(),
                token: enrolled.host_token.0.clone(),
                host: enrolled.host.clone(),
                role: inner.cfg.role,
                cell: inner.cfg.cell.clone(),
                gateway_url: inner.cfg.gateway_url.clone(),
                tunnel: tunnel_rx.clone(),
                versions: ComponentVersions {
                    nestd: env!("CARGO_PKG_VERSION").into(),
                    nest_proxy: inner.cfg.versions.nest_proxy.clone(),
                    agent_runner: inner.cfg.versions.agent_runner.clone(),
                    claude_code: inner.cfg.versions.claude_code.clone(),
                },
                instance_id,
                flush_interval: inner.cfg.flush_interval(),
            },
            inner.clone(),
            fleet_rx,
            notice_tx,
        );

        // Command executor: in order, one at a time.
        let (exec_tx, mut exec_rx) = mpsc::unbounded_channel::<(Seq, Vec<Command>)>();
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some((seq, cmds)) = exec_rx.recv().await {
                    for c in cmds {
                        inner.execute(c).await;
                    }
                    let _ = inner.fleet.send(FleetInput::CommandsDone(seq));
                }
            });
        }
        // Fleet notices.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some(n) = notice_rx.recv().await {
                    inner.on_fleet_notice(n, &exec_tx).await;
                }
            });
        }
        // Proxy, runner and guest notices.
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some(n) = proxy_rx.recv().await {
                    inner.on_proxy_notice(n);
                }
            });
        }
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some(n) = runner_rx.recv().await {
                    inner.on_runner_notice(n).await;
                }
            });
        }
        tokio::spawn(async move {
            while let Some(n) = gateway_rx.recv().await {
                match n {
                    GatewayNotice::Connected { instance_id, listen } => tracing::info!(%instance_id, %listen, "sandbox gateway connected"),
                    GatewayNotice::Disconnected => tracing::warn!("sandbox gateway disconnected"),
                }
            }
        });
        {
            let inner = inner.clone();
            tokio::spawn(async move {
                while let Some((sbx, ev)) = guest_rx.recv().await {
                    inner.on_guest_event(sbx, ev);
                }
            });
        }
        // Lease watchdog: self-fence when the deadline passes without renewal.
        {
            let inner = inner.clone();
            tokio::spawn(async move { inner.lease_watchdog(lease_rx).await });
        }
        // Spot interruption notices (AWS hosts): FleetDO drains the host before the deadline.
        if let crate::config::EnrollmentConfig::AwsImds { imds_url } = &inner.cfg.enrollment {
            let (inner, url) = (inner.clone(), imds_url.clone());
            tokio::spawn(async move { inner.spot_watch(url).await });
        }
        // Object-store GC: burst hosts offer to run it; the control plane says when.
        if inner.cfg.role == nest_protocol::model::HostRole::Burst && inner.s3.is_some() {
            let inner = inner.clone();
            tokio::spawn(async move { inner.gc_loop().await });
        }
        // Housekeeping: proxy CA renewal and capacity reports.
        {
            let inner = inner.clone();
            tokio::spawn(async move { inner.housekeeping().await });
        }
        // Every change of the tunnel's state goes to the control plane as an event (the hello
        // carries the state at connect time).
        {
            let inner = inner.clone();
            let mut rx = tunnel_rx;
            tokio::spawn(async move {
                while rx.changed().await.is_ok() {
                    let state = *rx.borrow_and_update();
                    inner.emit(HostEventBody::TunnelState { state });
                }
            });
        }
        let cloudflared = crate::cloudflared::spawn(tunnel, tunnel_tx);
        Ok(Host { inner, cloudflared })
    }
}

impl Inner {
    pub fn host_id(&self) -> &HostId {
        &self.host_id
    }

    fn emit(&self, body: HostEventBody) {
        let _ = self.fleet.send(FleetInput::Event(HostEvent { ts_ms: now_ms(), body }));
    }

    /// Report brains that are gone without a runner exit of their own (the runner connection
    /// dropped, or a fenced start was never sent). AgentDO restarts `crashed` and `fenced` brains
    /// that have work with a current `agent_start`.
    fn brains_exited(&self, gone: impl IntoIterator<Item = (AgentId, ExitReason)>) {
        for (agent, reason) in gone {
            self.emit(HostEventBody::AgentExited { agent, exit_code: None, signal: None, reason: reason.as_str().into() });
        }
    }

    /// Record and report a state transition. `Fenced` is terminal for its epoch: a transition out
    /// of it (e.g. an in-flight create finishing after a fence) is refused and returns `false`.
    fn set_state(&self, sbx: &SandboxId, epoch: Epoch, state: SandboxState, suspend_mode: Option<SuspendMode>, detail: Option<String>) -> bool {
        {
            let mut summary = self.summary.lock().expect("summary");
            if let Some(s) = summary.get_mut(sbx) {
                if s.epoch == epoch && s.state == SandboxState::Fenced && state != SandboxState::Fenced && state != SandboxState::Destroyed {
                    tracing::warn!(sandbox = %sbx, epoch = epoch.0, ?state, "refusing a transition out of fenced");
                    return false;
                }
                if s.epoch != epoch {
                    return false;
                }
                s.state = state;
            }
        }
        let guest = if state == SandboxState::Running { self.summary.lock().expect("summary").get(sbx).and_then(|s| s.guest.clone()) } else { None };
        self.emit(HostEventBody::SandboxState { sandbox: sbx.clone(), epoch, state, suspend_mode, detail, guest });
        true
    }

    /// Refresh the gateway's entry for a **running** sandbox (attached clients, the guest's
    /// version). In any other state this does nothing: membership follows the lifecycle (create
    /// and resume add the sandbox, suspend, fence and teardown remove it), so an attach, detach or
    /// guest hello while suspended never makes a paused VM reachable again.
    fn gateway_sync(&self, s: &Sbx) {
        let running = self.summary.lock().expect("summary").get(&s.id).is_some_and(|x| x.epoch == s.epoch && x.state == SandboxState::Running);
        if running {
            self.gateway_upsert(s);
        }
    }

    /// Tell the gateway what it needs about a sandbox (epoch, vsock socket, attached clients, the
    /// guest's version). Called directly only on the way into `running` (create, resume), just
    /// before the state is reported. No VM: nothing to reach, so nothing is sent.
    fn gateway_upsert(&self, s: &Sbx) {
        let Some(vm) = s.vm.as_ref() else { return };
        self.gateway.upsert(
            s.id.clone(),
            GatewayEntry { epoch: s.epoch, vsock_uds_path: vm.vsock_uds_path().display().to_string(), clients: s.slots.keys().map(|a| a.0.clone()).collect(), guest: s.guest_info.clone() },
        );
    }

    /// Whether `sbx@epoch` has been fenced (or is gone) since an operation started.
    fn fenced(&self, sbx: &SandboxId, epoch: Epoch) -> bool {
        match self.summary.lock().expect("summary").get(sbx) {
            Some(s) => s.epoch != epoch || s.state == SandboxState::Fenced,
            None => true,
        }
    }

    fn ensure_not_fenced(&self, sbx: &SandboxId, epoch: Epoch) -> Result<(), ErrorBody> {
        if self.fenced(sbx, epoch) {
            return Err(error(error_codes::STALE_EPOCH, format!("{sbx}@{} was fenced during the operation", epoch.0), false));
        }
        Ok(())
    }

    fn capacity(&self, summary: &BTreeMap<SandboxId, Summary>) -> Capacity {
        let used_vcpus: u32 = summary.values().filter(|s| holds_lease(s.state)).map(|s| s.resources.vcpus).sum();
        let total_vcpus = std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1);
        let mem = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
        let field = |name: &str| -> u64 {
            mem.lines().find_map(|l| l.strip_prefix(name).and_then(|v| v.split_whitespace().next()?.parse().ok())).unwrap_or(0)
        };
        let huge_free_mib = field("HugePages_Free:") * field("Hugepagesize:") / 1024;
        let huge_total_mib = field("HugePages_Total:") * field("Hugepagesize:") / 1024;
        Capacity {
            vcpus_free: total_vcpus.saturating_sub(used_vcpus),
            memory_mib_free: (field("MemAvailable:") / 1024) as u32,
            hugepages_mib_free: huge_free_mib as u32,
            hugepages_mib_total: huge_total_mib as u32,
            sandboxes: summary.values().filter(|s| holds_lease(s.state)).count() as u32,
            agents: self.runner.count() as u32,
            warm: vec![],
        }
    }

    fn sandbox(&self, id: &SandboxId) -> Option<Arc<tokio::sync::Mutex<Sbx>>> {
        self.sandboxes.lock().expect("sandboxes").get(id).cloned()
    }

    fn workstream_of(&self, id: &SandboxId) -> Option<(WorkstreamId, Epoch)> {
        self.summary.lock().expect("summary").get(id).map(|s| (s.workstream.clone(), s.epoch))
    }

    fn workstream_event(&self, sbx: &SandboxId, agent: Option<AgentId>, kind: WorkstreamEventKind) {
        let Some((workstream, epoch)) = self.workstream_of(sbx) else { return };
        self.emit(HostEventBody::Workstream {
            event: WorkstreamEvent { workstream, ts_ms: now_ms(), agent, sandbox: Some(sbx.clone()), epoch: Some(epoch), kind },
        });
    }

    /// Check that `sandbox` exists at `epoch`.
    fn check_epoch(&self, sandbox: &SandboxId, epoch: Epoch) -> Result<(), ErrorBody> {
        match self.summary.lock().expect("summary").get(sandbox) {
            None => Err(error(error_codes::UNKNOWN_SANDBOX, format!("{sandbox} is not on this host"), false)),
            Some(s) if s.epoch != epoch => Err(error(error_codes::STALE_EPOCH, format!("{sandbox} is at epoch {} here, command has {}", s.epoch.0, epoch.0), false)),
            Some(s) if s.state == SandboxState::Fenced => Err(error(error_codes::STALE_EPOCH, format!("{sandbox} is fenced"), false)),
            Some(_) => Ok(()),
        }
    }

    // ------------------------------------------------------------------------------------------
    // Notices
    // ------------------------------------------------------------------------------------------

    async fn on_fleet_notice(self: &Arc<Self>, n: FleetNotice, exec: &mpsc::UnboundedSender<(Seq, Vec<Command>)>) {
        match n {
            FleetNotice::Commands { seq, commands } => {
                // Resolve commit results now so a commit awaiting in the executor can finish.
                for c in &commands {
                    match &c.body {
                        CommandBody::CommitResult { request, outcome, .. } => {
                            if let Some(tx) = self.pending_commits.lock().expect("pending").remove(request) {
                                let _ = tx.send(outcome.clone());
                            }
                        }
                        CommandBody::GuestCliResult { request, result } => {
                            if let Some(tx) = self.pending_cli.lock().expect("pending").remove(request) {
                                let _ = tx.send(result.clone());
                            }
                        }
                        // Fence at once, not behind slow commands; the executor re-applies it
                        // (a no-op) in order so the result is still acked in sequence.
                        CommandBody::Fence { sandboxes, reason } => {
                            for s in sandboxes {
                                self.fence_sandbox(s, reason, true, true).await;
                            }
                        }
                        _ => {}
                    }
                }
                let _ = exec.send((seq, commands));
            }
            FleetNotice::LeaseRenewed { deadline, deadline_boot, valid_until_ms } => {
                self.lease_deadline.send_replace(Some((deadline, deadline_boot)));
                self.proxy.apply(ProxyOp::Lease { valid_until_ms });
                self.runner.lease(valid_until_ms);
            }
            FleetNotice::Revoked(claims) => {
                for c in claims {
                    let current = self.summary.lock().expect("summary").get(&c.sandbox).map(|s| s.epoch);
                    if current == Some(c.epoch) {
                        self.fence_sandbox(&c.sandbox, "lease revoked by control plane", true, true).await;
                    }
                }
            }
            FleetNotice::HostToken { token, expires_ms } => {
                crate::credentials::update_token(&self.cfg.credentials_path(), &token, expires_ms);
                *self.host_token.lock().expect("host token") = Secret(token.clone());
                self.runner.host_token(Secret(token), expires_ms)
            }
            FleetNotice::BindingKey(keys) => {
                tracing::info!(keys = keys.len(), "binding verification keys updated");
                self.gateway.keys(keys);
            }
            FleetNotice::ProxyCa(ca) => {
                // A renewal answer is for the pending key; otherwise it re-issues the current one.
                let key = {
                    let mut st = self.proxy_ca.lock().expect("ca");
                    let key = st.pending.take().map(|(k, _)| k).or_else(|| st.key.clone());
                    if key.is_some() {
                        st.key = key.clone();
                        st.expires_ms = Some(ca.expires_ms);
                    }
                    key
                };
                match key {
                    Some(key_pem) => {
                        tracing::info!(expires_ms = ca.expires_ms, "installing proxy intermediate CA");
                        crate::credentials::update_proxy_ca(&self.cfg.credentials_path(), &ca, key_pem.expose());
                        self.proxy.apply(ProxyOp::CaInstall { ca, key_pem });
                    }
                    None => tracing::warn!("received proxy CA without a local key"),
                }
            }
            FleetNotice::Connected { lease } => tracing::info!(?lease, "fleet connected"),
            FleetNotice::Disconnected => tracing::warn!("fleet disconnected"),
            FleetNotice::Error(e) => tracing::warn!(code = %e.code, message = %e.message, "fleet error"),
        }
    }

    fn on_proxy_notice(&self, n: ProxyNotice) {
        match n {
            ProxyNotice::Event(ProxyEvent::Audit { records }) => {
                for r in records.iter().filter(|r| is_request_denial(r)) {
                    let key = (r.sandbox.clone(), r.host.clone(), r.port);
                    let fresh = {
                        let mut seen = self.denied_seen.lock().expect("denied");
                        let now = Instant::now();
                        seen.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
                        // Bounded: random names can't grow the map without limit.
                        if seen.len() >= MAX_DENIED_SEEN && !seen.contains_key(&key) {
                            false
                        } else {
                            seen.insert(key, now).is_none()
                        }
                    };
                    if fresh && self.limiter.allow(&r.sandbox, "denied", limits::DENIED, 1.0) {
                        self.workstream_event(&r.sandbox, r.agent.clone(), WorkstreamEventKind::EgressDenied { host: r.host.clone(), port: r.port });
                    }
                }
                // Per-sandbox budget for audit records (each batch becomes an R2 write).
                let records: Vec<_> = records.into_iter().filter(|r| self.limiter.allow(&r.sandbox, "audit", limits::AUDIT_RECORDS, 1.0)).collect();
                if !records.is_empty() {
                    self.emit(HostEventBody::EgressAudit { records });
                }
            }
            ProxyNotice::Event(ProxyEvent::Alert { sandbox, agent, kind, host, binding, .. }) => {
                let kind = match kind {
                    nest_protocol::host::proxy::AlertKind::PlaceholderWrongHost => "placeholder_wrong_host",
                    nest_protocol::host::proxy::AlertKind::DomainFronting => "domain_fronting",
                    nest_protocol::host::proxy::AlertKind::InjectionAfterExpiry => "injection_after_expiry",
                };
                let host: String = host.chars().take(253).collect();
                let fresh = {
                    let mut seen = self.alerts_seen.lock().expect("alerts");
                    let now = Instant::now();
                    seen.retain(|_, t| now.duration_since(*t) < Duration::from_secs(60));
                    seen.len() < MAX_DENIED_SEEN && seen.insert((sandbox.clone(), kind.to_string(), host.clone()), now).is_none()
                };
                if fresh && self.limiter.allow(&sandbox, "alert", limits::ALERTS, 1.0) {
                    self.workstream_event(&sandbox, agent, WorkstreamEventKind::EgressAlert { host, binding, reason: kind.into() });
                }
            }
            ProxyNotice::Event(ProxyEvent::ListenerFailed { sandbox, listener_id, error }) => {
                tracing::warn!(%sandbox, listener_id, code = %error.code, message = %error.message, "proxy listener failed");
            }
            ProxyNotice::Event(ProxyEvent::Error { error }) => tracing::warn!(code = %error.code, message = %error.message, "proxy error"),
            ProxyNotice::Event(_) => {}
            ProxyNotice::Connected { proxy_version, pid } => tracing::info!(%proxy_version, pid, "nest-proxy connected"),
            ProxyNotice::ResyncAck { sandboxes, listeners, matched } => tracing::info!(sandboxes, listeners, matched, "nest-proxy resynced"),
            ProxyNotice::Disconnected => tracing::warn!("nest-proxy disconnected (fails closed)"),
        }
    }

    async fn on_runner_notice(self: &Arc<Self>, n: RunnerNotice) {
        match n {
            // The runner link already updated its brain table (and dropped stale events).
            RunnerNotice::Event(RunnerEvent::AgentExited { agent, code, signal, reason }) => {
                // The guest slot stays: it belongs to the attachment (SandboxDO's `agent_detach`
                // ends it), not to the brain process, so a restarted brain finds its tasks.
                self.emit(HostEventBody::AgentExited { agent, exit_code: code, signal, reason: reason.as_str().into() });
            }
            RunnerNotice::Event(RunnerEvent::AgentStarted { agent, pid, session, .. }) => {
                tracing::info!(%agent, pid, %session, "brain started");
            }
            RunnerNotice::Event(RunnerEvent::AuthCheck { agent, auth_method, api_key_source, ok }) => {
                if !ok {
                    tracing::error!(%agent, %auth_method, %api_key_source, "brain failed the subscription auth check");
                }
            }
            RunnerNotice::Event(RunnerEvent::Error { agent, error }) => {
                tracing::warn!(agent = ?agent, code = %error.code, message = %error.message, "runner error")
            }
            RunnerNotice::Event(_) => {}
            RunnerNotice::Connected { runner_version, pid } => tracing::info!(%runner_version, pid, "agent runner connected"),
            RunnerNotice::Disconnected { lost } => {
                tracing::warn!(brains = lost.len(), "agent runner disconnected; its brains are gone");
                self.brains_exited(lost);
            }
        }
    }

    fn on_guest_event(self: &Arc<Self>, sbx: SandboxId, ev: GuestEvent) {
        match ev {
            GuestEvent::Ports(listening) => {
                // Coalesce bursts: keep only the latest report and process it after a short window.
                let first = self.latest_ports.lock().expect("ports").insert(sbx.clone(), listening).is_none();
                if !first {
                    return;
                }
                let this = self.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(PORTS_COALESCE).await;
                    let Some(listening) = this.latest_ports.lock().expect("ports").remove(&sbx) else { return };
                    let Some(entry) = this.sandbox(&sbx) else { return };
                    let mut s = entry.lock().await;
                    let now: BTreeSet<u16> = listening.iter().map(|p| p.port).collect();
                    let new: Vec<u16> = now.difference(&s.known_ports).copied().collect();
                    s.known_ports = now;
                    drop(s);
                    for port in new {
                        if this.limiter.allow(&sbx, "ports", limits::PORTS, 1.0) {
                            this.workstream_event(&sbx, None, WorkstreamEventKind::PortOpened { port });
                        }
                    }
                });
            }
            GuestEvent::Cli { agent_id, command, reply } => self.relay_cli(sbx, agent_id, command, reply),
            GuestEvent::TaskExited { agent_id, task } => {
                if !self.limiter.allow(&sbx, "tasks", limits::TASKS, 1.0) {
                    return;
                }
                let Some((_, epoch)) = self.workstream_of(&sbx) else { return };
                self.emit(HostEventBody::TaskExited { sandbox: sbx, epoch, agent: agent_id, task });
            }
            GuestEvent::Ready { resumed, guest } => {
                tracing::debug!(%sbx, resumed, protocol_version = guest.protocol_version, "guest ready");
                let this = self.clone();
                tokio::spawn(async move {
                    let Some(entry) = this.sandbox(&sbx) else { return };
                    let mut s = entry.lock().await;
                    let epoch = s.epoch;
                    if this.fenced(&sbx, epoch) {
                        return; // a hello from a fenced or superseded incarnation changes nothing
                    }
                    s.guest_info = Some(guest.clone());
                    this.gateway_sync(&s);
                    drop(s);
                    // A guest agent that restarted (or reconnected) while the sandbox is already
                    // running announced a possibly different version: report it as an update.
                    let changed = {
                        let mut summary = this.summary.lock().expect("summary");
                        match summary.get_mut(&sbx) {
                            Some(x) if x.epoch == epoch => {
                                let changed = x.state == SandboxState::Running && x.guest.as_ref() != Some(&guest);
                                x.guest = Some(guest.clone());
                                changed
                            }
                            _ => false,
                        }
                    };
                    if changed {
                        this.emit(HostEventBody::SandboxState { sandbox: sbx, epoch, state: SandboxState::Running, suspend_mode: None, detail: None, guest: Some(guest) });
                    }
                });
            }
            GuestEvent::Disconnected => tracing::debug!(%sbx, "guest control disconnected"),
        }
    }

    /// Relay a guest `nest` CLI command to the control plane; the answer comes back as a
    /// `guest_cli_result` command. `ask` may take up to its `wait_s` (≤ 120 s).
    fn relay_cli(self: &Arc<Self>, sbx: SandboxId, agent: Option<AgentId>, command: CliCommand, reply: oneshot::Sender<CliResult>) {
        let Some((_, epoch)) = self.workstream_of(&sbx) else {
            let _ = reply.send(CliResult::Error { error: error(error_codes::UNKNOWN_SANDBOX, format!("{sbx} is not on this host"), false) });
            return;
        };
        let wait = match &command {
            CliCommand::Ask { wait_s, .. } => Duration::from_secs(u64::from((*wait_s).min(120)) + CLI_RELAY_SLACK_S),
            _ => Duration::from_secs(CLI_RELAY_TIMEOUT_S),
        };
        let name = cli_name(&command);
        // Bounded per sandbox: rate and concurrency (an `ask` can be outstanding for minutes).
        let admitted = self.limiter.allow(&sbx, "cli", limits::CLI, 1.0) && {
            let mut inflight = self.cli_inflight.lock().expect("cli");
            let n = inflight.entry(sbx.clone()).or_default();
            if *n >= limits::MAX_CLI_INFLIGHT {
                false
            } else {
                *n += 1;
                true
            }
        };
        if !admitted {
            let _ = reply.send(CliResult::Error { error: error(error_codes::RATE_LIMITED, format!("nest {name}: too many requests from this sandbox"), true) });
            return;
        }
        let request = RequestId(new_id("req_"));
        let (tx, rx) = oneshot::channel();
        self.pending_cli.lock().expect("pending").insert(request.clone(), tx);
        self.emit(HostEventBody::GuestCli { request: request.clone(), sandbox: sbx.clone(), epoch, agent, command });
        let this = self.clone();
        tokio::spawn(async move {
            // The guest gives up after the same wait, so answer slightly before it does.
            let result = match tokio::time::timeout(wait, rx).await {
                Ok(Ok(r)) => r,
                _ => {
                    this.pending_cli.lock().expect("pending").remove(&request);
                    CliResult::Error { error: error(error_codes::INTERNAL, format!("nest {name}: no answer from the control plane"), true) }
                }
            };
            let _ = reply.send(result);
            if let Some(n) = this.cli_inflight.lock().expect("cli").get_mut(&sbx) {
                *n = n.saturating_sub(1);
            }
        });
    }

    /// Self-fence when the lease deadline passes without renewal. The deadline is checked on both
    /// the monotonic clock and `CLOCK_BOOTTIME` (which keeps running while the host is suspended),
    /// polling at least every 250 ms.
    async fn lease_watchdog(self: Arc<Self>, mut rx: watch::Receiver<Option<(Instant, Duration)>>) {
        loop {
            let deadline = *rx.borrow_and_update();
            match deadline {
                None => {
                    if rx.changed().await.is_err() {
                        return;
                    }
                }
                Some((d, db)) => {
                    let expired = Instant::now() >= d || crate::util::boottime() >= db;
                    if expired {
                        self.self_fence().await;
                        // Stay fenced until the next renewal.
                        if rx.changed().await.is_err() {
                            return;
                        }
                        continue;
                    }
                    let wait = d.saturating_duration_since(Instant::now()).min(db.saturating_sub(crate::util::boottime())).min(Duration::from_millis(250));
                    tokio::select! {
                        changed = rx.changed() => { if changed.is_err() { return; } }
                        _ = tokio::time::sleep(wait) => {}
                    }
                }
            }
        }
    }

    /// Lease lapsed: kill every brain (one runner fence), then fence every sandbox.
    async fn self_fence(self: &Arc<Self>) {
        let ids: Vec<SandboxId> = self.summary.lock().expect("summary").iter().filter(|(_, s)| holds_lease(s.state)).map(|(id, _)| id.clone()).collect();
        tracing::error!(sandboxes = ids.len(), "lease expired: self-fencing");
        let unsent = self.runner.fence(vec![], "host lease expired");
        self.brains_exited(unsent.into_iter().map(|a| (a, ExitReason::Fenced)));
        for id in ids {
            self.fence_sandbox(&id, "host lease expired", true, false).await;
        }
    }

    /// Fence one sandbox. Immediately and without the sandbox lock: mark it `Fenced` (terminal for
    /// the epoch), fence its brains (unless the caller already fenced all of them), drop its egress
    /// (the proxy link never blocks), and freeze its vCPUs through the lock-free pauser. Then,
    /// under the lock: close the guest connection, pause, drop the netns, and offer salvage.
    async fn fence_sandbox(self: &Arc<Self>, id: &SandboxId, reason: &str, salvage: bool, fence_brains: bool) {
        let (epoch, dirty) = {
            let mut summary = self.summary.lock().expect("summary");
            let Some(s) = summary.get_mut(id) else { return };
            if s.state == SandboxState::Fenced {
                return;
            }
            s.state = SandboxState::Fenced;
            (s.epoch, s.dirty)
        };
        if fence_brains {
            let unsent = self.runner.fence_sandbox(id, reason);
            self.brains_exited(unsent.into_iter().map(|a| (a, ExitReason::Fenced)));
        }
        if let Some(pauser) = self.pausers.lock().expect("pausers").get(id).cloned() {
            tokio::spawn(async move {
                if let Err(e) = pauser.pause().await {
                    tracing::warn!(error = %e, "fence: lock-free pause failed (retried under the sandbox lock)");
                }
            });
        }
        self.proxy.apply(ProxyOp::Drop { sandbox: id.clone(), epoch, reason: DropReason::Fence });
        self.gateway.remove(id, epoch);
        self.emit(HostEventBody::SandboxState { sandbox: id.clone(), epoch, state: SandboxState::Fenced, suspend_mode: None, detail: Some(reason.into()), guest: None });
        tracing::warn!(sandbox = %id, epoch = epoch.0, reason, "fenced");

        let Some(entry) = self.sandbox(id) else { return };
        let this = self.clone();
        let id = id.clone();
        tokio::spawn(async move {
            let mut s = entry.lock().await;
            if let Some(g) = s.guest.take() {
                g.shutdown();
            }
            // `Fenced` is terminal: this VM never runs again. Stop it now so its memory goes back
            // to the host; salvage needs only the disk, which stays until `sandbox_destroy` (or a
            // newer epoch's create) removes it.
            this.pausers.lock().expect("pausers").remove(&id);
            if let Some(mut vm) = s.vm.take() {
                let _ = vm.stop().await;
            }
            s.paused = false;
            s.netns = None; // drops (and unmounts) the namespace
            drop(s);
            if salvage && dirty {
                this.salvage(entry, id, SALVAGE_TIMEOUT).await;
            }
        });
    }

    /// Offer a fenced sandbox's uncommitted work as a sibling branch (may wait for reconnection).
    /// The sandbox lock is held only while chunking, not while waiting for the answer.
    /// Returns a boxed future: fencing and committing call each other.
    fn salvage(self: Arc<Self>, entry: Arc<tokio::sync::Mutex<Sbx>>, id: SandboxId, timeout: Duration) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
        Box::pin(async move {
            let s = entry.lock().await;
            let (_s, r) = self.commit(&entry, s, CommitReason::Salvage, None, timeout).await;
            match r {
                Ok(Some(g)) => tracing::info!(sandbox = %id, generation = %g.id, "salvage committed"),
                Ok(None) => {}
                Err(e) => tracing::warn!(sandbox = %id, code = %e.code, "salvage commit failed"),
            }
        })
    }

    /// Ask the control plane whether a GC pass is due, soon after start and then hourly (hosts
    /// come and go; whichever is up when one is due runs it), and run it.
    async fn gc_loop(self: Arc<Self>) {
        let http = match reqwest::Client::builder().timeout(Duration::from_secs(60)).build() {
            Ok(h) => h,
            Err(e) => return tracing::error!("GC disabled: {e}"),
        };
        tokio::time::sleep(GC_FIRST_CHECK).await;
        loop {
            if let Err(e) = self.gc_once(&http).await {
                tracing::warn!("GC: {e:#}");
            }
            tokio::time::sleep(GC_CHECK_EVERY).await;
        }
    }

    async fn gc_once(&self, http: &reqwest::Client) -> anyhow::Result<()> {
        let base = self.cfg.control_url.trim_end_matches('/');
        let token = || self.host_token.lock().expect("host token").0.clone();
        let res = http.post(format!("{base}/v1/hosts/gc/claim")).bearer_auth(token()).send().await?;
        if res.status() == reqwest::StatusCode::NO_CONTENT {
            return Ok(());
        }
        let claim: crate::gc::Claim = res.error_for_status()?.json().await?;
        let Some(s3) = self.s3.clone() else { return Ok(()) };
        tracing::info!(run = %claim.run, dry_run = claim.dry_run, roots = claim.roots.len(), "GC pass starting");
        let c = claim.clone();
        let report = tokio::task::spawn_blocking(move || crate::gc::run(&s3, &c, &|| now_ms())).await?;
        tracing::info!(run = %claim.run, ?report, "GC pass done");
        http.post(format!("{base}/v1/hosts/gc/report"))
            .bearer_auth(token())
            .json(&serde_json::json!({ "run": claim.run, "report": report }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Periodic: renew the proxy intermediate CA before it expires; report capacity changes.
    /// Poll IMDS for a spot interruption every 5 s and report it once.
    async fn spot_watch(self: Arc<Self>, imds_url: String) {
        let http = match reqwest::Client::builder().timeout(Duration::from_secs(2)).build() {
            Ok(h) => h,
            Err(e) => return tracing::error!("spot watch disabled: {e}"),
        };
        loop {
            match crate::enroll::spot_deadline(&http, &imds_url).await {
                Ok(Some(deadline_ms)) => {
                    tracing::warn!(deadline_ms, "spot interruption notice: draining");
                    self.emit(HostEventBody::SpotNotice { deadline_ms });
                    return;
                }
                Ok(None) => {}
                Err(e) => tracing::debug!("spot watch: {e:#}"),
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn housekeeping(self: Arc<Self>) {
        let mut last_capacity: Option<(Capacity, Instant)> = None;
        loop {
            self.maybe_renew_ca();
            let capacity = {
                let summary = self.summary.lock().expect("summary");
                self.capacity(&summary)
            };
            let stale = match &last_capacity {
                None => true,
                Some((c, at)) => *c != capacity || at.elapsed() > Duration::from_secs(600),
            };
            if stale {
                self.emit(HostEventBody::Capacity { capacity: capacity.clone() });
                last_capacity = Some((capacity, Instant::now()));
            }
            tokio::time::sleep(CAPACITY_EVERY).await;
        }
    }

    /// Send a `ca_renew` CSR (new key) when the proxy CA is within [`CA_RENEW_BEFORE_MS`] of
    /// expiry; retry after [`CA_RENEW_RETRY`] without an answer. An expired CA breaks inspected
    /// egress (the proxy fails closed), so it is logged loudly.
    fn maybe_renew_ca(&self) {
        let mut st = self.proxy_ca.lock().expect("ca");
        let Some(expires) = st.expires_ms else { return };
        let remaining = expires - now_ms();
        if remaining <= 0 {
            tracing::error!(expires_ms = expires, "proxy intermediate CA has EXPIRED: inspected egress fails closed until renewed");
        }
        if remaining > CA_RENEW_BEFORE_MS {
            return;
        }
        if st.pending.as_ref().is_some_and(|(_, at)| at.elapsed() < CA_RENEW_RETRY) {
            return;
        }
        match crate::enroll::proxy_ca_csr(&self.cfg.cell) {
            Ok((key, csr_pem)) => {
                tracing::info!(expires_ms = expires, "renewing the proxy intermediate CA");
                st.pending = Some((key, Instant::now()));
                let _ = self.fleet.send(FleetInput::CaRenew { csr_pem });
            }
            Err(e) => tracing::error!(error = %e, "proxy CA renewal: CSR generation failed"),
        }
    }

    // ------------------------------------------------------------------------------------------
    // Commands
    // ------------------------------------------------------------------------------------------

    async fn execute(self: &Arc<Self>, cmd: Command) {
        let cached = self.results.lock().expect("results").map.get(&cmd.cmd.0).cloned();
        if let Some(outcome) = cached {
            self.emit(HostEventBody::CommandResult { cmd: cmd.cmd, outcome });
            return;
        }
        let kind = command_kind(&cmd.body);
        let result = self.dispatch(cmd.body).await;
        let outcome = match result {
            Ok(detail) => CommandOutcome::Ok { detail },
            Err(error) => {
                tracing::warn!(cmd = %cmd.cmd, kind, code = %error.code, message = %error.message, "command failed");
                CommandOutcome::Error { error }
            }
        };
        self.results.lock().expect("results").insert(&cmd.cmd.0, outcome.clone());
        self.emit(HostEventBody::CommandResult { cmd: cmd.cmd, outcome });
    }

    async fn dispatch(self: &Arc<Self>, body: CommandBody) -> CmdResult {
        match body {
            CommandBody::SandboxCreate { sandbox, workstream, epoch, image, resources, policy, from } => {
                self.create_sandbox(sandbox, workstream, epoch, image, resources, policy, from, None).await
            }
            CommandBody::SandboxSuspend { sandbox, epoch, mode } => self.suspend(&sandbox, epoch, mode).await,
            CommandBody::SandboxResume { sandbox, epoch } => self.resume(&sandbox, epoch).await,
            CommandBody::SandboxArchive { sandbox, epoch } => self.archive(&sandbox, epoch).await,
            CommandBody::SandboxCheckpoint { sandbox, epoch, reason } => self.checkpoint(&sandbox, epoch, reason).await,
            CommandBody::SandboxFork { parent, parent_epoch, child, child_epoch, child_workstream, mode, policy } => {
                self.fork(&parent, parent_epoch, child, child_epoch, child_workstream, mode, policy).await
            }
            CommandBody::SandboxDestroy { sandbox, epoch } => self.destroy(&sandbox, epoch).await,
            CommandBody::PolicyUpdate { sandbox, epoch, policy } => self.policy_update(&sandbox, epoch, policy).await,
            CommandBody::SecretsUpdate { sandbox, epoch, secrets } => {
                self.check_epoch(&sandbox, epoch)?;
                self.proxy.apply(ProxyOp::Secrets { sandbox, epoch, secrets });
                Ok(None)
            }
            CommandBody::PortExpose { sandbox, epoch, port, host_header } => {
                self.check_epoch(&sandbox, epoch)?;
                if let Some(e) = self.sandbox(&sandbox) {
                    e.lock().await.exposed.insert(port, host_header);
                }
                // TODO(preview-router): program the router; exposure is recorded only.
                Ok(Some(serde_json::json!({ "note": "preview router not implemented; exposure recorded" })))
            }
            CommandBody::PortUnexpose { sandbox, epoch, port } => {
                self.check_epoch(&sandbox, epoch)?;
                if let Some(e) = self.sandbox(&sandbox) {
                    e.lock().await.exposed.remove(&port);
                }
                Ok(None)
            }
            // Resolved on receipt (see `on_fleet_notice`).
            CommandBody::CommitResult { .. } | CommandBody::GuestCliResult { .. } => Ok(None),
            CommandBody::AgentStart(start) => self.agent_start(start).await,
            CommandBody::AgentAttach { sandbox, epoch, agent, cwd } => self.agent_attach(&sandbox, epoch, &agent, cwd).await,
            CommandBody::AgentDetach { sandbox, epoch, agent, kill_processes } => self.agent_detach(&sandbox, epoch, &agent, kill_processes).await,
            CommandBody::AgentStop { agent, reason } => {
                self.runner.agent_stop(&agent, StopMode::Graceful, &reason);
                Ok(None)
            }
            // Already applied on arrival (`on_fleet_notice`); this is the in-order no-op.
            CommandBody::Fence { sandboxes, reason } => {
                for s in sandboxes {
                    self.fence_sandbox(&s, &reason, true, true).await;
                }
                Ok(None)
            }
            CommandBody::Drain { reason, deadline_ms } => self.drain(&reason, deadline_ms).await,
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_sandbox(
        self: &Arc<Self>,
        sandbox: SandboxId,
        workstream: WorkstreamId,
        epoch: Epoch,
        image: String,
        resources: Resources,
        policy: EgressPolicy,
        from: Option<GenerationRecord>,
        fork: Option<ForkIdentity>,
    ) -> CmdResult {
        let existing = self.summary.lock().expect("summary").get(&sandbox).cloned();
        if let Some(s) = existing {
            if s.epoch == epoch && s.state == SandboxState::Running {
                return Ok(Some(serde_json::json!({ "note": "already running" })));
            }
            if s.epoch == epoch && s.state == SandboxState::Fenced {
                return Err(error(error_codes::STALE_EPOCH, format!("{sandbox}@{} was fenced here", epoch.0), false));
            }
            if s.epoch > epoch {
                return Err(error(error_codes::STALE_EPOCH, format!("{sandbox} already at epoch {}", s.epoch.0), false));
            }
            // An older local incarnation. Its lease has moved on: fence it, and salvage its
            // uncommitted work before the new epoch reuses the sandbox's disk.
            self.fence_sandbox(&sandbox, "superseded by a newer epoch", false, true).await;
            let dirty = self.summary.lock().expect("summary").get(&sandbox).is_some_and(|x| x.dirty);
            if dirty
                && let Some(entry) = self.sandbox(&sandbox)
            {
                self.clone().salvage(entry, sandbox.clone(), self.cfg.commit_timeout()).await;
            }
            self.teardown(&sandbox, DropReason::Moved).await;
        }
        let vm_dir = self.cfg.vm_dir(&sandbox.0);
        let state_dir = self.cfg.sandbox_state_dir(&sandbox.0);
        std::fs::create_dir_all(&state_dir).map_err(internal)?;
        let restoring = from.is_some();
        let initial = if restoring { SandboxState::Restoring } else { SandboxState::Creating };
        self.summary.lock().expect("summary").insert(
            sandbox.clone(),
            Summary { workstream: workstream.clone(), epoch, state: initial, head: from.as_ref().map(|g| g.id.clone()), dirty: false, resources, guest: None },
        );
        self.emit(HostEventBody::SandboxState { sandbox: sandbox.clone(), epoch, state: initial, suspend_mode: None, detail: None, guest: None });

        let sbx = Sbx {
            id: sandbox.clone(),
            workstream: workstream.clone(),
            epoch,
            image: image.clone(),
            resources,
            policy: policy.clone(),
            head: from.clone(),
            vm: None,
            paused: false,
            netns: None,
            guest: None,
            next_listener: 1,
            slots: BTreeMap::new(),
            slot_cwds: BTreeMap::new(),
            tcp_listeners: BTreeMap::new(),
            known_ports: BTreeSet::new(),
            exposed: BTreeMap::new(),
            vm_dir,
            state_dir,
            guest_info: None,
            unanswered: None,
        };
        // Boot while holding the sandbox's own lock: guest events and fencing wait for it.
        let entry = Arc::new(tokio::sync::Mutex::new(sbx));
        let mut guard = entry.clone().lock_owned().await;
        self.sandboxes.lock().expect("sandboxes").insert(sandbox.clone(), entry);
        let r = self.boot(&mut guard, from.as_ref(), fork).await;
        if r.is_ok() {
            guard.guest_info = guard.guest.as_ref().and_then(|g| g.guest());
            if let Some(s) = self.summary.lock().expect("summary").get_mut(&sandbox) {
                s.guest = guard.guest_info.clone();
            }
            // Into `running`: reachable from the moment the state is reported.
            self.gateway_upsert(&guard);
        }
        drop(guard);
        let mut detail = None;
        if let Some(g) = &from
            && g.kind == GenerationKind::Checkpoint
        {
            detail = Some("memory restore not implemented (UFFD); cold boot from the disk generation".to_string());
        }
        // Fenced while booting: the fence task pauses whatever was started; report the fence.
        self.ensure_not_fenced(&sandbox, epoch)?;
        match r {
            Ok(()) => {
                if let Some(s) = self.summary.lock().expect("summary").get_mut(&sandbox) {
                    s.dirty = true;
                }
                if !self.set_state(&sandbox, epoch, SandboxState::Running, None, detail.clone()) {
                    return Err(error(error_codes::STALE_EPOCH, format!("{sandbox}@{} was fenced during create", epoch.0), false));
                }
                Ok(detail.map(|d| serde_json::json!({ "note": d })))
            }
            Err(e) => {
                self.set_state(&sandbox, epoch, SandboxState::Failed, None, Some(e.to_string()));
                self.teardown(&sandbox, DropReason::Teardown).await;
                Err(error(error_codes::INTERNAL, format!("create {sandbox}: {e:#}"), true))
            }
        }
    }

    /// Disk, network, VM, guest control. Leaves `sbx` populated even on error (for teardown).
    /// Re-checks for a fence after every await and before every externally visible step.
    async fn boot(self: &Arc<Self>, sbx: &mut Sbx, from: Option<&GenerationRecord>, fork: Option<ForkIdentity>) -> anyhow::Result<()> {
        let (id, epoch) = (sbx.id.clone(), sbx.epoch);
        let check = |what: &str| -> anyhow::Result<()> {
            if self.fenced(&id, epoch) {
                anyhow::bail!("{id}@{} fenced before {what}", epoch.0);
            }
            Ok(())
        };
        // Disk.
        let disk = sbx.disk_path();
        let store = self.store.clone();
        let disk_gib = sbx.resources.disk_gib as u64;
        let base_image = match &self.cfg.driver {
            DriverConfig::Firecracker(fc) => Some(fc.images_dir.join(format!("{}.ext4", sbx.image))),
            DriverConfig::Process { .. } => None,
        };
        let from_manifest = from.map(|g| g.disk_manifest.clone());
        tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
            match (from_manifest, base_image) {
                (Some(m), _) => {
                    storage::restore_file(store.as_ref(), &m, &disk).context("restore disk generation")?;
                }
                (None, Some(img)) if img.exists() => {
                    std::fs::copy(&img, &disk).with_context(|| format!("copy base image {}", img.display()))?;
                    let f = std::fs::OpenOptions::new().write(true).open(&disk)?;
                    if f.metadata()?.len() < disk_gib << 30 {
                        f.set_len(disk_gib << 30)?;
                        drop(f);
                        // Grow the filesystem with the file, offline, before the guest mounts it (the
                        // guest can't resize its own root: it isn't /dev/vda to resize2fs).
                        grow_filesystem(&disk)?;
                    }
                }
                _ => storage::create_sparse(&disk, disk_gib << 30).context("create sparse disk")?,
            }
            Ok(())
        })
        .await??;

        // Network (pushes listeners to the proxy).
        check("network setup")?;
        self.setup_network(sbx).context("sandbox network")?;

        // VM.
        check("VM start")?;
        let spec = VmSpec {
            sandbox: sbx.id.clone(),
            epoch: sbx.epoch,
            image: sbx.image.clone(),
            resources: sbx.resources,
            vm_dir: sbx.vm_dir.clone(),
            disk_path: sbx.disk_path(),
            netns: sbx.netns.clone(),
        };
        let mut vm = self.driver.create(spec).await.context("create VM")?;
        vm.start().await.context("start VM")?;
        let uds = vm.vsock_uds_path();
        self.register_pauser(&sbx.id, vm.as_ref());
        sbx.vm = Some(vm);
        sbx.paused = false;
        check("guest connection")?;

        // Guest control.
        let guest = GuestCtl::spawn(uds, sbx.id.clone(), sbx.epoch, hostname(&sbx.id), self.guest_events.clone());
        if fork.is_some() {
            guest.expect_resume(fork);
        }
        sbx.guest = Some(guest.clone());
        guest.wait_ready(GUEST_READY_TIMEOUT).await.context("guest agent")?;
        Ok(())
    }

    fn register_pauser(&self, id: &SandboxId, vm: &dyn Vm) {
        if let Some(p) = vm.pauser() {
            self.pausers.lock().expect("pausers").insert(id.clone(), p);
        }
    }

    /// Create the netns, its standard listeners, and push policy + listeners to the proxy.
    fn setup_network(&self, sbx: &mut Sbx) -> anyhow::Result<()> {
        let mut listeners = vec![];
        if let NetworkConfig::Netns { persist_dir } = &self.cfg.network {
            let persist = persist_dir.as_ref().map(|d| d.join(format!("ns-{}", sbx.id.0)));
            let ns = Arc::new(Netns::create(persist.as_deref()).context("create netns")?);
            // A jailed Firecracker runs as the jail's user, which must be able to attach to the tap.
            let tap_owner = match &self.cfg.driver {
                DriverConfig::Firecracker(fc) if fc.jailer_bin.is_some() => fc.jailer.as_ref().map(|j| (j.uid, j.gid)),
                _ => None,
            };
            ns.configure(tap_owner).context("configure netns")?;
            let std_listeners: [(Transport, u16, ListenerPurpose); 4] = [
                (Transport::Udp, 53, ListenerPurpose::Dns),
                (Transport::Tcp, 53, ListenerPurpose::Dns),
                (Transport::Tcp, 80, ListenerPurpose::HttpTransparent),
                (Transport::Tcp, 443, ListenerPurpose::HttpsTransparent),
            ];
            for (transport, port, purpose) in std_listeners {
                listeners.push(bind_listener(&ns, &mut sbx.next_listener, transport, port, purpose)?);
            }
            for (i, rule) in sbx.policy.tcp.iter().enumerate() {
                let key = format!("{}:{}", rule.host, rule.port);
                let port = TCP_EXCEPTION_BASE_PORT + i as u16;
                let l = bind_listener(&ns, &mut sbx.next_listener, Transport::Tcp, port, ListenerPurpose::TcpException { rule: key.clone() })?;
                sbx.tcp_listeners.insert(key, (l.spec.id, port));
                listeners.push(l);
            }
            sbx.netns = Some(ns);
        }
        // The proxy link refuses all of these for an epoch already dropped by a fence.
        if !self.proxy.apply(ProxyOp::Upsert { sandbox: sbx.id.clone(), epoch: sbx.epoch, workstream: Some(sbx.workstream.clone()), policy: sbx.policy.clone() }) {
            anyhow::bail!("{} was fenced: proxy refused the sandbox", sbx.id);
        }
        self.proxy.apply(ProxyOp::Secrets { sandbox: sbx.id.clone(), epoch: sbx.epoch, secrets: vec![] });
        if !listeners.is_empty() {
            self.proxy.apply(ProxyOp::AddListeners { sandbox: sbx.id.clone(), epoch: sbx.epoch, listeners });
        }
        Ok(())
    }

    /// Stop the VM and drop network state; forget the sandbox locally.
    async fn teardown(self: &Arc<Self>, id: &SandboxId, reason: DropReason) {
        let epoch = self.summary.lock().expect("summary").get(id).map(|s| s.epoch);
        if let Some(epoch) = epoch {
            self.proxy.apply(ProxyOp::Drop { sandbox: id.clone(), epoch, reason });
        }
        // No tombstone here: a failed create is retried at the same epoch, and a destroy, archive
        // or move ends the sandbox's time here without fencing it. Only a fence tombstones.
        self.gateway.forget(id);
        self.pausers.lock().expect("pausers").remove(id);
        self.latest_ports.lock().expect("ports").remove(id);
        self.cli_inflight.lock().expect("cli").remove(id);
        self.limiter.forget(id);
        let entry = self.sandboxes.lock().expect("sandboxes").remove(id);
        if let Some(entry) = entry {
            let mut s = entry.lock().await;
            if let Some(g) = s.guest.take() {
                g.shutdown();
            }
            if let Some(mut vm) = s.vm.take() {
                let _ = vm.stop().await;
            }
            s.netns = None;
            let _ = std::fs::remove_dir_all(&s.vm_dir);
        }
        self.summary.lock().expect("summary").remove(id);
    }

    async fn locked(&self, id: &SandboxId, epoch: Epoch) -> Result<Arc<tokio::sync::Mutex<Sbx>>, ErrorBody> {
        self.check_epoch(id, epoch)?;
        self.sandbox(id).ok_or_else(|| error(error_codes::UNKNOWN_SANDBOX, format!("{id} is not on this host"), false))
    }

    async fn suspend(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, mode: SuspendMode) -> CmdResult {
        let entry = self.locked(id, epoch).await?;
        let mut s = entry.lock().await;
        self.ensure_not_fenced(id, epoch)?;
        let state = self.summary.lock().expect("summary").get(id).map(|x| x.state);
        if state == Some(SandboxState::Suspended) {
            return Ok(Some(serde_json::json!({ "note": "already suspended" })));
        }
        if !self.set_state(id, epoch, SandboxState::Suspending, Some(mode), None) {
            return Err(error(error_codes::STALE_EPOCH, format!("{id} was fenced"), false));
        }
        if let Some(g) = &s.guest {
            let _ = g.prepare_snapshot(matches!(mode, SuspendMode::Memory)).await;
        }
        if let Some(vm) = s.vm.as_mut() {
            vm.pause().await.map_err(internal)?;
        }
        s.paused = true;
        let mem = if matches!(mode, SuspendMode::Memory) && self.driver.supports_memory_snapshots() {
            let dir = s.state_dir.join("snapshot");
            match s.vm.as_mut() {
                Some(vm) => vm.snapshot_memory(&dir).await.map_err(internal)?,
                None => None,
            }
        } else {
            None
        };
        let (mut s, r) = self.commit(&entry, s, CommitReason::Suspend, mem, self.cfg.commit_timeout()).await;
        r?;
        self.ensure_not_fenced(id, epoch)?;
        let mut detail = None;
        if matches!(mode, SuspendMode::DiskOnly) {
            // Disk-only: release the VM; resume is a cold boot.
            if let Some(g) = s.guest.take() {
                g.shutdown();
            }
            if let Some(mut vm) = s.vm.take() {
                let _ = vm.stop().await;
            }
            self.pausers.lock().expect("pausers").remove(id);
            s.paused = false;
        } else if !self.driver.supports_memory_snapshots() {
            detail = Some("driver keeps memory by pausing locally; generation is disk-only".to_string());
        }
        // Not reachable until resumed: clients re-resolve once instead of retrying `busy`.
        self.gateway.forget(id);
        if !self.set_state(id, epoch, SandboxState::Suspended, Some(mode), detail.clone()) {
            return Err(error(error_codes::STALE_EPOCH, format!("{id} was fenced"), false));
        }
        Ok(detail.map(|d| serde_json::json!({ "note": d })))
    }

    async fn resume(self: &Arc<Self>, id: &SandboxId, epoch: Epoch) -> CmdResult {
        let entry = self.locked(id, epoch).await?;
        let mut s = entry.lock().await;
        self.ensure_not_fenced(id, epoch)?;
        let state = self.summary.lock().expect("summary").get(id).map(|x| x.state);
        if state == Some(SandboxState::Running) {
            return Ok(Some(serde_json::json!({ "note": "already running" })));
        }
        if state != Some(SandboxState::Suspended) {
            return Err(error(error_codes::INVALID_MESSAGE, format!("{id} is {state:?}, not suspended"), false));
        }
        if s.vm.is_some() && s.paused {
            self.ensure_not_fenced(id, epoch)?;
            s.vm.as_mut().expect("checked").resume().await.map_err(internal)?;
            s.paused = false;
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
            self.gateway_upsert(&s);
        } else {
            // Cold boot from the local disk.
            let spec = VmSpec {
                sandbox: s.id.clone(),
                epoch: s.epoch,
                image: s.image.clone(),
                resources: s.resources,
                vm_dir: s.vm_dir.clone(),
                disk_path: s.disk_path(),
                netns: s.netns.clone(),
            };
            let mut vm = self.driver.create(spec).await.map_err(internal)?;
            self.ensure_not_fenced(id, epoch)?;
            vm.start().await.map_err(internal)?;
            self.register_pauser(id, vm.as_ref());
            let guest = GuestCtl::spawn(vm.vsock_uds_path(), s.id.clone(), s.epoch, hostname(&s.id), self.guest_events.clone());
            s.vm = Some(vm);
            for (agent, (slot, _)) in s.slots.clone() {
                let cwd = s.slot_cwds.get(&agent).cloned().unwrap_or_else(|| DEFAULT_CWD.into());
                let _ = guest.attach(slot_for(&agent, slot, cwd)).await;
            }
            guest.wait_ready(GUEST_READY_TIMEOUT).await.map_err(internal)?;
            s.guest_info = guest.guest();
            s.guest = Some(guest);
            self.gateway_upsert(&s);
        }
        if let Some(x) = self.summary.lock().expect("summary").get_mut(id) {
            x.dirty = true;
            x.guest = s.guest_info.clone();
        }
        if !self.set_state(id, epoch, SandboxState::Running, None, None) {
            return Err(error(error_codes::STALE_EPOCH, format!("{id} was fenced during resume"), false));
        }
        Ok(None)
    }

    async fn checkpoint(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, reason: CommitReason) -> CmdResult {
        let entry = self.locked(id, epoch).await?;
        let mut s = entry.lock().await;
        let running = s.vm.is_some() && !s.paused;
        // TODO(ublk): epoch-flip CoW cut instead of pausing for the whole chunking pass.
        if let Some(g) = &s.guest {
            let _ = g.prepare_snapshot(false).await;
        }
        if running {
            s.vm.as_mut().expect("checked").pause().await.map_err(internal)?;
        }
        let (mut s, r) = self.commit(&entry, s, reason, None, self.cfg.commit_timeout()).await;
        // Never resume a VM that was fenced while the commit was in flight.
        if running && !self.fenced(id, epoch) {
            if let Some(vm) = s.vm.as_mut() {
                let _ = vm.resume().await;
            }
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
            if let Some(x) = self.summary.lock().expect("summary").get_mut(id) {
                x.dirty = true;
            }
        }
        let g = r?;
        Ok(g.map(|g| serde_json::json!({ "generation": g.id })))
    }

    async fn archive(self: &Arc<Self>, id: &SandboxId, epoch: Epoch) -> CmdResult {
        let entry = self.locked(id, epoch).await?;
        {
            let mut s = entry.lock().await;
            if !self.set_state(id, epoch, SandboxState::Archiving, None, None) {
                return Err(error(error_codes::STALE_EPOCH, format!("{id} was fenced"), false));
            }
            let dirty = self.summary.lock().expect("summary").get(id).is_some_and(|x| x.dirty);
            if dirty || s.head.is_none() {
                if let Some(vm) = s.vm.as_mut() {
                    let _ = vm.pause().await;
                }
                let (s2, r) = self.commit(&entry, s, CommitReason::Archive, None, self.cfg.commit_timeout()).await;
                s = s2;
                r?;
            }
            self.ensure_not_fenced(id, epoch)?;
            let _ = std::fs::remove_dir_all(&s.state_dir);
        }
        if !self.set_state(id, epoch, SandboxState::Archived, None, None) {
            return Err(error(error_codes::STALE_EPOCH, format!("{id} was fenced"), false));
        }
        self.teardown(id, DropReason::Teardown).await;
        Ok(None)
    }

    async fn destroy(self: &Arc<Self>, id: &SandboxId, epoch: Epoch) -> CmdResult {
        // Destroy is allowed for any local incarnation at or below the command's epoch (including
        // fenced ones, which FleetDO cleans up after reconciliation).
        let local = self.summary.lock().expect("summary").get(id).map(|s| s.epoch);
        if let Some(local) = local
            && local > epoch
        {
            return Err(error(error_codes::STALE_EPOCH, format!("{id} is at epoch {} here", local.0), false));
        }
        let state_dir = self.cfg.sandbox_state_dir(&id.0);
        let exists = self.summary.lock().expect("summary").contains_key(id);
        if exists {
            self.set_state(id, epoch, SandboxState::Destroyed, None, None);
        }
        self.teardown(id, DropReason::Teardown).await;
        let _ = std::fs::remove_dir_all(state_dir);
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)]
    async fn fork(
        self: &Arc<Self>,
        parent: &SandboxId,
        parent_epoch: Epoch,
        child: SandboxId,
        child_epoch: Epoch,
        child_workstream: WorkstreamId,
        mode: ForkMode,
        policy: EgressPolicy,
    ) -> CmdResult {
        let entry = self.locked(parent, parent_epoch).await?;
        let (image, resources) = {
            let s = entry.lock().await;
            (s.image.clone(), s.resources)
        };
        let generation = self
            .checkpoint(parent, parent_epoch, CommitReason::Fork)
            .await?
            .and_then(|v| v.get("generation").cloned())
            .ok_or_else(|| error(error_codes::INTERNAL, "fork: parent commit produced no generation", true))?;
        let gen_id: GenerationId = serde_json::from_value(generation).map_err(internal)?;
        let record = entry.lock().await.head.clone().filter(|h| h.id == gen_id).ok_or_else(|| error(error_codes::INTERNAL, "fork: head moved", true))?;
        let fork = ForkIdentity { new_sandbox_id: child.clone(), hostname: hostname(&child), machine_id: crate::guest::new_machine_id() };
        let mut r = self.create_sandbox(child, child_workstream, child_epoch, image, resources, policy, Some(record), Some(fork)).await?;
        if matches!(mode, ForkMode::Live) {
            r = Some(serde_json::json!({ "note": "live fork not implemented; child cold-booted from the parent's disk generation" }));
        }
        Ok(r)
    }

    async fn policy_update(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, policy: EgressPolicy) -> CmdResult {
        let entry = self.locked(id, epoch).await?;
        let mut s = entry.lock().await;
        if policy.version <= s.policy.version {
            return Ok(Some(serde_json::json!({ "note": "stale policy version ignored" })));
        }
        s.policy = policy.clone();
        self.proxy.apply(ProxyOp::Upsert { sandbox: id.clone(), epoch, workstream: Some(s.workstream.clone()), policy: policy.clone() });
        // Reconcile TCP-exception listeners.
        if let Some(ns) = s.netns.clone() {
            let wanted: Vec<String> = policy.tcp.iter().map(|t| format!("{}:{}", t.host, t.port)).collect();
            let stale: Vec<String> = s.tcp_listeners.keys().filter(|k| !wanted.contains(k)).cloned().collect();
            if !stale.is_empty() {
                let ids = stale.iter().filter_map(|k| s.tcp_listeners.remove(k)).map(|(id, _)| id).collect();
                self.proxy.apply(ProxyOp::RemoveListeners { sandbox: id.clone(), epoch, ids });
            }
            let missing: Vec<String> = wanted.into_iter().filter(|k| !s.tcp_listeners.contains_key(k)).collect();
            let mut add = vec![];
            for key in missing {
                let used: BTreeSet<u16> = s.tcp_listeners.values().map(|(_, p)| *p).collect();
                let port = (0..1000u16)
                    .map(|i| TCP_EXCEPTION_BASE_PORT + i)
                    .find(|p| !used.contains(p))
                    .ok_or_else(|| error(error_codes::CAPACITY_EXHAUSTED, "no free tcp-exception ports", false))?;
                let l = bind_listener(&ns, &mut s.next_listener, Transport::Tcp, port, ListenerPurpose::TcpException { rule: key.clone() }).map_err(internal)?;
                s.tcp_listeners.insert(key, (l.spec.id, port));
                add.push(l);
            }
            if !add.is_empty() {
                self.proxy.apply(ProxyOp::AddListeners { sandbox: id.clone(), epoch, listeners: add });
            }
        }
        Ok(None)
    }

    /// Start a brain. Hands are the runner's business (it resolves a binding through AgentDO):
    /// nestd only remembers which sandbox the brain is bound to, for fencing.
    async fn agent_start(self: &Arc<Self>, start: nest_protocol::control::AgentStart) -> CmdResult {
        let agent = start.agent.clone();
        let config_dir = self.cfg.agents_dir().join(&agent.0);
        std::fs::create_dir_all(&config_dir).map_err(internal)?;
        let dispatched = self.runner.agent_start(RunnerAgentStart { start, config_dir: config_dir.display().to_string() });
        Ok(Some(serde_json::json!({ "dispatched": dispatched })))
    }

    /// The sandbox side of `attach`: a slot (explicit proxy listener + guest `agent_attach`) for
    /// the agent, then the gateway learns the client. Idempotent: an existing slot keeps its port.
    async fn agent_attach(self: &Arc<Self>, sandbox: &SandboxId, epoch: Epoch, agent: &AgentId, cwd: Option<String>) -> CmdResult {
        let entry = self.locked(sandbox, epoch).await?;
        let mut s = entry.lock().await;
        self.ensure_not_fenced(sandbox, epoch)?;
        let slot = match s.slots.get(agent) {
            Some((slot, _)) => *slot,
            None => {
                let used: BTreeSet<u16> = s.slots.values().map(|(n, _)| *n).collect();
                (0..MAX_AGENT_SLOTS).find(|n| !used.contains(n)).ok_or_else(|| error(error_codes::CAPACITY_EXHAUSTED, "no free agent slots", false))?
            }
        };
        // No guest (a sandbox suspended to disk): refuse before binding anything, so no listener
        // outlives the failed attach and a later one finds its port free.
        let guest = s.guest.clone().ok_or_else(|| error(error_codes::INTERNAL, "sandbox has no guest connection", true))?;
        let mut listener_id = s.slots.get(agent).and_then(|(_, l)| *l);
        if listener_id.is_none()
            && let Some(ns) = s.netns.clone()
        {
            let l = bind_listener(&ns, &mut s.next_listener, Transport::Tcp, EXPLICIT_BASE_PORT + slot, ListenerPurpose::Explicit { agent: agent.clone(), slot })
                .map_err(internal)?;
            listener_id = Some(l.spec.id);
            self.proxy.apply(ProxyOp::AddListeners { sandbox: sandbox.clone(), epoch, listeners: vec![l] });
        }
        let cwd = cwd.unwrap_or_else(|| DEFAULT_CWD.into());
        let fresh = s.slots.insert(agent.clone(), (slot, listener_id)).is_none();
        s.slot_cwds.insert(agent.clone(), cwd.clone());
        self.gateway_sync(&s);
        // The guest round trip (up to 30 s) runs without the sandbox lock, so a fence, suspend or
        // checkpoint is never queued behind it.
        drop(s);
        let attached = guest.attach(slot_for(agent, slot, cwd)).await;
        // Fenced meanwhile: the slot is moot and the answer is `stale_epoch`, whatever the guest said.
        if let Err(e) = self.ensure_not_fenced(sandbox, epoch) {
            if fresh {
                self.drop_slot(&entry, sandbox, epoch, agent).await;
            }
            return Err(e);
        }
        if let Err(e) = attached {
            if fresh {
                self.drop_slot(&entry, sandbox, epoch, agent).await;
            }
            return Err(error(error_codes::INTERNAL, format!("guest agent_attach: {e}"), true));
        }
        Ok(None)
    }

    /// Undo a slot that never took: records (the guest connection's copy included, so no later
    /// `configure` brings it back) and listener go, and the gateway hears about it.
    async fn drop_slot(&self, entry: &Arc<tokio::sync::Mutex<Sbx>>, sandbox: &SandboxId, epoch: Epoch, agent: &AgentId) {
        let mut s = entry.lock().await;
        if let Some((_, Some(id))) = s.slots.remove(agent) {
            self.proxy.apply(ProxyOp::RemoveListeners { sandbox: sandbox.clone(), epoch, ids: vec![id] });
        }
        s.slot_cwds.remove(agent);
        if let Some(g) = &s.guest {
            g.forget_slot(agent);
        }
        self.gateway_sync(&s);
    }

    /// Remove an agent's slot (an unknown agent is `ok`); with `kill_processes`, its whole cgroup
    /// goes first. The gateway then refuses the agent's bindings.
    async fn agent_detach(self: &Arc<Self>, sandbox: &SandboxId, epoch: Epoch, agent: &AgentId, kill_processes: bool) -> CmdResult {
        let entry = self.locked(sandbox, epoch).await?;
        let mut s = entry.lock().await;
        let Some((_, listener)) = s.slots.remove(agent) else {
            // Not ours, and not the guest connection's either (no stale slot is re-configured).
            if let Some(g) = &s.guest {
                g.forget_slot(agent);
            }
            return Ok(Some(serde_json::json!({ "note": "not attached" })));
        };
        s.slot_cwds.remove(agent);
        if let Some(id) = listener {
            self.proxy.apply(ProxyOp::RemoveListeners { sandbox: sandbox.clone(), epoch, ids: vec![id] });
        }
        self.gateway_sync(&s);
        if let Some(g) = s.guest.clone() {
            drop(s);
            g.detach(agent, kill_processes).await.map_err(|e| error(error_codes::INTERNAL, format!("guest agent_detach: {e}"), true))?;
        }
        Ok(None)
    }


    async fn drain(self: &Arc<Self>, reason: &str, deadline_ms: i64) -> CmdResult {
        tracing::warn!(reason, deadline_ms, "draining");
        let running: Vec<(SandboxId, Epoch)> = self
            .summary
            .lock()
            .expect("summary")
            .iter()
            .filter(|(_, s)| s.state == SandboxState::Running)
            .map(|(id, s)| (id.clone(), s.epoch))
            .collect();
        let mut failed = vec![];
        for (id, epoch) in running {
            let budget = Duration::from_millis((deadline_ms - now_ms()).max(0) as u64);
            match tokio::time::timeout(budget, self.suspend(&id, epoch, SuspendMode::DiskOnly)).await {
                Ok(Ok(_)) => {}
                _ => failed.push(id.0),
            }
        }
        if failed.is_empty() { Ok(None) } else { Err(error(error_codes::INTERNAL, format!("not drained: {}", failed.join(", ")), true)) }
    }

    /// Chunk disk (+ memory) into the store and compare-and-set the head through the control
    /// plane. `Ok(None)`: nothing to commit. A `stale_epoch` rejection fences the sandbox.
    ///
    /// The sandbox lock (`s`) is held while chunking (the disk must be stable) but **released
    /// while waiting for `commit_result`**, then re-taken and returned with the result: a slow or
    /// partitioned control plane never blocks fencing, guest events or other commands on this
    /// sandbox.
    async fn commit<'a>(
        self: &Arc<Self>,
        entry: &'a Arc<tokio::sync::Mutex<Sbx>>,
        mut s: tokio::sync::MutexGuard<'a, Sbx>,
        reason: CommitReason,
        mem: Option<PathBuf>,
        timeout: Duration,
    ) -> (tokio::sync::MutexGuard<'a, Sbx>, Result<Option<GenerationRecord>, ErrorBody>) {
        // An earlier commit's answer was lost (timed out), but SandboxDO may have moved its head:
        // ask again under the same request id (idempotent per id) and adopt the outcome, rather
        // than send a new request with a stale parent that is rejected and fences the sandbox.
        let mut answered = None;
        if let Some(prev) = s.unanswered.clone() {
            let (s2, r) = self.send_commit(entry, s, prev.clone(), timeout).await;
            s = s2;
            match r {
                Ok(g) => answered = Some((prev, g)),
                Err(e) => return (s, Err(e)),
            }
        }
        let c = match self.prepare_commit(&mut s, reason, mem).await {
            Ok(Some(c)) => c,
            Ok(None) => return (s, Ok(answered.and_then(|(_, g)| g))),
            Err(e) => return (s, Err(e)),
        };
        // Nothing changed since the commit just answered: its generation is this one.
        if let Some((prev, g)) = answered
            && (&prev.disk_manifest, &prev.mem_manifest) == (&c.disk_manifest, &c.mem_manifest)
        {
            return (s, Ok(g));
        }
        self.send_commit(entry, s, c, timeout).await
    }

    /// Send a `commit_request` and wait (unlocked) for its answer; a timeout keeps it as
    /// [`Sbx::unanswered`] for the next commit to ask again.
    async fn send_commit<'a>(
        self: &Arc<Self>,
        entry: &'a Arc<tokio::sync::Mutex<Sbx>>,
        s: tokio::sync::MutexGuard<'a, Sbx>,
        c: SentCommit,
        timeout: Duration,
    ) -> (tokio::sync::MutexGuard<'a, Sbx>, Result<Option<GenerationRecord>, ErrorBody>) {
        let (tx, rx) = oneshot::channel();
        self.pending_commits.lock().expect("pending").insert(c.request.clone(), tx);
        self.emit(HostEventBody::CommitRequest {
            request: c.request.clone(),
            sandbox: s.id.clone(),
            epoch: s.epoch,
            parent: c.parent.clone(),
            kind: c.kind,
            disk_manifest: c.disk_manifest.clone(),
            mem_manifest: c.mem_manifest.clone(),
            reason: c.reason,
        });
        let id = s.id.clone();
        drop(s);
        let outcome = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(o)) => Ok(o),
            _ => {
                self.pending_commits.lock().expect("pending").remove(&c.request);
                Err(error(error_codes::INTERNAL, format!("commit {} timed out", c.request), true))
            }
        };
        let mut s = entry.lock().await;
        let r = match outcome {
            Ok(o) => {
                if s.unanswered.as_ref().is_some_and(|u| u.request == c.request) {
                    s.unanswered = None;
                }
                self.apply_commit(&mut s, &id, o)
            }
            Err(e) => {
                s.unanswered = Some(c);
                Err(e)
            }
        };
        (s, r)
    }

    /// Chunk disk (+ memory) into the store and build the `commit_request` (a new request id).
    async fn prepare_commit(self: &Arc<Self>, s: &mut Sbx, reason: CommitReason, mem: Option<PathBuf>) -> Result<Option<SentCommit>, ErrorBody> {
        let disk = s.disk_path();
        if !disk.exists() {
            return Ok(None);
        }
        let store = self.store.clone();
        let (disk_manifest, mem_manifest) = tokio::task::spawn_blocking(move || -> std::io::Result<(ManifestHash, Option<ManifestHash>)> {
            let (_, d) = storage::commit_file(store.as_ref(), &disk, ManifestKind::Disk)?;
            let m = match mem {
                Some(p) => Some(storage::commit_file(store.as_ref(), &p, ManifestKind::Memory)?.1),
                None => None,
            };
            Ok((d, m))
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
        if reason == CommitReason::Salvage
            && let Some(x) = self.summary.lock().expect("summary").get_mut(&s.id)
        {
            // The work is captured in the store now: the disk may be reused by a newer epoch.
            x.dirty = false;
        }
        let kind = if mem_manifest.is_some() { GenerationKind::Checkpoint } else { GenerationKind::DiskOnly };
        Ok(Some(SentCommit { request: RequestId(new_id("req_")), parent: s.head.as_ref().map(|h| h.id.clone()), kind, disk_manifest, mem_manifest, reason }))
    }

    fn apply_commit(self: &Arc<Self>, s: &mut Sbx, id: &SandboxId, outcome: CommitOutcome) -> Result<Option<GenerationRecord>, ErrorBody> {
        match outcome {
            CommitOutcome::Committed { generation } => {
                s.head = Some(generation.clone());
                if let Some(x) = self.summary.lock().expect("summary").get_mut(id) {
                    x.head = Some(generation.id.clone());
                    x.dirty = false;
                }
                Ok(Some(generation))
            }
            CommitOutcome::Orphaned { generation } => Ok(Some(generation)),
            CommitOutcome::Rejected { reason: why, .. } => {
                if why == error_codes::STALE_EPOCH || why == error_codes::PARENT_MISMATCH {
                    let this = self.clone();
                    let id = id.clone();
                    // Fence; the uncommitted work is offered as salvage (a sibling branch).
                    spawn_boxed(async move { this.fence_sandbox(&id, "commit rejected", true, true).await });
                }
                Err(error(&why, format!("commit rejected: {why}"), false))
            }
        }
    }
}

fn bind_listener(ns: &Netns, next: &mut u32, transport: Transport, port: u16, purpose: ListenerPurpose) -> anyhow::Result<HeldListener> {
    let addr: SocketAddr = format!("{GATEWAY_IP}:{port}").parse().expect("valid address");
    let fd = ns.bind(transport, addr).with_context(|| format!("bind {addr} ({transport:?})"))?;
    let id = *next;
    *next += 1;
    Ok(HeldListener { spec: ListenerSpec { id, transport, addr: addr.to_string(), purpose }, fd })
}

/// Spawn through a boxed trait object: fencing and commits call each other, and boxing breaks
/// the recursive future types.
fn spawn_boxed(f: impl std::future::Future<Output = ()> + Send + 'static) {
    let f: std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> = Box::pin(f);
    tokio::spawn(f);
}

/// Whether an audit record is one request's denial: what `egress_denied` reports. nest-proxy's
/// other deny records are aggregates with port 0 — a window's suppression summary (`count` set,
/// host `*`) and `connection_limit` (no host) — and stay in the audit log only.
fn is_request_denial(r: &EgressAuditRecord) -> bool {
    r.verdict == EgressVerdict::Deny && r.count.is_none() && r.port != 0
}

fn slot_for(agent: &AgentId, slot: u16, cwd: String) -> AgentSlot {
    AgentSlot {
        agent_id: agent.clone(),
        proxy_port: EXPLICIT_BASE_PORT + slot,
        cwd,
        env: Default::default(),
        memory_max_bytes: None,
    }
}

fn hostname(id: &SandboxId) -> String {
    id.0.replace('_', "-")
}

fn internal(e: impl std::fmt::Display) -> ErrorBody {
    error(error_codes::INTERNAL, e.to_string(), true)
}

fn cli_name(c: &nest_protocol::guest::CliCommand) -> &'static str {
    use nest_protocol::guest::CliCommand::*;
    match c {
        Notify { .. } => "notify",
        Emit { .. } => "emit",
        Ask { .. } => "ask",
        Expose { .. } => "expose",
        Whoami {} => "whoami",
    }
}

fn command_kind(b: &CommandBody) -> &'static str {
    match b {
        CommandBody::SandboxCreate { .. } => "sandbox_create",
        CommandBody::SandboxSuspend { .. } => "sandbox_suspend",
        CommandBody::SandboxResume { .. } => "sandbox_resume",
        CommandBody::SandboxArchive { .. } => "sandbox_archive",
        CommandBody::SandboxCheckpoint { .. } => "sandbox_checkpoint",
        CommandBody::SandboxFork { .. } => "sandbox_fork",
        CommandBody::SandboxDestroy { .. } => "sandbox_destroy",
        CommandBody::PolicyUpdate { .. } => "policy_update",
        CommandBody::SecretsUpdate { .. } => "secrets_update",
        CommandBody::PortExpose { .. } => "port_expose",
        CommandBody::PortUnexpose { .. } => "port_unexpose",
        CommandBody::CommitResult { .. } => "commit_result",
        CommandBody::GuestCliResult { .. } => "guest_cli_result",
        CommandBody::AgentStart(_) => "agent_start",
        CommandBody::AgentAttach { .. } => "agent_attach",
        CommandBody::AgentDetach { .. } => "agent_detach",
        CommandBody::AgentStop { .. } => "agent_stop",
        CommandBody::Fence { .. } => "fence",
        CommandBody::Drain { .. } => "drain",
    }
}


/// Grow the ext4 filesystem in a freshly copied base image to fill its (just extended) file. The
/// image is new from `mkfs`, so the check resize2fs wants first is skipped (`-f`).
fn grow_filesystem(disk: &std::path::Path) -> anyhow::Result<()> {
    let out = std::process::Command::new("resize2fs").arg("-f").arg(disk).output().context("run resize2fs")?;
    anyhow::ensure!(out.status.success(), "resize2fs {}: {}", disk.display(), String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

#[cfg(test)]
mod tests {
    use nest_protocol::control::{EgressAuditRecord, EgressVerdict};
    use nest_protocol::model::{Epoch, SandboxId};

    fn record(host: &str, port: u16, verdict: EgressVerdict, reason: &str, count: Option<u32>) -> EgressAuditRecord {
        EgressAuditRecord {
            sandbox: SandboxId("sbx_1".into()),
            epoch: Epoch(1),
            agent: None,
            ts_ms: 0,
            via: None,
            host: host.into(),
            port,
            method: None,
            path: None,
            status: None,
            bytes_up: 0,
            bytes_down: 0,
            verdict,
            binding: None,
            reason: Some(reason.into()),
            count,
        }
    }

    /// Guest-proxy review #2: only one request's denial becomes `egress_denied`; nest-proxy's
    /// suppression summaries and connection-limit records are aggregates, not denied hosts.
    #[test]
    fn only_request_denials_become_egress_denied() {
        use super::is_request_denial;
        assert!(is_request_denial(&record("evil.example", 443, EgressVerdict::Deny, "not_allowed", None)));
        assert!(is_request_denial(&record("x.example", 53, EgressVerdict::Deny, "dns_nxdomain", None)));
        assert!(!is_request_denial(&record("*", 0, EgressVerdict::Deny, "suppressed: 9 duplicate or excess deny records", Some(9))), "summary");
        assert!(!is_request_denial(&record("", 0, EgressVerdict::Deny, "connection_limit", None)), "connection limit");
        assert!(!is_request_denial(&record("github.com", 443, EgressVerdict::Allow, "", None)));
    }

    /// A base image extended to a sandbox's disk size gets a filesystem that fills it.
    #[test]
    fn grows_a_copied_base_image_to_its_disk() {
        let dir = tempfile::tempdir().unwrap();
        let img = dir.path().join("disk.img");
        std::fs::File::create(&img).unwrap().set_len(64 << 20).unwrap();
        let ok = std::process::Command::new("mkfs.ext4").args(["-q", "-F"]).arg(&img).status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            eprintln!("NEST-TEST-SKIP: mkfs.ext4 unavailable");
            return;
        }
        let blocks = || {
            let out = std::process::Command::new("dumpe2fs").arg("-h").arg(&img).output().unwrap();
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let line = text.lines().find(|l| l.starts_with("Block count:")).unwrap().to_string();
            line.split_whitespace().last().unwrap().parse::<u64>().unwrap()
        };
        let before = blocks();
        std::fs::OpenOptions::new().write(true).open(&img).unwrap().set_len(256 << 20).unwrap();
        super::grow_filesystem(&img).unwrap();
        let after = blocks();
        assert!(after >= before * 3, "{before} -> {after} blocks");
    }
}
