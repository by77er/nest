//! Host-internal boundaries. Spec: `docs/interfaces/host-internal/`.
//!
//! | Boundary | Transport | Module |
//! |---|---|---|
//! | nestd ↔ nest-proxy | unix `SOCK_SEQPACKET`, one JSON object per packet, listener fds via `SCM_RIGHTS` | [`proxy`], [`fdpass`] |
//! | nestd ↔ agent runner | unix `SOCK_STREAM`, length-prefixed JSON frames | [`runner`], [`frame`] |
//! | `nest hook` → runner (async tracking) | unix `SOCK_DGRAM`, one JSON object per datagram | [`hook`] |
//! | `nest hook` ↔ runner (sync decisions) | unix `SOCK_STREAM`, one request frame, one response frame | [`hook`], [`frame`] |
//! | `nest mcp` ↔ runner | unix `SOCK_STREAM`, length-prefixed JSON frames | [`mcp`], [`frame`] |
//! | runner ↔ Claude Code | CLI args, env, managed settings, stream-json on stdio | [`claude`] |
//!
//! Control-plane connections: **nestd** owns enrollment, the fleet channel, leases, fencing and
//! credentials. The **agent runner** owns one session channel per active agent
//! (`control::RunnerToAgent` / `control::AgentToRunner`, authenticated with the host token nestd
//! hands it in memory). **nest-proxy** never talks to the control plane.

use serde::{Deserialize, Serialize};

use crate::model::{AgentId, Epoch, ErrorBody, HostId, HostRole, SandboxId, SessionId, TimestampMs, WorkstreamId};

/// Version carried in every host-internal hello. Bumped on incompatible changes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Well-known socket and directory paths.
pub mod paths {
    /// Created by nestd: `root:nest 0750`.
    pub const RUN_DIR: &str = "/run/nest";
    /// nestd listens (`SOCK_SEQPACKET`, `0660 root:nest-proxy`); nest-proxy connects.
    pub const PROXY_SOCK: &str = "/run/nest/proxy.sock";
    /// nestd listens (`SOCK_STREAM`, `0660 root:nest-runner`); the agent runner connects.
    pub const RUNNER_SOCK: &str = "/run/nest/runner.sock";
    /// nestd listens (`SOCK_STREAM`, `0660 root:nest-gateway`); the sandbox gateway connects.
    pub const GATEWAY_SOCK: &str = "/run/nest/gateway.sock";
    /// Runner-owned directory for the hook and MCP sockets (`nest-runner:nest-agents 0750`).
    pub const RUNNER_DIR: &str = "/run/nest/runner";
    /// Runner binds (`SOCK_DGRAM`): async tracking hooks.
    pub const HOOK_DGRAM: &str = "/run/nest/runner/hook.dgram";
    /// Runner listens (`SOCK_STREAM`): synchronous hook decisions.
    pub const HOOK_SOCK: &str = "/run/nest/runner/hook.sock";
    /// Runner listens (`SOCK_STREAM`): `nest mcp` bridge.
    pub const MCP_SOCK: &str = "/run/nest/runner/mcp.sock";
    /// One `CLAUDE_CONFIG_DIR` per agent: `<AGENTS_DIR>/<agent_id>`.
    pub const AGENTS_DIR: &str = "/var/lib/nest/agents";
    /// Empty, read-only working directory for every Claude Code process.
    pub const EMPTY_CWD: &str = "/var/lib/nest/empty";
    /// Claude Code managed settings (Linux).
    pub const MANAGED_SETTINGS: &str = "/etc/claude-code/managed-settings.json";
    /// The `nest` binary (provides `nest hook` and `nest mcp`).
    pub const NEST_BIN: &str = "/usr/lib/nest/nest";
    /// Socket and binary locations handed to Claude Code (via env and the MCP config). The
    /// production values are the constants above; tests and dev runs override them.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RunnerSockets {
        pub hook_dgram: String,
        pub hook_sock: String,
        pub mcp_sock: String,
        pub nest_bin: String,
    }

    impl Default for RunnerSockets {
        fn default() -> Self {
            RunnerSockets {
                hook_dgram: HOOK_DGRAM.into(),
                hook_sock: HOOK_SOCK.into(),
                mcp_sock: MCP_SOCK.into(),
                nest_bin: NEST_BIN.into(),
            }
        }
    }
}

/// Environment variable names shared by the runner, `nest hook` and `nest mcp`.
pub mod env {
    pub const AGENT_ID: &str = "NEST_AGENT_ID";
    pub const HOOK_DGRAM: &str = "NEST_HOOK_DGRAM";
    pub const HOOK_SOCK: &str = "NEST_HOOK_SOCK";
    pub const MCP_SOCK: &str = "NEST_MCP_SOCK";
    /// Spool file used by `nest hook` when the datagram socket is unavailable.
    pub const HOOK_SPOOL: &str = "NEST_HOOK_SPOOL";
}

pub use crate::model::Secret;

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/// Length-prefixed JSON frames for `SOCK_STREAM` sockets: a 4-byte big-endian length followed by
/// that many bytes of UTF-8 JSON (one object). Compatible with `tokio_util::codec::LengthDelimitedCodec`
/// defaults (u32 BE length, header excluded from the length).
pub mod frame {
    use serde::{Serialize, de::DeserializeOwned};
    use std::io::{self, Read, Write};

    /// Largest accepted frame body (hands results with images are the largest messages).
    pub const MAX_FRAME: usize = 16 << 20;

    /// Serialize `msg` and prepend its length.
    pub fn encode<T: Serialize>(msg: &T) -> io::Result<Vec<u8>> {
        let body = serde_json::to_vec(msg).map_err(io::Error::other)?;
        if body.len() > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
        }
        let mut out = Vec::with_capacity(4 + body.len());
        out.extend_from_slice(&(body.len() as u32).to_be_bytes());
        out.extend_from_slice(&body);
        Ok(out)
    }

    pub fn write<W: Write, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
        w.write_all(&encode(msg)?)?;
        w.flush()
    }

    /// Read one frame. Returns `Ok(None)` on a clean EOF at a frame boundary.
    pub fn read<R: Read, T: DeserializeOwned>(r: &mut R) -> io::Result<Option<T>> {
        let mut len = [0u8; 4];
        match r.read_exact(&mut len) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        let len = u32::from_be_bytes(len) as usize;
        if len > MAX_FRAME {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        serde_json::from_slice(&body).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
    }
}

