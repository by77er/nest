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

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Context;
use nestd_core::shadow::{self as shadow_core, Shadows, Slot};
use nestd_core::checkpoint::{DiskStamp, Pass, SENTINEL, ScanMemo};
use nestd_core::incarnation;
use nestd_core::results::ResultCache;
use nest_protocol::control::{
    AgentReport, Capacity, Command, CommandBody, CommandOutcome, CommitOutcome, ComponentVersions, DEFAULT_CWD, EgressAuditRecord,
    EgressVerdict, HostEvent, HostEventBody, HostHeaderMode, LeaseClaim, SandboxReport,
};
use nest_protocol::guest::{AgentSlot, CliCommand, CliResult, ForkIdentity};
use nest_protocol::host::proxy::{DropReason, ListenerPurpose, ListenerSpec, ProxyEvent, Transport, EXPLICIT_BASE_PORT, TCP_EXCEPTION_BASE_PORT};
use nest_protocol::gateway::GuestInfo;
use nest_protocol::host::runner::{AgentStart as RunnerAgentStart, ExitReason, RunnerEvent, StopMode};
use nest_protocol::host::Secret;
use nest_protocol::host::gateway_link::SandboxPause;
use nest_protocol::model::{
    error_codes, AgentId, CommitReason, EgressPolicy, Epoch, ErrorBody, ForkMode, GenerationId, GenerationKind,
    GenerationRecord, HostId, HostRole, Manifest, ManifestHash, ManifestKind, RequestId, Resources, SandboxId, SandboxState, Seq, SuspendMode, SandboxEvent,
    SandboxEventKind, WorkstreamId,
};
use tokio::sync::{mpsc, oneshot, watch};

use crate::config::{Config, DiskCut, DriverConfig, NetworkConfig, StorageConfig};
use crate::s3::{CredentialSource, S3Options, S3Store};
use crate::driver::{Driver, Pauser, Vm, VmSpec};
use crate::enroll::Enrolled;
use crate::fleet::{self, FleetInput, FleetNotice, FleetParams, FleetReporter};
use crate::gateway_link::{Entry as GatewayEntry, GatewayLink, GatewayNotice};
use crate::guest::{GuestCtl, GuestEvent};
use crate::net::{GATEWAY_IP, Netns};
use crate::limits::{self, Limiter, RecentSet};
use crate::proxy_link::{Access, HeldListener, ProxyLink, ProxyNotice, ProxyOp};
use crate::recovery::{self, META_VERSION, SandboxMeta, SentCommit};
use crate::runner_link::{RunnerLink, RunnerNotice};
use crate::storage::{self, ObjectStore};
use crate::tombstones::Tombstones;
use crate::util::{error, new_id, now_ms};

const MAX_AGENT_SLOTS: u16 = 64;
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
/// An egress denial or alert repeated within this window is reported once.
const RELAY_DEDUP_WINDOW: Duration = Duration::from_secs(60);
/// Bound on each relay's dedup set.
const MAX_DENIED_SEEN: usize = 10_000;

#[derive(Clone, Debug)]
struct Summary {
    /// Compat: the `ws_` value the control plane sent, echoed in sandbox events (see `SandboxEvent`).
    workstream: Option<WorkstreamId>,
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
    workstream: Option<WorkstreamId>,
    epoch: Epoch,
    image: String,
    resources: Resources,
    /// `None` only for an incarnation found on disk at start, which never runs again.
    policy: Option<EgressPolicy>,
    head: Option<GenerationRecord>,
    /// The disk is known to equal `head`: a commit landed while no VM ran on it (stopped or
    /// paused), and none has since. Persisted in `meta.json`; a restart deletes a clean incarnation
    /// without salvage or report.
    disk_clean: bool,
    /// Its salvage-and-delete has started (`Inner::retire`): one per incarnation.
    retiring: bool,
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
    /// agent → its slot's environment (`agent_attach.env`)
    slot_envs: BTreeMap<AgentId, BTreeMap<String, String>>,
    /// tcp exception rule (`host:port`) → (listener id, port)
    tcp_listeners: BTreeMap<String, (u32, u16)>,
    known_ports: BTreeSet<u16>,
    exposed: BTreeMap<u16, HostHeaderMode>,
    vm_dir: PathBuf,
    state_dir: PathBuf,
    /// The guest's version and capabilities from its last hello (what the gateway tells clients).
    guest_info: Option<GuestInfo>,
    /// A `commit_request` whose answer never came (timed out, or sent by a previous nestd). The
    /// next commit asks again under the same request id first: SandboxDO answers a repeated id with
    /// its stored outcome.
    unanswered: Option<SentCommit>,
    /// The last pass over the disk a later commit may reuse unread (`nestd_core::checkpoint`). In
    /// memory only: a restarted nestd reads every disk it salvages.
    scan_memo: ScanMemo<Manifest>,
    /// A cut taken and not yet picked up by its background commit (at most one: a newer cut
    /// replaces it; a suspend, archive or salvage drops it, since what it reads is newer).
    pending_cut: Option<PendingCut>,
    /// Which shadow a cut writes and which one a commit reads (M3′).
    shadows: Shadows,
    /// How many times a VM has started or resumed on this disk: a commit marks the disk clean only
    /// if none has since its read (a cut's VM resumes right after the cut).
    runs: u64,
}

impl Sbx {
    #[allow(clippy::too_many_arguments)]
    fn new(
        id: SandboxId,
        workstream: Option<WorkstreamId>,
        epoch: Epoch,
        image: String,
        resources: Resources,
        policy: Option<EgressPolicy>,
        head: Option<GenerationRecord>,
        vm_dir: PathBuf,
        state_dir: PathBuf,
    ) -> Sbx {
        Sbx {
            id,
            workstream,
            epoch,
            image,
            resources,
            policy,
            head,
            disk_clean: false,
            retiring: false,
            vm: None,
            paused: false,
            netns: None,
            guest: None,
            next_listener: 1,
            slots: BTreeMap::new(),
            slot_cwds: BTreeMap::new(),
            slot_envs: BTreeMap::new(),
            tcp_listeners: BTreeMap::new(),
            known_ports: BTreeSet::new(),
            exposed: BTreeMap::new(),
            vm_dir,
            state_dir,
            guest_info: None,
            unanswered: None,
            scan_memo: ScanMemo::new(),
            pending_cut: None,
            shadows: Shadows::new(),
            runs: 0,
        }
    }

    fn disk_path(&self) -> PathBuf {
        self.state_dir.join("disk.img")
    }

    /// Whether the disk may differ from its head or a commit's outcome is unknown: decides salvage
    /// or archive commit. Durable, read under the lock (the reported `dirty` is cleared by a commit
    /// while a VM may still run).
    fn may_hold_work(&self) -> bool {
        !self.disk_clean || self.unanswered.is_some()
    }

    fn vm_spec(&self) -> VmSpec {
        VmSpec {
            sandbox: self.id.clone(),
            epoch: self.epoch,
            image: self.image.clone(),
            resources: self.resources,
            vm_dir: self.vm_dir.clone(),
            disk_path: self.disk_path(),
            netns: self.netns.clone(),
        }
    }

    /// The attached agents' slots, as the guest's `configure` carries them.
    fn agent_slots(&self) -> Vec<AgentSlot> {
        self.slots
            .iter()
            .map(|(agent, (slot, _))| {
                slot_for(agent, *slot, self.slot_cwds.get(agent).cloned().unwrap_or_else(|| DEFAULT_CWD.into()), self.slot_envs.get(agent).cloned().unwrap_or_default())
            })
            .collect()
    }

    /// What `meta.json` records about this incarnation (see `recovery.rs`), with `inflight` as the
    /// unanswered request while one is being sent.
    fn meta(&self, inflight: Option<&SentCommit>) -> SandboxMeta {
        SandboxMeta {
            version: META_VERSION,
            sandbox: self.id.clone(),
            workstream: self.workstream.clone(),
            epoch: self.epoch,
            image: self.image.clone(),
            resources: self.resources,
            head: self.head.clone(),
            clean: self.disk_clean,
            unanswered: inflight.or(self.unanswered.as_ref()).cloned(),
        }
    }

    /// Rewrite this incarnation's `meta.json`.
    fn persist(&self, inflight: Option<&SentCommit>) -> std::io::Result<()> {
        recovery::write_meta(&self.state_dir, &self.meta(inflight))
    }

    /// [`Sbx::persist`] where a failure only costs precision after a restart: logged.
    fn persist_or_log(&self, inflight: Option<&SentCommit>) {
        if let Err(e) = self.persist(inflight) {
            // A destroyed incarnation's directory is gone: nothing to record.
            if self.state_dir.exists() {
                tracing::error!(sandbox = %self.id, epoch = self.epoch.0, error = %e, "updating meta.json");
            }
        }
    }
}

/// An incarnation's state, locked. Owned, so a commit can unlock it while it waits.
type SbxGuard = tokio::sync::OwnedMutexGuard<Sbx>;

/// Lock-free pause handles of running VMs, one per incarnation: a late step of an older epoch (its
/// fence task, queued behind a long salvage) never takes a newer epoch's handle.
#[derive(Default)]
struct Pausers(Mutex<HashMap<(SandboxId, Epoch), Arc<dyn Pauser>>>);

impl Pausers {
    fn insert(&self, id: &SandboxId, epoch: Epoch, p: Arc<dyn Pauser>) {
        self.0.lock().expect("pausers").insert((id.clone(), epoch), p);
    }
    fn get(&self, id: &SandboxId, epoch: Epoch) -> Option<Arc<dyn Pauser>> {
        self.0.lock().expect("pausers").get(&(id.clone(), epoch)).cloned()
    }
    fn remove(&self, id: &SandboxId, epoch: Epoch) {
        self.0.lock().expect("pausers").remove(&(id.clone(), epoch));
    }
}

type CmdResult = Result<Option<serde_json::Value>, ErrorBody>;

pub struct Inner {
    cfg: Config,
    host_id: HostId,
    driver: Arc<dyn Driver>,
    store: Arc<dyn ObjectStore>,
    /// The same store when it's S3: sandbox hosts run its GC.
    s3: Option<Arc<S3Store>>,
    /// The current host token (rotated over the fleet channel), for HTTP calls to the control plane.
    host_token: Mutex<Secret>,
    proxy: ProxyLink,
    runner: RunnerLink,
    gateway: GatewayLink,
    /// Fenced epochs, the one map both links consult (`tombstones.rs`); written by `fence_sandbox`.
    tombstones: Tombstones,
    fleet: mpsc::UnboundedSender<FleetInput>,
    guest_events: mpsc::UnboundedSender<(SandboxId, GuestEvent)>,
    summary: Mutex<BTreeMap<SandboxId, Summary>>,
    sandboxes: Mutex<BTreeMap<SandboxId, Arc<tokio::sync::Mutex<Sbx>>>>,
    pending_commits: Mutex<HashMap<RequestId, oneshot::Sender<CommitOutcome>>>,
    /// Guest `nest` CLI relays awaiting `guest_cli_result`.
    pending_cli: Mutex<HashMap<RequestId, oneshot::Sender<CliResult>>>,
    /// Command dedup (`nestd_core::results`): a redelivered `cmd` answers with its first outcome.
    results: Mutex<ResultCache<CommandOutcome>>,
    lease_deadline: watch::Sender<Option<(Instant, Duration)>>,
    /// Starts against lease lapses (amendment A3).
    lapse_guard: LapseGuard,
    denied_seen: RecentSet<(SandboxId, String, u16)>,
    alerts_seen: RecentSet<(SandboxId, String, String)>,
    proxy_ca: Mutex<CaState>,
    /// Lock-free pause handles of running VMs (fencing freezes vCPUs without the sandbox lock).
    pausers: Pausers,
    limiter: Limiter,
    /// In-flight guest CLI relays per sandbox.
    cli_inflight: Mutex<HashMap<SandboxId, u32>>,
    /// Latest port report per sandbox awaiting the coalescing window.
    latest_ports: Mutex<HashMap<SandboxId, Vec<nest_protocol::guest::ListeningPort>>>,
    /// How a checkpoint cuts a running VM's disk, decided at start.
    cut: CutMode,
    /// One per incarnation, held across a whole commit (its unlocked wait for the answer
    /// included), so commits leave an incarnation one at a time and in order. Taken before the
    /// sandbox lock, never under it.
    commit_locks: Mutex<HashMap<(SandboxId, Epoch), CommitLock>>,
    next_cut: std::sync::atomic::AtomicU64,
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

/// A start never outlives a lease lapse (amendment A3): each `agent_start` command is stamped with
/// the lapse count when it arrives, or as arriving while lapsed, and runs only if neither holds
/// when the executor reaches it.
/// One lock over the lapse count, the lapsed flag and the stamps, so a stamp and a lapse are
/// ordered (N5): a start stamped before a lapse sees it, one stamped after it is stamped as lapsed.
#[derive(Default)]
struct LapseGuard {
    state: Mutex<LapseState>,
}

#[derive(Default)]
struct LapseState {
    lapses: u64,
    lapsed: bool,
    seen: HashMap<String, u64>,
}

impl LapseGuard {
    /// Arrived while lapsed: never runs.
    const WHILE_LAPSED: u64 = u64::MAX;

    fn arrived(&self, cmd: &str) {
        let mut st = self.state.lock().expect("lapse guard");
        let stamp = if st.lapsed { Self::WHILE_LAPSED } else { st.lapses };
        st.seen.entry(cmd.to_owned()).or_insert(stamp);
    }

    fn lapsed(&self) {
        let mut st = self.state.lock().expect("lapse guard");
        st.lapsed = true;
        st.lapses += 1;
    }

    fn renewed(&self) {
        self.state.lock().expect("lapse guard").lapsed = false;
    }

