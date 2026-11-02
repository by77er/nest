//! The client against an in-test gateway (tokio-tungstenite's server side; no nest-gateway).
//! The gateway's `bound` and `error` messages are sent as the raw text of the fixtures under
//! `protocol/fixtures/gateway/gateway_message/`, so the fixtures are the oracle for what the
//! client must parse; the frames the client sends are checked against `nest_protocol::guest::frame`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nest_hands_client::{
    BUSY_RETRY, EDGE_CLIENT_ID_HEADER, EDGE_CLIENT_SECRET_HEADER, Next, OpenError, OpenOptions,
    Phase, REFRESH_MARGIN, RecvError, Refusal, RefusalCode, TransportError, binding_exp_ms,
    guest_error_next, open, refresh_due,
};
use nest_protocol::model::ErrorBody;
use nest_protocol::gateway::{
    ClientMessage, EdgeAuth, GuestInfo, HandsTarget, PROTOCOL_VERSION, close_code,
};
use nest_protocol::guest::frame::{self, MAX_FRAME_LEN};
use nest_protocol::model::Secret;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::Request;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::Frame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::{CloseCode, Data, OpCode};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures/gateway/gateway_message")
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(fixtures().join(name)).unwrap()
}

/// What the gateway does after it has read `bind`.
#[derive(Clone)]
enum Mode {
    /// Send the `bound.json` fixture, then echo every binary message back.
    Echo,
    /// Send a `Ping` before `bound.json`, then echo, with a `Ping` before every echo.
    EchoWithPings,
    /// Send the named `error.*.json` fixture and close.
    Refuse(&'static str),
    /// Answer nothing.
    Silent,
    /// Close with a normal code before answering.
    CloseBeforeBound,
    /// Send a binary message before `bound`.
    BinaryBeforeBound,
    /// Send `bound` with the given gateway version.
    BoundVersion(u32),
    /// `bound`, then answer the first binary message with the given raw bytes as one message.
    RawReply(Vec<u8>),
    /// `bound`, then answer the first binary message with one JSON frame split in two WebSocket fragments.
    Fragmented,
    /// `bound`, then answer the first binary message with a text message.
    TextAfterBound,
    /// `bound`, then on the first binary message close with the given code.
    CloseWith(u16),
    /// `bound`, then on the first binary message drop the TCP socket without a close handshake.
    Reset,
    /// `bound`, then echo the first binary message after a delay (for the cancel-safety test).
    DelayedEcho(Duration),
}

struct Seen {
    headers: Vec<(String, String)>,
    bind: ClientMessage,
}

struct Gateway {
    url: String,
    seen: mpsc::UnboundedReceiver<Seen>,
    closes: mpsc::UnboundedReceiver<Option<u16>>,
    pongs: Arc<Mutex<usize>>,
}

async fn gateway(mode: Mode) -> Gateway {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (seen_tx, seen) = mpsc::unbounded_channel();
    let (close_tx, closes) = mpsc::unbounded_channel();
    let pongs = Arc::new(Mutex::new(0usize));
    let pongs_srv = pongs.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let mode = mode.clone();
            let seen_tx = seen_tx.clone();
            let close_tx = close_tx.clone();
            let pongs = pongs_srv.clone();
            tokio::spawn(async move {
                let headers = Arc::new(Mutex::new(Vec::new()));
                let h = headers.clone();
                #[allow(clippy::result_large_err)]
                // the callback's error type is tungstenite's ErrorResponse
                let on_request = move |req: &Request, resp| {
                    assert_eq!(req.uri().path(), "/hands", "route");
                    let mut v = h.lock().unwrap();
                    for (k, val) in req.headers() {
                        v.push((
                            k.as_str().to_string(),
                            val.to_str().unwrap_or("<binary>").to_string(),
                        ));
                    }
                    Ok(resp)
                };
                let mut ws = tokio_tungstenite::accept_hdr_async(stream, on_request)
                    .await
                    .unwrap();
                let bind = match ws.next().await {
                    Some(Ok(Message::Text(t))) => {
                        serde_json::from_str::<ClientMessage>(&t).unwrap()
                    }
                    other => panic!("first message must be a text bind, got {other:?}"),
                };
                let _ = seen_tx.send(Seen {
                    headers: headers.lock().unwrap().clone(),
                    bind,
                });
                match mode {
                    Mode::Silent => {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        return;
                    }
                    Mode::CloseBeforeBound => {
                        let _ = ws
                            .close(Some(CloseFrame {
                                code: CloseCode::Normal,
                                reason: "bye".into(),
                            }))
                            .await;
                        return;
                    }
                    Mode::BinaryBeforeBound => {
                        ws.send(Message::Binary(
                            frame::encode_json(&serde_json::json!({})).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                        return;
                    }
                    Mode::Refuse(name) => {
                        ws.send(Message::text(fixture(name))).await.unwrap();
                        let _ = ws.close(None).await;
                        return;
                    }
                    Mode::BoundVersion(v) => {
                        let text = fixture("bound.json").replace(
                            "\"gateway_version\": 1",
                            &format!("\"gateway_version\": {v}"),
                        );
                        assert!(text.contains(&format!("\"gateway_version\": {v}")));
                        ws.send(Message::text(text)).await.unwrap();
                    }
                    Mode::EchoWithPings => {
                        ws.send(Message::Ping("before-bound".into())).await.unwrap();
                        ws.send(Message::text(fixture("bound.json"))).await.unwrap();
                    }
                    _ => ws.send(Message::text(fixture("bound.json"))).await.unwrap(),
                }
                while let Some(msg) = ws.next().await {
                    match msg {
                        Ok(Message::Binary(b)) => match mode {
                            Mode::Echo | Mode::BoundVersion(_) => {
                                ws.send(Message::Binary(b)).await.unwrap()
                            }
                            Mode::EchoWithPings => {
                                ws.send(Message::Ping("between".into())).await.unwrap();
                                ws.send(Message::Binary(b)).await.unwrap();
                            }
                            Mode::DelayedEcho(d) => {
                                tokio::time::sleep(d).await;
                                ws.send(Message::Binary(b)).await.unwrap();
                            }
                            Mode::RawReply(ref bytes) => ws
                                .send(Message::Binary(bytes.clone().into()))
                                .await
                                .unwrap(),
                            Mode::Fragmented => {
                                let whole = frame::encode_json(
                                    &serde_json::json!({"whole": true, "pad": "x".repeat(64)}),
                                )
                                .unwrap();
                                let (a, z) = whole.split_at(whole.len() / 2);
                                ws.send(Message::Frame(Frame::message(
                                    a.to_vec(),
                                    OpCode::Data(Data::Binary),
                                    false,
                                )))
                                .await
                                .unwrap();
                                ws.send(Message::Frame(Frame::message(
                                    z.to_vec(),
                                    OpCode::Data(Data::Continue),
                                    true,
                                )))
                                .await
                                .unwrap();
                            }
                            Mode::TextAfterBound => ws
                                .send(Message::text("{\"type\":\"bound\"}"))
                                .await
                                .unwrap(),
                            Mode::CloseWith(code) => {
                                let _ = ws
                                    .close(Some(CloseFrame {
                                        code: CloseCode::from(code),
                                        reason: "sandbox left this host".into(),
                                    }))
                                    .await;
                            }
                            Mode::Reset => {
                                // Drop the socket: no close frame, so the peer sees EOF with no handshake.
                                drop(ws.into_inner());
                                return;
                            }
                            _ => unreachable!(),
                        },
                        Ok(Message::Pong(_)) => *pongs.lock().unwrap() += 1,
                        Ok(Message::Close(cf)) => {
                            let _ = close_tx.send(cf.map(|c| u16::from(c.code)));
                            return;
                        }
                        Ok(_) => {}
                        Err(_) => {
                            let _ = close_tx.send(None);
                            return;
                        }
                    }
                }
                let _ = close_tx.send(None);
            });
        }
    });
    Gateway {
        url,
        seen,
        closes,
        pongs,
    }
}

