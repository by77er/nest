//! nestd side of the nestd ↔ nest-proxy protocol (`docs/interfaces/host-internal/nestd-proxy/`).
//!
//! nestd owns all state in a [`Mirror`]; nest-proxy is a stateless cache rebuilt by a full
//! resync on every (re)connection. Every change goes through [`ProxyLink::apply`], which updates
//! the mirror and queues the matching command under one short lock, tagged with a sequence number.
//! The writer thread skips queued commands already covered by the last resync snapshot, so nothing
//! is lost or applied twice across reconnects.
//!
//! **`apply` never blocks on the proxy.** Queued commands carry their own duplicated listener fds,
//! and the resync snapshot (commands + duplicated fds) is built under the lock and sent after it
//! is released, so the mirror lock is never held across `sendmsg`. Sends time out
//! ([`SEND_TIMEOUT`]); a proxy that stops reading, or stops answering pings
//! ([`PING_INTERVAL`]/[`PONG_TIMEOUT`]), is disconnected and fails closed. Fencing therefore never
//! waits on nest-proxy.
//!
//! Access: the socket is `0660` (optional group), the peer uid is checked with `SO_PEERCRED`, and
//! only one proxy connection is served at a time (a second one is refused until the first closes).
//! A packet from the proxy that is oversized or undecodable is dropped, not the connection. A
//! `resync_ack` whose counts differ from the snapshot closes the connection (the proxy reconnects
//! and resyncs). Upserts, secrets and listeners for an epoch the host has tombstoned (fenced; see
//! [`crate::tombstones`]) are refused.
//!
//! Seqpacket + `SCM_RIGHTS` is done with blocking threads (`nest_protocol::host::fdpass`).

use std::collections::BTreeMap;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nest_protocol::control::CaCertificate;
use nest_protocol::host::fdpass;
use nest_protocol::host::proxy::{DropReason, ListenerSpec, ProxyCommand, ProxyEvent};
use nest_protocol::host::{PROTOCOL_VERSION, Secret};
use nest_protocol::model::{EgressPolicy, Epoch, HostId, InjectionSecret, SandboxId, TimestampMs, WorkstreamId};
use nix::sys::socket::{
    AddressFamily, Backlog, SockFlag, SockType, UnixAddr, accept4, bind, getsockopt, listen, setsockopt, socket, sockopt,
};
use tokio::sync::mpsc::UnboundedSender;

/// A blocked `sendmsg` to the proxy gives up after this long and the connection is dropped.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(2);
/// Health probe interval while connected.
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
/// No pong for this long: the proxy is presumed wedged and is disconnected (it fails closed).
pub const PONG_TIMEOUT: Duration = Duration::from_secs(15);

/// A listener held by nestd (the original fd; the proxy receives its own copy).
pub struct HeldListener {
    pub spec: ListenerSpec,
    pub fd: OwnedFd,
}

#[derive(Default)]
struct SandboxMirror {
    epoch: Option<Epoch>,
    workstream: Option<WorkstreamId>,
    policy: Option<EgressPolicy>,
    secrets: Vec<InjectionSecret>,
    listeners: BTreeMap<u32, HeldListener>,
}

#[derive(Default)]
struct Mirror {
    ca: Option<(CaCertificate, Secret)>,
    lease_valid_until: Option<TimestampMs>,
    sandboxes: BTreeMap<SandboxId, SandboxMirror>,
}

/// A change to the proxy's state.
pub enum ProxyOp {
    CaInstall { ca: CaCertificate, key_pem: Secret },
    Lease { valid_until_ms: TimestampMs },
    Upsert { sandbox: SandboxId, epoch: Epoch, workstream: Option<WorkstreamId>, policy: EgressPolicy },
    Secrets { sandbox: SandboxId, epoch: Epoch, secrets: Vec<InjectionSecret> },
    AddListeners { sandbox: SandboxId, epoch: Epoch, listeners: Vec<HeldListener> },
    RemoveListeners { sandbox: SandboxId, epoch: Epoch, ids: Vec<u32> },
    Drop { sandbox: SandboxId, epoch: Epoch, reason: DropReason },
}

/// A command to send, with its own (duplicated) fds.
struct Queued {
    seq: u64,
    cmd: ProxyCommand,
    fds: Vec<OwnedFd>,
}

enum WriterMsg {
    NewConn(OwnedFd),
    Op(Box<Queued>),
    Closed(u64),
    Ping(u64),
}

struct Shared {
    mirror: Mirror,
    next_seq: u64,
    /// The host's fenced epochs (shared with the gateway link; the host core writes them).
    tombstones: crate::tombstones::Tombstones,
}

#[derive(Clone)]
pub struct ProxyLink {
    shared: Arc<Mutex<Shared>>,
    writer: mpsc::Sender<WriterMsg>,
}

