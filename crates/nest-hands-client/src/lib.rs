//! The hands client: one WebSocket per hands call to a sandbox's gateway, as
//! `docs/interfaces/gateway/` specifies. The runner (and later AgentDO's `api-loop`) holds a
//! [`HandsTarget`] from SandboxDO's `resolve`, opens a connection per call with [`open`], sends
//! the host-guest hands frames with [`HandsConn::send_json`] and reads the guest's answers with
//! [`HandsConn::recv_json`]. Closing the connection is the cancel.
//!
//! The binding token and the edge credential are sent on the wire and never logged by this
//! crate. tungstenite's own `trace` logging prints frame payloads, so `tungstenite=trace` (or a
//! global `trace` filter) must never be enabled in a process where a binding travels.

use std::io;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nest_protocol::gateway::{
    ClientMessage, GatewayMessage, GuestInfo, HandsTarget, MIN_SUPPORTED_PROTOCOL_VERSION,
    PROTOCOL_VERSION, ROUTE_HANDS, close_code, error_code,
};
use nest_protocol::guest::frame::{self, Kind, MAX_FRAME_LEN};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::error::ProtocolError;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{
    Connector, MaybeTlsStream, WebSocketStream, connect_async_tls_with_config,
};

/// Request header names for a Cloudflare Access service token ([`HandsTarget::edge`]).
pub const EDGE_CLIENT_ID_HEADER: &str = "CF-Access-Client-Id";
pub const EDGE_CLIENT_SECRET_HEADER: &str = "CF-Access-Client-Secret";

/// The close handshake in [`HandsConn::close`] is bounded by this.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug)]
pub struct OpenOptions {
    /// TCP connect (and TLS) plus the WebSocket upgrade.
    pub connect_timeout: Duration,
    /// From sending `bind` to the gateway's `bound` or `error`.
    pub bind_timeout: Duration,
}

impl Default for OpenOptions {
    fn default() -> Self {
        OpenOptions {
            connect_timeout: Duration::from_secs(5),
            bind_timeout: Duration::from_secs(5),
        }
    }
}

/// A refusal code from `nest_protocol::gateway::error_code`, parsed from the wire string.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RefusalCode {
    Unauthorized,
    UnknownKey,
    StaleEpoch,
    Moved,
    UnsupportedVersion,
    Busy,
    BadRequest,
    Other(String),
}

impl RefusalCode {
    pub fn parse(code: &str) -> RefusalCode {
        match code {
            error_code::UNAUTHORIZED => RefusalCode::Unauthorized,
            error_code::UNKNOWN_KEY => RefusalCode::UnknownKey,
            error_code::STALE_EPOCH => RefusalCode::StaleEpoch,
            error_code::MOVED => RefusalCode::Moved,
            error_code::UNSUPPORTED_VERSION => RefusalCode::UnsupportedVersion,
            error_code::BUSY => RefusalCode::Busy,
            error_code::BAD_REQUEST => RefusalCode::BadRequest,
            other => RefusalCode::Other(other.to_string()),
        }
    }

    pub fn as_str(&self) -> &str {
        match self {
            RefusalCode::Unauthorized => error_code::UNAUTHORIZED,
            RefusalCode::UnknownKey => error_code::UNKNOWN_KEY,
            RefusalCode::StaleEpoch => error_code::STALE_EPOCH,
            RefusalCode::Moved => error_code::MOVED,
            RefusalCode::UnsupportedVersion => error_code::UNSUPPORTED_VERSION,
            RefusalCode::Busy => error_code::BUSY,
            RefusalCode::BadRequest => error_code::BAD_REQUEST,
            RefusalCode::Other(s) => s,
        }
    }
}

/// The gateway's `error` before `bound`: nothing reached the guest (`executed: false`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
    /// Retryable with the same binding (`busy`); otherwise resolve again or give up.
    pub retryable: bool,
    pub retry_after_ms: Option<u64>,
}

