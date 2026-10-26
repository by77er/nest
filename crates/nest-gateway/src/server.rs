//! The WebSocket server: one connection per hands call. Bind, verify, register, connect the
//! guest's vsock port, then pipe frames until either side hangs up or nestd says the sandbox
//! left.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nest_protocol::gateway::{ClientMessage, GatewayMessage, ROUTE_HANDS, ROUTE_INGRESS_PREFIX, ROUTE_PTY, close_code, error_code};
use nest_protocol::guest::frame::{self, Decoder, Kind, MAX_FRAME_LEN};
use nest_protocol::guest::{PORT_HANDS, handshake};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::sync::Semaphore;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};

use crate::state::State;
use crate::verify::{Refusal, check_bind, first_frame_mismatch};

/// How long a client has, from the TCP accept, to finish the upgrade and send `bind`.
pub const BIND_TIMEOUT: Duration = Duration::from_secs(5);
/// How long the vsock `CONNECT` handshake may take.
const VSOCK_TIMEOUT: Duration = Duration::from_secs(5);
/// Bound on every write toward a client (a close, a refusal, a guest frame): a client that
/// stops reading cannot pin a task, its registration and the guest connection.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
/// Connections allowed between accept and `bound` at once; each may hold a 16 MiB message
/// buffer, so this bounds the pre-authentication memory too.
pub const MAX_PRE_BIND: usize = 256;
/// Pause after a failed accept (fd exhaustion and the like) before accepting again.
const ACCEPT_RETRY: Duration = Duration::from_millis(100);

/// How long [`shutdown`] waits for the connection tasks to deliver their close frames.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);

/// Cut every connection (close code 4409) and wait, up to [`SHUTDOWN_GRACE`], until each
/// connection task has sent its close frame and unregistered, so clients see a close rather
/// than a reset when the process exits. Returns the connections still open at the cap.
pub async fn shutdown(state: &State) -> usize {
    state.clear();
    let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
    while state.open_connections() > 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    state.open_connections()
}

/// Accept connections forever. An accept error is logged and retried after [`ACCEPT_RETRY`].
pub async fn serve(listener: TcpListener, state: Arc<State>) -> std::io::Result<()> {
    let pre_bind = Arc::new(Semaphore::new(MAX_PRE_BIND));
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!(error = %e, "accept failed; retrying");
                tokio::time::sleep(ACCEPT_RETRY).await;
                continue;
            }
        };
        let state = Arc::clone(&state);
        let pre_bind = Arc::clone(&pre_bind);
        tokio::spawn(async move {
            // Closed semaphores never happen here; a failed acquire just drops the connection.
            let Ok(permit) = pre_bind.acquire_owned().await else { return };
            if let Err(e) = connection(stream, state, permit).await {
                tracing::debug!(%peer, error = %e, "connection ended");
            }
        });
    }
}

type Ws = WebSocketStream<TcpStream>;

