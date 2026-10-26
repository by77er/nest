//! Fleet channel client (`docs/interfaces/control-host/fleet/`).
//!
//! One WebSocket per host to FleetDO. This task owns the transport concerns only:
//! - hello (with a full report) / hello_ack, reconnect with backoff;
//! - **reliable outbox** of `events` batches (seq, cumulative acks, resend after the peer's
//!   `last_event_seq`), flushed every `flush_interval` or at 100 events;
//! - inbound `commands` dedup by seq; a batch is acked only after the host reports it processed;
//! - heartbeats every `heartbeat_ms`; each `heartbeat_ack` renews the lease to
//!   `sent_instant + host_fence_ms`. Heartbeats are keyed by a strictly increasing `sent_ms`
//!   (never a raw wall-clock reading, so clock steps can't drop entries), and the deadline is kept
//!   on both `CLOCK_MONOTONIC` and `CLOCK_BOOTTIME` (the latter keeps running across suspend);
//! - liveness: no inbound message for ~2.5 heartbeat intervals ⇒ reconnect (a half-open TCP
//!   connection must not silently turn into a fence);
//! - a retryable `error` from FleetDO closes the socket: the reconnect resends everything unacked,
//!   so a batch FleetDO failed to process is never skipped by a later cumulative ack;
//! - the outbox is bounded: audit batches coalesce, and low-value events (audit, capacity,
//!   egress-denied, port-opened) are shed first when it overflows while offline.
//!
//! Everything else is reported to the host as [`FleetNotice`]s.

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::{
    AgentReport, CaCertificate, Capacity, Command, ComponentVersions, FleetToHost, HelloAck, HostEvent, HostEventBody, HostHello,
    HostToFleet, LeaseClaim, LeaseTiming, SandboxReport, TunnelState,
};
use nest_protocol::model::{ErrorBody, HostId, HostRole, PROTOCOL_VERSION, Seq, TimestampMs};
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
    BindingKey(Vec<nest_protocol::gateway::BindingKey>),
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


pub fn spawn(params: FleetParams, reporter: Arc<dyn FleetReporter>, input: UnboundedReceiver<FleetInput>, notices: UnboundedSender<FleetNotice>) {
    let state = State {
        params,
        reporter,
        notices,
        pending: Vec::new(),
        unacked: VecDeque::new(),
        // A new process has a new `instance_id`, so FleetDO resets the lineage: start at 1.
        next_seq: 1,
        last_command_seq: None,
        forwarded_command_seq: None,
        lease: LeaseTiming::default(),
        sent: BTreeMap::new(),
        last_sent_ms: 0,
        pending_ca_renew: None,
        shed: 0,
    };
    tokio::spawn(state.run(input));
}

struct State {
    params: FleetParams,
    reporter: Arc<dyn FleetReporter>,
    notices: UnboundedSender<FleetNotice>,
    /// Events not yet assigned a seq.
    pending: Vec<HostEvent>,
    /// Sent (or to be sent) batches awaiting a cumulative ack.
    unacked: VecDeque<(Seq, Vec<HostEvent>)>,
    next_seq: u64,
    /// Highest command batch fully processed (and acked).
    last_command_seq: Option<Seq>,
    /// Highest command batch handed to the host (may still be processing).
    forwarded_command_seq: Option<Seq>,
    lease: LeaseTiming,
    /// heartbeat `sent_ms` → (monotonic, boottime) send instants.
    sent: BTreeMap<TimestampMs, (Instant, Duration)>,
    /// Last `sent_ms` used: heartbeats get strictly increasing keys even if the clock steps back.
    last_sent_ms: TimestampMs,
    /// A CA renewal requested while disconnected; sent on the next connection.
    pending_ca_renew: Option<String>,
    /// Events dropped by outbox shedding since the last report.
    shed: u64,
}

/// Outbox bound (pending + unacked events) before shedding low-value events.
const MAX_OUTBOX_EVENTS: usize = 4096;
/// Audit records merged into one `egress_audit` event at most.
const MAX_AUDIT_RECORDS_PER_EVENT: usize = 512;