impl Refusal {
    /// The same binding can never succeed, but a fresh one from `hands_resolve` may:
    /// `stale_epoch`, `moved`, `unknown_key`.
    pub fn resolve_again(&self) -> bool {
        matches!(
            self.code,
            RefusalCode::StaleEpoch | RefusalCode::Moved | RefusalCode::UnknownKey
        )
    }

    /// Neither a retry nor a new binding helps: `unauthorized`, `bad_request`, `unsupported_version`.
    pub fn is_final(&self) -> bool {
        matches!(
            self.code,
            RefusalCode::Unauthorized | RefusalCode::BadRequest | RefusalCode::UnsupportedVersion
        )
    }
}

/// Which timer of [`OpenOptions`] elapsed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Connect,
    Bind,
}

/// The connection failed, or dropped before `bound`.
#[derive(Debug)]
pub enum TransportError {
    /// The TCP connect or the socket failed.
    Io(io::Error),
    /// The TLS handshake failed (certificate, protocol).
    Tls(String),
    /// The server answered the upgrade with an HTTP status instead of switching protocols.
    Http(u16),
    /// The URL could not be used: unparsable, a disallowed scheme, an edge credential over
    /// cleartext to a non-loopback host, or a malformed upgrade exchange.
    Url(String),
    /// The gateway closed the WebSocket before answering `bind`.
    ClosedBeforeBound { code: Option<u16>, reason: String },
}

impl TransportError {
    /// Nothing answered at the target's address (refused, reset, unreachable): the runner treats
    /// this like `moved` and resolves again rather than retrying the same target.
    pub fn is_unreachable(&self) -> bool {
        matches!(
            self,
            TransportError::Io(e) if matches!(
                e.kind(),
                io::ErrorKind::ConnectionRefused
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::NotConnected
                    | io::ErrorKind::HostUnreachable
                    | io::ErrorKind::NetworkUnreachable
            )
        )
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TransportError::Io(e) => write!(f, "{:?}: {e}", e.kind()),
            TransportError::Tls(m) => write!(f, "tls: {m}"),
            TransportError::Http(s) => write!(f, "http {s} instead of an upgrade"),
            TransportError::Url(m) => write!(f, "url: {m}"),
            TransportError::ClosedBeforeBound {
                code: Some(c),
                reason,
            } => write!(f, "closed before bound: {c} {reason}"),
            TransportError::ClosedBeforeBound { code: None, .. } => {
                f.write_str("closed before bound")
            }
        }
    }
}

impl std::error::Error for TransportError {}

#[derive(Debug)]
pub enum OpenError {
    /// The gateway answered `error` and closed.
    Refused(Refusal),
    Transport(TransportError),
    /// The gateway spoke something that is not the contract (a binary or unparsable first
    /// message, or a `bound.gateway_version` this client does not serve).
    Protocol(String),
    /// A timer of [`OpenOptions`] elapsed.
    Timeout(Phase),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Refused(r) => {
                write!(f, "gateway refused: {} ({})", r.code.as_str(), r.message)
            }
            OpenError::Transport(t) => write!(f, "transport: {t}"),
            OpenError::Protocol(m) => write!(f, "protocol: {m}"),
            OpenError::Timeout(Phase::Connect) => f.write_str("connect timed out"),
            OpenError::Timeout(Phase::Bind) => f.write_str("bind timed out"),
        }
    }
}

impl std::error::Error for OpenError {}

/// A close frame with a gateway close code: 4400 protocol, 4401 unauthorized, 4409 moved, or any
/// other code that is not the normal 1000.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Closed {
    pub code: u16,
    pub reason: String,
}

impl Closed {
    pub fn is_moved(&self) -> bool {
        self.code == close_code::MOVED
    }
    pub fn is_unauthorized(&self) -> bool {
        self.code == close_code::UNAUTHORIZED
    }
}

impl std::fmt::Display for Closed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "gateway closed with {} ({})", self.code, self.reason)
    }
}