    /// Whether this start arrived while lapsed or a lapse came since (forgotten once asked: the
    /// command's result is cached).
    fn outlived(&self, cmd: &str) -> bool {
        let mut st = self.state.lock().expect("lapse guard");
        let now = st.lapses;
        st.seen.remove(cmd).is_some_and(|s| s != now)
    }
}

fn holds_lease(s: SandboxState) -> bool {
    matches!(s, SandboxState::Creating | SandboxState::Restoring | SandboxState::Running | SandboxState::Suspending | SandboxState::Suspended | SandboxState::Archiving)
}

impl Host {
    /// Start every subsystem. `driver` overrides the configured driver (tests).
    pub async fn start(cfg: Config, enrolled: Enrolled, driver: Option<Arc<dyn Driver>>) -> anyhow::Result<Host> {
        cfg.validate()?;
        // A brain host runs nestd's supervisor duties only: no VMs, netns, proxy, gateway, tunnel
        // or object store of its own (`Config::validate` refused their settings), and it refuses
        // sandbox commands (`host_kind_refusal`). The fleet channel, the lease, self-fencing and the
        // runner link are the same on both kinds.
        let sandbox_host = cfg.role == HostRole::Sandbox;
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
        // What a previous nestd process left, before anything new starts and before the first
        // fleet hello. First no VM process may survive it: kill them (their cgroups, and pidfiles).
        // (`main` entered the delegated cgroup before the runtime started; this reads the outcome.)
        let (delegated, delegation_error) = if cfg.delegated_cgroup {
            match crate::cgroup::delegate(&cfg.cgroup_root) {
                Ok(d) => {
                    tracing::info!(supervisor = %d.supervisor, vms = %d.vms, "running in a delegated cgroup: the unit's stop kills every VMM");
                    (Some(d.clone()), None)
                }
                Err(e) => {
                    tracing::error!(error = %e, "delegated_cgroup is set but nestd could not set up its cgroups: VMMs start under the jailer's default parent");
                    (None, Some(e.clone()))
                }
            }
        } else {
            (None, None)
        };
        if let Some(DriverConfig::Firecracker(fc)) = &cfg.driver
            && fc.jailer_bin.is_some()
        {
            let exe = fc.firecracker_bin.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "firecracker".into());
            for parent in crate::cgroup::vm_parents(&cfg.cgroup_root, &exe, delegated.as_ref()) {
                let n = crate::cgroup::kill_children(&parent, Duration::from_secs(10));
                if n > 0 {
                    tracing::warn!(n, parent = %parent.display(), "killed VMMs left by a previous nestd");
                }
            }
        }
        let n = if sandbox_host { crate::driver::supervise::kill_leftovers(&cfg.vms_dir()) } else { 0 };
        if n > 0 {
            tracing::warn!(n, "killed VM processes left by a previous nestd");
        }
        // Then their network namespaces (with tap0 and nft inside) and runtime directories.
        if let NetworkConfig::Netns { persist_dir: Some(dir) } = &cfg.network {
            let n = crate::net::sweep_persisted(dir);
            if n > 0 {
                tracing::info!(n, "removed netns bind mounts left by a previous nestd");
            }
        }
        let n = if sandbox_host { recovery::sweep_vm_dirs(&cfg.vms_dir()) } else { 0 };
        if n > 0 {
            tracing::info!(n, "removed VM runtime directories left by a previous nestd");
        }
        // Then their disks: a clean one (it equals its head) goes at once, unreported (a suspended
        // sandbox wakes from its head anyway); the others are reported fenced, salvaged, deleted.
        let mut found = vec![];
        let scanned = if sandbox_host { recovery::scan(&cfg.sandboxes_dir()) } else { vec![] };
        for f in scanned {
            if incarnation::deletes_unreported(f.meta.clean, f.meta.unanswered.is_some()) {
                tracing::info!(sandbox = %f.meta.sandbox, epoch = f.meta.epoch.0, "deleting a clean incarnation left by a previous nestd");
                recovery::remove_incarnation(&f.state_dir);
            } else {
                found.push(f);
            }
        }
        if !found.is_empty() {
            tracing::warn!(incarnations = found.len(), "incarnations with uncommitted work left by a previous nestd: reporting them fenced, salvaging, then deleting them");
        }
        let driver: Arc<dyn Driver> = match driver {
            Some(d) => d,
            None => match &cfg.driver {
                None => Arc::new(crate::driver::NoDriver),
                Some(DriverConfig::Process { guest_command, mount_disk }) => {
                    Arc::new(crate::driver::process::ProcessDriver { guest_command: guest_command.clone(), mount_disk: *mount_disk, gateway_gid: cfg.sockets.gateway_gid, run_dir: cfg.run_dir.clone() })
                }
                Some(DriverConfig::Firecracker(fc)) => {
                    if let (Some(_), Some(j)) = (&fc.jailer_bin, &fc.jailer) {
                        match crate::driver::firecracker::remove_stale_jails(fc, j) {
                            Ok(0) => {}
                            Ok(n) => tracing::info!(n, "removed jails left by a crash or reboot"),
                            Err(e) => tracing::warn!("removing stale jails: {e}"),
                        }
                    }
                    Arc::new(crate::driver::firecracker::FirecrackerDriver {
                        cfg: fc.clone(),
                        parent_cgroup: delegated.as_ref().map(|d| d.vms.clone()),
                        cgroup_root: cfg.cgroup_root.clone(),
                        gateway_gid: cfg.sockets.gateway_gid,
                        run_dir: cfg.run_dir.clone(),
                    })
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

        let tombstones = Tombstones::default();
        let (proxy_tx, mut proxy_rx) = mpsc::unbounded_channel();
        let proxy_access = Access { gid: cfg.sockets.gid, allowed_uids: cfg.sockets.proxy_uids.clone() };
        let proxy = if sandbox_host {
            ProxyLink::start(&cfg.proxy_sock(), enrolled.host.clone(), instance_id.clone(), proxy_access, tombstones.clone(), proxy_tx)?
        } else {
            ProxyLink::disabled(tombstones.clone())
        };
        let (runner_tx, mut runner_rx) = mpsc::unbounded_channel();
        let runner_access = Access { gid: cfg.sockets.gid, allowed_uids: cfg.sockets.runner_uids.clone() };
        let runner = RunnerLink::start(&cfg.runner_sock(), enrolled.host.clone(), cfg.role, runner_access, runner_tx)?;
        let (gateway_tx, mut gateway_rx) = mpsc::unbounded_channel();
        let gateway_access = Access { gid: cfg.sockets.gateway_sock_gid(), allowed_uids: cfg.sockets.gateway_uids.clone() };
        let gateway = if sandbox_host {
            GatewayLink::start(&cfg.gateway_sock(), enrolled.host.clone(), gateway_access, tombstones.clone(), gateway_tx)?
        } else {
            GatewayLink::disabled(tombstones.clone())
        };
        let (fleet_tx, fleet_rx) = mpsc::unbounded_channel();
        let (notice_tx, mut notice_rx) = mpsc::unbounded_channel();
        let (guest_tx, mut guest_rx) = mpsc::unbounded_channel();
        let (lease_tx, lease_rx) = watch::channel(None);

        if let Some((ca, key)) = &enrolled.proxy_ca {
            proxy.apply(ProxyOp::CaInstall { ca: ca.clone(), key_pem: key.clone() });
        }
        runner.host_token(enrolled.host_token.clone(), enrolled.host_token_expires_ms);

        // Each incarnation found is a fenced row (one per sandbox: its newest epoch), reported in
        // the hello, with its epoch tombstoned; its Sbx holds only the disk and is not listed
        // among the sandboxes: `retire` owns it.
        let mut summary = BTreeMap::new();
        let mut recovered = vec![];
        for f in found {
            let m = f.meta;
            tombstones.fence(&m.sandbox, m.epoch);
            summary.insert(
                m.sandbox.clone(),
                Summary {
                    workstream: m.workstream.clone(),
                    epoch: m.epoch,
                    state: SandboxState::Fenced,
                    head: m.head.as_ref().map(|g| g.id.clone()),
                    dirty: true,
                    resources: m.resources,
                    guest: None,
                },
            );
            let mut sbx = Sbx::new(m.sandbox.clone(), m.workstream, m.epoch, m.image, m.resources, None, m.head, cfg.vm_dir(&m.sandbox.0, m.epoch.0), f.state_dir);
            sbx.disk_clean = m.clean;
            sbx.unanswered = m.unanswered;
            recovered.push(Arc::new(tokio::sync::Mutex::new(sbx)));
        }

        let cut = if sandbox_host { decide_cut(&cfg) } else { CutMode::None };
        let inner = Arc::new(Inner {
            host_id: enrolled.host.clone(),
            driver,
            store,
            s3,
            host_token: Mutex::new(enrolled.host_token.clone()),
            proxy,
            runner,
            gateway,
            tombstones,
            fleet: fleet_tx,
            guest_events: guest_tx,
            summary: Mutex::new(summary),
            sandboxes: Mutex::new(BTreeMap::new()),
            pending_commits: Mutex::new(HashMap::new()),
            pending_cli: Mutex::new(HashMap::new()),
            results: Mutex::new(ResultCache::default()),
            lease_deadline: lease_tx,
            lapse_guard: LapseGuard::default(),
            denied_seen: RecentSet::new(RELAY_DEDUP_WINDOW, MAX_DENIED_SEEN),
            alerts_seen: RecentSet::new(RELAY_DEDUP_WINDOW, MAX_DENIED_SEEN),
            proxy_ca: Mutex::new(CaState {
                key: enrolled.proxy_ca.as_ref().map(|(_, k)| k.clone()),
                expires_ms: enrolled.proxy_ca.as_ref().map(|(c, _)| c.expires_ms),
                pending: None,
            }),
            pausers: Pausers::default(),
            limiter: Limiter::default(),
            cli_inflight: Mutex::new(HashMap::new()),
            latest_ports: Mutex::new(HashMap::new()),
            cut,
            commit_locks: Mutex::new(HashMap::new()),
            next_cut: std::sync::atomic::AtomicU64::new(1),
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
                cgroup_delegation_error: delegation_error,
            },
            inner.clone(),
            fleet_rx,
            notice_tx,
        );

        // Incarnations left by a previous nestd: salvage (the commit request queues until the fleet
        // connects, after the hello), then delete.
        for entry in recovered {
            inner.retire(entry);
        }

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
        // Object-store GC: sandbox hosts offer to run it; the control plane says when.
        if inner.cfg.role == HostRole::Sandbox && inner.s3.is_some() {
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

    /// The fenced epoch tombstoned for `sandbox` on this host, if any (introspection and tests).
    pub fn fenced_epoch(&self, sandbox: &SandboxId) -> Option<Epoch> {
        self.tombstones.get(sandbox)
    }

    /// Apply `f` to `sandbox`'s summary row only while it is `epoch`'s: an older incarnation (a
    /// retiring one, a late commit answer) never touches a newer one's row.
    fn with_row<R>(&self, sandbox: &SandboxId, epoch: Epoch, f: impl FnOnce(&mut Summary) -> R) -> Option<R> {
        self.summary.lock().expect("summary").get_mut(sandbox).filter(|x| x.epoch == epoch).map(f)
    }

    fn emit(&self, body: HostEventBody) {
        let _ = self.fleet.send(FleetInput::Event(HostEvent { ts_ms: now_ms(), body }));
    }

    /// Report brains that are gone without a runner exit of their own (the runner connection
    /// dropped, or a fenced start was never sent). AgentDO restarts `crashed` and `fenced` brains
    /// that have work with a current `agent_start`.
    fn brains_exited(&self, gone: impl IntoIterator<Item = (AgentId, Epoch, ExitReason)>) {
        for (agent, epoch, reason) in gone {
            // With the agent epoch of that start, so it never counts for a newer one.
            self.emit(HostEventBody::AgentExited { agent, exit_code: None, signal: None, reason: reason.into(), epoch: Some(epoch) });
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

    /// A boot step's check: fail if `s`'s incarnation was fenced before `what`.
    fn unless_fenced(&self, s: &Sbx, what: &str) -> anyhow::Result<()> {
        if self.fenced(&s.id, s.epoch) {
            anyhow::bail!("{}@{} fenced before {what}", s.id, s.epoch.0);
        }
        Ok(())
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

    fn summary_of(&self, id: &SandboxId) -> Option<(Option<WorkstreamId>, Epoch)> {
        self.summary.lock().expect("summary").get(id).map(|s| (s.workstream.clone(), s.epoch))
    }

    fn sandbox_event(&self, sbx: &SandboxId, agent: Option<AgentId>, kind: SandboxEventKind) {
        let Some((workstream, epoch)) = self.summary_of(sbx) else { return };
        self.emit(HostEventBody::SandboxEvent {
            event: SandboxEvent { workstream, ts_ms: now_ms(), agent, sandbox: Some(sbx.clone()), epoch: Some(epoch), kind },
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
                    if matches!(c.body, CommandBody::AgentStart(_)) {
                        self.lapse_guard.arrived(&c.cmd.0);
                    }
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
                                self.fence_current(s, reason).await;
                            }
                        }
                        // A kill takes effect at once too, not behind slow commands: AgentDO starts the
                        // agent elsewhere only once this brain's exit is reported. Its epoch is
                        // remembered (here and, forwarded, in the runner), so a start at or below it
                        // never runs; when no start at or below it went out to the runner, the exit
                        // is reported now. Its result goes out now as well: AgentDO reads a kill
                        // with a result as "this host processes commands" (the in-order no-op in the
                        // executor repeats it, which FleetDO ignores).
                        CommandBody::AgentStop { agent, reason, mode: Some(StopMode::Kill), epoch } => {
                            if !self.runner.kill(agent, *epoch, reason) {
                                self.emit(HostEventBody::AgentExited { agent: agent.clone(), exit_code: None, signal: None, reason: nest_protocol::control::AgentExitReason::Stopped, epoch: *epoch });
                            }
                            let outcome = CommandOutcome::Ok { detail: None };
                            self.results.lock().expect("results").insert(&c.cmd.0, outcome.clone());
                            self.emit(HostEventBody::CommandResult { cmd: c.cmd.clone(), outcome });
                        }
                        _ => {}
                    }
                }
                let _ = exec.send((seq, commands));
            }
            FleetNotice::LeaseRenewed { deadline, deadline_boot, valid_until_ms } => {
                self.lapse_guard.renewed();
                self.lease_deadline.send_replace(Some((deadline, deadline_boot)));
                self.proxy.apply(ProxyOp::Lease { valid_until_ms });
                self.runner.lease(valid_until_ms);
            }
            FleetNotice::Revoked(claims) => {
                for c in claims {
                    let current = self.summary.lock().expect("summary").get(&c.sandbox).map(|s| s.epoch);
                    if current == Some(c.epoch) {
                        self.fence_sandbox(&c.sandbox, c.epoch, "lease revoked by control plane", true).await;
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
                    let fresh = self.denied_seen.fresh((r.sandbox.clone(), r.host.clone(), r.port));
                    if fresh && self.limiter.allow(&r.sandbox, "denied", limits::DENIED) {
                        self.sandbox_event(&r.sandbox, r.agent.clone(), SandboxEventKind::EgressDenied { host: r.host.clone(), port: r.port });
                    }
                }
                // Per-sandbox budget for audit records (each batch becomes an R2 write).
                let records: Vec<_> = records.into_iter().filter(|r| self.limiter.allow(&r.sandbox, "audit", limits::AUDIT_RECORDS)).collect();
                if !records.is_empty() {
                    self.emit(HostEventBody::EgressAudit { records });
                }
            }
            ProxyNotice::Event(ProxyEvent::Alert { sandbox, agent, kind, host, binding, .. }) => {
                let reason = nest_protocol::model::EgressAlertReason::from(kind);
                let host: String = host.chars().take(253).collect();
                let fresh = self.alerts_seen.fresh((sandbox.clone(), format!("{reason:?}"), host.clone()));
                if fresh && self.limiter.allow(&sandbox, "alert", limits::ALERTS) {
                    self.sandbox_event(&sandbox, agent, SandboxEventKind::EgressAlert { host, binding, reason });
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
            RunnerNotice::Event(RunnerEvent::AgentExited { agent, code, signal, reason, epoch }) => {
                // The guest slot stays: it belongs to the attachment (SandboxDO's `agent_detach`
                // ends it), not to the brain process, so a restarted brain finds its tasks.
                self.emit(HostEventBody::AgentExited { agent, exit_code: code, signal, reason: reason.into(), epoch });
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
                        if this.limiter.allow(&sbx, "ports", limits::PORTS) {
                            this.sandbox_event(&sbx, None, SandboxEventKind::PortOpened { port });
                        }
                    }
                });
            }
            GuestEvent::Cli { agent_id, command, reply } => self.relay_cli(sbx, agent_id, command, reply),
            GuestEvent::TaskExited { agent_id, task } => {
                if !self.limiter.allow(&sbx, "tasks", limits::TASKS) {
                    return;
                }
                let Some((_, epoch)) = self.summary_of(&sbx) else { return };
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
        if let Some(refusal) = cli_agent_refusal(agent.as_ref()) {
            let _ = reply.send(refusal);
            return;
        }
        let Some((_, epoch)) = self.summary_of(&sbx) else {
            let _ = reply.send(CliResult::Error { error: error(error_codes::UNKNOWN_SANDBOX, format!("{sbx} is not on this host"), false) });
            return;
        };
        let wait = match &command {
            CliCommand::Ask { wait_s, .. } => Duration::from_secs(u64::from((*wait_s).min(120)) + CLI_RELAY_SLACK_S),
            _ => Duration::from_secs(CLI_RELAY_TIMEOUT_S),
        };
        let name = cli_name(&command);
        // Bounded per sandbox: rate and concurrency (an `ask` can be outstanding for minutes).
        let admitted = self.limiter.allow(&sbx, "cli", limits::CLI) && {
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
                    let remaining = (d.saturating_duration_since(Instant::now()), db.saturating_sub(crate::util::boottime()));
                    match nestd_core::lease::check(remaining.0.as_millis() as u64, remaining.1.as_millis() as u64) {
                        nestd_core::lease::LeaseCheck::Expired => {
                            self.self_fence().await;
                            // Stay fenced until the next renewal.
                            if rx.changed().await.is_err() {
                                return;
                            }
                        }
                        nestd_core::lease::LeaseCheck::Valid { recheck_ms } => tokio::select! {
                            changed = rx.changed() => { if changed.is_err() { return; } }
                            _ = tokio::time::sleep(Duration::from_millis(recheck_ms)) => {}
                        },
                    }
                }
            }
        }
    }

    /// Lease lapsed: kill every brain (one runner fence), then fence every sandbox.
    async fn self_fence(self: &Arc<Self>) {
        let ids: Vec<(SandboxId, Epoch)> = self.summary.lock().expect("summary").iter().filter(|(_, s)| holds_lease(s.state)).map(|(id, s)| (id.clone(), s.epoch)).collect();
        tracing::error!(sandboxes = ids.len(), "lease expired: self-fencing");
        // Every start held now (queued, or arriving before the next renewal) is refused (A3).
        self.lapse_guard.lapsed();
        let unsent = self.runner.fence(vec![], "host lease expired");
        self.brains_exited(unsent.into_iter().map(|(a, e)| (a, e, ExitReason::Fenced)));
        for (id, epoch) in ids {
            self.fence_sandbox(&id, epoch, "host lease expired", true).await;
        }
    }

    /// Fence whatever incarnation of `id` this host has now (a `fence` command names no epoch).
    async fn fence_current(self: &Arc<Self>, id: &SandboxId, reason: &str) {
        let epoch = self.summary.lock().expect("summary").get(id).map(|s| s.epoch);
        if let Some(epoch) = epoch {
            self.fence_sandbox(id, epoch, reason, true).await;
        }
    }

    /// Fence `id@epoch`; a no-op when this host's row for `id` is another epoch (an older
    /// incarnation's late rejection never fences a newer one). Immediately and without the sandbox
    /// lock: mark it `Fenced` (terminal for the epoch), drop its egress (the proxy link never blocks), and freeze its vCPUs
    /// through the lock-free pauser. Then, under the lock: close the guest connection, stop the
    /// VM, drop the netns, and retire it (salvage, then delete) when `salvage` is set.
    async fn fence_sandbox(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, reason: &str, salvage: bool) {
        {
            let mut summary = self.summary.lock().expect("summary");
            let Some(s) = summary.get_mut(id) else { return };
            if s.epoch != epoch || s.state == SandboxState::Fenced {
                return;
            }
            s.state = SandboxState::Fenced;
        }
        if let Some(pauser) = self.pausers.get(id, epoch) {
            tokio::spawn(async move {
                if let Err(e) = pauser.pause().await {
                    tracing::warn!(error = %e, "fence: lock-free pause failed (retried under the sandbox lock)");
                }
            });
        }
        // Tombstone first: from here on neither link accepts anything for this epoch.
        self.tombstones.fence(id, epoch);
        self.proxy.apply(ProxyOp::Drop { sandbox: id.clone(), epoch, reason: DropReason::Fence });
        self.gateway.forget(id);
        self.emit(HostEventBody::SandboxState { sandbox: id.clone(), epoch, state: SandboxState::Fenced, suspend_mode: None, detail: Some(reason.into()), guest: None });
        tracing::warn!(sandbox = %id, epoch = epoch.0, reason, "fenced");

        let Some(entry) = self.sandbox(id) else { return };
        let this = self.clone();
        tokio::spawn(async move {
            let mut s = entry.lock().await;
            if s.epoch != epoch {
                return; // a newer incarnation took the entry meanwhile (S7)
            }
            // `Fenced` is terminal: this VM never runs again. Stop it now so its memory goes back
            // to the host; salvage needs only the disk.
            this.stop_vm(&mut s).await;
            s.netns = None; // drops (and unmounts) the namespace
            drop(s);
            if salvage {
                this.retire(entry);
            }
        });
    }

    /// An incarnation that never runs again (fenced, superseded here, or left by a previous nestd):
    /// salvage its uncommitted work as a sibling branch, if [`Sbx::may_hold_work`]. A transient
    /// failure (timeout, store error, `parent_mismatch`, anything retryable) keeps the disk and is
    /// retried with backoff; a final refusal (`stale_epoch`, `invalid_message`) is logged and ends
    /// it, like a landed salvage. Then its directories go, its `fenced` row (while this epoch's) is
    /// marked clean and `incarnation_retired` reported, so FleetDO need not wait out the salvage
    /// window. A destroy that removed the directory meanwhile ends it silently. Once per
    /// incarnation; the lock is held only while chunking.
    fn retire(self: &Arc<Self>, entry: Arc<tokio::sync::Mutex<Sbx>>) {
        let this = self.clone();
        // Boxed: retiring commits, a commit's rejection fences, a fence retires.
        spawn_boxed(async move { this.retire_now(entry).await });
    }

    async fn retire_now(self: Arc<Self>, entry: Arc<tokio::sync::Mutex<Sbx>>) {
        // A queued cut goes first (the salvage reads the disk itself, newer than any cut); then the
        // retire waits for any commit in flight.
        let (id, epoch) = {
            let mut s = entry.lock().await;
            drop_pending_cut(&mut s, "the incarnation is retired: its salvage reads the disk");
            (s.id.clone(), s.epoch)
        };
        // Its own handle on the lock: released across each backoff below, so a command waiting on
        // it (one that began before the fence) gets it, finds the fence and returns.
        let lock = self.commit_lock(&id, epoch);
        let mut commit = Some(lock.clone().lock_owned().await);
        let mut s = entry.clone().lock_owned().await;
        if s.retiring {
            return;
        }
        s.retiring = true;
        let (id, epoch) = (s.id.clone(), s.epoch);
        let mut backoff = incarnation::RETIRE_RETRY_FIRST;
        let salvage = s.may_hold_work();
        while salvage && s.state_dir.exists() {
            let stable = s.vm.is_none() || s.paused;
            let (s2, r) = self.commit(s, CommitReason::Salvage, None, stable, self.cfg.commit_timeout()).await;
            s = s2;
            match r {
                Ok(Some(g)) => {
                    tracing::info!(sandbox = %id, epoch = epoch.0, generation = %g.id, "salvaged");
                    break;
                }
                Ok(None) => break, // nothing written since the head, or the disk is gone
                Err(e) if !salvage_retryable(&e) => {
                    tracing::error!(sandbox = %id, epoch = epoch.0, code = %e.code, message = %e.message, "salvage refused for good: this incarnation's uncommitted work is dropped");
                    break;
                }
                Err(e) => {
                    tracing::warn!(sandbox = %id, epoch = epoch.0, code = %e.code, message = %e.message, retry_in = ?backoff, "salvage failed: the disk is kept and the salvage retried");
                    drop(s);
                    drop(commit.take());
                    tokio::time::sleep(backoff).await;
                    backoff = incarnation::retire_backoff(backoff);
                    commit = Some(lock.clone().lock_owned().await);
                    s = entry.clone().lock_owned().await;
                }
            }
        }
        let destroyed = !s.state_dir.exists();
        recovery::remove_incarnation(&s.state_dir);
        recovery::remove_incarnation(&s.vm_dir);
        drop(s);
        drop(commit);
        self.commit_locks.lock().expect("commit locks").remove(&(id.clone(), epoch));
        if destroyed {
            return; // a destroy took it: nothing left to report
        }
        self.with_row(&id, epoch, |x| {
            if x.state == SandboxState::Fenced {
                x.dirty = false;
            }
        });
        self.emit(HostEventBody::IncarnationRetired { sandbox: id, epoch });
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
        // Taken first, so a start answered from the cache or refused leaves no stamp behind.
        let outlived = self.lapse_guard.outlived(&cmd.cmd.0);
        let cached = self.results.lock().expect("results").get(&cmd.cmd.0).cloned();
        if let Some(outcome) = cached {
            self.emit(HostEventBody::CommandResult { cmd: cmd.cmd, outcome });
            return;
        }
        let kind = command_kind(&cmd.body);
        let refusal = host_kind_refusal(self.cfg.role, &cmd.body);
        let result = match (cmd.body, refusal) {
            (_, Some(why)) => Err(error(error_codes::FORBIDDEN, why, false)),
            (CommandBody::AgentStart(start), None) if outlived => {
                self.refuse_start(&start, "the host lease lapsed since this start arrived")
            }
            (body, None) => self.dispatch(body).await,
        };
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
            CommandBody::SandboxSuspend { sandbox, epoch, mode } => self.suspend(&sandbox, epoch, mode, self.cfg.commit_timeout()).await,
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
            CommandBody::AgentAttach { sandbox, epoch, agent, cwd, env } => self.agent_attach(&sandbox, epoch, &agent, cwd, env).await,
            CommandBody::AgentDetach { sandbox, epoch, agent, kill_processes } => self.agent_detach(&sandbox, epoch, &agent, kill_processes).await,
            // A kill was applied on arrival; a graceful stop (or one from the previous release) goes in order.
            CommandBody::AgentStop { mode: Some(StopMode::Kill), .. } => Ok(None),
            CommandBody::AgentStop { agent, reason, epoch, .. } => {
                // A start never sent to the runner ends here, and its exit is reported now.
                let unsent = self.runner.agent_stop(&agent, StopMode::Graceful, &reason, epoch);
                self.brains_exited(unsent.into_iter().map(|e| (agent.clone(), e, ExitReason::Stopped)));
                Ok(None)
            }
            // Already applied on arrival (`on_fleet_notice`); this is the in-order no-op.
            CommandBody::Fence { sandboxes, reason } => {
                for s in sandboxes {
                    self.fence_current(&s, &reason).await;
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
        workstream: Option<WorkstreamId>,
        epoch: Epoch,
        image: String,
        resources: Resources,
        policy: EgressPolicy,
        from: Option<GenerationRecord>,
        fork: Option<ForkIdentity>,
    ) -> CmdResult {
        // A tombstoned epoch was fenced here: final, whatever the summary still holds.
        if self.tombstones.refuses(&sandbox, epoch) {
            return Err(error(error_codes::STALE_EPOCH, format!("{sandbox}@{} was fenced here", epoch.0), false));
        }
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
            // An older local incarnation. Its lease has moved on: fence it, and retire it in the
            // background (salvage, then delete). It has its own directory, so this one never waits.
            self.fence_sandbox(&sandbox, s.epoch, "superseded by a newer epoch", false).await;
            if let Some(old) = self.teardown(&sandbox, DropReason::Moved).await {
                self.retire(old);
            }
        }
        let vm_dir = self.cfg.vm_dir(&sandbox.0, epoch.0);
        let state_dir = self.cfg.sandbox_state_dir(&sandbox.0, epoch.0);
        std::fs::create_dir_all(&state_dir).map_err(internal)?;
        let restoring = from.is_some();
        let initial = if restoring { SandboxState::Restoring } else { SandboxState::Creating };
        self.summary.lock().expect("summary").insert(
            sandbox.clone(),
            Summary { workstream: workstream.clone(), epoch, state: initial, head: from.as_ref().map(|g| g.id.clone()), dirty: false, resources, guest: None },
        );
        self.emit(HostEventBody::SandboxState { sandbox: sandbox.clone(), epoch, state: initial, suspend_mode: None, detail: None, guest: None });

        let sbx = Sbx::new(sandbox.clone(), workstream.clone(), epoch, image.clone(), resources, Some(policy.clone()), from.clone(), vm_dir.clone(), state_dir.clone());
        // Boot while holding the sandbox's own lock: guest events and fencing wait for it.
        let entry = Arc::new(tokio::sync::Mutex::new(sbx));
        let mut guard = entry.clone().lock_owned().await;
        self.sandboxes.lock().expect("sandboxes").insert(sandbox.clone(), entry);
        let r = self.boot(&mut guard, from.as_ref(), fork).await;
        if r.is_ok() {
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
                self.with_row(&sandbox, epoch, |s| s.dirty = true);
                self.transition(&sandbox, epoch, SandboxState::Running, None, detail.clone())?;
                // A newer epoch runs here: the summary's epoch refuses older ones from now on, so
                // their tombstone goes (never this epoch's, should a fence land right now).
                self.tombstones.prune_below(&sandbox, epoch);
                Ok(detail.map(|d| serde_json::json!({ "note": d })))
            }
            Err(e) => {
                self.set_state(&sandbox, epoch, SandboxState::Failed, None, Some(e.to_string()));
                self.teardown(&sandbox, DropReason::Teardown).await;
                self.forget_commit_locks(&sandbox, epoch);
                // It never ran for an agent: nothing to keep, and a retry at this epoch starts clean.
                recovery::remove_incarnation(&state_dir);
                recovery::remove_incarnation(&vm_dir);
                Err(error(error_codes::INTERNAL, format!("create {sandbox}: {e:#}"), true))
            }
        }
    }

    /// Disk, network, VM, guest control. Leaves `sbx` populated even on error (for teardown).
    /// Re-checks for a fence after every await and before every externally visible step.
    async fn boot(self: &Arc<Self>, sbx: &mut Sbx, from: Option<&GenerationRecord>, fork: Option<ForkIdentity>) -> anyhow::Result<()> {
        // Disk.
        let disk = sbx.disk_path();
        let store = self.store.clone();
        let disk_gib = sbx.resources.disk_gib as u64;
        let base_image = match &self.cfg.driver {
            Some(DriverConfig::Firecracker(fc)) => Some(fc.images_dir.join(format!("{}.ext4", sbx.image))),
            Some(DriverConfig::Process { .. }) | None => None,
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
            // Durable before meta.json says the disk is complete.
            std::fs::File::open(&disk)?.sync_all()?;
            Ok(())
        })
        .await??;
        // The disk is complete, and nothing has written to it yet (it is its head, or the base
        // image): a restart finds this incarnation and, while no VM has run, just deletes it.
        sbx.disk_clean = true;
        sbx.persist(None).context("write meta.json")?;

        // Network (pushes listeners to the proxy).
        self.unless_fenced(sbx, "network setup")?;
        self.setup_network(sbx).context("sandbox network")?;

        self.launch(sbx, fork).await
    }

    /// Start a VM on `s`'s disk and wait for its guest (`fork`: a fork's first boot). `clean =
    /// false` is persisted first, so a restart salvages. On any error the VM is stopped again: a
    /// stranded one would share the disk with the next boot.
    async fn launch(&self, s: &mut Sbx, fork: Option<ForkIdentity>) -> anyhow::Result<()> {
        s.vm = Some(self.driver.create(s.vm_spec()).await.context("create VM")?);
        let r = self.start_vm(s, fork).await;
        if r.is_err() {
            self.stop_vm(s).await;
        }
        r
    }

    async fn start_vm(&self, s: &mut Sbx, fork: Option<ForkIdentity>) -> anyhow::Result<()> {
        self.unless_fenced(s, "VM start")?;
        s.disk_clean = false;
        s.persist(None).context("write meta.json")?;
        s.runs += 1;
        let vm = s.vm.as_mut().expect("created");
        vm.start().await.context("start VM")?;
        self.register_pauser(&s.id, s.epoch, vm.as_ref());
        let uds = vm.vsock_uds_path();
        self.unless_fenced(s, "guest connection")?;
        let guest = GuestCtl::spawn(uds, s.id.clone(), s.epoch, hostname(&s.id), s.agent_slots(), self.guest_events.clone());
        if fork.is_some() {
            guest.expect_resume(fork);
        }
        s.guest = Some(guest.clone());
        guest.wait_ready(self.cfg.guest_ready_timeout()).await.context("guest agent")?;
        s.guest_info = guest.guest();
        Ok(())
    }

    /// Stop `s`'s VM, if any, with its guest connection and pause handle.
    async fn stop_vm(&self, s: &mut Sbx) {
        if let Some(g) = s.guest.take() {
            g.shutdown();
        }
        self.pausers.remove(&s.id, s.epoch);
        if let Some(mut vm) = s.vm.take() {
            let _ = vm.stop().await;
        }
        // A pause mark stays: the VM is gone, and the caller's `forget` (teardown, suspend,
        // fence) drops the mark with the entry; lifting it first would let binds at a stopped VM.
        s.paused = false;
    }

    /// Freeze `s`'s vCPUs with the sandbox still placed here (a commit's pause), telling the
    /// gateway first: until [`Self::resume_vm`], its binds get `busy` with a short hint instead of
    /// a vsock connect that hangs. Connections already bound stall and continue with the VM. A
    /// failed pause lifts the mark again. No VM: nothing to pause.
    async fn pause_vm(&self, s: &mut Sbx, reason: String) -> std::io::Result<()> {
        let Some(vm) = s.vm.as_mut() else { return Ok(()) };
        self.gateway.set_paused(&s.id, s.epoch, Some(SandboxPause { reason }));
        let r = vm.pause().await;
        if r.is_err() {
            self.gateway.set_paused(&s.id, s.epoch, None);
        }
        r
    }

    /// Run `s`'s VM again after [`Self::pause_vm`]. The gateway admits binds again only once the
    /// VM runs: a VM that fails to resume stays marked paused, which it is.
    async fn resume_vm(&self, s: &mut Sbx) -> std::io::Result<()> {
        s.runs += 1;
        if let Some(vm) = s.vm.as_mut() {
            vm.resume().await?;
        }
        self.gateway.set_paused(&s.id, s.epoch, None);
        Ok(())
    }

    fn register_pauser(&self, id: &SandboxId, epoch: Epoch, vm: &dyn Vm) {
        if let Some(p) = vm.pauser() {
            self.pausers.insert(id, epoch, p);
        }
    }

    /// Create the netns, its standard listeners, and push policy + listeners to the proxy.
    fn setup_network(&self, sbx: &mut Sbx) -> anyhow::Result<()> {
        let policy = sbx.policy.clone().context("no egress policy (an incarnation found at start never runs)")?;
        let mut listeners = vec![];
        if let NetworkConfig::Netns { persist_dir } = &self.cfg.network {
            let persist = persist_dir.as_ref().map(|d| d.join(format!("ns-{}", sbx.id.0)));
            let ns = Arc::new(Netns::create(persist.as_deref()).context("create netns")?);
            // A jailed Firecracker runs as the jail's user, which must be able to attach to the tap.
            let tap_owner = match &self.cfg.driver {
                Some(DriverConfig::Firecracker(fc)) if fc.jailer_bin.is_some() => fc.jailer.as_ref().map(|j| (j.uid, j.gid)),
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
            for (i, rule) in policy.tcp.iter().enumerate() {
                let key = format!("{}:{}", rule.host, rule.port);
                let port = TCP_EXCEPTION_BASE_PORT + i as u16;
                let l = bind_listener(&ns, &mut sbx.next_listener, Transport::Tcp, port, ListenerPurpose::TcpException { rule: key.clone() })?;
                sbx.tcp_listeners.insert(key, (l.spec.id, port));
                listeners.push(l);
            }
            sbx.netns = Some(ns);
        }
        // The proxy link refuses all of these for an epoch already dropped by a fence.
        if !self.proxy.apply(ProxyOp::Upsert { sandbox: sbx.id.clone(), epoch: sbx.epoch, workstream: sbx.workstream.clone(), policy }) {
            anyhow::bail!("{} was fenced: proxy refused the sandbox", sbx.id);
        }
        self.proxy.apply(ProxyOp::Secrets { sandbox: sbx.id.clone(), epoch: sbx.epoch, secrets: vec![] });
        if !listeners.is_empty() {
            self.proxy.apply(ProxyOp::AddListeners { sandbox: sbx.id.clone(), epoch: sbx.epoch, listeners });
        }
        Ok(())
    }

    /// Stop the VM and drop network state; forget the sandbox locally. Its state directory stays:
    /// the caller retires or deletes it. Returns the incarnation's entry, if there was one.
    async fn teardown(self: &Arc<Self>, id: &SandboxId, reason: DropReason) -> Option<Arc<tokio::sync::Mutex<Sbx>>> {
        let epoch = self.summary.lock().expect("summary").get(id).map(|s| s.epoch);
        if let Some(epoch) = epoch {
            self.proxy.apply(ProxyOp::Drop { sandbox: id.clone(), epoch, reason });
        }
        // No tombstone here: a failed create is retried at the same epoch, and a destroy, archive
        // or move ends the sandbox's time here without fencing it. Only a fence tombstones.
        self.gateway.forget(id);
        if let Some(epoch) = epoch {
            self.pausers.remove(id, epoch);
        }
        self.latest_ports.lock().expect("ports").remove(id);
        self.cli_inflight.lock().expect("cli").remove(id);
        self.limiter.forget(id);
        let entry = self.sandboxes.lock().expect("sandboxes").remove(id);
        if let Some(entry) = &entry {
            let mut s = entry.lock().await;
            self.stop_vm(&mut s).await;
            s.netns = None;
            let _ = std::fs::remove_dir_all(&s.vm_dir);
        }
        self.summary.lock().expect("summary").remove(id);
        entry
    }

    /// Lock `id@epoch`'s incarnation, refusing a stale or fenced epoch before and after the wait.
    async fn lock_live(&self, id: &SandboxId, epoch: Epoch) -> Result<SbxGuard, ErrorBody> {
        self.check_epoch(id, epoch)?;
        let entry = self.sandbox(id).ok_or_else(|| error(error_codes::UNKNOWN_SANDBOX, format!("{id} is not on this host"), false))?;
        let s = entry.lock_owned().await;
        self.ensure_not_fenced(id, epoch)?;
        Ok(s)
    }

    /// Move `id@epoch` to `state`, or `stale_epoch` if it was fenced or superseded.
    fn transition(&self, id: &SandboxId, epoch: Epoch, state: SandboxState, suspend_mode: Option<SuspendMode>, detail: Option<String>) -> Result<(), ErrorBody> {
        if self.set_state(id, epoch, state, suspend_mode, detail) {
            return Ok(());
        }
        Err(error(error_codes::STALE_EPOCH, format!("{id}@{} was fenced", epoch.0), false))
    }

    /// Suspend `id@epoch`, waiting at most `commit_timeout` for its commit's answer.
    async fn suspend(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, mode: SuspendMode, commit_timeout: Duration) -> CmdResult {
        // A queued cut goes first (the suspend reads a newer disk); then the suspend waits for any
        // commit in flight, before the VM is paused. No new cut can queue meanwhile: commands run
        // one at a time.
        drop_pending_cut(&mut *self.lock_live(id, epoch).await?, "a suspend commits a newer read of the disk");
        let _commit = self.commit_turn(id, epoch).await?;
        let s = self.lock_live(id, epoch).await?;
        let state = self.summary.lock().expect("summary").get(id).map(|x| x.state);
        if state == Some(SandboxState::Suspended) {
            return Ok(Some(serde_json::json!({ "note": "already suspended" })));
        }
        self.transition(id, epoch, SandboxState::Suspending, Some(mode), None)?;
        let (mut s, r) = self.suspend_commit(s, mode, commit_timeout).await;
        if let Err(e) = r {
            self.roll_back_suspend(&mut s, &e).await;
            return Err(e);
        }
        self.ensure_not_fenced(id, epoch)?;
        let mut detail = None;
        if matches!(mode, SuspendMode::DiskOnly) {
            // Disk-only: release the VM; resume is a cold boot.
            self.stop_vm(&mut s).await;
        } else if !self.driver.supports_memory_snapshots() {
            detail = Some("driver keeps memory by pausing locally; generation is disk-only".to_string());
        }
        // Not reachable until resumed: clients re-resolve once instead of retrying `busy`.
        self.gateway.forget(id);
        self.transition(id, epoch, SandboxState::Suspended, Some(mode), detail.clone())?;
        Ok(detail.map(|d| serde_json::json!({ "note": d })))
    }

    /// Pause the VM, snapshot its memory (memory mode, where the driver can) and commit.
    async fn suspend_commit(self: &Arc<Self>, mut s: SbxGuard, mode: SuspendMode, commit_timeout: Duration) -> (SbxGuard, Result<(), ErrorBody>) {
        if let Some(g) = &s.guest {
            let _ = g.prepare_snapshot(matches!(mode, SuspendMode::Memory)).await;
        }
        if let Err(e) = self.pause_vm(&mut s, "suspend".into()).await {
            return (s, Err(internal(e)));
        }
        s.paused = true;
        let mut mem = None;
        if matches!(mode, SuspendMode::Memory) && self.driver.supports_memory_snapshots() {
            let dir = s.state_dir.join("snapshot");
            if let Some(vm) = s.vm.as_mut() {
                match vm.snapshot_memory(&dir).await {
                    Ok(m) => mem = m,
                    Err(e) => return (s, Err(internal(e))),
                }
            }
        }
        // Paused: nothing writes the disk.
        let (s, r) = self.commit(s, CommitReason::Suspend, mem, true, commit_timeout).await;
        (s, r.map(|_| ()))
    }

    /// A failed suspend goes back to `running` (SandboxDO's idle timer asks again) unless it was
    /// or will be fenced. A landed commit may have marked the disk clean: undone durably first.
    async fn roll_back_suspend(&self, s: &mut Sbx, why: &ErrorBody) {
        let (id, epoch) = (s.id.clone(), s.epoch);
        if self.fenced(&id, epoch) || rejection_fences(&why.code) {
            return;
        }
        s.disk_clean = false;
        if let Err(e) = s.persist(None) {
            tracing::error!(sandbox = %id, epoch = epoch.0, error = %e, "a failed suspend stays paused: meta.json can't record the VM running again");
            return;
        }
        if s.paused {
            if let Err(e) = self.resume_vm(s).await {
                tracing::error!(sandbox = %id, epoch = epoch.0, error = %e, "a failed suspend's VM can't be resumed");
                return;
            }
            s.paused = false;
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
        }
        self.set_state(&id, epoch, SandboxState::Running, None, Some(format!("suspend failed: {}", why.message)));
    }

    async fn resume(self: &Arc<Self>, id: &SandboxId, epoch: Epoch) -> CmdResult {
        let mut s = self.lock_live(id, epoch).await?;
        let state = self.summary.lock().expect("summary").get(id).map(|x| x.state);
        if state == Some(SandboxState::Running) {
            return Ok(Some(serde_json::json!({ "note": "already running" })));
        }
        if state != Some(SandboxState::Suspended) {
            return Err(error(error_codes::INVALID_MESSAGE, format!("{id} is {state:?}, not suspended"), false));
        }
        if s.vm.is_some() && s.paused {
            // Recorded before the VM runs again, or a restart would delete work as clean.
            s.disk_clean = false;
            s.persist(None).map_err(internal)?;
            self.ensure_not_fenced(id, epoch)?;
            s.runs += 1;
            s.vm.as_mut().expect("checked").resume().await.map_err(internal)?;
            s.paused = false;
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
        } else if let Err(e) = self.launch(&mut s, None).await {
            self.ensure_not_fenced(id, epoch)?;
            return Err(internal(format!("resume {id}: {e:#}")));
        }
        self.gateway_upsert(&s);
        let guest = s.guest_info.clone();
        self.with_row(id, epoch, |x| {
            x.dirty = true;
            x.guest = guest;
        });
        self.transition(id, epoch, SandboxState::Running, None, None)?;
        Ok(None)
    }

    /// Commit a running (or suspended) sandbox's disk. The VM is paused only while its disk is read:
    /// a lost answer is asked about again first, while it runs, and the held-back uploads and the
    /// control plane's answer come after it resumes. A checkpoint never marks the disk clean (a
    /// resumed VM writes it again), so resuming before the answer changes nothing a restart reads.
    async fn checkpoint(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, reason: CommitReason) -> CmdResult {
        if self.cut != CutMode::None {
            return match self.cut_checkpoint(id, epoch, reason, false).await? {
                CutOutcome::Committed(g) => Ok(g.map(|g| serde_json::json!({ "generation": g.id }))),
                CutOutcome::Queued { cut, .. } => Ok(Some(serde_json::json!({ "cut": cut }))),
            };
        }
        self.checkpoint_by_read(id, epoch, reason).await
    }

    /// A checkpoint without a cut (M1): the VM is paused while its disk is read.
    async fn checkpoint_by_read(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, reason: CommitReason) -> CmdResult {
        let _commit = self.commit_turn(id, epoch).await?;
        let s = self.lock_live(id, epoch).await?;
        let timeout = self.cfg.commit_timeout();
        let (mut s, answered) = match self.reask(s, reason, timeout).await {
            (s, Ok(a)) => (s, a),
            (_, Err(e)) => return Err(e),
        };
        let running = s.vm.is_some() && !s.paused;
        if let Some(g) = &s.guest {
            let _ = g.prepare_snapshot(false).await;
        }
        let paused_at = Instant::now();
        if running {
            self.pause_vm(&mut s, format!("checkpoint ({})", commit_reason_wire(reason))).await.map_err(internal)?;
        }
        // Paused, or no VM runs: nothing writes the disk while it is read.
        let r = self.scan(&mut s, reason, None, true).await;
        // Never resume a VM fenced meanwhile (the fence forgets the sandbox at the gateway, pause
        // and all). A rejection that fences comes after this, and fences the running VM through
        // its pause handle, as a fence of any running VM does.
        if running && !self.fenced(id, epoch) {
            if let Err(e) = self.resume_vm(&mut s).await {
                tracing::error!(sandbox = %id, epoch = epoch.0, error = %e, "a checkpoint's VM can't be resumed");
            }
            // A fence marks the row before its lock-free pause: one that landed between the check
            // above and this resume is undone by it, so freeze the VM again.
            if self.fenced(id, epoch)
                && let Some(vm) = s.vm.as_mut()
            {
                let _ = vm.pause().await;
            }
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
            self.with_row(id, epoch, |x| x.dirty = true);
        }
        if running {
            tracing::info!(sandbox = %id, epoch = epoch.0, reason = ?reason, paused_ms = paused_at.elapsed().as_millis() as u64, "checkpoint: VM resumed");
        }
        let g = match r? {
            Some(p) => self.publish_and_send(s, p, answered, timeout).await.1?,
            None => answered.and_then(|(_, g)| g),
        };
        Ok(g.map(|g| serde_json::json!({ "generation": g.id })))
    }

    /// This incarnation's commit lock ([`Inner::commit_locks`]).
    fn commit_lock(&self, id: &SandboxId, epoch: Epoch) -> CommitLock {
        self.commit_locks.lock().expect("commit locks").entry((id.clone(), epoch)).or_default().clone()
    }

    /// The command executor's way to `id@epoch`'s commit lock: a stale or fenced epoch is refused
    /// before the wait, so a fenced incarnation's salvage (which holds the lock through its retries)
    /// never holds up the host's one executor, and again after it, for a fence that landed during
    /// the wait. What waits is only a commit in flight of a live incarnation, or one salvage attempt
    /// (the retire releases the lock across its backoff).
    async fn commit_turn(&self, id: &SandboxId, epoch: Epoch) -> Result<tokio::sync::OwnedMutexGuard<()>, ErrorBody> {
        self.check_epoch(id, epoch)?;
        let guard = self.commit_lock(id, epoch).lock_owned().await;
        self.check_epoch(id, epoch)?;
        Ok(guard)
    }

    /// Forget the commit locks of `id`'s incarnations at or below `epoch` (destroyed, archived or
    /// never started): a holder keeps its own handle, and nothing asks for one of these again.
    fn forget_commit_locks(&self, id: &SandboxId, epoch: Epoch) {
        self.commit_locks.lock().expect("commit locks").retain(|(sid, e), _| !(sid == id && *e <= epoch));
    }

    /// A checkpoint that cuts the disk (M2, `docs/sandbox/state/disk/`). The guest flushes and the
    /// disk file is synced while the VM runs; the VM is paused only for the cut (a reflink clone,
    /// or, for a disk unchanged since the last pass, the M1 check); then it resumes and the cut is
    /// queued for a background commit, which replaces any cut still queued. The command returns
    /// once the cut is taken: the host's command queue never waits for a read, an upload or the
    /// control plane. `keep_local`: a same-host fork reads from this commit next.
    async fn cut_checkpoint(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, reason: CommitReason, keep_local: bool) -> Result<CutOutcome, ErrorBody> {
        let mut s = self.lock_live(id, epoch).await?;
        let disk = s.disk_path();
        if !disk.exists() {
            return Ok(CutOutcome::Committed(None));
        }
        let running = s.vm.is_some() && !s.paused;
        if let Some(g) = &s.guest {
            let _ = g.prepare_snapshot(false).await;
        }
        // While the VM runs: what the guest flushed reaches the disk, so the clone's own flush
        // (inside the pause) has little left to write.
        {
            let d = disk.clone();
            let _ = tokio::task::spawn_blocking(move || storage::sync_data(&d)).await;
        }
        // The guard against an unbounded pause (a disk fragmented, on purpose or not, until its
        // clone would outlast a read of it): counted while the VM runs.
        let counted = {
            let d = disk.clone();
            tokio::task::spawn_blocking(move || Some((storage::extent_count(&d).ok()?, std::os::unix::fs::MetadataExt::blocks(&std::fs::metadata(&d).ok()?) * 512)))
                .await
                .ok()
                .flatten()
        };
        let extents = counted.map(|c| c.0);
        // M3′: the shadow this cut writes, and its pre-copy while the VM runs (a shadow not made yet
        // is made here, a whole clone of the running disk, then compared like any other). A failed
        // pre-copy leaves the shadow to be cloned whole in the pause, as M2 cuts. The target is never
        // a shadow a queued or taken cut names (`Shadows`); when both are (one cut taken by its
        // commit, one queued), the queued cut is dropped first: this newer cut replaces it anyway.
        let shadow = if self.cut.shadow() {
            let slot = match s.shadows.target() {
                Some(t) => t,
                None => {
                    drop_pending_cut(&mut s, "both shadows are held: a newer cut replaces the queued one");
                    s.shadows.target().ok_or_else(|| error(error_codes::INTERNAL, "no shadow is free for a cut", true))?
                }
            };
            let path = shadow_path(&s.state_dir, slot);
            let (mode, d, p, make, min) = (self.cut, disk.clone(), path.clone(), !path.exists(), self.cfg.shadow_pre_copy_min_ranges);
            let pre = match tokio::task::spawn_blocking(move || pre_copy(mode, &d, &p, make, min)).await {
                Ok(Ok(pre)) => Some(pre),
                Ok(Err(e)) => {
                    tracing::warn!(sandbox = %id, epoch = epoch.0, error = %e, "checkpoint: the shadow's pre-copy failed: this cut clones the disk whole");
                    None
                }
                Err(e) => {
                    s.shadows.cut_failed(slot);
                    return Err(internal(e));
                }
            };
            Some((slot, path, pre))
        } else {
            None
        };
        // Only a whole clone can outlast a read: the shadow's in-pause step is a walk of the map.
        let whole = shadow.as_ref().is_none_or(|(_, _, pre)| pre.is_none());
        let read_instead = whole && match counted {
            Some((extents, allocated)) => {
                let slower = storage::clone_slower_than_read(extents, allocated, self.cfg.cut_clone_ns_per_extent, self.cfg.cut_read_bytes_per_s);
                if slower {
                    tracing::warn!(sandbox = %id, epoch = epoch.0, extents, allocated, "checkpoint: the disk's clone would outlast reading it: this cut reads it in the pause");
                }
                slower
            }
            None => false,
        };
        let paused_at = Instant::now();
        if running && let Err(e) = self.pause_vm(&mut s, format!("checkpoint ({})", commit_reason_wire(reason))).await {
            // The pre-copy may have written the shadow: it wasn't held, so no cut names it.
            if let Some((slot, _, _)) = &shadow {
                s.shadows.cut_failed(*slot);
            }
            return Err(internal(e));
        }
        // Paused, or no VM runs. A fork's pass reads every chunk (to keep them local): no reuse.
        let stable = self.driver.pause_quiesces_disk();
        let (reuse, pass) = s.scan_memo.begin(stable && !keep_local, disk_stamp(&disk).ok().as_ref());
        let cut_id = self.next_cut.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cut_path = s.state_dir.join(format!("cut-{cut_id}.img"));
        let (store, mode) = (self.store.clone(), self.cut);
        let (d, c) = (disk.clone(), cut_path.clone());
        let verify = self.cfg.disk_cut_verify;
        let shadow_for_cut = shadow.as_ref().map(|(slot, path, pre)| (*slot, path.clone(), pre.as_ref().map(|p| p.base.clone())));
        let cut = tokio::task::spawn_blocking(move || -> std::io::Result<(CutSource, Option<DiskStamp>, Option<ShadowCut>)> {
            // An unchanged disk isn't cut: its manifest is checked as M1 does (reading only the
            // chunks the 12 h rule doubts), inside this pause.
            let reread = match &reuse {
                Some(prev) => storage::rescan_unchanged(store.as_ref(), &d, prev, HOLD_BACK_BYTES)?,
                None => None,
            };
            let mut shadow_cut = None;
            let source = match reread {
                Some(read) => CutSource::Read(read),
                None if read_instead => CutSource::Read(storage::scan_file_keeping(store.as_ref(), &d, ManifestKind::Disk, HOLD_BACK_BYTES, keep_local)?),
                None => match shadow_for_cut {
                    Some((slot, path, base)) => {
                        shadow_cut = Some(cut_shadow(mode, &d, &path, base, verify)?);
                        CutSource::Shadow(slot, path)
                    }
                    None => {
                        match mode {
                            CutMode::LockedCopy => storage::locked_copy(&d, &c)?,
                            _ => storage::reflink(&d, &c)?,
                        }
                        CutSource::File(c)
                    }
                },
            };
            // Last, still paused: a write from here on moves the mtime off the sentinel.
            let stamp = if stable { set_sentinel(&d).ok() } else { None };
            Ok((source, stamp, shadow_cut))
        })
        .await
        .map_err(internal)
        .and_then(|r| r.map_err(internal));
        let cut_ms = now_ms();
        let runs_at_cut = s.runs;
        let resumed = running && !self.fenced(id, epoch);
        if resumed {
            if let Err(e) = self.resume_vm(&mut s).await {
                tracing::error!(sandbox = %id, epoch = epoch.0, error = %e, "a checkpoint's VM can't be resumed");
            }
            // A fence that landed between the check above and this resume is undone by it.
            if self.fenced(id, epoch)
                && let Some(vm) = s.vm.as_mut()
            {
                let _ = vm.pause().await;
            }
            if let Some(g) = &s.guest {
                let _ = g.thaw().await;
            }
            self.with_row(id, epoch, |x| x.dirty = true);
        }
        let paused_ms = paused_at.elapsed().as_millis() as u64;
        let (source, stamp, shadow_cut) = match cut {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&cut_path);
                if let Some((slot, _, _)) = &shadow {
                    s.shadows.cut_failed(*slot);
                }
                tracing::warn!(sandbox = %id, epoch = epoch.0, error = %e.message, "checkpoint: the cut failed");
                return Err(e);
            }
        };
        // The cut is queued from here: its shadow is held until its commit is done with it, and the
        // cut it replaces releases its own.
        drop_pending_cut(&mut s, "a newer cut replaces it");
        match (&source, &shadow) {
            (CutSource::Shadow(slot, _), _) => s.shadows.cut(*slot),
            // Read instead: the pre-copy may have written the shadow, which no cut names.
            (_, Some((slot, _, _))) => s.shadows.cut_failed(*slot),
            _ => {}
        }
        let reused = matches!(source, CutSource::Read(_));
        match (&shadow_cut, shadow.as_ref().and_then(|(_, _, pre)| pre.as_ref())) {
            // The record count and the pause per cut, for measuring real disks (docs/sandbox/state/disk/, M3′).
            (Some(c), pre) => tracing::info!(
                sandbox = %id, epoch = epoch.0, reason = ?reason, cut = cut_id, paused_ms, records = c.records, walk_ms = c.walk_ms,
                ranges = c.ranges, bytes = c.bytes, whole = c.whole, made = pre.map(|p| p.made), precopy_ranges = pre.map(|p| p.ranges), precopy_bytes = pre.map(|p| p.bytes),
                precopy_ms = pre.map(|p| p.ms), "checkpoint: disk cut into a shadow"
            ),
            (None, _) => tracing::info!(sandbox = %id, epoch = epoch.0, reason = ?reason, cut = cut_id, paused_ms, reused, extents, "checkpoint: disk cut"),
        }
        let (tx, rx) = oneshot::channel();
        s.pending_cut = Some(PendingCut { id: cut_id, source, pass, stable, stamp, cut_ms, runs_at_cut, reason, keep_local, done: Some(tx) });
        let entry = tokio::sync::OwnedMutexGuard::mutex(&s).clone();
        drop(s);
        let this = self.clone();
        let lock = self.commit_lock(id, epoch);
        spawn_boxed(async move { this.commit_cut(entry, lock, cut_id).await });
        Ok(CutOutcome::Queued { cut: cut_id, done: rx })
    }

    /// The background commit of cut `cut_id`, after any commit in flight: read the cut (outside the
    /// sandbox lock), then commit it as any commit is (asking again for a lost answer first). A cut
    /// replaced or dropped meanwhile, or an incarnation fenced meanwhile (its salvage reads the
    /// disk), commits nothing.
    async fn commit_cut(self: Arc<Self>, entry: Arc<tokio::sync::Mutex<Sbx>>, lock: CommitLock, cut_id: u64) {
        let _commit = lock.lock_owned().await;
        let mut s = entry.clone().lock_owned().await;
        if s.pending_cut.as_ref().is_none_or(|p| p.id != cut_id) {
            return;
        }
        let mut cut = s.pending_cut.take().expect("checked");
        let done = cut.done.take();
        let (id, epoch) = (s.id.clone(), s.epoch);
        // The shadow this cut names stays held (no cut writes it) until this commit is done with it,
        // on every path out: the re-ask below waits with the sandbox unlocked, and newer cuts run.
        let held = match &cut.source {
            CutSource::Shadow(slot, _) => Some(*slot),
            _ => None,
        };
        let finish = |s: &mut Sbx, cut: &PendingCut| {
            if let CutSource::File(f) = &cut.source {
                let _ = std::fs::remove_file(f);
            }
            if let Some(slot) = held {
                s.shadows.release(slot);
            }
        };
        if self.fenced(&id, epoch) {
            finish(&mut s, &cut);
            if let Some(d) = done {
                let _ = d.send(Err(error(error_codes::STALE_EPOCH, format!("{id}@{} was fenced", epoch.0), false)));
            }
            return;
        }
        let timeout = self.cfg.commit_timeout();
        let (s2, answered) = self.reask(s, cut.reason, timeout).await;
        s = s2;
        let answered = match answered {
            Ok(a) => a,
            Err(e) => {
                finish(&mut s, &cut);
                if let Some(d) = done {
                    let _ = d.send(Err(e));
                }
                return;
            }
        };
        // Read the cut with the sandbox unlocked: it is a frozen file no cut writes (it is held).
        drop(s);
        let started = Instant::now();
        let read = match &cut.source {
            CutSource::Read(_) => match std::mem::replace(&mut cut.source, CutSource::File(PathBuf::new())) {
                CutSource::Read(r) => Ok(r),
                _ => unreachable!(),
            },
            // The VM runs again: uploads go as the cut is read (nothing to hold back for).
            CutSource::Shadow(_, f) | CutSource::File(f) => {
                let (store, keep, f2) = (self.store.clone(), cut.keep_local, f.clone());
                tokio::task::spawn_blocking(move || storage::scan_file_keeping(store.as_ref(), &f2, ManifestKind::Disk, 0, keep)).await.map_err(internal).and_then(|r| r.map_err(internal))
            }
        };
        let mut s = entry.lock_owned().await;
        finish(&mut s, &cut);
        let read = match read {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(sandbox = %id, epoch = epoch.0, cut = cut_id, error = %e.message, "checkpoint: reading the cut failed");
                if let Some(d) = done {
                    let _ = d.send(Err(e));
                }
                return;
            }
        };
        let st = read.stats;
        tracing::info!(
            sandbox = %id, epoch = epoch.0, reason = ?cut.reason, cut = cut_id, scan_ms = started.elapsed().as_millis() as u64, reused = st.reused,
            chunks_read = st.chunks_read, bytes_read = st.bytes_read, chunks_put = st.chunks_put, "commit: cut read"
        );
        // The disk had this content when its stamp was read, in the cut's pause.
        s.scan_memo.scanned(cut.pass, cut.stable, cut.stamp, read.manifest.clone());
        let p = Prepared { disk: read, mem: None, reason: cut.reason, runs_at_read: cut.runs_at_cut, cut_ms: Some(cut.cut_ms) };
        let (_s, r) = self.publish_and_send(s, p, answered, timeout).await;
        if let Err(e) = &r {
            tracing::warn!(sandbox = %id, epoch = epoch.0, cut = cut_id, code = %e.code, message = %e.message, "checkpoint: the cut's commit failed");
        }
        if let Some(d) = done {
            let _ = d.send(r);
        }
    }

