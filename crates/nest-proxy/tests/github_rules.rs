//! The seam between the control plane's GitHub rule constructor (`control-plane/src/lib/rules/github.ts`)
//! and the proxy's generic evaluator: the constructor's output for `by77er/nest` and `by77er/nest-fork`
//! is the fixture `protocol/fixtures/control/egress_policy/egress_policy.github.json` (a vitest asserts
//! the constructor still produces it), with read-only repos `egress_policy.github_read.json`, and in a
//! sandbox where nest injects no GitHub token of its own `egress_policy.github_none.json`; here the
//! proxy evaluates real GitHub request shapes against them.

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, refusing};
use nest_proxy::inject::Whole;

fn fixture(name: &str) -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn policy() -> EgressPolicy {
    fixture("egress_policy.github.json")
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
    check(&p, cases);
    assert!(p.guarded("github.com") && p.guarded("api.github.com") && p.guarded("raw.githubusercontent.com"));
}

/// The constructor's output for push allowlist `by77er/nest` and read-only repos `by77er/private-lib`
/// and `by77er/nest` (a repo on both is pushable): `egress_policy.github_read.json`, which a vitest
/// asserts the constructor still produces. A read-only repo is fetched and never written.
#[test]
fn read_only_repos_are_fetched_never_written() {
    let p = fixture("egress_policy.github_read.json");
    let cases: &[Case] = &[
        // pushes into the read-only repo, in each shape
        ("github.com", "POST", "/by77er/private-lib.git/git-receive-pack", None, None, true),
        ("github.com", "POST", "/by77er/private-lib/git-receive-pack", None, None, true),
        ("github.com", "POST", "/By77er/Private-Lib.git/git-receive-pack", None, None, true),
        ("github.com", "GET", "/by77er/private-lib.git/info/refs?service=git-receive-pack", None, None, true),
        ("github.com", "POST", "/by77er/private-lib.git/git-receive-pack", None, Some("github_read"), true),
        ("github.com", "POST", "/by77er/private-lib.git/info/lfs/objects/batch", Some(r#"{"operation":"upload"}"#), None, true),
        // fetches of it
        ("github.com", "GET", "/by77er/private-lib.git/info/refs?service=git-upload-pack", None, Some("github_read"), false),
        ("github.com", "POST", "/by77er/private-lib.git/git-upload-pack", None, Some("github_read"), false),
        ("github.com", "POST", "/by77er/private-lib.git/info/lfs/objects/batch", Some(r#"{"operation":"download"}"#), None, false),
        // its REST API: reads only
        ("api.github.com", "GET", "/repos/by77er/private-lib/contents/README.md", None, Some("github_read"), false),
        ("api.github.com", "PUT", "/repos/by77er/private-lib/contents/a.txt", None, Some("github_read"), true),
        ("api.github.com", "POST", "/repos/by77er/private-lib/pulls", None, Some("github"), true),
        ("api.github.com", "DELETE", "/repos/by77er/private-lib/git/refs/heads%2Fmain", None, None, true),
        // the allowlist's repo is still pushable
        ("github.com", "POST", "/by77er/nest.git/git-receive-pack", None, Some("github"), false),
        ("api.github.com", "POST", "/repos/by77er/nest/pulls", None, Some("github"), false),
        // GraphQL with either of the sandbox's own tokens (the read-only one can't write), never without
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"{viewer{login}}"}"#), Some("github_read"), false),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Some("github"), false),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), None, true),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Some("other"), true),
    ];
    check(&p, cases);
}

/// `(host, method, target, injected, whole, refused)`.
type WholeCase<'a> = (&'a str, &'a str, &'a str, Option<&'a str>, &'a [Whole], bool);

/// The constructor's output where nest injects no GitHub token of its own (no repos, no operator GitHub
/// binding): `egress_policy.github_none.json`. A write passes only when its one `Authorization` field is a
/// credential nest's injection wrote whole (an app's own binding, say `client:gh`); push discovery goes
/// bare, as git sends it before its 401; gists and the content hosts take no write at all.
#[test]
fn without_nests_own_token_writes_need_a_credential_nest_injected() {
    let p = fixture("egress_policy.github_none.json");
    let auth = [Whole { header: "authorization".into(), binding: "client:gh".into() }];
    let other = [Whole { header: "x-api-key".into(), binding: "client:gh".into() }];
    let cases: &[WholeCase] = &[
        // git: discovery bare (git's first request), the push itself only with nest's credential in Authorization
        ("github.com", "GET", "/me/box.git/info/refs?service=git-receive-pack", None, &[], false),
        ("github.com", "POST", "/me/box.git/git-receive-pack", Some("client:gh"), &auth, false),
        ("github.com", "POST", "/me/box.git/git-receive-pack", None, &[], true),
        ("github.com", "POST", "/me/box.git/git-receive-pack", Some("client:gh"), &[], true),
        ("github.com", "POST", "/me/box.git/git-receive-pack", Some("client:gh"), &other, true),
        ("github.com", "POST", "/me/box.git/info/lfs/objects/batch", None, &[], true),
        // fetches stay open
        ("github.com", "POST", "/torvalds/linux.git/git-upload-pack", None, &[], false),
        // the API, REST and GraphQL alike
        ("api.github.com", "POST", "/graphql", Some("client:gh"), &auth, false),
        ("api.github.com", "POST", "/graphql", None, &[], true),
        ("api.github.com", "POST", "/repos/me/box/pulls", Some("client:gh"), &auth, false),
        ("api.github.com", "POST", "/gists", None, &[], true),
        ("uploads.github.com", "POST", "/repos/me/box/releases/1/assets", Some("client:gh"), &other, true),
        ("api.github.com", "GET", "/repos/me/box", None, &[], false),
        // gists and the content hosts: never written, whatever the credential
        ("gist.github.com", "POST", "/0123abcd.git/git-receive-pack", Some("client:gh"), &auth, true),
        ("objects.githubusercontent.com", "PUT", "/upload/x", Some("client:gh"), &auth, true),
    ];
    for &(host, method, target, injected, whole, want) in cases {
        let (path, query) = target.split_once('?').map_or((target, None), |(p, q)| (p, Some(q)));
        let req = Req { host, method, path, query, injected, whole };
        let got = refusing(&p.guards, &req.prepare().unwrap(), &BodyView::Unread).map(|g| g.name.clone());
        assert_eq!(got.is_some(), want, "{method} {host}{target} {injected:?}: {got:?}");
    }
}

fn check(p: &EgressPolicy, cases: &[Case]) {
    for &(host, method, target, body, injected, want) in cases {
        let (path, query) = target.split_once('?').map_or((target, None), |(p, q)| (p, Some(q)));
        let json = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
        let view = match (body, &json) {
            (None, _) => BodyView::Unread,
            (Some(_), Some(v)) => BodyView::Json(v),
            (Some(_), None) => BodyView::Unknown,
        };
        let req = Req { host, method, path, query, injected, whole: &[] };
        let got = refusing(&p.guards, &req.prepare().unwrap(), &view).map(|g| g.name.clone());
        assert_eq!(got.is_some(), want, "{method} {host}{target}: {got:?}");
    }
}
