//! The seam between the control plane's GitHub rule constructor (`control-plane/src/lib/rules/github.ts`)
//! and the proxy's generic evaluator: the constructor's output for `by77er/nest` and `by77er/nest-fork`
//! is the fixture `protocol/fixtures/control/egress_policy/egress_policy.github.json` (a vitest asserts
//! the constructor still produces it); here the proxy evaluates real GitHub request shapes against it.

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, refusing};

fn policy() -> EgressPolicy {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../protocol/fixtures/control/egress_policy/egress_policy.github.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// `(host, method, path?query, body, injected, refused)`.
type Case = (&'static str, &'static str, &'static str, Option<&'static str>, Option<&'static str>, bool);

#[test]
fn pushes_and_writes_reach_only_allowed_repos() {
    let p = policy();
    let cases: &[Case] = &[
        // git smart HTTP on github.com
        ("github.com", "POST", "/attacker/repo.git/git-receive-pack", None, None, true),
        ("github.com", "POST", "/attacker/repo/git-receive-pack", None, None, true),
        ("github.com", "GET", "/attacker/repo.git/info/refs?service=git-receive-pack", None, None, true),
        ("github.com", "GET", "/attacker/repo.git/info/refs?service=git%2Dreceive%2Dpack", None, None, true),
        ("github.com", "POST", "/by77er/other.git/git-receive-pack", None, None, true),
        ("github.com", "POST", "/by77er/nest/../../attacker/x/git-receive-pack", None, None, true),
        ("github.com", "POST", "/by77er/ne%73t/git-receive-pack", None, None, true),
        ("github.com", "POST", "/by77er/nest.git/git-receive-pack", None, None, false),
        ("github.com", "POST", "/BY77ER/Nest/git-receive-pack", None, None, false),
        ("github.com", "GET", "/by77er/nest/info/refs?service=git-receive-pack", None, None, false),
        ("github.com", "POST", "/by77er/nest-fork.git/git-receive-pack", None, None, false),
        // fetches of anything stay open
        ("github.com", "POST", "/torvalds/linux.git/git-upload-pack", None, None, false),
        ("github.com", "GET", "/torvalds/linux/info/refs?service=git-upload-pack", None, None, false),
        ("github.com", "GET", "/torvalds/linux", None, None, false),
        // Git LFS
        ("github.com", "POST", "/attacker/repo.git/info/lfs/objects/batch", Some(r#"{"operation":"upload","objects":[]}"#), None, true),
        ("github.com", "POST", "/attacker/repo.git/info/lfs/objects/batch", Some(r#"{"operation":"download","objects":[]}"#), None, false),
        ("github.com", "POST", "/attacker/repo.git/info/lfs/objects/batch", Some("not json"), None, true),
        ("github.com", "POST", "/by77er/nest.git/info/lfs/objects/batch", Some(r#"{"operation":"upload"}"#), None, false),
        ("github.com", "POST", "/attacker/repo.git/info/lfs/locks", Some("{}"), None, true),
        // web forms (someone's cookie)
        ("github.com", "POST", "/attacker/repo/issues/new", None, None, true),
        ("github.com", "POST", "/session", None, None, true),
        // the REST API
        ("api.github.com", "POST", "/repos/attacker/x/pulls", None, None, true),
        ("api.github.com", "PUT", "/repos/attacker/x/contents/a.txt", None, None, true),
        ("api.github.com", "POST", "/user/repos", None, None, true),
        ("api.github.com", "POST", "/gists", None, None, true),
        ("api.github.com", "POST", "/repos/by77er/nest/pulls", None, None, false),
        ("api.github.com", "DELETE", "/repos/By77er/Nest/git/refs/heads%2Ffeature", None, None, false),
        ("api.github.com", "POST", "/repos/by77er/nest/../../attacker/x/pulls", None, None, true),
        ("api.github.com", "GET", "/repos/attacker/x", None, None, false),
        // GraphQL: only with the sandbox's own (narrowed) token
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Some("github"), false),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), None, true),
        // other GitHub hosts
        ("uploads.github.com", "POST", "/repos/attacker/x/releases/1/assets", None, None, true),
        ("uploads.github.com", "POST", "/repos/by77er/nest/releases/1/assets", None, None, false),
        ("www.github.com", "POST", "/attacker/repo.git/git-receive-pack", None, None, true),
        ("gist.github.com", "POST", "/0123abcd.git/git-receive-pack", None, None, true),
        ("gist.github.com", "GET", "/0123abcd.git/info/refs?service=git-receive-pack", None, None, true),
        ("gist.github.com", "GET", "/0123abcd", None, None, false),
        ("objects.githubusercontent.com", "PUT", "/upload/x", None, None, true),
        ("raw.githubusercontent.com", "GET", "/by77er/nest/main/README.md", None, None, false),
        // not GitHub's
        ("example.com", "POST", "/attacker/repo.git/git-receive-pack", None, None, false),
    ];
    for &(host, method, target, body, injected, want) in cases {
        let (path, query) = target.split_once('?').map_or((target, None), |(p, q)| (p, Some(q)));
        let json = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
        let view = match (body, &json) {
            (None, _) => BodyView::Unread,
            (Some(_), Some(v)) => BodyView::Json(v),
            (Some(_), None) => BodyView::Unknown,
        };
        let req = Req { host, method, path, query, injected };
        let got = refusing(&p.guards, &req, &view).map(|g| g.name.clone());
        assert_eq!(got.is_some(), want, "{method} {host}{target}: {got:?}");
    }
    assert!(p.guarded("github.com") && p.guarded("api.github.com") && p.guarded("raw.githubusercontent.com"));
}