    async fn archive(self: &Arc<Self>, id: &SandboxId, epoch: Epoch) -> CmdResult {
        {
            drop_pending_cut(&mut *self.lock_live(id, epoch).await?, "an archive commits a newer read of the disk");
            let _commit = self.commit_turn(id, epoch).await?;
            let mut s = self.lock_live(id, epoch).await?;
            self.transition(id, epoch, SandboxState::Archiving, None, None)?;
            if s.may_hold_work() || s.head.is_none() {
                // Stable only if the pause landed (a failed one is ignored, as before).
                let stable = self.pause_vm(&mut s, "archive".into()).await.is_ok() || s.paused;
                let (s2, r) = self.commit(s, CommitReason::Archive, None, stable, self.cfg.commit_timeout()).await;
                s = s2;
                r?;
            }
            self.ensure_not_fenced(id, epoch)?;
            recovery::remove_incarnation(&s.state_dir);
        }
        self.transition(id, epoch, SandboxState::Archived, None, None)?;
        self.teardown(id, DropReason::Teardown).await;
        self.forget_commit_locks(id, epoch);
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
        let exists = self.summary.lock().expect("summary").contains_key(id);
        if exists {
            self.set_state(id, epoch, SandboxState::Destroyed, None, None);
        }
        self.teardown(id, DropReason::Teardown).await;
        // Every incarnation of it here at or below this epoch, a retiring one included (its
        // salvage stops once its directory is gone).
        recovery::remove_up_to(&self.cfg.sandboxes_dir(), id, epoch);
        recovery::remove_up_to(&self.cfg.vms_dir(), id, epoch);
        // Nothing of the sandbox is left here at or below this epoch: neither is its tombstone, nor
        // a commit lock (a retire still running holds its own).
        self.tombstones.prune_up_to(id, epoch);
        self.forget_commit_locks(id, epoch);
        Ok(None)
    }

