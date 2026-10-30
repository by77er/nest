//! The fleet link: nestd's REAL core (`nestd_core::fleet::FleetLink`, the result cache and the
//! executor's dedup) composed with a model of FleetDO as nestd sees it.
//!
//! The FleetDO side follows `control-plane/src/do/fleet.ts` (`webSocketMessage`, `onHello`,
//! `onEvents`, `issueCommands`, `sendResolved`, `failPendingCommands`, `onCommandResult`) and
//! `control-plane/src/lib/reliable.ts`: durable SQLite (`rel_out`, `rel_state`, `commands`,
//! `hosts.nestd_instance`, the `kv` orphan capture) survives a FleetDO restart; the per-host
//! `SerialQueue`, in-flight `sendResolved` awaits and sockets don't. Every `await` in a handler is a
//! point where other actions interleave. The nestd side is the shipped core, stepped exactly as the
//! shell steps it (every effect performed in order, failures fed back), plus the executor: FIFO,
//! one batch at a time, dedup by `cmd` through `nestd_core::results::ResultCache`.
//!
//! With the fixes on (`Config::fixed`), FleetDO sends every batch through one per-host chain
//! (`flush`): a run takes `socketFor(host)` (the first helloed socket), sends everything above that
//! socket's `sent` in seq order with secrets resolved for the whole run first, and advances `sent`;
//! the hello acks `last_command_seq`, sets `sent` to it, sends `hello_ack` and enqueues a run in one
//! synchronous step. `Config::main` is FleetDO as on main: each send on its own.
//!
//! Abstractions, each a part of fleet.ts this model leaves out because nothing in it can change
//! what nestd's command and event channels do (see docs/verification/nestd/):
//! - one command per batch, so a seq names a command (seqs survive `rel.reset`); its payload is its
//!   index; every command is the same kind, so sendResolved's filter of answered `agent_start`s
//!   (#30) never applies (a batch it empties is still sent, with its seq);
//! - results travel up as `events` through the real outbox, and FleetDO's event handler never
//!   fails (the study's B4, a batch failing partway, is out of scope);
//! - heartbeats run once per connection and FleetDO's answer is left out (it only renews the lease:
//!   `lease.rs`); time advances only for reconnect backoff;
//! - no wedged hosts (the 4408 close a wedged host's hello gets), no CA renewals and their errors,
//!   no malformed frames (`invalid_message`): all are closes, which a drop already covers;
//! - no sandboxes: `dropUnreported` and its lease writes, the `sandbox_create` reconciliation in
//!   `failPendingCommands`, and `answered_by`/`killProgress` (which read results, never send) are
//!   outside; FleetDO's own answers are modelled as `Res::Synthetic`;
//! - `onCommandResult` throwing midway through `failPendingCommands`: the job ends and the `kv`
//!   capture stays for the next hello, which a FleetDO restart already models.

use std::collections::{BTreeSet, VecDeque};

use nestd_core::fleet::{Effect, FleetLink, Inbound, Input, Lease, Log, Notice, Now, Outbound, OutboxEvent, Phase};
use nestd_core::results::ResultCache;
use stateright::{Model, Property};

/// A `command_result` for the command with this index.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Ev(pub u8);

impl OutboxEvent for Ev {
    fn shed_rank(&self) -> Option<u8> {
        None
    }
    fn absorb(&mut self, _: &Self) -> bool {
        false
    }
}

/// Which FleetDO is modelled, and the bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    /// `onHello` captures the old lineage's unanswered commands in the same step as `rel.reset`
    /// (main: after the awaits).
    pub capture_at_reset: bool,
    /// ... and keeps the capture in `kv` until failed, so a restart midway leaves it to the next hello.
    pub durable_capture: bool,
    /// `hello_ack` carries `next_command_seq`.
    pub send_baseline: bool,
    /// A BrokerDO failure in `sendResolved` closes the socket (main: returns quietly).
    pub close_on_broker_fail: bool,
    /// A hello whose socket closed while it waited in the queue does nothing (main: it runs, and
    /// supersedes, so closes, the newer socket the host reconnected on).
    pub stale_hello_guard: bool,
    /// One per-host send chain for issueCommands and the hello's resend (main: each sends on its
    /// own, after its own BrokerDO await, so a later batch can overtake an earlier one).
    pub send_chain: bool,
    /// `onEvents` processes a batch only if its socket is still the host's helloed one (main: the
    /// attachment read at arrival, so a dead process's batch can become the new lineage's baseline).
    pub events_socket_guard: bool,
    pub max_cmds: u8,
    pub secrets: bool,
    pub max_drops: u8,
    pub max_restarts: u8,
    pub max_fleet_resets: u8,
    pub max_broker_fails: u8,
}

