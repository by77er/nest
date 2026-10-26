//! The fleet link as FleetDO sees it, over a real WebSocket: a scripted peer plays FleetDO frame by
//! frame and the test plays the host (inputs in, notices out). These pin the link's observable
//! behaviour across the extraction of its core (`nestd_core::fleet`): what goes on the wire, in
//! which order, and what the host is told.

#![allow(clippy::result_large_err)] // tungstenite's handshake callback type

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nest_protocol::control::*;
use nest_protocol::model::*;
use nestd::fleet::{FleetInput, FleetNotice, FleetParams, FleetReporter};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;

const HB_MS: u64 = 60;

struct Reporter;
impl FleetReporter for Reporter {
    fn report(&self) -> (Vec<SandboxReport>, Vec<AgentReport>, Capacity) {
        (vec![], vec![], capacity())
    }
    fn lease_claims(&self) -> Vec<LeaseClaim> {
        vec![]
    }
}

fn capacity() -> Capacity {
    Capacity { vcpus_free: 1, memory_mib_free: 1, hugepages_mib_free: 0, hugepages_mib_total: 0, sandboxes: 0, agents: 0, warm: vec![] }
}

/// One accepted connection: frames from the host, and a sink for FleetDO's frames.
struct Conn {
    rx: mpsc::UnboundedReceiver<HostToFleet>,
    tx: mpsc::UnboundedSender<Option<serde_json::Value>>,
    auth: String,
}

impl Conn {
    async fn next(&mut self) -> HostToFleet {
        timeout(Duration::from_secs(5), self.rx.recv()).await.expect("a frame from the host").expect("connection open")
    }
    /// The next frame that isn't a heartbeat (heartbeats are answered by the test where it matters).
    async fn next_non_hb(&mut self) -> HostToFleet {
        loop {
            match self.next().await {
                HostToFleet::Heartbeat { .. } => continue,
                f => return f,
            }
        }
    }
    fn send(&self, v: serde_json::Value) {
        let _ = self.tx.send(Some(v));
    }
    /// Close the connection from FleetDO's side.
    fn close(&self) {
        let _ = self.tx.send(None);
    }
    async fn closed(&mut self) {
        let end = timeout(Duration::from_secs(5), async {
            while self.rx.recv().await.is_some() {}
        });
        end.await.expect("the host closes the connection");
    }
    fn hello_ack(&self, last_event_seq: Option<u64>) {
        self.hello_ack_from(last_event_seq, None);
    }
    fn hello_ack_from(&self, last_event_seq: Option<u64>, next_command_seq: Option<u64>) {
        let mut ack = json!({ "type": "hello_ack", "protocol_version": PROTOCOL_VERSION, "server_ms": 0,
            "lease": { "heartbeat_ms": HB_MS, "host_fence_ms": 10_000, "cp_expiry_ms": 15_000 }, "host_token_expires_ms": 0 });
        if let Some(s) = last_event_seq {
            ack["last_event_seq"] = json!(s);
        }
        if let Some(s) = next_command_seq {
            ack["next_command_seq"] = json!(s);
        }
        self.send(ack);
    }
    fn commands(&self, seq: u64) {
        self.send(json!({ "type": "commands", "seq": seq, "commands": [
            { "cmd": format!("cmd_{seq}"), "issued_ms": 0, "type": "agent_stop", "agent": "agt_1", "reason": "test" } ] }));
    }
}

struct Peer {
    url: String,
    conns: mpsc::UnboundedReceiver<Conn>,
}

impl Peer {
    async fn start() -> Self {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/fleet", l.local_addr().unwrap());
        let (ctx, conns) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((tcp, _)) = l.accept().await {
                let auth = Arc::new(Mutex::new(String::new()));
                let a = auth.clone();
                let Ok(ws) = tokio_tungstenite::accept_hdr_async(tcp, move |req: &tokio_tungstenite::tungstenite::handshake::server::Request, resp| {
                    *a.lock().unwrap() = req.headers().get("authorization").map(|v| v.to_str().unwrap().to_string()).unwrap_or_default();
                    Ok(resp)
                })
                .await
                else {
                    continue;
                };
                let (mut sink, mut stream) = ws.split();
                let (in_tx, in_rx) = mpsc::unbounded_channel();
                let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Option<serde_json::Value>>();
                let auth = auth.lock().unwrap().clone();
                if ctx.send(Conn { rx: in_rx, tx: out_tx, auth }).is_err() {
                    return;
                }
                tokio::spawn(async move {
                    loop {
                        tokio::select! {
                            out = out_rx.recv() => match out {
                                Some(Some(v)) => { if sink.send(Message::Text(v.to_string().into())).await.is_err() { break; } }
                                _ => { let _ = sink.close().await; break; }
                            },
                            msg = stream.next() => match msg {
                                Some(Ok(Message::Text(t))) => { let _ = in_tx.send(serde_json::from_str::<HostToFleet>(&t).unwrap()); }
                                Some(Ok(_)) => {}
                                _ => break,
                            },
                        }
                    }
                });
            }
        });
        Peer { url, conns }
    }

    async fn accept(&mut self) -> Conn {
        timeout(Duration::from_secs(10), self.conns.recv()).await.expect("the host connects").unwrap()
    }
}

