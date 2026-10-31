//! Turning handed-over listening sockets into accept loops. The listener a connection arrives on
//! identifies its sandbox (and, for explicit listeners, the agent).

use std::io;
use std::os::fd::OwnedFd;
use std::sync::Arc;
use std::time::Duration;

use nix::sys::socket::{SockType, getsockopt, sockopt};
use tokio::net::{TcpListener, UdpSocket};
use tokio_util::sync::CancellationToken;

use nest_protocol::control::EgressVerdict;
use nest_protocol::host::proxy::{ListenerPurpose, ListenerSpec, ProxyEvent, Transport};
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
                    session.emit(ProxyEvent::ListenerFailed {
                        sandbox: sandbox.id.clone(),
                        listener_id: id,
                        error: ErrorBody { code: "accept_failed".into(), message: e.to_string(), retryable: true },
                    });
                    sandbox.listeners.lock().unwrap().remove(&id);
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
        let Some(guard) = sandbox.try_acquire() else {
            let a = Audit::new("", 0, EgressVerdict::Deny).reason("connection_limit");
            crate::state::submit_audit(&session, &sandbox, a.into_record(&sandbox.id, sandbox.view().epoch, agent, Some(crate::audit::via(&purpose))));
            continue;
        };
        let _ = s.set_nodelay(true);
        let ctx = Arc::new(ConnCtx { session: session.clone(), sandbox: sandbox.clone(), agent, via: crate::audit::via(&purpose), _guard: guard });
        let purpose = purpose.clone();
        tokio::spawn(async move {
            match purpose {
                ListenerPurpose::Dns => dns::serve_tcp_conn(ctx.session.clone(), ctx.sandbox.clone(), s).await,
                ListenerPurpose::HttpTransparent => http::serve_h1(ctx, s, false).await,
                ListenerPurpose::HttpsTransparent => http::serve_https_transparent(ctx, s).await,
                ListenerPurpose::Explicit { .. } => http::serve_h1(ctx, s, true).await,
                ListenerPurpose::TcpException { rule } => http::serve_tcp_exception(ctx, s, rule).await,
            }
        });
    }
}

fn transient(e: &io::Error) -> bool {
    matches!(e.raw_os_error(), Some(libc_errno::EMFILE | libc_errno::ENFILE | libc_errno::ENOBUFS | libc_errno::ENOMEM | libc_errno::ECONNABORTED | libc_errno::EINTR | libc_errno::EPROTO))
        || matches!(e.kind(), io::ErrorKind::ConnectionAborted | io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock)
}

mod libc_errno {
    use nix::errno::Errno;
    pub const EMFILE: i32 = Errno::EMFILE as i32;
    pub const ENFILE: i32 = Errno::ENFILE as i32;
    pub const ENOBUFS: i32 = Errno::ENOBUFS as i32;
    pub const ENOMEM: i32 = Errno::ENOMEM as i32;
    pub const ECONNABORTED: i32 = Errno::ECONNABORTED as i32;
    pub const EINTR: i32 = Errno::EINTR as i32;
    pub const EPROTO: i32 = Errno::EPROTO as i32;
}
