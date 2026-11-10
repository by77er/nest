//! Shared data models. Core identifiers are fixed here; the rest of this module (events, policy,
//! generations) is owned by docs/interfaces/control-host/.

use serde::{Deserialize, Serialize};

macro_rules! id_type {
    ($name:ident, $prefix:literal) => {
        #[doc = concat!("Opaque identifier, rendered as `", $prefix, "<suffix>`.")]
        ///
        /// Deserializing checks the prefix (the same check the control plane's schemas make), so a
        /// malformed id from an untrusted sender (a guest, a program in a sandbox) fails where it
        /// is parsed instead of travelling on to reject a whole batch somewhere else.
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub const PREFIX: &'static str = $prefix;

            /// Whether the id carries its kind's prefix: what deserializing enforces. Values built
            /// in code with the tuple constructor are not checked.
            pub fn is_valid(&self) -> bool {
                self.0.starts_with(Self::PREFIX)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = String::deserialize(d)?;
                if s.starts_with($prefix) {
                    Ok(Self(s))
                } else {
                    // Not echoed: the value comes from an untrusted sender and may be large.
                    Err(serde::de::Error::custom(concat!("expected an id starting with `", $prefix, "`")))
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

id_type!(HostId, "hst_");
id_type!(SandboxId, "sbx_");
id_type!(AgentId, "agt_");
// Compat, one release back: hosts and runners of the previous release require a `ws_` value in
// `sandbox_create`, `sandbox_fork` and `agent_start`. Workstreams left the platform; nothing reads it.
id_type!(WorkstreamId, "ws_");
id_type!(GenerationId, "gen_");
id_type!(SessionId, "ses_");

/// Fencing token: incremented every time a sandbox lease is granted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Epoch(pub u64);

/// Monotonic per-source sequence number used for at-least-once delivery and dedup.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Seq(pub u64);

/// Milliseconds since the Unix epoch, UTC.
pub type TimestampMs = i64;

/// A secret value (credential, private key). Serialized as a plain string; `Debug` is redacted.
/// Secrets are held in memory only and never logged.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Secret(pub String);

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl Secret {
    /// The plaintext value. Call only where the secret is actually used.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl From<String> for Secret {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for Secret {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

/// Uniform error body used on every boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

// ---------------------------------------------------------------------------------------------
// Everything below is owned by docs/interfaces/control-host/ (shared models).
// ---------------------------------------------------------------------------------------------

id_type!(TurnId, "trn_");
id_type!(CallId, "cal_");
id_type!(CommandId, "cmd_");
id_type!(RequestId, "req_");
id_type!(AskId, "ask_");
id_type!(MessageId, "msg_");

/// Protocol version spoken on every control-host channel. Bumped on incompatible changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Well-known `ErrorBody::code` values shared by every boundary. [`ALL`](error_codes::ALL) is
/// the list; `protocol/fixtures/codes.json` holds the same list and both mirrors assert against it.
pub mod error_codes {
    pub const STALE_EPOCH: &str = "stale_epoch";
    pub const PARENT_MISMATCH: &str = "parent_mismatch";
    pub const UNKNOWN_SANDBOX: &str = "unknown_sandbox";
    pub const UNKNOWN_AGENT: &str = "unknown_agent";
    pub const UNAUTHORIZED: &str = "unauthorized";
    pub const FORBIDDEN: &str = "forbidden";
    /// The peer speaks a protocol (or gateway, or claims-format) version this side doesn't. The
    /// same name on every boundary; read it with [`is_unsupported_version`], which also accepts
    /// [`LEGACY_UNSUPPORTED_VERSION`].
    pub const UNSUPPORTED_VERSION: &str = "unsupported_version";
    /// What the control-host channels sent for [`UNSUPPORTED_VERSION`] before the names were
    /// merged. Accepted on read only; never sent.
    pub const LEGACY_UNSUPPORTED_VERSION: &str = "unsupported_protocol_version";
    pub const INVALID_MESSAGE: &str = "invalid_message";
    pub const UNKNOWN_TOOL: &str = "unknown_tool";
    pub const CAPACITY_EXHAUSTED: &str = "capacity_exhausted";
    pub const RATE_LIMITED: &str = "rate_limited";
    pub const NOT_BOUND: &str = "not_bound";
    /// `hands_resolve` can't hand out a binding yet (unplaced, placing, waking, or the agent's
    /// slot isn't configured): ask again after `retry_after_ms`.
    pub const SANDBOX_NOT_READY: &str = "sandbox_not_ready";
    pub const INTERNAL: &str = "internal";
    /// The operation exists in the contract but has no implementation yet. Hosts and nest-mcp
    /// pass it through as an ordinary tool error.
    pub const NOT_IMPLEMENTED: &str = "not_implemented";
    /// The caller gave up waiting (e.g. a platform tool call that timed out in the runner): the
    /// operation may or may not have taken effect. Not retryable under the same call id.
    pub const OUTCOME_UNKNOWN: &str = "outcome_unknown";
    /// A compare-and-set lost: the state it was conditioned on changed.
    /// The caller reads the current state and decides again. HTTP 409.
    pub const CONFLICT: &str = "conflict";
    /// The named object doesn't exist. Passed through as an ordinary tool error.
    pub const NOT_FOUND: &str = "not_found";
    /// A remote (MCP) tool ran and reported an error (`isError`); the message is its text. Passed
    /// through as an ordinary tool error.
    pub const TOOL_ERROR: &str = "tool_error";
    /// Refused because the agent is working now (a restart asked for only when idle, while a turn
    /// runs or is queued): ask again later. HTTP 409.
    pub const BUSY: &str = "busy";

    /// Every code above that is sent (the legacy alias is not).
    pub const ALL: &[&str] = &[
        STALE_EPOCH, PARENT_MISMATCH, UNKNOWN_SANDBOX, UNKNOWN_AGENT, UNAUTHORIZED, FORBIDDEN,
        UNSUPPORTED_VERSION, INVALID_MESSAGE, UNKNOWN_TOOL, CAPACITY_EXHAUSTED, RATE_LIMITED, NOT_BOUND,
        SANDBOX_NOT_READY, INTERNAL, NOT_IMPLEMENTED, OUTCOME_UNKNOWN, CONFLICT, NOT_FOUND, TOOL_ERROR, BUSY,
    ];

    /// `unsupported_version` under either name.
    pub fn is_unsupported_version(code: &str) -> bool {
        code == UNSUPPORTED_VERSION || code == LEGACY_UNSUPPORTED_VERSION
    }
}

/// What a host is for: it runs sandboxes or brains, never both. See docs/compute/.
///
/// Renamed by expand/contract over two releases (dev/deploy.md): this release reads `sandbox` and
/// `brain` but still writes the previous release's names, `burst` and `controller`, so a control
/// plane rolled back to the previous release accepts every host of this one; the next release
/// writes the new names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum HostRole {
    /// Runs sandboxes (Firecracker, the gateway, nest-proxy, the tunnel); never a brain.
    #[serde(rename = "burst", alias = "sandbox")]
    Sandbox,
    /// Runs brains (the agent runner and Claude Code); never a sandbox.
    #[serde(rename = "controller", alias = "brain")]
    Brain,
}

/// Deprecated wire value, for one release only ([`crate::control::AgentStart::role`],
/// [`crate::control::ToolDef::roles`]): nothing decides on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    /// Brain with hands bound to a sandbox.
    Worker,
    /// Brain with no hands; platform tools only.
    Captain,
}

/// VM sizing. Hugepage-backed memory cannot grow after boot: size for the expected agents.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resources {
    pub vcpus: u32,
    pub memory_mib: u32,
    pub disk_gib: u32,
}

// --- Sandbox and agent state ------------------------------------------------------------------

/// Sandbox lifecycle (docs/sandbox/). Reported by hosts; SandboxDO holds the authoritative copy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum SandboxState {
    Creating,
    Restoring,
    Running,
    Suspending,
    /// Stopped on a host; disk (and, for `SuspendMode::Memory`, memory) kept locally.
    Suspended,
    Archiving,
    /// Only in object storage; restorable on any host in the cell.
    Archived,
    /// Lease lost; VM paused, netns and listeners dropped. Terminal for this epoch.
    Fenced,
    Destroyed,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum SuspendMode {
    /// Full hugepage memory snapshot + disk: resumes with processes intact.
    Memory,
    /// Disk only: resume is a cold boot (+ `claude --resume` on the brain side).
    DiskOnly,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum ForkMode {
    /// Child head = parent's freshly committed disk manifest; child cold-boots.
    DiskOnly,
    /// Parent paused for a full memory snapshot; child restores processes too.
    Live,
}

/// Agent state machine (docs/agents/state-tracking/).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    Starting,
    Ready,
    Working,
    WaitingPermission,
    WaitingInput,
    Compacting,
    Idle,
    Errored,
    QuotaParked,
    Stalled,
    NeedsAttention,
    Detached,
}

// --- Egress policy ------------------------------------------------------------------------------

/// Host pattern: an exact hostname (`github.com`) or a wildcard suffix (`*.githubusercontent.com`,
/// which matches subdomains but not the apex). Case-insensitive; a trailing dot is ignored.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct HostPattern(pub String);

impl HostPattern {
    pub fn matches(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let pat = self.0.trim_end_matches('.').to_ascii_lowercase();
        match pat.strip_prefix("*.") {
            Some(suffix) => host.len() > suffix.len() + 1 && host.ends_with(&format!(".{suffix}")),
            None => host == pat,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum PolicyLayer {
    /// Image defaults (package registries, GitHub, distro mirrors).
    Base,
    /// The operator's own layer for the sandbox (allow rules, passthrough, injection, repos). Its
    /// wire name is `workstream` (historical: the layer was once set per workstream); a rename is
    /// two releases of expand/contract, not worth it for a label.
    Workstream,
    /// Temporary per-sandbox grants (the operator's, or `egress_policy` widening).
    Sandbox,
}

fn default_web_ports() -> Vec<u16> {
    vec![80, 443]
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AllowRule {
    pub host: HostPattern,
    #[serde(default = "default_web_ports")]
    pub ports: Vec<u16>,
    pub layer: PolicyLayer,
    /// Temporary grant: ignored once `now_ms >= expires_ms`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<TimestampMs>,
}

impl AllowRule {
    /// Whether the rule is in force at `now_ms`: a temporary grant is ignored once it expires.
    pub fn active(&self, now_ms: TimestampMs) -> bool {
        self.expires_ms.is_none_or(|e| now_ms < e)
    }
}

/// Where in a request nest-proxy looks for (and replaces) a binding's placeholder.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InjectionLocation {
    /// `Authorization: Bearer <placeholder>` (also `token <placeholder>`).
    AuthorizationBearer,
    /// `Authorization: Basic base64(user:<placeholder>)`; git's credential helper uses this.
    AuthorizationBasicPassword,
    /// Any named header whose value equals or contains the placeholder.
    Header { name: String },
}

/// A credential the proxy substitutes on inspected traffic. The secret value is delivered
/// separately (`InjectionSecret`) and never appears in policy documents or audit logs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InjectionBinding {
    pub name: String,
    pub hosts: Vec<HostPattern>,
    /// Unique per binding, e.g. `nest-ph-github-7f3a`. Seen by the sandbox; worthless outside.
    pub placeholder: String,
    pub locations: Vec<InjectionLocation>,
}

/// Secret value for an `InjectionBinding`, held only in nest-proxy memory. `Debug` redacts
/// `value`, so logging a command that carries secrets never leaks them.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InjectionSecret {
    pub binding: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_ms: Option<TimestampMs>,
}

impl std::fmt::Debug for InjectionSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InjectionSecret")
            .field("binding", &self.binding)
            .field("value", &"<redacted>")
            .field("expires_ms", &self.expires_ms)
            .finish()
    }
}

/// Raw TCP egress exception: its own listener port in the netns, connected only to IPs the
/// proxy's resolver returned for `host`. Bytes are spliced uninspected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TcpException {
    pub host: String,
    pub port: u16,
}

