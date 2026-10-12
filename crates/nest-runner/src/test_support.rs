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
}

/// A fake guest agent behind a hybrid-vsock-style unix socket (`CONNECT 1025\n` → `OK n\n`).
///
/// Bash behavior: `sleep …` blocks until cancelled (or hangup); a command mentioning
/// `CLAUDE.md` prints `# Project rules`; anything else prints `ran: <command>`.
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
    log.lock().await.requests.push(req.clone());
    let call_id = req.call_id.clone();
    let reply = match &req.op {
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
