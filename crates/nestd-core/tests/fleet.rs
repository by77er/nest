//! The fleet link core, step by step. Model-checker counterexamples are replayed here as plain
//! step sequences.

use nestd_core::fleet::*;

/// A test event of a kind; merging audit events adds their record counts, as the shell's
/// concatenation of record vectors does.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Ev {
    id: u32,
    kind: EventKind,
}

impl OutboxEvent for Ev {
    fn kind(&self) -> EventKind {
        self.kind
    }
    fn merge(&mut self, next: Self) {
        if let (EventKind::Audit { records }, EventKind::Audit { records: more }) = (&mut self.kind, next.kind) {
            *records += more;
        }
    }
}

fn ev(id: u32) -> Ev {
    Ev { id, kind: EventKind::Other }
}

/// An event shed at `rank` (0: capacity, 1: egress denied).
fn ranked(id: u32, rank: u8) -> Ev {
    Ev { id, kind: if rank == 0 { EventKind::Capacity } else { EventKind::EgressDenied } }
}

fn audit(id: u32, records: usize) -> Ev {
    Ev { id, kind: EventKind::Audit { records } }
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
    // Any inbound frame proves the link alive; once nothing has arrived for more than 2.5 heartbeat
    // intervals (250 ms here), the next heartbeat tick closes.
    let mut h = H::new();
    h.open();
    h.at(100).step(Input::Tick);
    h.at(150).step(Input::Noise { unparseable: None });
    for t in [200, 300, 400] {
        let fx = h.at(t).step(Input::Tick);
        assert!(!fx.contains(&Effect::Close), "at {t}, {} ms after the last frame: {fx:?}", t - 150);
    }
    let fx = h.at(500).step(Input::Tick);
    assert!(fx.contains(&Effect::Close), "{fx:?}");
    assert!(fx.contains(&Effect::Notify(Notice::Disconnected)));
}

#[test]
fn a_retryable_or_fatal_peer_error_reconnects_and_others_do_not() {
    let mut h = H::new();
    h.open();
    let fx = h.step(Input::Frame(Inbound::Error { code: "forbidden".into(), retryable: false, error: 9 }));
    assert!(!fx.contains(&Effect::Close) && fx.contains(&Effect::Notify(Notice::Error(9))));
    let fx = h.step(Input::Frame(Inbound::Error { code: "internal".into(), retryable: true, error: 9 }));
    assert!(fx.contains(&Effect::Close));
    h.at(BACKOFF_FIRST_MS).open();
    let fx = h.step(Input::Frame(Inbound::Error { code: "unsupported_protocol_version".into(), retryable: false, error: 9 }));
    assert!(fx.contains(&Effect::Close), "a fatal code reconnects even when not retryable: {fx:?}");
}

#[test]
fn an_offline_outbox_sheds_rank_zero_first_and_never_unranked_events() {
    let mut h = H::new();
    for i in 0..10 {
        h.step(Input::Event(ev(i)));
    }
    for i in 0..(MAX_OUTBOX_EVENTS as u32) {
        h.step(Input::Event(ranked(100 + i, 0)));
    }
    // Shed to 3072 at the 4097th, then 9 more arrive.
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS * 3 / 4 + 9);
    h.open();
    let fx = h.at(0).step(Input::Tick);
    let Some(Outbound::Events { events, .. }) = sent(&fx).into_iter().find(|o| matches!(o, Outbound::Events { .. })) else { panic!("{fx:?}") };
    assert_eq!(events.iter().filter(|e| e.kind == EventKind::Other).count(), 10);
}

#[test]
fn audit_events_coalesce_within_their_bound() {
    let mut h = H::new();
    h.step(Input::Event(audit(0, 300)));
    h.step(Input::Event(audit(1, MAX_AUDIT_RECORDS_PER_EVENT - 300)));
    assert_eq!(h.link.pending_len(), 1, "records up to the bound merge into one event");
    h.step(Input::Event(audit(2, 1)));
    assert_eq!(h.link.pending_len(), 2, "one more starts another");
    h.step(Input::Event(ev(3)));
    h.step(Input::Event(audit(4, 1)));
    assert_eq!(h.link.pending_len(), 4, "only consecutive audits merge");
    h.open();
    let fx = h.at(0).step(Input::Tick);
    let Some(Outbound::Events { events, .. }) = sent(&fx).into_iter().find(|o| matches!(o, Outbound::Events { .. })) else { panic!("{fx:?}") };
    let kinds: Vec<_> = events.iter().map(|e| (e.id, e.kind)).collect();
    let a = |records| EventKind::Audit { records };
    assert_eq!(kinds, vec![(0, a(MAX_AUDIT_RECORDS_PER_EVENT)), (2, a(1)), (3, EventKind::Other), (4, a(1))]);
}