/// `SOCK_SEQPACKET` messages with attached file descriptors (nestd → nest-proxy listener handoff).
///
/// One packet = one UTF-8 JSON object, plus zero or more fds in a single `SCM_RIGHTS` control
/// message. The receiver must use `MSG_CMSG_CLOEXEC` and treat `MSG_TRUNC`/`MSG_CTRUNC` as a fatal
/// protocol error (close the connection; nestd resyncs on reconnect).
#[cfg(unix)]
pub mod fdpass {
    use nix::sys::socket::{ControlMessage, ControlMessageOwned, MsgFlags, recvmsg, sendmsg};
    use serde::{Serialize, de::DeserializeOwned};
    use std::io::{self, IoSlice, IoSliceMut};
    use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};

    /// Largest packet nestd sends to the proxy. nestd raises `SO_SNDBUF` with `SO_SNDBUFFORCE`
    /// to at least 2 × this.
    pub const MAX_PACKET_TO_PROXY: usize = 1 << 20;
    /// Largest packet the proxy sends to nestd (fits the default unprivileged `SO_SNDBUF`).
    pub const MAX_PACKET_FROM_PROXY: usize = 64 << 10;
    /// Upper bound on fds attached to one packet. Larger listener sets are split across packets.
    pub const MAX_FDS_PER_PACKET: usize = 32;

    /// Send one JSON packet with `fds` attached (in order).
    pub fn send<T: Serialize>(sock: BorrowedFd<'_>, msg: &T, fds: &[BorrowedFd<'_>]) -> io::Result<()> {
        if fds.len() > MAX_FDS_PER_PACKET {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "too many fds in one packet"));
        }
        let body = serde_json::to_vec(msg).map_err(io::Error::other)?;
        if body.len() > MAX_PACKET_TO_PROXY {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "packet too large"));
        }
        let raw: Vec<RawFd> = fds.iter().map(|f| f.as_raw_fd()).collect();
        let iov = [IoSlice::new(&body)];
        let cmsgs: Vec<ControlMessage<'_>> =
            if raw.is_empty() { Vec::new() } else { vec![ControlMessage::ScmRights(&raw)] };
        let sent = sendmsg::<()>(sock.as_raw_fd(), &iov, &cmsgs, MsgFlags::MSG_NOSIGNAL, None)
            .map_err(io::Error::from)?;
        if sent != body.len() {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "short seqpacket send"));
        }
        Ok(())
    }

    /// Receive one packet into `buf` (resized to `max_len`). Returns `Ok(None)` on EOF.
    pub fn recv<T: DeserializeOwned>(
        sock: BorrowedFd<'_>,
        buf: &mut Vec<u8>,
        max_len: usize,
    ) -> io::Result<Option<(T, Vec<OwnedFd>)>> {
        buf.resize(max_len, 0);
        let mut cmsg_space = nix::cmsg_space!([RawFd; MAX_FDS_PER_PACKET]);
        let (len, flags, fds) = {
            let mut iov = [IoSliceMut::new(&mut buf[..])];
            let msg = recvmsg::<()>(
                sock.as_raw_fd(),
                &mut iov,
                Some(&mut cmsg_space),
                MsgFlags::MSG_CMSG_CLOEXEC,
            )
            .map_err(io::Error::from)?;
            let mut fds = Vec::new();
            for c in msg.cmsgs().map_err(io::Error::from)? {
                if let ControlMessageOwned::ScmRights(raw) = c {
                    // SAFETY: the kernel just installed these descriptors in our table; we take
                    // sole ownership of each exactly once.
                    fds.extend(raw.into_iter().map(|r| unsafe { OwnedFd::from_raw_fd(r) }));
                }
            }
            (msg.bytes, msg.flags, fds)
        };
        if flags.intersects(MsgFlags::MSG_TRUNC | MsgFlags::MSG_CTRUNC) {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "truncated packet or control data"));
        }
        if len == 0 && fds.is_empty() {
            return Ok(None);
        }
        let msg = serde_json::from_slice(&buf[..len]).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(Some((msg, fds)))
    }
}

// ---------------------------------------------------------------------------------------------
// nestd ↔ nest-proxy
// ---------------------------------------------------------------------------------------------

/// nestd ↔ nest-proxy control protocol. nestd owns all state; the proxy is a stateless cache
/// that is fully rebuilt on every (re)connection (see the resync sequence in the spec).
pub mod proxy {
    use super::*;
    use crate::control::{CaCertificate, EgressAuditRecord};
    use crate::model::{EgressPolicy, InjectionSecret};