    #[allow(clippy::too_many_arguments)]
    async fn fork(
        self: &Arc<Self>,
        parent: &SandboxId,
        parent_epoch: Epoch,
        child: SandboxId,
        child_epoch: Epoch,
        child_workstream: Option<WorkstreamId>,
        mode: ForkMode,
        policy: EgressPolicy,
    ) -> CmdResult {
        let (image, resources) = {
            let s = self.lock_live(parent, parent_epoch).await?;
            (s.image.clone(), s.resources)
        };
        // The child restores from the parent's commit on this host: its chunks are kept local.
        let committed: Option<GenerationId> = if self.cut != CutMode::None {
            match self.cut_checkpoint(parent, parent_epoch, CommitReason::Fork, true).await? {
                CutOutcome::Committed(g) => g.map(|g| g.id),
                CutOutcome::Queued { done, .. } => done.await.map_err(|_| error(error_codes::INTERNAL, "fork: the parent's cut was dropped", true))??.map(|g| g.id),
            }
        } else {
            self.checkpoint_by_read(parent, parent_epoch, CommitReason::Fork)
                .await?
                .and_then(|v| v.get("generation").cloned())
                .map(serde_json::from_value::<GenerationId>)
                .transpose()
                .map_err(internal)?
        };
        let gen_id = committed.ok_or_else(|| error(error_codes::INTERNAL, "fork: parent commit produced no generation", true))?;
        let record = self.lock_live(parent, parent_epoch).await?.head.clone().filter(|h| h.id == gen_id).ok_or_else(|| error(error_codes::INTERNAL, "fork: head moved", true))?;
        let fork = ForkIdentity { new_sandbox_id: child.clone(), hostname: hostname(&child), machine_id: crate::guest::new_machine_id() };
        let mut r = self.create_sandbox(child, child_workstream, child_epoch, image, resources, policy, Some(record), Some(fork)).await?;
        if matches!(mode, ForkMode::Live) {
            r = Some(serde_json::json!({ "note": "live fork not implemented; child cold-booted from the parent's disk generation" }));
        }
        Ok(r)
    }

