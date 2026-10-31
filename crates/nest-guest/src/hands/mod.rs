//! Hands RPC (port 1025): one connection per tool call.

pub mod bash;
pub mod files;
pub mod glob;
pub mod grep;
pub mod read;

use std::sync::Arc;
use std::time::Duration;

use nest_protocol::guest::{
    HandsCancel, HandsDetail, HandsOp, HandsRequest, HandsResponse, HandsResult, PROTOCOL_VERSION, ToolContent,
    error_code,
};
use nest_protocol::model::{AgentId, ErrorBody};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::debug;

use crate::exec::AsUser;
use crate::framed::{FramedReader, err, parse_json, write_json};
use crate::state::{Gate, Guest};
use crate::transport::Conn;

/// Per-call context handed to tools.
pub struct CallCtx {
    pub call_id: String,
    pub agent_id: AgentId,
    pub cancel: CancellationToken,
    responses: mpsc::UnboundedSender<HandsResponse>,
}

impl CallCtx {
    /// Tell the host the process is running (Bash only).
    pub fn started(&self) {
        let _ = self.responses.send(HandsResponse::Started { call_id: self.call_id.clone() });
    }
}

pub async fn serve(guest: Arc<Guest>, conn: Conn) {
    let (rd, mut wr) = tokio::io::split(conn);
    let mut reader = FramedReader::new(rd);
    let req: HandsRequest = match reader.next().await {
        Ok(Some(f)) => match parse_json(&f) {
            Ok(r) => r,
            Err(e) => {
                let _ = write_json(&mut wr, &HandsResponse::Error { call_id: String::new(), error: e }).await;
                return;
            }
        },
        _ => return,
    };
    let call_id = req.call_id.clone();
    if let Err(e) = validate(&guest, &req) {
        let _ = write_json(&mut wr, &HandsResponse::Error { call_id, error: e }).await;
        return;
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<HandsResponse>();
    let writer = tokio::spawn(async move {
        while let Some(resp) = rx.recv().await {
            let last = !matches!(resp, HandsResponse::Started { .. });
            if write_json(&mut wr, &resp).await.is_err() || last {
                break;
            }
        }
    });
    let cancel = CancellationToken::new();
    let watcher = {
        let cancel = cancel.clone();
        tokio::spawn(async move {
            // Any later frame must be `cancel`; EOF (hangup) also cancels.
            loop {
                match reader.next().await {
                    Ok(Some(f)) => {
                        if parse_json::<HandsCancel>(&f).is_ok() {
                            cancel.cancel();
                        }
                    }
                    _ => {
                        cancel.cancel();
                        return;
                    }
                }
            }
        })
    };

    let ctx = CallCtx { call_id: call_id.clone(), agent_id: req.agent_id.clone(), cancel, responses: tx.clone() };
    set_running(&guest, &req.agent_id, 1);
    debug!(call_id, tool = req.op.tool_name(), "hands call");
    let outcome = run_tool(&guest, req.op, &ctx).await;
    set_running(&guest, &req.agent_id, -1);
    let resp = match outcome {
        Ok(result) => HandsResponse::Result { call_id, result },
        Err(error) => HandsResponse::Error { call_id, error },
    };
    let _ = tx.send(resp);
    drop(tx);
    drop(ctx);
    let _ = writer.await;
    watcher.abort();
}

fn set_running(guest: &Guest, agent: &AgentId, delta: i32) {
    if let Some(rt) = guest.inner.lock().unwrap().agents.get_mut(agent) {
        rt.running_calls = rt.running_calls.saturating_add_signed(delta);
    }
}

fn validate(guest: &Guest, req: &HandsRequest) -> Result<(), ErrorBody> {
    if req.protocol_version != PROTOCOL_VERSION {
        return Err(err(
            error_code::UNSUPPORTED_VERSION,
            format!("protocol_version {} != {PROTOCOL_VERSION}", req.protocol_version),
            false,
        ));
    }
    guest.inner.lock().unwrap().admit(Gate::Hands { epoch: req.epoch, agent: &req.agent_id }).map(|_| ())
}

/// Upper bound for one in-process file tool call (Read/Write/Edit/Glob). The blocking thread is
/// abandoned at the deadline; inputs that could block forever (FIFOs, devices) are refused up front.
pub const FILE_TOOL_DEADLINE: Duration = Duration::from_secs(120);

async fn run_tool(guest: &Arc<Guest>, op: HandsOp, ctx: &CallCtx) -> Result<HandsResult, ErrorBody> {
    match op {
        HandsOp::Bash(i) => bash::run(guest, i, ctx).await,
        HandsOp::TaskOutput(i) => bash::task_output(guest, &ctx.agent_id, i).await,
        HandsOp::TaskStop(i) => bash::task_stop(guest, &ctx.agent_id, i).await,
        HandsOp::Read(i) => {
            let d = HandsDetail::Read { file_kind: "text".into(), total_lines: 0, partial: true };
            blocking(guest, ctx, d, move |g, a, c| read::run(g, a, i, c)).await
        }
        HandsOp::Write(i) => {
            let d = HandsDetail::Write { created: false, bytes: 0 };
            blocking(guest, ctx, d, move |g, a, _| files::write(g, a, i)).await
        }
        HandsOp::Edit(i) => {
            let d = HandsDetail::Edit { replacements: 0, changed_since_read: false };
            blocking(guest, ctx, d, move |g, a, _| files::edit(g, a, i)).await
        }
        HandsOp::Glob(i) => {
            let d = HandsDetail::Glob { num_files: 0, truncated: false };
            blocking(guest, ctx, d, move |g, a, c| glob::run(g, a, i, c)).await
        }
        HandsOp::Grep(i) => grep::run(guest, &ctx.agent_id, i, ctx).await,
    }
}

/// Run a file tool on a blocking thread **as the sandbox user** (see [`AsUser`]), returning early
/// on cancel or at [`FILE_TOOL_DEADLINE`].
async fn blocking<F>(guest: &Arc<Guest>, ctx: &CallCtx, interrupted: HandsDetail, f: F) -> Result<HandsResult, ErrorBody>
where
    F: FnOnce(&Guest, &AgentId, &CancellationToken) -> Result<HandsResult, ErrorBody> + Send + 'static,
{
    let g = guest.clone();
    let a = ctx.agent_id.clone();
    let cancel = ctx.cancel.clone();
    let run_as = guest.config.run_as;
    let job = tokio::task::spawn_blocking(move || {
        let _identity = AsUser::enter(run_as)
            .map_err(|e| err(error_code::INTERNAL, format!("could not switch to the sandbox user: {e}"), false))?;
        f(&g, &a, &cancel)
    });
    tokio::select! {
        r = job => r.unwrap_or_else(|e| Err(err(error_code::INTERNAL, format!("tool panicked: {e}"), false))),
        _ = ctx.cancel.cancelled() => Ok(text(true, "[Interrupted]", interrupted)),
        _ = tokio::time::sleep(FILE_TOOL_DEADLINE) => Err(err(error_code::INTERNAL, format!("tool did not finish within {}s", FILE_TOOL_DEADLINE.as_secs()), true)),
    }
}

pub fn text(is_error: bool, text: impl Into<String>, detail: HandsDetail) -> HandsResult {
    HandsResult { is_error, content: vec![ToolContent::Text { text: text.into() }], detail }
}

/// The agent's current Bash cwd.
pub fn agent_cwd(guest: &Guest, agent: &AgentId) -> String {
    guest.inner.lock().unwrap().agents.get(agent).map(|a| a.cwd.clone()).unwrap_or_else(|| "/".into())
}

/// Resolve `path` (relative → against the agent's cwd).
pub fn resolve(guest: &Guest, agent: &AgentId, path: Option<&str>) -> std::path::PathBuf {
    let cwd = agent_cwd(guest, agent);
    match path {
        None | Some("") => cwd.into(),
        Some(p) if p.starts_with('/') => p.into(),
        Some(p) => std::path::Path::new(&cwd).join(p),
    }
}

/// Absolute path required (Read/Write/Edit).
pub fn require_absolute(p: &str) -> Result<std::path::PathBuf, ErrorBody> {
    if p.starts_with('/') {
        Ok(p.into())
    } else {
        Err(err(error_code::BAD_REQUEST, format!("file_path must be absolute, got {p:?}"), false))
    }
}
