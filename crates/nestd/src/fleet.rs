//! Fleet channel client (`docs/interfaces/control-host/fleet/`): the I/O shell around
//! [`nestd_core::fleet`], which makes every decision (hello, the reliable outbox, command dedup,
//! heartbeats and the lease, liveness, reconnects).
//!
//! This file only moves bytes and time: it decodes what arrives (from the host, the WebSocket, or
//! the clock) into one core input, steps the core, and performs the effects it returns in order,
//! one I/O operation each, feeding every failure back as another input. The audit table of its
//! effects is in `docs/verification/nestd/`.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::{
    AgentReport, CaCertificate, Capacity, Command, ComponentVersions, FleetToHost, HostEvent, HostEventBody, HostHello, HostToFleet,
    LeaseClaim, LeaseTiming, SandboxReport, TunnelState,
};
use nest_protocol::gateway::BindingKey;
use nest_protocol::model::{ErrorBody, HostId, HostRole, PROTOCOL_VERSION, Seq, TimestampMs};
use nestd_core::fleet::{self as core, Effect, EventKind, FleetLink, Inbound, Input, Log, Notice, Now, Outbound};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::util::now_ms;

/// Provides the state FleetDO needs in hellos and heartbeats.
pub trait FleetReporter: Send + Sync + 'static {
    fn report(&self) -> (Vec<SandboxReport>, Vec<AgentReport>, Capacity);
    fn lease_claims(&self) -> Vec<LeaseClaim>;
}

#[derive(Debug)]
pub enum FleetNotice {
    Connected { lease: LeaseTiming },
    Disconnected,
    /// A new command batch; reply with `FleetInput::CommandsDone(seq)` once all are processed.
    Commands { seq: Seq, commands: Vec<Command> },
    /// Lease renewed until `deadline` (monotonic) / `deadline_boot` ([`crate::util::boottime`]);
    /// `valid_until_ms` is the same instant on the wall clock, for the proxy and runner mirrors.
    LeaseRenewed { deadline: Instant, deadline_boot: Duration, valid_until_ms: TimestampMs },
    Revoked(Vec<LeaseClaim>),
    HostToken { token: String, expires_ms: TimestampMs },
    ProxyCa(CaCertificate),
    /// Every binding verification key still valid, for the sandbox gateway.
    BindingKey(Vec<BindingKey>),
    Error(ErrorBody),
}

#[derive(Debug)]
pub enum FleetInput {
    Event(HostEvent),
    CommandsDone(Seq),
    CaRenew { csr_pem: String },
}

pub struct FleetParams {
    pub url: String,
    pub token: String,
    pub host: HostId,
    pub role: HostRole,
    pub cell: String,
    /// Reported in the hello: where clients reach this host's sandbox gateway.
    pub gateway_url: Option<String>,
    /// The tunnel's state, reported in the hello (changes go out as `tunnel_state` events).
    pub tunnel: tokio::sync::watch::Receiver<TunnelState>,
    pub versions: ComponentVersions,
    /// Random per nestd process; FleetDO resets both seq lineages when it changes.
    pub instance_id: String,
    pub flush_interval: Duration,
    /// Reported in every hello: why the configured cgroup delegation failed (`cgroup.rs`).
    pub cgroup_delegation_error: Option<String>,
}

/// A host event as the core queues it. The core decides what to shed and what to coalesce from its
/// [`EventKind`]; this only reads the kind off the event and performs a merge the core asks for.
#[derive(Clone, Debug, PartialEq)]
pub struct Ev(pub HostEvent);

impl core::OutboxEvent for Ev {
    fn kind(&self) -> EventKind {
        use nest_protocol::model::SandboxEventKind as K;
        match &self.0.body {
            HostEventBody::EgressAudit { records } => EventKind::Audit { records: records.len() },
            HostEventBody::Capacity { .. } => EventKind::Capacity,
            HostEventBody::SandboxEvent { event } => match event.kind {
                K::EgressDenied { .. } => EventKind::EgressDenied,
                K::PortOpened { .. } => EventKind::PortOpened,
                _ => EventKind::Other,
            },
            _ => EventKind::Other,
        }
    }

