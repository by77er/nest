//! The seam for `injected: "*"` (docs/sandbox/networking/egress/policy/#any-injected-credential): a
//! matcher that holds when the proxy substituted a credential, whichever binding's. The fixture
//! `protocol/fixtures/control/egress_policy/egress_policy.injected_any.json` is what the control plane
//! produces from a base-layer floor (a push passes only when its Authorization header is one nest's
//! substitution wrote whole: `at`), an operator guard with `*` in its scope, and a client guard with `*`
//! in an exception (a vitest asserts it); here the proxy's own evaluator decides requests against it.

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, Whole, refusing};

fn policy() -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/egress_policy.injected_any.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// The name of the guard that refuses the request, if any. `injected`: the binding substituted, which
/// wrote Authorization whole.
fn decide(p: &EgressPolicy, host: &str, method: &str, target: &str, injected: Option<&str>) -> Option<String> {
    let whole: Vec<Whole> = injected.map(|b| Whole { header: "authorization".into(), binding: b.into() }).into_iter().collect();
    decide_whole(p, host, method, target, injected, &whole)
}

fn decide_whole(p: &EgressPolicy, host: &str, method: &str, target: &str, injected: Option<&str>, whole: &[Whole]) -> Option<String> {
    let (path, query) = target.split_once('?').map_or((target, None), |(a, b)| (a, Some(b)));
    let req = Req { host, method, path, query, injected, whole };
    refusing(&p.guards, &req.prepare().unwrap(), &BodyView::Unread).map(|g| g.name.clone())
}

#[test]
fn a_floor_lets_a_push_through_only_with_a_credential_nest_injected() {
    let p = policy();
    let push = |target, injected| decide(&p, "git.example.com", "POST", target, injected);
    // With the operator's binding or a client's, whichever: nest injected it.
    assert_eq!(push("/me/box.git/git-receive-pack", Some("svc")), None);
    assert_eq!(push("/me/box.git/git-receive-pack", Some("client:push")), None);
    // With none (a credential the sandbox holds itself, planted or not), refused, whatever the spelling.
    assert_eq!(push("/me/box.git/git-receive-pack", None).as_deref(), Some("push-floor"));
    assert_eq!(push("/me/box/../../them/repo/git-receive-pack", None).as_deref(), Some("push-floor"));
    assert_eq!(
        decide(&p, "git.example.com", "GET", "/them/repo/info/refs?service=git%2Dreceive%2Dpack", None).as_deref(),
        Some("push-floor")
    );
    // Fetches are out of its scope.
    assert_eq!(push("/them/repo.git/git-upload-pack", None), None);
    // nest's credential substituted into another header, Authorization planted: refused.
    let x_app_key = [Whole { header: "x-app-key".into(), binding: "client:push".into() }];
    assert_eq!(
        decide_whole(&p, "git.example.com", "POST", "/me/box.git/git-receive-pack", Some("client:push"), &x_app_key).as_deref(),
        Some("push-floor")
    );
}

#[test]
fn a_scope_naming_any_covers_every_injected_binding_and_nothing_without_one() {
    let p = policy();
    let upload = |injected| decide(&p, "files.example.com", "PUT", "/upload/x", injected);
    assert_eq!(upload(Some("svc")).as_deref(), Some("no-credential-uploads"));
    assert_eq!(upload(Some("client:push")).as_deref(), Some("no-credential-uploads"));
    assert_eq!(upload(None), None);
    assert_eq!(decide(&p, "files.example.com", "PUT", "/other/x", Some("svc")), None);
}

#[test]
fn a_client_exception_naming_any_only_narrows_the_clients_own_guard() {
    let p = policy();
    let q = |injected| decide(&p, "api.example.com", "POST", "/query", injected);
    // The client's exception holds with any credential nest injected, the operator's binding's included...
    assert_eq!(q(Some("svc")), None);
    assert_eq!(q(Some("client:push")), None);
    // ...and with none it doesn't: the client's guard refuses.
    assert_eq!(q(None).as_deref(), Some("client:api-write"));
    // It never exempts a request from another guard: without the client's guard, nothing it now refuses
    // was let through, and with it, nothing the rest refuse is let through.
    let mut without = p.clone();
    without.guards.retain(|g| !g.name.starts_with("client:"));
    for (host, method, target) in [
        ("api.example.com", "POST", "/query"),
        ("api.example.com", "DELETE", "/x"),
        ("files.example.com", "PUT", "/upload/x"),
        ("git.example.com", "POST", "/a/b/git-receive-pack"),
    ] {
        for injected in [None, Some("svc"), Some("client:push")] {
            let (w, wo) = (decide(&p, host, method, target, injected), decide(&without, host, method, target, injected));
            assert!(wo.is_none() || w.is_some(), "{method} {host}{target} {injected:?}: the client's guard let through what the others refuse");
        }
    }
}