fn target(url: &str, edge: Option<EdgeAuth>) -> HandsTarget {
    HandsTarget {
        url: url.to_string(),
        sandbox: None,
        epoch: None,
        binding: Secret("nbd_eyJ2IjoxfQ.c2ln".into()),
        guest: GuestInfo {
            protocol_version: 1,
            capabilities: vec!["pty".into()],
        },
        edge,
    }
}

fn opts() -> OpenOptions {
    OpenOptions {
        connect_timeout: Duration::from_secs(5),
        bind_timeout: Duration::from_millis(800),
    }
}

fn bound_fixture_guest() -> GuestInfo {
    let v: serde_json::Value = serde_json::from_str(&fixture("bound.json")).unwrap();
    serde_json::from_value(v["guest"].clone()).unwrap()
}

#[tokio::test]
async fn bind_carries_the_binding_and_versions_and_bound_fills_guest_from_the_fixture() {
    let mut gw = gateway(Mode::Echo).await;
    let t = target(&gw.url, None);
    let conn = open(&t, &opts()).await.unwrap();
    assert_eq!(
        conn.guest(),
        &bound_fixture_guest(),
        "guest is what bound.json says, not what the target said"
    );
    assert_eq!(conn.gateway_version(), PROTOCOL_VERSION);
    let seen = gw.seen.recv().await.unwrap();
    assert_eq!(
        seen.bind,
        ClientMessage::Bind {
            binding: t.binding.expose().to_string(),
            protocol_version: 1,
            gateway_version: PROTOCOL_VERSION
        }
    );
    assert!(
        !seen
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(EDGE_CLIENT_ID_HEADER)),
        "no edge headers without edge"
    );
    assert!(
        !seen
            .headers
            .iter()
            .any(|(k, _)| k.eq_ignore_ascii_case(EDGE_CLIENT_SECRET_HEADER))
    );
}