struct Link {
    input: mpsc::UnboundedSender<FleetInput>,
    notices: mpsc::UnboundedReceiver<FleetNotice>,
}

impl Link {
    fn start(url: &str) -> Link {
        let (input, input_rx) = mpsc::unbounded_channel();
        let (notice_tx, notices) = mpsc::unbounded_channel();
        let (_tunnel_tx, tunnel) = tokio::sync::watch::channel(TunnelState::None);
        std::mem::forget(_tunnel_tx);
        let params = FleetParams {
            url: url.to_string(),
            token: "tok".into(),
            host: HostId("hst_t".into()),
            role: HostRole::Burst,
            cell: "c1".into(),
            gateway_url: None,
            tunnel,
            versions: ComponentVersions { nestd: "t".into(), nest_proxy: "t".into(), agent_runner: "t".into(), claude_code: "t".into() },
            instance_id: "inst_1".into(),
            flush_interval: Duration::from_millis(20),
            cgroup_delegation_error: None,
        };
        nestd::fleet::spawn(params, Arc::new(Reporter), input_rx, notice_tx);
        Link { input, notices }
    }
    fn event(&self, body: HostEventBody) {
        self.input.send(FleetInput::Event(HostEvent { ts_ms: 0, body })).unwrap();
    }
    fn done(&self, seq: u64) {
        self.input.send(FleetInput::CommandsDone(Seq(seq))).unwrap();
    }
    /// The next notice matching `f`, skipping others.
    async fn notice<T>(&mut self, mut f: impl FnMut(FleetNotice) -> Option<T>) -> T {
        timeout(Duration::from_secs(5), async {
            loop {
                if let Some(t) = f(self.notices.recv().await.expect("link alive")) {
                    return t;
                }
            }
        })
        .await
        .expect("the expected notice")
    }
    /// No `Commands` notice arrives within `ms`.
    async fn no_commands_for(&mut self, ms: u64) {
        let r = timeout(Duration::from_millis(ms), async {
            loop {
                if let FleetNotice::Commands { seq, .. } = self.notices.recv().await.expect("link alive") {
                    return seq;
                }
            }
        })
        .await;
        assert!(r.is_err(), "unexpected Commands notice for {:?}", r.ok());
    }
}

fn tunnel_event(n: u64) -> HostEventBody {
    // A cheap, non-sheddable event whose content identifies it.
    HostEventBody::SpotNotice { deadline_ms: n as i64 }
}

fn event_ids(events: &[HostEvent]) -> Vec<String> {
    events
        .iter()
        .map(|e| match &e.body {
            HostEventBody::SpotNotice { deadline_ms } => format!("t{deadline_ms}"),
            other => format!("{other:?}"),
        })
        .collect()
}

async fn connect(peer: &mut Peer) -> (Conn, Box<HostHello>) {
    let mut c = peer.accept().await;
    let HostToFleet::Hello(h) = c.next().await else { panic!("hello first") };
    (c, h)
}

