//! Regression tests for the security review of nest-proxy (findings E1–E4 and related fixes).

mod common;

use std::time::Duration;

use hickory_proto::op::{Message, Query, ResponseCode};
use hickory_proto::rr::{Name, RecordType};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};

use common::*;
use nest_protocol::control::EgressVerdict;
use nest_protocol::host::proxy::{AlertKind, DropReason, ProxyCommand, ProxyEvent};
use nest_protocol::model::Epoch;

fn audit_with(ev: &ProxyEvent, f: impl Fn(&nest_protocol::control::EgressAuditRecord) -> bool) -> bool {
    matches!(ev, ProxyEvent::Audit { records } if records.iter().any(&f))
}

/// Read a whole HTTP/1.1 response (we always send `Connection: close`).
async fn read_all<S: AsyncRead + Unpin>(s: &mut S) -> String {
    let mut out = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), s.read_to_end(&mut out)).await;
    String::from_utf8_lossy(&out).to_string()
}

async fn inspected_tls(env: &Env, sni: &str) -> tokio_rustls::client::TlsStream<TcpStream> {
    tls_connect(env.net.https_addr(), sni, std::slice::from_ref(&env.pki.proxy_root), &[b"http/1.1"]).await.unwrap()
}

/// The control link to nestd is still healthy.
async fn link_alive(env: &mut Env) {
    env.conn.send(&ProxyCommand::Ping { nonce: 42 }, &[]);
    env.conn.wait(|e| matches!(e, ProxyEvent::Pong { nonce: 42, .. })).await;
}

/// E1: inside inspected TLS, an absolute-form target naming the SNI host plus a different Host
/// header must not reach the upstream (and the placeholder must never be swapped for the secret).
#[tokio::test(flavor = "multi_thread")]
async fn e1_absolute_form_with_foreign_host_is_blocked_before_injection() {
    let mut env = env().await;
    let mut tls = inspected_tls(&env, "api.github.test").await;
    let req = format!(
        "GET https://api.github.test/x HTTP/1.1\r\nHost: evil.test\r\nAuthorization: Bearer {PLACEHOLDER}\r\nConnection: close\r\n\r\n"
    );
    tls.write_all(req.as_bytes()).await.unwrap();
    let resp = read_all(&mut tls).await;
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
    assert!(resp.contains("host_mismatch") && !resp.contains(SECRET), "{resp}");
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Alert { .. })).await;
    assert!(matches!(ev, ProxyEvent::Alert { kind: AlertKind::DomainFronting, binding: None, .. }), "{ev:?}");
}

/// E1 (variant): two Host headers are rejected even if the first one matches.
#[tokio::test(flavor = "multi_thread")]
async fn duplicate_host_headers_are_rejected() {
    let env = env().await;
    let mut tls = inspected_tls(&env, "api.github.test").await;
    tls.write_all(b"GET / HTTP/1.1\r\nHost: api.github.test\r\nHost: evil.test\r\nConnection: close\r\n\r\n").await.unwrap();
    let resp = read_all(&mut tls).await;
    assert!(resp.starts_with("HTTP/1.1 403") && resp.contains("host_mismatch"), "{resp}");
}

