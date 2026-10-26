//! Test doubles shared by this crate's unit tests and the end-to-end tests in `nest-cli`.
//! Not part of the runner's behavior.

use std::path::PathBuf;
use std::sync::Arc;

use nest_protocol::guest::{self, HandsDetail, HandsOp, HandsRequest, HandsResponse, HandsResult, ToolContent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::Mutex;

use crate::framing;

#[derive(Default)]
struct GuestLog {
    requests: Vec<HandsRequest>,
    cancelled: Vec<String>,
    /// The next this many requests are refused `busy` before anything runs (a snapshot freeze).
    busy_left: usize,
}

/// A fake guest agent behind a hybrid-vsock-style unix socket (`CONNECT 1025\n` → `OK n\n`).
///
/// Bash behavior: `sleep …` blocks until cancelled (or hangup); `hangup` closes the connection
/// without any reply (a guest that died mid-call); a command mentioning `CLAUDE.md` prints
/// `# Project rules`; anything else prints `ran: <command>`.
pub struct FakeGuest {
    pub path: String,
    log: Arc<Mutex<GuestLog>>,
    _dir: PathBuf,
}

impl FakeGuest {
    pub async fn start() -> Self {
        let dir = std::env::temp_dir().join(format!("nest-fake-guest-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("vsock.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let log: Arc<Mutex<GuestLog>> = Default::default();
        let l2 = log.clone();
        tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                tokio::spawn(serve(s, l2.clone()));
            }
        });
        Self { path: path.to_string_lossy().into_owned(), log, _dir: dir }
    }

    pub async fn requests(&self) -> Vec<HandsRequest> {
        self.log.lock().await.requests.clone()
    }

    pub async fn cancelled(&self) -> Vec<String> {
        self.log.lock().await.cancelled.clone()
    }

    /// Refuse the next `n` requests with the guest's own `busy` error (logged, never run), as
    /// the guest does while a snapshot freezes its filesystems.
    pub async fn refuse_busy(&self, n: usize) {
        self.log.lock().await.busy_left = n;
    }
}

async fn serve(mut s: tokio::net::UnixStream, log: Arc<Mutex<GuestLog>>) {
    let mut line = Vec::new();
    loop {
        let mut b = [0u8; 1];
        if s.read(&mut b).await.unwrap_or(0) == 0 {
            return;
        }
        line.push(b[0]);
        if b[0] == b'\n' {
            break;
        }
    }
    let port = guest::handshake::parse_connect_line(&String::from_utf8_lossy(&line));
    if port != Some(guest::PORT_HANDS) {
        return;
    }
    let _ = s.write_all(guest::handshake::ok_line(1_073_741_824).as_bytes()).await;
    let Ok(frame) = framing::read_guest(&mut s).await else { return };
    let Ok(req) = serde_json::from_slice::<HandsRequest>(&frame.payload) else { return };
    let call_id = req.call_id.clone();
    {
        let mut l = log.lock().await;
        l.requests.push(req.clone());
        if l.busy_left > 0 {
            l.busy_left -= 1;
            drop(l);
            let error = nest_protocol::model::ErrorBody {
                code: guest::error_code::BUSY.into(),
                message: "filesystems are frozen for a snapshot".into(),
                retryable: true,
            };
            let _ = framing::write_guest_json(&mut s, &HandsResponse::Error { call_id, error }).await;
            return;
        }
    }
    let reply = match &req.op {
        HandsOp::Bash(b) if b.command.starts_with("hangup") => return,
        HandsOp::Bash(b) if b.command.starts_with("sleep") => {
            let _ = framing::write_guest_json(&mut s, &HandsResponse::Started { call_id: call_id.clone() }).await;
            // Block until `cancel` or hangup.
            let _ = framing::read_guest(&mut s).await;
            log.lock().await.cancelled.push(call_id.clone());
            HandsResponse::Result { call_id, result: bash("interrupted", true, true) }
        }
        HandsOp::Bash(b) if b.command.contains("CLAUDE.md") => {
            HandsResponse::Result { call_id, result: bash("# Project rules\nUse tabs.", false, false) }
        }
        HandsOp::Bash(b) => HandsResponse::Result { call_id, result: bash(&format!("ran: {}", b.command), false, false) },
        other => HandsResponse::Result {
            call_id,
            result: HandsResult {
                is_error: false,
                content: vec![ToolContent::Text { text: format!("ok {}", other.tool_name()) }],
                detail: HandsDetail::Glob { num_files: 0, truncated: false },
            },
        },
    };
    let _ = framing::write_guest_json(&mut s, &reply).await;
}

