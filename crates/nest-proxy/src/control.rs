//! The nestd control connection (SEQPACKET + SCM_RIGHTS). nestd owns all state; every
//! (re)connection starts empty and is resynced. When the connection ends, every listener and
//! connection is closed (fail closed) and the proxy reconnects with backoff.

use std::io;
use std::os::fd::{AsFd, OwnedFd};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use nix::sys::socket::{AddressFamily, SockFlag, SockType, UnixAddr, connect, socket};
use tokio::io::unix::AsyncFd;
use tokio::sync::mpsc;

use nest_protocol::host::PROTOCOL_VERSION;
use nest_protocol::host::fdpass::{self, MAX_PACKET_FROM_PROXY, MAX_PACKET_TO_PROXY};
use nest_protocol::host::proxy::{ProxyCommand, ProxyEvent};
use nest_protocol::model::ErrorBody;

use crate::Config;
use crate::state::{Session, Upstream};
use crate::tls::{Ca, UpstreamTls};
use crate::{audit, listener};

const BACKOFF_MIN: Duration = Duration::from_millis(100);
const BACKOFF_MAX: Duration = Duration::from_secs(5);

/// Run forever: connect to nestd, serve, and reconnect.
pub async fn run(config: Config) -> Result<()> {
    let upstream = Arc::new(Upstream::new(
        config.resolver.clone(),
        UpstreamTls::new(config.webpki_roots, &config.extra_roots)?,
        config.allow_private_upstreams,
    ));
    let mut backoff = BACKOFF_MIN;
    loop {
        match connect_nestd(&config.nestd_sock) {
            Ok(fd) => {
                backoff = BACKOFF_MIN;
                match serve(upstream.clone(), fd).await {
                    Ok(()) => tracing::info!("nestd closed the control connection; reconnecting"),
                    Err(e) => tracing::warn!("nestd control connection failed: {e:#}"),
                }
            }
            Err(e) => tracing::debug!("connect {}: {e}", config.nestd_sock.display()),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

fn connect_nestd(path: &Path) -> io::Result<OwnedFd> {
    let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC | SockFlag::SOCK_NONBLOCK, None)?;
    let addr = UnixAddr::new(path)?;
    connect(std::os::fd::AsRawFd::as_raw_fd(&fd), &addr)?;
    Ok(fd)
}

/// Serve one nestd connection until EOF or error. All state lives in the `Session` and dies
/// with it.
pub async fn serve(upstream: Arc<Upstream>, fd: OwnedFd) -> Result<()> {
    // SAFETY: the AsyncFd takes ownership of `fd`, an `OwnedFd`: the descriptor stays open and
    // refers to the same socket until the AsyncFd drops it (RUSTSEC-2026-0386).
    let fd = Arc::new(unsafe { AsyncFd::register(fd) }.map_err(io::Error::from).context("register control socket")?);
    let (ev_tx, mut ev_rx) = mpsc::unbounded_channel::<ProxyEvent>();
    let (audit_tx, audit_rx) = mpsc::channel(4096);
    let session = Session::new(upstream, ev_tx.clone(), audit_tx);

    let writer = {
        let (fd, cancel) = (fd.clone(), session.cancel.clone());
        tokio::spawn(async move {
            loop {
                let ev = tokio::select! {
                    _ = cancel.cancelled() => break,
                    ev = ev_rx.recv() => match ev { Some(ev) => ev, None => break },
                };
                if let Err(e) = send_packet(&fd, &ev).await {
                    tracing::warn!("send to nestd: {e}");
                    cancel.cancel();
                    break;
                }
            }
            // Flush anything already queued (e.g. a final error) without blocking.
            while let Ok(ev) = ev_rx.try_recv() {
                let _ = tokio::time::timeout(Duration::from_millis(200), send_packet(&fd, &ev)).await;
            }
        })
    };
    tokio::spawn(audit::batcher(audit_rx, ev_tx.clone(), session.cancel.clone()));

    session.emit(ProxyEvent::Hello {
        protocol_version: PROTOCOL_VERSION,
        proxy_version: env!("CARGO_PKG_VERSION").to_string(),
        pid: std::process::id(),
    });

    let mut buf = Vec::new();
    let result: Result<()> = loop {
        let pkt = tokio::select! {
            _ = session.cancel.cancelled() => break Err(anyhow::anyhow!("writer failed")),
            p = recv_packet(&fd, &mut buf) => p,
        };
        let (cmd, fds) = match pkt {
            Ok(Some(v)) => v,
            Ok(None) => break Ok(()),
            Err(e) => {
                protocol_error(&session, "invalid_message", &e.to_string());
                break Err(e.into());
            }
        };
        if fds.len() != cmd.expected_fds() {
            let msg = format!("expected {} fds, got {}", cmd.expected_fds(), fds.len());
            protocol_error(&session, "invalid_message", &msg);
            break Err(anyhow::anyhow!(msg));
        }
        if let Err(e) = handle(&session, cmd, fds) {
            let msg = e.message.clone();
            session.emit(ProxyEvent::Error { error: e });
            break Err(anyhow::anyhow!(msg));
        }
    };

    // Fail closed: stop every listener and connection of this session, then let the writer
    // flush the last events.
    drop(ev_tx);
    session.cancel.cancel();
    let _ = tokio::time::timeout(Duration::from_millis(500), writer).await;
    result
}

fn protocol_error(session: &Session, code: &str, message: &str) {
    session.emit(ProxyEvent::Error {
        error: ErrorBody { code: code.into(), message: message.into(), retryable: false },
    });
}

fn handle(session: &Arc<Session>, cmd: ProxyCommand, fds: Vec<OwnedFd>) -> Result<(), ErrorBody> {
    match cmd {
        ProxyCommand::HelloAck { protocol_version, host_id, .. } => {
            if protocol_version != PROTOCOL_VERSION {
                return Err(ErrorBody {
                    code: nest_protocol::model::error_codes::UNSUPPORTED_VERSION.into(),
                    message: format!("nestd speaks {protocol_version}, proxy speaks {PROTOCOL_VERSION}"),
                    retryable: false,
                });
            }
            tracing::info!(%host_id, "resync starting");
            session.reset();
        }
        ProxyCommand::CaInstall { ca, key_pem } => {
            let ca = Ca::from_install(&ca, &key_pem.0).map_err(|e| ErrorBody {
                code: "invalid_ca".into(),
                message: format!("{e:#}"),
                retryable: false,
            })?;
            session.set_ca(Arc::new(ca));
        }
        ProxyCommand::LeaseUpdate { valid_until_ms } => session.set_lease(valid_until_ms),
        ProxyCommand::SandboxUpsert { sandbox, epoch, workstream, policy } => {
            let Some(sb) = session.sandbox_for(&sandbox, epoch) else {
                tracing::warn!(%sandbox, ?epoch, "ignored policy push for a dropped sandbox");
                return Ok(());
            };
            if !sb.upsert(epoch, workstream, policy) {
                tracing::debug!(%sandbox, "ignored stale policy push");
            }
        }
        ProxyCommand::SecretsSet { sandbox, epoch, secrets } => {
            let Some(sb) = session.sandbox_for(&sandbox, epoch) else {
                tracing::warn!(%sandbox, ?epoch, "ignored secrets for a dropped sandbox");
                return Ok(());
            };
            if !sb.set_secrets(epoch, secrets) {
                tracing::debug!(%sandbox, "ignored stale secrets");
            }
        }
        ProxyCommand::ListenersAdd { sandbox, epoch, listeners } => {
            // fds for refused pushes are simply dropped (nestd keeps its own copies).
            let Some(sb) = session.sandbox_for(&sandbox, epoch) else {
                tracing::warn!(%sandbox, ?epoch, "ignored listeners for a dropped sandbox");
                return Ok(());
            };
            if !sb.accepts_epoch(epoch) {
                tracing::debug!(%sandbox, "ignored listeners for stale epoch");
                return Ok(());
            }
            for (spec, fd) in listeners.into_iter().zip(fds) {
                let id = spec.id;
                if let Err(error) = listener::spawn(session, &sb, spec, fd) {
                    session.emit(ProxyEvent::ListenerFailed { sandbox: sandbox.clone(), listener_id: id, error });
                }
            }
        }
        ProxyCommand::ListenersRemove { sandbox, epoch, listener_ids } => {
            if let Some(sb) = session.sandbox(&sandbox).filter(|sb| sb.accepts_epoch(epoch)) {
                let mut map = sb.listeners.lock().unwrap();
                for id in listener_ids {
                    if let Some(t) = map.remove(&id) {
                        t.cancel();
                    }
                }
            }
        }
        ProxyCommand::SandboxDrop { sandbox, epoch, reason } => {
            // A fence is remembered even if the sandbox isn't here yet, so a push racing the drop
            // can't bring it back.
            if let Some(sb) = session.drop_sandbox(&sandbox, epoch, reason) {
                tracing::info!(%sandbox, ?reason, "dropping sandbox");
                sb.drop.cancel();
            }
        }
        ProxyCommand::ResyncComplete { sandboxes, listeners } => {
            let (n, m) = session.counts();
            if (n, m) != (sandboxes, listeners) {
                tracing::warn!(expected = ?(sandboxes, listeners), got = ?(n, m), "resync count mismatch");
            }
            session.emit(ProxyEvent::ResyncAck { sandboxes: n, listeners: m });
        }
        ProxyCommand::Ping { nonce } => {
            let (n, _) = session.counts();
            session.emit(ProxyEvent::Pong { nonce, sandboxes: n, active_connections: session.active_connections() });
        }
    }
    Ok(())
}

async fn recv_packet(fd: &AsyncFd<OwnedFd>, buf: &mut Vec<u8>) -> io::Result<Option<(ProxyCommand, Vec<OwnedFd>)>> {
    loop {
        let mut guard = fd.readable().await?;
        match guard.try_io(|inner| fdpass::recv(inner.get_ref().as_fd(), buf, MAX_PACKET_TO_PROXY)) {
            Ok(r) => return r,
            Err(_would_block) => continue,
        }
    }
}

/// Send one event. Strings that guests can influence are clipped first, and anything still
/// over nestd's receive limit is dropped (never sent): an oversized packet would make nestd's
/// reader fail and take down the control link for every sandbox on the host.
async fn send_packet(fd: &AsyncFd<OwnedFd>, ev: &ProxyEvent) -> io::Result<()> {
    let ev = crate::audit::clip_event(ev.clone());
    let len = serde_json::to_vec(&ev).map(|v| v.len()).unwrap_or(usize::MAX);
    if len > MAX_PACKET_FROM_PROXY {
        tracing::warn!(len, kind = event_kind(&ev), "dropping oversized event to nestd");
        return Ok(());
    }
    let ev = &ev;
    loop {
        let mut guard = fd.writable().await?;
        match guard.try_io(|inner| fdpass::send(inner.get_ref().as_fd(), ev, &[])) {
            Ok(r) => return r,
            Err(_would_block) => continue,
        }
    }
}

fn event_kind(ev: &ProxyEvent) -> &'static str {
    match ev {
        ProxyEvent::Hello { .. } => "hello",
        ProxyEvent::ResyncAck { .. } => "resync_ack",
        ProxyEvent::Audit { .. } => "audit",
        ProxyEvent::Alert { .. } => "alert",
        ProxyEvent::ListenerFailed { .. } => "listener_failed",
        ProxyEvent::Pong { .. } => "pong",
        ProxyEvent::Error { .. } => "error",
    }
}
