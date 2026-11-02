//! Host ↔ guest agent boundary (virtio-vsock). Spec: `docs/interfaces/host-guest/`.
//!
//! Every connection is host-initiated through Firecracker's host-side unix socket
//! (`CONNECT <port>\n` → `OK <port>\n`, see [`handshake`]) and then carries [`frame`]s.
//! Ports select the channel:
//!
//! | Port | Channel | Lifetime |
//! |---|---|---|
//! | [`PORT_CONTROL`] | [`ControlFrame`] both ways | one persistent connection |
//! | [`PORT_HANDS`] | one [`HandsRequest`] → [`HandsResponse`]s | one connection per call |
//! | [`PORT_INGRESS`] | one [`IngressRequest`] → [`IngressResponse`], then raw TCP or framed PTY | one connection per stream |

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::{AgentId, Epoch, ErrorBody, SandboxId, TimestampMs};

/// Version carried in [`ControlBody::Hello`] and [`HandsRequest::protocol_version`].
pub const PROTOCOL_VERSION: u32 = 1;

/// Guest context ID configured on every Firecracker VM (the host is always CID 2).
pub const GUEST_CID: u32 = 3;
/// Persistent control channel: lifecycle, agent slots, port events, CLI relay.
pub const PORT_CONTROL: u32 = 1024;
/// Hands RPC, one connection per tool call.
pub const PORT_HANDS: u32 = 1025;
/// Ingress: previews, `nest port-forward`, terminal PTYs.
pub const PORT_INGRESS: u32 = 10000;

/// Unix socket inside the guest where the `nest` CLI reaches the guest agent (same framing,
/// [`CliRequest`] → [`CliResponse`]).
pub const GUEST_CLI_SOCKET: &str = "/run/nest/guest.sock";

// ---------------------------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------------------------

/// Length-prefixed frames: `[u32 BE len][u8 kind][payload; len-1]`, where `len` counts the
/// kind byte plus the payload.
pub mod frame {
    /// Upper bound on `len` (kind byte + payload). Larger frames are a protocol error.
    pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

    /// What the payload of a frame is.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    #[repr(u8)]
    pub enum Kind {
        /// UTF-8 JSON object (one message).
        Json = 0x00,
        /// Opaque bytes; meaning depends on the channel (PTY data).
        Data = 0x01,
    }

    impl Kind {
        pub fn from_u8(b: u8) -> Option<Kind> {
            match b {
                0x00 => Some(Kind::Json),
                0x01 => Some(Kind::Data),
                _ => None,
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Frame {
        pub kind: Kind,
        pub payload: Vec<u8>,
    }

    #[derive(Debug, PartialEq, Eq)]
    pub enum FrameError {
        TooLarge(u32),
        Empty,
        UnknownKind(u8),
        /// A message too short to hold a header and a kind byte.
        Short(usize),
        /// A message whose length isn't its frame's (more than one frame, or a partial one).
        LengthMismatch { len: u32, message: usize },
    }

    impl std::fmt::Display for FrameError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                FrameError::TooLarge(n) => write!(f, "frame length {n} exceeds {MAX_FRAME_LEN}"),
                FrameError::Empty => f.write_str("frame length 0 (missing kind byte)"),
                FrameError::UnknownKind(k) => write!(f, "unknown frame kind 0x{k:02x}"),
                FrameError::Short(n) => write!(f, "binary message of {n} bytes is not a frame"),
                FrameError::LengthMismatch { len, message } => {
                    write!(f, "frame length {len} does not match a message of {message} bytes")
                }
            }
        }
    }

    /// Largest WebSocket message that carries one frame (the gateway's).
    pub const MAX_WS_MESSAGE: usize = MAX_FRAME_LEN as usize + 4;

    /// `message` (one WebSocket message) as exactly one frame: its kind and payload. One frame
    /// per message, so no message can smuggle a second frame past the checks on the first.
    pub fn one_frame(message: &[u8]) -> Result<(Kind, &[u8]), FrameError> {
        if message.len() < 5 {
            return Err(FrameError::Short(message.len()));
        }
        let len = u32::from_be_bytes([message[0], message[1], message[2], message[3]]);
        if len > MAX_FRAME_LEN {
            return Err(FrameError::TooLarge(len));
        }
        if len as usize != message.len() - 4 {
            return Err(FrameError::LengthMismatch { len, message: message.len() });
        }
        let kind = Kind::from_u8(message[4]).ok_or(FrameError::UnknownKind(message[4]))?;
        Ok((kind, &message[5..]))
    }

    impl std::error::Error for FrameError {}