fn bash(text: &str, is_error: bool, interrupted: bool) -> HandsResult {
    HandsResult {
        is_error,
        content: vec![ToolContent::Text { text: text.into() }],
        detail: HandsDetail::Bash {
            exit_code: Some(if is_error { 130 } else { 0 }),
            signal: None,
            interrupted,
            task_id: None,
            output_path: "/tmp/out".into(),
            output_bytes: text.len() as u64,
            truncated: false,
            cwd: "/workspace".into(),
            duration_ms: 1,
        },
    }
}

/// A real gateway in-process (feature `test-support`), fed directly instead of by nestd, with a
/// local signer standing in for the control plane. Tests of the hands path put a [`FakeGuest`]
/// behind it.
#[cfg(feature = "test-support")]
pub mod gateway {
    use std::collections::BTreeSet;
    use std::path::PathBuf;
    use std::sync::Arc;

    use nest_gateway::State;
    use nest_gateway::testing::Signer;
    use nest_protocol::gateway::{BINDING_VERSION, BindingClaims, BindingScope, GuestInfo, HandsTarget};
    use nest_protocol::model::{Epoch, SandboxId, Secret};

    pub struct TestGateway {
        /// `ws://127.0.0.1:<port>`, what a `HandsTarget.url` holds.
        pub url: String,
        pub state: Arc<State>,
        pub signer: Signer,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for TestGateway {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl TestGateway {
        pub async fn start() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("ws://{}", listener.local_addr().unwrap());
            let state = State::new();
            let signer = Signer::generate();
            state.set_key(&signer.kid(), &signer.public_key());
            let st = state.clone();
            let task = tokio::spawn(async move {
                let _ = nest_gateway::serve(listener, st).await;
            });
            Self { url, state, signer, task }
        }

        /// A sandbox whose guest is up (version 1), with these clients attached.
        pub fn add_sandbox(&self, sandbox: &str, epoch: u64, vsock_uds_path: &str, clients: &[&str]) {
            Self::configure(&self.state, sandbox, epoch, vsock_uds_path, clients);
        }

        /// A sandbox still booting: no guest info, so binds get `busy` until [`Self::configure`].
        pub fn add_sandbox_booting(&self, sandbox: &str, epoch: u64, vsock_uds_path: &str, clients: &[&str]) {
            self.state.upsert_sandbox(
                SandboxId(sandbox.into()),
                Epoch(epoch),
                PathBuf::from(vsock_uds_path),
                clients.iter().map(|c| c.to_string()).collect::<BTreeSet<_>>(),
                None,
            );
        }

        pub fn configure(state: &State, sandbox: &str, epoch: u64, vsock_uds_path: &str, clients: &[&str]) {
            state.upsert_sandbox(
                SandboxId(sandbox.into()),
                Epoch(epoch),
                PathBuf::from(vsock_uds_path),
                clients.iter().map(|c| c.to_string()).collect::<BTreeSet<_>>(),
                Some(GuestInfo { protocol_version: nest_protocol::guest::PROTOCOL_VERSION, capabilities: vec![] }),
            );
        }

        /// A target with a binding this gateway accepts (for the sandbox at `epoch`, if that is
        /// its current epoch) — what AgentDO's `hands_resolved` would carry.
        pub fn target(&self, sandbox: &str, epoch: u64, client: &str) -> HandsTarget {
            let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
            self.target_with_exp(sandbox, epoch, client, now + 3_600_000)
        }

        /// A target whose binding expires at `exp_ms` (in the past: the gateway refuses it as
        /// `unauthorized`, like a binding that aged out).
        pub fn target_with_exp(&self, sandbox: &str, epoch: u64, client: &str, exp_ms: i64) -> HandsTarget {
            let claims = BindingClaims {
                v: BINDING_VERSION,
                kid: self.signer.kid(),
                sandbox: SandboxId(sandbox.into()),
                epoch: Epoch(epoch),
                client: client.into(),
                scope: BindingScope::Hands,
                exp_ms,
                agent_epoch: None,
            };
            HandsTarget {
                url: self.url.clone(),
                // Only the claims name the sandbox and epoch, as AgentDO's answers will once the
                // previous release's unsigned copies go.
                sandbox: None,
                epoch: None,
                binding: Secret(self.signer.sign(&claims)),
                guest: GuestInfo { protocol_version: nest_protocol::guest::PROTOCOL_VERSION, capabilities: vec![] },
                edge: None,
            }
        }
    }
}
