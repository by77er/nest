//! Control plane <-> host wire types. Spec: docs/interfaces/control-host/.
//!
//! Three transports:
//! - **Enrollment** (HTTPS, once per host boot): [`EnrollRequest`] → [`EnrollResponse`].
//! - **Fleet channel** (WebSocket, host → FleetDO, one per host): [`HostToFleet`] / [`FleetToHost`].
//! - **Session channel** (WebSocket, agent runner → AgentDO, one per active agent):
//!   [`RunnerToAgent`] / [`AgentToRunner`].
//!
//! Reliable messages carry a per-direction `seq` and are acknowledged cumulatively with `ack`.

use serde::{Deserialize, Serialize};

use crate::gateway::{BindingKey, GuestInfo, HandsTarget};
use crate::model::{
    AgentEvent, AgentId, AgentRole, AgentState, AskId, CallId, CommandId, CommitReason, Epoch,
    ErrorBody, EgressPolicy, ForkMode, GenerationId, GenerationKind, GenerationRecord, HostId,
    HostRole, InjectionSecret, ManifestHash, MessageId, RequestId, Resources, SandboxId,
    SandboxState, Seq, SessionId, SuspendMode, TimestampMs, TurnId, TurnInputKind, WorkstreamEvent,
    WorkstreamId,
};

/// Lease timings (docs/sandbox/fencing/). Sent in `hello_ack`; hosts must use these values.
pub const HEARTBEAT_INTERVAL_MS: u64 = 5_000;
/// Host treats its leases as expired this long after it *sent* the last acknowledged heartbeat.
pub const HOST_FENCE_AFTER_MS: u64 = 20_000;
/// FleetDO treats a host's leases as expired this long after the last heartbeat it *received*.
pub const CP_LEASE_EXPIRY_MS: u64 = 30_000;

// =================================================================================================
// Enrollment (HTTPS POST /v1/hosts/enroll)
// =================================================================================================

/// First contact from a freshly booted host. No secrets in user-data: AWS hosts prove identity
/// with the signed instance identity document; others use a one-time token I minted.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollRequest {
    pub protocol_version: u32,
    pub role: HostRole,
    pub cell: String,
    pub proof: EnrollmentProof,
    /// PEM PKCS#10 CSR for nest-proxy's per-host intermediate CA (key generated on the host and
    /// never leaves it).
    pub proxy_ca_csr_pem: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EnrollmentProof {
    /// IMDSv2 `/latest/dynamic/instance-identity/document` and its **`rsa2048`** signature
    /// (`/latest/dynamic/instance-identity/rsa2048`: an RSA-2048 / SHA-256 CMS signature, with or
    /// without PEM armor). The legacy DSA `/pkcs7` form is not accepted. The field keeps its
    /// historical name. FleetDO verifies the signature and that it launched this instance ID and
    /// hasn't enrolled it already.
    AwsIdentityDocument { document_b64: String, pkcs7_b64: String },
    /// Single-use token for hosts outside AWS (e.g. the controller host on a VPS).
    EnrollmentToken { token: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnrollResponse {
    pub host: HostId,
    /// Bearer token for the fleet and session WebSockets. Short-lived; rotated over the fleet
    /// channel (`host_token`).
    pub host_token: String,
    pub host_token_expires_ms: TimestampMs,
    pub fleet_ws_url: String,
    pub proxy_ca: CaCertificate,
    /// The host's Cloudflare Tunnel token, when the control plane created a tunnel for it (a
    /// sandbox host in a cell with a zone): nestd runs cloudflared with it, in memory and in its
    /// credentials file, never on a command line. Absent on the harness and on hosts that run
    /// no sandboxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tunnel_token: Option<crate::model::Secret>,
    /// The URL clients will be told for this host's gateway (`wss://<host>-gw-nest.<zone>` behind
    /// the tunnel). The control plane is the authority; the host's own `hello.gateway_url` counts
    /// only when this is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
}

/// Per-host intermediate CA certificate (≈7 days), signed by the root key held in the control
/// plane. The root certificate is baked into the sandbox image.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaCertificate {
    pub cert_pem: String,
    /// Intermediate + root, PEM, leaf-to-root order.
    pub chain_pem: String,
    pub expires_ms: TimestampMs,
}

// =================================================================================================
// Fleet channel: host <-> FleetDO
// =================================================================================================

/// Host → FleetDO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostToFleet {
    /// First frame after connecting (the WebSocket upgrade carries `Authorization: Bearer`).
    /// Boxed: by far the largest variant.
    Hello(Box<HostHello>),
    /// Every `HEARTBEAT_INTERVAL_MS`. Renews the lease of every listed sandbox. Unreliable by
    /// design: a lost heartbeat is just a missed renewal.
    Heartbeat { sent_ms: TimestampMs, leases: Vec<LeaseClaim> },
    /// Reliable, batched every 1–2 s.
    Events { seq: Seq, events: Vec<HostEvent> },
    /// Cumulative ack of `FleetToHost::Commands` up to and including `up_to`.
    Ack { up_to: Seq },
    /// Renew the proxy intermediate CA before it expires.
    CaRenew { csr_pem: String },
}

/// Whether the host's Cloudflare Tunnel serves its gateway hostname: `none` (no tunnel runs: no
/// token, no binary, or a nestd that predates the field), `connecting` (cloudflared runs but
/// reports no ready connection to Cloudflare yet) or `connected` (it does). Reported in the hello
/// and as a `tunnel_state` event on every change; the control plane advertises the tunnel
/// hostname only while `connected` (docs/sandbox/gateway/, Addressing).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum TunnelState {
    #[default]
    None,
    Connecting,
    Connected,
}