    /// nestd → nest-proxy.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(ProxyCommandKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ProxyCommand {
        /// Reply to [`ProxyEvent::Hello`]. Starts a resync: the proxy must discard any state.
        HelloAck { protocol_version: u32, host_id: HostId, nestd_boot_id: String },
        /// Per-host intermediate CA (from enrollment / `proxy_ca` rotation) and its private key,
        /// which nestd generated for the CSR. Sent during every resync and on rotation. The key is
        /// held in memory only.
        CaInstall { ca: CaCertificate, key_pem: Secret },
        /// Host lease mirror, sent on every heartbeat (≈5 s). After `valid_until_ms` the proxy
        /// refuses new connections and stops injecting for every sandbox (fail closed).
        LeaseUpdate { valid_until_ms: TimestampMs },
        /// Create or replace a sandbox's effective policy. Always precedes the sandbox's first
        /// `ListenersAdd`. Pushes whose `policy.version` is not newer are ignored. Applies to new
        /// requests only.
        SandboxUpsert {
            sandbox: SandboxId,
            epoch: Epoch,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            workstream: Option<WorkstreamId>,
            policy: EgressPolicy,
        },
        /// Replace the secret values for the sandbox's injection bindings (memory only).
        SecretsSet { sandbox: SandboxId, epoch: Epoch, secrets: Vec<InjectionSecret> },
        /// Hand over pre-bound listening sockets. **Carries exactly `listeners.len()` fds, in the
        /// same order.** At most [`super::fdpass::MAX_FDS_PER_PACKET`] per packet.
        ListenersAdd { sandbox: SandboxId, epoch: Epoch, listeners: Vec<ListenerSpec> },
        /// Stop accepting on these listeners and close them. Established connections finish.
        ListenersRemove { sandbox: SandboxId, epoch: Epoch, listener_ids: Vec<u32> },
        /// Forget the sandbox: close its listeners **and all its established connections**,
        /// drop its policy and secrets. Used for teardown, fencing and moves.
        SandboxDrop { sandbox: SandboxId, epoch: Epoch, reason: DropReason },
        /// End of a resync. Counts let the proxy verify it received everything.
        ResyncComplete { sandboxes: u32, listeners: u32 },
        /// Health probe; answered with [`ProxyEvent::Pong`].
        Ping { nonce: u64 },
    }

    impl ProxyCommand {
        /// Number of fds that must accompany this packet.
        pub fn expected_fds(&self) -> usize {
            match self {
                ProxyCommand::ListenersAdd { listeners, .. } => listeners.len(),
                _ => 0,
            }
        }
    }

    /// nest-proxy → nestd. Never carries fds.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(ProxyEventKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ProxyEvent {
        /// First packet after connecting.
        Hello { protocol_version: u32, proxy_version: String, pid: u32 },
        /// The proxy applied a full resync.
        ResyncAck { sandboxes: u32, listeners: u32 },
        /// Batched audit records (flushed every ≤1 s or 128 records; must fit
        /// [`super::fdpass::MAX_PACKET_FROM_PROXY`]). nestd forwards them as
        /// `HostEventBody::EgressAudit`.
        Audit { records: Vec<EgressAuditRecord> },
        /// High-priority security signal, sent immediately (the request is also audited with
        /// verdict `alert`). nestd turns it into an egress-alert workstream event.
        Alert {
            ts_ms: TimestampMs,
            sandbox: SandboxId,
            epoch: Epoch,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            agent: Option<AgentId>,
            kind: AlertKind,
            host: String,
            /// Injection binding involved, if any (forwarded as `EgressAlert.binding`).
            #[serde(default, skip_serializing_if = "Option::is_none")]
            binding: Option<String>,
            /// Human-readable detail; truncated to keep the packet under the size limit.
            detail: String,
        },
        /// A handed-over listener failed (accept error). nestd may rebind and resend.
        ListenerFailed { sandbox: SandboxId, listener_id: u32, error: ErrorBody },
        Pong { nonce: u64, sandboxes: u32, active_connections: u32 },
        /// Protocol error; the sender closes the connection after this.
        Error { error: ErrorBody },
    }

    /// A pre-bound socket inside a sandbox's netns. Serialized flat:
    /// `{"id":5,"transport":"tcp","addr":"172.16.0.1:3128","purpose":"explicit","agent":"agt_…","slot":0}`.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ListenerSpec {
        /// Unique per sandbox for the sandbox's lifetime on this host.
        pub id: u32,
        pub transport: Transport,
        /// Bound address inside the netns, e.g. `172.16.0.1:443`.
        pub addr: String,
        #[serde(flatten)]
        pub purpose: ListenerPurpose,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Transport {
        Tcp,
        Udp,
    }

    /// What a listener is for. The listener a connection arrived on identifies the sandbox (and,
    /// for `Explicit`, the agent).
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "purpose", rename_all = "snake_case")]
    pub enum ListenerPurpose {
        /// `:53` — one udp and one tcp listener per sandbox.
        Dns,
        /// `:80`, reached via nft redirect (programs ignoring proxy env).
        HttpTransparent,
        /// `:443`, reached via nft redirect; SNI-driven.
        HttpsTransparent,
        /// `:3128 + slot`, set as `HTTP(S)_PROXY` for one agent's hands execs (CONNECT + plain
        /// HTTP). The same port is `guest::AgentSlot::proxy_port`.
        Explicit { agent: AgentId, slot: u16 },
        /// One port per `model::TcpException`; `rule` is its `host:port`. The proxy dials it
        /// (resolved only through its own resolver) and splices bytes uninspected.
        TcpException { rule: String },
    }

    /// Base port for explicit (per-agent) proxy listeners.
    pub const EXPLICIT_BASE_PORT: u16 = 3128;
    /// Base port for TCP-exception listeners.
    pub const TCP_EXCEPTION_BASE_PORT: u16 = 20000;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum DropReason {
        Teardown,
        Fence,
        Moved,
    }

    impl DropReason {
        /// Whether this drop tombstones the epoch: later pushes at or below it are refused. Only a
        /// fence does; a teardown or move ends the sandbox's time here without fencing it, and a
        /// failed create is retried at the same epoch. nestd's mirror and nest-proxy both apply
        /// this one rule.
        pub fn tombstones(self) -> bool {
            matches!(self, DropReason::Fence)
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
    #[serde(rename_all = "snake_case")]
    pub enum AlertKind {
        /// A binding's placeholder was sent to a host outside the binding.
        PlaceholderWrongHost,
        /// `Host` header differs from SNI after termination.
        DomainFronting,
        /// A placeholder appeared after its secret or the host lease expired.
        InjectionAfterExpiry,
    }
}

// ---------------------------------------------------------------------------------------------
// nestd ↔ agent runner
// ---------------------------------------------------------------------------------------------

/// nestd ↔ agent runner: **brain lifecycle only**. Turns, inbox, caches, platform tool calls and
/// the session stream travel on the runner's own session channel to AgentDO
/// (`control::RunnerToAgent` / `control::AgentToRunner`). nestd keeps leases and fencing.
pub mod runner {
    use super::*;

    /// nestd → runner.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(RunnerCommandKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum RunnerCommand {
        /// Reply to [`RunnerEvent::Hello`]. The runner has no agents at this point: on any
        /// (re)connection nestd re-issues `AgentStart` for agents that should be running.
        HelloAck { protocol_version: u32, host_id: HostId, host_role: HostRole },
        /// Current host bearer token for session-channel WebSocket upgrades (memory only). Sent
        /// right after `HelloAck` and on every rotation; new connections use the newest token.
        HostToken { token: Secret, expires_ms: TimestampMs },
        /// Host lease mirror (≈5 s). If it lapses — or the nestd socket closes — the runner kills
        /// every brain immediately (`cgroup.kill`).
        LeaseUpdate { valid_until_ms: TimestampMs },
        /// Start (or resume) a brain.
        AgentStart(Box<AgentStart>),
        /// `epoch`: for a kill, the agent epoch it is for (nestd forwards the control plane's).
        /// The runner keeps it as the agent's tombstone: a brain at or below it is killed, a newer
        /// one is left alone, and a start at or below it is refused even if it registers later.
        /// Absent (a graceful stop, or nestd of the previous release): whatever runs is stopped.
        AgentStop {
            agent: AgentId,
            mode: StopMode,
            reason: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            epoch: Option<Epoch>,
        },
        /// Kill these brains now (empty = all). The runner then reports
        /// `AgentExited { reason: fenced }` and closes their session channels.
        Fence {
            #[serde(default)]
            agents: Vec<AgentId>,
            reason: String,
        },
        Ping { nonce: u64 },
    }

    /// runner → nestd.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(RunnerEventKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum RunnerEvent {
        Hello { protocol_version: u32, runner_version: String, pid: u32 },
        /// Process spawned, `system/init` received, auth verified, session channel open.
        AgentStarted {
            agent: AgentId,
            pid: u32,
            session: SessionId,
            claude_version: String,
            /// `system/init.capabilities` (feature detection, e.g. `interrupt_receipt_v1`).
            capabilities: Vec<String>,
            /// The agent epoch of the start this brain registered under (absent from a runner of
            /// the previous release): nestd marks that start's entry, and no other.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            epoch: Option<Epoch>,
        },
        /// Claude Code capabilities, sent whenever they become known (`system/init` may only
        /// arrive after the first user message, i.e. after `agent_started`).
        AgentCapabilities { agent: AgentId, capabilities: Vec<String> },
        /// Startup auth verification. `ok` requires `system/init.apiKeySource == "none"` (no API
        /// key in play) and `claude auth status` → `authMethod: "oauth_token"`. On failure the
        /// runner has already killed the agent.
        AuthCheck { agent: AgentId, auth_method: String, api_key_source: String, ok: bool },
        /// nestd forwards as `HostEventBody::AgentExited`.
        AgentExited {
            agent: AgentId,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            code: Option<i32>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            signal: Option<i32>,
            reason: ExitReason,
            /// The agent epoch the brain ran under (its last adopted one).
            #[serde(default, skip_serializing_if = "Option::is_none")]
            epoch: Option<Epoch>,
        },
        Pong { nonce: u64, agents: u32 },
        Error {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            agent: Option<AgentId>,
            error: ErrorBody,
        },
    }

    /// The control plane's `agent_start` plus host-local facts only nestd knows.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub struct AgentStart {
        /// As received from FleetDO (`CommandBody::AgentStart`), including `oauth_token`,
        /// `session_ws_url`, `resume` (Worker-signed segment URLs the runner downloads) and
        /// `hands` (the sandbox's id only; the runner fetches the gateway target over
        /// its session channel). nestd adds nothing about hands: the runner never touches a
        /// vsock socket.
        pub start: crate::control::AgentStart,
        /// `CLAUDE_CONFIG_DIR`, normally `<AGENTS_DIR>/<agent>`; created by nestd, owned by the
        /// agent's unit user.
        pub config_dir: String,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum StopMode {
        /// Close stdin and let the current turn finish (idle exit).
        Graceful,
        /// `cgroup.kill` now.
        Kill,
    }

    /// nestd forwards it as `control::AgentExitReason` (`From`), never as a string.
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter, strum::IntoStaticStr)]
    #[serde(rename_all = "snake_case")]
    #[strum(serialize_all = "snake_case")]
    pub enum ExitReason {
        /// Idle grace elapsed; stdin closed; exited cleanly.
        Idle,
        Stopped,
        Fenced,
        AuthFailed,
        Crashed,
    }

    impl ExitReason {
        /// The wire name, for logs and state details (derived; a test pins it to the serde name).
        pub fn as_str(self) -> &'static str {
            self.into()
        }
    }
}

// ---------------------------------------------------------------------------------------------
// runner ↔ `nest hook`
// ---------------------------------------------------------------------------------------------

