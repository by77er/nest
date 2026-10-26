//! The fleet link's core: nestd's side of the one WebSocket to FleetDO
//! (`docs/interfaces/control-host/fleet/`), as a pure state machine.
//!
//! It owns every decision the link makes: when to connect and back off, the hello and what the
//! hello_ack resets, the **reliable outbox** of `events` batches (seq, cumulative acks, resend after
//! the peer's `last_event_seq`, audit coalescing and shedding), inbound `commands` (dedup by seq,
//! forwarded once, acked only after the host reports them done), heartbeats with strictly
//! increasing keys and the lease each ack renews, the liveness drop, and which peer errors
//! reconnect. The shell (`nestd::fleet`) decodes frames into [`Input`]s, passes the clock in as
//! [`Now`], and performs the [`Effect`]s in order; it never decides anything itself.
//!
//! Nothing here is durable: the link's state lives and dies with the process, and a new process
//! (a new `instance_id`) starts a new lineage that FleetDO resets on its side.
//!
//! The core is generic over the payloads it only carries: `E` events (it needs [`OutboxEvent`] to
//! shed and coalesce them), `C` a command batch, `R` revoked claims, `O` anything else passed
//! through to the host. nestd instantiates them with the protocol types; the model checker with
//! small ones.

use std::collections::{BTreeMap, VecDeque};

use crate::invariant;

pub type Seq = u64;

/// Clock readings the shell takes and passes in with every input, in milliseconds: `mono` and
/// `boot` since a fixed anchor of the shell's (`CLOCK_MONOTONIC`, `CLOCK_BOOTTIME`, which keeps
/// running across suspend), `wall` since the Unix epoch.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Now {
    pub mono: u64,
    pub boot: u64,
    pub wall: i64,
}

/// What the core needs to know about an event it queues.
pub trait OutboxEvent: Clone {
    /// Shedding order when the outbox overflows (lower first); `None`: never shed.
    fn shed_rank(&self) -> Option<u8>;
    /// Merge `next` into `self` if both are mergeable (audit records, within their bound).
    fn absorb(&mut self, next: &Self) -> bool;
}

/// The lease timing FleetDO hands out in `hello_ack`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Lease {
    pub heartbeat_ms: u64,
    pub host_fence_ms: u64,
    pub cp_expiry_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    /// The protocol version this nestd speaks; a hello_ack with another closes the connection.
    pub protocol_version: u32,
    pub flush_interval_ms: u64,
}

/// Outbox bound (pending + unacked events) before shedding low-value events.
pub const MAX_OUTBOX_EVENTS: usize = 4096;
/// Pending events that trigger a flush before the next tick.
pub const FLUSH_AT_EVENTS: usize = 100;
/// Reconnect backoff: first wait, and the cap it doubles up to.
pub const BACKOFF_FIRST_MS: u64 = 200;
pub const BACKOFF_MAX_MS: u64 = 30_000;
/// How long the hello waits for each frame before giving up on the connection.
pub const HELLO_WAIT_MS: u64 = 10_000;
/// Heartbeat send times kept for matching acks.
pub const HEARTBEATS_KEPT: usize = 64;

/// A frame from FleetDO, decoded.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Inbound<C, R, O> {
    HelloAck { protocol_version: u32, last_event_seq: Option<Seq>, next_command_seq: Option<Seq>, lease: Lease },
    HeartbeatAck { sent_ms: i64, revoked: Option<R> },
    Commands { seq: Seq, commands: C },
    Ack { up_to: Seq },
    HostToken { token: String, expires_ms: i64 },
    /// `fatal`: the peer will never accept this host as it is (unauthorized, another version).
    Error { fatal: bool, retryable: bool, error: O },
    /// Passed to the host as is (proxy CA, binding keys).
    Other(O),
}