/// Notifications for the rest of nestd.
#[derive(Debug)]
pub enum ProxyNotice {
    Connected { proxy_version: String, pid: u32 },
    /// `matched`: the counts equal the snapshot; otherwise the connection is being closed.
    ResyncAck { sandboxes: u32, listeners: u32, matched: bool },
    Event(ProxyEvent),
    Disconnected,
}

/// Socket access policy (see `config::SocketsConfig`).
#[derive(Clone, Debug, Default)]
pub struct Access {
    pub gid: Option<u32>,
    pub allowed_uids: Vec<u32>,
}

/// Bind a unix socket path with mode `0660` and an optional group.
pub(crate) fn secure_socket_path(path: &Path, gid: Option<u32>) -> io::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o660))?;
    if let Some(gid) = gid {
        nix::unistd::chown(path, None, Some(nix::unistd::Gid::from_raw(gid))).map_err(io::Error::from)?;
    }
    Ok(())
}

impl ProxyLink {
    /// Listen on `path` and serve one nest-proxy connection at a time.
    /// `tombstones` is the host's one map of fenced epochs: nothing at or below one is pushed.
    pub fn start(
        path: &Path,
        host_id: HostId,
        boot_id: String,
        access: Access,
        tombstones: crate::tombstones::Tombstones,
        notices: UnboundedSender<ProxyNotice>,
    ) -> io::Result<ProxyLink> {
        let _ = std::fs::remove_file(path);
        let sock = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None).map_err(io::Error::from)?;
        bind(sock.as_raw_fd(), &UnixAddr::new(path).map_err(io::Error::from)?).map_err(io::Error::from)?;
        secure_socket_path(path, access.gid)?;
        listen(&sock, Backlog::new(8).map_err(io::Error::from)?).map_err(io::Error::from)?;

