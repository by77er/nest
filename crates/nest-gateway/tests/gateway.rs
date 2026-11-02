//! The gateway against a fake guest (a unix socket speaking the hybrid-vsock handshake and
//! echoing frames) and a fake nestd (the link's other end), driven by a real WebSocket client.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use nest_gateway::state::clients;
use nest_gateway::testing::{Signer, kid_of};
use nest_gateway::{State, serve};
use nest_protocol::gateway::{
    BindingClaims, BindingKey, BindingScope, ClientMessage, GatewayMessage, GuestInfo, PROTOCOL_VERSION, close_code, error_code,
};
use nest_protocol::guest::frame::{self, Decoder, Kind, MAX_FRAME_LEN};
use nest_protocol::guest::{PORT_HANDS, handshake};
use nest_protocol::host::gateway_link::{GatewayCommand, GatewayEvent, SandboxPause};
use nest_protocol::model::{Epoch, SandboxId};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UnixListener, UnixStream};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

const SBX: &str = "sbx_01jb7m2a4c";
const AGENT: &str = "agt_01jb7n0w1e";

fn sbx() -> SandboxId {
    SandboxId(SBX.into())
}

fn guest_v1() -> GuestInfo {
    GuestInfo { protocol_version: 1, capabilities: vec!["pty".into()] }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn claims(signer: &Signer) -> BindingClaims {
    BindingClaims {
        v: 1,
        kid: signer.kid(),
        sandbox: sbx(),
        epoch: Epoch(4),
        client: AGENT.into(),
        scope: BindingScope::Hands,
        exp_ms: now_ms() + 60_000,
    }
}

/// A guest behind `<dir>/vsock.sock`: `CONNECT 1025` → `OK` (after `ok_delay_ms`), then every
/// frame is logged and answered with two frames in one write (`started`, then an echo).
/// Hangups are counted.
struct FakeGuest {
    path: PathBuf,
    frames: Arc<Mutex<Vec<Vec<u8>>>>,
    hangups: Arc<AtomicUsize>,
    ok_delay_ms: Arc<AtomicU64>,
    _dir: tempfile::TempDir,
}

impl FakeGuest {
    async fn start() -> FakeGuest {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vsock.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let frames: Arc<Mutex<Vec<Vec<u8>>>> = Default::default();
        let hangups = Arc::new(AtomicUsize::new(0));
        let ok_delay_ms = Arc::new(AtomicU64::new(0));
        let (f, h, d) = (frames.clone(), hangups.clone(), ok_delay_ms.clone());
        tokio::spawn(async move {
            while let Ok((s, _)) = listener.accept().await {
                tokio::spawn(guest_conn(s, f.clone(), h.clone(), d.clone()));
            }
        });
        FakeGuest { path, frames, hangups, ok_delay_ms, _dir: dir }
    }

    async fn frames(&self) -> Vec<Vec<u8>> {
        self.frames.lock().await.clone()
    }
}

async fn guest_conn(mut s: UnixStream, frames: Arc<Mutex<Vec<Vec<u8>>>>, hangups: Arc<AtomicUsize>, ok_delay_ms: Arc<AtomicU64>) {
    let mut line = Vec::new();
    loop {
        let mut b = [0u8; 1];
        if s.read(&mut b).await.unwrap_or(0) == 0 {
            return;
        }
        line.push(b[0]);
        if b[0] == b'\n' {
            break;
        }
    }
    if handshake::parse_connect_line(&String::from_utf8_lossy(&line)) != Some(PORT_HANDS) {
        return;
    }
    let delay = ok_delay_ms.load(Ordering::SeqCst);
    if delay > 0 {
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
    if s.write_all(handshake::ok_line(1 << 30).as_bytes()).await.is_err() {
        return;
    }
    let mut dec = Decoder::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = match s.read(&mut buf).await {
            Ok(0) | Err(_) => {
                hangups.fetch_add(1, Ordering::SeqCst);
                return;
            }
            Ok(n) => n,
        };
        dec.push(&buf[..n]);
        while let Ok(Some(f)) = dec.next_frame() {
            frames.lock().await.push(f.payload.clone());
            let mut out = frame::encode(Kind::Json, br#"{"type":"started"}"#).unwrap();
            out.extend(frame::encode(f.kind, &f.payload).unwrap());
            let _ = s.write_all(&out).await;
        }
    }
}

async fn start_server(state: Arc<State>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap().to_string();
    tokio::spawn(serve(listener, state));
    addr
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(addr: &str, route: &str) -> Ws {
    tokio_tungstenite::connect_async(format!("ws://{addr}{route}")).await.unwrap().0
}

async fn bind(ws: &mut Ws, token: &str, protocol_version: u32, gateway_version: u32) -> GatewayMessage {
    let msg = ClientMessage::Bind { binding: token.into(), protocol_version, gateway_version };
    ws.send(Message::text(serde_json::to_string(&msg).unwrap())).await.unwrap();
    loop {
        match ws.next().await.unwrap().unwrap() {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            // The WebSocket layer's own pong to a ping we sent.
            Message::Pong(_) | Message::Ping(_) => continue,
            other => panic!("expected a text reply, got {other:?}"),
        }
    }
}

async fn refusal(ws: &mut Ws, token: &str, pv: u32, gv: u32) -> (String, bool, Option<u64>) {
    match bind(ws, token, pv, gv).await {
        GatewayMessage::Error { error, executed, retry_after_ms } => {
            assert!(!executed);
            (error.code, error.retryable, retry_after_ms)
        }
        GatewayMessage::Bound { .. } => panic!("expected a refusal"),
    }
}

/// Drains until the server's close frame; its code, or `None` if the stream ended without one.
async fn close_code(ws: &mut Ws) -> Option<u16> {
    loop {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("close within 5 s") {
            Some(Ok(Message::Close(f))) => return f.map(|f| u16::from(f.code)),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return None,
        }
    }
}

fn hands_request(agent: &str, epoch: u64, version: u32) -> Vec<u8> {
    let json = serde_json::json!({
        "protocol_version": version, "call_id": "c1", "agent_id": agent, "epoch": epoch,
        "op": {"tool": "Bash", "command": "echo hi"}
    });
    frame::encode(Kind::Json, json.to_string().as_bytes()).unwrap()
}

fn ready_state(signer: &Signer, guest: &FakeGuest) -> Arc<State> {
    let state = State::new();
    state.set_key(&signer.kid(), &signer.public_key());
    state.upsert_sandbox(sbx(), Epoch(4), guest.path.clone(), clients(&[AGENT]), Some(guest_v1()));
    state
}

// --- the cross-language oracle ---------------------------------------------------------------

#[test]
fn signed_fixture_verifies_with_ring_and_tampered_copies_do_not() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/gateway/binding_token/signed.json");
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let pub_key = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(f["public_key"].as_str().unwrap()).unwrap();
    let token = f["token"].as_str().unwrap();
    assert_eq!(kid_of(&pub_key), f["kid"].as_str().unwrap(), "kid is the first 16 hex chars of SHA-256(point)");
    let claims = nest_gateway::verify::verify_with_key(&pub_key, token).expect("the control plane's signature verifies here");
    assert_eq!(serde_json::to_value(&claims).unwrap(), f["claims"]);
    // A flipped signature byte.
    let dot = token.rfind('.').unwrap();
    let sig = &token[dot + 1..];
    let flipped = format!("{}{}{}", &token[..dot + 1], if sig.starts_with('A') { "B" } else { "A" }, &sig[1..]);
    assert!(nest_gateway::verify::verify_with_key(&pub_key, &flipped).is_none());
    // The same claims, re-encoded by another signer: the fixture key must refuse it.
    let other = Signer::generate().sign(&claims);
    assert!(nest_gateway::verify::verify_with_key(&pub_key, &other).is_none());
    // A claims segment the signature does not cover.
    let mut bumped = claims.clone();
    bumped.epoch = Epoch(5);
    let claims_b64 =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&bumped).unwrap());
    let forged = format!("nbd_{claims_b64}.{sig}");
    assert!(nest_gateway::verify::verify_with_key(&pub_key, &forged).is_none());
}