async fn connection(stream: TcpStream, state: Arc<State>, permit: tokio::sync::OwnedSemaphorePermit) -> anyhow::Result<()> {
    // Upgrade and bind share one deadline, counted from the accept.
    let deadline = tokio::time::Instant::now() + BIND_TIMEOUT;
    let Some((mut ws, bind, via)) = upgrade_and_bind(stream, deadline).await else { return Ok(()) };
    let Some(ClientMessage::Bind { binding, protocol_version, gateway_version }) = bind else {
        refuse(&mut ws, &Refusal::new(error_code::BAD_REQUEST, "expected a bind message")).await;
        return Ok(());
    };
    let accepted = match check_bind(&state, &binding, protocol_version, gateway_version, now_ms()) {
        Ok(a) => a,
        Err(r) => {
            tracing::info!(code = r.code, via, "bind refused");
            refuse(&mut ws, &r).await;
            return Ok(());
        }
    };
    let sandbox = accepted.claims.sandbox.clone();
    let client = accepted.claims.client.clone();
    // Registered before the guest is touched, atomically with a re-check of the sandbox and
    // epoch: a removal, epoch bump or link loss since the bind check is refused here, and one
    // during the vsock connect cuts the connect below.
    let agent_epoch = accepted.claims.agent_epoch.unwrap_or(nest_protocol::model::Epoch(0));
    let Some(mut guard) = state.register_client_conn(sandbox.clone(), accepted.claims.epoch, &client, agent_epoch) else {
        refuse(&mut ws, &Refusal::moved("the sandbox left this host")).await;
        return Ok(());
    };
    let guest = tokio::select! {
        biased;
        _ = guard.closed() => {
            refuse(&mut ws, &Refusal::moved("the sandbox left this host")).await;
            return Ok(());
        }
        r = tokio::time::timeout(VSOCK_TIMEOUT, vsock_connect(&accepted.vsock_uds_path, PORT_HANDS)) => match r {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                tracing::warn!(sandbox = %sandbox.0, error = %e, "guest vsock connect failed");
                refuse(&mut ws, &Refusal::busy("guest not reachable")).await;
                return Ok(());
            }
            Err(_) => {
                refuse(&mut ws, &Refusal::busy("guest handshake timed out")).await;
                return Ok(());
            }
        }
    };
    drop(permit);
    let bound = GatewayMessage::Bound { guest: accepted.guest.clone(), gateway_version: accepted.gateway_version };
    if send(&mut ws, Message::text(serde_json::to_string(&bound)?)).await.is_err() {
        return Ok(());
    }
    tracing::info!(sandbox = %sandbox.0, client = %client, via, "bound");

    // The pipe.
    let (mut guest_rd, mut guest_wr) = guest.into_split();
    let mut decoder = Decoder::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut first = true;
    let outcome: &str = loop {
        tokio::select! {
            biased;
            code = guard.closed() => {
                close(&mut ws, code, "sandbox left this host").await;
                break "sandbox left";
            }
            msg = ws.next() => match msg {
                None => break "client gone",
                Some(Ok(Message::Close(_))) => {
                    // The WebSocket layer queued the reply close frame; flushing sends it, so the
                    // client sees a completed handshake, not a reset.
                    let _ = tokio::time::timeout(WRITE_TIMEOUT, ws.flush()).await;
                    break "client closed";
                }
                Some(Err(e)) => {
                    tracing::debug!(sandbox = %sandbox.0, client = %client, error = %e, "client read error");
                    break "client error";
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let kind = match check_frame(&bytes) {
                        Ok(k) => k,
                        Err(why) => {
                            close(&mut ws, close_code::PROTOCOL, why).await;
                            break "bad frame";
                        }
                    };
                    if first {
                        first = false;
                        let json = (kind == Kind::Json).then(|| serde_json::from_slice::<serde_json::Value>(&bytes[5..]).ok()).flatten();
                        let Some(json) = json else {
                            close(&mut ws, close_code::PROTOCOL, "first frame is not JSON").await;
                            break "bad first frame";
                        };
                        if let Some(field) = first_frame_mismatch(&json, &accepted.claims, accepted.guest.protocol_version) {
                            tracing::info!(sandbox = %sandbox.0, client = %client, field, "first frame differs from the binding");
                            close(&mut ws, close_code::UNAUTHORIZED, "frame does not match the binding").await;
                            break "unauthorized frame";
                        }
                    }
                    if guest_wr.write_all(&bytes).await.is_err() {
                        close(&mut ws, close_code::MOVED, "guest write failed").await;
                        break "guest write failed";
                    }
                }
                Some(Ok(Message::Text(_))) => {
                    close(&mut ws, close_code::PROTOCOL, "text frame after bound").await;
                    break "text after bound";
                }
                // Pings are answered by the WebSocket layer; pongs and raw frames carry nothing.
                Some(Ok(_)) => {}
            },
            n = guest_rd.read(&mut buf) => match n {
                Ok(0) | Err(_) => {
                    let _ = tokio::time::timeout(WRITE_TIMEOUT, ws.close(None)).await;
                    break "guest closed";
                }
                Ok(n) => {
                    decoder.push(&buf[..n]);
                    let mut stop = None;
                    loop {
                        match decoder.next_frame() {
                            Ok(Some(f)) => {
                                let bytes = frame::encode(f.kind, &f.payload)?;
                                if send(&mut ws, Message::binary(bytes)).await.is_err() {
                                    stop = Some("client write failed");
                                    break;
                                }
                            }
                            Ok(None) => break,
                            Err(e) => {
                                tracing::warn!(sandbox = %sandbox.0, error = %e, "guest frame error");
                                close(&mut ws, u16::from(CloseCode::Error), "guest frame error").await;
                                stop = Some("guest frame error");
                                break;
                            }
                        }
                    }
                    if let Some(why) = stop {
                        break why;
                    }
                }
            },
        }
    };
    let _ = guest_wr.shutdown().await;
    tracing::info!(sandbox = %sandbox.0, client = %client, outcome, "connection ended");
    Ok(())
}

/// Where a connection came in from, for the log: `edge` when the upgrade request carries
/// Cloudflare's `cf-ray` header (it arrived through the host's tunnel, past Access), `direct`
/// otherwise (loopback on the harness, or a client on the host). A log fact only: the binding
/// is the admission check, and a direct client can set the header itself.
pub fn via_of(req: &Request) -> &'static str {
    if req.headers().contains_key("cf-ray") { "edge" } else { "direct" }
}

