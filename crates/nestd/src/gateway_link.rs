//! nestd side of the nestd ↔ sandbox gateway protocol (`docs/interfaces/host-internal/`,
//! `nest_protocol::host::gateway_link`).
//!
//! nestd is the source of truth. It keeps a mirror of what the gateway needs (the cell's binding
//! verification keys and, per sandbox, the epoch, the host-side vsock socket, the attached
//! clients and the guest's version) and replays all of it on every gateway (re)connection:
//! `hello_ack`, `key_update`, one `sandbox_upsert` per sandbox, then `resync_done`. Deltas follow
//! as they happen. The gateway refuses everything once the socket closes, so a dead nestd fences
//! its gateway without a message; a dead gateway is noticed by the ping watchdog here.
//!
//! Access: the socket is `0660` (optional group), the peer uid is checked with `SO_PEERCRED`, and
//! only one gateway is served at a time.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use nest_protocol::gateway::{BindingKey, GuestInfo};
use nest_protocol::host::PROTOCOL_VERSION;
use nest_protocol::host::gateway_link::{GatewayCommand, GatewayEvent};
use nest_protocol::model::{Epoch, HostId, SandboxId};
use tokio::net::UnixListener;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_util::codec::{Framed, LengthDelimitedCodec};

/// Ping cadence and the silence after which the gateway is presumed dead and dropped. A send
/// that stalls past the pong timeout drops the peer too, so a wedged gateway never blocks a
/// replacement from connecting.
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
pub const PONG_TIMEOUT: Duration = Duration::from_secs(15);

/// The link's timers; tests shorten them.
#[derive(Clone, Copy, Debug)]
pub struct Timings {
    pub ping_interval: Duration,
    pub pong_timeout: Duration,
}

impl Default for Timings {
    fn default() -> Self {
        Timings { ping_interval: PING_INTERVAL, pong_timeout: PONG_TIMEOUT }
    }
}

#[derive(Debug)]
pub enum GatewayNotice {
    Connected { instance_id: String, listen: String },
    Disconnected,
}

/// What the gateway knows about one sandbox on this host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub epoch: Epoch,
    pub vsock_uds_path: String,
    /// Agent ids with a configured slot; a binding for any other client is refused.
    pub clients: Vec<String>,
    /// The guest's last hello; `None` until it arrives (bindings get `busy`).
    pub guest: Option<GuestInfo>,
}

#[derive(Default)]
struct State {
    keys: Vec<BindingKey>,
    sandboxes: BTreeMap<SandboxId, Entry>,
    /// The host's fenced epochs (shared with the proxy link; the host core writes them): an upsert
    /// at or below one is refused, so a late `gateway_sync` after a fence can't re-add the sandbox.
    tombstones: crate::tombstones::Tombstones,
    conn: Option<UnboundedSender<GatewayCommand>>,
}

#[derive(Clone)]
pub struct GatewayLink {
    state: Arc<Mutex<State>>,
}

impl GatewayLink {
    /// `tombstones` is the host's one map of fenced epochs: no upsert at or below one is sent.
    pub fn start(
        path: &Path,
        host_id: HostId,
        access: crate::proxy_link::Access,
        tombstones: crate::tombstones::Tombstones,
        notices: UnboundedSender<GatewayNotice>,
    ) -> io::Result<GatewayLink> {
        Self::start_with(path, host_id, access, tombstones, notices, Timings::default())
    }

    /// No gateway on this host (a brain host): no socket is bound, so no gateway ever connects and
    /// nothing is sent.
    pub fn disabled(tombstones: crate::tombstones::Tombstones) -> GatewayLink {
        GatewayLink { state: Arc::new(Mutex::new(State { tombstones, ..State::default() })) }
    }