// --- the happy path --------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn bind_pipes_frames_both_ways_and_a_close_hangs_up_the_guest() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    let mut ws = connect(&addr, "/hands").await;
    match bind(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await {
        GatewayMessage::Bound { guest: g, gateway_version } => {
            assert_eq!(g, guest_v1());
            assert_eq!(gateway_version, PROTOCOL_VERSION);
        }
        other => panic!("{other:?}"),
    }
    let req = hands_request(AGENT, 4, 1);
    ws.send(Message::binary(req.clone())).await.unwrap();
    // The guest's two frames arrive as two separate messages, each one whole frame.
    let m1 = ws.next().await.unwrap().unwrap().into_data();
    let m2 = ws.next().await.unwrap().unwrap().into_data();
    assert_eq!(&m1[..], &frame::encode(Kind::Json, br#"{"type":"started"}"#).unwrap()[..]);
    assert_eq!(&m2[..], &req[..], "the echo is the request frame, re-framed as one message");
    assert_eq!(guest.frames().await.len(), 1);
    assert_eq!(state.open_connections(), 1);
    ws.close(None).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while guest.hangups.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("closing the WebSocket hangs up the guest");
    tokio::time::timeout(Duration::from_secs(5), async {
        while state.open_connections() != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the connection unregisters");
}

// --- refusals, in precedence order -------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn unknown_routes_are_refused_at_the_upgrade() {
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&Signer::generate(), &guest)).await;
    for (route, status) in [("/pty", 501), ("/ingress/3000", 501), ("/", 404), ("/handsx", 404)] {
        match tokio_tungstenite::connect_async(format!("ws://{addr}{route}")).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => assert_eq!(resp.status().as_u16(), status, "{route}"),
            other => panic!("{route}: expected an HTTP refusal, got {:?}", other.map(|_| ())),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_message_that_is_not_a_bind_is_bad_request() {
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&Signer::generate(), &guest)).await;
    let mut ws = connect(&addr, "/hands").await;
    ws.send(Message::binary(hands_request(AGENT, 4, 1))).await.unwrap();
    match ws.next().await.unwrap().unwrap() {
        Message::Text(t) => match serde_json::from_str::<GatewayMessage>(&t).unwrap() {
            GatewayMessage::Error { error, .. } => assert_eq!(error.code, error_code::BAD_REQUEST),
            other => panic!("{other:?}"),
        },
        other => panic!("{other:?}"),
    }
    assert!(guest.frames().await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn no_bind_within_the_timeout_is_bad_request() {
    // Outlasts `server::BIND_TIMEOUT` (5 s) with margin.
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&Signer::generate(), &guest)).await;
    let mut ws = connect(&addr, "/hands").await;
    let msg = tokio::time::timeout(Duration::from_secs(8), ws.next()).await.expect("refused before 8 s").unwrap().unwrap();
    let Message::Text(t) = msg else { panic!("{msg:?}") };
    let GatewayMessage::Error { error, .. } = serde_json::from_str(&t).unwrap() else { panic!() };
    assert_eq!(error.code, error_code::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn token_refusals_follow_the_documented_precedence() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    // Gateway version first, before the token is even looked at.
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, "not-a-token", 1, 0).await.0, error_code::UNSUPPORTED_VERSION);
    // Then the claims format version.
    let mut c = claims(&signer);
    c.v = 2;
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await.0, error_code::UNSUPPORTED_VERSION);
    // Unknown kid, before any signature check.
    let other = Signer::generate();
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, _) = refusal(&mut ws, &other.sign(&claims(&other)), 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable), (error_code::UNKNOWN_KEY, false));
    // A known kid with another key's signature: unauthorized (never which check failed).
    let mut c = claims(&other);
    c.kid = signer.kid();
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &other.sign(&c), 1, PROTOCOL_VERSION).await.0, error_code::UNAUTHORIZED);
    // Expired.
    let mut c = claims(&signer);
    c.exp_ms = now_ms() - 1;
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await.0, error_code::UNAUTHORIZED);
    // Wrong scope.
    let mut c = claims(&signer);
    c.scope = BindingScope::Pty;
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await.0, error_code::UNAUTHORIZED);
    assert!(guest.frames().await.is_empty(), "no refusal reached the guest");
}