    /// Encode one frame.
    pub fn encode(kind: Kind, payload: &[u8]) -> Result<Vec<u8>, FrameError> {
        let len = u32::try_from(payload.len() + 1).map_err(|_| FrameError::TooLarge(u32::MAX))?;
        if len > MAX_FRAME_LEN {
            return Err(FrameError::TooLarge(len));
        }
        let mut out = Vec::with_capacity(payload.len() + 5);
        out.extend_from_slice(&len.to_be_bytes());
        out.push(kind as u8);
        out.extend_from_slice(payload);
        Ok(out)
    }

    /// Encode a JSON message frame.
    pub fn encode_json<T: serde::Serialize>(msg: &T) -> Result<Vec<u8>, FrameError> {
        let body = serde_json::to_vec(msg).expect("protocol types always serialize");
        encode(Kind::Json, &body)
    }

    /// The length of the kind byte plus payload that a frame header announces, if it is allowed.
    fn body_len(hdr: [u8; 4]) -> Result<usize, FrameError> {
        match u32::from_be_bytes(hdr) {
            0 => Err(FrameError::Empty),
            len if len > MAX_FRAME_LEN => Err(FrameError::TooLarge(len)),
            len => Ok(len as usize),
        }
    }

    /// Incremental decoder: push bytes as they arrive, pop complete frames.
    #[derive(Default)]
    pub struct Decoder {
        buf: Vec<u8>,
    }

    impl Decoder {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn push(&mut self, bytes: &[u8]) {
            self.buf.extend_from_slice(bytes);
        }

        /// Next complete frame, `Ok(None)` if more bytes are needed.
        pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
            if self.buf.len() < 4 {
                return Ok(None);
            }
            let total = 4 + body_len([self.buf[0], self.buf[1], self.buf[2], self.buf[3]])?;
            if self.buf.len() < total {
                return Ok(None);
            }
            let kind = Kind::from_u8(self.buf[4]).ok_or(FrameError::UnknownKind(self.buf[4]))?;
            let payload = self.buf[5..total].to_vec();
            self.buf.drain(..total);
            Ok(Some(Frame { kind, payload }))
        }

        /// Bytes received after the last complete frame. Used when a channel switches to raw
        /// mode (ingress TCP): anything already buffered belongs to the raw stream.
        pub fn into_remainder(self) -> Vec<u8> {
            self.buf
        }
    }

    /// Blocking read of exactly one frame (async users have [`super::framed`]).
    pub fn read_frame<R: std::io::Read>(r: &mut R) -> std::io::Result<Frame> {
        let mut hdr = [0u8; 4];
        r.read_exact(&mut hdr)?;
        let len = body_len(hdr).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut body = vec![0u8; len];
        r.read_exact(&mut body)?;
        let kind = Kind::from_u8(body[0])
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, FrameError::UnknownKind(body[0])))?;
        body.remove(0);
        Ok(Frame { kind, payload: body })
    }

    /// Blocking write of one frame.
    pub fn write_frame<W: std::io::Write>(w: &mut W, kind: Kind, payload: &[u8]) -> std::io::Result<()> {
        let bytes = encode(kind, payload).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
        w.write_all(&bytes)
    }
}

/// [`frame`]s over tokio streams.
#[cfg(feature = "tokio")]
pub mod framed {
    use std::io;

    use serde::Serialize;
    use serde::de::DeserializeOwned;
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    use super::frame::{self, Decoder, Frame, Kind};

    /// Reads frames from an async byte stream. Cancel-safe: bytes read are kept in the decoder,
    /// so a frame that arrives while `next` is dropped is returned by the next call.
    pub struct FramedReader<R> {
        inner: R,
        dec: Decoder,
        buf: Vec<u8>,
    }

    impl<R: AsyncRead + Unpin> FramedReader<R> {
        pub fn new(inner: R) -> Self {
            Self::with_buffered(inner, &[])
        }

        /// A reader whose stream begins with `buffered`, bytes already read from `inner`.
        pub fn with_buffered(inner: R, buffered: &[u8]) -> Self {
            let mut dec = Decoder::new();
            dec.push(buffered);
            Self { inner, dec, buf: vec![0; 64 << 10] }
        }

