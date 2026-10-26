//! Stateright model of FleetDO -> nestd command delivery over the fleet reliable channel.
//!
//! Abstracts `control-plane/src/do/fleet.ts` (issueCommands, sendResolved, onHello, ack),
//! `control-plane/src/lib/reliable.ts` (push, ack, pendingAfter, reset) and
//! `crates/nestd/src/fleet.rs` + `host.rs` (Commands handling, executor, CommandsDone, hello).
//! One command per batch, so a seq names a command. Seqs are global per host (they survive
//! `rel.reset`), so a bitmask over seqs 1..=7 is enough. See README.md for the mapping table.

use stateright::{Model, Property};

/// How nestd treats an inbound `commands{seq}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Receiver {
    /// fleet.rs:394-404 as coded: re-ack `<= last`, drop `<= forwarded`, else forward. No gap check.
    Main,
    /// Strict gap check, baseline = first batch after the hello (reliable.ts `classify` style).
    GapFirst,
    /// Strict gap check, baseline for a fresh lineage taken from `hello_ack` (lowest seq FleetDO will send).
    GapHelloBase,
}

/// Which code is modelled. `main()` is the code on main (edf6829); the flags are fixes or mutations.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Config {
    pub receiver: Receiver,
    /// Sender fix: one per-host FIFO send chain (issue sends and the hello resend), so wire order = seq order.
    pub send_chain: bool,
    /// Sender fix: a BrokerDO failure closes the socket (forcing hello + resend) instead of returning quietly.
    pub close_on_broker_fail: bool,
    /// Hello fix: on a new nestd process, fail the old lineage's unanswered commands in the same
    /// synchronous step as `rel.reset`, not after the awaits (fleet.ts:789-791).
    pub capture_at_reset: bool,
    /// Receiver fix: `CommandsDone` while offline keeps `last := max(last, seq)` like the online path
    /// (fleet.rs:190 sets `Some(seq)`, which a cached replay of an older batch moves backwards).
    pub offline_max: bool,
    /// Mutation of the receiver fix: on a gap, drop the batch silently instead of closing.
    pub mut_gap_silent: bool,
    /// Mutation of the sender fix: enqueue the hello resend after the awaits (helloed is set before them).
    pub mut_late_resend: bool,
    /// Bounds.
    pub max_cmds: u8,
    pub secrets: bool,
    pub max_drops: u8,
    pub max_restarts: u8,
    pub max_fleet_resets: u8,
    pub max_broker_fails: u8,
}