#[tokio::test(flavor = "multi_thread")]
async fn placement_refusals_distinguish_moved_busy_and_stale() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    // Unknown sandbox: busy during a resync, moved after it.
    let mut c = claims(&signer);
    c.sandbox = SandboxId("sbx_0000000000".into());
    let elsewhere = signer.sign(&c);
    state.begin_resync();
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, after) = refusal(&mut ws, &elsewhere, 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable, after), (error_code::BUSY, true, Some(500)));
    state.end_resync();
    // end_resync dropped the entry that was not re-sent; put it back.
    state.upsert_sandbox(sbx(), Epoch(4), guest.path.clone(), clients(&[AGENT]), Some(guest_v1()));
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, _) = refusal(&mut ws, &elsewhere, 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable), (error_code::MOVED, false));
    // Older epoch: stale, not retryable, and the message does not leak the current epoch.
    let mut c = claims(&signer);
    c.epoch = Epoch(3);
    let mut ws = connect(&addr, "/hands").await;
    let GatewayMessage::Error { error, .. } = bind(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await else { panic!() };
    assert_eq!((error.code.as_str(), error.retryable), (error_code::STALE_EPOCH, false));
    assert!(!error.message.contains('4'), "{}", error.message);
    // Newer epoch: busy.
    c.epoch = Epoch(5);
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, _) = refusal(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable), (error_code::BUSY, true));
    assert!(guest.frames().await.is_empty(), "no refusal reached the guest");
}

