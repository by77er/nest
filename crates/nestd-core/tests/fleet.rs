//! The fleet link core, step by step. Model-checker counterexamples are replayed here as plain
//! step sequences.

use nestd_core::fleet::*;

/// A test event: `rank` is its shedding rank; `audit` events absorb each other up to 3 records.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Ev {
    id: u32,
    rank: Option<u8>,
    audit: u32,
}

impl OutboxEvent for Ev {
    fn shed_rank(&self) -> Option<u8> {
        self.rank
    }
    fn absorb(&mut self, next: &Self) -> bool {
        if self.audit > 0 && next.audit > 0 && self.audit + next.audit <= 3 {
            self.audit += next.audit;
            true
        } else {
            false
        }
    }
}

fn ev(id: u32) -> Ev {
    Ev { id, rank: None, audit: 0 }
}

type In = Input<Ev, &'static str, u8, u8>;
type Fx = Vec<Effect<Ev, &'static str, u8, u8>>;

const LEASE: Lease = Lease { heartbeat_ms: 100, host_fence_ms: 1_000, cp_expiry_ms: 1_500 };

struct H {
    link: FleetLink<Ev>,
    now: Now,
}

impl H {
    fn new() -> H {
        H { link: FleetLink::new(Config { protocol_version: 1, flush_interval_ms: 50 }, "tok".into()), now: Now { mono: 0, boot: 0, wall: 1_000 } }
    }
    fn at(&mut self, mono: u64) -> &mut Self {
        self.now = Now { mono, boot: mono, wall: 1_000 + mono as i64 };
        self
    }
    fn step(&mut self, i: In) -> Fx {
        self.link.step(self.now, i)
    }
    fn ack(last_event_seq: Option<u64>, next_command_seq: Option<u64>) -> In {
        Input::Frame(Inbound::HelloAck { protocol_version: 1, last_event_seq, next_command_seq, lease: LEASE })
    }
    /// Connect and complete the hello at the current time.
    fn open(&mut self) -> Fx {
        assert_eq!(self.step(Input::Tick), vec![Effect::Connect { token: "tok".into() }]);
        let hello = self.step(Input::Connected);
        assert!(matches!(hello[..], [Effect::Send(Outbound::Hello { .. })]), "{hello:?}");
        let fx = self.step(H::ack(None, None));
        assert!(self.link.is_open());
        fx
    }
    fn commands(&mut self, seq: u64) -> Fx {
        self.step(Input::Frame(Inbound::Commands { seq, commands: "c" }))
    }
}

fn sent(fx: &Fx) -> Vec<Outbound<Ev>> {
    fx.iter().filter_map(|e| if let Effect::Send(o) = e { Some(o.clone()) } else { None }).collect()
}

fn forwarded(fx: &Fx) -> Vec<u64> {
    fx.iter().filter_map(|e| if let Effect::Notify(Notice::Commands { seq, .. }) = e { Some(*seq) } else { None }).collect()
}

#[test]
fn the_hello_ack_renews_the_lease_from_the_hello_and_resends_what_the_peer_lacks() {
    let mut h = H::new();
    h.open();
    h.step(Input::Event(ev(1)));
    h.step(Input::Event(ev(2)));
    let fx = h.at(50).step(Input::Tick); // heartbeat and flush were due at 0, the flush again at 50
    assert!(sent(&fx).contains(&Outbound::Events { seq: 1, events: vec![ev(1), ev(2)] }), "{fx:?}");
    h.step(Input::Event(ev(3)));
    h.at(100).step(Input::Tick);
    assert_eq!(h.link.unacked_seqs().collect::<Vec<_>>(), vec![1, 2]);
    h.step(Input::Closed);
    // Reconnect at 300 (200 ms backoff); the hello goes out at 300, its ack arrives at 340.
    assert_eq!(h.link.wake_at(), Some(300));
    h.at(300).step(Input::Tick);
    h.step(Input::Connected);
    let fx = h.at(340).step(H::ack(Some(1), None));
    let renewed = fx.iter().find_map(|e| if let Effect::Notify(Notice::LeaseRenewed { deadline_mono, .. }) = e { Some(*deadline_mono) } else { None });
    assert_eq!(renewed, Some(300 + 1_000), "renewed from the hello's send time, not the ack's");
    assert_eq!(sent(&fx), vec![Outbound::Events { seq: 2, events: vec![ev(3)] }], "only what FleetDO hasn't processed");
}