impl Config {
    /// FleetDO as on main (edf6829).
    pub fn main() -> Self {
        Config {
            capture_at_reset: false,
            durable_capture: false,
            send_baseline: false,
            close_on_broker_fail: false,
            stale_hello_guard: false,
            send_chain: false,
            events_socket_guard: false,
            max_cmds: 3,
            secrets: true,
            max_drops: 1,
            max_restarts: 1,
            max_fleet_resets: 1,
            max_broker_fails: 1,
        }
    }
    /// FleetDO with this branch's fixes.
    pub fn fixed() -> Self {
        Config { capture_at_reset: true, durable_capture: true, send_baseline: true, close_on_broker_fail: true, stale_hello_guard: true, send_chain: true, events_socket_guard: true, ..Self::main() }
    }
    pub fn faults(self, drops: u8, restarts: u8, resets: u8, broker_fails: u8) -> Self {
        Config { max_drops: drops, max_restarts: restarts, max_fleet_resets: resets, max_broker_fails: broker_fails, ..self }
    }
}

/// FleetDO → nestd.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Down {
    HelloAck { last_event_seq: Option<u64>, next_command_seq: Option<u64> },
    Commands(u64),
    Ack(u64),
    HeartbeatAck(i64),
    /// A retryable `error` (FleetDO closes right after).
    Error,
    Close,
}

/// nestd → FleetDO.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Up {
    Hello { inst: u8, last: Option<u64> },
    Events { seq: u64, results: Vec<u8> },
    Ack(u64),
    Heartbeat(i64),
    CaRenew,
    Close,
}

