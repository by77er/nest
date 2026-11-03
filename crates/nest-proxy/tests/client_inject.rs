//! The seam for API clients' injection bindings (`control-plane/src/lib/client-secrets.ts`): on the wire
//! they are ordinary `InjectionBinding`s, named `client:<name>` with the placeholder nest assigns
//! (`nest-ph.<client>.<name>.`). The fixture `protocol/fixtures/control/egress_policy/egress_policy.client_inject.json`
//! is what the control plane's constructor produces (a vitest asserts it); here the proxy substitutes
//! each client secret on its binding's own hosts only, beside the operator's GitHub binding.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use http::{HeaderMap, header::AUTHORIZATION};
use nest_protocol::model::{EgressPolicy, InjectionSecret};
use nest_proxy::inject::{Input, Verdict, apply};

const STRIPE: &str = "nest-ph.cli_01JTESTCLIENT.stripe.";
const SEARCH: &str = "nest-ph.cli_01JTESTCLIENT.search.";

fn policy() -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/egress_policy.client_inject.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn secrets() -> HashMap<String, InjectionSecret> {
    [("client:stripe", "sk_live_REAL"), ("client:search", "search-REAL"), ("github", "ghs_REAL")]
        .into_iter()
        .map(|(b, v)| (b.to_string(), InjectionSecret { binding: b.into(), value: v.into(), expires_ms: None }))
        .collect()
}

fn run(host: &str, sec: &HashMap<String, InjectionSecret>, h: &mut HeaderMap) -> Verdict {
    let p = policy();
    apply(&Input { bindings: &p.inject, secrets: sec, host, tls: true, live: true, now_ms: 1000 }, h, &"/v1/x".parse().unwrap())
}

#[test]
fn a_client_secret_is_substituted_on_its_own_hosts() {
    let mut h = HeaderMap::new();
    h.insert(AUTHORIZATION, format!("Bearer {STRIPE}").parse().unwrap());
    assert_eq!(run("api.stripe.com", &secrets(), &mut h), Verdict::Substituted("client:stripe".into()));
    assert_eq!(h[AUTHORIZATION], "Bearer sk_live_REAL");

    // A header location, on a host its `*.` pattern covers.
    let mut h = HeaderMap::new();
    h.insert("x-api-key", SEARCH.parse().unwrap());
    assert_eq!(run("search.example.com", &secrets(), &mut h), Verdict::Substituted("client:search".into()));
    assert_eq!(h["x-api-key"], "search-REAL");

    // A basic password.
    let mut h = HeaderMap::new();
    h.insert(AUTHORIZATION, format!("Basic {}", B64.encode(format!("u:{SEARCH}"))).parse().unwrap());
    assert_eq!(run("a.example.com", &secrets(), &mut h), Verdict::Substituted("client:search".into()));
    assert_eq!(B64.decode(h[AUTHORIZATION].to_str().unwrap().strip_prefix("Basic ").unwrap()).unwrap(), b"u:search-REAL");
}

#[test]
fn a_client_placeholder_anywhere_else_is_blocked_untouched() {
    for host in ["evil.com", "github.com", "example.com", "api.stripe.com.evil.com"] {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, format!("Bearer {STRIPE}").parse().unwrap());
        h.insert("x-api-key", SEARCH.parse().unwrap());
        let v = run(host, &secrets(), &mut h);
        assert!(matches!(&v, Verdict::WrongHost(b) if b.starts_with("client:")), "{host}: {v:?}");
        assert_eq!(h[AUTHORIZATION], format!("Bearer {STRIPE}"), "{host}: untouched");
    }
    // Its secret not pushed (deleted, or its host outside the client's grant now): refused, never sent bare.
    let mut h = HeaderMap::new();
    h.insert(AUTHORIZATION, format!("Bearer {STRIPE}").parse().unwrap());
    let mut sec = secrets();
    sec.remove("client:stripe");
    assert_eq!(run("api.stripe.com", &sec, &mut h), Verdict::Expired("client:stripe".into()));
}

#[test]
fn client_placeholders_and_the_github_one_never_contain_each_other() {
    // nest-proxy finds a placeholder as a substring before it checks the host: one inside another would
    // block (or substitute) the wrong binding.
    let p = policy();
    let phs: Vec<&str> = p.inject.iter().map(|b| b.placeholder.as_str()).collect();
    for a in &phs {
        for b in &phs {
            assert!(a == b || !a.contains(b), "{a} contains {b}");
        }
    }
    // The GitHub placeholder is substituted for its own binding, with client bindings beside it.
    let mut h = HeaderMap::new();
    h.insert(AUTHORIZATION, "Bearer nest-ph-github".parse().unwrap());
    assert_eq!(run("github.com", &secrets(), &mut h), Verdict::Substituted("github".into()));
}
