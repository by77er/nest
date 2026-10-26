//! Turning handed-over listening sockets into accept loops. The listener a connection arrives on
//! identifies its sandbox (and, for explicit listeners, the agent).

use std::io;
use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::time::Duration;

use nix::sys::socket::{SockType, getsockopt, sockopt};
use tokio::net::{TcpListener, UdpSocket};
use tokio_util::sync::CancellationToken;

use nest_protocol::control::{EgressAuditKind, EgressReason, EgressVerdict};
use nest_protocol::host::proxy::{ListenerPurpose, ListenerSpec, Transport};
use nest_protocol::model::ErrorBody;

use crate::audit::Audit;
use crate::state::{ConnCtx, Sandbox, Session};
use crate::{dns, http};

/// Start serving `fd` according to `spec`. The listener is registered on the sandbox so
/// `listeners_remove` / `sandbox_drop` can stop it.
pub fn spawn(session: &Arc<Session>, sandbox: &Arc<Sandbox>, spec: ListenerSpec, fd: OwnedFd) -> Result<(), ErrorBody> {
    let bad = |m: String| ErrorBody { code: "invalid_listener".into(), message: m, retryable: false };
    let ty = getsockopt(&fd, sockopt::SockType).map_err(|e| bad(format!("listener {}: {e}", spec.id)))?;
    let token = sandbox.drop.child_token();
    match (spec.transport, &spec.purpose) {
        (Transport::Udp, ListenerPurpose::Dns) => {
            if ty != SockType::Datagram {
                return Err(bad(format!("listener {} is not a datagram socket", spec.id)));
            }
            let std = std::net::UdpSocket::from(fd);
            std.set_nonblocking(true).map_err(|e| bad(e.to_string()))?;
            let sock = UdpSocket::from_std(std).map_err(|e| bad(e.to_string()))?;
            register(sandbox, spec.id, token.clone());
            tokio::spawn(dns::serve_udp(session.clone(), sandbox.clone(), sock, token));
        }
        (Transport::Udp, _) => return Err(bad(format!("listener {}: only dns may be udp", spec.id))),
        (Transport::Tcp, purpose) => {
            if ty != SockType::Stream {
                return Err(bad(format!("listener {} is not a stream socket", spec.id)));
            }
            let std = std::net::TcpListener::from(fd);
            std.set_nonblocking(true).map_err(|e| bad(e.to_string()))?;
            let l = TcpListener::from_std(std).map_err(|e| bad(e.to_string()))?;
            register(sandbox, spec.id, token.clone());
            tokio::spawn(accept_loop(session.clone(), sandbox.clone(), spec.id, purpose.clone(), l, token));
        }
    }
    Ok(())
}

fn register(sandbox: &Sandbox, id: u32, token: CancellationToken) {
    if let Some(old) = sandbox.listeners.lock().unwrap().insert(id, token) {
        old.cancel();
    }
}

async fn accept_loop(
    session: Arc<Session>,
    sandbox: Arc<Sandbox>,
    id: u32,
    purpose: ListenerPurpose,
    l: TcpListener,
    stop: CancellationToken,
) {
    loop {
        let s = tokio::select! {
            _ = stop.cancelled() => return,
            r = l.accept() => match r {
                Ok((s, _)) => s,
                Err(e) if transient(&e) => { tokio::time::sleep(Duration::from_millis(50)).await; continue }
                Err(e) => {
                    // Close our copy before telling nestd, which rebinds the same address.
                    sandbox.listeners.lock().unwrap().remove(&id);
                    drop(l);
                    let error = ErrorBody { code: "accept_failed".into(), message: e.to_string(), retryable: true };
                    session.listener_failed(&sandbox.id, id, error);
                    return;
                }
            },
        };
        // Fail closed: no lease (or nestd gone) → no new connections.
        if !session.lease_ok() {
            continue;
        }
        let agent = match &purpose {
            ListenerPurpose::Explicit { agent, .. } => Some(agent.clone()),
            _ => None,
        };
        let guard = match sandbox.try_acquire(&session.upstream) {
            Ok(g) => g,
            Err(which) => {
                let mut a = Audit::new("", 0, EgressVerdict::Deny).reason(EgressReason::ConnectionLimit);
                a.kind = EgressAuditKind::Limit { which };
                crate::state::submit_audit(&session, &sandbox, a.into_record(&sandbox.id, sandbox.view().epoch, agent, Some(crate::audit::via(&purpose))));
                continue;
            }
        };
        let _ = s.set_nodelay(true);
        let ctx = Arc::new(ConnCtx { session: session.clone(), sandbox: sandbox.clone(), agent, via: crate::audit::via(&purpose), _guard: guard });
        let purpose = purpose.clone();
        tokio::spawn(async move {
            match purpose {
                ListenerPurpose::Dns => dns::serve_tcp_conn(ctx.session.clone(), ctx.sandbox.clone(), s).await,
                ListenerPurpose::HttpTransparent => http::serve_http_transparent(ctx, s).await,
                ListenerPurpose::HttpsTransparent => http::serve_https_transparent(ctx, s).await,
                ListenerPurpose::Explicit { .. } => http::serve_explicit(ctx, s).await,
                ListenerPurpose::TcpException { rule } => http::serve_tcp_exception(ctx, s, rule).await,
            }
        });
    }
}

/// Accept errors that leave the listener usable: resource exhaustion (wait and retry) and the
/// ones accept(2) says to treat like `EAGAIN` (a pending network error on the new connection,
/// `ECONNABORTED`, a firewall rule refusing it). Anything else ends the listener (`listener_failed`).
fn transient(e: &io::Error) -> bool {
    use nix::errno::Errno::*;
    const RETRY: &[nix::errno::Errno] = &[
        EMFILE, ENFILE, ENOBUFS, ENOMEM, ECONNABORTED, EINTR, EAGAIN, EPERM,
        // accept(2), "Error handling": already-pending network errors, to retry like EAGAIN.
        ENETDOWN, EPROTO, ENOPROTOOPT, EHOSTDOWN, ENONET, EHOSTUNREACH, EOPNOTSUPP, ENETUNREACH,
    ];
    e.raw_os_error().is_some_and(|n| RETRY.iter().any(|r| *r as i32 == n))
        || matches!(e.kind(), io::ErrorKind::ConnectionAborted | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock)
}

#[cfg(test)]
mod tests {
    use super::transient;
    use std::io;

    #[test]
    fn accept_errors_accept2_says_to_retry_are_transient() {
        use nix::errno::Errno::*;
        for e in [EMFILE, ECONNABORTED, EPERM, ENETDOWN, EPROTO, ENOPROTOOPT, EHOSTDOWN, ENONET, EHOSTUNREACH, EOPNOTSUPP, ENETUNREACH] {
            assert!(transient(&io::Error::from_raw_os_error(e as i32)), "{e:?}");
        }
        for e in [EBADF, EINVAL, ENOTSOCK] {
            assert!(!transient(&io::Error::from_raw_os_error(e as i32)), "{e:?} ends the listener");
        }
    }
}