    pub fn start_with(
        path: &Path,
        host_id: HostId,
        access: crate::proxy_link::Access,
        tombstones: crate::tombstones::Tombstones,
        notices: UnboundedSender<GatewayNotice>,
        timings: Timings,
    ) -> io::Result<GatewayLink> {
        let _ = std::fs::remove_file(path);
        let listener = UnixListener::bind(path)?;
        crate::proxy_link::secure_socket_path(path, access.gid)?;
        let link = GatewayLink { state: Arc::new(Mutex::new(State { tombstones, ..State::default() })) };
        let state = link.state.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                match stream.peer_cred() {
                    Ok(c) if crate::config::SocketsConfig::allows(&access.allowed_uids, c.uid()) => {}
                    Ok(c) => {
                        tracing::warn!(uid = c.uid(), pid = ?c.pid(), "refusing gateway connection from a disallowed uid");
                        continue;
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "refusing gateway connection: no peer credentials");
                        continue;
                    }
                }
                if state.lock().expect("gateway state").conn.is_some() {
                    tracing::warn!("refusing a second concurrent gateway connection");
                    continue;
                }
                let codec = LengthDelimitedCodec::builder().max_frame_length(nest_protocol::host::frame::MAX_FRAME).new_codec();
                let framed = Framed::new(stream, codec);
                tokio::spawn(serve(framed, state.clone(), host_id.clone(), notices.clone(), timings));
            }
        });
        Ok(link)
    }

    fn send(&self, cmd: GatewayCommand) {
        if let Some(c) = &self.state.lock().expect("gateway state").conn {
            let _ = c.send(cmd);
        }
    }

    /// Replace the binding verification keys (from FleetDO's `binding_key`).
    pub fn keys(&self, keys: Vec<BindingKey>) {
        self.state.lock().expect("gateway state").keys = keys.clone();
        self.send(GatewayCommand::KeyUpdate { keys });
    }

    /// Record a sandbox (new or changed) and tell the gateway. A no-op when nothing changed, and
    /// refused (with a warning) for a tombstoned (fenced) epoch: a sync that raced a fence must
    /// not bring the sandbox back.
    pub fn upsert(&self, sandbox: SandboxId, entry: Entry) {
        {
            let mut st = self.state.lock().expect("gateway state");
            if st.tombstones.refuses(&sandbox, entry.epoch) {
                tracing::warn!(%sandbox, epoch = entry.epoch.0, "refusing to re-add a fenced epoch to the gateway");
                return;
            }
            if st.sandboxes.get(&sandbox) == Some(&entry) {
                return;
            }
            st.sandboxes.insert(sandbox.clone(), entry.clone());
        }
        self.send(GatewayCommand::SandboxUpsert { sandbox, epoch: entry.epoch, vsock_uds_path: entry.vsock_uds_path, clients: entry.clients, guest: entry.guest });
    }

    /// Drop the sandbox from the gateway (its open calls close). On its own this leaves no
    /// tombstone: a suspended sandbox's epoch comes back on resume, and a failed create is retried
    /// at the same epoch. A fence records the epoch in the host's tombstones first, which keeps
    /// every later upsert at or below it out.
    pub fn forget(&self, sandbox: &SandboxId) {
        if self.state.lock().expect("gateway state").sandboxes.remove(sandbox).is_none() {
            return;
        }
        self.send(GatewayCommand::SandboxRemove { sandbox: sandbox.clone() });
    }

    pub fn entry(&self, sandbox: &SandboxId) -> Option<Entry> {
        self.state.lock().expect("gateway state").sandboxes.get(sandbox).cloned()
    }

    pub fn connected(&self) -> bool {
        self.state.lock().expect("gateway state").conn.is_some()
    }
}

