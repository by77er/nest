//! An operator's floor in the base layer, as data (docs/sandbox/networking/egress/policy/#base-layer): the
//! fixture `protocol/fixtures/control/egress_policy/egress_policy.base_floor.json` holds guards an operator
//! writes with `PUT /v1/admin/egress/base`, here for GitHub's hosts (a vitest asserts the control plane
//! carries them to a sandbox's policy as written). nest builds none of them; here the proxy's own evaluator
//! decides real request shapes against them: `injected: "*"` with `at`, path anchoring and encoded
//! separators, on data an operator actually writes. Only its guards are the base layer's; its `allow` is
//! an example (the live layer allows more hosts, on ports 80 and 443).

use nest_protocol::model::EgressPolicy;
use nest_proxy::guard::{BodyView, Req, refusing};
use nest_proxy::inject::Whole;

fn fixture() -> EgressPolicy {
    let p = format!("{}/../../protocol/fixtures/control/egress_policy/egress_policy.base_floor.json", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// `(host, method, target, injected, whole, refused)`.
type WholeCase<'a> = (&'a str, &'a str, &'a str, Option<&'a str>, &'a [Whole], bool);

/// A write passes only when its one `Authorization` field is a credential nest's injection wrote whole (an
/// app's own binding, say `client:gh`); push discovery goes bare, as git sends it before its 401; gists and
/// the content hosts take no write at all.
#[test]
fn a_floor_lets_writes_through_only_with_a_credential_nest_injected() {
    let p = fixture();
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
        // LFS's API with nest's credential: in Authorization, through; whole in another header, refused
        ("github.com", "POST", "/me/box.git/info/lfs/objects/batch", Some("client:gh"), &auth, false),
        ("github.com", "POST", "/me/box.git/info/lfs/locks", Some("client:gh"), &auth, false),
        ("github.com", "POST", "/me/box.git/info/lfs/locks/12/unlock", Some("client:gh"), &auth, false),
        ("github.com", "POST", "/me/box.git/info/lfs/locks", Some("client:gh"), &other, true),
        ("github.com", "POST", "/me/box.git/info/lfs/objects/batch", Some("client:gh"), &other, true),
        // github.com's web routes authenticate by cookie, which `at` never sees: refused whatever Authorization carries
        ("github.com", "POST", "/me/box/tree-save/main/README.md", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/upload/policies/assets", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/_graphql", Some("client:gh"), &auth, true),
        ("github.com", "DELETE", "/anything", Some("client:gh"), &auth, true),
        ("github.com", "PUT", "/me/box.git/git-receive-pack", Some("client:gh"), &auth, true),
        // The web editor's routes end in a path the user chooses: never taken for git's or LFS's, whatever they end in
        ("github.com", "POST", "/me/box/tree-save/main/git-receive-pack", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/me/box/tree-save/main/info/lfs/locks", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/me/box/create/main/info/lfs/objects/batch", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/me/box/delete/main/x/info/lfs/locks/verify", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/settings/git-receive-pack", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/attacker/drop/tree-save/main/git-upload-pack", None, &[], true),
        // ...nor one whose slashes are encoded, which a server that decodes them reads as the editor's: a segment
        // holding a separator once decoded is matched by no exception (an older nest-proxy matched it)
        ("github.com", "POST", "/me/box%2Ftree-save%2Fmain/git-receive-pack", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/me/box%252Ftree-save%252Fmain/git-receive-pack", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/me/box%5Ctree-save%5Cmain/info/lfs/locks", Some("client:gh"), &auth, true),
        ("github.com", "POST", "/attacker/drop%2Ftree-save%2Fmain/git-upload-pack", None, &[], true),
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
