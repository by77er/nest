//! The lease: nestd's REAL fleet core (heartbeats, hello, the renewal each ack makes) and REAL
//! watchdog decision (`nestd_core::lease::check`), against FleetDO's liveness rule (`fleet.ts`
//! `tick`: a host whose `last_rx` is `cp_expiry_ms` old is expired; `onHello`/`onHeartbeat` set
//! `last_rx` on receipt and answer), with abstract time.
//!
//! Time moves in steps of one unit (1 s). Frames take any number of steps to arrive (in order) or
//! are lost with the connection. A host suspend stops the monotonic clock while real time and
//! `CLOCK_BOOTTIME` run on. The watchdog looks at every step (in nestd it looks at least every
//! 250 ms, far inside the 10 s margin between `host_fence_ms` and `cp_expiry_ms`).
//!
//! Property: when FleetDO may consider the host expired, nestd's own lease has already run out, so
//! it has fenced itself before anything it ran can be placed elsewhere.

use std::collections::VecDeque;

use nestd_core::fleet::{Effect, EventKind, FleetLink, Inbound, Input, Lease, Notice, Now, Outbound, OutboxEvent};
use nestd_core::lease::{LeaseCheck, check};
use stateright::{Model, Property};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NoEvent;

impl OutboxEvent for NoEvent {
    fn kind(&self) -> EventKind {
        EventKind::Other
    }
    fn merge(&mut self, _: Self) {}
}