    fn merge(&mut self, next: Self) {
        if let (HostEventBody::EgressAudit { records: last }, HostEventBody::EgressAudit { records }) = (&mut self.0.body, next.0.body) {
            last.extend(records);
        }
    }
}

/// Frames the core passes through to the host untouched.
#[derive(Clone, Debug, PartialEq)]
pub enum Other {
    ProxyCa(CaCertificate),
    BindingKey(Vec<BindingKey>),
    Error(ErrorBody),
}

/// The fleet core's input, as this shell instantiates it.
pub type CoreInput = Input<Ev, Vec<Command>, Vec<LeaseClaim>, Other>;
type CoreEffect = Effect<Ev, Vec<Command>, Vec<LeaseClaim>, Other>;
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub fn spawn(params: FleetParams, reporter: Arc<dyn FleetReporter>, input: UnboundedReceiver<FleetInput>, notices: UnboundedSender<FleetNotice>) {
    let cfg = core::Config { protocol_version: PROTOCOL_VERSION, flush_interval_ms: params.flush_interval.as_millis() as u64 };
    let link = FleetLink::new(cfg, params.token.clone());
    let shell = Shell { params, reporter, notices, ws: None, anchor: Instant::now() };
    tokio::spawn(shell.run(link, input));
}

struct Shell {
    params: FleetParams,
    reporter: Arc<dyn FleetReporter>,
    notices: UnboundedSender<FleetNotice>,
    ws: Option<Ws>,
    /// `Now::mono` counts from here.
    anchor: Instant,
}

impl Shell {
    /// Receive → step → perform, until the host goes away. Outcomes of effects are stepped before
    /// anything new is read.
    async fn run(mut self, mut link: FleetLink<Ev>, mut input: UnboundedReceiver<FleetInput>) {
        let mut queue: VecDeque<CoreInput> = VecDeque::new();
        loop {
            while let Some(i) = queue.pop_front() {
                for e in link.step(self.now(), i) {
                    queue.extend(self.perform(e).await);
                }
            }
            let wake = link.wake_at().map(|ms| self.anchor + Duration::from_millis(ms));
            let next = tokio::select! {
                m = input.recv() => match m {
                    Some(FleetInput::Event(e)) => Input::Event(Ev(e)),
                    Some(FleetInput::CommandsDone(seq)) => Input::CommandsDone(seq.0),
                    Some(FleetInput::CaRenew { csr_pem }) => Input::CaRenew(csr_pem),
                    None => return,
                },
                m = recv(&mut self.ws) => {
                    let i = decode(m);
                    if matches!(i, Input::Closed) {
                        self.ws = None; // transport state: the socket is done
                    }
                    i
                }
                _ = sleep_until(wake) => Input::Tick,
            };
            queue.push_back(next);
        }
    }

    fn now(&self) -> Now {
        Now { mono: self.anchor.elapsed().as_millis() as u64, boot: crate::util::boottime().as_millis() as u64, wall: now_ms() }
    }

    /// One effect, one I/O operation; a failure comes back as the core's input.
    async fn perform(&mut self, e: CoreEffect) -> Option<CoreInput> {
        match e {
            Effect::Connect { token } => match connect(&self.params.url, &token).await {
                Ok(ws) => {
                    self.ws = Some(ws);
                    Some(Input::Connected)
                }
                Err(e) => Some(Input::ConnectFailed { error: format!("{e:#}") }),
            },
            Effect::Send(frame) => {
                let text = serde_json::to_string(&self.encode(&frame)).expect("frames serialize");
                let sent = match self.ws.as_mut() {
                    Some(ws) => ws.send(Message::Text(text.into())).await.is_ok(),
                    None => false,
                };
                if sent {
                    return None;
                }
                self.ws = None;
                Some(Input::SendFailed(frame))
            }
            Effect::Close => {
                self.ws = None;
                None
            }
            Effect::Notify(n) => {
                let _ = self.notices.send(self.notice(n));
                None
            }
            Effect::Log(l) => {
                log(&self.params.url, l);
                None
            }
        }
    }

