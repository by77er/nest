//! What deciding one request costs the shared proxy (guards run on its workers, for every sandbox on
//! the host). Two shapes a sandbox's guards may take, each within the control plane's per-sandbox
//! bounds or past them, against the worst request a guest can send:
//! - many scope matchers (`/**` plus query names), which once decoded the path and query per matcher;
//! - many exceptions with query and body matchers, which the body pre-pass walked whatever the scope.
//!
//! A target past the guarded bounds is refused before any matcher runs; one within them is decided
//! in well under the budget below, which the per-matcher decoding missed by orders of magnitude.

use std::time::{Duration, Instant};

use nest_protocol::model::{HostPattern, JsonFieldMatch, QueryMatch, RequestGuard, RequestMatch};
use nest_proxy::guard::{
    self, BodyView, MAX_GUARDED_PATH, MAX_GUARDED_QUERY, MAX_GUARDED_QUERY_PAIRS, MAX_GUARDED_SEGMENTS, Req, TooLong,
};

/// Per request, in a debug build on a loaded CI runner: generous, yet far below what the old evaluator took.
const BUDGET: Duration = Duration::from_millis(250);

fn queries(n: usize) -> Vec<QueryMatch> {
    (0..n).map(|i| QueryMatch { name: format!("q{i}"), values: vec![] }).collect()
}

/// 32 guards with 64 scope matchers between them: `/**` and four query names each.
fn scope_heavy() -> Vec<RequestGuard> {
    (0..32)
        .map(|i| RequestGuard {
            name: format!("client:s{i}"),
            hosts: vec![HostPattern("h.test".into())],
            scope: (0..2).map(|_| RequestMatch { path: Some("/**".into()), query: queries(4), ..Default::default() }).collect(),
            allow: vec![],
            reason: String::new(),
            ignore_case: true,
        })
        .collect()
}

/// Guards whose scope covers everything, with 534 exceptions of four query names and a body field.
fn allow_heavy() -> Vec<RequestGuard> {
    let body = || Some(JsonFieldMatch { pointer: "/op".into(), values: vec!["read".into()] });
    (0..9)
        .map(|i| RequestGuard {
            name: format!("client:a{i}"),
            hosts: vec![HostPattern("h.test".into())],
            scope: vec![RequestMatch::default()],
            allow: (0..60).map(|_| RequestMatch { query: queries(4), body_json: body(), ..Default::default() }).collect(),
            reason: String::new(),
            ignore_case: true,
        })
        .collect()
}

/// Prepare, the body pre-pass and the decision, as the proxy runs them; how long it took.
fn decide(guards: &[RequestGuard], path: &str, query: &str) -> (Result<bool, TooLong>, Duration) {
    let t = Instant::now();
    let req = Req { host: "h.test", method: "POST", path, query: Some(query), injected: None };
    let out = req.prepare().map(|p| {
        let nb = guard::needs_body(guards, &p);
        let body = serde_json::json!({"op": "write"});
        let view = if nb { BodyView::Json(&body) } else { BodyView::Unread };
        guard::refusing(guards, &p, &view).is_some()
    });
    (out, t.elapsed())
}

/// A path of `segs` one-byte segments of decodable junk, and a query of `pairs` encoded pairs, each within `bytes`.
fn target(path_bytes: usize, segs: usize, query_bytes: usize, pairs: usize) -> (String, String) {
    let seg = "%2e".repeat(((path_bytes / segs).saturating_sub(1) / 3).max(1));
    let path: String = (0..segs).map(|_| format!("/{seg}")).collect::<String>().chars().take(path_bytes).collect();
    // Raw names every matcher's query entries hit (`q0`..`q3`), so each looks further; encoded values to decode.
    let q: String = (0..pairs).map(|i| format!("q{}=%2541%2541", i % 4)).collect::<Vec<_>>().join("&").chars().take(query_bytes).collect();
    (path, q)
}

#[test]
fn oversized_targets_are_refused_before_any_matcher() {
    // The review's probe: a path of about 128 KiB and a query of about 256 KiB.
    let (path, query) = target(128 << 10, 30_000, 256 << 10, 16_000);
    for guards in [scope_heavy(), allow_heavy()] {
        let (out, took) = decide(&guards, &path, &query);
        assert_eq!(out, Err(TooLong));
        eprintln!("oversized: {took:?}");
        assert!(took < BUDGET, "{took:?}");
    }
}

#[test]
fn a_target_within_the_bounds_is_decided_within_budget() {
    let (path, query) = target(MAX_GUARDED_PATH, MAX_GUARDED_SEGMENTS, MAX_GUARDED_QUERY, MAX_GUARDED_QUERY_PAIRS);
    assert!(path.len() <= MAX_GUARDED_PATH && query.len() <= MAX_GUARDED_QUERY, "{} {}", path.len(), query.len());
    for (name, guards) in [("scope-heavy", scope_heavy()), ("allow-heavy", allow_heavy())] {
        let (out, took) = decide(&guards, &path, &query);
        assert!(out.is_ok(), "{name}: within the bounds");
        eprintln!("{name}: {took:?}");
        assert!(took < BUDGET, "{name}: {took:?}");
    }
}
