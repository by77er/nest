//! End-to-end tests: a real nest-proxy driven by a fake nestd over SEQPACKET + SCM_RIGHTS, with
//! listener fds bound on 127.0.0.1 (standing in for the sandbox netns), local TLS/plaintext
//! upstreams, and clients trusting the proxy's root.

mod common;

use std::time::Duration;

use base64::Engine;
use hickory_proto::op::{Message, Query, ResponseCode};
use hickory_proto::rr::{Name, RData, RecordType};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use common::*;
use nest_protocol::control::{EgressVerdict, EgressVia};
use nest_protocol::host::proxy::{AlertKind, DropReason, ProxyCommand, ProxyEvent};
use nest_protocol::model::Epoch;

fn audit_with(ev: &ProxyEvent, f: impl Fn(&nest_protocol::control::EgressAuditRecord) -> bool) -> bool {
    matches!(ev, ProxyEvent::Audit { records } if records.iter().any(&f))
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_injects_bearer_over_h1_and_h2() {
    let mut env = env().await;
    let auth = format!("Bearer {PLACEHOLDER}");
    let r = https_get(&env, "api.github.test", "api.github.test", &[("authorization", &auth)], false).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(received_auth(&r.body), format!("Bearer {SECRET}"));
    // The upstream echoed the real secret back; the sandbox only sees it masked.
    let masked = r.body["authorization"].as_str().unwrap();
    assert!(!masked.contains(SECRET) && masked.chars().all(|c| c == '*'), "{masked}");
    assert_eq!(r.body["path"], "/x?q=1");
    assert_eq!(r.body["version"], "HTTP/1.1");
    assert_eq!(r.body["body_len"], 5);

    // ALPN mirrored end to end: client h2 → upstream h2.
    let r = https_get(&env, "api.github.test", "api.github.test", &[("authorization", &auth)], true).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.body["version"], "HTTP/2.0");
    assert_eq!(received_auth(&r.body), format!("Bearer {SECRET}"));

    // Audited with the binding name, never the value, and without the query string.
    let ev = env.conn.wait(|e| audit_with(e, |r| r.binding.as_deref() == Some("github"))).await;
    let s = serde_json::to_string(&ev).unwrap();
    assert!(!s.contains(SECRET) && !s.contains("q=1"), "{s}");
    let ProxyEvent::Audit { records } = ev else { unreachable!() };
    let rec = records.iter().find(|r| r.binding.is_some()).unwrap();
    assert_eq!((rec.verdict, rec.status, rec.path.as_deref()), (EgressVerdict::Allow, Some(200), Some("/x")));
    assert!(rec.bytes_down > 0 && rec.bytes_up == 5);
    assert!(matches!(rec.via, Some(EgressVia::HttpsTransparent | EgressVia::Explicit)), "{:?}", rec.via);
}

#[tokio::test(flavor = "multi_thread")]
async fn inspect_injects_git_basic_auth() {
    let env = env().await;
    let basic = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{PLACEHOLDER}")));
    let r = https_get(&env, "api.github.test", "api.github.test", &[("authorization", &basic)], false).await;
    let got = received_auth(&r.body).strip_prefix("Basic ").unwrap().to_string();
    assert!(!r.body.to_string().contains(&got), "the echoed Basic credential is masked");
    let dec = base64::engine::general_purpose::STANDARD.decode(got).unwrap();
    assert_eq!(dec, format!("x-access-token:{SECRET}").as_bytes());
}