    fn encode(&self, frame: &Outbound<Ev>) -> HostToFleet {
        match frame {
            Outbound::Hello { last_command_seq } => {
                let (sandboxes, agents, capacity) = self.reporter.report();
                let p = &self.params;
                HostToFleet::Hello(Box::new(HostHello {
                    protocol_version: PROTOCOL_VERSION,
                    host: p.host.clone(),
                    instance_id: p.instance_id.clone(),
                    role: p.role,
                    cell: p.cell.clone(),
                    versions: p.versions.clone(),
                    gateway_url: p.gateway_url.clone(),
                    tunnel: *p.tunnel.borrow(),
                    last_command_seq: last_command_seq.map(Seq),
                    cgroup_delegation_error: p.cgroup_delegation_error.clone(),
                    brain_epochs: true,
                    // nest-proxy ships with nestd: this release's bounds guarded requests.
                    guard_bounds: true,
                    // ...and reads a guard's `injected: "*"` as any binding.
                    guard_injected_any: true,
                    // ...and writes a binding's Basic username itself, a Basic field whole only then.
                    guard_basic_user: true,
                    sandboxes,
                    agents,
                    capacity,
                }))
            }
            Outbound::Events { seq, events } => HostToFleet::Events { seq: Seq(*seq), events: events.iter().map(|e| e.0.clone()).collect() },
            Outbound::Ack { up_to } => HostToFleet::Ack { up_to: Seq(*up_to) },
            Outbound::Heartbeat { sent_ms } => HostToFleet::Heartbeat { sent_ms: *sent_ms, leases: self.reporter.lease_claims() },
            Outbound::CaRenew { csr_pem } => HostToFleet::CaRenew { csr_pem: csr_pem.clone() },
        }
    }

    fn notice(&self, n: Notice<Vec<Command>, Vec<LeaseClaim>, Other>) -> FleetNotice {
        match n {
            Notice::Connected { lease } => {
                FleetNotice::Connected { lease: LeaseTiming { heartbeat_ms: lease.heartbeat_ms, host_fence_ms: lease.host_fence_ms, cp_expiry_ms: lease.cp_expiry_ms } }
            }
            Notice::Disconnected => FleetNotice::Disconnected,
            Notice::Commands { seq, commands } => FleetNotice::Commands { seq: Seq(seq), commands },
            Notice::LeaseRenewed { deadline_mono, deadline_boot, valid_until_ms } => FleetNotice::LeaseRenewed {
                deadline: self.anchor + Duration::from_millis(deadline_mono),
                deadline_boot: Duration::from_millis(deadline_boot),
                valid_until_ms,
            },
            Notice::Revoked(r) => FleetNotice::Revoked(r),
            Notice::HostToken { token, expires_ms } => FleetNotice::HostToken { token, expires_ms },
            Notice::Error(o) | Notice::Other(o) => match o {
                Other::ProxyCa(ca) => FleetNotice::ProxyCa(ca),
                Other::BindingKey(keys) => FleetNotice::BindingKey(keys),
                Other::Error(e) => FleetNotice::Error(e),
            },
        }
    }
}

/// What arrived on the WebSocket (the next item of its stream), as the core's input: a pure decode,
/// no I/O. The connection ends on a close, an error, or the end of the stream ([`Input::Closed`]).
/// Public so the `fleet_to_host` fuzz target (`verification/nestd/fuzz/`) drives this very code.
pub fn decode(m: Option<Result<Message, tokio_tungstenite::tungstenite::Error>>) -> CoreInput {
    let text = match &m {
        Some(Ok(Message::Text(t))) => Some(t.as_str()),
        Some(Ok(Message::Binary(b))) => std::str::from_utf8(b).ok(),
        Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => return Input::Noise { unparseable: None },
        Some(Ok(Message::Close(_)) | Err(_)) | None => return Input::Closed,
    };
    match text.map(serde_json::from_str::<FleetToHost>) {
        Some(Ok(f)) => Input::Frame(inbound(f)),
        Some(Err(e)) => Input::Noise { unparseable: Some(e.to_string()) },
        None => Input::Noise { unparseable: Some("binary frame is not UTF-8".into()) },
    }
}