#[tokio::test]
async fn edge_credentials_travel_as_upgrade_headers_to_loopback_only() {
    let mut gw = gateway(Mode::Echo).await;
    let edge = EdgeAuth {
        client_id: "9c1f.access".into(),
        client_secret: Secret("s3cret-value".into()),
    };
    let _conn = open(&target(&gw.url, Some(edge.clone())), &opts())
        .await
        .unwrap();
    let seen = gw.seen.recv().await.unwrap();
    let get = |name: &str| {
        seen.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    };
    assert_eq!(get(EDGE_CLIENT_ID_HEADER).as_deref(), Some("9c1f.access"));
    assert_eq!(
        get(EDGE_CLIENT_SECRET_HEADER).as_deref(),
        Some("s3cret-value")
    );
    // Cleartext to a non-loopback host would leak the secret: refused before any connect.
    let r = open(
        &target("ws://gateway.example.test:18790", Some(edge)),
        &opts(),
    )
    .await;
    assert!(
        matches!(&r, Err(OpenError::Transport(TransportError::Url(m))) if m.contains("cleartext")),
        "{r:?}"
    );
}

#[tokio::test]
async fn each_refusal_fixture_maps_to_refused_with_its_fields() {
    let cases = [
        (
            "error.stale_epoch.json",
            RefusalCode::StaleEpoch,
            Next::Resolve,
        ),
        (
            "error.busy.json",
            RefusalCode::Busy,
            Next::RetrySame {
                after: Duration::from_millis(500),
            },
        ),
        // An expired or revoked binding: a fresh one may cure it.
        ("error.json", RefusalCode::Unauthorized, Next::Resolve),
        (
            "error.unknown_key.json",
            RefusalCode::UnknownKey,
            Next::Resolve,
        ),
    ];
    for (name, code, next) in cases {
        let expected: serde_json::Value = serde_json::from_str(&fixture(name)).unwrap();
        let gw = gateway(Mode::Refuse(name)).await;
        match open(&target(&gw.url, None), &opts()).await {
            Err(OpenError::Refused(r)) => {
                assert_eq!(r.code, code, "{name}");
                assert_eq!(r.code.as_str(), expected["error"]["code"].as_str().unwrap());
                assert_eq!(r.message, expected["error"]["message"].as_str().unwrap());
                assert_eq!(
                    r.retryable,
                    expected["error"]["retryable"].as_bool().unwrap()
                );
                assert_eq!(r.retry_after_ms, expected["retry_after_ms"].as_u64());
                assert_eq!(r.next(), next, "{name}");
            }
            other => panic!("{name}: expected Refused, got {other:?}"),
        }
    }
    assert_eq!(
        RefusalCode::parse("something_new"),
        RefusalCode::Other("something_new".into())
    );
}

