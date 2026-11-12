//! The seam for API clients' request guards (`control-plane/src/lib/client-guards.ts`): on the wire they
//! are ordinary `RequestGuard`s named `client:<name>`, after the operator's, and their `injected` matchers
//! name the client's own bindings (`client:<binding>`). The fixture
//! `protocol/fixtures/control/egress_policy/egress_policy.client_guards.json` is what the control plane
//! produces from an operator guard and three client guards (a vitest asserts it); here the proxy's own
//! evaluator decides requests against it: a client guard refuses, but its exceptions never exempt a
//! request from the operator's guard, and its binding exception holds only for the client's own binding.

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, refusing};

fn policy() -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/egress_policy.client_guards.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The name of the guard that refuses the request, if any.
fn decide(p: &EgressPolicy, host: &str, method: &str, target: &str, body: Option<&str>, injected: Option<&str>) -> Option<String> {
    let (path, query) = target.split_once('?').map_or((target, None), |(a, b)| (a, Some(b)));
    let req = Req { host, method, path, query, injected };
    let json = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
    let view = match (body, &json) {
        (None, _) => BodyView::Unread,
        (Some(_), Some(v)) => BodyView::Json(v),
        (Some(_), None) => BodyView::Unknown,
    };
    refusing(&p.guards, &req, &view).map(|g| g.name.clone())
}

#[test]
fn a_client_guard_refuses_what_its_scope_covers() {
    let p = policy();
    // Within the operator's exception, but a delete the client's guard refuses.
    assert_eq!(decide(&p, "files.example.com", "DELETE", "/store/mine/x", None, None).as_deref(), Some("client:no-delete"));
    assert_eq!(decide(&p, "files.example.com", "PUT", "/store/mine/x", None, None), None);
    assert_eq!(decide(&p, "files.example.com", "GET", "/store/theirs/x", None, None), None);
    // Writes to the API, and pushes outside the client's own repo, whatever the spelling.
    assert_eq!(decide(&p, "api.example.com", "POST", "/repos/x", None, None).as_deref(), Some("client:api-write"));
    assert_eq!(decide(&p, "git.example.com", "POST", "/other/repo.git/git-receive-pack", None, None).as_deref(), Some("client:push"));
    assert_eq!(decide(&p, "git.example.com", "POST", "/me/box/../../other/repo/git-receive-pack", None, None).as_deref(), Some("client:push"));
    assert_eq!(
        decide(&p, "git.example.com", "GET", "/other/repo/info/refs?service=git%2Dreceive%2Dpack", None, None).as_deref(),
        Some("client:push")
    );
    assert_eq!(decide(&p, "git.example.com", "POST", "/ME/Box.git/git-receive-pack", None, None), None);
    assert_eq!(decide(&p, "git.example.com", "POST", "/other/repo.git/git-upload-pack", None, None), None);
    assert!(p.guarded("files.example.com") && p.guarded("api.example.com") && p.guarded("git.example.com"));
}

#[test]
fn a_client_exception_never_exempts_an_operator_refusal() {
    let p = policy();
    // `/store/theirs/**` is the client guard's exception; the operator's guard still refuses the write.
    assert_eq!(decide(&p, "files.example.com", "PUT", "/store/theirs/x", None, None).as_deref(), Some("store-write"));
    assert_eq!(decide(&p, "files.example.com", "DELETE", "/store/theirs/x", None, None).as_deref(), Some("store-write"));
    // Without the client's guards, the operator's alone decides the same way: they only took away.
    let mut operator_only = p.clone();
    operator_only.guards.retain(|g| !g.name.starts_with("client:"));
    for (m, path) in [("PUT", "/store/theirs/x"), ("DELETE", "/store/theirs/x"), ("PUT", "/store/mine/x"), ("DELETE", "/store/mine/x")] {
        let with = decide(&p, "files.example.com", m, path, None, None);
        let without = decide(&operator_only, "files.example.com", m, path, None, None);
        assert!(without.is_none() || with.is_some(), "{m} {path}: the client's guards let through what the operator's refuse");
    }
}

#[test]
fn a_client_binding_exception_needs_the_clients_own_binding() {
    let p = policy();
    let q = |injected| decide(&p, "api.example.com", "POST", "/query", None, injected);
    assert_eq!(q(Some("client:svc")), None);
    // The operator's binding under the same short name is not the client's.
    assert_eq!(q(Some("svc")).as_deref(), Some("client:api-write"));
    assert_eq!(q(None).as_deref(), Some("client:api-write"));
    // A body-field exception: only a readable body with that value.
    let b = |body| decide(&p, "api.example.com", "POST", "/batch", Some(body), None);
    assert_eq!(b(r#"{"op":"read"}"#), None);
    assert_eq!(b(r#"{"op":"write"}"#).as_deref(), Some("client:api-write"));
    assert_eq!(b("not json").as_deref(), Some("client:api-write"));
}