impl TcpException {
    /// Whether this exception names `host` (case-insensitive; a trailing dot is ignored).
    pub fn is_for(&self, host: &str) -> bool {
        self.host.trim_end_matches('.').eq_ignore_ascii_case(host.trim_end_matches('.'))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressLimits {
    pub max_connections: u32,
    pub bandwidth_mbps: u32,
    pub max_inspected_body_bytes: u64,
}

/// A request guard (docs/sandbox/networking/egress/policy/#request-guards): on its hosts, a request
/// that any `scope` matcher covers is refused unless an `allow` matcher covers it too. Generic: the
/// proxy knows hosts, methods, paths, queries, a JSON body field and whether a binding was
/// substituted, nothing about the services behind them. Guards only take away: every guard in the
/// policy must let a request through.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestGuard {
    /// Shown in the 403 and audited as reason `guard: <name>`.
    pub name: String,
    /// Hosts it applies to. A guarded host is always inspected: never spliced, never a TCP exception.
    pub hosts: Vec<HostPattern>,
    pub scope: Vec<RequestMatch>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allow: Vec<RequestMatch>,
    /// Human-readable reason for the 403.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reason: String,
    /// Path literals and query names and values compare without ASCII case.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub ignore_case: bool,
}

/// One request matcher: every field given must match (an empty one matches anything).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RequestMatch {
    /// Any of these methods (compared without case).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods: Vec<String>,
    /// Any method but these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub methods_except: Vec<String>,
    /// A path pattern: `/`-separated segments, each a literal, `*` (one segment) or `**` (any number).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Query parameters, all of which must match.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub query: Vec<QueryMatch>,
    /// A field of a JSON request body.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_json: Option<JsonFieldMatch>,
    /// The request had this binding's credential substituted by the proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub injected: Option<String>,
}

