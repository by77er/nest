//! Test doubles shared by this crate's unit tests and the end-to-end tests in `nest-cli`.
//! Not part of the runner's behavior.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nest_protocol::guest::{self, HandsDetail, HandsOp, HandsRequest, HandsResponse, HandsResult, ToolContent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::sync::Mutex;

use crate::framing;

/// Install `contents` as an executable (a fake `claude`) at `path` without this process ever
/// holding the file open for writing.
///
/// Tests run in parallel threads of one process and spawn children all the time. A file written
/// here (`std::fs::write`, `std::fs::copy`) has its write descriptor copied into any child another
/// thread forks meanwhile, until that child execs; running the file in that window fails with
/// ETXTBSY ("Text file busy"), so a fake binary written and run at once failed now and then (about
/// one lifecycle run in 15). Here the bytes go to a staging file that is never run, and `cp` (its
/// own process, which nothing forks) writes the executable.
pub fn install_executable(path: &Path, contents: impl AsRef<[u8]>) {
    let staging = PathBuf::from(format!("{}.staging", path.display()));
    std::fs::write(&staging, contents).unwrap();
    let st = std::process::Command::new("cp").arg(&staging).arg(path).status().unwrap();
    assert!(st.success(), "cp {} {}: {st}", staging.display(), path.display());
    std::fs::remove_file(&staging).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[derive(Default)]
pub struct GuestLog {
    requests: Vec<HandsRequest>,
    cancelled: Vec<String>,
    /// The next this many requests are refused `busy` before anything runs (a guest not configured yet).
    busy_left: usize,
    /// A paused VM: `CONNECT` is read and answered only once this is cleared.
    pub frozen: bool,
}

/// A fake guest agent behind a hybrid-vsock-style unix socket (`CONNECT 1025\n` → `OK n\n`).
///
/// Bash behavior: `sleep …` blocks until cancelled (or hangup); `hangup` closes the connection
/// without any reply (a guest that died mid-call); anything else prints `ran: <command>`.
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
    /// the guest does before nestd's `configure`.
    pub async fn refuse_busy(&self, n: usize) {
        self.log.lock().await.busy_left = n;
    }

    /// The guest's shared state, for a task that thaws it later (`frozen`).
    pub fn log_handle(&self) -> Arc<Mutex<GuestLog>> {
        self.log.clone()
    }

    /// Freeze or thaw the guest as a paused VM is: while frozen, a `CONNECT` gets no answer
    /// until the thaw (by which time the gateway has given up on it).
    pub async fn freeze(&self, frozen: bool) {
        self.log.lock().await.frozen = frozen;
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
    while log.lock().await.frozen {
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
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
                message: "guest not configured yet".into(),
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

        /// What nestd's `sandbox_upsert` says around a commit's pause: `Some(reason)` while the VM
        /// is paused (binds get `busy` at once), `None` once it runs again.
        pub fn set_paused(&self, sandbox: &str, epoch: u64, vsock_uds_path: &str, clients: &[&str], reason: Option<&str>) {
            self.state.upsert_sandbox_paused(
                SandboxId(sandbox.into()),
                Epoch(epoch),
                PathBuf::from(vsock_uds_path),
                clients.iter().map(|c| c.to_string()).collect::<BTreeSet<_>>(),
                Some(GuestInfo { protocol_version: nest_protocol::guest::PROTOCOL_VERSION, capabilities: vec![] }),
                reason.map(|r| nest_protocol::host::gateway_link::SandboxPause { reason: r.into() }),
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    /// The lifecycle flake made deterministic enough to own: while other threads spawn children
    /// nonstop, every freshly installed executable runs at once. A plain `std::fs::write` here
    /// fails with ETXTBSY within a few hundred tries.
    #[test]
    fn an_installed_executable_runs_at_once_while_other_threads_spawn() {
        let dir = tempfile::tempdir().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let spawners: Vec<_> = (0..4)
            .map(|_| {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        let _ = std::process::Command::new("true").status();
                    }
                })
            })
            .collect();
        let mut failed = None;
        for i in 0..400 {
            let bin = dir.path().join(format!("fake{i}"));
            install_executable(&bin, "#!/bin/sh\nexit 0\n");
            if let Err(e) = std::process::Command::new(&bin).status() {
                failed = Some((i, e));
                break;
            }
        }
        stop.store(true, Ordering::Relaxed);
        for t in spawners {
            t.join().unwrap();
        }
        assert!(failed.is_none(), "a just-installed executable could not be run: {failed:?}");
    }
}