/// A FleetDO frame in the core's vocabulary.
fn inbound(f: FleetToHost) -> Inbound<Vec<Command>, Vec<LeaseClaim>, Other> {
    match f {
        FleetToHost::HelloAck(a) => Inbound::HelloAck {
            protocol_version: a.protocol_version,
            last_event_seq: a.last_event_seq.map(|s| s.0),
            next_command_seq: a.next_command_seq.map(|s| s.0),
            lease: core::Lease { heartbeat_ms: a.lease.heartbeat_ms, host_fence_ms: a.lease.host_fence_ms, cp_expiry_ms: a.lease.cp_expiry_ms },
        },
        FleetToHost::HeartbeatAck { sent_ms, revoked, .. } => Inbound::HeartbeatAck { sent_ms, revoked: (!revoked.is_empty()).then_some(revoked) },
        FleetToHost::Commands { seq, commands } => Inbound::Commands { seq: seq.0, commands },
        FleetToHost::Ack { up_to } => Inbound::Ack { up_to: up_to.0 },
        FleetToHost::HostToken { token, expires_ms } => Inbound::HostToken { token, expires_ms },
        FleetToHost::BindingKey { keys } => Inbound::Other(Other::BindingKey(keys)),
        FleetToHost::ProxyCa(ca) => Inbound::Other(Other::ProxyCa(ca)),
        FleetToHost::Error { error } => Inbound::Error { code: error.code.clone(), retryable: error.retryable, error: Other::Error(error) },
    }
}

fn log(url: &str, l: Log) {
    match l {
        Log::ConnectFailed { error } => tracing::warn!(%error, url, "fleet connect failed"),
        Log::HelloRefused => tracing::error!("fleet refused hello"),
        Log::ProtocolMismatch { theirs } => tracing::error!(theirs, "fleet protocol mismatch"),
        Log::Silent { silent_ms } => tracing::warn!(silent_ms, "fleet connection silent; reconnecting"),
        Log::PeerError { reconnect } => tracing::warn!(reconnect, "fleet error"),
        Log::Unparseable { error } => tracing::warn!(%error, "unparseable fleet message"),
        Log::CommandGap { seq, expected } => tracing::warn!(seq, expected, "fleet command batch out of order; reconnecting"),
        Log::OutboxShed { shed } => tracing::warn!(shed, "fleet outbox full: shed low-value events"),
        Log::InvariantViolated { name } => tracing::error!(invariant = name, "fleet core invariant violated"),
    }
}

async fn connect(url: &str, token: &str) -> anyhow::Result<Ws> {
    let mut req = url.into_client_request()?;
    req.headers_mut().insert("Authorization", format!("Bearer {token}").parse()?);
    let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(req)).await??;
    Ok(ws)
}