/// A query parameter `name` (decoded) whose decoded value is one of `values` (any value when empty).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryMatch {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<String>,
}

/// The JSON body's string at `pointer` (RFC 6901) is one of `values`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonFieldMatch {
    pub pointer: String,
    pub values: Vec<String>,
}

/// Effective egress policy for one sandbox, merged from all layers by SandboxDO. `version`
/// increases monotonically per sandbox; consumers ignore pushes with a version they've seen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EgressPolicy {
    pub version: u64,
    pub allow: Vec<AllowRule>,
    /// Allowed hosts spliced without TLS termination (pinned clients). No injection possible.
    #[serde(default)]
    pub passthrough: Vec<HostPattern>,
    #[serde(default)]
    pub inject: Vec<InjectionBinding>,
    #[serde(default)]
    pub tcp: Vec<TcpException>,
    pub limits: EgressLimits,
    /// Request guards, evaluated by nest-proxy on every inspected or plaintext request.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guards: Vec<RequestGuard>,
}

/// Outcome of evaluating `EgressPolicy` for one HTTP(S) destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EgressDecision {
    Deny,
    /// Allowed, spliced without decryption.
    Passthrough,
    /// Allowed, TLS terminated, injection + inspection applied.
    Inspect,
}

impl EgressPolicy {
    /// Decide an HTTP(S) destination. TCP exceptions are matched by listener, not here.
    pub fn decide(&self, host: &str, port: u16, now_ms: TimestampMs) -> EgressDecision {
        let allowed = self.allow.iter().any(|r| r.host.matches(host) && r.ports.contains(&port) && r.active(now_ms));
        if !allowed {
            EgressDecision::Deny
        } else if !self.guarded(host) && self.passthrough.iter().any(|p| p.matches(host)) {
            EgressDecision::Passthrough
        } else {
            EgressDecision::Inspect
        }
    }