/// `nest hook` is the command every Claude Code hook runs. Async (tracking) hooks send one
/// [`HookDatagram`]; sync (decision) hooks send one [`HookDecisionRequest`] frame and print the
/// [`HookOutput`] from the response to stdout. `nest hook` always exits 0.
///
/// nestd ↔ sandbox gateway (`paths::GATEWAY_SOCK`, length-prefixed JSON). nestd is the source of
/// truth: after every `hello` it resends the keys and every sandbox, then `resync_done`. A
/// gateway that loses the socket closes every open connection (`close_code::MOVED`) and refuses
/// every binding (`moved`) until it reconnects: the gateway's self-fence. nestd pings every 5 s
/// and drops a peer silent for 15 s.
pub mod gateway_link {
    use super::*;
    use crate::gateway::{BindingKey, GuestInfo};

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(GatewayCommandKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum GatewayCommand {
        /// Reply to [`GatewayEvent::Hello`]; a full resync (`key_update`, one `sandbox_upsert`
        /// per sandbox, then `resync_done`) follows on every (re)connection.
        HelloAck { protocol_version: u32, host_id: HostId },
        /// Every binding verification key still valid (see [`BindingKey`]); replaces the set.
        KeyUpdate { keys: Vec<BindingKey> },
        /// A sandbox this host runs: its current epoch, the host-side vsock unix socket the
        /// gateway connects to (`CONNECT <port>`), the clients attached to it (agent ids with a
        /// configured slot; a binding whose client is not listed is `unauthorized`, which is how
        /// `detach` revokes), and the guest's version once its hello arrived (`None` until the
        /// guest is configured: bindings get `busy`). A newer epoch replaces the old one, which
        /// revokes every binding that named it. Exposed ports and their `Host` mode come with
        /// the ingress routes, which are not served yet.
        SandboxUpsert {
            sandbox: SandboxId,
            epoch: Epoch,
            vsock_uds_path: String,
            #[serde(default)]
            clients: Vec<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            guest: Option<GuestInfo>,
        },
        /// The sandbox left this host (destroyed, evicted, fenced): open connections close with
        /// `close_code::MOVED` and bindings get `moved`.
        SandboxRemove { sandbox: SandboxId },
        /// Ends the resync that follows `hello_ack`: entries not re-sent since `hello` are
        /// dropped, and unknown sandboxes answer `moved` instead of `busy` from here on.
        ResyncDone,
        Ping,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(GatewayEventKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum GatewayEvent {
        /// First frame. `instance_id` is random per gateway process; `listen` is the address it
        /// accepts WebSockets on, for nestd's logs and health. The URL clients use comes from
        /// nestd's configuration (`gateway_url` in its fleet hello), not from here.
        Hello { protocol_version: u32, instance_id: String, listen: String },
        Pong,
        Error { error: ErrorBody },
    }
}

/// Claude Code's hook input/output JSON is an external format: inputs are snake_case and are
/// forwarded raw; outputs use Claude Code's camelCase field names.
pub mod hook {
    use super::*;

    /// Max datagram; `tool_response`/`tool_input` string fields are truncated to fit.
    pub const MAX_DATAGRAM: usize = 60 << 10;

    /// Async tracking hook → runner (`SOCK_DGRAM`, or one line in the spool file).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct HookDatagram {
        pub v: u32,
        pub agent: AgentId,
        pub ts_ms: TimestampMs,
        /// Raw Claude Code hook input (has `hook_event_name`, `session_id`, …).
        pub input: serde_json::Value,
        /// True if `nest hook` truncated large fields to fit [`MAX_DATAGRAM`].
        #[serde(default)]
        pub truncated: bool,
    }

    /// Sync decision hook → runner (one frame on `HOOK_SOCK`).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct HookDecisionRequest {
        pub v: u32,
        pub agent: AgentId,
        pub input: serde_json::Value,
    }

    /// runner → sync hook. `output` is printed verbatim to stdout.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct HookDecisionResponse {
        pub output: HookOutput,
    }

    /// Claude Code synchronous hook JSON output (subset we use).
    #[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct HookOutput {
        #[serde(rename = "continue", default, skip_serializing_if = "Option::is_none")]
        pub continue_: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub stop_reason: Option<String>,
        /// Top-level decision; used by `Stop` (`block` = keep going with `reason` as input).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub decision: Option<TopLevelDecision>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub system_message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub hook_specific_output: Option<HookSpecificOutput>,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum TopLevelDecision {
        Approve,
        Block,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "hookEventName")]
    pub enum HookSpecificOutput {
        #[serde(rename_all = "camelCase")]
        PreToolUse {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            permission_decision: Option<PermissionDecision>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            permission_decision_reason: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            updated_input: Option<serde_json::Value>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            additional_context: Option<String>,
        },
        PermissionRequest { decision: PermissionRequestDecision },
        #[serde(rename_all = "camelCase")]
        SessionStart {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            additional_context: Option<String>,
        },
        #[serde(rename_all = "camelCase")]
        Stop {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            additional_context: Option<String>,
        },
        /// Context the model reads after the tool's result (the runner's mid-turn inbox).
        #[serde(rename_all = "camelCase")]
        PostToolUse {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            additional_context: Option<String>,
        },
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum PermissionDecision {
        Allow,
        Deny,
        Ask,
        Defer,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "behavior", rename_all = "lowercase")]
    pub enum PermissionRequestDecision {
        #[serde(rename_all = "camelCase")]
        Allow {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            updated_input: Option<serde_json::Value>,
        },
        Deny {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            message: Option<String>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            interrupt: Option<bool>,
        },
    }

    /// Hook events wired to `nest hook --sync` (decision via `HOOK_SOCK`). All others are async.
    pub const SYNC_EVENTS: &[&str] = &["SessionStart", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
    /// Hook events wired as async tracking hooks.
    pub const ASYNC_EVENTS: &[&str] = &[
        "UserPromptSubmit",
        "PostToolUseFailure",
        "Notification",
        "Elicitation",
        "SubagentStart",
        "SubagentStop",
        "PreCompact",
        "PostCompact",
        "StopFailure",
        "SessionEnd",
    ];

    /// What `nest hook --sync` prints when the runner is unreachable or times out.
    /// `PreToolUse`/`PermissionRequest` fail closed; `SessionStart`/`Stop` fail open (no output).
    pub fn fallback_output(hook_event_name: &str) -> Option<HookOutput> {
        let reason = "nest runner unavailable".to_string();
        match hook_event_name {
            "PreToolUse" => Some(HookOutput {
                hook_specific_output: Some(HookSpecificOutput::PreToolUse {
                    permission_decision: Some(PermissionDecision::Deny),
                    permission_decision_reason: Some(reason),
                    updated_input: None,
                    additional_context: None,
                }),
                ..Default::default()
            }),
            "PermissionRequest" => Some(HookOutput {
                hook_specific_output: Some(HookSpecificOutput::PermissionRequest {
                    decision: PermissionRequestDecision::Deny { message: Some(reason), interrupt: None },
                }),
                ..Default::default()
            }),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// runner ↔ `nest mcp`
// ---------------------------------------------------------------------------------------------

/// `nest mcp` is the stdio MCP server Claude Code spawns (server name `nest`, so tools appear as
/// `mcp__nest__<Name>`). It speaks MCP JSON-RPC to Claude Code and forwards `tools/list` and
/// `tools/call` to the runner over `MCP_SOCK`. It holds no logic and no credentials.
///
/// MCP-shaped objects ([`McpToolDef`], [`McpContent`], [`ToolCallResult`]) keep MCP's camelCase
/// field names so they pass through unchanged.
pub mod mcp {
    use super::*;

    /// `nest mcp` → runner.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(McpBridgeRequestKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum McpBridgeRequest {
        /// First frame; identifies the agent (from `NEST_AGENT_ID`).
        Hello { v: u32, agent: AgentId },
        ToolsList { id: u64 },
        ToolsCall {
            id: u64,
            name: String,
            arguments: serde_json::Value,
            /// Claude Code's `tool_use` id, from the `tools/call` request's `_meta` when present
            /// (e.g. `_meta["claudecode/toolUseId"]`; UNVERIFIED key). Becomes the guest
            /// `HandsRequest.call_id`; the runner falls back to a generated `hc_<random>`.
            #[serde(default, skip_serializing_if = "Option::is_none")]
            tool_use_id: Option<String>,
        },
        /// MCP `notifications/cancelled` for an in-flight call.
        Cancel { id: u64 },
    }

    /// runner → `nest mcp`.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, strum::EnumDiscriminants)]
    #[strum_discriminants(name(McpBridgeResponseKind), derive(strum::EnumIter, strum::IntoStaticStr))]
    #[strum_discriminants(strum(serialize_all = "snake_case"))]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum McpBridgeResponse {
        HelloAck { v: u32 },
        ToolsList { id: u64, tools: Vec<McpToolDef> },
        ToolsCall { id: u64, result: ToolCallResult },
        /// Pushed when the tool set changes; `nest mcp` emits `notifications/tools/list_changed`.
        ToolsChanged {},
        Error {
            #[serde(default, skip_serializing_if = "Option::is_none")]
            id: Option<u64>,
            error: ErrorBody,
        },
    }

    /// An MCP tool definition (MCP field names).
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct McpToolDef {
        pub name: String,
        pub description: String,
        #[serde(rename = "inputSchema")]
        pub input_schema: serde_json::Value,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub annotations: Option<serde_json::Value>,
    }

    /// MCP `tools/call` result.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct ToolCallResult {
        pub content: Vec<McpContent>,
        #[serde(rename = "isError", default)]
        pub is_error: bool,
    }

    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "lowercase")]
    pub enum McpContent {
        Text { text: String },
        Image {
            /// Base64.
            data: String,
            #[serde(rename = "mimeType")]
            mime_type: String,
        },
    }

    impl ToolCallResult {
        pub fn text(text: impl Into<String>) -> Self {
            Self { content: vec![McpContent::Text { text: text.into() }], is_error: false }
        }
        pub fn error(text: impl Into<String>) -> Self {
            Self { content: vec![McpContent::Text { text: text.into() }], is_error: true }
        }
    }

    impl From<&crate::control::ToolDef> for McpToolDef {
        fn from(t: &crate::control::ToolDef) -> Self {
            Self {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
                annotations: None,
            }
        }
    }

    impl From<&crate::control::ToolOutcome> for ToolCallResult {
        /// `pending` is *not* an error: the model is told the question is posted and to end the
        /// turn; the answer arrives as a later turn.
        fn from(o: &crate::control::ToolOutcome) -> Self {
            use crate::control::{ToolContent, ToolOutcome};
            match o {
                ToolOutcome::Ok { content } => Self {
                    content: content
                        .iter()
                        .map(|c| match c {
                            ToolContent::Text { text } => McpContent::Text { text: text.clone() },
                            ToolContent::Image { media_type, data_b64 } => {
                                McpContent::Image { data: data_b64.clone(), mime_type: media_type.clone() }
                            }
                            ToolContent::Json { value } => McpContent::Text { text: value.to_string() },
                        })
                        .collect(),
                    is_error: false,
                },
                ToolOutcome::Error { error } => Self::error(format!("{}: {}", error.code, error.message)),
                ToolOutcome::Pending { ask, message } => Self::text(format!("{message} (pending: {ask})")),
            }
        }
    }

    /// The MCP server name; tools appear to the model as `mcp__nest__<Name>`.
    pub const SERVER_NAME: &str = "nest";
    /// MCP tool-call timeout (ms) set in the generated config; long hands execs run in the
    /// background instead of blocking past this.
    pub const TOOL_TIMEOUT_MS: u64 = 15 * 60 * 1000;
}