        let shared = Arc::new(Mutex::new(Shared { mirror: Mirror::default(), next_seq: 1, tombstones }));
        let (tx, rx) = mpsc::channel();
        let accept_tx = tx.clone();
        let allowed = access.allowed_uids.clone();
        std::thread::Builder::new().name("proxy-accept".into()).spawn(move || {
            loop {
                match accept4(sock.as_raw_fd(), SockFlag::SOCK_CLOEXEC) {
                    Ok(fd) => {
                        // SAFETY: accept4 returned a fresh descriptor we now own.
                        let fd = unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) };
                        match getsockopt(&fd, sockopt::PeerCredentials) {
                            Ok(cred) if crate::config::SocketsConfig::allows(&allowed, cred.uid()) => {}
                            Ok(cred) => {
                                tracing::warn!(uid = cred.uid(), pid = cred.pid(), "refusing proxy connection from a disallowed uid");
                                continue;
                            }
                            Err(e) => {
                                tracing::warn!(error = %e, "refusing proxy connection: no peer credentials");
                                continue;
                            }
                        }
                        if accept_tx.send(WriterMsg::NewConn(fd)).is_err() {
                            break;
                        }
                    }
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(e) => {
                        tracing::error!(error = %e, "proxy accept failed");
                        break;
                    }
                }
            }
        })?;
        let writer = Writer {
            shared: shared.clone(),
            tx: tx.clone(),
            notices,
            host_id,
            boot_id,
            conn: None,
            conn_id: 0,
            snapshot_seq: 0,
            last_pong: Arc::new(AtomicU64::new(0)),
            started: Instant::now(),
            next_nonce: 1,
        };
        std::thread::Builder::new().name("proxy-writer".into()).spawn(move || writer.run(rx))?;
        Ok(ProxyLink { shared, writer: tx })
    }

    /// Apply a state change: update the mirror and queue the command (atomically, briefly locked;
    /// never blocks on the proxy). Returns `false` if the change was refused because the sandbox
    /// epoch is tombstoned (fenced).
    pub fn apply(&self, op: ProxyOp) -> bool {
        let mut sh = self.shared.lock().expect("proxy mirror poisoned");
        let tombstones = sh.tombstones.clone();
        let m = &mut sh.mirror;
        let refused = |_: &Mirror, sandbox: &SandboxId, epoch: Epoch| tombstones.refuses(sandbox, epoch);
        let (cmd, fds) = match op {
            ProxyOp::CaInstall { ca, key_pem } => {
                m.ca = Some((ca.clone(), key_pem.clone()));
                (ProxyCommand::CaInstall { ca, key_pem }, vec![])
            }
            ProxyOp::Lease { valid_until_ms } => {
                m.lease_valid_until = Some(valid_until_ms);
                (ProxyCommand::LeaseUpdate { valid_until_ms }, vec![])
            }
            ProxyOp::Upsert { sandbox, epoch, workstream, policy } => {
                if refused(m, &sandbox, epoch) {
                    tracing::warn!(%sandbox, epoch = epoch.0, "refusing proxy upsert for a fenced epoch");
                    return false;
                }
                let s = m.sandboxes.entry(sandbox.clone()).or_default();
                s.epoch = Some(epoch);
                s.workstream = workstream.clone();
                s.policy = Some(policy.clone());
                (ProxyCommand::SandboxUpsert { sandbox, epoch, workstream, policy }, vec![])
            }
            ProxyOp::Secrets { sandbox, epoch, secrets } => {
                if refused(m, &sandbox, epoch) {
                    return false;
                }
                m.sandboxes.entry(sandbox.clone()).or_default().secrets = secrets.clone();
                (ProxyCommand::SecretsSet { sandbox, epoch, secrets }, vec![])
            }
            ProxyOp::AddListeners { sandbox, epoch, listeners } => {
                if refused(m, &sandbox, epoch) {
                    tracing::warn!(%sandbox, epoch = epoch.0, "refusing proxy listeners for a fenced epoch");
                    return false;
                }
                let s = m.sandboxes.entry(sandbox.clone()).or_default();
                let specs: Vec<ListenerSpec> = listeners.iter().map(|l| l.spec.clone()).collect();
                let mut fds = Vec::with_capacity(listeners.len());
                for l in &listeners {
                    match l.fd.try_clone() {
                        Ok(fd) => fds.push(fd),
                        Err(e) => {
                            tracing::error!(error = %e, "dup listener fd");
                            return false;
                        }
                    }
                }
                for l in listeners {
                    s.listeners.insert(l.spec.id, l);
                }
                // Split into packets of at most MAX_FDS_PER_PACKET, each with its own fds.
                let mut fds = fds.into_iter();
                let chunks: Vec<Vec<ListenerSpec>> = specs.chunks(fdpass::MAX_FDS_PER_PACKET).map(<[ListenerSpec]>::to_vec).collect();
                let seq = sh.next_seq;
                sh.next_seq += 1;
                for chunk in chunks {
                    let n = chunk.len();
                    let cmd = ProxyCommand::ListenersAdd { sandbox: sandbox.clone(), epoch, listeners: chunk };
                    let _ = self.writer.send(WriterMsg::Op(Box::new(Queued { seq, cmd, fds: fds.by_ref().take(n).collect() })));
                }
                return true;
            }
            ProxyOp::RemoveListeners { sandbox, epoch, ids } => {
                if let Some(s) = m.sandboxes.get_mut(&sandbox) {
                    for id in &ids {
                        s.listeners.remove(id);
                    }
                }
                (ProxyCommand::ListenersRemove { sandbox, epoch, listener_ids: ids }, vec![])
            }
            // A fence's tombstone is already recorded by the host (before this drop is queued).
            ProxyOp::Drop { sandbox, epoch, reason } => {
                m.sandboxes.remove(&sandbox);
                (ProxyCommand::SandboxDrop { sandbox, epoch, reason }, vec![])
            }
        };
        let seq = sh.next_seq;
        sh.next_seq += 1;
        let _ = self.writer.send(WriterMsg::Op(Box::new(Queued { seq, cmd, fds })));
        true
    }

    pub fn ping(&self, nonce: u64) {
        let _ = self.writer.send(WriterMsg::Ping(nonce));
    }

    /// Listener ids currently held for a sandbox.
    pub fn listener_ids(&self, sandbox: &SandboxId) -> Vec<u32> {
        let sh = self.shared.lock().expect("proxy mirror poisoned");
        sh.mirror.sandboxes.get(sandbox).map(|s| s.listeners.keys().copied().collect()).unwrap_or_default()
    }
}

struct Writer {
    shared: Arc<Mutex<Shared>>,
    tx: mpsc::Sender<WriterMsg>,
    notices: UnboundedSender<ProxyNotice>,
    host_id: HostId,
    boot_id: String,
    conn: Option<Arc<OwnedFd>>,
    conn_id: u64,
    snapshot_seq: u64,
    /// Milliseconds since `started` of the last pong (or connection).
    last_pong: Arc<AtomicU64>,
    started: Instant,
    next_nonce: u64,
}

impl Writer {
    fn elapsed_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn drop_conn(&mut self, why: &str) {
        if let Some(conn) = self.conn.take() {
            tracing::warn!(why, "disconnecting nest-proxy (it fails closed until it resyncs)");
            let _ = nix::sys::socket::shutdown(conn.as_raw_fd(), nix::sys::socket::Shutdown::Both);
        }
    }