    /// Whether the proxy's DNS answers `name` for this sandbox: an active allow rule or a TCP
    /// exception names it.
    pub fn resolves(&self, name: &str, now_ms: TimestampMs) -> bool {
        self.allow.iter().any(|r| r.host.matches(name) && r.active(now_ms)) || self.tcp.iter().any(|t| t.is_for(name))
    }

    /// Whether a TCP exception allows raw TCP to `host:port`.
    pub fn tcp_exception(&self, host: &str, port: u16) -> bool {
        !self.guarded(host) && self.tcp.iter().any(|t| t.is_for(host) && t.port == port)
    }

    /// Whether a request guard names `host`: its traffic must be inspected, so it is never spliced
    /// (passthrough) and never a raw TCP exception, whatever the other layers say.
    pub fn guarded(&self, host: &str) -> bool {
        self.guards.iter().any(|g| g.hosts.iter().any(|h| h.matches(host)))
    }
}

// --- Canonical agent events ---------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum TurnInputKind {
    /// Me (Discord, UI, CLI).
    User,
    /// No longer sent (it carried workstream event batches, which left the platform); kept so a
    /// turn a control plane of the previous release queued still parses.
    EventBatch,
    /// Messages queued in the agent's inbox.
    Inbox,
    /// The operator's decision on an approval (or an answer to a question asked before the `ask`
    /// tool left) that returned `pending`.
    AskAnswer,
    /// Continuation after a crash/move ("you were interrupted, here's what happened since").
    Recovery,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    /// Claude Code's client-side estimate; informational only on a subscription.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd_estimate: Option<f64>,
}