impl TunnelState {
    /// `none` is the wire default and is left out when serializing.
    pub fn is_none(&self) -> bool {
        *self == TunnelState::None
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostHello {
    pub protocol_version: u32,
    pub host: HostId,
    /// Random per nestd process. When it differs from the previous connection's, FleetDO resets
    /// both seq lineages (host events and commands) and reconciles from this report instead of
    /// replaying unacked commands the new process has no memory of.
    pub instance_id: String,
    pub role: HostRole,
    pub cell: String,
    pub versions: ComponentVersions,
    /// Where clients reach this host's sandbox gateway: a `ws://` or `wss://` base URL (the
    /// host's tunnel hostname on a real host). Absent on a host that runs no sandboxes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway_url: Option<String>,
    /// The tunnel's state at connect time; changes follow as `tunnel_state` events. Absent
    /// (an older nestd, or a host without a tunnel) means `none`.
    #[serde(default, skip_serializing_if = "TunnelState::is_none")]
    pub tunnel: TunnelState,
    /// Highest `FleetToHost::Commands.seq` this host fully processed (reconnect resume).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_command_seq: Option<Seq>,
    /// Set when nestd is configured to run its VMMs in its delegated unit cgroup and could not set
    /// that up: its VMMs then sit outside the unit, so a restart of the unit doesn't kill them
    /// (nestd still kills leftovers at start). Absent when delegation works or isn't configured.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cgroup_delegation_error: Option<String>,
    /// Everything this host currently holds; FleetDO reconciles against it.
    pub sandboxes: Vec<SandboxReport>,
    pub agents: Vec<AgentReport>,
    pub capacity: Capacity,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComponentVersions {
    pub nestd: String,
    pub nest_proxy: String,
    pub agent_runner: String,
    pub claude_code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxReport {
    pub sandbox: SandboxId,
    pub epoch: Epoch,
    pub state: SandboxState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<GenerationId>,
    /// Uncommitted local writes exist (salvage candidate if the epoch turns out stale).
    #[serde(default)]
    pub dirty: bool,
    /// The guest's version and capabilities for a `running` sandbox (nestd caches the last
    /// guest hello, so a resumed sandbox reports it too).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guest: Option<GuestInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReport {
    pub agent: AgentId,
    pub state: AgentState,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseClaim {
    pub sandbox: SandboxId,
    pub epoch: Epoch,
}

fn is_zero(n: &u32) -> bool {
    *n == 0
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capacity {
    pub vcpus_free: u32,
    /// `MemAvailable`: what the host can still give sandboxes backed by regular pages.
    pub memory_mib_free: u32,
    pub hugepages_mib_free: u32,
    /// The hugepage pool's size; 0 (the wire default) means guest memory is regular pages and
    /// placement packs by `memory_mib_free`, otherwise by `hugepages_mib_free`.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub hugepages_mib_total: u32,
    pub sandboxes: u32,
    pub agents: u32,
    /// Generations whose snapshots are warm locally (page cache or NVMe); placement prefers them.
    #[serde(default)]
    pub warm: Vec<GenerationId>,
}

/// FleetDO → host.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FleetToHost {
    HelloAck(HelloAck),
    HeartbeatAck {
        /// Echo of `Heartbeat.sent_ms`: the host's lease deadline is `sent_ms + host_fence_ms`.
        sent_ms: TimestampMs,
        server_ms: TimestampMs,
        /// Claims FleetDO no longer honors (expired, reassigned, or destroyed). The host must
        /// fence these immediately.
        #[serde(default)]
        revoked: Vec<LeaseClaim>,
    },
    /// Reliable, batched. Commands are applied in order; each yields exactly one
    /// `HostEvent::CommandResult` (dedup on `cmd`).
    Commands { seq: Seq, commands: Vec<Command> },
    /// Cumulative ack of `HostToFleet::Events` up to and including `up_to`.
    Ack { up_to: Seq },
    /// Rotated bearer token; use for all new connections and reconnects.
    HostToken { token: String, expires_ms: TimestampMs },
    /// Every binding verification key still valid, for the sandbox gateway (replaces the set).
    /// Sent after `hello_ack` and on every rotation.
    BindingKey { keys: Vec<BindingKey> },
    /// Renewed proxy intermediate (answer to `CaRenew`).
    ProxyCa(CaCertificate),
    /// Fatal or per-frame error. `unsupported_version` / `unauthorized` close the socket.
    Error { error: ErrorBody },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloAck {
    pub protocol_version: u32,
    pub server_ms: TimestampMs,
    /// Highest `HostToFleet::Events.seq` FleetDO has durably processed; the host resends after it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_event_seq: Option<Seq>,
    pub lease: LeaseTiming,
    pub host_token_expires_ms: TimestampMs,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeaseTiming {
    pub heartbeat_ms: u64,
    pub host_fence_ms: u64,
    pub cp_expiry_ms: u64,
}

impl Default for LeaseTiming {
    fn default() -> Self {
        Self { heartbeat_ms: HEARTBEAT_INTERVAL_MS, host_fence_ms: HOST_FENCE_AFTER_MS, cp_expiry_ms: CP_LEASE_EXPIRY_MS }
    }
}

// --- Commands -------------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Command {
    pub cmd: CommandId,
    pub issued_ms: TimestampMs,
    #[serde(flatten)]
    pub body: CommandBody,
}

/// Everything FleetDO asks a host to do. Sandbox-scoped commands carry the epoch the host must
/// hold; a host that holds a different epoch replies `stale_epoch`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CommandBody {
    /// Grants the lease at `epoch` and boots the sandbox: fresh from `image` when `from` is
    /// `None`, otherwise restored (lazily) from that generation — memory restore iff it is a
    /// `checkpoint`, cold boot otherwise.
    SandboxCreate {
        sandbox: SandboxId,
        workstream: WorkstreamId,
        epoch: Epoch,
        image: String,
        resources: Resources,
        policy: EgressPolicy,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<GenerationRecord>,
    },
    /// Commit (reason `suspend`) then stop the VM, keeping local state.
    SandboxSuspend { sandbox: SandboxId, epoch: Epoch, mode: SuspendMode },
    /// Resume a sandbox suspended on this host.
    SandboxResume { sandbox: SandboxId, epoch: Epoch },
    /// Commit, then evict all local state; afterwards the sandbox lives only in object storage.
    SandboxArchive { sandbox: SandboxId, epoch: Epoch },
    /// Force a commit now (e.g. before delegate inspection or on request).
    SandboxCheckpoint { sandbox: SandboxId, epoch: Epoch, reason: CommitReason },
    /// Commit the parent (reason `fork`), then create `child` from that generation on this host
    /// (same-host fast path). For a cross-host fork FleetDO instead sends `sandbox_checkpoint`
    /// here and `sandbox_create { from }` to the other host.
    SandboxFork {
        parent: SandboxId,
        parent_epoch: Epoch,
        child: SandboxId,
        child_epoch: Epoch,
        child_workstream: WorkstreamId,
        mode: ForkMode,
        policy: EgressPolicy,
    },
    SandboxDestroy { sandbox: SandboxId, epoch: Epoch },
    /// Replace the effective egress policy (ignored if `policy.version` is not newer).
    PolicyUpdate { sandbox: SandboxId, epoch: Epoch, policy: EgressPolicy },
    /// Replace the secret values for injection bindings. Held only in nest-proxy memory.
    SecretsUpdate { sandbox: SandboxId, epoch: Epoch, secrets: Vec<InjectionSecret> },
    PortExpose { sandbox: SandboxId, epoch: Epoch, port: u16, host_header: HostHeaderMode },
    PortUnexpose { sandbox: SandboxId, epoch: Epoch, port: u16 },
    /// Answer to `HostEvent::CommitRequest`. Delivered reliably as a command.
    CommitResult { request: RequestId, sandbox: SandboxId, outcome: CommitOutcome },
    /// Answer to `HostEvent::GuestCli`; nestd relays it to the guest's pending `cli` request.
    GuestCliResult { request: RequestId, result: crate::guest::CliResult },
    /// Start a brain (agent runner). The runner then opens the session channel to AgentDO.
    AgentStart(AgentStart),
    /// Configure an agent's slot in a sandbox's guest (cwd, proxy port, cgroup): the sandbox
    /// side of `attach`. Goes to the sandbox's host; the brain may run anywhere. Idempotent: an
    /// existing slot is replaced. `cwd` defaults to [`DEFAULT_CWD`]. Its `command_result` is what
    /// SandboxDO waits for before it hands out a binding, so a first hands call never beats the
    /// slot.
    AgentAttach {
        sandbox: SandboxId,
        epoch: Epoch,
        agent: AgentId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    /// Remove the slot (an unknown agent is `ok`); with `kill_processes`, kill the agent's whole
    /// cgroup first. The gateway then refuses the agent's bindings (`unauthorized`).
    AgentDetach { sandbox: SandboxId, epoch: Epoch, agent: AgentId, #[serde(default)] kill_processes: bool },
    /// Stop the brain process: `graceful` (absent: nestd of the previous release always does so)
    /// lets the current turn finish, in order; `kill` ends it at once, applied on arrival (AgentDO
    /// starts the brain elsewhere once its exit is reported). `epoch`: the newest agent epoch this
    /// stop ends; nestd remembers the highest killed one per agent and refuses a later
    /// `agent_start` at or below it (a kill overtaking a queued start). A kill for a brain nestd
    /// doesn't run is answered with its `agent_exited` at once.
    AgentStop {
        agent: AgentId,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mode: Option<crate::host::runner::StopMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        epoch: Option<Epoch>,
    },
    /// Fence immediately: pause these sandboxes' VMs, drop their listeners/netns. Brains are not
    /// touched: they are fenced by their own host's lease and their agent epoch, and their hands
    /// by the gateway.
    Fence { sandboxes: Vec<SandboxId>, reason: String },
    /// Spot reclaim or scale-down: commit/suspend everything by `deadline_ms`, then exit.
    Drain { reason: String, deadline_ms: TimestampMs },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum HostHeaderMode {
    /// `Host: localhost:<port>` + `X-Forwarded-Host` (default; satisfies dev-server host checks).
    Localhost,
    /// Forward the public host unchanged.
    Preserve,
    Custom { value: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommitOutcome {
    /// Head advanced to `generation`.
    Committed { generation: GenerationRecord },
    /// Salvage commit accepted as a sibling branch (head unchanged); captain gets `orphaned_work`.
    Orphaned { generation: GenerationRecord },
    /// Compare-and-set failed. `reason` is `stale_epoch` or `parent_mismatch`; the host must
    /// treat `stale_epoch` as a fence for this sandbox.
    Rejected {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        head: Option<GenerationId>,
    },
}

/// The sandbox an agent's hands act in, by id only: no address, no token, no epoch (the sandbox
/// epoch travels inside the binding). The runner fetches the target (`HandsTarget`) with
/// `hands_resolve` over its own session channel.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandsBinding {
    pub sandbox: SandboxId,
    /// Deprecated, for one release: the control plane still sends a copy of
    /// [`AgentStart::epoch`] here, because runners of the previous release take their session
    /// epoch from it (and require the field). Current runners use it only when `epoch` is absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<Epoch>,
}

/// Default working directory of an agent's slot (`agent_attach.cwd`).
pub const DEFAULT_CWD: &str = "/workspace";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentStart {
    pub agent: AgentId,
    pub role: AgentRole,
    pub workstream: WorkstreamId,
    /// The agent epoch AgentDO issued for this brain start (one per start, never reused). The
    /// brain presents it in its session `hello`; AgentDO keys platform tool calls and filters
    /// events by it. Unrelated to the sandbox's epoch: a sandbox move doesn't change it. Absent
    /// only from a command queued by a control plane of the previous release (see
    /// [`AgentStart::agent_epoch`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<Epoch>,
    /// Existing session to resume; `None` starts a fresh conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<SessionResume>,
    /// The sandbox this agent's hands act in, if any. Only its id: the gateway URL and the
    /// binding never pass through FleetDO or nestd; the runner asks AgentDO for them
    /// (`hands_resolve`) before its first hands call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hands: Option<HandsBinding>,
    pub launch: LaunchConfig,
    /// `claude setup-token` OAuth token. Goes only into the Claude Code process environment
    /// (`CLAUDE_CODE_OAUTH_TOKEN`); never logged, never written to disk, never sent to a VM.
    pub oauth_token: crate::model::Secret,
    pub session_ws_url: String,
}

impl AgentStart {
    /// The brain's session epoch: `epoch`, or, in a command from a control plane of the previous
    /// release, the `hands.epoch` it sent instead (`0` for an agent without hands, as it did).
    pub fn agent_epoch(&self) -> Epoch {
        self.epoch.or_else(|| self.hands.as_ref().and_then(|h| h.epoch)).unwrap_or(Epoch(0))
    }
}

/// Rebuild the native session file before `claude --resume <path>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionResume {
    pub session: SessionId,
    /// Presigned R2 GET URLs, in offset order; concatenated they form the file (a later `base`
    /// segment resets the file to its contents).
    pub segments: Vec<SegmentRef>,
    pub total_bytes: u64,
    /// Conversation fork: resume with `--fork-session` (new session id).
    #[serde(default)]
    pub fork: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SegmentRef {
    pub offset: u64,
    pub len: u64,
    #[serde(default)]
    pub base: bool,
    pub url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Value for `--tools` (built-ins that don't touch the host). Empty for captains.
    pub builtin_tools: Vec<String>,
    pub system_prompt: SystemPrompt,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum SystemPrompt {
    /// `--append-system-prompt-file` (workers: keep the coding prompt).
    Append { text: String },
    /// `--system-prompt-file` (captains: `captain.md`).
    Replace { text: String },
}

// --- Host events ----------------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostEvent {
    pub ts_ms: TimestampMs,
    #[serde(flatten)]
    pub body: HostEventBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostEventBody {
    /// Exactly one per `Command`, after it finished (or failed).
    CommandResult { cmd: CommandId, outcome: CommandOutcome },
    SandboxState {
        sandbox: SandboxId,
        epoch: Epoch,
        state: SandboxState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suspend_mode: Option<SuspendMode>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        /// The guest's protocol version and capabilities. Every `running` carries it (nestd
        /// caches the last guest hello, so a resume reports it without a new hello); a repeated
        /// `running` with a different `guest` is an update, not a transition. SandboxDO hands it
        /// to clients in `resolve`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        guest: Option<GuestInfo>,
    },
    /// A fenced (or superseded) incarnation is gone from this host: its uncommitted work was
    /// salvaged, there was none, or SandboxDO refused it for good; its disk is deleted. FleetDO marks
    /// the stale incarnation clean, so it is destroyed without waiting out the salvage window. An
    /// older Worker quarantines the unknown event and loses only that shortcut.
    IncarnationRetired { sandbox: SandboxId, epoch: Epoch },
    /// Chunks are already uploaded; asks SandboxDO to compare-and-set head. Answered by
    /// `CommandBody::CommitResult`.
    CommitRequest {
        request: RequestId,
        sandbox: SandboxId,
        epoch: Epoch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<GenerationId>,
        kind: GenerationKind,
        disk_manifest: ManifestHash,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mem_manifest: Option<ManifestHash>,
        reason: CommitReason,
    },
    /// Host-originated workstream events (port opened/exposed, egress denied/alert).
    Workstream { event: WorkstreamEvent },
    /// A `nest` CLI command run by a program inside the sandbox (`notify`/`emit`/`ask`/`expose`),
    /// relayed guest → nestd → FleetDO → AgentDO. Answered by `CommandBody::GuestCliResult`.
    /// `agent` comes from `NEST_AGENT_ID` (attribution only).
    GuestCli {
        request: RequestId,
        sandbox: SandboxId,
        epoch: Epoch,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent: Option<AgentId>,
        command: crate::guest::CliCommand,
    },
    /// A background hands task exited. FleetDO forwards it to the agent's AgentDO as an
    /// `AgentEventBody::TaskExited`.
    TaskExited { sandbox: SandboxId, epoch: Epoch, agent: AgentId, task: crate::guest::TaskInfo },
    EgressAudit { records: Vec<EgressAuditRecord> },
    Capacity { capacity: Capacity },
    /// The host's tunnel changed state (see [`TunnelState`]).
    TunnelState { state: TunnelState },
    /// Spot interruption notice (IMDS): the host is draining by `deadline_ms`.
    SpotNotice { deadline_ms: TimestampMs },
    /// Brain process ended (crash, stop, or idle exit). Lifecycle only; turns/state go over the
    /// session channel.
    AgentExited {
        agent: AgentId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
        reason: AgentExitReason,
        /// The agent epoch the brain ran under (absent from the previous release, or for a brain
        /// the runner never reported): an exit of an older start than AgentDO's is ignored.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        epoch: Option<Epoch>,
    },
}

/// Why a brain process ended (`HostEventBody::AgentExited.reason`); AgentDO decides whether to
/// restart it from this. The runner's `host::runner::ExitReason` maps onto it member for member.
/// Open: a member this build doesn't know (a newer sender, or free text from an older one) parses
/// as `unknown`, so a new reason never rejects an event batch.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum AgentExitReason {
    /// Idle grace elapsed; stdin closed; exited cleanly.
    Idle,
    /// `agent_stop`.
    Stopped,
    /// The sandbox lease (or the host's) lapsed.
    Fenced,
    /// Startup auth verification failed.
    AuthFailed,
    Crashed,
    /// The control plane's own: the host reconnected without reporting the brain. Never sent by
    /// a host.
    HostLost,
    /// Deserialize-only fallback; never sent by this build.
    #[serde(other)]
    Unknown,
}

impl From<crate::host::runner::ExitReason> for AgentExitReason {
    fn from(r: crate::host::runner::ExitReason) -> Self {
        use crate::host::runner::ExitReason;
        match r {
            ExitReason::Idle => Self::Idle,
            ExitReason::Stopped => Self::Stopped,
            ExitReason::Fenced => Self::Fenced,
            ExitReason::AuthFailed => Self::AuthFailed,
            ExitReason::Crashed => Self::Crashed,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CommandOutcome {
    Ok {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<serde_json::Value>,
    },
    Error { error: ErrorBody },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum EgressVerdict {
    Allow,
    Passthrough,
    Deny,
    /// Placeholder sent to a host outside its binding; request blocked.
    Alert,
}

/// Which nest-proxy entry point handled a connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum EgressVia {
    Dns,
    HttpTransparent,
    HttpsTransparent,
    /// Per-agent explicit proxy listener (`HTTP(S)_PROXY`).
    Explicit,
    TcpException,
}

/// One proxied connection/request. Never contains secret values or query strings.
/// `reason` values are listed in docs/interfaces/host-internal/nestd-proxy/.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressAuditRecord {
    pub sandbox: SandboxId,
    pub epoch: Epoch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentId>,
    pub ts_ms: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub via: Option<EgressVia>,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub bytes_up: u64,
    pub bytes_down: u64,
    pub verdict: EgressVerdict,
    /// Name (never value) of the injection binding used or violated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// For an aggregated record: how many requests it stands for (absent = 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<u32>,
}

// =================================================================================================
// Session channel: agent runner <-> AgentDO
// =================================================================================================

/// Agent runner → AgentDO (one WebSocket per active agent, opened after `agent_start`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunnerToAgent {
    Hello(RunnerHello),
    /// Native session JSONL bytes `[offset, offset+len)`. `base: true` means the file was
    /// rewritten (shrank / new inode): discard earlier segments, this one starts at offset 0.
    /// Acknowledged by `segment_ack` after the bytes are durable in R2. Not seq-numbered:
    /// offsets are the ordering and dedup key.
    Segment { session: SessionId, offset: u64, base: bool, data_b64: String },
    /// Reliable, batched every 1–2 s; coalesced (heartbeat-ish tool events may be dropped
    /// under pressure, leaving a seq gap that AgentDO repairs from the session).
    Events { seq: Seq, events: Vec<AgentEvent> },
    /// Platform tool invocation relayed from nest-mcp. Reliable; answered by `tool_result`.
    /// Idempotency key: (agent, epoch, call).
    ToolCall(ToolCall),
    /// nest-mcp asks for the current platform tool list (captain backends use the DO registry).
    ToolsListRequest { request: RequestId },
    /// The runner's binding aged out or a gateway refused it (`stale_epoch`, `moved`, a refused
    /// connection): ask AgentDO for the sandbox's current placement. Answered by `hands_resolved`.
    HandsResolve { request: RequestId },
    /// The runner abandoned a platform tool call (it timed out locally and returned
    /// `outcome_unknown` to the model). Reliable. AgentDO marks the call cancelled: if it hasn't
    /// started it never runs, a pending `ask` is withdrawn, and a late result is discarded.
    CancelCall { seq: Seq, call: CallId, reason: String },
    /// Cumulative ack of reliable `AgentToRunner` messages.
    Ack { up_to: Seq },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunnerHello {
    pub protocol_version: u32,
    pub agent: AgentId,
    pub host: HostId,
    /// Random per brain process (runner restart, brain restart, move). When it changes, AgentDO
    /// resets the session channel's seq lineage and event dedup, like FleetDO does for
    /// `HostHello.instance_id`.
    pub instance_id: String,
    /// The agent epoch of this brain start (`AgentStart::epoch`), never the sandbox's. A brain
    /// that adopted a newer epoch (a later `agent_start` while it ran) reconnects with that one.
    pub epoch: Epoch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionId>,
    /// Bytes of the session file present locally (resume after reconnect).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_bytes: Option<u64>,
    /// Highest reliable `AgentToRunner` seq processed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<Seq>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub seq: Seq,
    pub call: CallId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnId>,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// AgentDO → agent runner.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentToRunner {
    HelloAck {
        protocol_version: u32,
        /// Session bytes already durable in R2; the runner resends from here.
        durable_bytes: u64,
        /// Highest reliable `RunnerToAgent` seq processed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        last_seq: Option<Seq>,
    },
    SegmentAck { session: SessionId, durable_bytes: u64 },
    /// Start a turn (written to the harness stdin as a user message).
    RunTurn { seq: Seq, turn: TurnId, input: TurnInput },
    /// Deliver mid-turn (stream-json stdin) or at `Stop` (inbox mirror); `interrupt` interrupts
    /// the current turn first.
    Inbox { seq: Seq, message: InboxMessage },
    Interrupt {
        seq: Seq,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn: Option<TurnId>,
    },
    /// Replace the runner's local caches used to answer synchronous hooks in ~1 ms.
    CacheUpdate { seq: Seq, cache: AgentCache },
    ToolResult { seq: Seq, call: CallId, outcome: ToolOutcome },
    ToolsList { request: RequestId, tools: Vec<ToolDef> },
    /// Answer to `hands_resolve`: `outcome` is a fresh target or the reason there is none.
    ///
    /// `hands`, `error` and `retry_after_ms` are the previous release's shape of the same answer
    /// (exactly one of `hands` and `error`). For one release the control plane sends both
    /// shapes, so runners of either release understand it; a runner reads `outcome` first and
    /// falls back to them ([`HandsOutcome::from_legacy`]).
    HandsResolved {
        request: RequestId,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        outcome: Option<Box<HandsOutcome>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hands: Option<HandsTarget>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ErrorBody>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
    Ack { up_to: Seq },
    Error { error: ErrorBody },
}

/// What `hands_resolve` produced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum HandsOutcome {
    /// A fresh binding and the sandbox's current gateway.
    Ok { hands: HandsTarget },
    /// No target now: `not_bound` (the agent has no hands: tell the model), `sandbox_not_ready`
    /// with `retry_after_ms` (placing, waking: wait and ask again), `stale_epoch` (not the
    /// current runner process or epoch), or another error the runner surfaces as an MCP error.
    Error {
        error: ErrorBody,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
    },
}

impl HandsOutcome {
    /// The answer in `hands_resolved`: `outcome`, else the previous release's three-optional
    /// shape (`hands` wins; neither present is an `invalid_message` error).
    pub fn from_wire(outcome: Option<Box<HandsOutcome>>, hands: Option<HandsTarget>, error: Option<ErrorBody>, retry_after_ms: Option<u64>) -> Self {
        match (outcome, hands, error) {
            (Some(o), _, _) => *o,
            (None, Some(hands), _) => HandsOutcome::Ok { hands },
            (None, None, Some(error)) => HandsOutcome::Error { error, retry_after_ms },
            (None, None, None) => HandsOutcome::Error {
                error: ErrorBody {
                    code: crate::model::error_codes::INVALID_MESSAGE.into(),
                    message: "hands_resolved carried no outcome".into(),
                    retryable: false,
                },
                retry_after_ms: None,
            },
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnInput {
    pub kind: TurnInputKind,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxMessage {
    pub id: MessageId,
    /// `user`, `captain:<agent>`, `agent:<agent>`, or `system`.
    pub from: String,
    pub text: String,
    #[serde(default)]
    pub interrupt: bool,
    pub ts_ms: TimestampMs,
}

/// Everything the runner needs to answer `PreToolUse`, `PermissionRequest` and `Stop` locally.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCache {
    /// Monotonic; older updates are ignored.
    pub version: u64,
    pub rules: Vec<ToolRule>,
    /// Inbox mirror: undelivered messages the `Stop` hook returns as `decision: "block"`.
    pub inbox: Vec<InboxMessage>,
    /// Max consecutive `Stop`-hook continuations (loop guard).
    pub max_stop_continuations: u32,
}

/// First matching rule wins; no match ⇒ `ask` (escalate, returns `pending`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolRule {
    /// Claude Code permission-rule syntax, e.g. `mcp__nest__Bash`, `mcp__nest__Bash(git push *)`.
    pub pattern: String,
    pub decision: RuleDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum RuleDecision {
    Allow,
    Deny,
    Ask,
}

/// Result of a platform tool call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ToolOutcome {
    Ok { content: Vec<ToolContent> },
    Error { error: ErrorBody },
    /// Needs a human/captain beyond the ~2 min synchronous window. The model is told the
    /// question is posted and the turn should end; the answer arrives as a
    /// `TurnInputKind::AskAnswer` turn.
    Pending { ask: AskId, message: String },
}

/// MCP-compatible content blocks.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Text { text: String },
    Image { media_type: String, data_b64: String },
    Json { value: serde_json::Value },
}

/// Platform tool definition (MCP `tools/list` entry + nest metadata). The canonical list lives
/// in `protocol/schemas/control/platform-tools.json`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
    /// Roles the tool is offered to.
    pub roles: Vec<AgentRole>,
    /// Always routed through the approval gate.
    #[serde(default)]
    pub requires_approval: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn fixtures(dir: &str) -> Vec<(String, serde_json::Value)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/control").join(dir);
        let mut out = vec![];
        for e in std::fs::read_dir(&root).unwrap_or_else(|e| panic!("{}: {e}", root.display())) {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "json") {
                let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap())
                    .unwrap_or_else(|e| panic!("{}: {e}", p.display()));
                out.push((p.file_stem().unwrap().to_string_lossy().into_owned(), v));
            }
        }
        assert!(!out.is_empty(), "no fixtures in {}", root.display());
        out
    }

    /// Round-trip every fixture in `dir` through `T`, and check that the fixture names (== the
    /// variant tag) cover exactly `expected`.
    fn roundtrip<T: serde::de::DeserializeOwned + Serialize>(dir: &str, expected: &[&str], tag: impl Fn(&T) -> &'static str) {
        let mut seen = BTreeSet::new();
        for (name, v) in fixtures(dir) {
            let t: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{dir}/{name}: {e}"));
            assert_eq!(serde_json::to_value(&t).unwrap(), v, "{dir}/{name} did not round-trip");
            let variant = tag(&t);
            assert!(name == variant || name.starts_with(&format!("{variant}.")), "{dir}/{name} is a `{variant}`");
            seen.insert(variant);
        }
        let expected: BTreeSet<_> = expected.iter().copied().collect();
        assert_eq!(seen, expected, "{dir}: fixture coverage mismatch");
    }

    fn host_to_fleet(m: &HostToFleet) -> &'static str {
        match m {
            HostToFleet::Hello(_) => "hello",
            HostToFleet::Heartbeat { .. } => "heartbeat",
            HostToFleet::Events { .. } => "events",
            HostToFleet::Ack { .. } => "ack",
            HostToFleet::CaRenew { .. } => "ca_renew",
        }
    }
    const HOST_TO_FLEET: &[&str] = &["hello", "heartbeat", "events", "ack", "ca_renew"];

    fn fleet_to_host(m: &FleetToHost) -> &'static str {
        match m {
            FleetToHost::HelloAck(_) => "hello_ack",
            FleetToHost::HeartbeatAck { .. } => "heartbeat_ack",
            FleetToHost::Commands { .. } => "commands",
            FleetToHost::Ack { .. } => "ack",
            FleetToHost::HostToken { .. } => "host_token",
            FleetToHost::BindingKey { .. } => "binding_key",
            FleetToHost::ProxyCa(_) => "proxy_ca",
            FleetToHost::Error { .. } => "error",
        }
    }
    const FLEET_TO_HOST: &[&str] =
        &["hello_ack", "heartbeat_ack", "commands", "ack", "host_token", "binding_key", "proxy_ca", "error"];

    fn command(c: &Command) -> &'static str {
        match &c.body {
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
    const COMMANDS: &[&str] = &[
        "sandbox_create", "sandbox_suspend", "sandbox_resume", "sandbox_archive", "sandbox_checkpoint",
        "sandbox_fork", "sandbox_destroy", "policy_update", "secrets_update", "port_expose", "port_unexpose",
        "commit_result", "guest_cli_result", "agent_start", "agent_attach", "agent_detach", "agent_stop", "fence",
        "drain",
    ];

    fn host_event(e: &HostEvent) -> &'static str {
        match &e.body {
            HostEventBody::CommandResult { .. } => "command_result",
            HostEventBody::SandboxState { .. } => "sandbox_state",
            HostEventBody::CommitRequest { .. } => "commit_request",
            HostEventBody::Workstream { .. } => "workstream",
            HostEventBody::EgressAudit { .. } => "egress_audit",
            HostEventBody::Capacity { .. } => "capacity",
            HostEventBody::TunnelState { .. } => "tunnel_state",
            HostEventBody::SpotNotice { .. } => "spot_notice",
            HostEventBody::AgentExited { .. } => "agent_exited",
            HostEventBody::GuestCli { .. } => "guest_cli",
            HostEventBody::TaskExited { .. } => "task_exited",
            HostEventBody::IncarnationRetired { .. } => "incarnation_retired",
        }
    }
    const HOST_EVENTS: &[&str] = &[
        "command_result", "sandbox_state", "commit_request", "workstream", "egress_audit", "capacity",
        "tunnel_state",
        "spot_notice", "agent_exited", "guest_cli", "task_exited", "incarnation_retired",
    ];

    fn runner_to_agent(m: &RunnerToAgent) -> &'static str {
        match m {
            RunnerToAgent::Hello(_) => "hello",
            RunnerToAgent::Segment { .. } => "segment",
            RunnerToAgent::Events { .. } => "events",
            RunnerToAgent::ToolCall(_) => "tool_call",
            RunnerToAgent::ToolsListRequest { .. } => "tools_list_request",
            RunnerToAgent::HandsResolve { .. } => "hands_resolve",
            RunnerToAgent::CancelCall { .. } => "cancel_call",
            RunnerToAgent::Ack { .. } => "ack",
        }
    }
    const RUNNER_TO_AGENT: &[&str] =
        &["hello", "segment", "events", "tool_call", "tools_list_request", "hands_resolve", "cancel_call", "ack"];

    fn agent_to_runner(m: &AgentToRunner) -> &'static str {
        match m {
            AgentToRunner::HelloAck { .. } => "hello_ack",
            AgentToRunner::SegmentAck { .. } => "segment_ack",
            AgentToRunner::RunTurn { .. } => "run_turn",
            AgentToRunner::Inbox { .. } => "inbox",
            AgentToRunner::Interrupt { .. } => "interrupt",
            AgentToRunner::CacheUpdate { .. } => "cache_update",
            AgentToRunner::ToolResult { .. } => "tool_result",
            AgentToRunner::ToolsList { .. } => "tools_list",
            AgentToRunner::HandsResolved { .. } => "hands_resolved",
            AgentToRunner::Ack { .. } => "ack",
            AgentToRunner::Error { .. } => "error",
        }
    }
    const AGENT_TO_RUNNER: &[&str] = &[
        "hello_ack", "segment_ack", "run_turn", "inbox", "interrupt", "cache_update", "tool_result",
        "tools_list", "hands_resolved", "ack", "error",
    ];

    fn agent_event(e: &crate::model::AgentEvent) -> &'static str {
        use crate::model::AgentEventBody::*;
        match &e.body {
            TurnStarted { .. } => "turn_started",
            AssistantText { .. } => "assistant_text",
            ToolCall { .. } => "tool_call",
            ToolResult { .. } => "tool_result",
            TurnCompleted { .. } => "turn_completed",
            RateLimited { .. } => "rate_limited",
            Error { .. } => "error",
            Usage { .. } => "usage",
            StateChanged { .. } => "state_changed",
            Escalation { .. } => "escalation",
            Capabilities { .. } => "capabilities",
            InboxDelivered { .. } => "inbox_delivered",
            TaskExited { .. } => "task_exited",
        }
    }
    const AGENT_EVENTS: &[&str] = &[
        "turn_started", "assistant_text", "tool_call", "tool_result", "turn_completed", "rate_limited",
        "error", "usage", "state_changed", "escalation", "capabilities", "task_exited", "inbox_delivered",
    ];

    fn workstream_event(e: &crate::model::WorkstreamEvent) -> &'static str {
        use crate::model::WorkstreamEventKind::*;
        match &e.kind {
            Started { .. } => "started",
            Progress { .. } => "progress",
            NeedsInput { .. } => "needs_input",
            Blocked { .. } => "blocked",
            PrOpened { .. } => "pr_opened",
            Completed { .. } => "completed",
            Failed { .. } => "failed",
            BudgetExceeded { .. } => "budget_exceeded",
            QuotaParked { .. } => "quota_parked",
            OrphanedWork { .. } => "orphaned_work",
            EgressDenied { .. } => "egress_denied",
            EgressAlert { .. } => "egress_alert",
            PortOpened { .. } => "port_opened",
            PortExposed { .. } => "port_exposed",
        }
    }
    const WORKSTREAM_EVENTS: &[&str] = &[
        "started", "progress", "needs_input", "blocked", "pr_opened", "completed", "failed",
        "budget_exceeded", "quota_parked", "orphaned_work", "egress_denied", "egress_alert",
        "port_opened", "port_exposed",
    ];

    fn proof(p: &EnrollRequest) -> &'static str {
        match p.proof {
            EnrollmentProof::AwsIdentityDocument { .. } => "aws_identity_document",
            EnrollmentProof::EnrollmentToken { .. } => "enrollment_token",
        }
    }

    #[test]
    fn fleet_channel_fixtures() {
        roundtrip::<HostToFleet>("host_to_fleet", HOST_TO_FLEET, host_to_fleet);
        roundtrip::<FleetToHost>("fleet_to_host", FLEET_TO_HOST, fleet_to_host);
        roundtrip::<Command>("command", COMMANDS, command);
        roundtrip::<HostEvent>("host_event", HOST_EVENTS, host_event);
    }

    #[test]
    fn session_channel_fixtures() {
        roundtrip::<RunnerToAgent>("runner_to_agent", RUNNER_TO_AGENT, runner_to_agent);
        roundtrip::<AgentToRunner>("agent_to_runner", AGENT_TO_RUNNER, agent_to_runner);
    }

    #[test]
    fn model_fixtures() {
        roundtrip::<crate::model::AgentEvent>("agent_event", AGENT_EVENTS, agent_event);
        roundtrip::<crate::model::WorkstreamEvent>("workstream_event", WORKSTREAM_EVENTS, workstream_event);
        roundtrip::<EnrollRequest>("enroll_request", &["aws_identity_document", "enrollment_token"], proof);
        roundtrip::<EnrollResponse>("enroll_response", &["enroll_response"], |_| "enroll_response");
        roundtrip::<crate::model::EgressPolicy>("egress_policy", &["egress_policy"], |_| "egress_policy");
        roundtrip::<crate::model::GenerationRecord>("generation_record", &["generation_record"], |_| "generation_record");
        roundtrip::<crate::model::Manifest>("manifest", &["manifest"], |_| "manifest");
    }

    #[test]
    fn platform_tools_schema() {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/schemas/control/platform-tools.json");
        let tools: Vec<ToolDef> = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        let mut names = BTreeSet::new();
        for t in &tools {
            assert!(names.insert(t.name.as_str()), "duplicate tool {}", t.name);
            assert_eq!(t.input_schema["type"], "object", "{}: input_schema must be an object schema", t.name);
            assert_eq!(t.input_schema["additionalProperties"], false, "{}: additionalProperties must be false", t.name);
            assert!(!t.roles.is_empty(), "{}: no roles", t.name);
        }
        for required in [
            "notify", "emit", "ask", "spawn_agent", "fork_sandbox", "attach", "read_transcript", "checkpoint",
            "expose_port", "brokered", "spawn_workstream", "send", "list_workstreams", "get_status", "wait_events",
            "approve", "deny", "merge", "kill", "delegate", "memory_read", "memory_write", "notify_user",
        ] {
            assert!(names.contains(required), "missing platform tool {required}");
        }
    }

    fn fixture_json<T: serde::de::DeserializeOwned>(rel: &str) -> T {
        let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures").join(rel);
        serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
    }

    fn hands_outcome(m: AgentToRunner) -> HandsOutcome {
        match m {
            AgentToRunner::HandsResolved { outcome, hands, error, retry_after_ms, .. } => {
                HandsOutcome::from_wire(outcome, hands, error, retry_after_ms)
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn hands_resolved_reads_the_outcome_and_the_previous_shape() {
        let ok = hands_outcome(fixture_json("control/agent_to_runner/hands_resolved.json"));
        let legacy = hands_outcome(fixture_json("control/agent_to_runner/hands_resolved.legacy.json"));
        let dual = hands_outcome(fixture_json("control/agent_to_runner/hands_resolved.dual.json"));
        let target = |o: &HandsOutcome| match o {
            HandsOutcome::Ok { hands } => hands.binding.clone(),
            other => panic!("{other:?}"),
        };
        assert_eq!(target(&ok), target(&legacy));
        assert_eq!(target(&dual), target(&ok));

        let not_ready = hands_outcome(fixture_json("control/agent_to_runner/hands_resolved.not_ready.json"));
        let legacy_not_ready = hands_outcome(fixture_json("control/agent_to_runner/hands_resolved.legacy_not_ready.json"));
        assert_eq!(not_ready, legacy_not_ready, "retry_after_ms moved into the error arm");
        assert!(matches!(&not_ready, HandsOutcome::Error { error, retry_after_ms: Some(2000) } if error.code == "sandbox_not_ready"));

        // `outcome` wins over the old fields; nothing at all is an invalid message.
        let e = ErrorBody { code: "not_bound".into(), message: "m".into(), retryable: false };
        let o = HandsOutcome::Error { error: e.clone(), retry_after_ms: None };
        let t: crate::gateway::HandsTarget = fixture_json("gateway/hands_target/hands_target.json");
        assert_eq!(HandsOutcome::from_wire(Some(Box::new(o.clone())), Some(t), None, None), o);
        assert!(matches!(
            HandsOutcome::from_wire(None, None, None, None),
            HandsOutcome::Error { error, .. } if error.code == crate::model::error_codes::INVALID_MESSAGE
        ));
    }

    #[test]
    fn agent_start_epoch_falls_back_to_the_previous_releases_hands_epoch() {
        let start = |rel: &str| match fixture_json::<Command>(rel).body {
            CommandBody::AgentStart(s) => s,
            other => panic!("{other:?}"),
        };
        assert_eq!(start("control/command/agent_start.json").agent_epoch(), Epoch(5));
        assert_eq!(start("control/command/agent_start.captain.json").agent_epoch(), Epoch(2));
        // A command queued by the previous release: its session epoch was `hands.epoch`.
        assert_eq!(start("control/command/agent_start.legacy.json").agent_epoch(), Epoch(4));
        // `epoch` wins over the copy this release still sends in `hands.epoch`.
        let mut s = start("control/command/agent_start.json");
        s.hands.as_mut().unwrap().epoch = Some(Epoch(9));
        assert_eq!(s.agent_epoch(), Epoch(5));
    }

    #[test]
    fn lease_timing_defaults() {
        let t = LeaseTiming::default();
        assert!(t.heartbeat_ms * 3 < t.host_fence_ms && t.host_fence_ms < t.cp_expiry_ms);
    }
}