#[test]
fn commands_are_forwarded_once_and_acked_after_their_results() {
    let mut h = H::new();
    h.open();
    assert_eq!(forwarded(&h.commands(1)), vec![1]);
    assert_eq!(h.commands(1), vec![], "still processing: neither forwarded nor acked");
    h.step(Input::Event(ev(7)));
    let fx = h.step(Input::CommandsDone(1));
    assert_eq!(sent(&fx), vec![Outbound::Events { seq: 1, events: vec![ev(7)] }, Outbound::Ack { up_to: 1 }], "results first");
    assert_eq!(sent(&h.commands(1)), vec![Outbound::Ack { up_to: 1 }], "processed: re-acked");
}

#[test]
fn a_failed_ca_renewal_send_is_kept_for_the_next_connection() {
    let mut h = H::new();
    h.open();
    let fx = h.step(Input::CaRenew("csr".into()));
    assert_eq!(sent(&fx), vec![Outbound::CaRenew { csr_pem: "csr".into() }]);
    let fx = h.step(Input::SendFailed(Outbound::CaRenew { csr_pem: "csr".into() }));
    assert_eq!(fx, vec![Effect::Notify(Notice::Disconnected)]);
    h.at(200).step(Input::Tick);
    h.step(Input::Connected);
    assert!(sent(&h.step(H::ack(None, None))).contains(&Outbound::CaRenew { csr_pem: "csr".into() }));
}

#[test]
fn heartbeat_keys_increase_when_the_wall_clock_steps_back_and_silence_closes() {
    let mut h = H::new();
    h.open();
    let key = |fx: &Fx| sent(fx).iter().find_map(|o| if let Outbound::Heartbeat { sent_ms } = o { Some(*sent_ms) } else { None });
    let mut h2 = |mono: u64, wall: i64| {
        h.now = Now { mono, boot: mono, wall };
        let fx = h.link.step(h.now, Input::Tick);
        h.link.step::<&str, u8, u8>(h.now, Input::Noise { unparseable: None });
        fx
    };
    let a = key(&h2(100, 5_000)).unwrap();
    let b = key(&h2(200, 4_000)).unwrap();
    assert!(b > a, "{a} then {b}");
    // Then nothing arrives: after more than 2.5 intervals since the last frame, a tick closes.
    let mut h = H::new();
    h.open();
    h.at(100).step(Input::Tick);
    h.at(200).step(Input::Tick);
    let fx = h.at(300).step(Input::Tick);
    assert!(fx.contains(&Effect::Close), "{fx:?}");
    assert!(fx.contains(&Effect::Notify(Notice::Disconnected)));
}

#[test]
fn a_retryable_or_fatal_peer_error_reconnects_and_others_do_not() {
    let mut h = H::new();
    h.open();
    let fx = h.step(Input::Frame(Inbound::Error { fatal: false, retryable: false, error: 9 }));
    assert!(!fx.contains(&Effect::Close) && fx.contains(&Effect::Notify(Notice::Error(9))));
    let fx = h.step(Input::Frame(Inbound::Error { fatal: false, retryable: true, error: 9 }));
    assert!(fx.contains(&Effect::Close));
}

#[test]
fn an_offline_outbox_sheds_rank_zero_first_and_never_unranked_events() {
    let mut h = H::new();
    for i in 0..10 {
        h.step(Input::Event(ev(i)));
    }
    for i in 0..(MAX_OUTBOX_EVENTS as u32) {
        h.step(Input::Event(Ev { id: 100 + i, rank: Some(0), audit: 0 }));
    }
    // Shed to 3072 at the 4097th, then 9 more arrive.
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS * 3 / 4 + 9);
    h.open();
    let fx = h.at(0).step(Input::Tick);
    let Some(Outbound::Events { events, .. }) = sent(&fx).into_iter().find(|o| matches!(o, Outbound::Events { .. })) else { panic!("{fx:?}") };
    assert_eq!(events.iter().filter(|e| e.rank.is_none()).count(), 10);
}