#[test]
fn one_classification_for_every_refusal_and_guest_error() {
    let refusal = |code: RefusalCode, retry_after_ms: Option<u64>| Refusal {
        code,
        message: String::new(),
        retryable: false,
        retry_after_ms,
    };
    // A target minted with a guest version that is no longer the guest's: a fresh target
    // carries the current one.
    assert_eq!(
        refusal(RefusalCode::UnsupportedVersion, None).next(),
        Next::Resolve
    );
    assert_eq!(refusal(RefusalCode::Moved, None).next(), Next::Resolve);
    assert_eq!(refusal(RefusalCode::BadRequest, None).next(), Next::Final);
    assert_eq!(
        refusal(RefusalCode::Other("new".into()), None).next(),
        Next::Final
    );
    // `busy` without a hint waits the one default; the decision is by code, not the flag.
    assert_eq!(
        refusal(RefusalCode::Busy, None).next(),
        Next::RetrySame { after: BUSY_RETRY }
    );
    assert_eq!(
        OpenError::Timeout(Phase::Connect).next(),
        Next::Resolve,
        "a host that never completes the upgrade"
    );
    // The gateway took the bind and nothing reached the guest: a guest frozen past both timers
    // (a VM paused for a checkpoint, behind a gateway that can't tell) is waited out like `busy`.
    assert_eq!(
        OpenError::Timeout(Phase::Bind).next(),
        Next::RetrySame { after: BUSY_RETRY }
    );
    assert_eq!(
        OpenError::Transport(TransportError::Http(404)).next(),
        Next::Final
    );
    assert_eq!(
        OpenError::Transport(TransportError::Http(530)).next(),
        Next::Resolve
    );
    // The guest's own `busy` is retried like the gateway's; its other errors are the answer.
    let guest = |code: &str| ErrorBody {
        code: code.into(),
        message: String::new(),
        retryable: true,
    };
    assert_eq!(
        guest_error_next(&guest("busy")),
        Next::RetrySame { after: BUSY_RETRY }
    );
    assert_eq!(guest_error_next(&guest("stale_epoch")), Next::Final);
    assert_eq!(guest_error_next(&guest("not_found")), Next::Final);
}

#[test]
fn a_target_is_due_for_refresh_shortly_before_its_binding_expires() {
    // The cross-language fixture's token: claims `exp_ms` 1760274000000.
    let signed: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../protocol/fixtures/gateway/binding_token/signed.json"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut t = target("ws://127.0.0.1:1", None);
    t.binding = Secret(signed["token"].as_str().unwrap().into());
    let exp = signed["claims"]["exp_ms"].as_i64().unwrap();
    assert_eq!(binding_exp_ms(&t), Some(exp));
    let margin = REFRESH_MARGIN.as_millis() as i64;
    assert!(!refresh_due(&t, exp - margin - 1));
    assert!(refresh_due(&t, exp - margin));
    assert!(refresh_due(&t, exp + 1));
    // A token that does not parse is the gateway's to refuse, not a reason to resolve.
    t.binding = Secret("nbd_garbage".into());
    assert_eq!(binding_exp_ms(&t), None);
    assert!(!refresh_due(&t, i64::MAX));
}

#[tokio::test]
async fn no_answer_within_bind_timeout_is_a_bind_timeout() {
    let gw = gateway(Mode::Silent).await;
    let started = std::time::Instant::now();
    let r = open(&target(&gw.url, None), &opts()).await;
    assert!(matches!(r, Err(OpenError::Timeout(Phase::Bind))), "{r:?}");
    // bind_timeout is 800 ms and the silent gateway sleeps 30 s, so only the client's timer ends this.
    assert!(started.elapsed() < Duration::from_secs(10));
}