impl std::error::Error for Closed {}

/// Why [`HandsConn::recv_json`] could not return a frame.
#[derive(Debug)]
pub enum RecvError {
    /// A close frame with a non-normal code (see [`Closed`]).
    Closed(Closed),
    /// Not the contract: a text message after `bound`, a `DATA` frame, a message that is not
    /// exactly one frame, or a frame whose JSON does not parse as `T`.
    Protocol(String),
    /// The socket failed, including a reset without a close handshake (`ConnectionReset`).
    Io(io::Error),
}

impl std::fmt::Display for RecvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecvError::Closed(c) => write!(f, "{c}"),
            RecvError::Protocol(m) => write!(f, "protocol: {m}"),
            RecvError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for RecvError {}

fn transport(e: WsError) -> OpenError {
    OpenError::Transport(match e {
        // tokio-rustls reports a failed handshake (certificate verification included) as an
        // `InvalidData` io error wrapping the rustls error.
        WsError::Io(io) => match io
            .get_ref()
            .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        {
            Some(t) => TransportError::Tls(t.to_string()),
            None => TransportError::Io(io),
        },
        WsError::Tls(t) => TransportError::Tls(t.to_string()),
        WsError::Http(resp) => TransportError::Http(resp.status().as_u16()),
        WsError::Url(u) => TransportError::Url(u.to_string()),
        WsError::ConnectionClosed | WsError::AlreadyClosed | WsError::Protocol(_) => {
            TransportError::ClosedBeforeBound {
                code: None,
                reason: e.to_string(),
            }
        }
        other => TransportError::Url(other.to_string()),
    })
}

fn ws_config() -> WebSocketConfig {
    let max = MAX_FRAME_LEN as usize + 4;
    WebSocketConfig::default()
        .max_message_size(Some(max))
        .max_frame_size(Some(max))
}

/// TLS for `wss://`: the process's installed rustls provider if there is one (the runner installs
/// aws-lc-rs), else ring; webpki roots; no client auth. Independent of workspace feature
/// unification.
fn tls_connector() -> Connector {
    let provider = rustls::crypto::CryptoProvider::get_default()
        .cloned()
        .unwrap_or_else(|| Arc::new(rustls::crypto::ring::default_provider()));
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("rustls default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Connector::Rustls(Arc::new(config))
}

fn is_loopback(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost")
        || h.parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

/// One bound connection to a sandbox's gateway, ready for exactly one hands call.
pub struct HandsConn {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
    guest: GuestInfo,
    gateway_version: u32,
}

impl std::fmt::Debug for HandsConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HandsConn")
            .field("guest", &self.guest)
            .field("gateway_version", &self.gateway_version)
            .finish_non_exhaustive()
    }
}