    fn run(mut self, rx: mpsc::Receiver<WriterMsg>) {
        // Pings go out on schedule whatever else is sent: lease updates alone arrive more often than
        // every PING_INTERVAL, and a quiet-time-only ping would never be sent under them.
        let mut next_ping = Instant::now() + PING_INTERVAL;
        loop {
            let msg = match rx.recv_timeout(next_ping.saturating_duration_since(Instant::now())) {
                Ok(m) => Some(m),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            if Instant::now() >= next_ping {
                self.health_check();
                next_ping = Instant::now() + PING_INTERVAL;
            }
            let Some(msg) = msg else { continue };
            match msg {
                WriterMsg::NewConn(fd) => {
                    if self.conn.is_some() {
                        tracing::warn!("refusing a second concurrent nest-proxy connection");
                        continue; // dropping `fd` closes it; the proxy retries
                    }
                    self.conn_id += 1;
                    match self.handshake_and_resync(fd) {
                        Ok(conn) => self.conn = Some(conn),
                        Err(e) => tracing::warn!(error = %e, "proxy resync failed; waiting for reconnect"),
                    }
                }
                WriterMsg::Closed(id) if id == self.conn_id => {
                    self.conn = None;
                    let _ = self.notices.send(ProxyNotice::Disconnected);
                }
                WriterMsg::Closed(_) => {}
                WriterMsg::Op(q) => {
                    if q.seq <= self.snapshot_seq {
                        continue; // already contained in the resync snapshot
                    }
                    if let Some(conn) = self.conn.clone() {
                        let fds: Vec<BorrowedFd<'_>> = q.fds.iter().map(|f| f.as_fd()).collect();
                        if let Err(e) = fdpass::send(conn.as_fd(), &q.cmd, &fds) {
                            tracing::warn!(error = %e, "proxy send failed");
                            self.drop_conn("send failed or timed out");
                        }
                    }
                }
                WriterMsg::Ping(nonce) => {
                    if let Some(conn) = self.conn.clone()
                        && fdpass::send(conn.as_fd(), &ProxyCommand::Ping { nonce }, &[]).is_err()
                    {
                        self.drop_conn("ping send failed");
                    }
                }
            }
            if self.conn.is_some() && self.elapsed_ms().saturating_sub(self.last_pong.load(Ordering::Relaxed)) > PONG_TIMEOUT.as_millis() as u64 {
                self.drop_conn("no pong");
            }
        }
    }

    /// Periodic ping and pong-timeout check.
    fn health_check(&mut self) {
        let Some(conn) = self.conn.clone() else { return };
        if self.elapsed_ms().saturating_sub(self.last_pong.load(Ordering::Relaxed)) > PONG_TIMEOUT.as_millis() as u64 {
            self.drop_conn("no pong");
            return;
        }
        let nonce = self.next_nonce;
        self.next_nonce += 1;
        if fdpass::send(conn.as_fd(), &ProxyCommand::Ping { nonce }, &[]).is_err() {
            self.drop_conn("ping send failed");
        }
    }

    fn handshake_and_resync(&mut self, fd: OwnedFd) -> io::Result<Arc<OwnedFd>> {
        set_timeout(&fd, sockopt::ReceiveTimeout, Some(Duration::from_secs(5)))?;
        set_timeout(&fd, sockopt::SendTimeout, Some(SEND_TIMEOUT))?;
        let _ = setsockopt(&fd, sockopt::SndBufForce, &(2 * fdpass::MAX_PACKET_TO_PROXY));
        let mut buf = Vec::new();
        let hello: ProxyEvent = match fdpass::recv::<ProxyEvent>(fd.as_fd(), &mut buf, fdpass::MAX_PACKET_FROM_PROXY)? {
            Some((ev, _)) => ev,
            None => return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "proxy closed before hello")),
        };
        let ProxyEvent::Hello { protocol_version, proxy_version, pid } = hello else {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "first proxy packet was not hello"));
        };
        if protocol_version != PROTOCOL_VERSION {
            return Err(io::Error::new(io::ErrorKind::InvalidData, format!("proxy protocol {protocol_version}")));
        }
        let _ = self.notices.send(ProxyNotice::Connected { proxy_version, pid });
        fdpass::send(
            fd.as_fd(),
            &ProxyCommand::HelloAck { protocol_version: PROTOCOL_VERSION, host_id: self.host_id.clone(), nestd_boot_id: self.boot_id.clone() },
            &[],
        )?;

        // Snapshot under the lock (commands + duplicated fds, and `snapshot_seq`), send after.
        let (snapshot, expected) = {
            let sh = self.shared.lock().expect("proxy mirror poisoned");
            let m = &sh.mirror;
            let mut out: Vec<(ProxyCommand, Vec<OwnedFd>)> = vec![];
            if let Some((ca, key)) = &m.ca {
                out.push((ProxyCommand::CaInstall { ca: ca.clone(), key_pem: key.clone() }, vec![]));
            }
            if let Some(v) = m.lease_valid_until {
                out.push((ProxyCommand::LeaseUpdate { valid_until_ms: v }, vec![]));
            }
            let mut nsbx = 0u32;
            let mut nlis = 0u32;
            for (id, s) in &m.sandboxes {
                let (Some(epoch), Some(policy)) = (s.epoch, s.policy.clone()) else { continue };
                nsbx += 1;
                out.push((ProxyCommand::SandboxUpsert { sandbox: id.clone(), epoch, workstream: s.workstream.clone(), policy }, vec![]));
                out.push((ProxyCommand::SecretsSet { sandbox: id.clone(), epoch, secrets: s.secrets.clone() }, vec![]));
                let all: Vec<&HeldListener> = s.listeners.values().collect();
                for chunk in all.chunks(fdpass::MAX_FDS_PER_PACKET) {
                    let specs: Vec<ListenerSpec> = chunk.iter().map(|l| l.spec.clone()).collect();
                    let fds = chunk.iter().map(|l| l.fd.try_clone()).collect::<io::Result<Vec<OwnedFd>>>()?;
                    nlis += specs.len() as u32;
                    out.push((ProxyCommand::ListenersAdd { sandbox: id.clone(), epoch, listeners: specs }, fds));
                }
            }
            out.push((ProxyCommand::ResyncComplete { sandboxes: nsbx, listeners: nlis }, vec![]));
            self.snapshot_seq = sh.next_seq - 1;
            (out, (nsbx, nlis))
        };
        for (cmd, fds) in &snapshot {
            let b: Vec<BorrowedFd<'_>> = fds.iter().map(|f| f.as_fd()).collect();
            fdpass::send(fd.as_fd(), cmd, &b)?;
        }
        drop(snapshot);

        // Reads block indefinitely from here on (the reader thread); sends keep their timeout.
        set_timeout(&fd, sockopt::ReceiveTimeout, None)?;
        let conn = Arc::new(fd);
        self.last_pong.store(self.elapsed_ms(), Ordering::Relaxed);
        let reader_conn = conn.clone();
        let notices = self.notices.clone();
        let tx = self.tx.clone();
        let conn_id = self.conn_id;
        let last_pong = self.last_pong.clone();
        let started = self.started;
        std::thread::Builder::new().name("proxy-reader".into()).spawn(move || {
            let mut buf = Vec::new();
            loop {
                match fdpass::recv::<ProxyEvent>(reader_conn.as_fd(), &mut buf, fdpass::MAX_PACKET_FROM_PROXY) {
                    Ok(Some((ProxyEvent::ResyncAck { sandboxes, listeners }, _))) => {
                        let matched = (sandboxes, listeners) == expected;
                        let _ = notices.send(ProxyNotice::ResyncAck { sandboxes, listeners, matched });
                        if !matched {
                            tracing::warn!(?expected, got = ?(sandboxes, listeners), "proxy resync count mismatch; closing to resync");
                            let _ = nix::sys::socket::shutdown(reader_conn.as_raw_fd(), nix::sys::socket::Shutdown::Both);
                            break;
                        }
                    }
                    Ok(Some((ProxyEvent::Pong { .. }, _))) => {
                        last_pong.store(started.elapsed().as_millis() as u64, Ordering::Relaxed);
                    }
                    Ok(Some((ev, _))) => {
                        let _ = notices.send(ProxyNotice::Event(ev));
                    }
                    // Oversized (truncated) or undecodable packet: drop it, keep the link.
                    Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                        tracing::warn!(error = %e, "dropping a bad packet from nest-proxy");
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            let _ = tx.send(WriterMsg::Closed(conn_id));
        })?;
        Ok(conn)
    }
}

