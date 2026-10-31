//! Control channel (port 1024): hello, configure, lifecycle requests, events, CLI relay replies.

use std::sync::Arc;
use std::time::Duration;

use nest_protocol::guest::{CliResult, ControlBody, ControlFrame, PROTOCOL_VERSION, error_code};
use nest_protocol::model::ErrorBody;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::framed::{FramedReader, err, parse_json, write_json};
use crate::events::event;
use crate::state::{Guest, Identity};
use crate::sys;
use crate::transport::Conn;

pub async fn serve(guest: Arc<Guest>, conn: Conn) {
    let (rd, mut wr) = tokio::io::split(conn);
    let (tx, mut rx) = mpsc::unbounded_channel::<ControlFrame>();
    let writer = tokio::spawn(async move {
        while let Some(f) = rx.recv().await {
            if write_json(&mut wr, &f).await.is_err() {
                break;
            }
        }
    });
    let hello = ControlBody::Hello {
        protocol_version: PROTOCOL_VERSION,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        boot_id: guest.boot_id.clone(),
        instance_id: guest.instance_id.clone(),
        since_boot_ms: guest.started.elapsed().as_millis() as u64,
        capabilities: sys::capabilities(&guest),
    };
    let _ = tx.send(event(hello));
    let generation = guest.events.attach(tx.clone());
    info!(generation, "control connection open");

    let mut reader = FramedReader::new(rd);
    loop {
        let frame = match reader.next().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                warn!(error = %e, "control protocol error; closing");
                break;
            }
        };
        let msg: ControlFrame = match parse_json(&frame) {
            Ok(m) => m,
            Err(e) => {
                let _ = tx.send(reply(None, ControlBody::Error { error: e }));
                continue;
            }
        };
        let id = msg.id;
        let body = match msg.body {
            ControlBody::Configure { sandbox_id, epoch, hostname, agents } => {
                let next = Identity { sandbox_id, epoch, hostname };
                let admitted = {
                    let mut inner = guest.inner.lock().unwrap();
                    let admitted = Identity::admit_configure(inner.identity.as_ref(), &next);
                    if admitted.is_ok() {
                        sys::configured_hostname(&guest, &next.hostname);
                        inner.identity = Some(next);
                        let keep: std::collections::HashSet<_> = agents.iter().map(|a| a.agent_id.clone()).collect();
                        inner.agents.retain(|k, _| keep.contains(k));
                    }
                    admitted
                };
                if let Err(error) = admitted {
                    ControlBody::Error { error }
                } else {
                    for slot in agents {
                        guest.upsert_agent(slot);
                    }
                    let _ = tx.send(reply(id, ControlBody::Ok {}));
                    guest.events.ready(generation);
                    continue;
                }
            }
            ControlBody::AgentAttach { slot } => {
                guest.upsert_agent(slot);
                ControlBody::Ok {}
            }
            ControlBody::AgentDetach { agent_id, kill_processes } => {
                let rt = guest.inner.lock().unwrap().agents.remove(&agent_id);
                if kill_processes {
                    if let Some(rt) = rt {
                        for t in rt.tasks.values() {
                            t.stop();
                        }
                    }
                    if let Some(dir) = guest.cgroups.agent_dir(&agent_id.0) {
                        crate::cgroup::Cgroups::kill(&dir);
                    }
                    // Outputs live on tmpfs (guest RAM): drop them with the processes.
                    let _ = std::fs::remove_dir_all(guest.agent_dir(&agent_id));
                }
                ControlBody::Ok {}
            }
            ControlBody::Resume { wall_clock_ms, entropy_b64, fork } => {
                let g = guest.clone();
                match blocking(move || sys::resume(&g, wall_clock_ms, &entropy_b64, fork.as_ref())).await {
                    Ok(clock_step_ms) => ControlBody::ResumeDone { clock_step_ms },
                    Err(error) => ControlBody::Error { error },
                }
            }
            ControlBody::PrepareSnapshot { drop_caches, fsfreeze } => {
                let g = guest.clone();
                match blocking(move || sys::prepare_snapshot(&g, drop_caches, &fsfreeze)).await {
                    Ok(()) => ControlBody::Ok {},
                    Err(error) => ControlBody::Error { error },
                }
            }
            ControlBody::Thaw {} => {
                let g = guest.clone();
                let thaw = move || {
                    sys::thaw(&g);
                    Ok(())
                };
                match blocking(thaw).await {
                    Ok(()) => ControlBody::Ok {},
                    Err(error) => ControlBody::Error { error },
                }
            }
            ControlBody::Health {} => {
                let g = guest.clone();
                match blocking(move || Ok(sys::health(&g))).await {
                    Ok(report) => ControlBody::HealthReport { report },
                    Err(error) => ControlBody::Error { error },
                }
            }
            // Replies to our `cli` relays.
            ControlBody::CliResult { result } => {
                if let Some(r) = msg.reply_to {
                    guest.events.resolve_cli(r, result);
                }
                continue;
            }
            ControlBody::Error { error } => {
                match msg.reply_to {
                    Some(r) => guest.events.resolve_cli(r, CliResult::Error { error }),
                    None => warn!(code = error.code, message = error.message, "host reported an error"),
                }
                continue;
            }
            ControlBody::Ok {} => continue,
            other => {
                let name = serde_json::to_value(&other).ok().and_then(|v| v["type"].as_str().map(str::to_string));
                ControlBody::Error {
                    error: ErrorBody {
                        code: error_code::BAD_REQUEST.into(),
                        message: format!("unexpected message from host: {}", name.unwrap_or_default()),
                        retryable: false,
                    },
                }
            }
        };
        if id.is_some() {
            let _ = tx.send(reply(id, body));
        }
    }
    guest.events.detach(generation);
    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(1), writer).await;
    info!(generation, "control connection closed");
}

/// A lifecycle step on the blocking pool; a panic in it is an `internal` error, never success.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, ErrorBody> + Send + 'static) -> Result<T, ErrorBody> {
    tokio::task::spawn_blocking(f).await.unwrap_or_else(|e| Err(err(error_code::INTERNAL, e.to_string(), false)))
}

fn reply(to: Option<u64>, body: ControlBody) -> ControlFrame {
    ControlFrame { id: None, reply_to: to, body }
}