        /// The next frame, or `None` on a clean EOF between frames. A malformed frame is
        /// `InvalidData`.
        pub async fn next(&mut self) -> io::Result<Option<Frame>> {
            loop {
                if let Some(f) = self.dec.next_frame().map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))? {
                    return Ok(Some(f));
                }
                let n = self.inner.read(&mut self.buf).await?;
                if n == 0 {
                    return Ok(None);
                }
                self.dec.push(&self.buf[..n]);
            }
        }

        /// The next frame as a JSON message; a `DATA` frame or invalid JSON is `InvalidData`.
        pub async fn next_json<T: DeserializeOwned>(&mut self) -> io::Result<Option<T>> {
            let Some(f) = self.next().await? else { return Ok(None) };
            if f.kind != Kind::Json {
                return Err(io::Error::new(io::ErrorKind::InvalidData, "expected a JSON frame"));
            }
            serde_json::from_slice(&f.payload).map(Some).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
        }

        /// The stream and any bytes already read past the last frame (a switch to raw mode).
        pub fn into_parts(self) -> (R, Vec<u8>) {
            (self.inner, self.dec.into_remainder())
        }
    }

    /// Write and flush one frame.
    pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, kind: Kind, payload: &[u8]) -> io::Result<()> {
        let bytes = frame::encode(kind, payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;
        w.write_all(&bytes).await?;
        w.flush().await
    }

    pub async fn write_json<W: AsyncWrite + Unpin, T: Serialize>(w: &mut W, msg: &T) -> io::Result<()> {
        write(w, Kind::Json, &serde_json::to_vec(msg).expect("protocol types always serialize")).await
    }
}

/// Firecracker hybrid-vsock handshake, also spoken by the test emulator.
///
/// Host → guest: connect to the VM's vsock unix socket, send `CONNECT <port>\n`, read
/// `OK <host_port>\n`. Firecracker closes the connection if nothing listens on `<port>`.
/// Guest → host connections are not used by this protocol.
pub mod handshake {
    /// Line the host writes after connecting to the hybrid-vsock unix socket.
    pub fn connect_line(port: u32) -> String {
        format!("CONNECT {port}\n")
    }

    /// Parse the host's request line (emulator/guest side). Accepts with or without `\n`.
    pub fn parse_connect_line(line: &str) -> Option<u32> {
        line.trim_end_matches('\n').strip_prefix("CONNECT ")?.parse().ok()
    }

    /// Line the emulator writes back on success; `assigned` is the ephemeral host-side port.
    pub fn ok_line(assigned: u32) -> String {
        format!("OK {assigned}\n")
    }

    /// Parse Firecracker's reply. Returns the host-side port number.
    pub fn parse_ok_line(line: &str) -> Option<u32> {
        line.trim_end_matches('\n').strip_prefix("OK ")?.parse().ok()
    }
}

// ---------------------------------------------------------------------------------------------
// Control channel (port 1024)
// ---------------------------------------------------------------------------------------------

/// Envelope for every control-channel message. Requests carry `id`; replies carry `reply_to`;
/// unsolicited events carry neither.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ControlFrame {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<u64>,
    #[serde(flatten)]
    pub body: ControlBody,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlBody {
    // --- guest → host -------------------------------------------------------------------------
    /// First message on every control connection, sent by the guest.
    Hello {
        protocol_version: u32,
        agent_version: String,
        /// Random per boot. Unchanged after a memory-snapshot restore, which is how the host
        /// tells "resumed" from "rebooted".
        boot_id: String,
        /// Random per guest-agent process. Same `boot_id` + new `instance_id` = the agent process
        /// restarted within the same boot (nestd re-sends `configure`, not `resume`); same
        /// `boot_id` + same `instance_id` = a memory-snapshot restore (nestd sends `resume`).
        instance_id: String,
        since_boot_ms: u64,
        #[serde(default)]
        capabilities: Vec<String>,
    },
    /// Full set of listening sockets, sent after `configure` and on every change (debounced).
    Ports { listening: Vec<ListeningPort>, ts_ms: TimestampMs },
    /// Relay of a `nest` CLI command run by a program inside the sandbox. Request (has `id`).
    Cli {
        /// From `NEST_AGENT_ID` of the calling process. Attribution only, not authenticated.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        command: CliCommand,
    },
    /// A background task finished or hit its time limit (agent may poll with `TaskOutput`).
    TaskExited { agent_id: AgentId, task: TaskInfo },

    // --- host → guest (requests, have `id`) ---------------------------------------------------
    /// Identity and agent slots. Sent after every hello, and again whenever they change.
    Configure {
        sandbox_id: SandboxId,
        epoch: Epoch,
        hostname: String,
        /// Complete set; agents absent here are detached (processes left alone; use `agent_detach`).
        agents: Vec<AgentSlot>,
    },
    AgentAttach { slot: AgentSlot },
    AgentDetach {
        agent_id: AgentId,
        /// `true`: `cgroup.kill` the agent's whole cgroup, including background tasks.
        kill_processes: bool,
    },
    /// After any memory-snapshot restore. Fixes clock and randomness; on a fork, also identity.
    Resume {
        wall_clock_ms: TimestampMs,
        /// 64 random bytes from the host, mixed into the guest RNG (`RNDADDENTROPY`).
        entropy_b64: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fork: Option<ForkIdentity>,
    },
    /// Before a snapshot or commit: `sync`, then optionally `drop_caches`.
    PrepareSnapshot {
        drop_caches: bool,
        /// Deprecated: accepted and ignored. Guests no longer freeze filesystems (removed until
        /// memory snapshots are built); every guest has defaulted it, so it is sent only if set.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        fsfreeze: Vec<String>,
    },
    /// Deprecated no-op (nothing is frozen any more): answered `ok`.
    Thaw {},
    Health {},
    /// Reply to a guest `cli` request.
    CliResult { result: CliResult },

    // --- replies ------------------------------------------------------------------------------
    /// Generic success reply.
    Ok {},
    ResumeDone { clock_step_ms: i64 },
    HealthReport { report: HealthReport },
    Error { error: ErrorBody },
}