    async fn policy_update(self: &Arc<Self>, id: &SandboxId, epoch: Epoch, policy: EgressPolicy) -> CmdResult {
        let mut s = self.lock_live(id, epoch).await?;
        if s.policy.as_ref().is_some_and(|p| policy.version <= p.version) {
            return Ok(Some(serde_json::json!({ "note": "stale policy version ignored" })));
        }
        s.policy = Some(policy.clone());
        self.proxy.apply(ProxyOp::Upsert { sandbox: id.clone(), epoch, workstream: s.workstream.clone(), policy: policy.clone() });
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

    /// Refuse a start that must never run: its `agent_exited{fenced}` at its epoch is reported now,
    /// or once no older start of the agent is out here (an exit at an epoch means nothing at or
    /// below it runs here).
    fn refuse_start(&self, start: &nest_protocol::control::AgentStart, why: &str) -> CmdResult {
        let (agent, epoch) = (start.agent.clone(), start.agent_epoch());
        if self.runner.refused(&agent, epoch) {
            self.emit(HostEventBody::AgentExited { agent, exit_code: None, signal: None, reason: nest_protocol::control::AgentExitReason::Fenced, epoch: Some(epoch) });
        }
        Err(error(error_codes::STALE_EPOCH, why, false))
    }

    /// Start a brain. Hands are the runner's business (it resolves a binding through AgentDO):
    /// nestd only remembers which sandbox the brain is bound to, for fencing.
    async fn agent_start(self: &Arc<Self>, start: nest_protocol::control::AgentStart) -> CmdResult {
        let agent = start.agent.clone();
        // A kill for this epoch (or a later one) overtook it: it never runs, and its exit says so.
        let epoch = start.agent_epoch();
        if self.runner.killed_at_or_above(&agent, epoch) {
            return self.refuse_start(&start, "a kill for this agent epoch arrived first");
        }
        let config_dir = self.cfg.agents_dir().join(&agent.0);
        std::fs::create_dir_all(&config_dir).map_err(internal)?;
        let dispatched = self.runner.agent_start(RunnerAgentStart { start, config_dir: config_dir.display().to_string() });
        Ok(Some(serde_json::json!({ "dispatched": dispatched })))
    }

    /// The sandbox side of `attach`: a slot (explicit proxy listener + guest `agent_attach`) for
    /// the agent, then the gateway learns the client. Idempotent: an existing slot keeps its port.
    async fn agent_attach(self: &Arc<Self>, sandbox: &SandboxId, epoch: Epoch, agent: &AgentId, cwd: Option<String>, env: BTreeMap<String, String>) -> CmdResult {
        let mut s = self.lock_live(sandbox, epoch).await?;
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
        s.slot_envs.insert(agent.clone(), env.clone());
        self.gateway_sync(&s);
        // The guest round trip (up to 30 s) runs without the sandbox lock, so a fence, suspend or
        // checkpoint is never queued behind it.
        let entry = tokio::sync::OwnedMutexGuard::mutex(&s).clone();
        drop(s);
        let attached = guest.attach(slot_for(agent, slot, cwd, env)).await;
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
        s.slot_envs.remove(agent);
        if let Some(g) = &s.guest {
            g.forget_slot(agent);
        }
        self.gateway_sync(&s);
    }

    /// Remove an agent's slot (an unknown agent is `ok`); with `kill_processes`, its whole cgroup
    /// goes first. The gateway refuses the agent's bindings from here on. `ok` only once the guest
    /// confirmed the detach: until then the guest connection owes it (`GuestCtl::detach`), and a
    /// second `agent_detach` sends it again, though the slot here is already gone.
    async fn agent_detach(self: &Arc<Self>, sandbox: &SandboxId, epoch: Epoch, agent: &AgentId, kill_processes: bool) -> CmdResult {
        let mut s = self.lock_live(sandbox, epoch).await?;
        let Some((_, listener)) = s.slots.remove(agent) else {
            let Some(g) = s.guest.clone() else { return Ok(Some(serde_json::json!({ "note": "not attached" }))) };
            if g.owes_detach(agent) {
                // An earlier detach never reached the guest: send it again.
                drop(s);
                g.detach(agent, kill_processes).await.map_err(|e| error(error_codes::INTERNAL, format!("guest agent_detach: {e}"), true))?;
                return Ok(None);
            }
            // Not ours, and not the guest connection's either (no stale slot is re-configured).
            g.forget_slot(agent);
            return Ok(Some(serde_json::json!({ "note": "not attached" })));
        };
        s.slot_cwds.remove(agent);
        s.slot_envs.remove(agent);
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
            // Bounds each commit's wait; never a cancellation, which would lose the unanswered record.
            let budget = Duration::from_millis((deadline_ms - now_ms()).max(0) as u64);
            if budget.is_zero() || self.suspend(&id, epoch, SuspendMode::DiskOnly, budget.min(self.cfg.commit_timeout())).await.is_err() {
                failed.push(id.0);
            }
        }
        if failed.is_empty() { Ok(None) } else { Err(error(error_codes::INTERNAL, format!("not drained: {}", failed.join(", ")), true)) }
    }