/// One WebSocket: FIFO each way. `host_reading`: nestd still holds it; `fleet_open`: FleetDO does.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Wire {
    pub id: u8,
    pub down: VecDeque<Down>,
    pub up: VecDeque<Up>,
    pub host_reading: bool,
    pub fleet_open: bool,
    /// The socket attachment's `helloed`.
    pub helloed: bool,
    /// The send chain's high-water mark on this socket: the last seq it put on the wire.
    pub sent_up_to: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Res {
    Real,
    /// Failed by FleetDO at a new process's hello, at this instance.
    Synthetic(u8),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HelloStage {
    /// Queued; its synchronous start (`onHello` up to `hello_ack`) runs when it reaches the head.
    Start,
    /// Awaiting rotateToken / sendBindingKeys (772-774).
    Keys,
    /// The resend's `sendResolved` awaiting BrokerDO (778).
    Resolving(Vec<u64>),
    /// Awaiting reconcileSandboxes / dropUnreported before failing the old lineage (783-791).
    Reconcile,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Job {
    Hello { wire: u8, inst: u8, last: Option<u64>, stage: HelloStage, new_process: bool, captured: Option<Vec<u8>> },
    Events { wire: u8, seq: u64, results: Vec<u8> },
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Fleet {
    // Durable.
    pub next_out: u64,
    pub rel_out: BTreeSet<u64>,
    pub secret: BTreeSet<u64>,
    pub last_in: Option<u64>,
    pub nestd_instance: Option<u8>,
    pub results: Vec<Option<Res>>,
    pub orphans: Option<Vec<u8>>,
    // Volatile.
    pub queue: VecDeque<Job>,
    /// `issueCommands` → `sendResolved` awaiting BrokerDO: (wire, seqs). Without the send chain.
    pub resolving: Vec<(u8, Vec<u64>)>,
    /// The per-host send chain: runs queued, and the run awaiting BrokerDO (wire, seqs).
    pub chain_runs: u8,
    pub chain_resolving: Option<(u8, Vec<u64>)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Nestd {
    pub inst: u8,
    pub link: FleetLink<Ev>,
    pub t: u64,
    pub conn: Option<u8>,
    pub connecting: bool,
    pub exec: VecDeque<(u64, u8)>,
    pub done: ResultCache<()>,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    pub fleet: Fleet,
    pub nestd: Nestd,
    pub wires: Vec<Wire>,
    pub next_wire: u8,
    // Ghosts.
    /// Highest instance that ran (not replayed) each command.
    pub exec_by: Vec<Option<u8>>,
    pub exec_last: Option<u64>,
    pub lineage_base: u64,
    pub out_of_order: bool,
    pub ack_unexecuted: bool,
    pub closes: u8,
    /// Command gaps nestd met (each one closes the connection).
    pub gaps: u8,
    /// Seqs this process has finished (`CommandsDone`), and whether it forwarded one again.
    pub completed: BTreeSet<u64>,
    pub reforwarded: bool,
    pub drops: u8,
    pub restarts: u8,
    pub resets: u8,
    pub broker_fails: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// `issueCommands` from another DO, with or without a secret reference.
    Issue { secret: bool },
    /// FleetDO's `webSocketMessage` for the next frame on a wire.
    FleetRecv(u8),
    /// The head of the per-host queue runs to its next `await`.
    FleetJob,
    BrokerOk(usize),
    BrokerFail(usize),
    /// The send chain's next run starts (sends at once, or awaits BrokerDO for its secrets).
    ChainRun,
    ChainBrokerOk,
    ChainBrokerFail,
    /// Resume the hello at the head of the queue after its BrokerDO await.
    HelloBrokerOk,
    HelloBrokerFail,
    NestdRecv,
    NestdTick,
    NestdConnectOk,
    Exec,
    Drop,
    NestdRestart,
    FleetReset,
}

const LEASE: Lease = Lease { heartbeat_ms: 5_000, host_fence_ms: 20_000, cp_expiry_ms: 30_000 };

fn new_link() -> FleetLink<Ev> {
    FleetLink::new(nestd_core::fleet::Config { protocol_version: 1, flush_interval_ms: 1_000_000 }, String::new())
}

pub struct FleetModel {
    pub cfg: Config,
}

impl State {
    fn wire(&mut self, id: u8) -> Option<&mut Wire> {
        self.wires.iter_mut().find(|w| w.id == id)
    }

    /// FleetDO's `send` on a socket: lost if it's closed.
    fn send_down(&mut self, id: u8, f: Down) {
        if let Some(w) = self.wire(id).filter(|w| w.fleet_open) {
            w.down.push_back(f);
        }
    }

    /// FleetDO's `ws.close()`.
    fn fleet_close(&mut self, id: u8) {
        if let Some(w) = self.wire(id).filter(|w| w.fleet_open) {
            w.fleet_open = false;
            w.helloed = false;
            w.up.clear();
            w.down.push_back(Down::Close);
        }
    }

    /// The chain's send of `msgs` (in seq order) on socket `w`.
    fn chain_send(&mut self, w: u8, msgs: Vec<u64>) {
        for q in &msgs {
            self.send_down(w, Down::Commands(*q));
        }
        if let (Some(last), Some(x)) = (msgs.last(), self.wire(w)) {
            x.sent_up_to = x.sent_up_to.max(*last);
        }
    }

    /// `socketFor`: the first helloed socket of the host (`getWebSockets(host).find(helloed)`).
    fn socket_for(&self) -> Option<u8> {
        self.wires.iter().find(|w| w.fleet_open && w.helloed).map(|w| w.id)
    }

    /// `rel.ack`: a seq leaves the outbox; it must have run somewhere.
    fn rel_ack(&mut self, up_to: u64) {
        for s in self.fleet.rel_out.iter().copied().filter(|s| *s <= up_to).collect::<Vec<_>>() {
            if self.exec_by[(s - 1) as usize].is_none() {
                self.ack_unexecuted = true;
            }
            self.fleet.rel_out.remove(&s);
        }
    }

    fn on_command_result(&mut self, c: u8, r: Res) {
        let slot = &mut self.fleet.results[c as usize];
        if slot.is_none() {
            *slot = Some(r);
        }
    }

    fn unanswered(&self) -> Vec<u8> {
        (0..self.fleet.results.len() as u8).filter(|c| self.fleet.results[*c as usize].is_none()).collect()
    }

    fn gc_wires(&mut self) {
        self.wires.retain(|w| w.host_reading || w.fleet_open);
    }
}

impl FleetModel {
    /// Step nestd's core with `input` and perform its effects as the shell does, feeding failures
    /// back, until nothing is left.
    fn run_nestd(&self, s: &mut State, input: Input<Ev, u8, (), ()>) {
        let mut queue = VecDeque::from([input]);
        while let Some(i) = queue.pop_front() {
            let now = Now { mono: s.nestd.t, boot: s.nestd.t, wall: s.nestd.t as i64 };
            for e in s.nestd.link.step(now, i) {
                match e {
                    Effect::Connect { .. } => s.nestd.connecting = true,
                    Effect::Send(frame) => {
                        let up = match &frame {
                            Outbound::Hello { last_command_seq } => Up::Hello { inst: s.nestd.inst, last: *last_command_seq },
                            Outbound::Events { seq, events } => Up::Events { seq: *seq, results: events.iter().map(|e| e.0).collect() },
                            Outbound::Ack { up_to } => Up::Ack(*up_to),
                            Outbound::Heartbeat { sent_ms } => Up::Heartbeat(*sent_ms),
                            Outbound::CaRenew { .. } => Up::CaRenew,
                        };
                        match s.nestd.conn.and_then(|id| s.wire(id)) {
                            Some(w) => {
                                // FleetDO's answer to a heartbeat only renews the lease, outside
                                // this model: leaving the frame out removes its interleavings.
                                if w.fleet_open && !matches!(up, Up::Heartbeat(_)) {
                                    w.up.push_back(up);
                                }
                            }
                            None => queue.push_back(Input::SendFailed(frame)),
                        }
                    }
                    Effect::Close => {
                        s.closes += 1;
                        if let Some(w) = s.nestd.conn.take().and_then(|id| s.wire(id)) {
                            w.host_reading = false;
                            w.down.clear();
                            if w.fleet_open {
                                w.up.push_back(Up::Close);
                            }
                        }
                    }
                    Effect::Notify(Notice::Commands { seq, commands }) => {
                        if s.completed.contains(&seq) {
                            s.reforwarded = true;
                        }
                        s.nestd.exec.push_back((seq, commands));
                    }
                    Effect::Log(Log::CommandGap { .. }) => s.gaps += 1,
                    Effect::Notify(_) | Effect::Log(_) => {}
                }
            }
        }
        s.gc_wires();
    }

    /// `onHello`'s synchronous start, up to `hello_ack` (and the capture at the reset when fixed).
    fn hello_start(&self, s: &mut State) {
        let c = &self.cfg;
        let Some(Job::Hello { wire, inst, last, .. }) = s.fleet.queue.front().cloned() else { return };
        if c.stale_hello_guard && !s.wires.iter().any(|w| w.id == wire && w.fleet_open) {
            // Its socket closed while the hello waited in the queue: nothing to do.
            s.fleet.queue.pop_front();
            return;
        }
        // Every other socket is superseded (744-749), a newer one included. A newer one nestd
        // still uses counts as a close, so a supersede loop shows as `reconnects_bounded`.
        for id in s.wires.iter().map(|w| w.id).filter(|id| *id != wire).collect::<Vec<_>>() {
            if s.wires.iter().any(|w| w.id == id && w.fleet_open && w.host_reading) {
                s.closes += 1;
            }
            s.fleet_close(id);
        }
        let np = s.fleet.nestd_instance.is_some_and(|i| i != inst);
        let mut captured = None;
        if np {
            // rel.reset (reliable.ts:68-72): outbox gone, inbound baseline forgotten, seqs keep growing.
            s.fleet.rel_out.clear();
            s.fleet.last_in = None;
            s.lineage_base = s.fleet.next_out;
            if c.capture_at_reset {
                let unanswered = s.unanswered();
                if c.durable_capture {
                    s.fleet.orphans = Some(unanswered);
                } else {
                    captured = Some(unanswered);
                }
            }
        }
        if let Some(Job::Hello { new_process, captured: cap, stage, .. }) = s.fleet.queue.front_mut() {
            *new_process = np;
            *cap = captured;
            *stage = HelloStage::Keys;
        }
        s.fleet.nestd_instance = Some(inst);
        if c.send_chain
            && let Some(l) = last
        {
            // With the chain, the hello acks what the host processed in this same step.
            s.rel_ack(l);
        }
        if let Some(w) = s.wire(wire).filter(|w| w.fleet_open) {
            w.helloed = true;
            // The chain sends this socket everything above what the host has processed.
            w.sent_up_to = last.unwrap_or(0);
        }
        let next_command_seq = c.send_baseline.then(|| s.fleet.rel_out.iter().copied().find(|q| *q > last.unwrap_or(0)).unwrap_or(s.fleet.next_out));
        s.send_down(wire, Down::HelloAck { last_event_seq: s.fleet.last_in, next_command_seq });
        if c.send_chain {
            // The resend joins the chain in the step that sets `helloed`: whatever is issued later
            // queues behind it.
            s.fleet.chain_runs += 1;
        }
    }

    /// After a hello's resend: fail the old lineage (new process), then the job ends. A hello with
    /// nothing to fail ends here: its remaining awaits change nothing this model sees.
    fn hello_after_resend(&self, s: &mut State) {
        let orphans = s.fleet.orphans.is_some();
        match s.fleet.queue.front_mut() {
            Some(Job::Hello { new_process: false, .. }) if !(self.cfg.durable_capture && orphans) => {
                s.fleet.queue.pop_front();
            }
            Some(Job::Hello { stage, .. }) => *stage = HelloStage::Reconcile,
            _ => {}
        }
    }

    fn broker_failed(&self, s: &mut State, wire: u8) {
        s.broker_fails += 1;
        if self.cfg.close_on_broker_fail && s.wire(wire).is_some_and(|w| w.fleet_open) {
            s.closes += 1;
            s.send_down(wire, Down::Error);
            s.fleet_close(wire);
        }
    }

    /// Closes the faults so far can explain: 3 each (a BrokerDO failure closes both ends; a
    /// restart's hello supersedes). With no fault, none.
    fn close_allowance(&self, s: &State) -> u8 {
        3 * (s.drops + s.restarts + s.resets + s.broker_fails)
    }

    fn issued(s: &State) -> u8 {
        s.fleet.results.len() as u8
    }
}

impl Model for FleetModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        vec![State {
            fleet: Fleet {
                next_out: 1,
                rel_out: BTreeSet::new(),
                secret: BTreeSet::new(),
                last_in: None,
                nestd_instance: None,
                results: vec![],
                orphans: None,
                queue: VecDeque::new(),
                resolving: vec![],
                chain_runs: 0,
                chain_resolving: None,
            },
            nestd: Nestd { inst: 0, link: new_link(), t: 0, conn: None, connecting: false, exec: VecDeque::new(), done: ResultCache::default() },
            wires: vec![],
            next_wire: 0,
            exec_by: vec![],
            exec_last: None,
            lineage_base: 1,
            out_of_order: false,
            ack_unexecuted: false,
            closes: 0,
            gaps: 0,
            completed: BTreeSet::new(),
            reforwarded: false,
            drops: 0,
            restarts: 0,
            resets: 0,
            broker_fails: 0,
        }]
    }

    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        let c = &self.cfg;
        if Self::issued(s) < c.max_cmds {
            a.push(Action::Issue { secret: false });
            if c.secrets {
                a.push(Action::Issue { secret: true });
            }
        }
        for w in &s.wires {
            if w.fleet_open && !w.up.is_empty() {
                a.push(Action::FleetRecv(w.id));
            }
        }
        if s.fleet.chain_resolving.is_some() {
            a.push(Action::ChainBrokerOk);
            if s.broker_fails < c.max_broker_fails {
                a.push(Action::ChainBrokerFail);
            }
        } else if s.fleet.chain_runs > 0 {
            a.push(Action::ChainRun);
        }
        let can_fail = s.broker_fails < c.max_broker_fails;
        match s.fleet.queue.front() {
            Some(Job::Hello { stage: HelloStage::Resolving(_), .. }) => {
                a.push(Action::HelloBrokerOk);
                if can_fail {
                    a.push(Action::HelloBrokerFail);
                }
            }
            Some(_) => a.push(Action::FleetJob),
            None => {}
        }
        for i in 0..s.fleet.resolving.len() {
            a.push(Action::BrokerOk(i));
            if can_fail {
                a.push(Action::BrokerFail(i));
            }
        }
        if s.nestd.conn.and_then(|id| s.wires.iter().find(|w| w.id == id)).is_some_and(|w| !w.down.is_empty()) {
            a.push(Action::NestdRecv);
        }
        if s.nestd.connecting {
            a.push(Action::NestdConnectOk);
        }
        // Time moves only to a reconnect (an open link's next timer is far off; see the module docs).
        if s.nestd.link.phase() == Phase::Idle && s.nestd.link.wake_at().is_some() {
            a.push(Action::NestdTick);
        }
        if !s.nestd.exec.is_empty() {
            a.push(Action::Exec);
        }
        if s.drops < c.max_drops && s.nestd.conn.is_some() {
            a.push(Action::Drop);
        }
        if s.restarts < c.max_restarts {
            a.push(Action::NestdRestart);
        }
        if s.resets < c.max_fleet_resets {
            a.push(Action::FleetReset);
        }
    }

    fn next_state(&self, last: &State, action: Action) -> Option<State> {
        let c = &self.cfg;
        let mut s = last.clone();
        match action {
            // fleet.ts issueCommands: row, rel.push, then sendResolved on a helloed socket.
            Action::Issue { secret } => {
                let seq = s.fleet.next_out;
                s.fleet.next_out += 1;
                s.fleet.results.push(None);
                s.exec_by.push(None);
                s.fleet.rel_out.insert(seq);
                if secret {
                    s.fleet.secret.insert(seq);
                }
                if c.send_chain {
                    // Rows and seq now; the send joins the host's chain.
                    s.fleet.chain_runs += 1;
                } else if let Some(w) = s.socket_for() {
                    if secret {
                        s.fleet.resolving.push((w, vec![seq]));
                    } else {
                        s.send_down(w, Down::Commands(seq));
                    }
                }
            }
            // One run of the send chain: everything not yet sent on the current socket, in order,
            // secrets resolved for the whole run before any of it goes out.
            Action::ChainRun => {
                s.fleet.chain_runs -= 1;
                if let Some(w) = s.socket_for() {
                    let from = s.wires.iter().find(|x| x.id == w).map_or(0, |x| x.sent_up_to);
                    let msgs: Vec<u64> = s.fleet.rel_out.iter().copied().filter(|q| *q > from).collect();
                    if msgs.iter().any(|q| s.fleet.secret.contains(q)) {
                        s.fleet.chain_resolving = Some((w, msgs));
                    } else {
                        s.chain_send(w, msgs);
                    }
                }
            }
            Action::ChainBrokerOk => {
                let (w, msgs) = s.fleet.chain_resolving.take()?;
                s.chain_send(w, msgs);
            }
            Action::ChainBrokerFail => {
                let (w, _) = s.fleet.chain_resolving.take()?;
                self.broker_failed(&mut s, w);
            }
            Action::FleetRecv(id) => {
                let w = s.wire(id)?;
                let f = w.up.pop_front()?;
                let helloed = w.helloed;
                match f {
                    Up::Close => {
                        let w = s.wire(id)?;
                        w.fleet_open = false;
                        w.helloed = false;
                    }
                    Up::Hello { inst, last } => {
                        s.fleet.queue.push_back(Job::Hello { wire: id, inst, last, stage: HelloStage::Start, new_process: false, captured: None })
                    }
                    _ if !helloed => {
                        // `webSocketMessage`: "first frame must be hello".
                        s.send_down(id, Down::Error);
                        s.fleet_close(id);
                    }
                    Up::Events { seq, results } => s.fleet.queue.push_back(Job::Events { wire: id, seq, results }),
                    Up::Ack(u) => s.rel_ack(u),
                    // Heartbeat answers only renew the lease (outside this model).
                    Up::Heartbeat(_) => {}
                    Up::CaRenew => {}
                }
            }
            Action::FleetJob => match s.fleet.queue.front().cloned()? {
                Job::Hello { stage: HelloStage::Start, .. } => self.hello_start(&mut s),
                // `onHello` after its awaits: ack what the host processed, resend the rest (main).
                Job::Hello { wire, last, stage: HelloStage::Keys, .. } => {
                    if let Some(l) = last.filter(|_| !c.send_chain) {
                        s.rel_ack(l);
                    }
                    let pending: Vec<u64> = s.fleet.rel_out.iter().copied().filter(|q| *q > last.unwrap_or(0)).collect();
                    if c.send_chain {
                        // The resend was queued on the chain at the hello's start.
                        self.hello_after_resend(&mut s);
                    } else if pending.iter().any(|q| s.fleet.secret.contains(q)) {
                        if let Some(Job::Hello { stage, .. }) = s.fleet.queue.front_mut() {
                            *stage = HelloStage::Resolving(pending);
                        }
                    } else {
                        for q in pending {
                            s.send_down(wire, Down::Commands(q));
                        }
                        self.hello_after_resend(&mut s);
                    }
                }
                // `onHello`'s end: `failPendingCommands` for what the old process never answered.
                Job::Hello { inst, new_process, captured, stage: HelloStage::Reconcile, .. } => {
                    let fail = if c.durable_capture {
                        s.fleet.orphans.take()
                    } else if c.capture_at_reset {
                        captured
                    } else {
                        new_process.then(|| s.unanswered())
                    };
                    for cmd in fail.unwrap_or_default() {
                        s.on_command_result(cmd, Res::Synthetic(inst));
                    }
                    s.fleet.queue.pop_front();
                }
                Job::Hello { stage: HelloStage::Resolving(_), .. } => return None,
                // `onEvents`.
                Job::Events { wire, seq, results } => {
                    s.fleet.queue.pop_front();
                    if c.events_socket_guard && !s.wires.iter().any(|w| w.id == wire && w.fleet_open && w.helloed) {
                        // A superseded socket's batch: its lineage is over; neither processed nor acked.
                        return Some(s);
                    }
                    match s.fleet.last_in {
                        Some(l) if seq <= l => s.send_down(wire, Down::Ack(l)),
                        Some(l) if seq != l + 1 => {
                            s.closes += 1;
                            s.send_down(wire, Down::Error);
                            s.fleet_close(wire);
                        }
                        _ => {
                            for r in results {
                                s.on_command_result(r, Res::Real);
                            }
                            s.fleet.last_in = Some(seq);
                            s.send_down(wire, Down::Ack(seq));
                        }
                    }
                }
            },
            Action::HelloBrokerOk | Action::HelloBrokerFail => {
                let Some(Job::Hello { wire, stage: HelloStage::Resolving(msgs), .. }) = s.fleet.queue.front().cloned() else { return None };
                if action == Action::HelloBrokerOk {
                    for q in msgs {
                        s.send_down(wire, Down::Commands(q));
                    }
                } else {
                    self.broker_failed(&mut s, wire);
                }
                self.hello_after_resend(&mut s);
            }
            Action::BrokerOk(i) => {
                let (wire, seqs) = s.fleet.resolving.remove(i);
                for q in seqs {
                    s.send_down(wire, Down::Commands(q));
                }
            }
            Action::BrokerFail(i) => {
                let (wire, _) = s.fleet.resolving.remove(i);
                self.broker_failed(&mut s, wire);
            }
            Action::NestdRecv => {
                let id = s.nestd.conn?;
                let f = s.wire(id)?.down.pop_front()?;
                let input = match f {
                    Down::HelloAck { last_event_seq, next_command_seq } => {
                        Input::Frame(Inbound::HelloAck { protocol_version: 1, last_event_seq, next_command_seq, lease: LEASE })
                    }
                    Down::Commands(q) => Input::Frame(Inbound::Commands { seq: q, commands: (q - 1) as u8 }),
                    Down::Ack(u) => Input::Frame(Inbound::Ack { up_to: u }),
                    Down::HeartbeatAck(ms) => Input::Frame(Inbound::HeartbeatAck { sent_ms: ms, revoked: None }),
                    Down::Error => Input::Frame(Inbound::Error { fatal: false, retryable: true, error: () }),
                    Down::Close => {
                        let w = s.wire(id)?;
                        w.host_reading = false;
                        s.nestd.conn = None;
                        Input::Closed
                    }
                };
                self.run_nestd(&mut s, input);
                // A fresh connection's timers fire at once (the heartbeat, a flush): folded into the
                // step that opened it.
                if s.nestd.link.is_open() && s.nestd.link.wake_at().is_some_and(|w| w <= s.nestd.t) {
                    self.run_nestd(&mut s, Input::Tick);
                }
            }
            Action::NestdTick => {
                if s.nestd.link.phase() == Phase::Idle {
                    s.nestd.t = s.nestd.t.max(s.nestd.link.wake_at()?);
                }
                self.run_nestd(&mut s, Input::Tick);
            }
            Action::NestdConnectOk => {
                let id = s.next_wire;
                s.next_wire += 1;
                s.wires.push(Wire { id, down: VecDeque::new(), up: VecDeque::new(), host_reading: true, fleet_open: true, helloed: false, sent_up_to: 0 });
                s.nestd.conn = Some(id);
                s.nestd.connecting = false;
                self.run_nestd(&mut s, Input::Connected);
            }
            // host.rs: the executor runs each command (dedup by cmd), then CommandsDone.
            Action::Exec => {
                let (seq, cmd) = s.nestd.exec.pop_front()?;
                let key = cmd.to_string();
                if s.nestd.done.get(&key).is_none() {
                    let expected = s.exec_last.map_or(s.lineage_base, |l| l + 1);
                    if seq != expected {
                        s.out_of_order = true;
                    }
                    s.exec_last = Some(seq);
                    let by = &mut s.exec_by[cmd as usize];
                    *by = Some(by.map_or(s.nestd.inst, |b| b.max(s.nestd.inst)));
                    s.nestd.done.insert(&key, ());
                }
                self.run_nestd(&mut s, Input::Event(Ev(cmd)));
                s.completed.insert(seq);
                self.run_nestd(&mut s, Input::CommandsDone(seq));
            }
            Action::Drop => {
                s.drops += 1;
                let id = s.nestd.conn.take()?;
                let w = s.wire(id)?;
                w.down.clear();
                w.up.clear();
                w.host_reading = false;
                w.fleet_open = false;
                w.helloed = false;
                self.run_nestd(&mut s, Input::Closed);
            }
            // A new nestd process: new instance_id; the core, executor and dedup cache start empty.
            Action::NestdRestart => {
                s.restarts += 1;
                if let Some(w) = s.nestd.conn.and_then(|id| s.wire(id)) {
                    w.host_reading = false;
                    w.down.clear();
                    if w.fleet_open {
                        w.up.push_back(Up::Close);
                    }
                }
                s.nestd = Nestd { inst: s.nestd.inst + 1, link: new_link(), t: s.nestd.t, conn: None, connecting: false, exec: VecDeque::new(), done: ResultCache::default() };
                s.exec_last = None;
                s.completed.clear();
                s.gc_wires();
            }
            // FleetDO restarts (deploy, eviction): SQLite kept; the queue, awaits and sockets lost.
            Action::FleetReset => {
                s.resets += 1;
                s.fleet.queue.clear();
                s.fleet.resolving.clear();
                s.fleet.chain_runs = 0;
                s.fleet.chain_resolving = None;
                for id in s.wires.iter().map(|w| w.id).collect::<Vec<_>>() {
                    s.fleet_close(id);
                }
                s.gc_wires();
            }
        }
        Some(s)
    }

    /// Caps a close/reconnect loop; `reconnects_bounded` reports it before the cap is reached.
    fn within_boundary(&self, s: &State) -> bool {
        s.closes <= self.close_allowance(s) + 1
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always("no_ack_without_execution", |_, s: &State| !s.ack_unexecuted),
            Property::always("in_order_per_lineage", |_, s: &State| !s.out_of_order),
            Property::always("failed_never_executed", |_, s: &State| {
                s.fleet.results.iter().zip(&s.exec_by).all(|(r, by)| match (r, by) {
                    (Some(Res::Synthetic(at)), Some(by)) => by < at,
                    _ => true,
                })
            }),
            // A fault can cause a few closes (a BrokerDO failure closes both ends; a restart's hello
            // supersedes); a close/reconnect loop causes them with no fault at all.
            // FleetDO sends in seq order on a socket (the send chain), so nestd never meets a gap:
            // a gap close would mean a reconnect per overtaking batch.
            Property::always("never_a_gap", |_, s: &State| s.gaps == 0),
            // A batch this process finished is never handed to its executor again (its replay would
            // only come from a cache, but a `last_command_seq` that went backwards asks for it).
            Property::always("finished_never_reforwarded", |_, s: &State| !s.reforwarded),
            Property::always("reconnects_bounded", |m: &FleetModel, s: &State| s.closes <= m.close_allowance(s)),
            // Monotone once true (every command issued; results are never cleared), and faults are
            // bounded, so a terminal state has the link up with nothing left to do.
            Property::eventually("every_command_answered", |m: &FleetModel, s: &State| {
                Self::issued(s) == m.cfg.max_cmds && s.fleet.results.iter().all(Option::is_some)
            }),
            Property::sometimes("answered_after_a_restart", |m: &FleetModel, s: &State| {
                s.restarts > 0 && Self::issued(s) == m.cfg.max_cmds && s.fleet.results.iter().all(|r| *r == Some(Res::Real))
            }),
            Property::sometimes("answered_after_a_broker_failure", |m: &FleetModel, s: &State| {
                s.broker_fails > 0 && Self::issued(s) == m.cfg.max_cmds && s.fleet.results.iter().all(|r| *r == Some(Res::Real))
            }),
        ]
    }
}