/// Per-agent execution context inside the sandbox.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSlot {
    pub agent_id: AgentId,
    /// Explicit-proxy listener for this agent on 172.16.0.1; becomes `HTTP(S)_PROXY`.
    pub proxy_port: u16,
    /// Initial working directory for `Bash` (absolute).
    pub cwd: String,
    /// Extra environment for every exec (after the base env, before per-call env).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// cgroup v2 `memory.max` for the agent's subtree; `None` = unlimited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_max_bytes: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkIdentity {
    pub new_sandbox_id: SandboxId,
    pub hostname: String,
    /// 32 lowercase hex chars written to `/etc/machine-id`.
    pub machine_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListeningPort {
    pub port: u16,
    pub proto: PortProto,
    /// `loopback`, `any`, or a specific address such as `172.16.0.2`.
    pub bind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortProto {
    Tcp,
    Tcp6,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HealthReport {
    pub uptime_ms: u64,
    pub load1: f64,
    pub mem_total_kb: u64,
    pub mem_available_kb: u64,
    pub disks: Vec<DiskUsage>,
    pub agents: Vec<AgentUsage>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiskUsage {
    pub mount: String,
    pub total_bytes: u64,
    pub avail_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentUsage {
    pub agent_id: AgentId,
    pub running_calls: u32,
    pub background_tasks: u32,
    /// From the agent cgroup's `cpu.stat` (`usage_usec`).
    pub cpu_usage_usec: u64,
    pub memory_current_bytes: u64,
}

// ---------------------------------------------------------------------------------------------
// CLI relay (`nest` inside the sandbox → guest socket → control channel → host)
// ---------------------------------------------------------------------------------------------

/// Sent by the `nest` CLI to [`GUEST_CLI_SOCKET`] (one JSON frame per connection).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CliRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentId>,
    pub command: CliCommand,
}

/// Reply on [`GUEST_CLI_SOCKET`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CliResponse {
    pub result: CliResult,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum CliCommand {
    /// `notify`, `emit` and `ask` are no longer offered by the `nest` CLI: the tools behind them left
    /// the platform. Kept so a guest of the previous release still parses; the control plane answers
    /// each with `unknown_tool`. Removed once no guest of that release runs.
    Notify {
        to: String,
        message: String,
        #[serde(default)]
        urgency: Urgency,
    },
    /// See `Notify`.
    Emit {
        event: String,
        #[serde(default)]
        payload: serde_json::Value,
    },
    /// See `Notify`.
    Ask {
        question: String,
        #[serde(default)]
        options: Vec<String>,
        #[serde(default = "default_ask_wait")]
        wait_s: u32,
    },
    /// `nest expose <port>` / `nest unexpose <port>`
    Expose { port: u16, exposed: bool },
    /// `nest whoami`: answered by the guest agent locally (no host round trip).
    Whoami {},
}

fn default_ask_wait() -> u32 {
    120
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum Urgency {
    Low,
    #[default]
    Normal,
    High,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CliResult {
    Ok {
        #[serde(default)]
        data: serde_json::Value,
    },
    /// `ask` answered within the wait.
    Answered { answer: String },
    /// `ask` not answered in time; the answer arrives as the agent's next turn input.
    Pending { question_id: String },
    Error { error: ErrorBody },
}

// ---------------------------------------------------------------------------------------------
// Hands RPC (port 1025): one connection per call
// ---------------------------------------------------------------------------------------------

/// First (and only) host frame on a hands connection, except an optional later
/// [`HandsCancel`]. Closing the connection before the result also cancels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HandsRequest {
    pub protocol_version: u32,
    /// Unique per call (the MCP `tools/call` id is a fine source); used for cgroup and file names.
    pub call_id: String,
    pub agent_id: AgentId,
    /// Must equal the epoch of the last `configure`; otherwise `stale_epoch`.
    pub epoch: Epoch,
    /// The tool input, tagged with the tool name. Field names match the MCP tool schemas in
    /// `protocol/schemas/guest/hands-tools.json` so the runner forwards inputs verbatim.
    pub op: HandsOp,
}

/// Host → guest, mid-call: interrupt the call (`cgroup.kill` on the call's cgroup).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HandsCancel {
    Cancel {},
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tool")]
pub enum HandsOp {
    Bash(BashInput),
    TaskOutput(TaskOutputInput),
    TaskStop(TaskStopInput),
    Read(ReadInput),
    Write(WriteInput),
    Edit(EditInput),
    Glob(GlobInput),
    Grep(GrepInput),
}

impl HandsOp {
    pub fn tool_name(&self) -> &'static str {
        match self {
            HandsOp::Bash(_) => "Bash",
            HandsOp::TaskOutput(_) => "TaskOutput",
            HandsOp::TaskStop(_) => "TaskStop",
            HandsOp::Read(_) => "Read",
            HandsOp::Write(_) => "Write",
            HandsOp::Edit(_) => "Edit",
            HandsOp::Glob(_) => "Glob",
            HandsOp::Grep(_) => "Grep",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BashInput {
    pub command: String,
    /// Milliseconds. Foreground default 120 000, max 600 000. With `run_in_background`, the
    /// background time limit: default 1 800 000, max 7 200 000.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub run_in_background: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskOutputInput {
    pub task_id: String,
    /// Wait for the task to exit (up to `timeout` ms) before returning.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub block: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskStopInput {
    pub task_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadInput {
    /// Absolute path.
    pub file_path: String,
    /// 1-based first line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// PDF page range such as `"1-5"` (max 20 pages per call).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriteInput {
    pub file_path: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditInput {
    pub file_path: String,
    pub old_string: String,
    pub new_string: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub replace_all: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GlobInput {
    pub pattern: String,
    /// Directory to search; default the agent's current `Bash` cwd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrepOutputMode {
    Content,
    #[default]
    FilesWithMatches,
    Count,
}

/// Field names follow Claude Code's built-in Grep, including the dashed flag names.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrepInput {
    pub pattern: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub glob: Option<String>,
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_mode: Option<GrepOutputMode>,
    #[serde(default, rename = "-i", skip_serializing_if = "Option::is_none")]
    pub case_insensitive: Option<bool>,
    #[serde(default, rename = "-n", skip_serializing_if = "Option::is_none")]
    pub line_numbers: Option<bool>,
    #[serde(default, rename = "-A", skip_serializing_if = "Option::is_none")]
    pub after: Option<u32>,
    #[serde(default, rename = "-B", skip_serializing_if = "Option::is_none")]
    pub before: Option<u32>,
    #[serde(default, rename = "-C", skip_serializing_if = "Option::is_none")]
    pub context: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
    /// Max entries returned (lines, files, or counts depending on mode). Default 250.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head_limit: Option<u32>,
    /// Entries to skip before `head_limit` applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

/// Guest → host frames on a hands connection: optional `started`, then exactly one of
/// `result` / `error`, then the guest closes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HandsResponse {
    /// Process spawned (Bash only); lets the host show progress and know cancel will bite.
    Started { call_id: String },
    /// The tool ran. `is_error` follows MCP semantics (tool-level failure the model should see).
    Result { call_id: String, result: HandsResult },
    /// The call could not be executed (protocol, epoch, unknown agent). Not shown to the model
    /// verbatim; the runner maps it to an MCP error.
    Error { call_id: String, error: ErrorBody },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HandsResult {
    #[serde(default)]
    pub is_error: bool,
    /// What the model sees, in order. The runner maps this 1:1 to MCP `content`.
    pub content: Vec<ToolContent>,
    /// Structured facts for the runner, UI and state tracking. Never shown to the model.
    pub detail: HandsDetail,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolContent {
    Text { text: String },
    /// MCP image content (`{"type":"image","data":…,"mimeType":…}` on the MCP side).
    Image { media_type: String, data_b64: String },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tool")]
pub enum HandsDetail {
    Bash {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
        interrupted: bool,
        /// Set when the command was started in, or moved to, the background.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_id: Option<String>,
        /// Full combined output inside the sandbox (readable with `Read`).
        output_path: String,
        output_bytes: u64,
        /// Inline output was cut to fit the inline limit.
        truncated: bool,
        /// The agent's cwd after the command.
        cwd: String,
        duration_ms: u64,
    },
    TaskOutput { task: TaskInfo },
    TaskStop { task: TaskInfo },
    Read {
        /// `text`, `image`, `pdf`, `notebook`, `empty`.
        file_kind: String,
        total_lines: u64,
        partial: bool,
    },
    Write { created: bool, bytes: u64 },
    Edit {
        replacements: u32,
        /// The file changed on disk since this agent last read it (edit still applied because
        /// `old_string` matched current content unambiguously).
        changed_since_read: bool,
    },
    Glob { num_files: u32, truncated: bool },
    Grep { num_entries: u32, truncated: bool },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskInfo {
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output_path: String,
    pub output_bytes: u64,
    pub started_ms: TimestampMs,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_ms: Option<TimestampMs>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Exited,
    Killed,
    /// Stopped after reaching its background time limit.
    TimedOut,
}

// ---------------------------------------------------------------------------------------------
// Ingress (port 10000): one connection per stream
// ---------------------------------------------------------------------------------------------

/// First host frame on an ingress connection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum IngressRequest {
    /// Preview / port-forward. After `accepted`, both sides switch to raw bytes.
    Tcp { port: u16 },
    /// Terminal. Stays framed: `Data` frames carry PTY bytes both ways, JSON frames carry
    /// [`PtyControl`].
    Pty {
        /// Runs in this agent's context (cwd, env, cgroup); `None` = plain user shell.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<AgentId>,
        cols: u16,
        rows: u16,
        /// Default: the user's login shell.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        command: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum IngressResponse {
    /// TCP: the address that accepted (`127.0.0.1:3000` or `172.16.0.2:3000`). PTY: the pid.
    Accepted {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connected: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pid: Option<u32>,
    },
    Rejected { error: ErrorBody },
}

/// JSON frames on a PTY ingress stream (data travels in `Data` frames).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PtyControl {
    /// Host → guest.
    Resize { cols: u16, rows: u16 },
    /// Host → guest: deliver a signal to the PTY's foreground process group (e.g. `INT`).
    Signal { signal: String },
    /// Guest → host: the shell exited; the guest closes after this frame.
    Exit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signal: Option<i32>,
    },
}

// ---------------------------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------------------------

/// `ErrorBody::code` values used on this boundary.
pub mod error_code {
    pub const BAD_REQUEST: &str = "bad_request";
    pub const UNSUPPORTED_VERSION: &str = crate::model::error_codes::UNSUPPORTED_VERSION;
    pub const STALE_EPOCH: &str = crate::model::error_codes::STALE_EPOCH;
    pub const UNKNOWN_AGENT: &str = crate::model::error_codes::UNKNOWN_AGENT;
    pub const UNKNOWN_TASK: &str = "unknown_task";
    pub const CONNECT_REFUSED: &str = "connect_refused";
    pub const BUSY: &str = "busy";
    pub const INTERNAL: &str = crate::model::error_codes::INTERNAL;
}

// ---------------------------------------------------------------------------------------------
// Fixture coverage lists (kept in sync with the enums; tests enforce fixture ↔ list)
// ---------------------------------------------------------------------------------------------

/// Every [`ControlBody`] tag. Each has `protocol/fixtures/guest/control/<tag>.json`.
pub const CONTROL_TYPES: &[&str] = &[
    "hello", "ports", "cli", "task_exited", "configure", "agent_attach", "agent_detach", "resume",
    "prepare_snapshot", "thaw", "health", "cli_result", "ok", "resume_done", "health_report", "error",
];
/// Every [`HandsOp`] tool. Each has `protocol/fixtures/guest/hands/request_<Tool>.json`.
pub const HANDS_TOOLS: &[&str] = &["Bash", "TaskOutput", "TaskStop", "Read", "Write", "Edit", "Glob", "Grep"];
/// Every [`HandsResponse`] tag. Each has `protocol/fixtures/guest/hands/response_<tag>*.json`.
pub const HANDS_RESPONSE_TYPES: &[&str] = &["started", "result", "error"];
/// Every [`CliCommand`]. Each has `protocol/fixtures/guest/cli/request_<command>.json`.
pub const CLI_COMMANDS: &[&str] = &["notify", "emit", "ask", "expose", "whoami"];
/// Every [`CliResult`] status. Each has `protocol/fixtures/guest/cli/response_<status>.json`.
pub const CLI_RESULTS: &[&str] = &["ok", "answered", "pending", "error"];
/// Every [`IngressRequest`] mode / [`IngressResponse`] / [`PtyControl`] tag, under
/// `protocol/fixtures/guest/ingress/`.
pub const INGRESS_REQUESTS: &[&str] = &["tcp", "pty"];
pub const INGRESS_RESPONSES: &[&str] = &["accepted", "rejected"];
pub const PTY_CONTROLS: &[&str] = &["resize", "signal", "exit"];

#[cfg(test)]
mod tests {
    use super::frame::{Decoder, Kind};
    use super::*;
    use std::collections::BTreeSet;
    use std::path::{Path, PathBuf};

    fn fixtures(sub: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/guest").join(sub)
    }

    /// Load every `*.json` in a fixture dir, round-trip through `T`, return (file stem, value).
    fn roundtrip_dir<T>(sub: &str, prefix: &str) -> Vec<(String, T)>
    where
        T: serde::de::DeserializeOwned + Serialize,
    {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(fixtures(sub)).expect("fixture dir") {
            let path = entry.unwrap().path();
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            if path.extension().and_then(|e| e.to_str()) != Some("json") || !stem.starts_with(prefix) {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let original: serde_json::Value = serde_json::from_str(&text).unwrap();
            let parsed: T = serde_json::from_value(original.clone())
                .unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let back = serde_json::to_value(&parsed).unwrap();
            assert_eq!(original, back, "{} does not round-trip", path.display());
            out.push((stem, parsed));
        }
        out
    }

    fn assert_covers(seen: BTreeSet<String>, expected: &[&str], what: &str) {
        let expected: BTreeSet<String> = expected.iter().map(|s| s.to_string()).collect();
        assert_eq!(seen, expected, "{what}: fixtures and coverage list differ");
    }

    fn tag_of(v: &impl Serialize, key: &str) -> String {
        serde_json::to_value(v).unwrap()[key].as_str().unwrap().to_string()
    }

    /// `fsfreeze` is deprecated: an older host's list still parses, and an empty one isn't sent.
    #[test]
    fn prepare_snapshot_fsfreeze_is_optional_and_omitted_when_empty() {
        let old: ControlBody = serde_json::from_str(r#"{"type":"prepare_snapshot","drop_caches":true,"fsfreeze":["/workspace"]}"#).unwrap();
        assert!(matches!(old, ControlBody::PrepareSnapshot { drop_caches: true, ref fsfreeze } if fsfreeze == &["/workspace"]));
        let new = ControlBody::PrepareSnapshot { drop_caches: false, fsfreeze: Vec::new() };
        let wire = serde_json::to_value(&new).unwrap();
        assert_eq!(wire, serde_json::json!({"type": "prepare_snapshot", "drop_caches": false}));
        assert_eq!(serde_json::from_value::<ControlBody>(wire).unwrap(), new);
    }

    #[test]
    fn control_fixtures() {
        let seen = roundtrip_dir::<ControlFrame>("control", "")
            .iter()
            .map(|(stem, f)| {
                let tag = tag_of(&f.body, "type");
                assert_eq!(stem, &tag, "control fixture file name must equal its type");
                tag
            })
            .collect();
        assert_covers(seen, CONTROL_TYPES, "control");
    }

    #[test]
    fn hands_fixtures() {
        let reqs = roundtrip_dir::<HandsRequest>("hands", "request_");
        let seen = reqs.iter().map(|(_, r)| r.op.tool_name().to_string()).collect();
        assert_covers(seen, HANDS_TOOLS, "hands requests");
        let resps = roundtrip_dir::<HandsResponse>("hands", "response_");
        assert_covers(resps.iter().map(|(_, r)| tag_of(r, "type")).collect(), HANDS_RESPONSE_TYPES, "hands responses");
        let cancel = roundtrip_dir::<HandsCancel>("hands", "cancel");
        assert_eq!(cancel.len(), 1);
    }

    #[test]
    fn cli_fixtures() {
        let reqs = roundtrip_dir::<CliRequest>("cli", "request_");
        assert_covers(reqs.iter().map(|(_, r)| tag_of(&r.command, "command")).collect(), CLI_COMMANDS, "cli requests");
        let resps = roundtrip_dir::<CliResponse>("cli", "response_");
        assert_covers(resps.iter().map(|(_, r)| tag_of(&r.result, "status")).collect(), CLI_RESULTS, "cli responses");
    }

    #[test]
    fn ingress_fixtures() {
        let reqs = roundtrip_dir::<IngressRequest>("ingress", "request_");
        assert_covers(reqs.iter().map(|(_, r)| tag_of(r, "mode")).collect(), INGRESS_REQUESTS, "ingress requests");
        let resps = roundtrip_dir::<IngressResponse>("ingress", "response_");
        assert_covers(resps.iter().map(|(_, r)| tag_of(r, "type")).collect(), INGRESS_RESPONSES, "ingress responses");
        let pty = roundtrip_dir::<PtyControl>("ingress", "pty_");
        assert_covers(pty.iter().map(|(_, r)| tag_of(r, "type")).collect(), PTY_CONTROLS, "pty controls");
    }

    #[test]
    fn hands_tool_schemas_match_ops() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/schemas/guest/hands-tools.json");
        let tools: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let names: BTreeSet<String> = tools["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_covers(names, HANDS_TOOLS, "hands-tools.json");
        // Every schema property must be accepted by the corresponding Rust input type.
        for t in tools["tools"].as_array().unwrap() {
            let props = t["inputSchema"]["properties"].as_object().unwrap();
            let required: Vec<&str> =
                t["inputSchema"]["required"].as_array().unwrap().iter().map(|r| r.as_str().unwrap()).collect();
            let mut input = serde_json::Map::new();
            input.insert("tool".into(), t["name"].clone());
            for (k, schema) in props {
                let sample = match schema["type"].as_str().unwrap() {
                    "string" => schema
                        .get("enum")
                        .and_then(|e| e[0].as_str())
                        .map(|s| serde_json::json!(s))
                        .unwrap_or(serde_json::json!("x")),
                    "integer" | "number" => serde_json::json!(1),
                    "boolean" => serde_json::json!(true),
                    other => panic!("unexpected schema type {other}"),
                };
                input.insert(k.clone(), sample);
            }
            let op: HandsOp = serde_json::from_value(serde_json::Value::Object(input.clone()))
                .unwrap_or_else(|e| panic!("{}: schema not accepted by HandsOp: {e}", t["name"]));
            let back = serde_json::to_value(&op).unwrap();
            for k in props.keys() {
                assert!(back.get(k).is_some(), "{}: property {k} dropped by HandsOp", t["name"]);
            }
            for r in required {
                assert!(props.contains_key(r));
            }
        }
    }

    #[test]
    fn frame_roundtrip_and_partial() {
        let a = frame::encode_json(&HandsCancel::Cancel {}).unwrap();
        let b = frame::encode(Kind::Data, b"\x00\xffpty").unwrap();
        let mut all = a.clone();
        all.extend_from_slice(&b);
        all.extend_from_slice(b"RAW");
        let mut d = Decoder::new();
        for chunk in all.chunks(3) {
            d.push(chunk);
        }
        let f1 = d.next_frame().unwrap().unwrap();
        assert_eq!(f1.kind, Kind::Json);
        let c: HandsCancel = serde_json::from_slice(&f1.payload).unwrap();
        assert_eq!(c, HandsCancel::Cancel {});
        let f2 = d.next_frame().unwrap().unwrap();
        assert_eq!((f2.kind, f2.payload.as_slice()), (Kind::Data, &b"\x00\xffpty"[..]));
        // "RAW" is 3 bytes: not a full header, so it stays buffered for raw mode.
        assert_eq!(d.next_frame().unwrap(), None);
        assert_eq!(d.into_remainder(), b"RAW");
    }

    #[test]
    fn frame_errors() {
        let mut d = Decoder::new();
        d.push(&[0, 0, 0, 0]);
        assert_eq!(d.next_frame(), Err(frame::FrameError::Empty));
        let mut d = Decoder::new();
        d.push(&(frame::MAX_FRAME_LEN + 1).to_be_bytes());
        assert!(matches!(d.next_frame(), Err(frame::FrameError::TooLarge(_))));
        let mut d = Decoder::new();
        d.push(&[0, 0, 0, 1, 0x7f]);
        assert_eq!(d.next_frame(), Err(frame::FrameError::UnknownKind(0x7f)));
    }

    #[test]
    fn std_io_frames() {
        let mut buf = Vec::new();
        frame::write_frame(&mut buf, Kind::Json, br#"{"type":"thaw"}"#).unwrap();
        let f = frame::read_frame(&mut std::io::Cursor::new(buf)).unwrap();
        assert_eq!(f.payload, br#"{"type":"thaw"}"#);
    }

    #[test]
    fn handshake_lines() {
        assert_eq!(handshake::connect_line(PORT_HANDS), "CONNECT 1025\n");
        assert_eq!(handshake::parse_connect_line("CONNECT 10000\n"), Some(10000));
        assert_eq!(handshake::parse_connect_line("CONNECT x\n"), None);
        assert_eq!(handshake::parse_ok_line(&handshake::ok_line(1073741824)), Some(1073741824));
        assert_eq!(handshake::parse_ok_line("ERR\n"), None);
    }
}