    /// Chunk disk (+ memory) into the store and compare-and-set the head through the control
    /// plane. `Ok(None)`: nothing to commit. A `stale_epoch` rejection fences the sandbox.
    /// `stable`: no VM can write the disk until this returns (it is paused or stopped).
    ///
    /// The sandbox lock (`s`) is held while chunking (the disk must be stable) but **released
    /// while waiting for `commit_result`**, then re-taken and returned with the result: a slow or
    /// partitioned control plane never blocks fencing, guest events or other commands on this
    /// sandbox. A checkpoint runs the same steps with the VM resumed after the read.
    async fn commit(self: &Arc<Self>, s: SbxGuard, reason: CommitReason, mem: Option<PathBuf>, stable: bool, timeout: Duration) -> (SbxGuard, Result<Option<GenerationRecord>, ErrorBody>) {
        let (mut s, answered) = match self.reask(s, reason, timeout).await {
            (s, Ok(a)) => (s, a),
            (s, Err(e)) => return (s, Err(e)),
        };
        match self.scan(&mut s, reason, mem, stable).await {
            Ok(Some(p)) => self.publish_and_send(s, p, answered, timeout).await,
            Ok(None) => (s, Ok(answered.and_then(|(_, g)| g))),
            Err(e) => (s, Err(e)),
        }
    }

    /// An earlier commit's answer was lost (timed out), but SandboxDO may have moved its head: ask
    /// again under the same request id (idempotent per id) and adopt the outcome, rather than send
    /// a new request with a stale parent that is rejected and fences the sandbox. `Ok(Some)`: the
    /// request asked again and its outcome; `Ok(None)`: nothing to ask, or a refusal that leaves
    /// this commit to go on (a salvage after another kind of request).
    async fn reask(self: &Arc<Self>, s: SbxGuard, reason: CommitReason, timeout: Duration) -> (SbxGuard, Result<Option<(SentCommit, Option<GenerationRecord>)>, ErrorBody>) {
        let Some(prev) = s.unanswered.clone() else { return (s, Ok(None)) };
        // Never marks the disk clean: what it was read from is unknown here.
        let (s, r) = self.send_commit(s, prev.clone(), timeout, None).await;
        match r {
            Ok(g) => (s, Ok(Some((prev, g)))),
            Err(e) if incarnation::reask_failure_ends_commit(reason == CommitReason::Salvage, prev.reason == CommitReason::Salvage, !e.retryable) => (s, Err(e)),
            // Another kind of request was refused: this incarnation's salvage still runs.
            Err(_) => (s, Ok(None)),
        }
    }