#[tokio::test(flavor = "multi_thread")]
async fn deny_is_a_readable_403() {
    let mut env = env().await;
    let r = https_get(&env, "evil.test", "evil.test", &[], false).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"], "egress_denied");
    assert_eq!(r.body["host"], "evil.test");
    assert!(r.body["hint"].as_str().unwrap().contains("ask"));
    env.conn.wait(|e| audit_with(e, |r| r.host == "evil.test" && r.verdict == EgressVerdict::Deny)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn passthrough_is_not_decrypted() {
    let mut env = env().await;
    // Trusting only the *upstream's* public CA works: the proxy didn't terminate TLS.
    let tls = tls_connect(env.net.https_addr(), "pinned.test", &[env.pki.public_root.clone()], &[b"http/1.1"]).await.unwrap();
    let r = http_over(tls, false, "GET", "pinned.test", "/", &[]).await;
    assert_eq!(r.status, 200);
    // Trusting only the proxy root fails for passthrough hosts.
    assert!(tls_connect(env.net.https_addr(), "pinned.test", &[env.pki.proxy_root.clone()], &[]).await.is_err());
    env.conn.wait(|e| audit_with(e, |r| r.host == "pinned.test" && r.verdict == EgressVerdict::Passthrough)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn host_sni_mismatch_is_blocked_and_alerted() {
    let mut env = env().await;
    let r = https_get(&env, "api.github.test", "api.stripe.test", &[], false).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"], "host_mismatch");
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Alert { .. })).await;
    assert!(matches!(ev, ProxyEvent::Alert { kind: AlertKind::DomainFronting, .. }), "{ev:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn placeholder_to_wrong_host_is_blocked_and_alerted() {
    let mut env = env().await;
    let auth = format!("Bearer {PLACEHOLDER}");
    let r = https_get(&env, "api.stripe.test", "api.stripe.test", &[("authorization", &auth)], false).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"], "credential_blocked");
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Alert { .. })).await;
    match ev {
        ProxyEvent::Alert { kind, host, sandbox, binding, .. } => {
            assert_eq!(kind, AlertKind::PlaceholderWrongHost);
            assert_eq!(binding.as_deref(), Some("github"));
            assert_eq!(host, "api.stripe.test");
            assert_eq!(sandbox, common::sandbox());
        }
        _ => unreachable!(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn expired_secret_is_never_used() {
    let mut env = env_with(Some(now_ms() - 1), true).await;
    let auth = format!("Bearer {PLACEHOLDER}");
    let r = https_get(&env, "api.github.test", "api.github.test", &[("authorization", &auth)], false).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"], "credential_unavailable");
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Alert { .. })).await;
    assert!(matches!(ev, ProxyEvent::Alert { kind: AlertKind::InjectionAfterExpiry, .. }));
}

#[tokio::test(flavor = "multi_thread")]
async fn private_upstream_addresses_are_refused() {
    // Production setting: names resolving to loopback/private/link-local are never dialed.
    let env = env_with(None, false).await;
    let r = https_get(&env, "private.test", "private.test", &[], false).await;
    assert_eq!(r.status, 403);
    assert!(r.body["reason"].as_str().unwrap().contains("upstream"), "{:?}", r.body);
}

fn dns_query(name: &str, ty: RecordType) -> Vec<u8> {
    let mut m = Message::query();
    m.metadata.recursion_desired = true;
    m.add_query(Query::query(Name::from_ascii(name).unwrap(), ty));
    m.to_vec().unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn dns_resolves_only_allowlisted_names() {
    let env = env().await;
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let dns = env.net.dns_udp.local_addr().unwrap();
    let mut buf = vec![0u8; 4096];

    sock.send_to(&dns_query("api.github.test.", RecordType::A), dns).await.unwrap();
    let n = tokio::time::timeout(Duration::from_secs(5), sock.recv(&mut buf)).await.unwrap().unwrap();
    let resp = Message::from_vec(&buf[..n]).unwrap();
    assert_eq!(resp.metadata.response_code, ResponseCode::NoError);
    assert!(matches!(resp.answers[0].data, RData::A(a) if a.0 == std::net::Ipv4Addr::LOCALHOST));
    assert!(resp.answers[0].ttl <= 60);

    sock.send_to(&dns_query("evil.test.", RecordType::A), dns).await.unwrap();
    let n = tokio::time::timeout(Duration::from_secs(5), sock.recv(&mut buf)).await.unwrap().unwrap();
    assert_eq!(Message::from_vec(&buf[..n]).unwrap().metadata.response_code, ResponseCode::NXDomain);

    // Same over TCP.
    let mut s = TcpStream::connect(env.net.dns_tcp.local_addr().unwrap()).await.unwrap();
    let q = dns_query("db.test.", RecordType::A);
    s.write_all(&(q.len() as u16).to_be_bytes()).await.unwrap();
    s.write_all(&q).await.unwrap();
    let mut len = [0u8; 2];
    s.read_exact(&mut len).await.unwrap();
    let mut msg = vec![0u8; u16::from_be_bytes(len) as usize];
    s.read_exact(&mut msg).await.unwrap();
    let resp = Message::from_vec(&msg).unwrap();
    assert_eq!(resp.metadata.response_code, ResponseCode::NoError);
    assert_eq!(resp.answers.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn fails_closed_when_lease_lapses() {
    let env = env().await;
    env.conn.send(&ProxyCommand::LeaseUpdate { valid_until_ms: now_ms() - 1 }, &[]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(tls_connect(env.net.https_addr(), "api.github.test", std::slice::from_ref(&env.pki.proxy_root), &[]).await.is_err());
    // DNS refuses too.
    let sock = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    sock.send_to(&dns_query("api.github.test.", RecordType::A), env.net.dns_udp.local_addr().unwrap()).await.unwrap();
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(5), sock.recv(&mut buf)).await.unwrap().unwrap();
    assert_eq!(Message::from_vec(&buf[..n]).unwrap().metadata.response_code, ResponseCode::Refused);

    env.conn.send(&ProxyCommand::LeaseUpdate { valid_until_ms: now_ms() + 60_000 }, &[]);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let r = https_get(&env, "api.github.test", "api.github.test", &[], false).await;
    assert_eq!(r.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn nestd_restart_resyncs_and_queued_connections_survive() {
    let mut env = env().await;
    // nestd goes away: the proxy must drop everything and reconnect. Once it has reconnected,
    // the old session is gone (a connection racing the disconnect itself is accepted and reset,
    // which is still fail-closed).
    env.conn.shutdown();
    let mut conn = env.nestd.accept().await;
    // A client connects before the resync; the kernel queues it on nestd's still-open listener.
    let https = env.net.https_addr();
    let root = env.pki.proxy_root.clone();
    let client = tokio::spawn(async move {
        let tls = tls_connect(https, "api.github.test", &[root], &[b"http/1.1"]).await.unwrap();
        http_over(tls, false, "GET", "api.github.test", "/", &[]).await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!client.is_finished(), "nothing may be served before the resync");

    resync(&mut conn, &env.pki, &env.net, None, env.echo_addr.port()).await;
    let r = tokio::time::timeout(Duration::from_secs(10), client).await.unwrap().unwrap();
    assert_eq!(r.status, 200);
    env.conn = conn;
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_proxy_connect_inject_deny_and_absolute_form() {
    let mut env = env().await;
    // CONNECT + TLS inspection + injection, attributed to the agent.
    let (s, head) = connect_tunnel(&env, "api.github.test:443").await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let tls = tokio_rustls::TlsConnector::from(client_tls(&[env.pki.proxy_root.clone()], &[b"http/1.1"]))
        .connect(rustls_pki_types::ServerName::try_from("api.github.test").unwrap(), s)
        .await
        .unwrap();
    let auth = format!("token {PLACEHOLDER}");
    let r = http_over(tls, false, "GET", "api.github.test", "/", &[("authorization", &auth)]).await;
    assert_eq!(received_auth(&r.body), format!("token {SECRET}"));
    env.conn
        .wait(|e| audit_with(e, |r| r.agent.as_ref().map(|a| a.0.as_str()) == Some("agt_test") && r.binding.is_some()))
        .await;

    // Denied CONNECT: the tunnel is accepted but answered inside it with a readable 403 over our
    // TLS (curl hides CONNECT error bodies); nothing reaches upstream.
    let (s, head) = connect_tunnel(&env, "evil.test:443").await;
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let tls = tokio_rustls::TlsConnector::from(client_tls(&[env.pki.proxy_root.clone()], &[b"http/1.1"]))
        .connect(rustls_pki_types::ServerName::try_from("evil.test").unwrap(), s)
        .await
        .unwrap();
    let r = http_over(tls, false, "GET", "evil.test", "/", &[]).await;
    assert_eq!(r.status, 403);
    assert_eq!(r.body["error"], "egress_denied");
    assert!(r.body["hint"].as_str().unwrap().contains("ask"));
    env.conn.wait(|e| audit_with(e, |r| r.host == "evil.test" && r.verdict == EgressVerdict::Deny)).await;

    // Absolute-form plaintext HTTP.
    let mut s = TcpStream::connect(env.net.explicit_addr()).await.unwrap();
    s.write_all(b"GET http://plain.test/hello HTTP/1.1\r\nHost: plain.test\r\nProxy-Authorization: Basic eDp5\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200"), "{out}");
    assert!(out.contains("\"path\":\"/hello\""), "{out}");
    assert!(out.contains("\"proxy_authorization\":false"), "proxy credentials must not be forwarded: {out}");

    // Placeholders never travel over plaintext.
    let mut s = TcpStream::connect(env.net.explicit_addr()).await.unwrap();
    let req = format!("GET http://plain.test/ HTTP/1.1\r\nHost: plain.test\r\nAuthorization: Bearer {PLACEHOLDER}\r\nConnection: close\r\n\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn transparent_plain_http_routes_by_host() {
    let env = env().await;
    let mut s = TcpStream::connect(env.net.http.local_addr().unwrap()).await.unwrap();
    s.write_all(b"GET /p HTTP/1.1\r\nHost: plain.test\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 200") && out.contains("\"path\":\"/p\""), "{out}");

    let mut s = TcpStream::connect(env.net.http.local_addr().unwrap()).await.unwrap();
    s.write_all(b"GET / HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut out = String::new();
    s.read_to_string(&mut out).await.unwrap();
    assert!(out.starts_with("HTTP/1.1 403"), "{out}");
}

#[tokio::test(flavor = "multi_thread")]
async fn tcp_exception_splices_and_sandbox_drop_closes_it() {
    let env = env().await;
    let mut s = TcpStream::connect(env.net.tcp_exc.local_addr().unwrap()).await.unwrap();
    s.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    tokio::time::timeout(Duration::from_secs(5), s.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"ping");

    // Fencing: established connections are closed and listeners stop accepting.
    env.conn.send(&ProxyCommand::SandboxDrop { sandbox: common::sandbox(), epoch: Epoch(4), reason: DropReason::Fence }, &[]);
    let n = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await.unwrap().unwrap_or(0);
    assert_eq!(n, 0, "connection must be closed on sandbox_drop");
    // The proxy no longer accepts on the sandbox's listeners. (Our harness still holds nestd's
    // copies, so the kernel queues the connection; it must simply never be served. nestd closes
    // its copies and the netns on a real teardown.)
    let roots = [env.pki.proxy_root.clone()];
    let attempt = tls_connect(env.net.https_addr(), "api.github.test", &roots, &[]);
    match tokio::time::timeout(Duration::from_millis(500), attempt).await {
        Err(_) | Ok(Err(_)) => {}
        Ok(Ok(_)) => panic!("dropped sandbox was served"),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn wrong_fd_count_is_a_protocol_error() {
    let mut env = env().await;
    env.conn.send(
        &ProxyCommand::ListenersAdd { sandbox: common::sandbox(), epoch: Epoch(4), listeners: env.net.handoff(env.echo_addr.port()).0 },
        &[],
    );
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Error { .. })).await;
    assert!(matches!(ev, ProxyEvent::Error { error } if error.code == "invalid_message"));
    // The proxy closes and comes back for a resync.
    let _again = env.nestd.accept().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn ping_and_stale_policy_pushes() {
    let mut env = env().await;
    env.conn.send(&ProxyCommand::Ping { nonce: 7 }, &[]);
    let ev = env.conn.wait(|e| matches!(e, ProxyEvent::Pong { .. })).await;
    assert!(matches!(ev, ProxyEvent::Pong { nonce: 7, sandboxes: 1, .. }));
    // An older epoch's policy (that would deny everything) is ignored.
    let mut p = policy(99, env.echo_addr.port());
    p.allow.clear();
    env.conn.send(&ProxyCommand::SandboxUpsert { sandbox: common::sandbox(), epoch: Epoch(3), workstream: None, policy: p }, &[]);
    env.conn.send(&ProxyCommand::Ping { nonce: 8 }, &[]);
    env.conn.wait(|e| matches!(e, ProxyEvent::Pong { nonce: 8, .. })).await;
    let r = https_get(&env, "api.github.test", "api.github.test", &[], false).await;
    assert_eq!(r.status, 200);
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_upgrade_through_inspection() {
    let mut env = env().await;
    let mut tls = tls_connect(env.net.https_addr(), "api.github.test", std::slice::from_ref(&env.pki.proxy_root), &[b"http/1.1"])
        .await
        .unwrap();
    tls.write_all(b"GET /ws HTTP/1.1\r\nHost: api.github.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n").await.unwrap();
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        assert_eq!(tls.read(&mut b).await.unwrap(), 1);
        head.push(b[0]);
    }
    let head = String::from_utf8(head).unwrap();
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    tls.write_all(b"frame-bytes").await.unwrap();
    let mut buf = [0u8; 11];
    tokio::time::timeout(Duration::from_secs(5), tls.read_exact(&mut buf)).await.unwrap().unwrap();
    assert_eq!(&buf, b"frame-bytes");
    drop(tls);
    env.conn.wait(|e| audit_with(e, |r| r.status == Some(101) && r.reason.as_deref() == Some("upgraded"))).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn h2_requests_multiplex_concurrently() {
    let env = env().await;
    let tls = tls_connect(env.net.https_addr(), "api.github.test", std::slice::from_ref(&env.pki.proxy_root), &[b"h2"])
        .await
        .unwrap();
    let (s, conn) = hyper::client::conn::http2::handshake(hyper_util::rt::TokioExecutor::new(), hyper_util::rt::TokioIo::new(tls))
        .await
        .unwrap();
    tokio::spawn(conn);
    let mut tasks = Vec::new();
    for i in 0..20 {
        let mut s = s.clone();
        tasks.push(tokio::spawn(async move {
            let req = hyper::Request::get(format!("https://api.github.test/{i}"))
                .body(http_body_util::Full::new(bytes::Bytes::new()))
                .unwrap();
            let resp = s.send_request(req).await.unwrap();
            assert_eq!(resp.status(), 200);
            http_body_util::BodyExt::collect(resp.into_body()).await.unwrap();
        }));
    }
    for t in tasks {
        tokio::time::timeout(Duration::from_secs(10), t).await.unwrap().unwrap();
    }
}