#[tokio::test(flavor = "multi_thread")]
async fn attachment_guest_and_version_refusals() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    let good = signer.sign(&claims(&signer));
    // Client not attached.
    let mut c = claims(&signer);
    c.client = "agt_other".into();
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&c), 1, PROTOCOL_VERSION).await.0, error_code::UNAUTHORIZED);
    // Guest not configured yet: busy.
    state.upsert_sandbox(sbx(), Epoch(4), guest.path.clone(), clients(&[AGENT]), None);
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, after) = refusal(&mut ws, &good, 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable, after), (error_code::BUSY, true, Some(500)));
    state.upsert_sandbox(sbx(), Epoch(4), guest.path.clone(), clients(&[AGENT]), Some(guest_v1()));
    // A client speaking another guest version than the guest's.
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &good, 2, PROTOCOL_VERSION).await.0, error_code::UNSUPPORTED_VERSION);
    // A guest that cannot be reached: busy, retryable.
    state.upsert_sandbox(sbx(), Epoch(4), PathBuf::from("/nonexistent/vsock.sock"), clients(&[AGENT]), Some(guest_v1()));
    let mut ws = connect(&addr, "/hands").await;
    let (code, retryable, _) = refusal(&mut ws, &good, 1, PROTOCOL_VERSION).await;
    assert_eq!((code.as_str(), retryable), (error_code::BUSY, true));
    assert!(guest.frames().await.is_empty(), "no refusal reached the guest");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sandbox_that_leaves_during_the_guest_connect_is_refused_and_the_guest_untouched() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    guest.ok_delay_ms.store(600, Ordering::SeqCst);
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    let token = signer.sign(&claims(&signer));
    let mut ws = connect(&addr, "/hands").await;
    let msg = ClientMessage::Bind { binding: token, protocol_version: 1, gateway_version: PROTOCOL_VERSION };
    ws.send(Message::text(serde_json::to_string(&msg).unwrap())).await.unwrap();
    // The bind check passed and the vsock connect is waiting on the delayed OK; now the
    // sandbox leaves.
    tokio::time::sleep(Duration::from_millis(150)).await;
    state.remove_sandbox(&sbx());
    match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.unwrap().unwrap().unwrap() {
        Message::Text(t) => match serde_json::from_str::<GatewayMessage>(&t).unwrap() {
            GatewayMessage::Error { error, .. } => assert_eq!(error.code, error_code::MOVED),
            GatewayMessage::Bound { .. } => panic!("bound a sandbox that had left"),
        },
        Message::Close(f) => assert_eq!(f.map(|f| u16::from(f.code)), Some(close_code::MOVED)),
        other => panic!("{other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(guest.frames().await.is_empty());
    assert_eq!(state.open_connections(), 0, "a refused connection holds no registration");
}

#[tokio::test(flavor = "multi_thread")]
async fn pings_before_bind_are_tolerated() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = connect(&addr, "/hands").await;
    ws.send(Message::Ping(vec![1, 2, 3].into())).await.unwrap();
    ws.send(Message::Pong(vec![].into())).await.unwrap();
    assert!(matches!(bind(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await, GatewayMessage::Bound { .. }));
}

// --- framing after bound -----------------------------------------------------------------------

async fn bound_ws(addr: &str, signer: &Signer) -> Ws {
    let mut ws = connect(addr, "/hands").await;
    assert!(matches!(bind(&mut ws, &signer.sign(&claims(signer)), 1, PROTOCOL_VERSION).await, GatewayMessage::Bound { .. }));
    ws
}

#[tokio::test(flavor = "multi_thread")]
async fn two_frames_in_one_message_close_4400_before_the_guest_sees_either() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = bound_ws(&addr, &signer).await;
    // A valid first frame, so the first-frame JSON check is behind us and only the length rule
    // stands between a double frame and the guest.
    ws.send(Message::binary(hands_request(AGENT, 4, 1))).await.unwrap();
    let _started = ws.next().await.unwrap().unwrap();
    let _echo = ws.next().await.unwrap().unwrap();
    let mut two = hands_request(AGENT, 4, 1);
    two.extend(hands_request(AGENT, 4, 1));
    ws.send(Message::binary(two)).await.unwrap();
    assert_eq!(close_code(&mut ws).await, Some(close_code::PROTOCOL));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(guest.frames().await.len(), 1, "neither smuggled frame reached the guest");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_frame_for_another_agent_closes_4401_and_the_guest_gets_nothing() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    for (agent, epoch, version) in [("agt_other", 4, 1), (AGENT, 3, 1), (AGENT, 4, 2)] {
        let mut ws = bound_ws(&addr, &signer).await;
        ws.send(Message::binary(hands_request(agent, epoch, version))).await.unwrap();
        assert_eq!(close_code(&mut ws).await, Some(close_code::UNAUTHORIZED), "{agent} {epoch} {version}");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(guest.frames().await.is_empty());
    // A frame without those fields (a cancel) is fine as a later frame but the first must be JSON.
    let mut ws = bound_ws(&addr, &signer).await;
    ws.send(Message::binary(frame::encode(Kind::Data, b"raw").unwrap())).await.unwrap();
    assert_eq!(close_code(&mut ws).await, Some(close_code::PROTOCOL));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_first_frame_is_checked_against_the_binding() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = bound_ws(&addr, &signer).await;
    ws.send(Message::binary(hands_request(AGENT, 4, 1))).await.unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    // A cancel-shaped frame without identity fields, then a frame naming another agent: both
    // pass, since the contract pins the check to the first frame.
    ws.send(Message::binary(frame::encode(Kind::Json, br#"{"type":"cancel"}"#).unwrap())).await.unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    ws.send(Message::binary(hands_request("agt_other", 9, 7))).await.unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    let _ = ws.next().await.unwrap().unwrap();
    assert_eq!(guest.frames().await.len(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_epoch_bump_cuts_every_connection_of_the_sandbox() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    let mut a = bound_ws(&addr, &signer).await;
    let mut b = bound_ws(&addr, &signer).await;
    assert_eq!(state.open_connections(), 2);
    state.upsert_sandbox(sbx(), Epoch(5), guest.path.clone(), clients(&[AGENT]), Some(guest_v1()));
    assert_eq!(close_code(&mut a).await, Some(close_code::MOVED));
    assert_eq!(close_code(&mut b).await, Some(close_code::MOVED));
    wait_until("both unregistered", || state.open_connections() == 0).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn shutdown_delivers_4409_to_a_bound_client_before_returning() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let state = ready_state(&signer, &guest);
    let addr = start_server(state.clone()).await;
    let mut ws = bound_ws(&addr, &signer).await;
    let (left, code) = tokio::join!(
        tokio::time::timeout(nest_gateway::server::SHUTDOWN_GRACE + Duration::from_secs(1), nest_gateway::shutdown(&state)),
        close_code(&mut ws),
    );
    assert_eq!(code, Some(close_code::MOVED), "the client sees the documented close, not a reset");
    assert_eq!(left.expect("shutdown returns within its cap"), 0, "every connection task finished before shutdown returned");
    assert_eq!(state.open_connections(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_close_is_answered_with_a_close_frame() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = bound_ws(&addr, &signer).await;
    use tokio_tungstenite::tungstenite::protocol::{CloseFrame, frame::coding::CloseCode};
    ws.close(Some(CloseFrame { code: CloseCode::Normal, reason: "done".into() })).await.unwrap();
    // The initiator gets the peer's close frame back (the same code), then a clean end of the
    // stream; a server that dropped the socket without answering shows up as a reset error.
    match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("ends within 5 s") {
        Some(Ok(Message::Close(f))) => assert_eq!(f.map(|f| u16::from(f.code)), Some(1000)),
        Some(Err(e)) => panic!("no close handshake: {e}"),
        other => panic!("unexpected after close: {other:?}"),
    }
    match tokio::time::timeout(Duration::from_secs(5), ws.next()).await.expect("ends within 5 s") {
        None => {}
        other => panic!("unexpected after the close frame: {other:?}"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_text_frame_after_bound_closes_4400() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = bound_ws(&addr, &signer).await;
    ws.send(Message::text("{\"type\":\"bind\"}")).await.unwrap();
    assert_eq!(close_code(&mut ws).await, Some(close_code::PROTOCOL));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_message_over_the_frame_limit_ends_the_connection_before_the_guest_sees_it() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let addr = start_server(ready_state(&signer, &guest)).await;
    let mut ws = bound_ws(&addr, &signer).await;
    let mut big = vec![0u8; MAX_FRAME_LEN as usize + 1 + 4];
    big[..4].copy_from_slice(&(MAX_FRAME_LEN + 1).to_be_bytes());
    // The send may itself fail once the server drops the socket; either way nothing comes back
    // but a close or an error.
    let _ = ws.send(Message::binary(big)).await;
    let code = close_code(&mut ws).await;
    assert!(code.is_none() || code == Some(1009), "got {code:?}");
    assert!(guest.frames().await.is_empty());
}

// --- the nestd link ----------------------------------------------------------------------------

async fn write_cmd(s: &mut UnixStream, cmd: &GatewayCommand) {
    nest_gateway::link::write(s, cmd).await.unwrap();
}

async fn read_event(s: &mut UnixStream) -> GatewayEvent {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).await.unwrap();
    let mut body = vec![0u8; u32::from_be_bytes(len) as usize];
    s.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn key_of(signer: &Signer) -> BindingKey {
    BindingKey { kid: signer.kid(), public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(signer.public_key()) }
}

fn upsert(guest: &FakeGuest, with_guest: bool) -> GatewayCommand {
    GatewayCommand::SandboxUpsert {
        sandbox: sbx(),
        epoch: Epoch(4),
        vsock_uds_path: guest.path.to_string_lossy().into_owned(),
        clients: vec![AGENT.into()],
        guest: with_guest.then(guest_v1),
        paused: None,
    }
}

async fn wait_until(what: &str, f: impl Fn() -> bool) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

#[tokio::test(flavor = "multi_thread")]
async fn the_link_resyncs_on_hello_drops_what_nestd_did_not_resend_and_answers_pings() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("gateway.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let state = State::new();
    tokio::spawn(nest_gateway::link(sock.clone(), "127.0.0.1:0".into(), state.clone()));
    let (mut s, _) = listener.accept().await.unwrap();
    let GatewayEvent::Hello { protocol_version, listen, .. } = read_event(&mut s).await else { panic!("expected hello") };
    assert_eq!((protocol_version, listen.as_str()), (nest_protocol::host::PROTOCOL_VERSION, "127.0.0.1:0"));
    write_cmd(&mut s, &GatewayCommand::HelloAck { protocol_version: nest_protocol::host::PROTOCOL_VERSION, host_id: nest_protocol::model::HostId("hst_1".into()) }).await;
    wait_until("resync begins", || state.resyncing()).await;
    write_cmd(&mut s, &GatewayCommand::KeyUpdate { keys: vec![key_of(&signer)] }).await;
    write_cmd(&mut s, &upsert(&guest, true)).await;
    // A second sandbox that the next resync will not re-send.
    write_cmd(&mut s, &GatewayCommand::SandboxUpsert { sandbox: SandboxId("sbx_second".into()), epoch: Epoch(1), vsock_uds_path: "/x".into(), clients: vec![], guest: None, paused: None }).await;
    write_cmd(&mut s, &GatewayCommand::ResyncDone).await;
    wait_until("resync done", || !state.resyncing() && state.sandbox_count() == 2).await;
    assert_eq!(state.key(&signer.kid()), Some(signer.public_key()));
    write_cmd(&mut s, &GatewayCommand::Ping).await;
    assert!(matches!(read_event(&mut s).await, GatewayEvent::Pong));
    // Undecodable command: an error event, the link stays up.
    let bad = b"{\"type\":\"no_such_command\"}";
    s.write_all(&(bad.len() as u32).to_be_bytes()).await.unwrap();
    s.write_all(bad).await.unwrap();
    match read_event(&mut s).await {
        GatewayEvent::Error { error } => assert_eq!(error.code, "invalid_message"),
        other => panic!("{other:?}"),
    }
    write_cmd(&mut s, &GatewayCommand::Ping).await;
    assert!(matches!(read_event(&mut s).await, GatewayEvent::Pong));

    // Lose nestd: the state empties and the next bind is refused as moved; after the reconnect
    // and a resync that omits the second sandbox, only the first remains.
    let addr = start_server(state.clone()).await;
    let mut ws = bound_ws(&addr, &signer).await;
    drop(s);
    assert_eq!(close_code(&mut ws).await, Some(close_code::MOVED), "losing nestd cuts open connections");
    wait_until("sandboxes cleared", || state.sandbox_count() == 0).await;
    assert_eq!(state.key(&signer.kid()), Some(signer.public_key()), "keys survive a link loss");
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await.0, error_code::MOVED, "after a link loss a bind is moved, not unknown_key");
    // A hello_ack with another host protocol version ends the session; the keys stay.
    let (mut s, _) = listener.accept().await.unwrap();
    let GatewayEvent::Hello { instance_id: id2, .. } = read_event(&mut s).await else { panic!("expected hello") };
    write_cmd(&mut s, &GatewayCommand::HelloAck { protocol_version: 99, host_id: nest_protocol::model::HostId("hst_1".into()) }).await;
    let (mut s, _) = listener.accept().await.unwrap();
    let GatewayEvent::Hello { instance_id: id3, .. } = read_event(&mut s).await else { panic!("expected hello") };
    assert_eq!(id2, id3, "one instance id per process");
    assert_eq!(state.key(&signer.kid()), Some(signer.public_key()));
    write_cmd(&mut s, &GatewayCommand::HelloAck { protocol_version: nest_protocol::host::PROTOCOL_VERSION, host_id: nest_protocol::model::HostId("hst_1".into()) }).await;
    // key_update: a 64-byte point is ignored, a duplicate kid keeps one entry, an empty list
    // removes every key.
    let short = BindingKey { kid: "0123456789abcdef".into(), public_key: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([4u8; 64]) };
    write_cmd(&mut s, &GatewayCommand::KeyUpdate { keys: vec![key_of(&signer), short, key_of(&signer)] }).await;
    wait_until("keys replaced", || state.key_count() == 1 && state.key("0123456789abcdef").is_none()).await;
    write_cmd(&mut s, &GatewayCommand::KeyUpdate { keys: vec![] }).await;
    wait_until("keys emptied", || state.key_count() == 0).await;
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await.0, error_code::UNKNOWN_KEY);
    write_cmd(&mut s, &GatewayCommand::KeyUpdate { keys: vec![key_of(&signer)] }).await;
    wait_until("key back", || state.key(&signer.kid()).is_some()).await;
    // Before resync_done an unknown sandbox is busy, not moved.
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await.0, error_code::BUSY);
    write_cmd(&mut s, &upsert(&guest, true)).await;
    write_cmd(&mut s, &GatewayCommand::ResyncDone).await;
    wait_until("resync done again", || !state.resyncing()).await;
    assert_eq!(state.sandbox_count(), 1, "the sandbox nestd did not re-send is gone");
    let mut ws = bound_ws(&addr, &signer).await;
    // An epoch bump from nestd cuts the open connection and refuses the old binding as stale.
    write_cmd(&mut s, &GatewayCommand::SandboxUpsert { sandbox: sbx(), epoch: Epoch(5), vsock_uds_path: guest.path.to_string_lossy().into_owned(), clients: vec![AGENT.into()], guest: Some(guest_v1()), paused: None }).await;
    assert_eq!(close_code(&mut ws).await, Some(close_code::MOVED));
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await.0, error_code::STALE_EPOCH);
    // sandbox_remove: moved.
    write_cmd(&mut s, &GatewayCommand::SandboxRemove { sandbox: sbx() }).await;
    wait_until("removed", || state.sandbox_count() == 0).await;
    let mut ws = connect(&addr, "/hands").await;
    assert_eq!(refusal(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await.0, error_code::MOVED);
}

/// The incident of 2026-11-02: while nestd had the VM paused for a checkpoint's commit, a bind
/// waited out the whole vsock timeout. Now nestd's `sandbox_upsert` carries the pause and the
/// gateway refuses at once with `busy` and the pause hint, naming the reason; a call bound before
/// the pause is not cut; once nestd sends the upsert without it, binds are admitted again.
#[tokio::test(flavor = "multi_thread")]
async fn a_paused_sandbox_is_busy_at_once_with_the_pause_hint_and_bound_calls_survive_it() {
    let signer = Signer::generate();
    let guest = FakeGuest::start().await;
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("gateway.sock");
    let listener = UnixListener::bind(&sock).unwrap();
    let state = State::new();
    tokio::spawn(nest_gateway::link(sock.clone(), "127.0.0.1:0".into(), state.clone()));
    let (mut s, _) = listener.accept().await.unwrap();
    let GatewayEvent::Hello { .. } = read_event(&mut s).await else { panic!("expected hello") };
    write_cmd(&mut s, &GatewayCommand::HelloAck { protocol_version: nest_protocol::host::PROTOCOL_VERSION, host_id: nest_protocol::model::HostId("hst_1".into()) }).await;
    write_cmd(&mut s, &GatewayCommand::KeyUpdate { keys: vec![key_of(&signer)] }).await;
    write_cmd(&mut s, &upsert(&guest, true)).await;
    write_cmd(&mut s, &GatewayCommand::ResyncDone).await;
    wait_until("resync done", || !state.resyncing() && state.sandbox_count() == 1).await;
    let addr = start_server(state.clone()).await;
    let mut bound = bound_ws(&addr, &signer).await;

    // The VM is frozen: its vsock would answer `CONNECT` only after the gateway's own timeout.
    guest.ok_delay_ms.store(30_000, Ordering::SeqCst);
    let paused = |p: bool| {
        let GatewayCommand::SandboxUpsert { sandbox, epoch, vsock_uds_path, clients, guest, .. } = upsert(&guest, true) else { unreachable!() };
        let paused = p.then(|| SandboxPause { reason: "checkpoint (turn_end)".into() });
        GatewayCommand::SandboxUpsert { sandbox, epoch, vsock_uds_path, clients, guest, paused }
    };
    write_cmd(&mut s, &paused(true)).await;
    wait_until("pause applied", || state.sandbox(&sbx()).is_some_and(|e| e.paused.is_some())).await;
    let started = std::time::Instant::now();
    let mut ws = connect(&addr, "/hands").await;
    let GatewayMessage::Error { error, executed, retry_after_ms } = bind(&mut ws, &signer.sign(&claims(&signer)), 1, PROTOCOL_VERSION).await else {
        panic!("bound a paused sandbox")
    };
    // Well under the gateway's 5 s vsock timeout: no connect was tried.
    assert!(started.elapsed() < Duration::from_secs(2), "refused after {:?}", started.elapsed());
    assert_eq!((error.code.as_str(), error.retryable, executed), (error_code::BUSY, true, false));
    assert_eq!(retry_after_ms, Some(nest_protocol::gateway::PAUSED_RETRY_AFTER_MS));
    assert!(error.message.contains("checkpoint (turn_end)"), "{}", error.message);

    // The call bound before the pause is still open and still pipes frames.
    bound.send(Message::binary(hands_request(AGENT, 4, 1))).await.unwrap();
    let m = tokio::time::timeout(Duration::from_secs(5), bound.next()).await.expect("a frame in time").unwrap().unwrap();
    assert!(matches!(m, Message::Binary(_)), "{m:?}");

    // Running again: the next bind is admitted.
    guest.ok_delay_ms.store(0, Ordering::SeqCst);
    write_cmd(&mut s, &paused(false)).await;
    wait_until("pause lifted", || state.sandbox(&sbx()).is_some_and(|e| e.paused.is_none())).await;
    let _ws = bound_ws(&addr, &signer).await;
}