/// Events that may be shed when the outbox overflows, in shedding order (lower first).
fn shed_rank(e: &HostEvent) -> Option<u8> {
    use nest_protocol::model::WorkstreamEventKind as K;
    match &e.body {
        HostEventBody::EgressAudit { .. } => Some(0),
        HostEventBody::Capacity { .. } => Some(0),
        HostEventBody::Workstream { event } => match event.kind {
            K::EgressDenied { .. } | K::PortOpened { .. } => Some(1),
            _ => None,
        },
        _ => None,
    }
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

enum Exit {
    Closed,
    InputGone,
}

impl State {
    async fn run(mut self, mut input: UnboundedReceiver<FleetInput>) {
        let mut backoff = Duration::from_millis(200);
        loop {
            match self.connect().await {
                Ok(ws) => {
                    backoff = Duration::from_millis(200);
                    match self.session(ws, &mut input).await {
                        Exit::InputGone => return,
                        Exit::Closed => {}
                    }
                    let _ = self.notices.send(FleetNotice::Disconnected);
                }
                Err(e) => tracing::warn!(error = %e, url = %self.params.url, "fleet connect failed"),
            }
            // Keep accepting events while disconnected.
            let sleep = tokio::time::sleep(backoff);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    msg = input.recv() => match msg {
                        Some(m) => self.on_input_offline(m),
                        None => return,
                    },
                }
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    fn on_input_offline(&mut self, m: FleetInput) {
        match m {
            FleetInput::Event(e) => self.push_event(e),
            FleetInput::CommandsDone(seq) => self.last_command_seq = Some(seq),
            FleetInput::CaRenew { csr_pem } => self.pending_ca_renew = Some(csr_pem),
        }
    }

    /// Queue an event: coalesce audit batches, and shed low-value events past the bound.
    fn push_event(&mut self, e: HostEvent) {
        if let HostEventBody::EgressAudit { records } = &e.body
            && let Some(HostEvent { body: HostEventBody::EgressAudit { records: last }, .. }) = self.pending.last_mut()
            && last.len() + records.len() <= MAX_AUDIT_RECORDS_PER_EVENT
        {
            last.extend(records.iter().cloned());
            return;
        }
        self.pending.push(e);
        let total = self.pending.len() + self.unacked.iter().map(|(_, v)| v.len()).sum::<usize>();
        if total > MAX_OUTBOX_EVENTS {
            let target = MAX_OUTBOX_EVENTS * 3 / 4;
            for rank in 0..=1u8 {
                let before = self.pending.len();
                let mut excess = total.saturating_sub(target);
                self.pending.retain(|e| {
                    if excess > 0 && shed_rank(e) == Some(rank) {
                        excess -= 1;
                        false
                    } else {
                        true
                    }
                });
                self.shed += (before - self.pending.len()) as u64;
                let total = self.pending.len() + self.unacked.iter().map(|(_, v)| v.len()).sum::<usize>();
                if total <= target {
                    break;
                }
            }
            tracing::warn!(shed = self.shed, "fleet outbox full: shed low-value events");
        }
    }

    async fn connect(&mut self) -> anyhow::Result<Ws> {
        let mut req = self.params.url.as_str().into_client_request()?;
        req.headers_mut().insert("Authorization", format!("Bearer {}", self.params.token).parse()?);
        let (ws, _) = tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(req)).await??;
        Ok(ws)
    }

    async fn send(ws: &mut Ws, msg: &HostToFleet) -> bool {
        match serde_json::to_string(msg) {
            Ok(text) => ws.send(Message::Text(text.into())).await.is_ok(),
            Err(_) => false,
        }
    }

    async fn session(&mut self, mut ws: Ws, input: &mut UnboundedReceiver<FleetInput>) -> Exit {
        // hello
        let (sandboxes, agents, capacity) = self.reporter.report();
        let hello = HostToFleet::Hello(Box::new(HostHello {
            protocol_version: PROTOCOL_VERSION,
            host: self.params.host.clone(),
            instance_id: self.params.instance_id.clone(),
            role: self.params.role,
            cell: self.params.cell.clone(),
            versions: self.params.versions.clone(),
            gateway_url: self.params.gateway_url.clone(),
            tunnel: *self.params.tunnel.borrow(),
            last_command_seq: self.last_command_seq,
            cgroup_delegation_error: self.params.cgroup_delegation_error.clone(),
            sandboxes,
            agents,
            capacity,
        }));
        let hello_sent = Instant::now();
        let hello_sent_boot = crate::util::boottime();
        if !Self::send(&mut ws, &hello).await {
            return Exit::Closed;
        }
        let mut last_rx = Instant::now();
        let ack: HelloAck = loop {
            let msg = tokio::time::timeout(Duration::from_secs(10), ws.next()).await;
            let Ok(Some(Ok(msg))) = msg else { return Exit::Closed };
            match parse(&msg) {
                Some(FleetToHost::HelloAck(a)) => break a,
                Some(FleetToHost::Error { error }) => {
                    tracing::error!(code = %error.code, message = %error.message, "fleet refused hello");
                    let _ = self.notices.send(FleetNotice::Error(error));
                    return Exit::Closed;
                }
                _ => continue,
            }
        };
        if ack.protocol_version != PROTOCOL_VERSION {
            tracing::error!(theirs = ack.protocol_version, "fleet protocol mismatch");
            return Exit::Closed;
        }
        self.lease = ack.lease;
        // Hello acknowledged: the lease is renewed from the moment the hello was sent.
        self.renew(hello_sent, hello_sent_boot);
        let _ = self.notices.send(FleetNotice::Connected { lease: ack.lease });
        if let Some(up_to) = ack.last_event_seq {
            self.unacked.retain(|(s, _)| *s > up_to);
        }
        for (seq, events) in self.unacked.clone() {
            if !Self::send(&mut ws, &HostToFleet::Events { seq, events }).await {
                return Exit::Closed;
            }
        }
        // The forwarded-but-unprocessed batch will be resent by FleetDO; dedup handles it.
        self.forwarded_command_seq = self.last_command_seq;
        if let Some(csr_pem) = self.pending_ca_renew.take()
            && !Self::send(&mut ws, &HostToFleet::CaRenew { csr_pem: csr_pem.clone() }).await
        {
            self.pending_ca_renew = Some(csr_pem);
            return Exit::Closed;
        }
        let hb_interval = Duration::from_millis(self.lease.heartbeat_ms.max(10));
        // No inbound traffic for 2.5 intervals: the connection is presumed dead.
        let liveness = hb_interval * 5 / 2;

        let mut heartbeat = tokio::time::interval(hb_interval);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut flush = tokio::time::interval(self.params.flush_interval);
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if last_rx.elapsed() > liveness {
                        tracing::warn!(silent_ms = last_rx.elapsed().as_millis() as u64, "fleet connection silent; reconnecting");
                        return Exit::Closed;
                    }
                    let sent_ms = now_ms().max(self.last_sent_ms + 1);
                    self.last_sent_ms = sent_ms;
                    self.sent.insert(sent_ms, (Instant::now(), crate::util::boottime()));
                    // Keep only recent send times.
                    while self.sent.len() > 64 { let k = *self.sent.keys().next().expect("non-empty"); self.sent.remove(&k); }
                    let hb = HostToFleet::Heartbeat { sent_ms, leases: self.reporter.lease_claims() };
                    if !Self::send(&mut ws, &hb).await { return Exit::Closed; }
                }
                _ = flush.tick() => {
                    if !self.flush(&mut ws).await { return Exit::Closed; }
                }
                msg = input.recv() => {
                    let Some(m) = msg else { return Exit::InputGone };
                    match m {
                        FleetInput::Event(e) => {
                            self.push_event(e);
                            if self.pending.len() >= 100 && !self.flush(&mut ws).await { return Exit::Closed; }
                        }
                        FleetInput::CommandsDone(seq) => {
                            self.last_command_seq = Some(self.last_command_seq.map_or(seq, |s| s.max(seq)));
                            // Flush first so command results precede the ack.
                            if !self.flush(&mut ws).await { return Exit::Closed; }
                            if !Self::send(&mut ws, &HostToFleet::Ack { up_to: seq }).await { return Exit::Closed; }
                        }
                        FleetInput::CaRenew { csr_pem } => {
                            if !Self::send(&mut ws, &HostToFleet::CaRenew { csr_pem: csr_pem.clone() }).await {
                                self.pending_ca_renew = Some(csr_pem);
                                return Exit::Closed;
                            }
                        }
                    }
                }
                msg = ws.next() => {
                    let Some(Ok(msg)) = msg else { return Exit::Closed };
                    if let Message::Close(_) = msg { return Exit::Closed; }
                    last_rx = Instant::now();
                    let Some(m) = parse(&msg) else { continue };
                    if !self.on_message(&mut ws, m).await { return Exit::Closed; }
                }
            }
        }
    }

    async fn flush(&mut self, ws: &mut Ws) -> bool {
        if self.pending.is_empty() {
            return true;
        }
        let events = std::mem::take(&mut self.pending);
        let seq = Seq(self.next_seq);
        self.next_seq += 1;
        self.unacked.push_back((seq, events.clone()));
        Self::send(ws, &HostToFleet::Events { seq, events }).await
    }

    fn renew(&mut self, sent_at: Instant, sent_boot: Duration) {
        let fence = Duration::from_millis(self.lease.host_fence_ms);
        let deadline = sent_at + fence;
        let deadline_boot = sent_boot + fence;
        let remaining = deadline_boot.saturating_sub(crate::util::boottime()).min(deadline.saturating_duration_since(Instant::now()));
        let valid_until_ms = now_ms() + remaining.as_millis() as i64;
        let _ = self.notices.send(FleetNotice::LeaseRenewed { deadline, deadline_boot, valid_until_ms });
    }

    async fn on_message(&mut self, ws: &mut Ws, m: FleetToHost) -> bool {
        match m {
            FleetToHost::HelloAck(_) => {}
            FleetToHost::HeartbeatAck { sent_ms, revoked, .. } => {
                if let Some((at, boot)) = self.sent.get(&sent_ms).copied() {
                    self.sent.retain(|k, _| *k > sent_ms);
                    self.renew(at, boot);
                }
                if !revoked.is_empty() {
                    let _ = self.notices.send(FleetNotice::Revoked(revoked));
                }
            }
            FleetToHost::Commands { seq, commands } => {
                if self.last_command_seq.is_some_and(|l| seq <= l) {
                    // Already processed: re-ack.
                    return Self::send(ws, &HostToFleet::Ack { up_to: self.last_command_seq.expect("checked") }).await;
                }
                if self.forwarded_command_seq.is_some_and(|f| seq <= f) {
                    return true; // still processing
                }
                self.forwarded_command_seq = Some(seq);
                let _ = self.notices.send(FleetNotice::Commands { seq, commands });
            }
            FleetToHost::Ack { up_to } => {
                self.unacked.retain(|(s, _)| *s > up_to);
            }
            FleetToHost::HostToken { token, expires_ms } => {
                self.params.token = token.clone();
                let _ = self.notices.send(FleetNotice::HostToken { token, expires_ms });
            }
            FleetToHost::ProxyCa(ca) => {
                let _ = self.notices.send(FleetNotice::ProxyCa(ca));
            }
            FleetToHost::BindingKey { keys } => {
                let _ = self.notices.send(FleetNotice::BindingKey(keys));
            }
            FleetToHost::Error { error } => {
                let fatal = error.code == nest_protocol::model::error_codes::UNAUTHORIZED
                    || nest_protocol::model::error_codes::is_unsupported_version(&error.code);
                // A retryable error means FleetDO failed to process something we sent (it did not
                // ack it). Reconnect so everything unacked is resent in order; carrying on would
                // let a later batch's cumulative ack cover the failed one.
                let reconnect = fatal || error.retryable;
                tracing::warn!(code = %error.code, message = %error.message, reconnect, "fleet error");
                let _ = self.notices.send(FleetNotice::Error(error));
                if reconnect {
                    return false;
                }
            }
        }
        true
    }
}

fn parse(msg: &Message) -> Option<FleetToHost> {
    let text = match msg {
        Message::Text(t) => t.as_str(),
        Message::Binary(b) => std::str::from_utf8(b).ok()?,
        _ => return None,
    };
    match serde_json::from_str(text) {
        Ok(m) => Some(m),
        Err(e) => {
            tracing::warn!(error = %e, "unparseable fleet message");
            None
        }
    }
}