async fn serve(mut framed: Framed<tokio::net::UnixStream, LengthDelimitedCodec>, state: Arc<Mutex<State>>, host_id: HostId, notices: UnboundedSender<GatewayNotice>, timings: Timings) {
    let hello = match framed.next().await {
        Some(Ok(b)) => serde_json::from_slice::<GatewayEvent>(&b),
        _ => return,
    };
    let (instance_id, listen) = match hello {
        Ok(GatewayEvent::Hello { protocol_version, instance_id, listen }) if protocol_version == PROTOCOL_VERSION => (instance_id, listen),
        other => {
            tracing::warn!(?other, "bad gateway hello");
            return;
        }
    };
    let (tx, mut rx) = mpsc::unbounded_channel::<GatewayCommand>();
    // Handshake and replay under the lock so concurrent deltas queue behind the resync.
    {
        let mut st = state.lock().expect("gateway state");
        if st.conn.is_some() {
            drop(st);
            tracing::warn!("refusing a second concurrent gateway connection");
            return;
        }
        let _ = tx.send(GatewayCommand::HelloAck { protocol_version: PROTOCOL_VERSION, host_id });
        let _ = tx.send(GatewayCommand::KeyUpdate { keys: st.keys.clone() });
        for (sandbox, e) in &st.sandboxes {
            let _ = tx.send(GatewayCommand::SandboxUpsert {
                sandbox: sandbox.clone(),
                epoch: e.epoch,
                vsock_uds_path: e.vsock_uds_path.clone(),
                clients: e.clients.clone(),
                guest: e.guest.clone(),
            });
        }
        let _ = tx.send(GatewayCommand::ResyncDone);
        st.conn = Some(tx.clone());
    }
    let _ = notices.send(GatewayNotice::Connected { instance_id, listen });
    let mut last_rx = Instant::now();
    let mut ping = tokio::time::interval(timings.ping_interval);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ping.tick().await; // the first tick fires at once
    // A send that stalls past the pong timeout means a wedged peer: drop it.
    let send_timeout = timings.pong_timeout;
    loop {
        tokio::select! {
            out = rx.recv() => {
                let Some(cmd) = out else { break };
                let Ok(bytes) = serde_json::to_vec(&cmd) else { continue };
                match tokio::time::timeout(send_timeout, framed.send(bytes::Bytes::from(bytes))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break,
                    Err(_) => { tracing::warn!("gateway stalled on a send; dropping it"); break; }
                }
            }
            inc = framed.next() => {
                match inc {
                    Some(Ok(b)) => {
                        // Only a decodable frame counts as liveness.
                        match serde_json::from_slice::<GatewayEvent>(&b) {
                            Ok(GatewayEvent::Pong) => last_rx = Instant::now(),
                            Ok(GatewayEvent::Hello { .. }) => {
                                tracing::warn!("gateway sent a second hello; dropping it");
                                break;
                            }
                            Ok(GatewayEvent::Error { error }) => {
                                last_rx = Instant::now();
                                tracing::warn!(code = %error.code, message = %error.message, "gateway error");
                            }
                            Err(e) => tracing::warn!(error = %e, "bad gateway event"),
                        }
                    }
                    _ => break,
                }
            }
            _ = ping.tick() => {
                if last_rx.elapsed() > timings.pong_timeout {
                    tracing::warn!("gateway silent past the pong timeout; dropping it");
                    break;
                }
                let Ok(bytes) = serde_json::to_vec(&GatewayCommand::Ping) else { continue };
                match tokio::time::timeout(send_timeout, framed.send(bytes::Bytes::from(bytes))).await {
                    Ok(Ok(())) => {}
                    Ok(Err(_)) => break,
                    Err(_) => { tracing::warn!("gateway stalled on a send; dropping it"); break; }
                }
            }
        }
    }
    {
        let mut st = state.lock().expect("gateway state");
        if st.conn.as_ref().is_some_and(|c| c.same_channel(&tx)) {
            st.conn = None;
        }
    }
    let _ = notices.send(GatewayNotice::Disconnected);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::UnixStream;

    async fn read(f: &mut Framed<UnixStream, LengthDelimitedCodec>) -> GatewayCommand {
        let b = tokio::time::timeout(Duration::from_secs(5), f.next()).await.expect("command in time").unwrap().unwrap();
        serde_json::from_slice(&b).unwrap()
    }

    async fn connect(path: &Path) -> Framed<UnixStream, LengthDelimitedCodec> {
        let s = UnixStream::connect(path).await.unwrap();
        let mut f = Framed::new(s, LengthDelimitedCodec::new());
        let hello = GatewayEvent::Hello { protocol_version: PROTOCOL_VERSION, instance_id: "g1".into(), listen: "127.0.0.1:18790".into() };
        f.send(bytes::Bytes::from(serde_json::to_vec(&hello).unwrap())).await.unwrap();
        f
    }

    fn test_policy() -> nest_protocol::model::EgressPolicy {
        use nest_protocol::model::EgressLimits;
        nest_protocol::model::EgressPolicy { version: 1, allow: vec![], passthrough: vec![], inject: vec![], tcp: vec![], limits: EgressLimits { max_connections: 1, bandwidth_mbps: 1, max_inspected_body_bytes: 1 } }
    }

    fn entry(epoch: u64, clients: &[&str], guest: Option<GuestInfo>) -> Entry {
        Entry { epoch: Epoch(epoch), vsock_uds_path: "/run/nest/vm/sbx_1/vsock.sock".into(), clients: clients.iter().map(|c| c.to_string()).collect(), guest }
    }

    /// A gateway that connects (or reconnects) gets the whole mirror in order and then
    /// `resync_done`; deltas after that arrive once; a no-op upsert is not sent.
    #[tokio::test]
    async fn replays_keys_and_sandboxes_then_streams_deltas() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.sock");
        let (ntx, mut nrx) = mpsc::unbounded_channel();
        let link = GatewayLink::start(&path, HostId("hst_1".into()), crate::proxy_link::Access::default(), Default::default(), ntx).unwrap();
        link.keys(vec![BindingKey { kid: "k1".into(), public_key: "pk".into() }]);
        let sbx = SandboxId("sbx_1".into());
        link.upsert(sbx.clone(), entry(1, &[], None));

        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, GatewayCommand::HelloAck { host_id, .. } if host_id.0 == "hst_1"));
        assert!(matches!(read(&mut f).await, GatewayCommand::KeyUpdate { keys } if keys.len() == 1 && keys[0].kid == "k1"));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { sandbox, epoch: Epoch(1), clients, guest: None, .. } if sandbox == sbx && clients.is_empty()));
        assert!(matches!(read(&mut f).await, GatewayCommand::ResyncDone));
        assert!(matches!(nrx.recv().await, Some(GatewayNotice::Connected { listen, .. }) if listen == "127.0.0.1:18790"));

        // Deltas: the guest hello, then an attached client; an identical upsert is not resent.
        let guest = GuestInfo { protocol_version: 1, capabilities: vec!["pty".into()] };
        link.upsert(sbx.clone(), entry(1, &[], Some(guest.clone())));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { guest: Some(g), .. } if g == guest));
        link.upsert(sbx.clone(), entry(1, &["agt_a"], Some(guest.clone())));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { clients, .. } if clients == vec!["agt_a".to_string()]));
        link.upsert(sbx.clone(), entry(1, &["agt_a"], Some(guest.clone())));
        link.forget(&sbx);
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxRemove { sandbox } if sandbox == sbx));
        link.forget(&sbx); // already gone: nothing is sent
        link.keys(vec![]);
        assert!(matches!(read(&mut f).await, GatewayCommand::KeyUpdate { keys } if keys.is_empty()));

        // Reconnect: the mirror is replayed (no sandboxes now), then resync_done.
        drop(f);
        assert!(matches!(nrx.recv().await, Some(GatewayNotice::Disconnected)));
        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, GatewayCommand::HelloAck { .. }));
        assert!(matches!(read(&mut f).await, GatewayCommand::KeyUpdate { keys } if keys.is_empty()));
        assert!(matches!(read(&mut f).await, GatewayCommand::ResyncDone));
    }

    /// A fence tombstones the epoch in the host's one map, which this link and the proxy link
    /// both consult: a later upsert at that epoch (a sync that raced the fence) changes nothing
    /// and sends nothing, here and at the proxy; the next epoch is accepted. `forget` alone
    /// (suspend) leaves no tombstone, so the same epoch comes back on resume.
    #[tokio::test]
    async fn fenced_epoch_cannot_be_re_added() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.sock");
        let (ntx, _nrx) = mpsc::unbounded_channel();
        let tombstones = crate::tombstones::Tombstones::default();
        let link = GatewayLink::start(&path, HostId("hst_1".into()), crate::proxy_link::Access::default(), tombstones.clone(), ntx).unwrap();
        let (ptx, _prx) = mpsc::unbounded_channel();
        let proxy = crate::proxy_link::ProxyLink::start(&dir.path().join("proxy.sock"), HostId("hst_1".into()), "boot".into(), Default::default(), tombstones.clone(), ptx).unwrap();
        let sbx = SandboxId("sbx_1".into());
        let mut f = connect(&path).await;
        for _ in 0..3 {
            let _ = read(&mut f).await; // hello_ack, key_update, resync_done
        }
        link.upsert(sbx.clone(), entry(1, &[], None));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { epoch: Epoch(1), .. }));
        tombstones.fence(&sbx, Epoch(1));
        link.forget(&sbx);
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxRemove { .. }));
        link.upsert(sbx.clone(), entry(1, &["agt_a"], None));
        assert_eq!(link.entry(&sbx), None, "a fenced epoch is not re-added");
        let upsert = |epoch| crate::proxy_link::ProxyOp::Upsert { sandbox: sbx.clone(), epoch: Epoch(epoch), workstream: None, policy: test_policy() };
        assert!(!proxy.apply(upsert(1)), "the proxy link refuses the same tombstone");
        assert!(proxy.apply(upsert(2)));
        link.upsert(sbx.clone(), entry(2, &[], None));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { epoch: Epoch(2), .. }), "the next epoch is accepted; nothing was sent for the fenced one");
        assert_eq!(link.entry(&sbx).map(|e| e.epoch), Some(Epoch(2)));
        link.forget(&sbx);
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxRemove { .. }));
        link.upsert(sbx.clone(), entry(2, &[], None));
        assert!(matches!(read(&mut f).await, GatewayCommand::SandboxUpsert { epoch: Epoch(2), .. }), "a forgotten (suspended) epoch comes back");
    }

    /// A second gateway is refused while one is connected, and a gateway that answers no ping is
    /// dropped once the pong timeout (shortened here through `Timings`) has passed since its hello.
    #[tokio::test]
    async fn second_gateway_refused_and_silent_gateway_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("gateway.sock");
        let (ntx, mut nrx) = mpsc::unbounded_channel();
        let timings = Timings { ping_interval: Duration::from_millis(100), pong_timeout: Duration::from_millis(500) };
        let _link = GatewayLink::start_with(&path, HostId("hst_1".into()), crate::proxy_link::Access::default(), Default::default(), ntx, timings).unwrap();
        let started = Instant::now();
        let mut f = connect(&path).await;
        assert!(matches!(read(&mut f).await, GatewayCommand::HelloAck { .. }));
        assert!(matches!(nrx.recv().await, Some(GatewayNotice::Connected { .. })));
        let mut f2 = connect(&path).await;
        let r = tokio::time::timeout(Duration::from_millis(200), f2.next()).await;
        assert!(!matches!(r, Ok(Some(Ok(_)))), "second gateway must get nothing");

        // Pings arrive; a silent gateway is dropped once the pong timeout has passed since its hello.
        let mut pings = 0;
        loop {
            match tokio::time::timeout(timings.pong_timeout + Duration::from_secs(5), f.next()).await {
                Ok(Some(Ok(b))) => {
                    let cmd: GatewayCommand = serde_json::from_slice(&b).unwrap();
                    if matches!(cmd, GatewayCommand::Ping) {
                        pings += 1;
                    }
                }
                Ok(_) => break, // closed
                Err(_) => panic!("nestd kept a silent gateway past the pong timeout"),
            }
        }
        assert!(pings >= 2, "expected pings before the drop, got {pings}");
        assert!(started.elapsed() >= timings.pong_timeout, "dropped too early: {:?}", started.elapsed());
        assert!(matches!(nrx.recv().await, Some(GatewayNotice::Disconnected)));
    }
}