/// The core checks that the shell's merge holds every record: one that drops some is a violated
/// invariant, which panics a debug build (and is a logged effect in release).
#[test]
#[cfg_attr(debug_assertions, should_panic(expected = "invariant violated: fleet_audit_merged"))]
fn a_merge_that_loses_records_is_an_invariant_violation() {
    #[derive(Clone, Debug, PartialEq)]
    struct Lossy(usize);
    impl OutboxEvent for Lossy {
        fn kind(&self) -> EventKind {
            EventKind::Audit { records: self.0 }
        }
        fn merge(&mut self, _: Self) {}
    }
    let mut link = FleetLink::new(Config { protocol_version: 1, flush_interval_ms: 50 }, "tok".into());
    link.step::<(), (), ()>(Now::default(), Input::Event(Lossy(2)));
    let fx = link.step::<(), (), ()>(Now::default(), Input::Event(Lossy(3)));
    assert_eq!(fx, vec![Effect::Log(Log::InvariantViolated { name: "fleet_audit_merged" })]);
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
    h.at(400).step(Input::Tick);
    h.step(Input::Connected);
    h.step(H::ack(None, None));
    assert_eq!(forwarded(&h.commands(6)), vec![6]);
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
    for i in 0..100 {
        h.step(Input::Event(ranked(i, 0)));
    }
    for i in 0..(MAX_OUTBOX_EVENTS as u32 - 100) {
        h.step(Input::Event(ranked(1_000 + i, 1)));
    }
    h.step(Input::Event(ranked(9_999, 1))); // the 4097th: 100 of rank 0 go, then 925 of rank 1
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS * 3 / 4);
}

/// A refused connect is retried after a backoff that doubles up to its cap, never sooner; a
/// connection that gets as far as its hello resets the backoff.
#[test]
fn failed_connects_back_off_doubling_to_the_cap_and_a_connection_resets_it() {
    let mut h = H::new();
    let (mut at, mut waits) = (0, Vec::new());
    for _ in 0..10 {
        assert_eq!(h.at(at).step(Input::Tick), vec![Effect::Connect { token: "tok".into() }]);
        h.step(Input::ConnectFailed { error: "refused".into() });
        let next = h.link.wake_at().expect("a failed connect is retried");
        assert_eq!(h.at(next - 1).step(Input::Tick), vec![], "not before the backoff");
        waits.push(next - at);
        at = next;
    }
    assert_eq!(waits, [200, 400, 800, 1_600, 3_200, 6_400, 12_800, 25_600, 30_000, 30_000]);
    h.at(at).step(Input::Tick);
    h.step(Input::Connected);
    h.step(Input::Closed);
    assert_eq!(h.link.wake_at(), Some(at + 200), "back to the first backoff");
}

/// A hello nobody answers is given up after `HELLO_WAIT_MS` without a frame; any frame restarts
/// the wait (FleetDO may be slow to ack a large hello, but it is talking).
#[test]
fn an_unanswered_hello_is_given_up_after_its_wait_and_any_frame_restarts_it() {
    let mut h = H::new();
    h.step(Input::Tick);
    h.at(1_000).step(Input::Connected);
    assert_eq!(h.link.wake_at(), Some(1_000 + HELLO_WAIT_MS));
    h.at(5_000).step(Input::Noise { unparseable: None });
    assert_eq!(h.link.wake_at(), Some(5_000 + HELLO_WAIT_MS));
    assert_eq!(h.at(5_000 + HELLO_WAIT_MS - 1).step(Input::Tick), vec![]);
    let fx = h.at(5_000 + HELLO_WAIT_MS).step(Input::Tick);
    assert_eq!(fx, vec![Effect::Close, Effect::Notify(Notice::Disconnected)]);
}

/// FleetDO refusing the hello (unauthorized, another version) ends the connection at once and the
/// host hears why, instead of waiting out the hello.
#[test]
fn a_refused_hello_closes_at_once_and_reports_the_error() {
    let mut h = H::new();
    h.step(Input::Tick);
    h.step(Input::Connected);
    let fx = h.step(Input::Frame(Inbound::Error { code: "unauthorized".into(), retryable: false, error: 7 }));
    assert!(fx.contains(&Effect::Notify(Notice::Error(7))) && fx.contains(&Effect::Close), "{fx:?}");
    assert_eq!(h.link.phase(), Phase::Idle);
}