/// One canonical agent event. Produced by the agent runner (stream-json + hooks) or by the
/// api-loop captain backend; consumed by AgentDO, state tracking, Discord, the scheduler.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentEvent {
    pub agent: AgentId,
    pub epoch: Epoch,
    /// Per-agent monotonic; AgentDO dedups on it and rebuilds state from the session on a gap.
    pub seq: Seq,
    pub ts_ms: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<TurnId>,
    #[serde(flatten)]
    pub body: AgentEventBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEventBody {
    TurnStarted { input_kind: TurnInputKind },
    AssistantText { text: String },
    /// `call_id` is Claude Code's `tool_use` id.
    ToolCall { call_id: String, name: String, input: serde_json::Value },
    ToolResult {
        call_id: String,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    TurnCompleted {
        stop_reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        usage: Option<Usage>,
    },
    RateLimited {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        retry_after_ms: Option<u64>,
        detail: String,
    },
    Error { error: ErrorBody },
    Usage { usage: Usage },
    StateChanged {
        state: AgentState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// A `PreToolUse` call matched no grant rule and was escalated: the runner denied it with
    /// "pending approval (request `call`)". AgentDO treats it like an `ask` to the captain or
    /// user; the answer arrives as the agent's next turn input.
    Escalation { call: CallId, tool: String, input: serde_json::Value },
    /// Claude Code capabilities (`system/init.capabilities`), reported whenever they become known
    /// (init may arrive only after the first user message).
    Capabilities { capabilities: Vec<String> },
    /// A background task started by a hands `Bash` call exited (relayed guest → nestd → FleetDO).
    TaskExited { task: crate::guest::TaskInfo },
    /// An inbox message reached the model (written to stdin mid-turn, or returned by the `Stop`
    /// hook). AgentDO removes it from the inbox mirror so a restarted brain doesn't see it again.
    InboxDelivered { message: MessageId },
}

// --- Sandbox events ----------------------------------------------------------------------------

/// Something a host saw about a sandbox it holds (a port opened, egress denied, an egress alert),
/// sent as `HostEventBody::SandboxEvent`. The control plane logs it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SandboxEvent {
    /// Compat, one release back: the `ws_` value the control plane sent in `sandbox_create`, echoed
    /// because a control plane of the previous release requires it. Workstreams left the platform;
    /// nothing reads it. Absent once the control plane stops sending one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workstream: Option<WorkstreamId>,
    pub ts_ms: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<Epoch>,
    #[serde(flatten)]
    pub kind: SandboxEventKind,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SandboxEventKind {
    EgressDenied { host: String, port: u16 },
    /// A binding's placeholder was sent to a host outside the binding: likely exfiltration.
    EgressAlert {
        host: String,
        /// Injection binding involved, when there is one (absent for e.g. domain fronting).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding: Option<String>,
        reason: EgressAlertReason,
    },
    PortOpened { port: u16 },
}

/// Why nest-proxy raised an egress alert (`SandboxEventKind::EgressAlert.reason`): nest-proxy's
/// `host::proxy::AlertKind`, plus a catch-all. Open: a member this build doesn't know (a newer
/// sender, or free text from an older one) parses as `unknown` instead of failing the event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum EgressAlertReason {
    PlaceholderWrongHost,
    DomainFronting,
    InjectionAfterExpiry,
    /// Deserialize-only fallback; never sent by this build.
    #[serde(other)]
    Unknown,
}

impl From<crate::host::proxy::AlertKind> for EgressAlertReason {
    fn from(k: crate::host::proxy::AlertKind) -> Self {
        use crate::host::proxy::AlertKind;
        match k {
            AlertKind::PlaceholderWrongHost => Self::PlaceholderWrongHost,
            AlertKind::DomainFronting => Self::DomainFronting,
            AlertKind::InjectionAfterExpiry => Self::InjectionAfterExpiry,
        }
    }
}

// --- Generations ----------------------------------------------------------------------------------

/// `blake3:<64 hex>` of a manifest object in the cell's object store.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ManifestHash(pub String);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum GenerationKind {
    /// Disk only. Head of this kind ⇒ restore is a cold boot.
    DiskOnly,
    /// Disk + memory taken at the same instant. Valid for memory restore only while it is head.
    Checkpoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum CommitReason {
    TurnEnd,
    Timer,
    DirtyThreshold,
    Suspend,
    Drain,
    SpotNotice,
    Checkpoint,
    Fork,
    /// Uncommitted work from a fenced host, committed as a sibling branch.
    Salvage,
    /// Final commit before `sandbox_archive` evicts local state.
    Archive,
}

/// Immutable generation record; SandboxDO stores the chain and the head.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GenerationRecord {
    pub id: GenerationId,
    pub sandbox: SandboxId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<GenerationId>,
    pub epoch: Epoch,
    pub kind: GenerationKind,
    pub disk_manifest: ManifestHash,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mem_manifest: Option<ManifestHash>,
    pub reason: CommitReason,
    pub created_ms: TimestampMs,
    /// When its disk was cut, from the commit request (`cut_ms`); absent for a disk read in place.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut_ms: Option<TimestampMs>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum ManifestKind {
    /// 4 MiB chunks of a ublk volume.
    Disk,
    /// 2 MiB chunks (one hugepage each) of guest memory.
    Memory,
}