    /// Read the disk (+ memory) into manifests while nothing writes it, holding back up to
    /// [`HOLD_BACK_BYTES`] of chunks the store isn't known to have for [`Inner::publish_and_send`]
    /// (after a checkpoint's VM resumes). A disk known unchanged since the last stable pass
    /// (`nestd_core::checkpoint`) isn't read but for the chunks the 12 h rule needs. `Ok(None)`: no
    /// disk, or a salvage of a disk that equals its head.
    async fn scan(self: &Arc<Self>, s: &mut Sbx, reason: CommitReason, mem: Option<PathBuf>, stable: bool) -> Result<Option<Prepared>, ErrorBody> {
        let disk = s.disk_path();
        if !disk.exists() {
            return Ok(None);
        }
        // The memo is trusted only where a pause or stop really stops every write to the file.
        let stable = stable && self.driver.pause_quiesces_disk();
        // A fork's child restores from this commit here: every chunk is read and kept local.
        let keep_local = reason == CommitReason::Fork;
        // Begun, the memo is forgotten: a pass that fails anywhere below (the sentinel set over
        // content it doesn't describe included) leaves nothing a later commit could reuse.
        let (reuse, pass) = s.scan_memo.begin(stable && !keep_local, disk_stamp(&disk).ok().as_ref());
        let runs = s.runs;
        let store = self.store.clone();
        let started = Instant::now();
        let (disk_scan, mem_scan, stamp) = tokio::task::spawn_blocking(move || -> std::io::Result<_> {
            let reused = match &reuse {
                Some(prev) => storage::rescan_unchanged(store.as_ref(), &disk, prev, HOLD_BACK_BYTES)?,
                None => None,
            };
            let d = match reused {
                Some(d) => d,
                None => storage::scan_file_keeping(store.as_ref(), &disk, ManifestKind::Disk, HOLD_BACK_BYTES, keep_local)?,
            };
            // A memory snapshot is taken only with the VM paused for a suspend: uploaded now.
            let m = match mem {
                Some(p) => Some(storage::scan_file(store.as_ref(), &p, ManifestKind::Memory, 0)?),
                None => None,
            };
            // Last, once every read succeeded, while still stable: a write from here on moves
            // the mtime off the sentinel.
            let stamp = if stable { set_sentinel(&disk).ok() } else { None };
            Ok((d, m, stamp))
        })
        .await
        .map_err(internal)?
        .map_err(internal)?;
        s.scan_memo.scanned(pass, stable, stamp, disk_scan.manifest.clone());
        let st = disk_scan.stats;
        tracing::info!(
            sandbox = %s.id, epoch = s.epoch.0, reason = ?reason, scan_ms = started.elapsed().as_millis() as u64, reused = st.reused,
            chunks_read = st.chunks_read, bytes_read = st.bytes_read, chunks_put = st.chunks_put, chunks_held = st.chunks_deferred,
            "commit: disk read"
        );
        // The disk is exactly its head's (nothing written since; a head's memory doesn't matter to
        // a salvage, which has none): there is no work to salvage.
        if incarnation::nothing_to_salvage(reason == CommitReason::Salvage, s.head.as_ref().map(|h| &h.disk_manifest), &disk_scan.hash) {
            return Ok(None);
        }
        Ok(Some(Prepared { disk: disk_scan, mem: mem_scan, reason, runs_at_read: runs, cut_ms: None }))
    }

    /// Upload what [`Inner::scan`] held back and the manifests, then send the `commit_request`
    /// (a new request id) unless the commit just asked again already covers these manifests.
    async fn publish_and_send(
        self: &Arc<Self>,
        s: SbxGuard,
        p: Prepared,
        answered: Option<(SentCommit, Option<GenerationRecord>)>,
        timeout: Duration,
    ) -> (SbxGuard, Result<Option<GenerationRecord>, ErrorBody>) {
        let store = self.store.clone();
        let started = Instant::now();
        let Prepared { disk, mem, reason, runs_at_read, cut_ms } = p;
        let published = tokio::task::spawn_blocking(move || -> std::io::Result<(ManifestHash, Option<ManifestHash>)> {
            storage::publish(store.as_ref(), &disk)?;
            if let Some(m) = &mem {
                storage::publish(store.as_ref(), m)?;
            }
            Ok((disk.hash, mem.map(|m| m.hash)))
        })
        .await;
        let (disk_manifest, mem_manifest) = match published {
            Ok(Ok(h)) => h,
            Ok(Err(e)) => return (s, Err(internal(e))),
            Err(e) => return (s, Err(internal(e))),
        };
        tracing::debug!(sandbox = %s.id, epoch = s.epoch.0, publish_ms = started.elapsed().as_millis() as u64, "commit: uploaded");
        let kind = if mem_manifest.is_some() { GenerationKind::Checkpoint } else { GenerationKind::DiskOnly };
        let c = SentCommit { request: RequestId(new_id("req_")), parent: s.head.as_ref().map(|h| h.id.clone()), kind, disk_manifest, mem_manifest, reason, cut_ms };
        // Nothing changed since the commit just answered: its generation is this one.
        if let Some((prev, g)) = answered
            && (&prev.disk_manifest, &prev.mem_manifest) == (&c.disk_manifest, &c.mem_manifest)
        {
            return (s, Ok(g));
        }
        self.send_commit(s, c, timeout, Some(runs_at_read)).await
    }

    /// Send a `commit_request` and wait (unlocked) for its answer; a timeout keeps it as
    /// [`Sbx::unanswered`] for the next commit to ask again.
    /// `read_at`: [`Sbx::runs`] when the committed disk was read or cut (`None`: unknown, as for a
    /// request asked about again): the disk is marked clean only if no VM has run since.
    async fn send_commit(self: &Arc<Self>, s: SbxGuard, c: SentCommit, timeout: Duration, read_at: Option<u64>) -> (SbxGuard, Result<Option<GenerationRecord>, ErrorBody>) {
        // Recorded before it goes out (or not sent): a restart asks again under this id.
        if let Err(e) = s.persist(Some(&c)) {
            return (s, Err(error(error_codes::INTERNAL, format!("recording commit {}: {e}", c.request), true)));
        }
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
            cut_ms: c.cut_ms,
        });
        let id = s.id.clone();
        let entry = tokio::sync::OwnedMutexGuard::mutex(&s).clone();
        drop(s);
        let outcome = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(o)) => Ok(o),
            _ => {
                self.pending_commits.lock().expect("pending").remove(&c.request);
                Err(error(error_codes::INTERNAL, format!("commit {} timed out", c.request), true))
            }
        };
        let mut s = entry.lock_owned().await;
        let r = match outcome {
            Ok(o) => {
                if s.unanswered.as_ref().is_some_and(|u| u.request == c.request) {
                    s.unanswered = None;
                }
                self.apply_commit(&mut s, &id, o, read_at)
            }
            Err(e) => {
                s.unanswered = Some(c);
                Err(e)
            }
        };
        s.persist_or_log(None);
        (s, r)
    }

    fn apply_commit(self: &Arc<Self>, s: &mut Sbx, id: &SandboxId, outcome: CommitOutcome, read_at: Option<u64>) -> Result<Option<GenerationRecord>, ErrorBody> {
        match outcome {
            CommitOutcome::Committed { generation } => {
                s.head = Some(generation.clone());
                // Clean only if no VM has run on the disk since it was read, and none runs now (a
                // suspend); `send_commit` persists it. A checkpoint's VM resumed before the answer
                // (and may have been stopped by a fence while it was awaited): its disk stays
                // dirty, so a retire salvages what it wrote.
                let still = (s.vm.is_none() || s.paused) && read_at == Some(s.runs);
                s.disk_clean = still;
                self.with_row(id, s.epoch, |x| {
                    x.head = Some(generation.id.clone());
                    if still {
                        x.dirty = false;
                    }
                });
                Ok(Some(generation))
            }
            CommitOutcome::Orphaned { generation } => Ok(Some(generation)),
            CommitOutcome::Rejected { reason: why, .. } => {
                if rejection_fences(&why) {
                    let this = self.clone();
                    let (id, epoch) = (id.clone(), s.epoch);
                    // Fence this incarnation (`fence_sandbox` checks the epoch under the summary lock:
                    // never a newer one that replaced it meanwhile); its work goes to salvage.
                    spawn_boxed(async move { this.fence_sandbox(&id, epoch, "commit rejected", true).await });
                }
                Err(error(&why, format!("commit rejected: {why}"), false))
            }
        }
    }
}

/// A commit reason as the wire spells it (`turn_end`), for the gateway's pause reason.
fn commit_reason_wire(reason: CommitReason) -> String {
    serde_json::to_value(reason).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| format!("{reason:?}"))
}

/// Whether SandboxDO's rejection of a commit fences the incarnation. The fence runs from a spawned
/// task (`apply_commit`), so a caller that would resume the VM checks this, not only `fenced`.
fn rejection_fences(code: &str) -> bool {
    code == error_codes::STALE_EPOCH || code == error_codes::PARENT_MISMATCH
}

/// What [`Inner::scan`] read, for [`Inner::publish_and_send`].
struct Prepared {
    disk: storage::Scanned,
    mem: Option<storage::Scanned>,
    reason: CommitReason,
    /// [`Sbx::runs`] when the disk was read or cut.
    runs_at_read: u64,
    /// When the disk was cut (a reflink cut read in the background).
    cut_ms: Option<i64>,
}

/// How this host cuts a running VM's disk for a checkpoint ([`decide_cut`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CutMode {
    /// No cut: the VM is paused while its disk is read (M1).
    None,
    /// `FICLONE` inside a pause only as long as the clone; read in the background (M2).
    Reflink,
    /// Tests and the e2e harness: a copy under an exclusive `flock` (`storage::locked_copy`).
    LockedCopy,
    /// Two shadows per incarnation, made equal to the disk by cloning only what changed (M3′,
    /// `nestd_core::shadow`): `FIEMAP` and `FICLONERANGE`.
    Shadow,
    /// Tests and the e2e harness: the shadow cut over `storage::sim_fiemap` and a byte copy.
    SimShadow,
}

impl CutMode {
    fn shadow(self) -> bool {
        matches!(self, CutMode::Shadow | CutMode::SimShadow)
    }
}

/// The configured cut, probed on the sandboxes' filesystem at start: `auto` takes a reflink where
/// it works and says so either way, since a host without one pauses its VMs for whole reads.
fn decide_cut(cfg: &Config) -> CutMode {
    let dir = cfg.sandboxes_dir();
    match cfg.disk_cut {
        DiskCut::Read => CutMode::None,
        DiskCut::LockedCopy => CutMode::LockedCopy,
        DiskCut::SimShadow => CutMode::SimShadow,
        DiskCut::Auto => {
            let _ = std::fs::create_dir_all(&dir);
            if storage::shadow_cut_works(&dir) {
                tracing::info!(dir = %dir.display(), "checkpoints cut disks into shadows, cloning only what changed");
                CutMode::Shadow
            } else if storage::reflink_works(&dir) {
                tracing::info!(dir = %dir.display(), "checkpoints cut disks with a reflink");
                CutMode::Reflink
            } else {
                tracing::warn!(dir = %dir.display(), "no reflink on the sandboxes' filesystem: checkpoints pause VMs while they read disks");
                CutMode::None
            }
        }
    }
}

/// An incarnation's commit lock ([`Inner::commit_locks`]).
type CommitLock = Arc<tokio::sync::Mutex<()>>;

/// A cut waiting for its background commit.
struct PendingCut {
    /// Unique on this host: the background task looks for its own.
    id: u64,
    /// The frozen copy to read, or a manifest already read (an unchanged disk, read in the pause).
    source: CutSource,
    pass: Pass,
    /// Whether the memo may record this pass ([`nestd_core::checkpoint`]), and the disk's stamp
    /// read right after the cut, while the VM was paused.
    stable: bool,
    stamp: Option<DiskStamp>,
    cut_ms: i64,
    runs_at_cut: u64,
    reason: CommitReason,
    keep_local: bool,
    /// A fork waits for its generation.
    done: Option<oneshot::Sender<Result<Option<GenerationRecord>, ErrorBody>>>,
}

enum CutSource {
    File(PathBuf),
    Read(storage::Scanned),
    /// A shadow left equal to the disk (M3′): read in place, never deleted.
    Shadow(Slot, PathBuf),
}

/// What a checkpoint with a cut returns: the generation at once (nothing to cut: no disk), or a
/// cut queued for its background commit.
enum CutOutcome {
    Committed(Option<GenerationRecord>),
    Queued { cut: u64, done: oneshot::Receiver<Result<Option<GenerationRecord>, ErrorBody>> },
}

/// Drop `s`'s queued cut, if any: a newer read of the disk replaces it. Its file goes, and a fork
/// waiting for it hears why.
fn drop_pending_cut(s: &mut Sbx, why: &str) {
    if let Some(p) = s.pending_cut.take() {
        tracing::info!(sandbox = %s.id, epoch = s.epoch.0, cut = p.id, why, "a queued cut is dropped");
        match &p.source {
            CutSource::File(f) => {
                let _ = std::fs::remove_file(f);
            }
            CutSource::Shadow(slot, _) => s.shadows.release(*slot),
            CutSource::Read(_) => {}
        }
        if let Some(done) = p.done {
            let _ = done.send(Err(error(error_codes::INTERNAL, format!("cut dropped: {why}"), true)));
        }
    }
}

/// A shadow's file in an incarnation directory (M3′).
fn shadow_path(dir: &Path, slot: Slot) -> PathBuf {
    dir.join(match slot {
        Slot::A => "shadow-a.img",
        Slot::B => "shadow-b.img",
    })
}

/// What the pre-copy leaves the pause: the shadow's map as it is now (after the pre-copy's clones),
/// to compare the disk's with.
struct PreCopy {
    base: Vec<shadow_core::Extent>,
    /// The shadow was made by this pre-copy (a whole clone while the VM ran).
    made: bool,
    ranges: usize,
    bytes: u64,
    ms: u64,
}

/// What a shadow cut did in the pause.
struct ShadowCut {
    records: usize,
    walk_ms: u64,
    ranges: usize,
    bytes: u64,
    /// Cloned whole (a new shadow, a failed pre-copy, or a check that failed).
    whole: bool,
}

fn shadow_map(mode: CutMode, path: &Path) -> std::io::Result<Vec<shadow_core::Extent>> {
    let raw = if mode == CutMode::SimShadow { storage::sim_fiemap(path)? } else { storage::fiemap(path)? };
    Ok(shadow_core::normalize(raw))
}

fn shadow_clone(mode: CutMode, disk: &Path, shadow: &Path, ranges: &[shadow_core::Range]) -> std::io::Result<()> {
    if mode == CutMode::SimShadow { storage::sim_clone_ranges(disk, shadow, ranges) } else { storage::clone_ranges(disk, shadow, ranges) }
}

/// The shadow made equal to the disk whole: a clone into a new file that replaces it.
fn shadow_whole(mode: CutMode, disk: &Path, shadow: &Path) -> std::io::Result<()> {
    let tmp = shadow.with_extension("img.tmp");
    let _ = std::fs::remove_file(&tmp);
    if mode == CutMode::SimShadow { storage::locked_copy(disk, &tmp)? } else { storage::reflink(disk, &tmp)? }
    std::fs::rename(&tmp, shadow)
}