/// A heartbeat ack renews the lease from when that heartbeat was sent, on both clocks: after a
/// suspend boottime has run on while monotonic hasn't, so the boottime deadline is the nearer one
/// and bounds the wall-clock `valid_until_ms` the proxy and runner enforce. The shell takes every
/// renewal as the new deadline, so an ack older than one already applied must not renew (it would
/// move the deadline back).
#[test]
fn a_heartbeat_ack_renews_the_lease_from_its_send_on_both_clocks_and_never_backwards() {
    let mut h = H::new();
    h.open();
    h.at(0).step(Input::Tick); // heartbeat sent_ms 1_000
    h.at(100).step(Input::Tick); // heartbeat sent_ms 1_100
    let renewed = |fx: &Fx| {
        fx.iter().find_map(|e| match e {
            Effect::Notify(Notice::LeaseRenewed { deadline_mono, deadline_boot, valid_until_ms }) => Some((*deadline_mono, *deadline_boot, *valid_until_ms)),
            _ => None,
        })
    };
    let hb_ack = |sent_ms| Input::Frame(Inbound::HeartbeatAck { sent_ms, revoked: None });
    h.at(120);
    assert_eq!(renewed(&h.step(hb_ack(1_000))), Some((1_000, 1_000, 1_120 + 880)));
    // The host was suspended for 250 ms before the next ack: boottime is 250 ms ahead.
    h.now = Now { mono: 150, boot: 400, wall: 9_000 };
    assert_eq!(renewed(&h.step(hb_ack(1_100))), Some((1_100, 1_100, 9_000 + 700)), "1_100 - 400 left on boottime");
    assert_eq!(renewed(&h.step(hb_ack(1_000))), None, "older than the ack already applied");
    assert_eq!(renewed(&h.step(hb_ack(4_242))), None, "never sent");
}

/// A cumulative ack releases every batch up to it and nothing after; a reconnect resends only what
/// is still unacknowledged.
#[test]
fn an_ack_releases_the_batches_it_covers_and_a_reconnect_resends_only_the_rest() {
    let mut h = H::new();
    h.open();
    for (id, t) in [(0, 0), (1, 50), (2, 100)] {
        h.step(Input::Event(ev(id)));
        h.at(t).step(Input::Tick);
    }
    assert_eq!(h.link.unacked_seqs().collect::<Vec<_>>(), vec![1, 2, 3]);
    h.step(Input::Frame(Inbound::Ack { up_to: 2 }));
    assert_eq!(h.link.unacked_seqs().collect::<Vec<_>>(), vec![3]);
    h.step(Input::Closed);
    h.at(300).step(Input::Tick);
    h.step(Input::Connected);
    assert_eq!(sent(&h.step(H::ack(None, None))), vec![Outbound::Events { seq: 3, events: vec![ev(2)] }]);
}

/// The bound covers events sent but not yet acknowledged (they're held for a resend), but only
/// queued events are shed; the log carries the running count of events lost, the operator's only
/// record of them.
#[test]
fn the_outbox_bound_counts_unacknowledged_events_and_logs_what_it_sheds() {
    let mut h = H::new();
    h.open();
    for i in 0..FLUSH_AT_EVENTS as u32 {
        h.step(Input::Event(ev(i)));
    }
    assert_eq!((h.link.pending_len(), h.link.unacked_seqs().collect::<Vec<_>>()), (0, vec![1]), "flushed as batch 1");
    h.step(Input::Closed);
    let low = |id| ranked(id, 0);
    for i in 0..(MAX_OUTBOX_EVENTS - FLUSH_AT_EVENTS) as u32 {
        h.step(Input::Event(low(1_000 + i)));
    }
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS - FLUSH_AT_EVENTS, "at the bound, nothing is shed");
    let fx = h.step(Input::Event(low(9_999)));
    assert_eq!(h.link.pending_len(), MAX_OUTBOX_EVENTS * 3 / 4 - FLUSH_AT_EVENTS);
    assert_eq!(h.link.unacked_seqs().collect::<Vec<_>>(), vec![1], "sent events are never shed");
    assert!(fx.contains(&Effect::Log(Log::OutboxShed { shed: (MAX_OUTBOX_EVENTS / 4 + 1) as u64 })), "{fx:?}");
}