#[tokio::test]
async fn a_close_or_a_binary_before_bound_is_named() {
    let gw = gateway(Mode::CloseBeforeBound).await;
    let r = open(&target(&gw.url, None), &opts()).await;
    assert!(
        matches!(&r, Err(OpenError::Transport(TransportError::ClosedBeforeBound { code: Some(1000), reason })) if reason == "bye"),
        "{r:?}"
    );
    let gw = gateway(Mode::BinaryBeforeBound).await;
    let r = open(&target(&gw.url, None), &opts()).await;
    assert!(
        matches!(&r, Err(OpenError::Protocol(m)) if m.contains("binary")),
        "{r:?}"
    );
}

#[tokio::test]
async fn an_out_of_range_gateway_version_in_bound_is_a_protocol_error() {
    let gw = gateway(Mode::BoundVersion(PROTOCOL_VERSION + 1)).await;
    let r = open(&target(&gw.url, None), &opts()).await;
    assert!(
        matches!(&r, Err(OpenError::Protocol(m)) if m.contains("gateway version")),
        "{r:?}"
    );
    let gw = gateway(Mode::BoundVersion(0)).await;
    let r = open(&target(&gw.url, None), &opts()).await;
    assert!(matches!(&r, Err(OpenError::Protocol(_))), "{r:?}");
}

#[tokio::test]
async fn connect_refused_and_an_unresolvable_hostname_are_unreachable() {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", l.local_addr().unwrap());
    drop(l);
    match open(&target(&url, None), &opts()).await {
        Err(OpenError::Transport(t)) => {
            assert!(t.is_unreachable(), "{t}");
            assert!(
                matches!(&t, TransportError::Io(e) if e.kind() == std::io::ErrorKind::ConnectionRefused),
                "{t}"
            );
        }
        other => panic!("expected Transport, got {other:?}"),
    }
    // `.invalid` never resolves: the record of a dead host, as the runner sees it once FleetDO
    // deleted it. A resolver that stalls instead of failing makes this a connect timeout, which
    // the runner also resolves again on.
    match open(&target("ws://nonexistent.invalid:1", None), &opts()).await {
        Err(OpenError::Transport(t)) => {
            assert!(matches!(&t, TransportError::Dns(_)), "{t}");
            assert!(t.is_unreachable(), "a hostname that does not resolve: {t}");
        }
        Err(OpenError::Timeout(Phase::Connect)) => {}
        other => panic!("expected Transport, got {other:?}"),
    }
    let r = open(&target("http://127.0.0.1:1", None), &opts()).await;
    assert!(
        matches!(&r, Err(OpenError::Transport(TransportError::Url(_)))),
        "{r:?}"
    );
}

/// A plain HTTP server that answers every request with `status` and no upgrade: Cloudflare's
/// edge in front of a hostname with no connector (530, 502, 503), Access refusing the service
/// token (403), or the gateway itself for an unknown route (404).
async fn http_status_server(status: u16) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 1024];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&chunk[..n]),
                    }
                }
                let reply =
                    format!("HTTP/1.1 {status} Edge\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                let _ = stream.write_all(reply.as_bytes()).await;
                let _ = stream.shutdown().await;
            });
        }
    });
    url
}

#[tokio::test]
async fn an_edge_5xx_or_an_access_refusal_is_unreachable_and_a_404_is_not() {
    for status in [530u16, 503, 502, 403, 401] {
        let url = http_status_server(status).await;
        match open(&target(&url, None), &opts()).await {
            Err(OpenError::Transport(t)) => {
                assert!(matches!(&t, TransportError::Http(s) if *s == status), "{status}: {t}");
                assert!(t.is_unreachable(), "{status} from in front of the gateway: {t}");
            }
            other => panic!("{status}: expected Transport(Http), got {other:?}"),
        }
    }
    // Only a 5xx is worth a pause before the next resolve; a refused credential is not.
    assert!(TransportError::Http(530).is_edge_outage());
    assert!(!TransportError::Http(403).is_edge_outage());
    for status in [404u16, 501, 400] {
        let url = http_status_server(status).await;
        match open(&target(&url, None), &opts()).await {
            Err(OpenError::Transport(t)) => {
                assert!(matches!(&t, TransportError::Http(s) if *s == status), "{status}: {t}");
                assert!(!t.is_unreachable(), "{status} is the gateway's own answer: {t}");
                assert!(!t.is_edge_outage());
            }
            other => panic!("{status}: expected Transport(Http), got {other:?}"),
        }
    }
}