/// `DEFAULT_LEASE_TIMING` (control-plane/src/protocol/control.ts).
const LEASE: Lease = Lease { heartbeat_ms: 5_000, host_fence_ms: 20_000, cp_expiry_ms: 30_000 };

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    /// One step of time, in ms: a coarser step explores longer runs.
    pub unit_ms: u64,
    /// Real time explored, in steps.
    pub horizon: u64,
    pub max_drops: u8,
    pub max_suspends: u8,
    /// How long a suspend lasts, in steps.
    pub suspend_steps: u64,
    /// Frames in flight per direction at most (bounds the delay interleavings).
    pub max_in_flight: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Up {
    Hello,
    Heartbeat(i64),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Down {
    HelloAck,
    HeartbeatAck(i64),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    /// One step of time, in ms (from the config).
    pub unit: u64,
    /// Real time (FleetDO's clock, nestd's boottime and wall clock), in steps.
    pub now: u64,
    /// nestd's monotonic clock, in steps (stops during a suspend).
    pub mono: u64,
    pub link: FleetLink<NoEvent>,
    pub connecting: bool,
    pub up: Option<VecDeque<Up>>,
    pub down: VecDeque<Down>,
    /// The deadline from the last `LeaseRenewed`, in ms on (mono, boot).
    pub deadline: Option<(u64, u64)>,
    /// FleetDO's `hosts.last_rx`, in steps.
    pub last_rx: Option<u64>,
    pub drops: u8,
    pub suspends: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// One step of time passes; or (`suspended`) a suspend of `suspend_steps`, during which the
    /// monotonic clock doesn't move.
    Time { suspended: bool },
    NestdTick,
    ConnectOk,
    FleetRecv,
    NestdRecv,
    Drop,
}

pub struct LeaseModel {
    pub cfg: Config,
}

impl State {
    fn clock(&self) -> Now {
        Now { mono: self.mono * self.unit, boot: self.now * self.unit, wall: (self.now * self.unit) as i64 }
    }

    /// The watchdog's view right now (`host.rs` `lease_watchdog`).
    pub fn leased(&self) -> bool {
        let c = self.clock();
        self.deadline.is_some_and(|(m, b)| matches!(check(m.saturating_sub(c.mono), b.saturating_sub(c.boot)), LeaseCheck::Valid { .. }))
    }

    pub fn fleet_expired(&self) -> bool {
        self.last_rx.is_some_and(|r| (self.now - r) * self.unit >= LEASE.cp_expiry_ms)
    }

    fn run(&mut self, input: Input<NoEvent, (), (), ()>) {
        let mut queue = VecDeque::from([input]);
        while let Some(i) = queue.pop_front() {
            for e in self.link.step(self.clock(), i) {
                match e {
                    Effect::Connect { .. } => self.connecting = true,
                    Effect::Send(f) => {
                        let up = match &f {
                            Outbound::Hello { .. } => Some(Up::Hello),
                            Outbound::Heartbeat { sent_ms } => Some(Up::Heartbeat(*sent_ms)),
                            _ => None,
                        };
                        match (&mut self.up, up) {
                            (Some(q), Some(u)) => q.push_back(u),
                            (Some(_), None) => {}
                            (None, _) => queue.push_back(Input::SendFailed(f)),
                        }
                    }
                    Effect::Close => {
                        self.up = None;
                        self.down.clear();
                    }
                    Effect::Notify(Notice::LeaseRenewed { deadline_mono, deadline_boot, .. }) => self.deadline = Some((deadline_mono, deadline_boot)),
                    Effect::Notify(_) | Effect::Log(_) => {}
                }
            }
        }
    }
}

impl Model for LeaseModel {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        let link = FleetLink::new(nestd_core::fleet::Config { protocol_version: 1, flush_interval_ms: 1_000_000 }, String::new());
        vec![State { unit: self.cfg.unit_ms, now: 0, mono: 0, link, connecting: false, up: None, down: VecDeque::new(), deadline: None, last_rx: None, drops: 0, suspends: 0 }]
    }

    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        let c = &self.cfg;
        let due = s.link.wake_at().is_some_and(|w| w <= s.mono * s.unit);
        if due {
            // Timers fire before time moves on (the shell sleeps until exactly then).
            a.push(Action::NestdTick);
        }
        if s.now < c.horizon && !due {
            a.push(Action::Time { suspended: false });
            if s.suspends < c.max_suspends {
                a.push(Action::Time { suspended: true });
            }
        }
        if s.connecting {
            a.push(Action::ConnectOk);
        }
        if s.up.as_ref().is_some_and(|q| !q.is_empty()) {
            a.push(Action::FleetRecv);
        }
        if !s.down.is_empty() {
            a.push(Action::NestdRecv);
        }
        if s.up.is_some() && s.drops < c.max_drops {
            a.push(Action::Drop);
        }
    }

    fn next_state(&self, last: &State, action: Action) -> Option<State> {
        let mut s = last.clone();
        match action {
            Action::Time { suspended } => {
                if suspended {
                    s.suspends += 1;
                    s.now = (s.now + self.cfg.suspend_steps).min(self.cfg.horizon);
                } else {
                    s.now += 1;
                    s.mono += 1;
                }
            }
            Action::NestdTick => s.run(Input::Tick),
            Action::ConnectOk => {
                s.connecting = false;
                s.up = Some(VecDeque::new());
                s.down.clear();
                s.run(Input::Connected);
            }
            // fleet.ts onHello / onHeartbeat: last_rx := now, then answer.
            Action::FleetRecv => {
                let f = s.up.as_mut()?.pop_front()?;
                s.last_rx = Some(s.now);
                s.down.push_back(match f {
                    Up::Hello => Down::HelloAck,
                    Up::Heartbeat(ms) => Down::HeartbeatAck(ms),
                });
            }
            Action::NestdRecv => {
                let f = s.down.pop_front()?;
                let frame = match f {
                    Down::HelloAck => Inbound::HelloAck { protocol_version: 1, last_event_seq: None, next_command_seq: None, lease: LEASE },
                    Down::HeartbeatAck(sent_ms) => Inbound::HeartbeatAck { sent_ms, revoked: None },
                };
                s.run(Input::Frame(frame));
            }
            Action::Drop => {
                s.drops += 1;
                s.up = None;
                s.down.clear();
                s.run(Input::Closed);
            }
        }
        let c = &self.cfg;
        if s.up.as_ref().is_some_and(|q| q.len() > c.max_in_flight) || s.down.len() > c.max_in_flight {
            return None;
        }
        Some(s)
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always("lease_never_outlives_fleetdo", |_, s: &State| !(s.fleet_expired() && s.leased())),
            Property::sometimes("renewed_after_a_suspend", |_, s: &State| s.suspends > 0 && s.leased()),
            Property::sometimes("expired_and_fenced", |_, s: &State| s.fleet_expired() && s.deadline.is_some() && !s.leased()),
        ]
    }
}
