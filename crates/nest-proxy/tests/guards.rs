//! Request guards through the real proxy (docs/sandbox/networking/egress/policy/#request-guards):
//! generic rules on the harness's made-up hosts, pushed the way nestd pushes a policy.

mod common;

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use common::*;
use nest_protocol::control::EgressVerdict;
use nest_protocol::host::proxy::{ProxyCommand, ProxyEvent};
use nest_protocol::model::{Epoch, HostPattern, INJECTED_ANY, JsonFieldMatch, RequestGuard, RequestMatch};

fn m(methods: &[&str], path: &str) -> RequestMatch {
    RequestMatch { methods: methods.iter().map(|s| s.to_string()).collect(), path: Some(path.into()), ..Default::default() }
}

/// On the injecting host: writes only under `/mine/`, a body-checked batch, and a query endpoint
/// only with the proxy's own credential. Plus guards on the passthrough host and the TCP exception's.
fn guarded_policy(env: &Env) -> nest_protocol::model::EgressPolicy {
    let mut p = policy(2, env.echo_addr.port());
    p.guards = vec![
        RequestGuard {
            name: "svc-write".into(),
            hosts: vec![HostPattern("api.github.test".into())],
            scope: vec![RequestMatch { methods_except: vec!["GET".into(), "HEAD".into()], ..Default::default() }],
            allow: vec![
                m(&[], "/mine/**"),
                RequestMatch {
                    body_json: Some(JsonFieldMatch { pointer: "/op".into(), values: vec!["read".into()] }),
                    ..m(&["POST"], "/batch")
                },
                RequestMatch { injected: Some("github".into()), ..m(&["POST"], "/q") },
                RequestMatch { injected: Some("github".into()), ..m(&["POST"], "/batch") },
            ],
            reason: "writes only under /mine".into(),
            ignore_case: true,
        },
        RequestGuard {
            name: "inspect-me".into(),
            hosts: vec![HostPattern("pinned.test".into()), HostPattern("db.test".into())],
            scope: vec![m(&[], "/never")],
            allow: vec![],
            reason: String::new(),
            ignore_case: false,
        },
    ];
    p
}

async fn push(env: &mut Env, p: nest_protocol::model::EgressPolicy) {
    env.conn.send(&ProxyCommand::SandboxUpsert { sandbox: common::sandbox(), epoch: Epoch(4), workstream: None, policy: p }, &[]);
    env.conn.send(&ProxyCommand::Ping { nonce: 1 }, &[]);
    env.conn.wait(|e| matches!(e, ProxyEvent::Pong { nonce: 1, .. })).await;
}

const HOST: &str = "api.github.test";