#[test]
fn audit_events_coalesce_within_their_bound() {
    let mut h = H::new();
    let audit = |id| Ev { id, rank: Some(0), audit: 1 };
    for i in 0..4 {
        h.step(Input::Event(audit(i)));
    }
    assert_eq!(h.link.pending_len(), 2, "3 records merge into one event, the 4th starts another");
}

/// Model-checker counterexample (verification/nestd/check, `no_ack_without_execution`, 11 steps on
/// the core before this fix): FleetDO sends batch 2 while batch 1 awaits BrokerDO; the core
/// forwarded 2, dropped 1 as "still processing" when it came, and 2's cumulative ack deleted 1.
/// Now 2 is a gap against the hello_ack's baseline: the core reconnects and forwards nothing.
#[test]
fn a_batch_that_overtakes_a_lower_one_is_a_gap_not_an_ack() {
    let mut h = H::new();
    assert_eq!(h.step(Input::Tick), vec![Effect::Connect { token: "tok".into() }]);
    h.step(Input::Connected);
    h.step(H::ack(None, Some(1)));
    let fx = h.commands(2);
    assert!(forwarded(&fx).is_empty() && fx.contains(&Effect::Close), "{fx:?}");
    assert!(fx.contains(&Effect::Notify(Notice::Disconnected)));
    // The reconnect's hello resends in order: 1 then 2 are forwarded, each once.
    h.at(200).step(Input::Tick);
    h.step(Input::Connected);
    h.step(H::ack(None, Some(1)));
    assert_eq!(forwarded(&h.commands(1)), vec![1]);
    assert_eq!(forwarded(&h.commands(2)), vec![2]);
    assert!(h.commands(4).contains(&Effect::Close), "3 is missing");
}

/// Without a baseline (a FleetDO from before `next_command_seq`) the first batch after the hello is
/// taken, then strict order; one past the last processed when the host has processed any.
#[test]
fn without_a_baseline_the_order_starts_after_the_last_processed_batch() {
    let mut h = H::new();
    h.open();
    assert_eq!(forwarded(&h.commands(5)), vec![5]);
    assert!(h.commands(7).contains(&Effect::Close));
    h.step(Input::CommandsDone(5));
    h.at(200).step(Input::Tick);
    h.step(Input::Connected);
    h.step(H::ack(None, None));
    assert!(h.commands(7).contains(&Effect::Close), "6 is next");
}

/// A batch replayed at a reconnect finishes after a later one did, while offline: the next hello
/// must not report the older seq (FleetDO would resend what was acked, and a strict host would see
/// a gap on every reconnect).
#[test]
fn last_processed_never_moves_back_while_offline() {
    let mut h = H::new();
    h.open();
    h.commands(1);
    h.commands(2);
    h.step(Input::CommandsDone(2));
    h.step(Input::Closed);
    h.step(Input::CommandsDone(1));
    assert_eq!(h.link.last_command_seq(), Some(2));
}

/// Shedding stops at the target: rank 1 sheds only what rank 0 couldn't.
#[test]
fn shedding_rank_one_takes_only_the_remaining_excess() {
    let mut h = H::new();
    let ranked = |id, r| Ev { id, rank: Some(r), audit: 0 };
    for i in 0..100 {
        h.step(Input::Event(ranked(i, 0)));
    }
    for i in 0..(MAX_OUTBOX_EVENTS as u32 - 100) {
        h.step(Input::Event(ranked(1_000 + i, 1)));
    }
    h.step(Input::Event(ranked(9_999, 1))); // the 4097th: 100 of rank 0 go, then 925 of rank 1
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS * 3 / 4);
}