// ---------------------------------------------------------------------------------------------
// runner ↔ Claude Code
// ---------------------------------------------------------------------------------------------

/// How the runner invokes Claude Code, and the stream-json subset it relies on.
/// Reference artifacts: `protocol/claude-code/`.
pub mod claude {
    use super::*;

    use crate::control::{LaunchConfig, SystemPrompt};

    /// Built-ins a worker may keep: nothing that reads/writes host files or runs host commands.
    /// The control plane sends the actual list in `LaunchConfig.builtin_tools` (the seeded `worker`
    /// template leaves out `Agent` and `TodoWrite`); this wider set is what the golden argv and the
    /// `e2e/claude-verify` probes exercise. The runner logs `system/init.tools` so drift is visible.
    pub const WORKER_BUILTIN_TOOLS: &[&str] =
        &["Agent", "TaskCreate", "TaskGet", "TaskUpdate", "TaskList", "TodoWrite", "WebSearch", "WebFetch"];

    /// File (inside the config dir) the runner writes `LaunchConfig.system_prompt.text` to.
    pub const PROMPT_FILE: &str = "nest-system-prompt.md";
    /// Generated `--mcp-config` file (inside the config dir).
    pub const MCP_CONFIG_FILE: &str = "nest-mcp.json";

    /// How to open the Claude Code session.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub enum SessionArgs {
        /// `--session-id <uuid>`: the runner picks the UUID, so the `SessionId` is known up front.
        New { uuid: String },
        /// `--resume <path>` (+ `--fork-session` for a conversation fork, which yields a new
        /// session id reported by `system/init`).
        Resume { path: String, fork: bool },
    }

    /// `SessionId` ⇔ Claude Code session UUID: `ses_<uuid>`.
    pub fn session_id(claude_uuid: &str) -> SessionId {
        SessionId(format!("{}{claude_uuid}", SessionId::PREFIX))
    }

    /// Inverse of [`session_id`].
    pub fn claude_uuid(id: &SessionId) -> Option<&str> {
        id.0.strip_prefix(SessionId::PREFIX)
    }

    /// Where the runner materializes a resumed session before `--resume <path>`: Claude Code's
    /// project directory for the process cwd (normally [`paths::EMPTY_CWD`]). The runner still
    /// tails the `transcript_path` reported by the `SessionStart` hook and rebases if it differs.
    pub fn transcript_path(config_dir: &str, cwd: &str, claude_uuid: &str) -> String {
        format!("{config_dir}/projects/{}/{claude_uuid}.jsonl", project_dir(cwd))
    }

    /// Longest project directory name Claude Code uses before shortening it with a hash.
    const MAX_PROJECT_DIR: usize = 200;

    /// Claude Code's project directory name for `cwd`: every UTF-16 unit that isn't an ASCII letter
    /// or digit becomes `-`; a name over [`MAX_PROJECT_DIR`] is cut there and suffixed with `-` and
    /// the base-36 absolute value of the cwd's Java-style string hash. Observed on Claude Code
    /// 2.1.300 (`e2e/claude-verify`, probe 8); the exact cut-off and non-ASCII handling are inferred.
    pub fn project_dir(cwd: &str) -> String {
        let name: String = cwd
            .encode_utf16()
            .map(|u| match char::from_u32(u32::from(u)) {
                Some(c) if c.is_ascii_alphanumeric() => c,
                _ => '-',
            })
            .collect();
        if name.len() <= MAX_PROJECT_DIR {
            return name;
        }
        let hash = cwd.encode_utf16().fold(0i32, |h, u| h.wrapping_mul(31).wrapping_add(i32::from(u)));
        format!("{}-{}", &name[..MAX_PROJECT_DIR], base36(i64::from(hash).unsigned_abs()))
    }

    fn base36(mut n: u64) -> String {
        const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut out = Vec::new();
        loop {
            out.push(DIGITS[(n % 36) as usize]);
            n /= 36;
            if n == 0 {
                break;
            }
        }
        out.reverse();
        String::from_utf8(out).expect("ascii")
    }

    /// Exact argv (without the program). `config_dir` holds [`PROMPT_FILE`] and
    /// [`MCP_CONFIG_FILE`].
    pub fn args(launch: &LaunchConfig, config_dir: &str, session: &SessionArgs) -> Vec<String> {
        let mut a: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--restricted",
            "--tools",
        ]
        .map(String::from)
        .to_vec();
        a.push(launch.builtin_tools.join(","));
        a.extend(["--strict-mcp-config".into(), "--mcp-config".into(), format!("{config_dir}/{MCP_CONFIG_FILE}")]);
        a.extend(["--permission-mode", "dontAsk", "--permission-prompts", "none"].map(String::from));
        let mut allowed = vec![format!("mcp__{}__*", mcp::SERVER_NAME)];
        allowed.extend(launch.builtin_tools.iter().cloned());
        a.push("--allowedTools".into());
        a.push(allowed.join(","));
        a.push("--disable-slash-commands".into());
        let flag = match &launch.system_prompt {
            SystemPrompt::Append { .. } => "--append-system-prompt-file",
            SystemPrompt::Replace { .. } => "--system-prompt-file",
        };
        a.extend([flag.into(), format!("{config_dir}/{PROMPT_FILE}")]);
        if let Some(m) = &launch.model {
            a.extend(["--model".into(), m.clone()]);
        }
        if let Some(e) = &launch.effort {
            a.extend(["--effort".into(), e.clone()]);
        }
        match session {
            SessionArgs::New { uuid } => a.extend(["--session-id".into(), uuid.clone()]),
            SessionArgs::Resume { path, fork } => {
                a.extend(["--resume".into(), path.clone()]);
                if *fork {
                    a.push("--fork-session".into());
                }
            }
        }
        a
    }

    /// Text of the prompt file for a launch.
    pub fn prompt_text(launch: &LaunchConfig) -> &str {
        match &launch.system_prompt {
            SystemPrompt::Append { text } | SystemPrompt::Replace { text } => text,
        }
    }

    /// The complete environment for a Claude Code process (nothing inherited).
    pub fn env(agent: &AgentId, config_dir: &str, oauth_token: &str, sockets: &paths::RunnerSockets) -> Vec<(String, String)> {
        let kv = |k: &str, v: &str| (k.to_string(), v.to_string());
        vec![
            kv("PATH", "/usr/local/bin:/usr/bin:/bin"),
            kv("HOME", config_dir),
            kv("LANG", "C.UTF-8"),
            kv("TZ", "UTC"),
            kv("TMPDIR", "/tmp"),
            kv("CLAUDE_CONFIG_DIR", config_dir),
            kv("CLAUDE_CODE_OAUTH_TOKEN", oauth_token),
            // Defense in depth: hook and MCP subprocesses never see the token.
            kv("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
            // stdio MCP servers get a safe baseline env plus their configured env only.
            kv("CLAUDE_CODE_MCP_ALLOWLIST_ENV", "1"),
            kv("DISABLE_AUTOUPDATER", "1"),
            kv(env::AGENT_ID, &agent.0),
            kv(env::HOOK_DGRAM, &sockets.hook_dgram),
            kv(env::HOOK_SOCK, &sockets.hook_sock),
            kv(env::HOOK_SPOOL, &format!("{config_dir}/nest-hook-spool.jsonl")),
        ]
    }

    /// The generated `--mcp-config` document.
    pub fn mcp_config(agent: &AgentId, sockets: &paths::RunnerSockets) -> serde_json::Value {
        serde_json::json!({
            "mcpServers": {
                mcp::SERVER_NAME: {
                    "type": "stdio",
                    "command": sockets.nest_bin,
                    "args": ["mcp"],
                    "env": {
                        env::AGENT_ID: agent.0,
                        env::MCP_SOCK: sockets.mcp_sock,
                    },
                    "timeout": mcp::TOOL_TIMEOUT_MS,
                    "alwaysLoad": true,
                }
            }
        })
    }

    // ---- stream-json: input (runner → Claude Code stdin) ----

    /// One stdin line.
    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum StreamIn {
        User { message: UserMessageParam, parent_tool_use_id: Option<String> },
        ControlRequest { request_id: String, request: ControlRequest },
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    pub struct UserMessageParam {
        /// Always `"user"`.
        pub role: String,
        pub content: Vec<serde_json::Value>,
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "subtype", rename_all = "snake_case")]
    pub enum ControlRequest {
        Interrupt {
            #[serde(default, skip_serializing_if = "std::ops::Not::not")]
            cancel_queued: bool,
        },
    }

    impl StreamIn {
        pub fn user_text(text: &str) -> Self {
            StreamIn::User {
                message: UserMessageParam {
                    role: "user".into(),
                    content: vec![serde_json::json!({"type": "text", "text": text})],
                },
                parent_tool_use_id: None,
            }
        }
    }

    // ---- stream-json: output (Claude Code stdout → runner) ----

    /// The stdout lines the runner interprets. Everything else is `Other` (still tailed via the
    /// session file, never an error).
    #[derive(Clone, Debug, PartialEq, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum StreamOut {
        System(SystemMessage),
        Assistant { message: serde_json::Value, session_id: String },
        User { message: serde_json::Value, session_id: String },
        Result(ResultMessage),
        RateLimitEvent { rate_limit_info: serde_json::Value, session_id: String },
        ControlResponse { response: ControlResponse },
        #[serde(other)]
        Other,
    }

    #[derive(Clone, Debug, PartialEq, Deserialize)]
    #[serde(tag = "subtype", rename_all = "snake_case")]
    pub enum SystemMessage {
        Init {
            session_id: String,
            claude_code_version: String,
            #[serde(rename = "apiKeySource")]
            api_key_source: String,
            tools: Vec<String>,
            mcp_servers: Vec<serde_json::Value>,
            model: String,
            #[serde(default)]
            capabilities: Vec<String>,
        },
        ApiRetry {
            attempt: u32,
            max_retries: u32,
            retry_delay_ms: u64,
            error_status: Option<u16>,
            error: String,
            session_id: String,
        },
        #[serde(other)]
        Other,
    }

    #[derive(Clone, Debug, PartialEq, Deserialize)]
    pub struct ResultMessage {
        /// `success` | `error_during_execution` | `error_max_turns` | …
        pub subtype: String,
        pub is_error: bool,
        pub num_turns: u32,
        pub duration_ms: u64,
        pub total_cost_usd: f64,
        pub usage: serde_json::Value,
        pub session_id: String,
        #[serde(default)]
        pub stop_reason: Option<String>,
        #[serde(default)]
        pub result: Option<String>,
    }

    #[derive(Clone, Debug, PartialEq, Deserialize)]
    #[serde(tag = "subtype", rename_all = "snake_case")]
    pub enum ControlResponse {
        Success {
            request_id: String,
            #[serde(default)]
            response: Option<serde_json::Value>,
        },
        Error { request_id: String, error: String },
    }
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Serialize, de::DeserializeOwned};
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};
    use strum::IntoEnumIterator;

    fn fixtures_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/host")
    }

    /// Round-trip every fixture in `dir` through `T` (semantic JSON equality) and return the
    /// set of `type` tags seen.
    fn round_trip_dir<T: Serialize + DeserializeOwned>(dir: &str) -> BTreeSet<String> {
        let path = fixtures_dir().join(dir);
        let mut seen = BTreeSet::new();
        let mut entries: Vec<_> = std::fs::read_dir(&path)
            .unwrap_or_else(|e| panic!("missing fixture dir {}: {e}", path.display()))
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        entries.sort();
        assert!(!entries.is_empty(), "no fixtures in {dir}");
        for file in entries {
            let text = std::fs::read_to_string(&file).unwrap();
            let original: serde_json::Value = serde_json::from_str(&text).unwrap();
            let parsed: T = serde_json::from_value(original.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", file.display()));
            let again = serde_json::to_value(&parsed).unwrap();
            assert_eq!(original, again, "round-trip mismatch for {}", file.display());
            if let Some(t) = original.get("type").and_then(|t| t.as_str()) {
                let stem = file.file_stem().unwrap().to_str().unwrap();
                assert_eq!(stem.split('.').next().unwrap(), t, "fixture file name must start with its type: {}", file.display());
                seen.insert(t.to_string());
            }
        }
        seen
    }

    fn assert_covered<K: IntoEnumIterator + Into<&'static str>>(dir: &str, seen: &BTreeSet<String>) {
        let all: BTreeSet<String> = K::iter().map(|k| k.into().to_string()).collect();
        let missing: Vec<_> = all.difference(seen).collect();
        assert!(missing.is_empty(), "variants without a fixture in {dir}: {missing:?}");
        let unknown: Vec<_> = seen.difference(&all).collect();
        assert!(unknown.is_empty(), "fixtures for unknown variants in {dir}: {unknown:?}");
    }

    #[test]
    fn proxy_command_fixtures() {
        let seen = round_trip_dir::<proxy::ProxyCommand>("proxy_command");
        assert_covered::<proxy::ProxyCommandKind>("proxy_command", &seen);
    }

    #[test]
    fn proxy_event_fixtures() {
        let seen = round_trip_dir::<proxy::ProxyEvent>("proxy_event");
        assert_covered::<proxy::ProxyEventKind>("proxy_event", &seen);
    }

    #[test]
    fn runner_command_fixtures() {
        let seen = round_trip_dir::<runner::RunnerCommand>("runner_command");
        assert_covered::<runner::RunnerCommandKind>("runner_command", &seen);
    }

    #[test]
    fn runner_event_fixtures() {
        let seen = round_trip_dir::<runner::RunnerEvent>("runner_event");
        assert_covered::<runner::RunnerEventKind>("runner_event", &seen);
    }

    #[test]
    fn mcp_bridge_fixtures() {
        let seen = round_trip_dir::<mcp::McpBridgeRequest>("mcp_request");
        assert_covered::<mcp::McpBridgeRequestKind>("mcp_request", &seen);
        let seen = round_trip_dir::<mcp::McpBridgeResponse>("mcp_response");
        assert_covered::<mcp::McpBridgeResponseKind>("mcp_response", &seen);
    }

    #[test]
    fn gateway_link_fixtures() {
        let seen = round_trip_dir::<gateway_link::GatewayCommand>("gateway_command");
        assert_covered::<gateway_link::GatewayCommandKind>("gateway_command", &seen);
        let seen = round_trip_dir::<gateway_link::GatewayEvent>("gateway_event");
        assert_covered::<gateway_link::GatewayEventKind>("gateway_event", &seen);
    }

    #[test]
    fn hook_fixtures() {
        round_trip_dir::<hook::HookDatagram>("hook_datagram");
        round_trip_dir::<hook::HookDecisionRequest>("hook_decision_request");
        round_trip_dir::<hook::HookDecisionResponse>("hook_decision_response");
    }

    #[test]
    fn listener_spec_is_flat() {
        let l = proxy::ListenerSpec {
            id: 3,
            transport: proxy::Transport::Tcp,
            addr: "172.16.0.1:3129".into(),
            purpose: proxy::ListenerPurpose::Explicit { agent: AgentId("agt_1".into()), slot: 1 },
        };
        assert_eq!(
            serde_json::to_value(&l).unwrap(),
            serde_json::json!({"id":3,"transport":"tcp","addr":"172.16.0.1:3129","purpose":"explicit","agent":"agt_1","slot":1})
        );
    }

    #[test]
    fn secret_debug_is_redacted() {
        assert_eq!(format!("{:?}", Secret("sk-live".into())), "Secret(<redacted>)");
    }

    #[test]
    fn hook_fallbacks() {
        let pre = serde_json::to_value(hook::fallback_output("PreToolUse").unwrap()).unwrap();
        assert_eq!(pre["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(pre["hookSpecificOutput"]["permissionDecision"], "deny");
        let perm = serde_json::to_value(hook::fallback_output("PermissionRequest").unwrap()).unwrap();
        assert_eq!(perm["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(hook::fallback_output("Stop").is_none());
        assert!(hook::fallback_output("SessionStart").is_none());
    }

    #[test]
    fn stop_block_output_shape() {
        let out = hook::HookOutput {
            decision: Some(hook::TopLevelDecision::Block),
            reason: Some("New message from captain".into()),
            ..Default::default()
        };
        assert_eq!(serde_json::to_value(&out).unwrap(), serde_json::json!({"decision":"block","reason":"New message from captain"}));
    }

    fn launch(prompt: crate::control::SystemPrompt, tools: &[&str]) -> crate::control::LaunchConfig {
        crate::control::LaunchConfig {
            model: None,
            effort: None,
            builtin_tools: tools.iter().map(|s| s.to_string()).collect(),
            system_prompt: prompt,
        }
    }

    #[test]
    fn worker_args_golden() {
        let l = launch(crate::control::SystemPrompt::Append { text: "w".into() }, claude::WORKER_BUILTIN_TOOLS);
        let args = claude::args(
            &l,
            "/var/lib/nest/agents/agt_w",
            &claude::SessionArgs::New { uuid: "0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69".into() },
        );
        let expected: Vec<String> = [
            "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
            "--restricted", "--tools", "Agent,TaskCreate,TaskGet,TaskUpdate,TaskList,TodoWrite,WebSearch,WebFetch",
            "--strict-mcp-config", "--mcp-config", "/var/lib/nest/agents/agt_w/nest-mcp.json",
            "--permission-mode", "dontAsk", "--permission-prompts", "none",
            "--allowedTools", "mcp__nest__*,Agent,TaskCreate,TaskGet,TaskUpdate,TaskList,TodoWrite,WebSearch,WebFetch",
            "--disable-slash-commands", "--append-system-prompt-file", "/var/lib/nest/agents/agt_w/nest-system-prompt.md",
            "--session-id", "0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(args, expected);
    }

    /// Samples observed on Claude Code 2.1.300 by `e2e/claude-verify` (probe 8).
    #[test]
    fn project_dir_matches_claude_code() {
        assert_eq!(claude::project_dir("/tmp/nest-cv-hg5x5c20/baseline/cwd.nest_probe"), "-tmp-nest-cv-hg5x5c20-baseline-cwd-nest-probe");
        let seg = "/seg.dir_0123456789-abcdefghij";
        let long = format!("/tmp/nest-cv-hg5x5c20/long{}", seg.repeat(8));
        let expected = format!(
            "-tmp-nest-cv-hg5x5c20-long{}-seg-dir-0123456789-abcd-6rxg1j",
            "-seg-dir-0123456789-abcdefghij".repeat(5)
        );
        assert_eq!(long.len(), 266);
        assert_eq!(claude::project_dir(&long), expected);
        assert_eq!(expected.len(), 207);
    }

    #[test]
    fn captain_args_golden() {
        let mut l = launch(crate::control::SystemPrompt::Replace { text: "c".into() }, &[]);
        l.model = Some("opus".into());
        let path = claude::transcript_path("/var/lib/nest/agents/agt_c", paths::EMPTY_CWD, "5d0f9a8e-1c2b-4d3e-8f7a-6b5c4d3e2f1a");
        assert_eq!(path, "/var/lib/nest/agents/agt_c/projects/-var-lib-nest-empty/5d0f9a8e-1c2b-4d3e-8f7a-6b5c4d3e2f1a.jsonl");
        let args = claude::args(&l, "/var/lib/nest/agents/agt_c", &claude::SessionArgs::Resume { path: path.clone(), fork: true });
        let i = args.iter().position(|a| a == "--tools").unwrap();
        assert_eq!(args[i + 1], "");
        assert!(args.windows(2).any(|w| w == ["--system-prompt-file", "/var/lib/nest/agents/agt_c/nest-system-prompt.md"]));
        assert!(args.windows(2).any(|w| w == ["--allowedTools", "mcp__nest__*"]));
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert_eq!(&args[args.len() - 3..], &["--resume".to_string(), path, "--fork-session".to_string()]);
        assert!(!args.iter().any(|a| a == "--bare" || a == "--safe-mode" || a == "--session-id"));
    }

    #[test]
    fn session_id_mapping() {
        let id = claude::session_id("0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69");
        assert_eq!(id.0, "ses_0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69");
        assert_eq!(claude::claude_uuid(&id), Some("0b6c7f6e-8f4c-4a7b-9a51-2f1d3c4b5a69"));
    }

    #[test]
    fn tool_outcome_to_mcp() {
        use crate::control::{ToolContent, ToolOutcome};
        let ok = ToolOutcome::Ok { content: vec![ToolContent::Image { media_type: "image/png".into(), data_b64: "AA==".into() }] };
        assert_eq!(
            serde_json::to_value(mcp::ToolCallResult::from(&ok)).unwrap(),
            serde_json::json!({"content":[{"type":"image","data":"AA==","mimeType":"image/png"}],"isError":false})
        );
        let err = ToolOutcome::Error { error: ErrorBody { code: "forbidden".into(), message: "no".into(), retryable: false } };
        assert!(mcp::ToolCallResult::from(&err).is_error);
        let pending: ToolOutcome = serde_json::from_value(serde_json::json!({"status":"pending","ask":"ask_1","message":"Posted."})).unwrap();
        let r = mcp::ToolCallResult::from(&pending);
        assert!(!r.is_error);
    }

    #[test]
    fn env_is_complete_and_clean() {
        let env = claude::env(&AgentId("agt_1".into()), "/var/lib/nest/agents/agt_1", "tok", &paths::RunnerSockets::default());
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!keys.iter().any(|k| k.starts_with("ANTHROPIC_")), "no ANTHROPIC_* may be set");
        assert!(!keys.contains(&"HTTPS_PROXY"), "brains are not proxied");
        // AgentDO's recovery turn is the one way an interrupted turn continues; Claude Code's own
        // auto-continue would run it a second time.
        assert!(!keys.contains(&"CLAUDE_CODE_RESUME_INTERRUPTED_TURN"));
        let settings: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/claude-code/managed-settings.json")).unwrap(),
        )
        .unwrap();
        assert!(settings.get("env").and_then(|e| e.get("CLAUDE_CODE_RESUME_INTERRUPTED_TURN")).is_none());
    }

    #[test]
    fn mcp_config_matches_reference() {
        let reference: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/claude-code/mcp-config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(claude::mcp_config(&AgentId("agt_EXAMPLE".into()), &paths::RunnerSockets::default()), reference);
    }

    #[test]
    fn stream_json_reference_lines_parse() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/claude-code");
        let out = std::fs::read_to_string(dir.join("stream-out.jsonl")).unwrap();
        let mut kinds = Vec::new();
        for line in out.lines().filter(|l| !l.trim().is_empty()) {
            let m: claude::StreamOut = serde_json::from_str(line).unwrap_or_else(|e| panic!("{line}: {e}"));
            kinds.push(match m {
                claude::StreamOut::System(claude::SystemMessage::Init { .. }) => "init",
                claude::StreamOut::System(claude::SystemMessage::ApiRetry { .. }) => "api_retry",
                claude::StreamOut::System(claude::SystemMessage::Other) => "system_other",
                claude::StreamOut::Assistant { .. } => "assistant",
                claude::StreamOut::User { .. } => "user",
                claude::StreamOut::Result(_) => "result",
                claude::StreamOut::RateLimitEvent { .. } => "rate_limit_event",
                claude::StreamOut::ControlResponse { .. } => "control_response",
                claude::StreamOut::Other => "other",
            });
        }
        for k in ["init", "api_retry", "assistant", "user", "result", "rate_limit_event", "control_response", "other", "system_other"] {
            assert!(kinds.contains(&k), "stream-out.jsonl lacks a {k} line");
        }
        let input = std::fs::read_to_string(dir.join("stream-in.jsonl")).unwrap();
        for line in input.lines().filter(|l| !l.trim().is_empty()) {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let m: claude::StreamIn = serde_json::from_value(v.clone()).unwrap();
            assert_eq!(serde_json::to_value(&m).unwrap(), v);
        }
        assert_eq!(
            serde_json::to_value(claude::StreamIn::user_text("hi")).unwrap(),
            serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"parent_tool_use_id":null})
        );
    }

    #[test]
    fn managed_settings_wire_every_hook() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/claude-code");
        let s: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("managed-settings.json")).unwrap()).unwrap();
        assert_eq!(s["forceLoginMethod"], "claudeai");
        assert_eq!(s["allowedProviders"], serde_json::json!(["anthropic"]));
        assert_eq!(s["allowManagedHooksOnly"], true);
        assert_eq!(s["autoMemoryEnabled"], false);
        for ev in hook::SYNC_EVENTS {
            let h = &s["hooks"][ev][0]["hooks"][0];
            assert_eq!(h["command"], format!("{} hook --sync", paths::NEST_BIN), "{ev}");
            assert!(h.get("async").is_none(), "{ev} must be sync");
        }
        for ev in hook::ASYNC_EVENTS {
            let h = &s["hooks"][ev][0]["hooks"][0];
            assert_eq!(h["command"], format!("{} hook", paths::NEST_BIN), "{ev}");
            assert_eq!(h["async"], true, "{ev} must be async");
        }
    }

    #[test]
    fn frame_round_trip() {
        let msg = runner::RunnerCommand::Ping { nonce: 7 };
        let bytes = frame::encode(&msg).unwrap();
        assert_eq!(&bytes[..4], &((bytes.len() - 4) as u32).to_be_bytes());
        let mut cur = std::io::Cursor::new([bytes.clone(), bytes].concat());
        let a: runner::RunnerCommand = frame::read(&mut cur).unwrap().unwrap();
        let b: runner::RunnerCommand = frame::read(&mut cur).unwrap().unwrap();
        assert_eq!(a, msg);
        assert_eq!(b, msg);
        assert!(frame::read::<_, runner::RunnerCommand>(&mut cur).unwrap().is_none());
    }

    #[test]
    fn frame_rejects_oversize_length() {
        let mut cur = std::io::Cursor::new(((frame::MAX_FRAME + 1) as u32).to_be_bytes().to_vec());
        assert!(frame::read::<_, serde_json::Value>(&mut cur).is_err());
    }

    #[cfg(unix)]
    mod fdpass_tests {
        use super::*;
        use nix::sys::socket::{AddressFamily, SockFlag, SockType, socketpair};
        use std::io::{Read, Write};
        use std::os::fd::AsFd;
        use std::os::unix::net::UnixStream;

        fn seqpacket_pair() -> (std::os::fd::OwnedFd, std::os::fd::OwnedFd) {
            socketpair(AddressFamily::Unix, SockType::SeqPacket, None, SockFlag::SOCK_CLOEXEC).unwrap()
        }

        #[test]
        fn listeners_add_carries_fds_in_order() {
            let (a, b) = seqpacket_pair();
            // Two "listeners": stream socketpairs whose peers we keep to prove identity + order.
            let (l0, mut p0) = UnixStream::pair().unwrap();
            let (l1, mut p1) = UnixStream::pair().unwrap();
            let msg = proxy::ProxyCommand::ListenersAdd {
                sandbox: SandboxId("sbx_1".into()),
                epoch: Epoch(4),
                listeners: vec![
                    proxy::ListenerSpec { id: 1, transport: proxy::Transport::Tcp, addr: "172.16.0.1:443".into(), purpose: proxy::ListenerPurpose::HttpsTransparent },
                    proxy::ListenerSpec { id: 2, transport: proxy::Transport::Tcp, addr: "172.16.0.1:80".into(), purpose: proxy::ListenerPurpose::HttpTransparent },
                ],
            };
            assert_eq!(msg.expected_fds(), 2);
            fdpass::send(a.as_fd(), &msg, &[l0.as_fd(), l1.as_fd()]).unwrap();
            drop((l0, l1));

            let mut buf = Vec::new();
            let (got, fds): (proxy::ProxyCommand, _) =
                fdpass::recv(b.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY).unwrap().unwrap();
            assert_eq!(got, msg);
            assert_eq!(fds.len(), got.expected_fds());
            let mut r0 = UnixStream::from(fds.into_iter().next().unwrap());
            p0.write_all(b"zero").unwrap();
            let mut s = [0u8; 4];
            r0.read_exact(&mut s).unwrap();
            assert_eq!(&s, b"zero");
            drop(p1.write_all(b"x"));
        }

        #[test]
        fn packets_without_fds_and_eof() {
            let (a, b) = seqpacket_pair();
            let ev = proxy::ProxyEvent::Pong { nonce: 1, sandboxes: 2, active_connections: 3 };
            fdpass::send(a.as_fd(), &ev, &[]).unwrap();
            drop(a);
            let mut buf = Vec::new();
            let (got, fds): (proxy::ProxyEvent, _) =
                fdpass::recv(b.as_fd(), &mut buf, fdpass::MAX_PACKET_FROM_PROXY).unwrap().unwrap();
            assert_eq!(got, ev);
            assert!(fds.is_empty());
            assert!(fdpass::recv::<proxy::ProxyEvent>(b.as_fd(), &mut buf, fdpass::MAX_PACKET_FROM_PROXY).unwrap().is_none());
        }

        #[test]
        fn oversized_packet_is_rejected_as_truncated() {
            let (a, b) = seqpacket_pair();
            let ev = proxy::ProxyEvent::Error { error: ErrorBody { code: "x".into(), message: "y".repeat(4096), retryable: false } };
            fdpass::send(a.as_fd(), &ev, &[]).unwrap();
            let mut buf = Vec::new();
            assert!(fdpass::recv::<proxy::ProxyEvent>(b.as_fd(), &mut buf, 256).is_err());
        }
    }
}