/// A frame to FleetDO. The shell adds what only it can read (the hello's report, the heartbeat's
/// lease claims).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Outbound<E> {
    Hello { last_command_seq: Option<Seq> },
    Events { seq: Seq, events: Vec<E> },
    Ack { up_to: Seq },
    Heartbeat { sent_ms: i64 },
    CaRenew { csr_pem: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Input<E, C, R, O> {
    /// From the host: an event to deliver.
    Event(E),
    /// From the host: every command of batch `seq` has run and its result is queued.
    CommandsDone(Seq),
    /// From the host: ask FleetDO to sign a new proxy CA.
    CaRenew(String),
    /// Outcome of [`Effect::Connect`].
    Connected,
    /// Outcome of [`Effect::Connect`].
    ConnectFailed { error: String },
    /// Outcome of an [`Effect::Send`] that failed: the connection is gone, and this frame with it.
    SendFailed(Outbound<E>),
    /// The connection ended (the peer closed it, or reading failed).
    Closed,
    Frame(Inbound<C, R, O>),
    /// Something arrived that isn't a frame (a ping, or a message that doesn't parse).
    Noise { unparseable: Option<String> },
    /// The time [`FleetLink::wake_at`] named has come.
    Tick,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Notice<C, R, O> {
    Connected { lease: Lease },
    Disconnected,
    /// A new command batch; answer with [`Input::CommandsDone`] once all are processed.
    Commands { seq: Seq, commands: C },
    /// Lease renewed until `deadline_mono` / `deadline_boot` (the shell's clocks);
    /// `valid_until_ms` is the same instant on the wall clock.
    LeaseRenewed { deadline_mono: u64, deadline_boot: u64, valid_until_ms: i64 },
    Revoked(R),
    HostToken { token: String, expires_ms: i64 },
    Error(O),
    Other(O),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Log {
    ConnectFailed { error: String },
    HelloRefused,
    ProtocolMismatch { theirs: u32 },
    Silent { silent_ms: u64 },
    PeerError { reconnect: bool },
    Unparseable { error: String },
    OutboxShed { shed: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Effect<E, C, R, O> {
    /// Open a WebSocket to FleetDO with this bearer token → [`Input::Connected`] or
    /// [`Input::ConnectFailed`].
    Connect { token: String },
    /// Send one frame; a failure comes back as [`Input::SendFailed`].
    Send(Outbound<E>),
    /// Drop the connection. Nothing comes back: the core already treats it as gone.
    Close,
    /// Tell the host.
    Notify(Notice<C, R, O>),
    Log(Log),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    Idle,
    Connecting,
    AwaitingAck,
    Open,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Conn {
    /// Not connected; connect at `retry_at`.
    Idle { retry_at: u64 },
    /// [`Effect::Connect`] is running.
    Connecting,
    /// The hello went out at `hello_sent`; give up at `deadline` unless a frame arrives.
    AwaitingAck { hello_sent: (u64, u64), deadline: u64 },
    Open { last_rx: u64, next_heartbeat: u64, next_flush: u64 },
}

/// The fleet link's state. Hashable when its events are, for the model checker.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct FleetLink<E> {
    cfg: Config,
    conn: Conn,
    backoff_ms: u64,
    /// The bearer token for the next connection (FleetDO rotates it).
    token: String,
    lease: Lease,
    /// Events not yet assigned a seq.
    pending: Vec<E>,
    /// Sent (or to be sent) batches awaiting a cumulative ack.
    unacked: VecDeque<(Seq, Vec<E>)>,
    next_seq: Seq,
    /// Highest command batch fully processed (and acked).
    last_command_seq: Option<Seq>,
    /// Highest command batch handed to the host (may still be processing).
    forwarded_command_seq: Option<Seq>,
    /// Heartbeat `sent_ms` → (monotonic, boottime) send instants.
    sent: BTreeMap<i64, (u64, u64)>,
    /// Last `sent_ms` used: heartbeat keys strictly increase even if the wall clock steps back.
    last_sent_ms: i64,
    /// A CA renewal not yet sent; sent on the next connection.
    pending_ca_renew: Option<String>,
    /// Events dropped by outbox shedding since the process started.
    shed: u64,
}

type Effects<E, C, R, O> = Vec<Effect<E, C, R, O>>;

impl<E: OutboxEvent> FleetLink<E> {
    /// A new process: a new lineage, so seqs start at 1. The first [`Input::Tick`] connects.
    pub fn new(cfg: Config, token: String) -> Self {
        FleetLink {
            cfg,
            conn: Conn::Idle { retry_at: 0 },
            backoff_ms: BACKOFF_FIRST_MS,
            token,
            lease: Lease::default(),
            pending: Vec::new(),
            unacked: VecDeque::new(),
            next_seq: 1,
            last_command_seq: None,
            forwarded_command_seq: None,
            sent: BTreeMap::new(),
            last_sent_ms: 0,
            pending_ca_renew: None,
            shed: 0,
        }
    }

    /// When the shell must feed [`Input::Tick`] next (`None`: only on another input).
    pub fn wake_at(&self) -> Option<u64> {
        match self.conn {
            Conn::Idle { retry_at } => Some(retry_at),
            Conn::Connecting => None,
            Conn::AwaitingAck { deadline, .. } => Some(deadline),
            Conn::Open { next_heartbeat, next_flush, .. } => Some(next_heartbeat.min(next_flush)),
        }
    }

    /// Where the connection stands.
    pub fn phase(&self) -> Phase {
        match self.conn {
            Conn::Idle { .. } => Phase::Idle,
            Conn::Connecting => Phase::Connecting,
            Conn::AwaitingAck { .. } => Phase::AwaitingAck,
            Conn::Open { .. } => Phase::Open,
        }
    }

    /// Whether a connection is up and past its hello.
    pub fn is_open(&self) -> bool {
        matches!(self.conn, Conn::Open { .. })
    }

    pub fn last_command_seq(&self) -> Option<Seq> {
        self.last_command_seq
    }

    pub fn forwarded_command_seq(&self) -> Option<Seq> {
        self.forwarded_command_seq
    }

    /// Seqs of the batches sent and not yet acknowledged, oldest first.
    pub fn unacked_seqs(&self) -> impl Iterator<Item = Seq> + '_ {
        self.unacked.iter().map(|(s, _)| *s)
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn step<C, R, O>(&mut self, now: Now, input: Input<E, C, R, O>) -> Effects<E, C, R, O> {
        let mut fx = Vec::new();
        match input {
            Input::Event(e) => {
                self.push_event(e, &mut fx);
                if self.is_open() && self.pending.len() >= FLUSH_AT_EVENTS {
                    self.flush(&mut fx);
                }
            }
            Input::CommandsDone(seq) => {
                if self.is_open() {
                    self.last_command_seq = Some(self.last_command_seq.map_or(seq, |s| s.max(seq)));
                    // Flush first so command results precede the ack.
                    self.flush(&mut fx);
                    fx.push(Effect::Send(Outbound::Ack { up_to: seq }));
                } else {
                    self.last_command_seq = Some(seq);
                }
            }
            Input::CaRenew(csr_pem) => {
                if self.is_open() {
                    fx.push(Effect::Send(Outbound::CaRenew { csr_pem }));
                } else {
                    self.pending_ca_renew = Some(csr_pem);
                }
            }
            Input::Connected => {
                if self.conn == Conn::Connecting {
                    self.backoff_ms = BACKOFF_FIRST_MS;
                    fx.push(Effect::Send(Outbound::Hello { last_command_seq: self.last_command_seq }));
                    self.conn = Conn::AwaitingAck { hello_sent: (now.mono, now.boot), deadline: now.mono + HELLO_WAIT_MS };
                }
            }
            Input::ConnectFailed { error } => {
                if self.conn == Conn::Connecting {
                    fx.push(Effect::Log(Log::ConnectFailed { error }));
                    self.retry_later(now);
                }
            }
            Input::SendFailed(frame) => {
                // A CA renewal that never left is sent on the next connection.
                if let Outbound::CaRenew { csr_pem } = frame
                    && self.pending_ca_renew.is_none()
                {
                    self.pending_ca_renew = Some(csr_pem);
                }
                self.lost(now, &mut fx);
            }
            Input::Closed => self.lost(now, &mut fx),
            Input::Noise { unparseable } => {
                if let Some(error) = unparseable {
                    fx.push(Effect::Log(Log::Unparseable { error }));
                }
                self.heard(now);
            }
            Input::Frame(f) => self.on_frame(now, f, &mut fx),
            Input::Tick => self.on_tick(now, &mut fx),
        }
        invariant::check(Self::effects_well_formed(&fx), "fleet_effects_well_formed");
        invariant::check(self.unacked.iter().zip(self.unacked.iter().skip(1)).all(|(a, b)| a.0 < b.0), "fleet_unacked_in_order");
        invariant::check(self.unacked.back().is_none_or(|(s, _)| *s < self.next_seq), "fleet_seq_never_reused");
        fx
    }

    /// At most one connect per step, and nothing is sent after a close.
    fn effects_well_formed<C, R, O>(fx: &Effects<E, C, R, O>) -> bool {
        let close = fx.iter().position(|e| matches!(e, Effect::Close));
        let connects = fx.iter().filter(|e| matches!(e, Effect::Connect { .. })).count();
        connects <= 1 && close.is_none_or(|i| !fx[i + 1..].iter().any(|e| matches!(e, Effect::Send(_) | Effect::Close)))
    }

    /// The connection is gone (closed by the peer, a failed send, or our own `Close`).
    fn lost<C, R, O>(&mut self, now: Now, fx: &mut Effects<E, C, R, O>) {
        if matches!(self.conn, Conn::AwaitingAck { .. } | Conn::Open { .. }) {
            fx.push(Effect::Notify(Notice::Disconnected));
            self.retry_later(now);
        }
    }

    fn retry_later(&mut self, now: Now) {
        self.conn = Conn::Idle { retry_at: now.mono + self.backoff_ms };
        self.backoff_ms = (self.backoff_ms * 2).min(BACKOFF_MAX_MS);
    }

    fn close<C, R, O>(&mut self, now: Now, fx: &mut Effects<E, C, R, O>) {
        fx.push(Effect::Close);
        self.lost(now, fx);
    }

    /// Any inbound traffic proves the connection alive (and keeps the hello waiting).
    fn heard(&mut self, now: Now) {
        match &mut self.conn {
            Conn::AwaitingAck { deadline, .. } => *deadline = now.mono + HELLO_WAIT_MS,
            Conn::Open { last_rx, .. } => *last_rx = now.mono,
            _ => {}
        }
    }

    fn on_tick<C, R, O>(&mut self, now: Now, fx: &mut Effects<E, C, R, O>) {
        match self.conn {
            Conn::Idle { retry_at } if now.mono >= retry_at => {
                self.conn = Conn::Connecting;
                fx.push(Effect::Connect { token: self.token.clone() });
            }
            Conn::AwaitingAck { deadline, .. } if now.mono >= deadline => self.close(now, fx),
            Conn::Open { last_rx, next_heartbeat, next_flush } => {
                let hb = self.lease.heartbeat_ms.max(10);
                if now.mono >= next_heartbeat {
                    // No inbound traffic for 2.5 intervals: the connection is presumed dead.
                    let silent = now.mono.saturating_sub(last_rx);
                    if silent > hb * 5 / 2 {
                        fx.push(Effect::Log(Log::Silent { silent_ms: silent }));
                        return self.close(now, fx);
                    }
                    let sent_ms = now.wall.max(self.last_sent_ms + 1);
                    invariant::check(sent_ms > self.last_sent_ms, "fleet_heartbeat_keys_increase");
                    self.last_sent_ms = sent_ms;
                    self.sent.insert(sent_ms, (now.mono, now.boot));
                    while self.sent.len() > HEARTBEATS_KEPT {
                        self.sent.pop_first();
                    }
                    fx.push(Effect::Send(Outbound::Heartbeat { sent_ms }));
                    if let Conn::Open { next_heartbeat, .. } = &mut self.conn {
                        *next_heartbeat = now.mono + hb;
                    }
                }
                if now.mono >= next_flush {
                    self.flush(fx);
                    if let Conn::Open { next_flush, .. } = &mut self.conn {
                        *next_flush = now.mono + self.cfg.flush_interval_ms;
                    }
                }
            }
            _ => {}
        }
    }

    fn on_frame<C, R, O>(&mut self, now: Now, f: Inbound<C, R, O>, fx: &mut Effects<E, C, R, O>) {
        self.heard(now);
        match self.conn {
            Conn::AwaitingAck { hello_sent, .. } => match f {
                Inbound::HelloAck { protocol_version, last_event_seq, next_command_seq: _, lease } => {
                    if protocol_version != self.cfg.protocol_version {
                        fx.push(Effect::Log(Log::ProtocolMismatch { theirs: protocol_version }));
                        return self.close(now, fx);
                    }
                    self.lease = lease;
                    // Hello acknowledged: the lease is renewed from the moment the hello was sent.
                    self.renew(now, hello_sent, fx);
                    fx.push(Effect::Notify(Notice::Connected { lease }));
                    if let Some(up_to) = last_event_seq {
                        self.unacked.retain(|(s, _)| *s > up_to);
                    }
                    for (seq, events) in &self.unacked {
                        fx.push(Effect::Send(Outbound::Events { seq: *seq, events: events.clone() }));
                    }
                    // The forwarded-but-unprocessed batch will be resent by FleetDO; dedup handles it.
                    self.forwarded_command_seq = self.last_command_seq;
                    if let Some(csr_pem) = self.pending_ca_renew.take() {
                        fx.push(Effect::Send(Outbound::CaRenew { csr_pem }));
                    }
                    // Both timers fire at once, as a fresh interval's first tick does; liveness counts
                    // from the hello.
                    self.conn = Conn::Open { last_rx: hello_sent.0, next_heartbeat: now.mono, next_flush: now.mono };
                }
                Inbound::Error { error, .. } => {
                    fx.push(Effect::Log(Log::HelloRefused));
                    fx.push(Effect::Notify(Notice::Error(error)));
                    self.close(now, fx);
                }
                _ => {}
            },
            Conn::Open { .. } => match f {
                Inbound::HelloAck { .. } => {}
                Inbound::HeartbeatAck { sent_ms, revoked } => {
                    if let Some(at) = self.sent.get(&sent_ms).copied() {
                        self.sent.retain(|k, _| *k > sent_ms);
                        self.renew(now, at, fx);
                    }
                    if let Some(r) = revoked {
                        fx.push(Effect::Notify(Notice::Revoked(r)));
                    }
                }
                Inbound::Commands { seq, commands } => {
                    if let Some(last) = self.last_command_seq.filter(|l| seq <= *l) {
                        // Already processed: re-ack.
                        fx.push(Effect::Send(Outbound::Ack { up_to: last }));
                    } else if self.forwarded_command_seq.is_some_and(|f| seq <= f) {
                        // Still processing.
                    } else {
                        self.forwarded_command_seq = Some(seq);
                        fx.push(Effect::Notify(Notice::Commands { seq, commands }));
                    }
                }
                Inbound::Ack { up_to } => self.unacked.retain(|(s, _)| *s > up_to),
                Inbound::HostToken { token, expires_ms } => {
                    self.token = token.clone();
                    fx.push(Effect::Notify(Notice::HostToken { token, expires_ms }));
                }
                Inbound::Other(o) => fx.push(Effect::Notify(Notice::Other(o))),
                Inbound::Error { fatal, retryable, error } => {
                    // A retryable error means FleetDO failed to process something we sent (it did
                    // not ack it). Reconnect so everything unacked is resent in order; carrying on
                    // would let a later batch's cumulative ack cover the failed one.
                    let reconnect = fatal || retryable;
                    fx.push(Effect::Log(Log::PeerError { reconnect }));
                    fx.push(Effect::Notify(Notice::Error(error)));
                    if reconnect {
                        self.close(now, fx);
                    }
                }
            },
            Conn::Idle { .. } | Conn::Connecting => {}
        }
    }

    fn renew<C, R, O>(&mut self, now: Now, sent: (u64, u64), fx: &mut Effects<E, C, R, O>) {
        let fence = self.lease.host_fence_ms;
        let (deadline_mono, deadline_boot) = (sent.0 + fence, sent.1 + fence);
        let remaining = deadline_boot.saturating_sub(now.boot).min(deadline_mono.saturating_sub(now.mono));
        let valid_until_ms = now.wall + remaining as i64;
        fx.push(Effect::Notify(Notice::LeaseRenewed { deadline_mono, deadline_boot, valid_until_ms }));
    }

    fn flush<C, R, O>(&mut self, fx: &mut Effects<E, C, R, O>) {
        if self.pending.is_empty() {
            return;
        }
        let events = std::mem::take(&mut self.pending);
        let seq = self.next_seq;
        self.next_seq += 1;
        self.unacked.push_back((seq, events.clone()));
        fx.push(Effect::Send(Outbound::Events { seq, events }));
    }

    fn outbox_len(&self) -> usize {
        self.pending.len() + self.unacked.iter().map(|(_, v)| v.len()).sum::<usize>()
    }

    /// Queue an event: coalesce audit batches, and shed low-value events past the bound.
    fn push_event<C, R, O>(&mut self, e: E, fx: &mut Effects<E, C, R, O>) {
        if let Some(last) = self.pending.last_mut()
            && last.absorb(&e)
        {
            return;
        }
        self.pending.push(e);
        let total = self.outbox_len();
        if total > MAX_OUTBOX_EVENTS {
            let target = MAX_OUTBOX_EVENTS * 3 / 4;
            for rank in 0..=1u8 {
                let before = self.pending.len();
                let mut excess = total.saturating_sub(target);
                self.pending.retain(|e| {
                    if excess > 0 && e.shed_rank() == Some(rank) {
                        excess -= 1;
                        false
                    } else {
                        true
                    }
                });
                self.shed += (before - self.pending.len()) as u64;
                if self.outbox_len() <= target {
                    break;
                }
            }
            fx.push(Effect::Log(Log::OutboxShed { shed: self.shed }));
        }
    }
}