#[tokio::test(flavor = "multi_thread")]
async fn guards_refuse_out_of_scope_writes_before_upstream() {
    let mut env = env().await;
    let p = guarded_policy(&env);
    push(&mut env, p).await;
    for h2 in [false, true] {
        let r = https_req(&env, HOST, "POST", "/theirs/x", &[], b"data", h2).await;
        assert_eq!(r.status, 403, "{:?}", r.body);
        assert_eq!((r.body["error"].as_str(), r.body["guard"].as_str()), (Some("request_denied"), Some("svc-write")));
        assert_eq!(r.body["reason"], "writes only under /mine");
        // Never reached the upstream: the echo would have answered with what it received.
        assert!(r.body.get("body_len").is_none());

        let r = https_req(&env, HOST, "PUT", "/MINE/x", &[], b"data", h2).await;
        assert_eq!((r.status, r.body["body_len"].as_u64()), (200, Some(4)), "{:?}", r.body);
        let r = https_req(&env, HOST, "PUT", "/mine/%2e%2e/theirs", &[], b"data", h2).await;
        assert_eq!(r.status, 403, "{:?}", r.body);
        let r = https_req(&env, HOST, "GET", "/theirs/x", &[], b"", h2).await;
        assert_eq!(r.status, 200);
    }
    env.conn
        .wait(|e| matches!(e, ProxyEvent::Audit { records } if records.iter().any(|r|
            r.verdict == EgressVerdict::Deny && r.reason.as_deref() == Some("guard: svc-write") && r.path.as_deref() == Some("/theirs/x"))))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_read_body_is_judged_and_then_replayed_whole() {
    let mut env = env().await;
    let p = guarded_policy(&env);
    push(&mut env, p).await;
    let read = br#"{"op": "read", "items": [1, 2, 3]}"#;
    for h2 in [false, true] {
        let r = https_req(&env, HOST, "POST", "/batch", &[("content-type", "application/json")], read, h2).await;
        assert_eq!((r.status, r.body["body_len"].as_u64()), (200, Some(read.len() as u64)), "{:?}", r.body);
        let r = https_req(&env, HOST, "POST", "/batch", &[], br#"{"op": "write"}"#, h2).await;
        assert_eq!(r.status, 403, "{:?}", r.body);
        let r = https_req(&env, HOST, "POST", "/batch", &[("content-encoding", "gzip")], read, h2).await;
        assert_eq!(r.status, 403, "an encoded body is unreadable, so never an exception");
        let r = https_req(&env, HOST, "POST", "/batch", &[], b"not json", h2).await;
        assert_eq!(r.status, 403);
    }
    // Too large to judge: refused, even with the right field first.
    let mut big = br#"{"op": "read", "pad": ""#.to_vec();
    big.extend(std::iter::repeat_n(b'a', 70 * 1024));
    big.extend(br#""}"#);
    let r = https_req(&env, HOST, "POST", "/batch", &[], &big, false).await;
    assert_eq!(r.status, 403, "{:?}", r.body);
    // Let through by another exception after a partial read: the upstream still gets all of it.
    let ours = format!("Bearer {PLACEHOLDER}");
    for h2 in [false, true] {
        let r = https_req(&env, HOST, "POST", "/batch", &[("authorization", &ours)], &big, h2).await;
        assert_eq!((r.status, r.body["body_len"].as_u64()), (200, Some(big.len() as u64)), "{:?}", r.body);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_exception_can_require_the_proxys_own_credential() {
    let mut env = env().await;
    let p = guarded_policy(&env);
    push(&mut env, p).await;
    let ours = format!("Bearer {PLACEHOLDER}");
    let r = https_req(&env, HOST, "POST", "/q", &[("authorization", &ours)], b"{}", false).await;
    assert_eq!(r.status, 200, "{:?}", r.body);
    assert_eq!(received_auth(&r.body), format!("Bearer {SECRET}"));
    let r = https_req(&env, HOST, "POST", "/q", &[("authorization", "Bearer someone-elses")], b"{}", false).await;
    assert_eq!(r.status, 403, "another credential gets no exception");
    let r = https_req(&env, HOST, "POST", "/q", &[], b"{}", false).await;
    assert_eq!(r.status, 403);
    env.conn
        .wait(|e| matches!(e, ProxyEvent::Audit { records } if records.iter().any(|r|
            r.reason.as_deref() == Some("guard: svc-write") && r.binding.is_none() && r.path.as_deref() == Some("/q"))))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_floor_can_require_any_credential_the_proxy_injected() {
    // An operator's floor that names no binding: a write passes only with a credential the proxy
    // substituted, whichever binding's (`injected: "*"`), never with one the sandbox sent itself.
    let mut env = env().await;
    let mut p = policy(2, env.echo_addr.port());
    p.guards = vec![RequestGuard {
        name: "floor".into(),
        hosts: vec![HostPattern(HOST.into())],
        scope: vec![RequestMatch { methods_except: vec!["GET".into(), "HEAD".into()], ..Default::default() }],
        allow: vec![RequestMatch { injected: Some(INJECTED_ANY.into()), ..Default::default() }],
        reason: "writes only with nest's credential".into(),
        ignore_case: false,
    }];
    push(&mut env, p).await;
    let ours = format!("Bearer {PLACEHOLDER}");
    for h2 in [false, true] {
        let r = https_req(&env, HOST, "POST", "/anything", &[("authorization", &ours)], b"{}", h2).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        assert_eq!(received_auth(&r.body), format!("Bearer {SECRET}"));
        let r = https_req(&env, HOST, "POST", "/anything", &[("authorization", "Bearer planted")], b"{}", h2).await;
        assert_eq!((r.status, r.body["guard"].as_str()), (403, Some("floor")), "a credential the sandbox holds gets no exception");
        assert!(r.body.get("body_len").is_none(), "refused before the upstream");
        let r = https_req(&env, HOST, "POST", "/anything", &[], b"{}", h2).await;
        assert_eq!(r.status, 403);
        let r = https_req(&env, HOST, "GET", "/anything", &[], b"", h2).await;
        assert_eq!(r.status, 200);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_guarded_host_is_never_spliced_or_a_tcp_exception() {
    let mut env = env().await;
    let p = guarded_policy(&env);
    push(&mut env, p).await;
    // pinned.test is on the passthrough list, but a guard names it: the proxy terminates TLS.
    let tls = tls_connect(env.net.https_addr(), "pinned.test", std::slice::from_ref(&env.pki.proxy_root), &[b"http/1.1"]).await;
    let r = http_over(tls.expect("inspected with the proxy's root"), false, "GET", "pinned.test", "/never", &[]).await;
    assert_eq!(r.status, 403, "{:?}", r.body);
    // db.test's TCP exception no longer splices.
    let mut s = TcpStream::connect(env.net.tcp_exc.local_addr().unwrap()).await.unwrap();
    let _ = s.write_all(b"ping").await;
    let mut buf = [0u8; 4];
    let got = tokio::time::timeout(Duration::from_secs(5), s.read(&mut buf)).await.unwrap().unwrap_or(0);
    assert_eq!(got, 0, "the exception's connection is closed, not echoed");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_target_past_the_guarded_bounds_is_refused_before_upstream() {
    let mut env = env().await;
    let p = guarded_policy(&env);
    push(&mut env, p).await;
    let long = format!("/mine/{}", "a/".repeat(300));
    for h2 in [false, true] {
        // On a guarded host a read is refused too: it can't be decided within the bounds.
        let r = https_req(&env, HOST, "GET", &long, &[], b"", h2).await;
        assert_eq!((r.status, r.body["error"].as_str()), (414, Some("request_target_too_long")), "{:?}", r.body);
        assert!(r.body.get("body_len").is_none());
        let query = format!("/mine/x?{}", vec!["a=1"; 300].join("&"));
        let r = https_req(&env, HOST, "GET", &query, &[], b"", h2).await;
        assert_eq!(r.status, 414, "{:?}", r.body);
        // Within them it is decided as ever.
        let r = https_req(&env, HOST, "GET", &format!("/mine/{}", "a/".repeat(200)), &[], b"", h2).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
        // A host no guard names isn't bounded.
        let r = https_req(&env, "api.stripe.test", "GET", &long, &[], b"", h2).await;
        assert_eq!(r.status, 200, "{:?}", r.body);
    }
    env.conn
        .wait(|e| matches!(e, ProxyEvent::Audit { records } if records.iter().any(|r|
            r.verdict == EgressVerdict::Deny && r.reason.as_deref() == Some("guard_target_too_long"))))
        .await;
}