#[tokio::test]
async fn wss_to_a_self_signed_server_fails_certificate_verification() {
    // A real TLS server with an untrusted certificate, run by the openssl CLI (nest-proxy is the
    // only crate allowed to build a TLS acceptor). No openssl on the machine fails this test.
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("key.pem");
    let cert = dir.path().join("cert.pem");
    let generated = tokio::process::Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-subj",
            "/CN=localhost",
            "-days",
            "1",
        ])
        .arg("-keyout")
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .output()
        .await
        .expect("openssl CLI is required for this test");
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let port = {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        l.local_addr().unwrap().port()
    };
    let mut server = tokio::process::Command::new("openssl")
        .args([
            "s_server",
            "-accept",
            &format!("127.0.0.1:{port}"),
            "-www",
            "-quiet",
        ])
        .arg("-key")
        .arg(&key)
        .arg("-cert")
        .arg(&cert)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err()
    {
        assert!(
            std::time::Instant::now() < deadline,
            "openssl s_server did not listen"
        );
        assert!(
            server.try_wait().unwrap().is_none(),
            "openssl s_server exited early"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let r = open(&target(&format!("wss://127.0.0.1:{port}"), None), &opts()).await;
    assert!(
        matches!(&r, Err(OpenError::Transport(TransportError::Tls(_)))),
        "{r:?}"
    );
    let _ = server.kill().await;
}

#[tokio::test]
async fn send_and_recv_round_trip_one_json_frame_and_oversize_is_invalid_input() {
    let gw = gateway(Mode::Echo).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    let req = serde_json::json!({"call_id": "hc_1", "agent_id": "agt_01jb7n0w1e", "epoch": 4, "op": {"tool": "Bash", "command": "true"}});
    conn.send_json(&req).await.unwrap();
    let got: Option<serde_json::Value> = conn.recv_json().await.unwrap();
    assert_eq!(got, Some(req));
    let huge = serde_json::json!({"pad": "x".repeat(MAX_FRAME_LEN as usize)});
    let e = conn.send_json(&huge).await.unwrap_err();
    assert_eq!(e.kind(), std::io::ErrorKind::InvalidInput, "{e}");
}

#[tokio::test]
async fn pings_before_bound_and_between_frames_are_answered_and_skipped() {
    let gw = gateway(Mode::EchoWithPings).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    for i in 0..3 {
        conn.send_json(&serde_json::json!({"i": i})).await.unwrap();
        let got: Option<serde_json::Value> = conn.recv_json().await.unwrap();
        assert_eq!(got, Some(serde_json::json!({"i": i})));
    }
    conn.close().await;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while *gw.pongs.lock().unwrap() < 4 {
        assert!(
            std::time::Instant::now() < deadline,
            "pongs seen: {}",
            *gw.pongs.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn a_fragmented_message_reassembles_into_one_frame() {
    let gw = gateway(Mode::Fragmented).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
    let got: Option<serde_json::Value> = conn.recv_json().await.unwrap();
    assert_eq!(got.unwrap()["whole"], true);
}

#[tokio::test]
async fn messages_that_are_not_exactly_one_json_frame_are_protocol_errors() {
    let one = frame::encode_json(&serde_json::json!({"n": 1})).unwrap();
    let two = frame::encode_json(&serde_json::json!({"n": 2})).unwrap();
    let mut too_large = (MAX_FRAME_LEN + 1).to_be_bytes().to_vec();
    too_large.extend_from_slice(&[0x00, b'{', b'}']);
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        (
            "two frames in one message",
            [one.clone(), two].concat(),
            "frame length",
        ),
        ("length over the limit", too_large, "exceeds"),
        ("shorter than a header", vec![0, 0, 0, 1], "not a frame"),
        (
            "unknown kind",
            frame::encode(frame::Kind::Data, b"{}")
                .unwrap()
                .iter()
                .enumerate()
                .map(|(i, b)| if i == 4 { 0x02 } else { *b })
                .collect(),
            "unknown frame kind",
        ),
        (
            "data frame",
            frame::encode(frame::Kind::Data, b"raw").unwrap(),
            "data frame",
        ),
        (
            "length short of the message",
            {
                let mut m = one.clone();
                m.push(b' ');
                m
            },
            "frame length",
        ),
    ];
    for (what, bytes, needle) in cases {
        let gw = gateway(Mode::RawReply(bytes)).await;
        let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
        conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
        match conn.recv_json::<serde_json::Value>().await {
            Err(RecvError::Protocol(m)) => assert!(m.contains(needle), "{what}: {m}"),
            other => panic!("{what}: expected Protocol, got {other:?}"),
        }
    }
    let gw = gateway(Mode::TextAfterBound).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
    assert!(
        matches!(conn.recv_json::<serde_json::Value>().await, Err(RecvError::Protocol(m)) if m.contains("text"))
    );
}

#[tokio::test]
async fn close_codes_surface_as_closed_and_only_a_normal_close_is_none() {
    for code in [
        close_code::MOVED,
        close_code::UNAUTHORIZED,
        close_code::PROTOCOL,
        1001,
    ] {
        let gw = gateway(Mode::CloseWith(code)).await;
        let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
        conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
        match conn.recv_json::<serde_json::Value>().await {
            Err(RecvError::Closed(c)) => {
                assert_eq!(c.code, code);
                assert_eq!(c.reason, "sandbox left this host");
                assert_eq!(c.is_moved(), code == close_code::MOVED);
                assert_eq!(c.is_unauthorized(), code == close_code::UNAUTHORIZED);
            }
            other => panic!("{code}: expected Closed, got {other:?}"),
        }
    }
    let gw = gateway(Mode::CloseWith(1000)).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
    assert!(
        conn.recv_json::<serde_json::Value>()
            .await
            .unwrap()
            .is_none(),
        "a normal close is the end, not an error"
    );
}

#[tokio::test]
async fn a_reset_without_a_close_handshake_is_an_io_error() {
    let gw = gateway(Mode::Reset).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.send_json(&serde_json::json!({"go": 1})).await.unwrap();
    match conn.recv_json::<serde_json::Value>().await {
        Err(RecvError::Io(e)) => assert!(
            matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
            ),
            "{e}"
        ),
        other => panic!("expected Io, got {other:?}"),
    }
}

#[tokio::test]
async fn recv_is_cancel_safe_inside_select() {
    let gw = gateway(Mode::DelayedEcho(Duration::from_millis(150))).await;
    let mut conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.send_json(&serde_json::json!({"late": true}))
        .await
        .unwrap();
    // The timer wins (10 ms) and the recv future is dropped while the echo is in flight.
    let lost = tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(10)) => true,
        _ = conn.recv_json::<serde_json::Value>() => false,
    };
    assert!(
        lost,
        "the timer must win this select for the test to mean anything"
    );
    let got: Option<serde_json::Value> = conn.recv_json().await.unwrap();
    assert_eq!(
        got,
        Some(serde_json::json!({"late": true})),
        "the frame that arrived meanwhile is intact"
    );
}

#[tokio::test]
async fn close_sends_a_close_frame_and_a_drop_hangs_up_without_one() {
    let mut gw = gateway(Mode::Echo).await;
    let conn = open(&target(&gw.url, None), &opts()).await.unwrap();
    conn.close_with_reason("cancel").await;
    let code = tokio::time::timeout(Duration::from_secs(5), gw.closes.recv())
        .await
        .expect("gateway saw the hangup")
        .unwrap();
    assert_eq!(
        code,
        Some(1000),
        "a deliberate cancel closes with the normal code"
    );
    let mut gw2 = gateway(Mode::Echo).await;
    let conn = open(&target(&gw2.url, None), &opts()).await.unwrap();
    drop(conn);
    let seen = tokio::time::timeout(Duration::from_secs(5), gw2.closes.recv())
        .await
        .expect("dropping hangs up too")
        .unwrap();
    assert_eq!(seen, None, "a drop is a hangup with no close frame");
}
