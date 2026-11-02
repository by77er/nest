//! The client against the real gateway (`nest-gateway`), for the one property that needs both: the
//! order of their bind timers (`nest_protocol::gateway::CLIENT_BIND_TIMEOUT_MS`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use nest_gateway::state::clients;
use nest_gateway::testing::Signer;
use nest_gateway::{State, serve};
use nest_hands_client::{Next, OpenError, OpenOptions, RefusalCode, open};
use nest_protocol::gateway::{
    BindingClaims, BindingScope, CLIENT_BIND_TIMEOUT_MS, GUEST_CONNECT_TIMEOUT_MS, GuestInfo, HandsTarget,
};
use nest_protocol::model::{Epoch, SandboxId, Secret};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, UnixListener};

/// 2026-11-02, cell use1: a VM paused for a checkpoint never answered the vsock `CONNECT`. The
/// gateway's 5 s timer and the client's 5 s bind timer raced, the client's always won, and its
/// `Timeout(Bind)` was final, so the gateway's retryable `busy` never arrived. With the client's
/// default timer past the gateway's, a guest that stays silent comes back as that `busy`.
#[tokio::test(flavor = "multi_thread")]
async fn a_guest_silent_past_the_gateways_timer_is_busy_not_a_bind_timeout() {
    // A frozen guest: the vsock socket accepts and reads `CONNECT 1025`, then never answers.
    let dir = tempfile::tempdir().unwrap();
    let vsock = dir.path().join("vsock.sock");
    let guest = UnixListener::bind(&vsock).unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((mut s, _)) = guest.accept().await {
            let mut b = [0u8; 64];
            let _ = s.read(&mut b).await;
            held.push(s);
        }
    });
    let signer = Signer::generate();
    let state = State::new();
    state.set_key(&signer.kid(), &signer.public_key());
    let guest_info = GuestInfo { protocol_version: 1, capabilities: vec![] };
    let sbx = SandboxId("sbx_01jb7m2a4c".into());
    state.upsert_sandbox(sbx.clone(), Epoch(4), vsock, clients(&["agt_01jb7n0w1e"]), Some(guest_info.clone()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    tokio::spawn(serve(listener, Arc::clone(&state)));
    let claims = BindingClaims {
        v: 1,
        kid: signer.kid(),
        sandbox: sbx,
        epoch: Epoch(4),
        client: "agt_01jb7n0w1e".into(),
        scope: BindingScope::Hands,
        exp_ms: i64::MAX,
    };
    let target = HandsTarget { url, binding: Secret(signer.sign(&claims)), guest: guest_info, edge: None, sandbox: None, epoch: None };

    let started = Instant::now();
    let r = open(&target, &OpenOptions::default()).await;
    let took = started.elapsed();
    match &r {
        Err(OpenError::Refused(refusal)) => {
            assert_eq!(refusal.code, RefusalCode::Busy, "{refusal:?}");
            assert!(refusal.retry_after_ms.is_some(), "{refusal:?}");
        }
        other => panic!("expected the gateway's busy, got {other:?} after {took:?}"),
    }
    assert!(matches!(r.as_ref().unwrap_err().next(), Next::RetrySame { .. }));
    // The gateway's timer ended it, not the client's.
    assert!(took >= Duration::from_millis(GUEST_CONNECT_TIMEOUT_MS), "{took:?}");
    assert!(took < Duration::from_millis(CLIENT_BIND_TIMEOUT_MS), "{took:?}");
}