/// While the VM runs: make the shadow if it isn't (`make`: a whole clone of the disk), write back
/// what the guest flushed, compare the disk's map with the shadow's, and, from `min_ranges` ranges
/// that differ, clone them now and read the shadow's map again, so the pause has little left to
/// clone (`nestd_core::shadow`). The VM writes throughout: the pause's comparison, against the
/// shadow's map as it is after these clones, catches whatever they missed.
fn pre_copy(mode: CutMode, disk: &Path, shadow: &Path, make: bool, min_ranges: usize) -> std::io::Result<PreCopy> {
    let started = Instant::now();
    if make {
        shadow_whole(mode, disk, shadow)?;
    }
    storage::sync_data(disk)?;
    let d0 = shadow_map(mode, disk)?;
    let s0 = shadow_map(mode, shadow)?;
    let ranges = shadow_core::changed(&d0, &s0);
    let bytes = ranges.iter().map(|r| r.end - r.start).sum();
    // The base is the shadow's map as it is after the clones, never the one read before them.
    let base = if ranges.len() >= min_ranges {
        shadow_clone(mode, disk, shadow, &ranges)?;
        shadow_map(mode, shadow)?
    } else {
        s0
    };
    Ok(PreCopy { base, made: make, ranges: ranges.len(), bytes, ms: started.elapsed().as_millis() as u64 })
}

/// In the pause: make the shadow equal to the disk. With a pre-copy's `base`, write back, walk the
/// disk's map, compare it with the shadow's and clone what differs; without one (or if that fails),
/// clone the disk whole. `verify` compares the two files after, and fails the cut if they differ.
fn cut_shadow(mode: CutMode, disk: &Path, shadow: &Path, base: Option<Vec<shadow_core::Extent>>, verify: bool) -> std::io::Result<ShadowCut> {
    let started = Instant::now();
    let by_diff = base.map(|base| -> std::io::Result<ShadowCut> {
        storage::sync_data(disk)?;
        let d1 = shadow_map(mode, disk)?;
        let walk_ms = started.elapsed().as_millis() as u64;
        let ranges = shadow_core::changed(&d1, &base);
        shadow_clone(mode, disk, shadow, &ranges)?;
        Ok(ShadowCut { records: d1.len(), walk_ms, ranges: ranges.len(), bytes: ranges.iter().map(|r| r.end - r.start).sum(), whole: false })
    });
    let cut = match by_diff {
        Some(Ok(c)) => c,
        Some(Err(e)) => {
            tracing::warn!(shadow = %shadow.display(), error = %e, "checkpoint: the shadow's comparison failed: cutting it whole");
            shadow_whole(mode, disk, shadow)?;
            ShadowCut { records: 0, walk_ms: 0, ranges: 0, bytes: 0, whole: true }
        }
        None => {
            shadow_whole(mode, disk, shadow)?;
            ShadowCut { records: 0, walk_ms: 0, ranges: 0, bytes: 0, whole: true }
        }
    };
    // The check the model proves can't fail (`verification/nestd/check`, `shadow`), made in tests:
    // a shadow that differs fails the cut, loudly.
    if verify && !storage::same_bytes(disk, shadow)? {
        tracing::error!(shadow = %shadow.display(), whole = cut.whole, "checkpoint: the shadow differs from its disk after the cut");
        return Err(std::io::Error::other("the shadow differs from its disk after the cut"));
    }
    Ok(cut)
}

/// Chunks a commit holds back in memory for upload after a checkpoint's VM resumes; past this it
/// uploads them while the VM is paused, as before. A turn changes tens of MB, usually
/// (`docs/sandbox/state/`), and nestd's own memory is what guests are packed around.
const HOLD_BACK_BYTES: usize = 64 << 20;

/// `path` as `stat` reads it, for the unchanged-disk check.
fn disk_stamp(path: &std::path::Path) -> std::io::Result<DiskStamp> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)?;
    Ok(DiskStamp { dev: m.dev(), ino: m.ino(), size: m.len(), mtime_sec: m.mtime(), mtime_nsec: m.mtime_nsec() as u32 })
}

/// Set `path`'s modification time to [`SENTINEL`] and read it back. Only nestd sets it, only while
/// nothing writes the file; any write after moves it to the current time.
fn set_sentinel(path: &std::path::Path) -> std::io::Result<DiskStamp> {
    let at = std::time::UNIX_EPOCH + Duration::new(SENTINEL.0 as u64, SENTINEL.1);
    std::fs::File::open(path)?.set_modified(at)?;
    disk_stamp(path)
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

fn slot_for(agent: &AgentId, slot: u16, cwd: String, env: BTreeMap<String, String>) -> AgentSlot {
    AgentSlot {
        agent_id: agent.clone(),
        proxy_port: EXPLICIT_BASE_PORT + slot,
        cwd,
        env,
        memory_max_bytes: None,
    }
}

fn hostname(id: &SandboxId) -> String {
    id.0.replace('_', "-")
}

/// Whether a failed salvage may succeed if tried again: a timeout or store error (`internal`,
/// retryable), or a `parent_mismatch`. A non-retryable refusal (`stale_epoch`, `invalid_message`)
/// is SandboxDO's final word on that work.
fn salvage_retryable(e: &ErrorBody) -> bool {
    incarnation::salvage_retryable(e.retryable, e.code == error_codes::PARENT_MISMATCH)
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

/// Why a host of `role` refuses a command of `kind` (`command_kind`), if it does: a brain host has no
/// driver, netns, proxy or gateway, so every command about a sandbox is refused. Brain commands are
/// the same on both kinds (the runner link is kind-independent): that a sandbox host never gets a
/// brain is FleetDO's rule (`issueCommands` refuses an `agent_start` there), and a sandbox host runs
/// no agent runner, so a start that reached one would never run. Pure, so the rule is tested apart
/// from the executor that applies it.
pub(crate) fn host_kind_refusal(role: HostRole, body: &CommandBody) -> Option<&'static str> {
    // Exhaustive on purpose: a new command must be placed on one side or the other.
    let about_a_sandbox = match body {
        CommandBody::SandboxCreate { .. }
        | CommandBody::SandboxSuspend { .. }
        | CommandBody::SandboxResume { .. }
        | CommandBody::SandboxArchive { .. }
        | CommandBody::SandboxCheckpoint { .. }
        | CommandBody::SandboxFork { .. }
        | CommandBody::SandboxDestroy { .. }
        | CommandBody::PolicyUpdate { .. }
        | CommandBody::SecretsUpdate { .. }
        | CommandBody::PortExpose { .. }
        | CommandBody::PortUnexpose { .. }
        | CommandBody::AgentAttach { .. }
        | CommandBody::AgentDetach { .. } => true,
        CommandBody::CommitResult { .. }
        | CommandBody::GuestCliResult { .. }
        | CommandBody::AgentStart(_)
        | CommandBody::AgentStop { .. }
        | CommandBody::Fence { .. }
        | CommandBody::Drain { .. } => false,
    };
    match role {
        HostRole::Brain if about_a_sandbox => Some("this is a brain host: it runs no sandboxes"),
        HostRole::Brain | HostRole::Sandbox => None,
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
/// A guest CLI call whose `NEST_AGENT_ID` is not an agent id is answered here, never relayed: the
/// control plane would refuse the event (deserializing already checks the prefix; this also covers
/// ids built in code).
fn cli_agent_refusal(agent: Option<&AgentId>) -> Option<CliResult> {
    let bad = agent.filter(|a| !a.is_valid())?;
    let shown: String = bad.0.chars().take(32).collect();
    Some(CliResult::Error { error: error(error_codes::INVALID_MESSAGE, format!("NEST_AGENT_ID {shown:?} is not an agent id"), false) })
}

fn grow_filesystem(disk: &std::path::Path) -> anyhow::Result<()> {
    let out = std::process::Command::new("resize2fs").arg("-f").arg(disk).output().context("run resize2fs")?;
    anyhow::ensure!(out.status.success(), "resize2fs {}: {}", disk.display(), String::from_utf8_lossy(&out.stderr).trim());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::LapseGuard;
    use nest_protocol::control::{EgressAuditRecord, EgressVerdict};

    struct NoPause;
    #[async_trait::async_trait]
    impl crate::driver::Pauser for NoPause {
        async fn pause(&self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// nestd review (M1): pause handles are per incarnation. Removing an older epoch's handle (its
    /// fence task running late, after a newer epoch booted) leaves the newer one's in place.
    #[test]
    fn an_older_epoch_never_takes_a_newer_epochs_pause_handle() {
        let p = super::Pausers::default();
        let s = SandboxId("sbx_1".into());
        p.insert(&s, Epoch(2), std::sync::Arc::new(NoPause));
        p.remove(&s, Epoch(1));
        assert!(p.get(&s, Epoch(2)).is_some());
        assert!(p.get(&s, Epoch(1)).is_none());
        p.remove(&s, Epoch(2));
        assert!(p.get(&s, Epoch(2)).is_none());
    }

    /// Which salvage failures are retried and which end the retire.
    /// A brain host refuses every sandbox command and nothing else; a sandbox host refuses nothing
    /// (FleetDO keeps brains off it). Checked on every command fixture (the fixtures cover every
    /// variant: `nest-protocol`'s round-trip test), by kind.
    #[test]
    fn a_brain_host_refuses_every_sandbox_command_and_nothing_else() {
        use super::{command_kind, host_kind_refusal};
        use nest_protocol::control::Command;
        use nest_protocol::model::HostRole;
        let sandbox_only = [
            "sandbox_create", "sandbox_suspend", "sandbox_resume", "sandbox_archive", "sandbox_checkpoint", "sandbox_fork",
            "sandbox_destroy", "policy_update", "secrets_update", "port_expose", "port_unexpose", "agent_attach", "agent_detach",
        ];
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/control/command");
        let mut seen = std::collections::BTreeSet::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let cmd: Command = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let kind = command_kind(&cmd.body);
            seen.insert(kind);
            assert_eq!(host_kind_refusal(HostRole::Brain, &cmd.body).is_some(), sandbox_only.contains(&kind), "{}", path.display());
            assert!(host_kind_refusal(HostRole::Sandbox, &cmd.body).is_none(), "{}", path.display());
        }
        assert_eq!(seen.len(), 19, "a fixture per command kind: {seen:?}");
    }

    /// Amendment A3 (a): a start that arrived before a lapse, or while lapsed, never runs, even
    /// once the lease is renewed; one that arrived after the renewal runs.
    #[test]
    fn a_start_never_outlives_a_lease_lapse() {
        let g = LapseGuard::default();
        g.arrived("before");
        g.lapsed();
        g.arrived("during");
        g.renewed();
        g.arrived("after");
        assert!(g.outlived("before"));
        assert!(g.outlived("during"));
        assert!(!g.outlived("after"));
        assert!(!g.outlived("unknown"), "a command never stamped (e.g. replayed from the cache path) is not refused here");
    }

    #[test]
    fn a_salvage_is_retried_only_when_it_may_still_land() {
        use nest_protocol::model::error_codes;
        let e = |code: &str, retryable| super::error(code, "x", retryable);
        assert!(super::salvage_retryable(&e(error_codes::INTERNAL, true)), "a timeout or store error");
        assert!(super::salvage_retryable(&e(error_codes::PARENT_MISMATCH, false)));
        assert!(!super::salvage_retryable(&e(error_codes::STALE_EPOCH, false)));
        assert!(!super::salvage_retryable(&e(error_codes::INVALID_MESSAGE, false)));
    }
    use nest_protocol::guest::CliResult;
    use nest_protocol::model::{AgentId, Epoch, SandboxId};

    /// A malformed agent id from inside a sandbox stops at nestd instead of reaching FleetDO.
    #[test]
    fn refuses_a_guest_cli_call_with_a_bad_agent_id() {
        match super::cli_agent_refusal(Some(&AgentId("x".into()))) {
            Some(CliResult::Error { error }) => assert_eq!(error.code, "invalid_message"),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(super::cli_agent_refusal(Some(&AgentId("agt_w".into()))).is_none());
        assert!(super::cli_agent_refusal(None).is_none(), "no agent id is the control plane's call");
    }

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

    /// The pause's write-back is load-bearing on a real XFS (`NEST_TEST_XFS_DIR`): a write after the
    /// pre-copy, still only in the page cache over a block the shadow shares, doesn't move the
    /// disk's map until it is written back. The same comparison without the write-back misses it
    /// (shown here, so the test can't pass vacuously); `cut_shadow`, which writes back first, doesn't.
    #[test]
    fn the_pauses_write_back_catches_a_write_after_the_pre_copy() {
        use super::{CutMode, cut_shadow, pre_copy, shadow_clone, shadow_map, storage};
        use std::os::unix::fs::FileExt;
        let Some(xfs) = std::env::var_os("NEST_TEST_XFS_DIR") else {
            assert!(std::env::var_os("NEST_CI_REQUIRE_USERNS").is_none(), "NEST_TEST_XFS_DIR is unset, and CI forbids skipping");
            eprintln!("NEST-TEST-SKIP: the_pauses_write_back_catches_a_write_after_the_pre_copy: NEST_TEST_XFS_DIR is unset");
            return;
        };
        let dir = tempfile::tempdir_in(xfs).unwrap();
        let (disk, a, b) = (dir.path().join("disk.img"), dir.path().join("shadow-a.img"), dir.path().join("shadow-b.img"));
        let f = std::fs::File::create(&disk).unwrap();
        f.write_all_at(&vec![7u8; 1 << 20], 0).unwrap();
        f.sync_all().unwrap();
        let after = |f: &std::fs::File| f.write_all_at(&[9u8; 4096], 64 << 10).unwrap();
        // Without the write-back: the write is missed.
        let pre = pre_copy(CutMode::Shadow, &disk, &a, true, 0).unwrap();
        after(&f);
        let unsynced = shadow_map(CutMode::Shadow, &disk).unwrap();
        shadow_clone(CutMode::Shadow, &disk, &a, &nestd_core::shadow::changed(&unsynced, &pre.base)).unwrap();
        assert!(!storage::same_bytes(&disk, &a).unwrap(), "the map moved before write-back: this kernel doesn't show the hazard");
        // `cut_shadow`, the same steps with the write-back first: equal.
        f.write_all_at(&[7u8; 4096], 64 << 10).unwrap();
        let pre = pre_copy(CutMode::Shadow, &disk, &b, true, 0).unwrap();
        after(&f);
        let cut = cut_shadow(CutMode::Shadow, &disk, &b, Some(pre.base), false).unwrap();
        assert!(!cut.whole);
        assert!(storage::same_bytes(&disk, &b).unwrap(), "the shadow missed a write made after its pre-copy");
    }
}
