//! The nestd link: the gateway dials `/run/nest/gateway.sock`, says hello, and applies what nestd
//! sends. nestd is the source of truth; losing it drops every sandbox and cuts every connection
//! (the keys stay: they are public, and the next bind must be `moved`).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use nest_protocol::host::gateway_link::{GatewayCommand, GatewayEvent};
use nest_protocol::host::{self, frame::MAX_FRAME};
use nest_protocol::model::{ErrorBody, error_codes};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

use crate::state::State;

/// Reconnect backoff bounds; the backoff resets once nestd has acknowledged a hello.
const BACKOFF_MIN: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(5);
/// nestd pings every 5 s; a link silent this long is treated as lost.
const SILENCE_LIMIT: Duration = Duration::from_secs(30);
const HELLO_ACK_TIMEOUT: Duration = Duration::from_secs(10);

/// Run the link forever: connect, serve one session, clear the sandboxes, back off, repeat.
pub async fn link(nestd_sock: PathBuf, listen: String, state: Arc<State>) {
    let instance_id = uuid::Uuid::new_v4().simple().to_string();
    let mut backoff = BACKOFF_MIN;
    loop {
        match UnixStream::connect(&nestd_sock).await {
            Ok(stream) => {
                tracing::info!(sock = %nestd_sock.display(), "nestd link up");
                let mut acked = false;
                match session(stream, &listen, &instance_id, &state, &mut acked).await {
                    Ok(()) => tracing::info!("nestd link closed"),
                    Err(e) => tracing::warn!(error = %e, "nestd link lost"),
                }
                state.clear();
                if acked {
                    backoff = BACKOFF_MIN;
                }
            }
            Err(e) => tracing::debug!(sock = %nestd_sock.display(), error = %e, "nestd not reachable"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// One session: hello, hello_ack, then commands until the socket ends. `acked` is set once
/// nestd answered the hello. The caller clears the sandboxes afterwards, whatever the reason.
pub async fn session(
    mut stream: UnixStream,
    listen: &str,
    instance_id: &str,
    state: &Arc<State>,
    acked: &mut bool,
) -> std::io::Result<()> {
    let hello = GatewayEvent::Hello {
        protocol_version: host::PROTOCOL_VERSION,
        instance_id: instance_id.to_string(),
        listen: listen.to_string(),
    };
    write(&mut stream, &hello).await?;
    let first = tokio::time::timeout(HELLO_ACK_TIMEOUT, read(&mut stream))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "no hello_ack"))??;
    match first {
        Some(Ok(GatewayCommand::HelloAck { protocol_version, .. })) => {
            if protocol_version != host::PROTOCOL_VERSION {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("nestd speaks host protocol {protocol_version}, this gateway {}", host::PROTOCOL_VERSION),
                ));
            }
        }
        Some(Ok(other)) => {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, format!("expected hello_ack, got {other:?}")));
        }
        Some(Err(e)) => return Err(e),
        None => return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed before hello_ack")),
    }
    *acked = true;
    state.begin_resync();
    loop {
        let cmd = tokio::time::timeout(SILENCE_LIMIT, read(&mut stream))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "nestd silent"))??;
        let Some(cmd) = cmd else { return Ok(()) };
        let cmd = match cmd {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "undecodable gateway command");
                let err = GatewayEvent::Error {
                    error: ErrorBody { code: error_codes::INVALID_MESSAGE.into(), message: e.to_string(), retryable: false },
                };
                write(&mut stream, &err).await?;
                continue;
            }
        };
        match cmd {
            GatewayCommand::HelloAck { .. } => {}
            GatewayCommand::KeyUpdate { keys } => {
                let decoded: Vec<(String, Vec<u8>)> = keys
                    .into_iter()
                    .filter_map(|k| match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&k.public_key) {
                        Ok(bytes) if bytes.len() == 65 && bytes[0] == 4 => Some((k.kid, bytes)),
                        _ => {
                            tracing::warn!(kid = %k.kid, "ignoring a key that is not an uncompressed P-256 point");
                            None
                        }
                    })
                    .collect();
                tracing::info!(keys = decoded.len(), "binding keys updated");
                state.set_keys(decoded);
            }
            GatewayCommand::SandboxUpsert { sandbox, epoch, vsock_uds_path, clients, guest, paused } => {
                tracing::debug!(sandbox = %sandbox.0, epoch = epoch.0, clients = clients.len(), guest = guest.is_some(), paused = paused.is_some(), "sandbox upsert");
                state.upsert_sandbox_paused(sandbox, epoch, PathBuf::from(vsock_uds_path), clients, guest, paused);
            }
            GatewayCommand::SandboxRemove { sandbox } => {
                tracing::debug!(sandbox = %sandbox.0, "sandbox removed");
                state.remove_sandbox(&sandbox);
            }
            GatewayCommand::ResyncDone => {
                state.end_resync();
                tracing::info!(sandboxes = state.sandbox_count(), "resync done");
            }
            GatewayCommand::Ping => write(&mut stream, &GatewayEvent::Pong).await?,
        }
    }
}

/// Length-prefixed JSON, as on the other nestd sockets (`host::frame`).
pub async fn write<T: serde::Serialize>(stream: &mut UnixStream, msg: &T) -> std::io::Result<()> {
    let bytes = host::frame::encode(msg)?;
    stream.write_all(&bytes).await?;
    stream.flush().await
}

/// `Ok(None)` on a clean EOF; `Ok(Some(Err))` for a frame that is not a known command, which
/// keeps the link up.
pub async fn read(stream: &mut UnixStream) -> std::io::Result<Option<std::io::Result<GatewayCommand>>> {
    let mut len = [0u8; 4];
    match stream.read_exact(&mut len).await {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))))
}