async fn recv(ws: &mut Option<Ws>) -> Option<Result<Message, tokio_tungstenite::tungstenite::Error>> {
    match ws {
        Some(ws) => ws.next().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at.into()).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use nest_protocol::model::error_codes;
    use nestd_core::fleet::{OutboxEvent, absorbs, error_is_fatal, shed_rank};

    use super::*;

    fn fixtures(dir: &str) -> Vec<(String, serde_json::Value)> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/control").join(dir);
        let mut out: Vec<_> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .map(|e| e.unwrap().path())
            .map(|p| (p.file_stem().unwrap().to_string_lossy().into_owned(), serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap()))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn fixture(dir: &str, name: &str) -> serde_json::Value {
        fixtures(dir).into_iter().find(|(n, _)| n == name).unwrap_or_else(|| panic!("{dir}/{name}")).1
    }

    fn event(v: serde_json::Value) -> Ev {
        Ev(serde_json::from_value(v).expect("a host event"))
    }

    /// The core's fatal classification (it has no dependencies, so it mirrors the code names) agrees
    /// with what this shell decided from nest-protocol's list before the decision moved: for every
    /// code sent, plus the legacy name for another version.
    #[test]
    fn the_cores_fatal_codes_are_nest_protocols() {
        for code in error_codes::ALL.iter().chain([&error_codes::LEGACY_UNSUPPORTED_VERSION]) {
            let protocol = *code == error_codes::UNAUTHORIZED || error_codes::is_unsupported_version(code);
            assert_eq!(error_is_fatal(code), protocol, "{code}");
        }
        assert_eq!(core::error_codes::UNAUTHORIZED, error_codes::UNAUTHORIZED);
        assert_eq!(core::error_codes::UNSUPPORTED_VERSION, error_codes::UNSUPPORTED_VERSION);
        assert_eq!(core::error_codes::LEGACY_UNSUPPORTED_VERSION, error_codes::LEGACY_UNSUPPORTED_VERSION);
    }

    /// Every host event fixture reads as the kind, and so sheds at the rank, this shell gave it
    /// before the decision moved into the core: audits and capacity first, denied and opened ports
    /// next, anything else never.
    #[test]
    fn every_host_event_reads_as_its_kind() {
        let all = fixtures("host_event");
        assert!(all.len() >= 10, "the fixtures are there");
        for (name, v) in all {
            let (kind, rank) = match name.as_str() {
                "egress_audit" => (EventKind::Audit { records: 4 }, Some(0)),
                "capacity" => (EventKind::Capacity, Some(0)),
                "workstream" => (EventKind::PortOpened, Some(1)),
                _ => (EventKind::Other, None),
            };
            let e = event(v);
            assert_eq!((e.kind(), shed_rank(e.kind())), (kind, rank), "{name}");
        }
        let host_event = fixture("host_event", "workstream");
        for (name, w) in fixtures("sandbox_event") {
            let mut v = host_event.clone();
            v["event"] = w;
            // `<variant>.<case>`: the variant decides.
            let (kind, rank) = match name.split('.').next().unwrap() {
                "egress_denied" => (EventKind::EgressDenied, Some(1)),
                "port_opened" => (EventKind::PortOpened, Some(1)),
                _ => (EventKind::Other, None),
            };
            let e = event(v);
            assert_eq!((e.kind(), shed_rank(e.kind())), (kind, rank), "sandbox event {name}");
        }
    }

    /// A merge the core asks for appends the next batch's records, in order.
    #[test]
    fn a_merge_appends_the_audit_records() {
        let (mut a, b) = (event(fixture("host_event", "egress_audit")), event(fixture("host_event", "egress_audit")));
        assert!(absorbs(a.kind(), b.kind()));
        let HostEventBody::EgressAudit { records } = &b.0.body else { unreachable!() };
        let want: Vec<_> = records.iter().chain(records).cloned().collect();
        a.merge(b);
        assert!(matches!(&a.0.body, HostEventBody::EgressAudit { records } if *records == want));
    }

    /// The decode the shell runs on each WebSocket item: frames (text or binary) become the core's
    /// frames, error codes pass through for the core to judge, control messages are noise, and a
    /// close, an error or the end of the stream ends the connection.
    #[test]
    fn websocket_items_decode_to_core_inputs() {
        for (name, v) in fixtures("fleet_to_host") {
            let text = v.to_string();
            let from_text = decode(Some(Ok(Message::Text(text.clone().into()))));
            assert!(matches!(from_text, Input::Frame(_)), "{name}: {from_text:?}");
            assert_eq!(decode(Some(Ok(Message::Binary(text.into_bytes().into())))), from_text, "{name}");
            if name == "error" {
                let Input::Frame(Inbound::Error { code, error: Other::Error(e), .. }) = &from_text else { panic!("{from_text:?}") };
                assert_eq!(*code, e.code);
            }
        }
        let not_utf8 = decode(Some(Ok(Message::Binary(vec![0xff].into()))));
        assert_eq!(not_utf8, Input::Noise { unparseable: Some("binary frame is not UTF-8".into()) });
        assert!(matches!(decode(Some(Ok(Message::Text("{".into())))), Input::Noise { unparseable: Some(_) }));
        assert_eq!(decode(Some(Ok(Message::Ping(vec![1].into())))), Input::Noise { unparseable: None });
        assert_eq!(decode(Some(Ok(Message::Pong(vec![].into())))), Input::Noise { unparseable: None });
        assert_eq!(decode(Some(Ok(Message::Close(None)))), Input::Closed);
        assert_eq!(decode(Some(Err(tokio_tungstenite::tungstenite::Error::ConnectionClosed))), Input::Closed);
        assert_eq!(decode(None), Input::Closed);
    }
}