pub const SAFETY: [&str; 6] = ["no_ack_without_execution", "in_order_per_lineage", "failed_never_executed", "never_a_gap", "finished_never_reforwarded", "reconnects_bounded"];
pub const LIVENESS: &str = "every_command_answered";

/// One line per step: the action and what it left.
pub fn describe(path: &[(State, Option<Action>)]) -> String {
    let mut out = String::new();
    for (i, w) in path.windows(2).enumerate() {
        let (a, s) = (w[0].1.as_ref().expect("action"), &w[1].0);
        let wires: Vec<String> = s
            .wires
            .iter()
            .map(|w| format!("#{}{}{} down={:?} up={:?}", w.id, if w.fleet_open { "" } else { "(fleet closed)" }, if w.helloed { "(helloed)" } else { "" }, w.down, w.up))
            .collect();
        out.push_str(&format!(
            "{:>3}. {:<26} fleet: out={:?} results={:?} inst={:?} queue={:?} resolving={:?} | nestd#{} {:?} last={:?} fwd={:?} exec={:?} | {}\n",
            i + 1,
            format!("{a:?}"),
            s.fleet.rel_out,
            s.fleet.results,
            s.fleet.nestd_instance,
            s.fleet.queue.iter().map(|j| match j {
                Job::Hello { stage, .. } => format!("hello@{stage:?}"),
                Job::Events { seq, .. } => format!("events{seq}"),
            }).collect::<Vec<_>>(),
            s.fleet.resolving,
            s.nestd.inst,
            s.nestd.link.phase(),
            s.nestd.link.last_command_seq(),
            s.nestd.link.forwarded_command_seq(),
            s.nestd.exec,
            wires.join("  ")
        ));
    }
    out
}