/// Content-addressed manifest object stored at `<cell>/manifests/<blake3>`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    pub kind: ManifestKind,
    pub chunk_size: u32,
    pub size_bytes: u64,
    /// One entry per chunk: `blake3:<hex>` stored at `<cell>/chunks/<hex>`, or `null` for an
    /// all-zero chunk (never stored).
    pub chunks: Vec<Option<String>>,
    /// Chunk indices touched during the previous run, prefetched first on restore.
    #[serde(default)]
    pub prefetch: Vec<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_pattern_matching() {
        let w = HostPattern("*.githubusercontent.com".into());
        assert!(w.matches("raw.githubusercontent.com"));
        assert!(w.matches("RAW.githubusercontent.com."));
        assert!(!w.matches("githubusercontent.com"));
        assert!(!w.matches("evilgithubusercontent.com"));
        let e = HostPattern("github.com".into());
        assert!(e.matches("github.com"));
        assert!(!e.matches("api.github.com"));
    }

    #[test]
    fn policy_decisions() {
        let p = EgressPolicy {
            version: 1,
            allow: vec![
                AllowRule { host: HostPattern("github.com".into()), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None },
                AllowRule { host: HostPattern("example.com".into()), ports: vec![443], layer: PolicyLayer::Sandbox, expires_ms: Some(1_000) },
                AllowRule { host: HostPattern("pinned.example.net".into()), ports: vec![443], layer: PolicyLayer::Workstream, expires_ms: None },
            ],
            passthrough: vec![HostPattern("pinned.example.net".into())],
            inject: vec![],
            tcp: vec![],
            limits: EgressLimits { max_connections: 256, bandwidth_mbps: 200, max_inspected_body_bytes: 512 << 20 },
            guards: vec![],
        };
        assert_eq!(p.decide("github.com", 443, 0), EgressDecision::Inspect);
        assert_eq!(p.decide("github.com", 80, 0), EgressDecision::Deny);
        assert_eq!(p.decide("example.com", 443, 999), EgressDecision::Inspect);
        assert_eq!(p.decide("example.com", 443, 1_000), EgressDecision::Deny);
        assert_eq!(p.decide("pinned.example.net", 443, 0), EgressDecision::Passthrough);
        assert_eq!(p.decide("evil.com", 443, 0), EgressDecision::Deny);
    }

    #[test]
    fn policy_resolves_names_and_tcp_exceptions() {
        let p = EgressPolicy {
            version: 1,
            allow: vec![
                AllowRule { host: HostPattern("*.githubusercontent.com".into()), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None },
                AllowRule { host: HostPattern("old.example".into()), ports: vec![443], layer: PolicyLayer::Sandbox, expires_ms: Some(10) },
            ],
            passthrough: vec![],
            inject: vec![],
            tcp: vec![TcpException { host: "DB.example.com.".into(), port: 5432 }],
            limits: EgressLimits { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 },
            guards: vec![],
        };
        for (name, now, resolves) in [
            ("raw.githubusercontent.com", 0, true),
            ("githubusercontent.com", 0, false),
            ("db.example.com", 0, true),
            ("old.example", 9, true),
            ("old.example", 10, false),
            ("evil.com", 0, false),
        ] {
            assert_eq!(p.resolves(name, now), resolves, "{name} at {now}");
        }
        assert!(p.tcp_exception("db.example.com", 5432));
        assert!(!p.tcp_exception("db.example.com", 5433));
        assert!(!p.tcp_exception("raw.githubusercontent.com", 443));
    }
}