/// The upstream always gets exactly one Host, set by the proxy (case/port/trailing-dot
/// variants of the routed name are accepted from the client, but never forwarded as-is).
#[tokio::test(flavor = "multi_thread")]
async fn upstream_host_is_rewritten_to_the_target() {
    let env = env().await;
    let mut tls = inspected_tls(&env, "api.github.test").await;
    tls.write_all(b"GET /h HTTP/1.1\r\nHost: API.GitHub.test.:443\r\nConnection: close\r\n\r\n").await.unwrap();
    let resp = read_all(&mut tls).await;
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(resp.contains(r#""host_headers":["api.github.test"]"#), "{resp}");
}

/// E2: the explicit proxy's absolute-form plaintext request can't be fronted with a Host header.
#[tokio::test(flavor = "multi_thread")]
async fn e2_explicit_absolute_form_with_foreign_host_is_blocked() {
    let mut env = env().await;
    let mut s = TcpStream::connect(env.net.explicit_addr()).await.unwrap();
    s.write_all(b"GET http://plain.test/y HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n").await.unwrap();
    let resp = read_all(&mut s).await;
    assert!(resp.starts_with("HTTP/1.1 403") && resp.contains("host_mismatch"), "{resp}");
    env.conn.wait(|e| audit_with(e, |r| r.host == "plain.test" && r.reason.as_deref() == Some("host_mismatch"))).await;
}

/// E3: a CONNECT tunnel that doesn't start TLS is denied with a readable plaintext 403 instead
/// of being spliced (which would allow Host-routed egress and skip the placeholder rules).
#[tokio::test(flavor = "multi_thread")]
async fn e3_non_tls_connect_tunnel_is_denied() {
    let mut env = env().await;
    let (mut s, head) = connect_tunnel(&env, "plain.test:80").await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    s.write_all(format!("GET /z HTTP/1.1\r\nHost: evil.test\r\nAuthorization: Bearer {PLACEHOLDER}\r\n\r\n").as_bytes()).await.unwrap();
    let resp = read_all(&mut s).await;
    assert!(resp.starts_with("HTTP/1.1 403") && resp.contains("must carry TLS"), "{resp}");
    env.conn
        .wait(|e| audit_with(e, |r| r.host == "plain.test" && r.verdict == EgressVerdict::Deny && r.reason.as_deref() == Some("non_tls_tunnel")))
        .await;

    // Passthrough hosts too: a pinned client speaks TLS; plaintext through CONNECT is refused.
    let (mut s, _) = connect_tunnel(&env, "pinned.test:443").await;
    s.write_all(b"GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n").await.unwrap();
    let resp = read_all(&mut s).await;
    assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
}

/// A denied CONNECT host that the client doesn't speak TLS to gets a plaintext 403.
#[tokio::test(flavor = "multi_thread")]
async fn denied_connect_plaintext_gets_readable_403() {
    let env = env().await;
    let (mut s, head) = connect_tunnel(&env, "evil.test:80").await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    s.write_all(b"GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n").await.unwrap();
    let resp = read_all(&mut s).await;
    assert!(resp.starts_with("HTTP/1.1 403") && resp.contains("egress_denied"), "{resp}");
}

/// E4: a guest-controlled 70 KB Host header no longer produces a packet nestd can't read; the
/// alert arrives clipped and the control link stays up.
#[tokio::test(flavor = "multi_thread")]
async fn e4_oversized_host_does_not_break_the_control_link() {
    let mut env = env().await;
    let big = "a".repeat(70_000);
    let mut tls = inspected_tls(&env, "api.github.test").await;
    tls.write_all(format!("GET / HTTP/1.1\r\nHost: {big}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let _ = read_all(&mut tls).await;
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Alert { .. })).await;
    let ProxyEvent::Alert { detail, host, .. } = ev else { unreachable!() };
    assert!(detail.len() <= 1024 && host.len() <= 256, "{} {}", detail.len(), host.len());
    link_alive(&mut env).await;

    // Same through the plaintext path (routing Host itself is huge → rejected as invalid).
    let mut s = TcpStream::connect(env.net.http.local_addr().unwrap()).await.unwrap();
    s.write_all(format!("GET / HTTP/1.1\r\nHost: {big}\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let resp = read_all(&mut s).await;
    assert!(resp.starts_with("HTTP/1.1 4"), "{}", &resp[..resp.len().min(200)]);
    link_alive(&mut env).await;
}

/// A late policy/listener push for a sandbox nestd already dropped (fence racing setup) must
/// not bring its egress back; a newer epoch (re-placement) is accepted.
#[tokio::test(flavor = "multi_thread")]
async fn pushes_after_drop_are_refused_until_a_newer_epoch() {
    let mut env = env().await;
    let sbx = sandbox();
    env.conn.send(&ProxyCommand::SandboxDrop { sandbox: sbx.clone(), epoch: Epoch(4), reason: DropReason::Fence }, &[]);
    env.conn.send(&ProxyCommand::SandboxUpsert { sandbox: sbx.clone(), epoch: Epoch(4), workstream: None, policy: policy(9, 1) }, &[]);
    env.conn.send(&ProxyCommand::Ping { nonce: 1 }, &[]);
    let pong = env.conn.wait(|e| matches!(e, ProxyEvent::Pong { nonce: 1, .. })).await;
    assert!(matches!(pong, ProxyEvent::Pong { sandboxes: 0, .. }), "{pong:?}");
    // The listeners are gone too: nothing answers on the old :443.
    assert!(inspected_tls_opt(&env, "api.github.test").await.is_none());

    env.conn.send(&ProxyCommand::SandboxUpsert { sandbox: sbx.clone(), epoch: Epoch(5), workstream: None, policy: policy(1, 1) }, &[]);
    env.conn.send(&ProxyCommand::Ping { nonce: 2 }, &[]);
    let pong = env.conn.wait(|e| matches!(e, ProxyEvent::Pong { nonce: 2, .. })).await;
    assert!(matches!(pong, ProxyEvent::Pong { sandboxes: 1, .. }), "{pong:?}");
}

async fn inspected_tls_opt(env: &Env, sni: &str) -> Option<()> {
    let r = tokio::time::timeout(
        Duration::from_secs(2),
        tls_connect(env.net.https_addr(), sni, std::slice::from_ref(&env.pki.proxy_root), &[b"http/1.1"]),
    )
    .await;
    match r {
        Ok(Ok(mut tls)) => {
            // Handshake can't complete without a listener; if it did, a request must fail.
            tls.write_all(b"GET / HTTP/1.1\r\nHost: api.github.test\r\nConnection: close\r\n\r\n").await.ok()?;
            let resp = read_all(&mut tls).await;
            resp.starts_with("HTTP/1.1 200").then_some(())
        }
        _ => None,
    }
}

fn dns_query(name: &str) -> Vec<u8> {
    let mut m = Message::query();
    m.metadata.recursion_desired = true;
    m.add_query(Query::query(Name::from_ascii(name).unwrap(), RecordType::A));
    m.to_vec().unwrap()
}

/// A flood of random denied DNS names produces a bounded number of audit records (one per
/// distinct name per window, capped), never one per query.
#[tokio::test(flavor = "multi_thread")]
async fn denied_dns_flood_is_aggregated() {
    let mut env = env().await;
    let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dns = env.net.dns_udp.local_addr().unwrap();
    let mut buf = [0u8; 512];
    for i in 0..400 {
        // Each name twice: duplicates are never audited twice.
        for _ in 0..2 {
            sock.send_to(&dns_query(&format!("x{i}.exfil.test")), dns).await.unwrap();
            let (n, _) = tokio::time::timeout(Duration::from_secs(2), sock.recv_from(&mut buf)).await.unwrap().unwrap();
            assert_eq!(Message::from_vec(&buf[..n]).unwrap().metadata.response_code, ResponseCode::NXDomain);
        }
    }
    // Count deny records for those names over the next couple of flushes.
    let mut seen = 0usize;
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
    while let Ok(Some(ev)) = tokio::time::timeout_at(deadline, env.conn.events.recv()).await {
        if let ProxyEvent::Audit { records } = ev {
            seen += records.iter().filter(|r| r.host.ends_with(".exfil.test")).count();
        }
    }
    assert!((1..=128).contains(&seen), "audited {seen} denials for 800 queries");
}

/// TRACE with an injected credential is refused (the upstream would reflect the secret).
#[tokio::test(flavor = "multi_thread")]
async fn trace_with_credential_is_blocked() {
    let env = env().await;
    let auth = format!("Bearer {PLACEHOLDER}");
    let tls = inspected_tls(&env, "api.github.test").await;
    let r = http_over(tls, false, "TRACE", "api.github.test", "/", &[("authorization", &auth)]).await;
    assert_eq!(r.status, 405);
    assert_eq!(r.body["error"], "method_blocked");
    // TRACE without a placeholder is just forwarded.
    let tls = inspected_tls(&env, "api.github.test").await;
    let r = http_over(tls, false, "TRACE", "api.github.test", "/", &[]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["method"], "TRACE");
}

/// gRPC needs `te: trailers` to survive to an h2 upstream.
#[tokio::test(flavor = "multi_thread")]
async fn te_trailers_survive_to_h2_upstreams() {
    let env = env().await;
    let tls = tls_connect(env.net.https_addr(), "api.github.test", std::slice::from_ref(&env.pki.proxy_root), &[b"h2"]).await.unwrap();
    let r = http_over(tls, true, "POST", "api.github.test", "/svc/Method", &[("te", "trailers"), ("content-type", "application/grpc")]).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["te"], "trailers");
}