fn set_timeout(fd: &OwnedFd, opt: impl nix::sys::socket::SetSockOpt<Val = nix::sys::time::TimeVal>, t: Option<Duration>) -> io::Result<()> {
    let tv = match t {
        Some(d) => nix::sys::time::TimeVal::new(d.as_secs() as i64, d.subsec_micros() as i64),
        None => nix::sys::time::TimeVal::new(0, 0),
    };
    setsockopt(fd, opt, &tv).map_err(io::Error::from)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;
    use nest_protocol::host::proxy::{ListenerPurpose, Transport};
    use nest_protocol::model::{EgressLimits, HostPattern, PolicyLayer, AllowRule};
    use nix::sys::socket::connect;

    pub fn policy(version: u64) -> EgressPolicy {
        EgressPolicy {
            version,
            allow: vec![AllowRule { host: HostPattern("github.com".into()), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None }],
            passthrough: vec![],
            inject: vec![],
            tcp: vec![],
            limits: EgressLimits { max_connections: 16, bandwidth_mbps: 10, max_inspected_body_bytes: 1 << 20 },
        }
    }

    /// Minimal fake nest-proxy: connects, sends hello, returns (fd, received commands with fd counts).
    pub struct FakeProxy {
        pub fd: OwnedFd,
    }

    impl FakeProxy {
        pub fn connect(path: &Path) -> FakeProxy {
            FakeProxy::try_connect(path).unwrap()
        }
        /// Like `connect`, but returns the hello's send error: a link that refuses this proxy
        /// may close the socket before the hello is written.
        pub fn try_connect(path: &Path) -> io::Result<FakeProxy> {
            let fd = socket(AddressFamily::Unix, SockType::SeqPacket, SockFlag::SOCK_CLOEXEC, None).unwrap();
            connect(fd.as_raw_fd(), &UnixAddr::new(path).unwrap()).unwrap();
            fdpass::send(fd.as_fd(), &ProxyEvent::Hello { protocol_version: PROTOCOL_VERSION, proxy_version: "test".into(), pid: 1 }, &[])?;
            Ok(FakeProxy { fd })
        }
        pub fn recv(&self) -> (ProxyCommand, Vec<OwnedFd>) {
            set_timeout(&self.fd, sockopt::ReceiveTimeout, Some(Duration::from_secs(5))).unwrap();
            let mut buf = Vec::new();
            fdpass::recv(self.fd.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY).unwrap().expect("eof")
        }
        /// Receive until `ResyncComplete`, return everything before it.
        pub fn resync(&self) -> Vec<(ProxyCommand, Vec<OwnedFd>)> {
            let mut out = vec![];
            loop {
                let (c, fds) = self.recv();
                if let ProxyCommand::ResyncComplete { sandboxes, listeners } = c {
                    fdpass::send(self.fd.as_fd(), &ProxyEvent::ResyncAck { sandboxes, listeners }, &[]).unwrap();
                    return out;
                }
                out.push((c, fds));
            }
        }
    }

    fn tcp_listener() -> OwnedFd {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().into()
    }

    #[test]
    fn resync_then_live_updates_with_fds() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("proxy.sock");
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (ntx, _nrx) = tokio::sync::mpsc::unbounded_channel();
        let link = ProxyLink::start(&path, HostId("hst_1".into()), "boot".into(), Access::default(), Default::default(), ntx).unwrap();
        let sbx = SandboxId("sbx_a".into());

        // State applied before any proxy connects goes into the mirror only.
        link.apply(ProxyOp::Upsert { sandbox: sbx.clone(), epoch: Epoch(1), workstream: None, policy: policy(1) });
        link.apply(ProxyOp::AddListeners {
            sandbox: sbx.clone(),
            epoch: Epoch(1),
            listeners: vec![HeldListener {
                spec: ListenerSpec { id: 1, transport: Transport::Tcp, addr: "172.16.0.1:443".into(), purpose: ListenerPurpose::HttpsTransparent },
                fd: tcp_listener(),
            }],
        });
        std::thread::sleep(Duration::from_millis(50));

        let p = FakeProxy::connect(&path);
        let (ack, _) = p.recv();
        assert!(matches!(ack, ProxyCommand::HelloAck { .. }));
        let resync = p.resync();
        let kinds: Vec<&str> = resync.iter().map(|(c, _)| match c {
            ProxyCommand::SandboxUpsert { .. } => "upsert",
            ProxyCommand::SecretsSet { .. } => "secrets",
            ProxyCommand::ListenersAdd { .. } => "listeners",
            _ => "other",
        }).collect();
        assert_eq!(kinds, ["upsert", "secrets", "listeners"]);
        assert_eq!(resync[2].1.len(), 1, "one fd with the listeners_add packet");

        // Live update after resync: exactly one new packet with its fd.
        link.apply(ProxyOp::AddListeners {
            sandbox: sbx.clone(),
            epoch: Epoch(1),
            listeners: vec![HeldListener {
                spec: ListenerSpec { id: 2, transport: Transport::Tcp, addr: "172.16.0.1:3128".into(), purpose: ListenerPurpose::Explicit { agent: nest_protocol::model::AgentId("agt_1".into()), slot: 0 } },
                fd: tcp_listener(),
            }],
        });
        let (c, fds) = p.recv();
        assert!(matches!(c, ProxyCommand::ListenersAdd { ref listeners, .. } if listeners[0].id == 2));
        assert_eq!(fds.len(), 1);

        // Reconnect: the new proxy gets the full state again (both listeners), nothing duplicated.
        drop(p);
        std::thread::sleep(Duration::from_millis(50));
        let p2 = FakeProxy::connect(&path);
        let _ = p2.recv();
        let resync = p2.resync();
        let fds: usize = resync.iter().map(|(_, f)| f.len()).sum();
        assert_eq!(fds, 2);
        link.apply(ProxyOp::Drop { sandbox: sbx.clone(), epoch: Epoch(1), reason: DropReason::Fence });
        let (c, _) = p2.recv();
        assert!(matches!(c, ProxyCommand::SandboxDrop { reason: DropReason::Fence, .. }));
        assert!(link.listener_ids(&sbx).is_empty());
    }

    fn start_link(dir: &Path) -> (ProxyLink, PathBuf, tokio::sync::mpsc::UnboundedReceiver<ProxyNotice>) {
        start_link_with(dir, Default::default())
    }

    fn start_link_with(dir: &Path, tombstones: crate::tombstones::Tombstones) -> (ProxyLink, PathBuf, tokio::sync::mpsc::UnboundedReceiver<ProxyNotice>) {
        let path = dir.join("proxy.sock");
        let (ntx, nrx) = tokio::sync::mpsc::unbounded_channel();
        let link = ProxyLink::start(&path, HostId("hst_1".into()), "boot".into(), Access::default(), tombstones, ntx).unwrap();
        (link, path, nrx)
    }

    fn upsert(link: &ProxyLink, version: u64, n: usize) {
        let mut p = policy(version);
        p.allow = (0..n)
            .map(|i| AllowRule { host: HostPattern(format!("host-{i}-{}.example.com", "x".repeat(40))), ports: vec![443], layer: PolicyLayer::Base, expires_ms: None })
            .collect();
        link.apply(ProxyOp::Upsert { sandbox: SandboxId("sbx_1".into()), epoch: Epoch(1), workstream: None, policy: p });
    }

    /// Review #4 (E6): a connected proxy that stops reading must not block `apply` (and so must
    /// not block fencing); the writer gives up on the send and drops the connection.
    #[test]
    fn stalled_proxy_never_blocks_apply() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (link, path, _nrx) = start_link(dir.path());
        let p = FakeProxy::connect(&path);
        let _ = p.recv();
        let _ = p.resync();
        // Stall: never read again. Flood far past the socket buffer.
        let (tx, rx) = std::sync::mpsc::channel();
        let l2 = link.clone();
        std::thread::spawn(move || {
            for v in 1..400u64 {
                let t = std::time::Instant::now();
                upsert(&l2, v, 200);
                let _ = tx.send(t.elapsed());
            }
            l2.apply(ProxyOp::Drop { sandbox: SandboxId("sbx_1".into()), epoch: Epoch(1), reason: DropReason::Fence });
            let _ = tx.send(Duration::ZERO);
        });
        let mut n = 0;
        while let Ok(d) = rx.recv_timeout(Duration::from_secs(3)) {
            assert!(d < Duration::from_millis(500), "apply blocked for {d:?}");
            n += 1;
            if n == 400 {
                break;
            }
        }
        assert_eq!(n, 400, "apply (including the fence drop) must never block on the proxy");
        std::mem::forget(p);
    }

    /// Review #5: an oversized or undecodable packet from the proxy is dropped, not the link.
    #[test]
    fn bad_proxy_packet_is_dropped_not_the_link() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (link, path, mut nrx) = start_link(dir.path());
        let p = FakeProxy::connect(&path);
        let _ = p.recv();
        let _ = p.resync();
        // > MAX_PACKET_FROM_PROXY: a guest-controlled 70 KB Host header in an alert.
        let big = ProxyEvent::Error { error: nest_protocol::model::ErrorBody { code: "x".into(), message: "h".repeat(70_000), retryable: false } };
        let body = serde_json::to_vec(&big).unwrap();
        nix::sys::socket::send(p.fd.as_raw_fd(), &body, nix::sys::socket::MsgFlags::empty()).unwrap();
        nix::sys::socket::send(p.fd.as_raw_fd(), b"not json", nix::sys::socket::MsgFlags::empty()).unwrap();
        // The link survives: a later command still arrives, and no Disconnected notice.
        upsert(&link, 2, 1);
        let (c, _) = p.recv();
        assert!(matches!(c, ProxyCommand::SandboxUpsert { .. }));
        while let Ok(n) = nrx.try_recv() {
            assert!(!matches!(n, ProxyNotice::Disconnected), "link dropped");
        }
    }

    /// Pings keep going out while other commands stream (lease updates come every few seconds),
    /// so a healthy proxy is never dropped for "no pong".
    #[test]
    fn pings_go_out_under_steady_traffic() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (link, path, _nrx) = start_link(dir.path());
        let p = FakeProxy::connect(&path);
        let _ = p.recv();
        let _ = p.resync();
        let l2 = link.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let s2 = stop.clone();
        // One lease update a second: busier than real heartbeats.
        let feeder = std::thread::spawn(move || {
            let mut v = 1;
            while !s2.load(Ordering::Relaxed) {
                l2.apply(ProxyOp::Lease { valid_until_ms: v });
                v += 1;
                std::thread::sleep(Duration::from_secs(1));
            }
        });
        let deadline = Instant::now() + PING_INTERVAL + Duration::from_secs(2);
        let mut pinged = false;
        while Instant::now() < deadline && !pinged {
            pinged = matches!(p.recv().0, ProxyCommand::Ping { .. });
        }
        stop.store(true, Ordering::Relaxed);
        feeder.join().unwrap();
        assert!(pinged, "no ping within {:?} while lease updates streamed", PING_INTERVAL + Duration::from_secs(2));
    }

    /// Review #11/#17: a resync_ack with counts that differ from the snapshot closes the
    /// connection so the proxy resyncs.
    #[test]
    fn resync_count_mismatch_closes_the_connection() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (link, path, _nrx) = start_link(dir.path());
        upsert(&link, 1, 1);
        let p = FakeProxy::connect(&path);
        let _ = p.recv();
        loop {
            let (c, _) = p.recv();
            if let ProxyCommand::ResyncComplete { sandboxes, .. } = c {
                assert_eq!(sandboxes, 1);
                fdpass::send(p.fd.as_fd(), &ProxyEvent::ResyncAck { sandboxes: 0, listeners: 0 }, &[]).unwrap();
                break;
            }
        }
        let mut buf = vec![];
        set_timeout(&p.fd, sockopt::ReceiveTimeout, Some(Duration::from_secs(5))).unwrap();
        // EOF (or reset) once nestd closes.
        let r = fdpass::recv::<ProxyCommand>(p.fd.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY);
        assert!(matches!(r, Ok(None) | Err(_)), "{r:?}");
    }

    /// Review #9: only one proxy connection is served; a second concurrent one is refused.
    #[test]
    fn second_concurrent_proxy_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let (_link, path, _nrx) = start_link(dir.path());
        let p1 = FakeProxy::connect(&path);
        assert!(matches!(p1.recv().0, ProxyCommand::HelloAck { .. }));
        let _ = p1.resync();
        // The link closes a second proxy at once, which can land before its hello is sent: a
        // failed send is a refusal too. Otherwise it must read EOF or an error, never a command.
        match FakeProxy::try_connect(&path) {
            Err(e) => assert!(
                matches!(e.kind(), io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset),
                "unexpected hello error: {e}"
            ),
            Ok(p2) => {
                let mut buf = vec![];
                set_timeout(&p2.fd, sockopt::ReceiveTimeout, Some(Duration::from_secs(5))).unwrap();
                let r = fdpass::recv::<ProxyCommand>(p2.fd.as_fd(), &mut buf, fdpass::MAX_PACKET_TO_PROXY);
                assert!(matches!(r, Ok(None) | Err(_)), "second proxy must be refused: {r:?}");
            }
        }
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o660);
    }

    /// Review #3: once the host tombstones an epoch (a fence), nothing re-adds it to the proxy.
    #[test]
    fn fenced_epoch_cannot_be_re_added() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let tombstones = crate::tombstones::Tombstones::default();
        let (link, _path, _nrx) = start_link_with(dir.path(), tombstones.clone());
        let sbx = SandboxId("sbx_1".into());
        tombstones.fence(&sbx, Epoch(3));
        assert!(link.apply(ProxyOp::Drop { sandbox: sbx.clone(), epoch: Epoch(3), reason: DropReason::Fence }));
        assert!(!link.apply(ProxyOp::Upsert { sandbox: sbx.clone(), epoch: Epoch(3), workstream: None, policy: policy(1) }));
        assert!(!link.apply(ProxyOp::AddListeners {
            sandbox: sbx.clone(),
            epoch: Epoch(2),
            listeners: vec![HeldListener { spec: ListenerSpec { id: 1, transport: Transport::Tcp, addr: "172.16.0.1:443".into(), purpose: ListenerPurpose::HttpsTransparent }, fd: tcp_listener() }],
        }));
        assert!(link.listener_ids(&sbx).is_empty());
        // A newer epoch (the sandbox was re-placed here) is fine.
        assert!(link.apply(ProxyOp::Upsert { sandbox: sbx, epoch: Epoch(4), workstream: None, policy: policy(1) }));
    }

    /// Guest-proxy review #1: a teardown or move is not a fence, so a create retried at the same
    /// epoch is accepted (nest-proxy applies the same `DropReason::tombstones` rule). A drop never
    /// writes the host's tombstone map itself: the host records a fence before it drops.
    #[test]
    fn a_teardown_drop_does_not_tombstone() {
        let dir = tempfile::tempdir().unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let _g = rt.enter();
        let tombstones = crate::tombstones::Tombstones::default();
        let (link, _path, _nrx) = start_link_with(dir.path(), tombstones.clone());
        let sbx = SandboxId("sbx".into());
        assert!(link.apply(ProxyOp::Drop { sandbox: sbx.clone(), epoch: Epoch(2), reason: DropReason::Fence }));
        assert!(tombstones.is_empty(), "the link wrote a tombstone");
        for reason in [DropReason::Teardown, DropReason::Moved] {
            assert!(link.apply(ProxyOp::Drop { sandbox: sbx.clone(), epoch: Epoch(3), reason }));
            assert!(link.apply(ProxyOp::Upsert { sandbox: sbx.clone(), epoch: Epoch(3), workstream: None, policy: policy(1) }), "{reason:?} tombstoned");
        }
    }
}