#[tokio::test]
async fn hello_carries_the_report_and_unacked_batches_are_resent_after_the_peer_baseline() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, h) = connect(&mut peer).await;
    assert_eq!(c.auth, "Bearer tok");
    assert_eq!((h.instance_id.as_str(), h.last_command_seq, h.protocol_version), ("inst_1", None, PROTOCOL_VERSION));
    c.hello_ack(None);
    link.notice(|n| matches!(n, FleetNotice::Connected { .. }).then_some(())).await;
    link.event(tunnel_event(1));
    let HostToFleet::Events { seq, events } = c.next_non_hb().await else { panic!("events") };
    assert_eq!((seq, event_ids(&events)), (Seq(1), vec!["t1".to_string()]));
    link.event(tunnel_event(2));
    let HostToFleet::Events { seq, .. } = c.next_non_hb().await else { panic!("events") };
    assert_eq!(seq, Seq(2));
    c.send(json!({ "type": "ack", "up_to": 1 }));
    // Batch 2 unacked; the connection drops; an event arrives offline.
    c.close();
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    link.event(tunnel_event(3));
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(None); // FleetDO processed nothing it will admit to: everything unacked is resent
    let HostToFleet::Events { seq, events } = c.next_non_hb().await else { panic!("events") };
    assert_eq!((seq, event_ids(&events)), (Seq(2), vec!["t2".to_string()]));
    let HostToFleet::Events { seq, events } = c.next_non_hb().await else { panic!("events") };
    assert_eq!((seq, event_ids(&events)), (Seq(3), vec!["t3".to_string()]));
    // Reconnect again: FleetDO says it processed 2, so only 3 is resent.
    c.close();
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(Some(2));
    let HostToFleet::Events { seq, .. } = c.next_non_hb().await else { panic!("events") };
    assert_eq!(seq, Seq(3));
}

#[tokio::test]
async fn commands_are_forwarded_once_and_acked_after_their_results() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    c.commands(1);
    let seq = link.notice(|n| if let FleetNotice::Commands { seq, .. } = n { Some(seq) } else { None }).await;
    assert_eq!(seq, Seq(1));
    c.commands(1); // a resend while it still runs: not forwarded again, not acked
    link.no_commands_for(150).await;
    // Its result, then done: the result's batch goes out before the ack.
    link.event(tunnel_event(1));
    link.done(1);
    let HostToFleet::Events { seq: es, events } = c.next_non_hb().await else { panic!("events first") };
    assert_eq!((es, event_ids(&events)), (Seq(1), vec!["t1".to_string()]));
    let HostToFleet::Ack { up_to } = c.next_non_hb().await else { panic!("then the ack") };
    assert_eq!(up_to, Seq(1));
    c.commands(1); // a resend after it ran: re-acked
    let HostToFleet::Ack { up_to } = c.next_non_hb().await else { panic!("re-ack") };
    assert_eq!(up_to, Seq(1));
    link.no_commands_for(100).await;
    c.commands(2);
    let seq = link.notice(|n| if let FleetNotice::Commands { seq, .. } = n { Some(seq) } else { None }).await;
    assert_eq!(seq, Seq(2));
}

#[tokio::test]
async fn a_batch_still_running_at_a_reconnect_is_forwarded_again_and_done_offline_is_reported_in_the_hello() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    c.commands(1);
    link.notice(|n| matches!(n, FleetNotice::Commands { .. }).then_some(())).await;
    c.close();
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    // Reconnected while batch 1 still runs: FleetDO resends it and the host forwards it again (the
    // executor's dedup by `cmd` answers it from its first run).
    let (c, h) = connect(&mut peer).await;
    assert_eq!(h.last_command_seq, None);
    c.hello_ack(None);
    c.commands(1);
    let seq = link.notice(|n| if let FleetNotice::Commands { seq, .. } = n { Some(seq) } else { None }).await;
    assert_eq!(seq, Seq(1));
    // Done while disconnected: the next hello says so.
    c.close();
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    link.done(1);
    let (_c, h) = connect(&mut peer).await;
    assert_eq!(h.last_command_seq, Some(Seq(1)));
}

#[tokio::test]
async fn a_retryable_error_reconnects_and_a_rotated_token_is_used_for_it() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    c.send(json!({ "type": "host_token", "token": "tok2", "expires_ms": 99 }));
    let (token, expires) = link.notice(|n| if let FleetNotice::HostToken { token, expires_ms } = n { Some((token, expires_ms)) } else { None }).await;
    assert_eq!((token.as_str(), expires), ("tok2", 99));
    // A non-retryable error is reported and the connection stays.
    c.send(json!({ "type": "error", "error": { "code": "invalid_message", "message": "x", "retryable": false } }));
    link.notice(|n| matches!(n, FleetNotice::Error(_)).then_some(())).await;
    c.commands(1);
    link.notice(|n| matches!(n, FleetNotice::Commands { .. }).then_some(())).await;
    // A retryable one closes it; the reconnect presents the rotated token.
    c.send(json!({ "type": "error", "error": { "code": "internal", "message": "x", "retryable": true } }));
    c.closed().await;
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    let (c, _) = connect(&mut peer).await;
    assert_eq!(c.auth, "Bearer tok2");
}