/// Open a WebSocket to `target.url` + `/hands`, send `bind`, and wait for `bound`.
pub async fn open(target: &HandsTarget, opts: &OpenOptions) -> Result<HandsConn, OpenError> {
    let url = format!("{}{}", target.url.trim_end_matches('/'), ROUTE_HANDS);
    let mut req = url
        .as_str()
        .into_client_request()
        .map_err(|e| OpenError::Transport(TransportError::Url(e.to_string())))?;
    let scheme = req.uri().scheme_str().unwrap_or("").to_string();
    if !matches!(scheme.as_str(), "ws" | "wss") {
        return Err(OpenError::Transport(TransportError::Url(format!(
            "scheme {scheme:?} is not ws or wss"
        ))));
    }
    if let Some(edge) = &target.edge {
        let host = req.uri().host().unwrap_or("").to_string();
        if scheme == "ws" && !is_loopback(&host) {
            return Err(OpenError::Transport(TransportError::Url(format!(
                "an edge credential must not travel in cleartext to {host}; use wss://"
            ))));
        }
        let bad = |what: &str| {
            OpenError::Transport(TransportError::Url(format!(
                "edge {what} is not a valid header value"
            )))
        };
        let id = HeaderValue::from_str(&edge.client_id).map_err(|_| bad("client id"))?;
        let mut secret =
            HeaderValue::from_str(edge.client_secret.expose()).map_err(|_| bad("client secret"))?;
        secret.set_sensitive(true);
        req.headers_mut().insert(EDGE_CLIENT_ID_HEADER, id);
        req.headers_mut().insert(EDGE_CLIENT_SECRET_HEADER, secret);
    }
    tracing::debug!(url = %url, sandbox = %target.sandbox.0, epoch = target.epoch.0, "opening hands connection");
    let connector = (scheme == "wss").then(tls_connector);
    let (mut ws, _) = tokio::time::timeout(
        opts.connect_timeout,
        connect_async_tls_with_config(req, Some(ws_config()), false, connector),
    )
    .await
    .map_err(|_| OpenError::Timeout(Phase::Connect))?
    .map_err(transport)?;
    let bind = ClientMessage::Bind {
        binding: target.binding.expose().to_string(),
        protocol_version: target.guest.protocol_version,
        gateway_version: PROTOCOL_VERSION,
    };
    let first = tokio::time::timeout(opts.bind_timeout, async {
        ws.send(Message::text(
            serde_json::to_string(&bind).expect("protocol types serialize"),
        ))
        .await
        .map_err(transport)?;
        loop {
            match ws.next().await {
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                other => break Ok(other),
            }
        }
    })
    .await
    .map_err(|_| OpenError::Timeout(Phase::Bind))??;
    match first {
        Some(Ok(Message::Text(t))) => match serde_json::from_str::<GatewayMessage>(&t) {
            Ok(GatewayMessage::Bound {
                guest,
                gateway_version,
            }) => {
                if !(MIN_SUPPORTED_PROTOCOL_VERSION..=PROTOCOL_VERSION).contains(&gateway_version) {
                    return Err(OpenError::Protocol(format!(
                        "bound names gateway version {gateway_version}, outside [{MIN_SUPPORTED_PROTOCOL_VERSION}, {PROTOCOL_VERSION}]"
                    )));
                }
                Ok(HandsConn {
                    ws,
                    guest,
                    gateway_version,
                })
            }
            Ok(GatewayMessage::Error {
                error,
                retry_after_ms,
                ..
            }) => Err(OpenError::Refused(Refusal {
                code: RefusalCode::parse(&error.code),
                message: error.message,
                retryable: error.retryable,
                retry_after_ms,
            })),
            Err(e) => Err(OpenError::Protocol(format!(
                "first message is not a gateway message: {e}"
            ))),
        },
        Some(Ok(Message::Close(cf))) => {
            Err(OpenError::Transport(TransportError::ClosedBeforeBound {
                code: cf.as_ref().map(|c| u16::from(c.code)),
                reason: cf.map(|c| c.reason.to_string()).unwrap_or_default(),
            }))
        }
        None => Err(OpenError::Transport(TransportError::ClosedBeforeBound {
            code: None,
            reason: String::new(),
        })),
        Some(Ok(Message::Binary(_))) => {
            Err(OpenError::Protocol("binary message before bound".into()))
        }
        Some(Ok(_)) => Err(OpenError::Protocol(
            "unexpected message before bound".into(),
        )),
        Some(Err(e)) => Err(transport(e)),
    }
}

/// Exactly one frame: `len == message_len - 4`, a known kind, within the frame limit.
fn one_frame(bytes: &[u8]) -> Result<(Kind, &[u8]), RecvError> {
    if bytes.len() < 5 {
        return Err(RecvError::Protocol(format!(
            "binary message of {} bytes is not a frame",
            bytes.len()
        )));
    }
    let len = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    if len > MAX_FRAME_LEN {
        return Err(RecvError::Protocol(
            frame::FrameError::TooLarge(len).to_string(),
        ));
    }
    if len as usize != bytes.len() - 4 {
        return Err(RecvError::Protocol(format!(
            "frame length {len} does not match a message of {} bytes",
            bytes.len()
        )));
    }
    let kind = Kind::from_u8(bytes[4])
        .ok_or_else(|| RecvError::Protocol(frame::FrameError::UnknownKind(bytes[4]).to_string()))?;
    Ok((kind, &bytes[5..]))
}