/// The upgrade, then the first text message, both before `deadline`. Pings, pongs and raw
/// frames before `bind` are skipped. `Some((ws, None, _))` (a binary message, a non-bind text,
/// or the deadline after the upgrade) is answered as `bad_request` by the caller; a closed or
/// broken socket, or no upgrade before the deadline, is `None`.
async fn upgrade_and_bind(stream: TcpStream, deadline: tokio::time::Instant) -> Option<(Ws, Option<ClientMessage>, &'static str)> {
    let mut route = String::new();
    let mut via = "direct";
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_LEN as usize + 4))
        .max_frame_size(Some(MAX_FRAME_LEN as usize + 4));
    // tungstenite's callback contract fixes the error type; nothing to box.
    #[allow(clippy::result_large_err)]
    let callback = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
        route = req.uri().path().to_string();
        via = via_of(req);
        if route == ROUTE_HANDS {
            return Ok(resp);
        }
        let (status, body) = if route == ROUTE_PTY || route.starts_with(ROUTE_INGRESS_PREFIX) {
            (StatusCode::NOT_IMPLEMENTED, "route not served yet")
        } else {
            (StatusCode::NOT_FOUND, "unknown route")
        };
        let mut r = ErrorResponse::new(Some(body.to_string()));
        *r.status_mut() = status;
        Err(r)
    };
    let upgrade = tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(config));
    let mut ws = match tokio::time::timeout_at(deadline, upgrade).await {
        Ok(Ok(ws)) => ws,
        Ok(Err(e)) => {
            tracing::debug!(route, error = %e, "upgrade refused");
            return None;
        }
        Err(_) => return None,
    };
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => return Some((ws, serde_json::from_str::<ClientMessage>(&text).ok(), via)),
            Ok(Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_)))) => continue,
            Ok(Some(Ok(Message::Binary(_)))) => return Some((ws, None, via)),
            Ok(Some(Ok(Message::Close(_))) | Some(Err(_)) | None) => return None,
            Err(_) => return Some((ws, None, via)),
        }
    }
}

/// Exactly one well-formed frame per message: `len == message_len - 4`, a known kind.
fn check_frame(bytes: &[u8]) -> Result<Kind, &'static str> {
    if bytes.len() < 5 {
        return Err("message shorter than a frame");
    }
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if len > MAX_FRAME_LEN {
        return Err("frame too large");
    }
    if len as usize != bytes.len() - 4 {
        return Err("frame length does not match the message");
    }
    Kind::from_u8(bytes[4]).ok_or("unknown frame kind")
}

async fn send(ws: &mut Ws, msg: Message) -> Result<(), ()> {
    match tokio::time::timeout(WRITE_TIMEOUT, ws.send(msg)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err(()),
    }
}

async fn refuse(ws: &mut Ws, r: &Refusal) {
    if let Ok(text) = serde_json::to_string(&r.message()) {
        let _ = send(ws, Message::text(text)).await;
    }
    let frame = CloseFrame { code: CloseCode::Policy, reason: Utf8Bytes::from(r.code) };
    let _ = tokio::time::timeout(WRITE_TIMEOUT, ws.close(Some(frame))).await;
}

async fn close(ws: &mut Ws, code: u16, reason: &'static str) {
    let frame = CloseFrame { code: CloseCode::from(code), reason: Utf8Bytes::from(reason) };
    let _ = tokio::time::timeout(WRITE_TIMEOUT, ws.close(Some(frame))).await;
}

/// Firecracker's hybrid-vsock handshake: connect, `CONNECT <port>\n`, read `OK <n>\n` byte by
/// byte so no frame bytes are consumed.
async fn vsock_connect(path: &std::path::Path, port: u32) -> std::io::Result<UnixStream> {
    let mut stream = UnixStream::connect(path).await?;
    stream.write_all(handshake::connect_line(port).as_bytes()).await?;
    let mut line = Vec::with_capacity(16);
    loop {
        let mut b = [0u8; 1];
        if stream.read(&mut b).await? == 0 {
            return Err(std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "vsock handshake: connection closed"));
        }
        line.push(b[0]);
        if b[0] == b'\n' || line.len() > 64 {
            break;
        }
    }
    let line = String::from_utf8_lossy(&line);
    handshake::parse_ok_line(&line)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, format!("vsock handshake: unexpected reply {line:?}")))?;
    Ok(stream)
}

/// Milliseconds since the epoch; a clock before 1970 yields `i64::MAX`, which makes every
/// binding expired rather than every binding fresh.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn via_is_edge_only_with_a_cf_ray_header() {
        let direct = Request::builder().uri("/hands").body(()).unwrap();
        assert_eq!(via_of(&direct), "direct");
        let edge = Request::builder().uri("/hands").header("cf-ray", "8a1b2c3d4e5f-IAD").body(()).unwrap();
        assert_eq!(via_of(&edge), "edge");
        // Cloudflare sets `cf-connecting-ip` too; alone it is not the edge (the host's own clients could).
        let other = Request::builder().uri("/hands").header("cf-connecting-ip", "203.0.113.9").body(()).unwrap();
        assert_eq!(via_of(&other), "direct");
    }
}