impl Config {
    /// (a) main as coded.
    pub fn main() -> Self {
        Config {
            receiver: Receiver::Main,
            send_chain: false,
            close_on_broker_fail: false,
            capture_at_reset: false,
            offline_max: false,
            mut_gap_silent: false,
            mut_late_resend: false,
            max_cmds: 3,
            secrets: true,
            max_drops: 1,
            max_restarts: 1,
            max_fleet_resets: 1,
            max_broker_fails: 1,
        }
    }
    /// (b) receiver fix: strict gap check that closes; baseline from hello_ack; monotone offline
    /// `last`; plus the two sender-side pieces the model shows are needed for liveness and
    /// exactly-one-result.
    pub fn receiver_fix() -> Self {
        Config {
            receiver: Receiver::GapHelloBase,
            offline_max: true,
            close_on_broker_fail: true,
            capture_at_reset: true,
            ..Self::main()
        }
    }
    /// (c) sender fix: per-host send chain; the receiver stays as coded.
    pub fn sender_fix() -> Self {
        Config { send_chain: true, close_on_broker_fail: true, capture_at_reset: true, ..Self::main() }
    }
    pub fn with_faults(self, drops: u8, restarts: u8, resets: u8, broker_fails: u8) -> Self {
        Config { max_drops: drops, max_restarts: restarts, max_fleet_resets: resets, max_broker_fails: broker_fails, ..self }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum F2H {
    HelloAck { base: u8 },
    Commands(u8),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum H2F {
    Hello { last: Option<u8>, inst: u8 },
    Ack(u8),
}

/// One open WebSocket: FIFO both ways; everything in flight is lost when it closes.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Link {
    pub f2h: Vec<F2H>,
    pub h2f: Vec<H2F>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HelloStep {
    /// Awaiting rotateToken / sendBindingKeys (fleet.ts:772-774).
    Keys,
    /// sendResolved(pendingAfter) awaiting BrokerDO (fleet.ts:778).
    Resolving(u8),
    /// Awaiting reconcileSandboxes etc. before the pending capture (fleet.ts:780-791).
    Reconcile,
}

/// An in-flight FleetDO async continuation (volatile: lost on a FleetDO reset).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Task {
    /// issueCommands -> sendResolved awaiting BrokerDO for these seqs (fleet.ts:711).
    Resolve { seqs: u8, alive: bool },
    /// onHello after `helloed := true` (fleet.ts:762). `alive`: its socket is still open.
    Hello { step: HelloStep, last: Option<u8>, alive: bool, capture: bool, resend: bool },
}

/// A job on the per-host send chain (sender fix only).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Job {
    Send(u8),
    Resend(Option<u8>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Phase {
    Down,
    AwaitAck,
    Up,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct State {
    // FleetDO, durable (SQLite: rel_state, rel_out, commands, hosts).
    pub next_out: u8,
    pub outbox: u8,
    pub secret: u8,
    pub failed: u8,
    pub nestd_instance: Option<u8>,
    // FleetDO, volatile.
    pub helloed: bool,
    pub tasks: Vec<Task>,
    pub chain: Vec<Job>,
    // The socket.
    pub link: Option<Link>,
    // nestd fleet task + executor (volatile; a restart wipes them).
    pub inst: u8,
    pub phase: Phase,
    pub last: Option<u8>,
    pub fwd: Option<u8>,
    pub base: Option<u8>,
    pub exec_q: Vec<u8>,
    // Ghosts.
    pub executed: u8,
    pub awaiting_fail: u8,
    pub lineage_base: u8,
    pub exec_last: Option<u8>,
    pub out_of_order: bool,
    pub closes: u8,
    pub drops: u8,
    pub restarts: u8,
    pub resets: u8,
    pub broker_fails: u8,
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Action {
    /// issueCommands with or without a secret ref (agent_start / secrets_update carry one).
    Issue { secret: bool },
    FleetRecv,
    NestdRecv,
    Exec,
    BrokerOk(usize),
    BrokerFail(usize),
    HelloResume(usize),
    HelloReconcile(usize),
    ChainOk,
    ChainFail,
    Connect,
    Drop,
    NestdRestart,
    FleetReset,
}

const fn bit(s: u8) -> u8 {
    1 << s
}
/// Seqs <= u.
fn le(u: u8) -> u8 {
    if u >= 7 { 0xFE } else { (bit(u + 1) - 1) & 0xFE }
}
fn gt(u: Option<u8>) -> u8 {
    0xFE & !le(u.unwrap_or(0))
}
fn seqs(mask: u8) -> impl Iterator<Item = u8> {
    (1..8u8).filter(move |s| mask & bit(*s) != 0)
}

pub struct Delivery {
    pub cfg: Config,
}

impl State {
    fn issued(&self) -> u8 {
        le(self.next_out - 1)
    }
    fn send(&mut self, m: F2H) {
        if let Some(l) = &mut self.link {
            l.f2h.push(m);
        }
    }
    fn send_up(&mut self, m: H2F) {
        if let Some(l) = &mut self.link {
            l.h2f.push(m);
        }
    }
    fn send_all(&mut self, mask: u8) {
        for s in seqs(mask) {
            self.send(F2H::Commands(s));
        }
    }
    /// A socket closes: in-flight frames are lost; continuations bound to it send into the void.
    fn close(&mut self) {
        self.link = None;
        self.helloed = false;
        self.phase = Phase::Down;
        for t in &mut self.tasks {
            match t {
                Task::Resolve { alive, .. } | Task::Hello { alive, .. } => *alive = false,
            }
        }
        self.chain.clear();
    }
    /// failPendingCommands over `commands WHERE result IS NULL` (results modelled as delivered on execution).
    fn capture(&mut self) {
        self.failed |= self.issued() & !self.executed & !self.failed;
        self.awaiting_fail = 0;
    }
    fn hello_in_progress(&self) -> bool {
        self.tasks.iter().any(|t| matches!(t, Task::Hello { .. }))
    }
}

impl Delivery {
    fn hello_next(&self, s: &mut State, i: usize) {
        let Task::Hello { capture, .. } = s.tasks[i] else { unreachable!() };
        if capture {
            if let Task::Hello { step, .. } = &mut s.tasks[i] {
                *step = HelloStep::Reconcile;
            }
        } else {
            s.tasks.remove(i);
        }
    }
    fn broker_failed(&self, s: &mut State, alive: bool) {
        s.broker_fails += 1;
        if self.cfg.close_on_broker_fail && alive {
            s.closes += 1;
            s.close();
        }
    }
    fn chain_msgs(&self, s: &mut State) -> u8 {
        match s.chain[0].clone() {
            Job::Send(q) => bit(q),
            Job::Resend(last) => {
                if let Some(l) = last {
                    s.outbox &= !le(l);
                }
                s.outbox & gt(last)
            }
        }
    }
}

impl Model for Delivery {
    type State = State;
    type Action = Action;

    fn init_states(&self) -> Vec<State> {
        vec![State {
            next_out: 1,
            outbox: 0,
            secret: 0,
            failed: 0,
            nestd_instance: None,
            helloed: false,
            tasks: vec![],
            chain: vec![],
            link: None,
            inst: 0,
            phase: Phase::Down,
            last: None,
            fwd: None,
            base: None,
            exec_q: vec![],
            executed: 0,
            awaiting_fail: 0,
            lineage_base: 1,
            exec_last: None,
            out_of_order: false,
            closes: 0,
            drops: 0,
            restarts: 0,
            resets: 0,
            broker_fails: 0,
        }]
    }

    fn actions(&self, s: &State, a: &mut Vec<Action>) {
        let c = &self.cfg;
        if s.next_out - 1 < c.max_cmds {
            a.push(Action::Issue { secret: false });
            if c.secrets {
                a.push(Action::Issue { secret: true });
            }
        }
        if let Some(l) = &s.link {
            match l.h2f.first() {
                Some(H2F::Hello { .. }) if s.hello_in_progress() => {} // per-host SerialQueue
                Some(_) => a.push(Action::FleetRecv),
                None => {}
            }
            if !l.f2h.is_empty() {
                a.push(Action::NestdRecv);
            }
        } else {
            a.push(Action::Connect);
        }
        if !s.exec_q.is_empty() {
            a.push(Action::Exec);
        }
        let can_fail = s.broker_fails < c.max_broker_fails;
        for (i, t) in s.tasks.iter().enumerate() {
            match t {
                Task::Resolve { .. } | Task::Hello { step: HelloStep::Resolving(_), .. } => {
                    a.push(Action::BrokerOk(i));
                    if can_fail {
                        a.push(Action::BrokerFail(i));
                    }
                }
                Task::Hello { step: HelloStep::Keys, .. } => a.push(Action::HelloResume(i)),
                Task::Hello { step: HelloStep::Reconcile, .. } => a.push(Action::HelloReconcile(i)),
            }
        }
        if !s.chain.is_empty() {
            a.push(Action::ChainOk);
            let mut probe = s.clone();
            let msgs = self.chain_msgs(&mut probe);
            if can_fail && msgs & s.secret != 0 {
                a.push(Action::ChainFail);
            }
        }
        if s.link.is_some() && s.drops < c.max_drops {
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
            // fleet.ts:1152-1172: insert commands rows, rel.push, then (if a helloed socket) sendResolved.
            Action::Issue { secret } => {
                let q = s.next_out;
                s.next_out += 1;
                s.outbox |= bit(q);
                if secret {
                    s.secret |= bit(q);
                }
                if s.helloed {
                    if c.send_chain {
                        s.chain.push(Job::Send(q));
                    } else if secret {
                        s.tasks.push(Task::Resolve { seqs: bit(q), alive: true });
                    } else {
                        s.send(F2H::Commands(q)); // no slots: no await, sends synchronously
                    }
                }
            }
            Action::FleetRecv => {
                let m = s.link.as_mut()?.h2f.remove(0);
                match m {
                    // fleet.ts:663-665: cumulative ack.
                    H2F::Ack(u) => s.outbox &= !le(u),
                    // fleet.ts:729-800.
                    H2F::Hello { last, inst } => {
                        let new_process = s.nestd_instance.is_some_and(|i| i != inst);
                        if new_process {
                            if c.capture_at_reset {
                                s.capture();
                            } else {
                                s.awaiting_fail |= s.outbox & !s.executed & !s.failed;
                            }
                            s.outbox = 0; // rel.reset (reliable.ts:68-72)
                            s.lineage_base = s.next_out;
                        }
                        s.nestd_instance = Some(inst);
                        s.helloed = true;
                        let base = seqs(s.outbox).next().unwrap_or(s.next_out);
                        s.send(F2H::HelloAck { base });
                        let chain_now = c.send_chain && !c.mut_late_resend;
                        if chain_now {
                            s.chain.push(Job::Resend(last));
                        }
                        s.tasks.push(Task::Hello {
                            step: HelloStep::Keys,
                            last,
                            alive: true,
                            capture: new_process && !c.capture_at_reset,
                            resend: !chain_now,
                        });
                    }
                }
            }
            Action::NestdRecv => {
                let m = s.link.as_mut()?.f2h.remove(0);
                match m {
                    // fleet.rs:297.
                    F2H::HelloAck { base } => {
                        s.phase = Phase::Up;
                        s.fwd = s.last;
                        s.base = Some(base);
                    }
                    // fleet.rs:394-404.
                    F2H::Commands(q) => {
                        if s.last.is_some_and(|l| q <= l) {
                            let l = s.last.unwrap();
                            s.send_up(H2F::Ack(l));
                        } else if s.fwd.is_some_and(|f| q <= f) {
                            // "still processing": dropped
                        } else {
                            let next = s.fwd.or(s.last).map(|x| x + 1);
                            let accept = match c.receiver {
                                Receiver::Main => true,
                                Receiver::GapFirst => next.is_none_or(|n| n == q),
                                Receiver::GapHelloBase => next.or(s.base) == Some(q),
                            };
                            if accept {
                                s.fwd = Some(q);
                                s.exec_q.push(q);
                            } else if !c.mut_gap_silent {
                                s.closes += 1;
                                s.close();
                            }
                        }
                    }
                }
            }
            // host.rs:553-561 executor; execute() dedups by cmd (host.rs:1330-1347).
            Action::Exec => {
                let q = s.exec_q.remove(0);
                if s.executed & bit(q) == 0 {
                    let expected = s.exec_last.map(|e| e + 1).unwrap_or(s.lineage_base);
                    if q != expected {
                        s.out_of_order = true;
                    }
                    s.executed |= bit(q);
                    s.exec_last = Some(q);
                }
                // CommandsDone: fleet.rs:337-342 online, :190 offline. During the handshake the real
                // task leaves it queued until after hello_ack, then handles it online; modelled as online.
                if s.phase != Phase::Down {
                    s.last = Some(s.last.map_or(q, |l| l.max(q)));
                    s.send_up(H2F::Ack(q));
                } else if c.offline_max {
                    s.last = Some(s.last.map_or(q, |l| l.max(q)));
                } else {
                    s.last = Some(q);
                }
            }
            Action::BrokerOk(i) => match s.tasks[i].clone() {
                Task::Resolve { seqs, alive } => {
                    if alive {
                        s.send_all(seqs);
                    }
                    s.tasks.remove(i);
                }
                Task::Hello { step: HelloStep::Resolving(p), alive, .. } => {
                    if alive {
                        s.send_all(p);
                    }
                    self.hello_next(&mut s, i);
                }
                _ => return None,
            },
            // fleet.ts:713-715: logs and returns; the batch "stays queued".
            Action::BrokerFail(i) => match s.tasks[i].clone() {
                Task::Resolve { alive, .. } => {
                    s.tasks.remove(i);
                    self.broker_failed(&mut s, alive);
                }
                Task::Hello { step: HelloStep::Resolving(_), alive, .. } => {
                    self.hello_next(&mut s, i);
                    self.broker_failed(&mut s, alive);
                }
                _ => return None,
            },
            // fleet.ts:776-778: ack(last_command_seq); sendResolved(pendingAfter(last_command_seq)).
            Action::HelloResume(i) => {
                let Task::Hello { last: hl, alive, resend, .. } = s.tasks[i].clone() else { return None };
                if resend {
                    if c.send_chain {
                        // mut_late_resend: the resend joins the chain only now.
                        if alive {
                            s.chain.push(Job::Resend(hl));
                        }
                    } else {
                        if let Some(l) = hl {
                            s.outbox &= !le(l);
                        }
                        let pending = s.outbox & gt(hl);
                        if pending & s.secret != 0 {
                            if let Task::Hello { step, .. } = &mut s.tasks[i] {
                                *step = HelloStep::Resolving(pending);
                            }
                            s.tasks.sort();
                            return Some(s);
                        }
                        if alive {
                            s.send_all(pending);
                        }
                    }
                }
                self.hello_next(&mut s, i);
            }
            // fleet.ts:789-791: pending captured after the awaits, then failed.
            Action::HelloReconcile(i) => {
                s.capture();
                s.tasks.remove(i);
            }
            Action::ChainOk => {
                let msgs = self.chain_msgs(&mut s);
                s.send_all(msgs);
                s.chain.remove(0);
            }
            Action::ChainFail => {
                let _ = self.chain_msgs(&mut s);
                s.chain.remove(0);
                self.broker_failed(&mut s, true);
            }
            Action::Connect => {
                s.link = Some(Link { f2h: vec![], h2f: vec![H2F::Hello { last: s.last, inst: s.inst }] });
                s.phase = Phase::AwaitAck;
            }
            Action::Drop => {
                s.drops += 1;
                s.close();
            }
            // New nestd process: new instance_id, volatile state gone (fleet.rs:93-96).
            Action::NestdRestart => {
                s.restarts += 1;
                s.inst += 1;
                s.last = None;
                s.fwd = None;
                s.base = None;
                s.exec_q.clear();
                s.exec_last = None;
                s.close();
            }
            // FleetDO restarts: SQLite kept; continuations and sockets gone.
            Action::FleetReset => {
                s.resets += 1;
                s.close();
                s.tasks.clear();
            }
        }
        s.tasks.sort();
        Some(s)
    }

    /// Caps a gap-close/reconnect loop; `gap_closes_bounded` reports it before the cap is hit.
    fn within_boundary(&self, s: &State) -> bool {
        s.closes <= 5
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::always("no_ack_without_execution", |_, s: &State| {
                let gone = s.issued() & !s.outbox;
                gone & !(s.executed | s.failed | s.awaiting_fail) == 0
            }),
            Property::always("in_order_per_lineage", |_, s: &State| !s.out_of_order),
            Property::always("failed_never_executed", |_, s: &State| s.failed & s.executed == 0),
            Property::always("gap_closes_bounded", |_, s: &State| s.closes <= 4),
            // Monotone once true (issued fixed at max, executed/failed only grow), so Stateright's
            // missing ebits in fingerprints cannot hide a violation; faults are bounded, so
            // every terminal state has the network up.
            Property::eventually("every_command_answered", |m: &Delivery, s: &State| {
                s.next_out - 1 == m.cfg.max_cmds && s.issued() & !(s.executed | s.failed) == 0
            }),
            Property::sometimes("recovers_after_broker_fail", |m: &Delivery, s: &State| {
                s.broker_fails > 0 && s.next_out - 1 == m.cfg.max_cmds && s.issued() & !s.executed == 0
            }),
            Property::sometimes("recovers_after_restart", |m: &Delivery, s: &State| {
                s.restarts > 0 && s.next_out - 1 == m.cfg.max_cmds && s.executed != 0 && s.issued() & !(s.executed | s.failed) == 0
            }),
        ]
    }
}

pub const SAFETY: [&str; 3] = ["no_ack_without_execution", "in_order_per_lineage", "failed_never_executed"];
pub const LIVENESS: &str = "every_command_answered";

/// Result of one BFS run.
pub struct Outcome {
    pub unique_states: usize,
    pub elapsed: std::time::Duration,
    /// Violated `always`/`eventually` properties.
    pub violations: Vec<&'static str>,
    /// `sometimes` properties found.
    pub examples: Vec<&'static str>,
}

impl Outcome {
    pub fn violated(&self, name: &str) -> bool {
        self.violations.contains(&name)
    }
    pub fn holds(&self) -> bool {
        self.violations.is_empty()
    }
}

/// Exhaustive single-threaded BFS of the whole reachable space (an `always` property that fails
/// keeps the run going, so the count is the full space unless every property has a discovery).
pub fn check(cfg: Config) -> Outcome {
    use stateright::Checker;
    let start = std::time::Instant::now();
    let checker = Delivery { cfg }.checker().spawn_bfs().join();
    let elapsed = start.elapsed();
    let model = Delivery { cfg };
    let mut violations = vec![];
    let mut examples = vec![];
    for p in model.properties() {
        if checker.discovery(p.name).is_some() {
            match p.expectation {
                stateright::Expectation::Sometimes => examples.push(p.name),
                _ => violations.push(p.name),
            }
        }
    }
    violations.sort();
    Outcome { unique_states: checker.unique_state_count(), elapsed, violations, examples }
}

/// Some counterexample for one property, stopping at the first block (1500 states) with a hit.
pub fn find(cfg: Config, name: &'static str) -> Option<Vec<(State, Option<Action>)>> {
    find_within(cfg, name, None)
}

fn find_within(cfg: Config, name: &'static str, depth: Option<usize>) -> Option<Vec<(State, Option<Action>)>> {
    use stateright::{Checker, HasDiscoveries};
    let mut b = Delivery { cfg }.checker().finish_when(HasDiscoveries::AnyOf([name].into_iter().collect()));
    if let Some(d) = depth {
        b = b.target_max_depth(d);
    }
    b.spawn_bfs().join().discovery(name).map(|p| p.into_vec())
}

/// A shortest counterexample for one property. Stateright overwrites a discovery each time another
/// violating state is visited, so a run reports the last one found, not the shortest; this binary
/// searches a depth bound below the length of the first one found.
pub fn counterexample(cfg: Config, name: &'static str) -> Option<Vec<(State, Option<Action>)>> {
    let mut best = find(cfg, name)?;
    let (mut lo, mut hi) = (1usize, best.len());
    while lo < hi {
        let mid = (lo + hi) / 2;
        match find_within(cfg, name, Some(mid + 1)) {
            Some(p) => {
                hi = p.len().min(mid);
                best = p;
            }
            None => lo = mid + 1,
        }
    }
    Some(best)
}

/// One line per step: the action, then the state it led to.
pub fn describe(path: &[(State, Option<Action>)]) -> String {
    let mut out = String::new();
    let mut prev: Option<&Action> = None;
    for (i, (s, next)) in path.iter().enumerate() {
        if i > 0 {
            let a = format!("{:?}", prev.expect("action"));
            out.push_str(&format!("  {i:>2}. {a:<22} {}\n", summary(s)));
        }
        prev = next.as_ref();
    }
    out
}

fn mask(m: u8) -> String {
    let v: Vec<String> = seqs(m).map(|s| s.to_string()).collect();
    format!("{{{}}}", v.join(","))
}

fn summary(s: &State) -> String {
    let wire = match &s.link {
        None => "down".to_string(),
        Some(l) => format!("f2h={:?} h2f={:?}", l.f2h, l.h2f),
    };
    format!(
        "outbox={} secret={} exec={} failed={} | nestd inst={} last={:?} fwd={:?} q={:?} | {} | tasks={:?} chain={:?}",
        mask(s.outbox),
        mask(s.secret),
        mask(s.executed),
        mask(s.failed),
        s.inst,
        s.last,
        s.fwd,
        s.exec_q,
        wire,
        s.tasks,
        s.chain
    )
}
