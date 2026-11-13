//! The seam for an API client that ports the GitHub rules into its own request guards (the projects app,
//! `projects/src/github-access.ts`, phase B3 of principle 10's plan): for its project's repo `by77er/nest`,
//! a worker's guards (`egress_policy.app_github_push.json`) and a reader's (`…_read.json`), in wire form
//! (`client:<name>`, `injected: client:<binding>`), which a projects vitest asserts the app still builds.
//! Here nest-proxy's own evaluator decides GitHub's real request shapes against them. These are the
//! client's guards alone: every other guard of the policy (the operator's, the constructor's) refuses on
//! its own besides.

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, refusing};
use nest_proxy::inject::Whole;

fn fixture(name: &str) -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// How a request arrives: no credential nest substituted, one substituted somewhere, or one written whole
/// into `Authorization` (git's Basic password, gh's `token`), by `binding`.
#[derive(Clone, Copy)]
enum Cred {
    None,
    Somewhere(&'static str),
    Auth(&'static str),
}

/// `(host, method, target, body, credential, refused)`.
type Case = (&'static str, &'static str, &'static str, Option<&'static str>, Cred, bool);

fn check(p: &EgressPolicy, cases: &[Case]) {
    for &(host, method, target, body, cred, want) in cases {
        let (path, query) = target.split_once('?').map_or((target, None), |(a, b)| (a, Some(b)));
        let (injected, whole) = match cred {
            Cred::None => (None, vec![]),
            Cred::Somewhere(b) => (Some(b), vec![]),
            Cred::Auth(b) => (Some(b), vec![Whole { header: "authorization".into(), binding: b.into() }]),
        };
        let json = body.and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok());
        let view = match (body, &json) {
            (None, _) => BodyView::Unread,
            (Some(_), Some(v)) => BodyView::Json(v),
            (Some(_), None) => BodyView::Unknown,
        };
        let req = Req { host, method, path, query, injected, whole: &whole };
        let got = refusing(&p.guards, &req.prepare().unwrap(), &view).map(|g| g.name.clone());
        assert_eq!(got.is_some(), want, "{method} {host}{target}: {got:?}");
        if let Some(name) = got {
            assert!(name.starts_with("client:"), "{name}");
        }
    }
}

const PUSH: &str = "client:gh_push";
const READ: &str = "client:gh_read";

#[test]
fn a_worker_pushes_and_writes_only_to_its_project_repo() {
    let p = fixture("egress_policy.app_github_push.json");
    let cases: &[Case] = &[
        // git smart HTTP: discovery bare (git's first request), then the push with nest's credential
        ("github.com", "GET", "/by77er/nest.git/info/refs?service=git-receive-pack", None, Cred::None, false),
        ("github.com", "POST", "/by77er/nest.git/git-receive-pack", None, Cred::Auth(PUSH), false),
        ("github.com", "POST", "/BY77ER/Nest/git-receive-pack", None, Cred::Auth(PUSH), false),
        ("github.com", "POST", "/attacker/x.git/git-receive-pack", None, Cred::Auth(PUSH), true),
        ("github.com", "GET", "/attacker/x.git/info/refs?service=git-receive-pack", None, Cred::None, true),
        ("github.com", "POST", "/by77er/nest/../../attacker/x/git-receive-pack", None, Cred::Auth(PUSH), true),
        ("github.com", "POST", "/by77er/ne%73t/git-receive-pack", None, Cred::Auth(PUSH), true),
        ("github.com", "POST", "/by77er/nest-fork.git/git-receive-pack", None, Cred::Auth(PUSH), true),
        // fetches of anything
        ("github.com", "POST", "/torvalds/linux.git/git-upload-pack", None, Cred::None, false),
        ("github.com", "POST", "/by77er/nest.git/git-upload-pack", None, Cred::Auth(PUSH), false),
        // LFS: downloads anywhere, uploads only to the repo
        ("github.com", "POST", "/attacker/x.git/info/lfs/objects/batch", Some(r#"{"operation":"upload"}"#), Cred::None, true),
        ("github.com", "POST", "/attacker/x.git/info/lfs/objects/batch", Some(r#"{"operation":"download"}"#), Cred::None, false),
        ("github.com", "POST", "/by77er/nest.git/info/lfs/objects/batch", Some(r#"{"operation":"upload"}"#), Cred::None, false),
        // web forms with someone's cookie
        ("github.com", "POST", "/attacker/x/issues/new", None, Cred::None, true),
        // the REST API: the repo's own paths (gh pr create's REST forms, a branch delete)
        ("api.github.com", "POST", "/repos/by77er/nest/pulls", None, Cred::Auth(PUSH), false),
        ("api.github.com", "DELETE", "/repos/By77er/Nest/git/refs/heads%2Ftask%2Fx", None, Cred::Auth(PUSH), false),
        ("api.github.com", "POST", "/repos/attacker/x/pulls", None, Cred::Auth(PUSH), true),
        ("api.github.com", "POST", "/user/repos", None, Cred::Auth(PUSH), true),
        ("api.github.com", "POST", "/gists", None, Cred::Auth(PUSH), true),
        ("api.github.com", "GET", "/repos/attacker/x", None, Cred::None, false),
        // GraphQL (gh pr create, gh api graphql): only with the sandbox's own token, written whole in Authorization
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::Auth(PUSH), false),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::Somewhere(PUSH), true),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::Auth(READ), true),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::None, true),
        // other GitHub hosts: gists and the content hosts take no write
        ("uploads.github.com", "POST", "/repos/by77er/nest/releases/1/assets", None, Cred::Auth(PUSH), false),
        ("uploads.github.com", "POST", "/repos/attacker/x/releases/1/assets", None, Cred::Auth(PUSH), true),
        ("gist.github.com", "POST", "/0123abcd.git/git-receive-pack", None, Cred::Auth(PUSH), true),
        ("objects.githubusercontent.com", "PUT", "/upload/x", None, Cred::Auth(PUSH), true),
        ("raw.githubusercontent.com", "GET", "/by77er/nest/main/README.md", None, Cred::None, false),
        // not GitHub's
        ("example.com", "POST", "/attacker/x.git/git-receive-pack", None, Cred::None, false),
    ];
    check(&p, cases);
}

#[test]
fn a_reader_fetches_and_never_writes() {
    let p = fixture("egress_policy.app_github_read.json");
    let cases: &[Case] = &[
        ("github.com", "GET", "/by77er/nest.git/info/refs?service=git-upload-pack", None, Cred::Auth(READ), false),
        ("github.com", "POST", "/by77er/nest.git/git-upload-pack", None, Cred::Auth(READ), false),
        ("github.com", "GET", "/by77er/nest.git/info/refs?service=git-receive-pack", None, Cred::None, true),
        ("github.com", "POST", "/by77er/nest.git/git-receive-pack", None, Cred::Auth(READ), true),
        ("github.com", "POST", "/by77er/nest.git/info/lfs/objects/batch", Some(r#"{"operation":"upload"}"#), Cred::Auth(READ), true),
        ("api.github.com", "GET", "/repos/by77er/nest/pulls/7", None, Cred::Auth(READ), false),
        ("api.github.com", "POST", "/repos/by77er/nest/issues/7/comments", None, Cred::Auth(READ), true),
        ("api.github.com", "POST", "/repos/by77er/nest/pulls/7/reviews", None, Cred::Auth(READ), true),
        // GraphQL with the read token (it can't write); never with another's
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"{viewer{login}}"}"#), Cred::Auth(READ), false),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::Auth(PUSH), true),
        ("api.github.com", "POST", "/graphql", Some(r#"{"query":"mutation{}"}"#), Cred::Somewhere(READ), true),
    ];
    check(&p, cases);
}