impl HandsConn {
    /// The guest's version and capabilities as the gateway reported them in `bound` (authoritative).
    pub fn guest(&self) -> &GuestInfo {
        &self.guest
    }

    /// The gateway protocol version the gateway chose.
    pub fn gateway_version(&self) -> u32 {
        self.gateway_version
    }

    /// Send one JSON frame (a `HandsRequest`, a `cancel`, a `call_status`) as one binary message.
    /// A payload over the frame limit is `InvalidInput`.
    pub async fn send_json<T: serde::Serialize>(&mut self, v: &T) -> io::Result<()> {
        let bytes = frame::encode_json(v)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e.to_string()))?;
        self.ws
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(|e| match e {
                WsError::Io(io) => io,
                other => io::Error::other(other.to_string()),
            })
    }

    /// The next JSON frame from the guest. `Ok(None)` only when the gateway closed normally (a
    /// close frame with code 1000, or EOF after the close handshake); any other close code is
    /// [`RecvError::Closed`]; a reset without a close handshake is [`RecvError::Io`]
    /// (`ConnectionReset`); a text message, a `DATA` frame or a message that is not exactly one
    /// frame is [`RecvError::Protocol`]. Cancel-safe: a frame that arrives while the future is
    /// dropped is returned by the next call.
    pub async fn recv_json<T: serde::de::DeserializeOwned>(
        &mut self,
    ) -> Result<Option<T>, RecvError> {
        loop {
            match self.ws.next().await {
                None => return Ok(None),
                Some(Ok(Message::Binary(b))) => {
                    let (kind, payload) = one_frame(&b)?;
                    if kind != Kind::Json {
                        return Err(RecvError::Protocol(
                            "data frame on the hands channel".into(),
                        ));
                    }
                    return serde_json::from_slice(payload)
                        .map(Some)
                        .map_err(|e| RecvError::Protocol(format!("guest frame: {e}")));
                }
                Some(Ok(Message::Close(cf))) => {
                    return match cf {
                        Some(cf) if cf.code != CloseCode::Normal => {
                            Err(RecvError::Closed(Closed {
                                code: u16::from(cf.code),
                                reason: cf.reason.to_string(),
                            }))
                        }
                        _ => Ok(None),
                    };
                }
                Some(Ok(Message::Text(_))) => {
                    return Err(RecvError::Protocol("text message after bound".into()));
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => continue,
                Some(Err(WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake))) => {
                    return Err(RecvError::Io(io::Error::new(
                        io::ErrorKind::ConnectionReset,
                        "gateway reset the connection without a close handshake",
                    )));
                }
                Some(Err(WsError::Io(e))) => return Err(RecvError::Io(e)),
                Some(Err(e)) => return Err(RecvError::Protocol(e.to_string())),
            }
        }
    }

    /// Hang up with an empty reason: a close frame, the handshake drained for at most
    /// [`CLOSE_TIMEOUT`], then drop. Dropping without calling this hangs up too; this one lets
    /// the gateway tell a deliberate cancel from a crash.
    pub async fn close(self) {
        self.close_with_reason("").await;
    }

    /// [`HandsConn::close`] with a reason in the close frame (for the gateway's logs).
    pub async fn close_with_reason(mut self, reason: &str) {
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            let _ = self
                .ws
                .close(Some(CloseFrame {
                    code: CloseCode::Normal,
                    reason: reason.to_string().into(),
                }))
                .await;
            while let Some(Ok(_)) = self.ws.next().await {}
        })
        .await;
    }
}