#[tokio::test]
async fn heartbeats_have_increasing_keys_and_their_acks_renew_the_lease() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    // The hello_ack renews the lease from the hello's send time.
    link.notice(|n| matches!(n, FleetNotice::LeaseRenewed { .. }).then_some(())).await;
    let mut keys = vec![];
    while keys.len() < 3 {
        if let HostToFleet::Heartbeat { sent_ms, .. } = c.next().await {
            keys.push(sent_ms);
        }
    }
    assert!(keys.windows(2).all(|w| w[0] < w[1]), "{keys:?}");
    // An ack for an unknown key renews nothing; a known one does, and revoked claims are passed on.
    c.send(json!({ "type": "heartbeat_ack", "sent_ms": 1, "server_ms": 0, "revoked": [] }));
    c.send(json!({ "type": "heartbeat_ack", "sent_ms": keys[2], "server_ms": 0,
        "revoked": [{ "sandbox": "sbx_1", "epoch": 3 }] }));
    let mut renewed = false;
    let revoked = link
        .notice(|n| match n {
            FleetNotice::LeaseRenewed { .. } => {
                renewed = true;
                None
            }
            FleetNotice::Revoked(r) => Some(r),
            _ => None,
        })
        .await;
    assert!(renewed, "the known key renews the lease (before its revocations are passed on)");
    assert_eq!(revoked, vec![LeaseClaim { sandbox: SandboxId("sbx_1".into()), epoch: Epoch(3) }]);
}

#[tokio::test]
async fn a_silent_connection_is_dropped_and_the_link_reconnects() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    // Never answer again: after ~2.5 heartbeat intervals the host gives up on this connection.
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    let (_c2, _) = connect(&mut peer).await;
    drop(c);
}

#[tokio::test]
async fn a_hello_ack_of_another_protocol_version_closes_the_connection() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, _) = connect(&mut peer).await;
    c.send(json!({ "type": "hello_ack", "protocol_version": PROTOCOL_VERSION + 1, "server_ms": 0,
        "lease": { "heartbeat_ms": HB_MS, "host_fence_ms": 10_000, "cp_expiry_ms": 15_000 }, "host_token_expires_ms": 0 }));
    c.closed().await;
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    let (_c, _) = connect(&mut peer).await;
}

#[tokio::test]
async fn an_overflowing_offline_outbox_sheds_low_value_events_only() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    // Never acknowledge the first hello: everything below is pushed while not connected.
    let (c, _) = connect(&mut peer).await;
    c.close();
    link.notice(|n| matches!(n, FleetNotice::Disconnected).then_some(())).await;
    for i in 0..10u64 {
        link.event(tunnel_event(i));
    }
    for _ in 0..4200u32 {
        link.event(HostEventBody::Capacity { capacity: capacity() });
    }
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack(None);
    let HostToFleet::Events { events, .. } = c.next_non_hb().await else { panic!("events") };
    let kept_tasks = events.iter().filter(|e| matches!(e.body, HostEventBody::SpotNotice { .. })).count();
    assert_eq!(kept_tasks, 10, "non-sheddable events are never shed");
    // Past 4096 pending, capacity events are shed down to 3072; the 113 pushed after that stay.
    assert_eq!(events.len(), 3072 + 113, "one batch, shed once");
}

#[tokio::test]
async fn a_command_batch_that_overtakes_a_lower_one_makes_the_host_reconnect() {
    let mut peer = Peer::start().await;
    let mut link = Link::start(&peer.url);
    let (mut c, _) = connect(&mut peer).await;
    c.hello_ack_from(None, Some(1));
    // Batch 2 arrives before 1 (FleetDO's send of 1 still awaits BrokerDO): not forwarded, not
    // acked; the host closes the connection so the hello resends from 1.
    c.commands(2);
    c.closed().await;
    link.no_commands_for(50).await;
    let (c, h) = connect(&mut peer).await;
    assert_eq!(h.last_command_seq, None);
    c.hello_ack_from(None, Some(1));
    c.commands(1);
    c.commands(2);
    let mut got = vec![];
    while got.len() < 2 {
        got.push(link.notice(|n| if let FleetNotice::Commands { seq, .. } = n { Some(seq.0) } else { None }).await);
    }
    assert_eq!(got, vec![1, 2]);
}
