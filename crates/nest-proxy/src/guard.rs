//! Request guards (docs/sandbox/networking/egress/policy/#request-guards): generic request rules
//! evaluated on every inspected or plaintext request after credential injection. A guard names hosts,
//! a scope and exceptions; a request its scope covers is refused unless an exception covers it too.
//!
//! This module knows hosts, methods, paths, query parameters, one JSON body field and whether a
//! binding was substituted. It knows nothing about any service: what a guard means (say, "pushes
//! only to these repos") is built by a constructor in the control plane.
//!
//! Matching errs towards refusing. A scope matches a request if it matches the path as sent **or**
//! the path decoded and normalized (percent-decoding, `\` as `/`, empty and dot segments, `;params`),
//! so an encoding can't step out of a scope. An exception matches only a clean path as sent: the
//! safe-path rules (no `\`, `#`, NUL, `//`, dot segments, raw or encoded), with its literals compared
//! to the segments as sent, so an encoded or `;`-suffixed name never equals one. A body the proxy can't read (encoded, too large, not JSON) is in scope and never
//! an exception.

use nest_protocol::model::{JsonFieldMatch, QueryMatch, RequestGuard, RequestMatch};

/// The longest request path an exception can match (the injection safe-path limit).
const MAX_PATH: usize = 2048;
/// Decoding rounds for scope matching (`%252e` → `%2e` → `.`).
const DECODE_ROUNDS: usize = 3;

/// The request as a guard sees it.
pub struct Req<'a> {
    pub host: &'a str,
    pub method: &'a str,
    /// The path as sent (no query).
    pub path: &'a str,
    pub query: Option<&'a str>,
    /// The binding whose credential the proxy substituted into this request, if any.
    pub injected: Option<&'a str>,
}

/// What the proxy knows of the request body.
pub enum BodyView<'a> {
    /// Not read: no matcher needs it.
    Unread,
    /// Read, but not usable: encoded, larger than the limit, or not JSON.
    Unknown,
    Json(&'a serde_json::Value),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Scope,
    Allow,
}

/// Whether a guard applies to `host`.
pub fn covers(g: &RequestGuard, host: &str) -> bool {
    g.hosts.iter().any(|h| h.matches(host))
}

/// Whether deciding this request needs its body: some matcher of a guard on its host looks at the
/// body and everything else about it matches.
pub fn needs_body(guards: &[RequestGuard], req: &Req<'_>) -> bool {
    guards.iter().filter(|g| covers(g, req.host)).any(|g| {
        g.scope.iter().map(|m| (m, Mode::Scope)).chain(g.allow.iter().map(|m| (m, Mode::Allow))).any(|(m, mode)| {
            m.body_json.is_some() && matches(m, req, None, g.ignore_case, mode)
        })
    })
}

/// The first guard that refuses this request, if any.
pub fn refusing<'g>(guards: &'g [RequestGuard], req: &Req<'_>, body: &BodyView<'_>) -> Option<&'g RequestGuard> {
    guards.iter().find(|g| {
        covers(g, req.host)
            && g.scope.iter().any(|m| matches(m, req, Some(body), g.ignore_case, Mode::Scope))
            && !g.allow.iter().any(|m| matches(m, req, Some(body), g.ignore_case, Mode::Allow))
    })
}

/// `body: None` ignores the body matcher (the pre-pass that decides whether to read it).
fn matches(m: &RequestMatch, req: &Req<'_>, body: Option<&BodyView<'_>>, ic: bool, mode: Mode) -> bool {
    if !m.methods.is_empty() && !m.methods.iter().any(|x| x.eq_ignore_ascii_case(req.method)) {
        return false;
    }
    if m.methods_except.iter().any(|x| x.eq_ignore_ascii_case(req.method)) {
        return false;
    }
    if let Some(b) = &m.injected
        && req.injected != Some(b.as_str())
    {
        return false;
    }
    if let Some(p) = &m.path {
        let ok = match mode {
            Mode::Scope => path_in_scope(p, req.path, ic),
            Mode::Allow => path_excepted(p, req.path, ic),
        };
        if !ok {
            return false;
        }
    }
    if !m.query.iter().all(|q| query_matches(q, req.query.unwrap_or(""), ic, mode)) {
        return false;
    }
    match (&m.body_json, body) {
        (None, _) | (Some(_), None) => true,
        (Some(f), Some(b)) => body_matches(f, b, mode),
    }
}

// --- paths ---------------------------------------------------------------------------------------

#[derive(Debug)]
enum Seg<'a> {
    Lit(&'a str),
    One,
    Any,
}

/// A pattern's segments; `None` for one that doesn't start with `/`.
fn pattern(p: &str) -> Option<Vec<Seg<'_>>> {
    let rest = p.strip_prefix('/')?;
    Some(
        rest.split('/')
            .map(|s| match s {
                "*" => Seg::One,
                "**" => Seg::Any,
                s => Seg::Lit(s),
            })
            .collect(),
    )
}

/// Segment glob: a literal equals the segment (without ASCII case when `ic`), `*` is one non-empty
/// segment, `**` any number.
fn glob(pat: &[Seg<'_>], segs: &[&str], ic: bool) -> bool {
    match pat.split_first() {
        None => segs.is_empty(),
        Some((Seg::Any, rest)) => (0..=segs.len()).any(|i| glob(rest, &segs[i..], ic)),
        Some((Seg::One, rest)) => segs.split_first().is_some_and(|(s, tail)| !s.is_empty() && glob(rest, tail, ic)),
        Some((Seg::Lit(l), rest)) => {
            segs.split_first().is_some_and(|(s, tail)| (if ic { s.eq_ignore_ascii_case(l) } else { s == l }) && glob(rest, tail, ic))
        }
    }
}

/// In scope if the pattern matches the path as sent or normalized. A pattern that isn't one
/// (no leading `/`) is in scope everywhere: a broken guard refuses rather than lets through.
fn path_in_scope(p: &str, path: &str, ic: bool) -> bool {
    let Some(pat) = pattern(p) else { return true };
    let raw: Vec<&str> = path.strip_prefix('/').unwrap_or(path).split('/').collect();
    if glob(&pat, &raw, ic) {
        return true;
    }
    let norm = normalize(path);
    let norm: Vec<&str> = norm.iter().map(String::as_str).collect();
    glob(&pat, &norm, ic)
}

/// An exception matches only a clean path, as sent.
fn path_excepted(p: &str, path: &str, ic: bool) -> bool {
    let Some(pat) = pattern(p) else { return false };
    if !clean_path(path) {
        return false;
    }
    let segs: Vec<&str> = path[1..].split('/').collect();
    glob(&pat, &segs, ic)
}

/// The injection safe-path rules, plus no segment that decodes to a dot segment.
fn clean_path(path: &str) -> bool {
    if !path.starts_with('/') || path.len() > MAX_PATH || path.contains(['\\', '#', '\0', '?']) || path.contains("//") {
        return false;
    }
    path[1..].split('/').all(|s| {
        let d = decode_repeatedly(s, false);
        s != "." && s != ".." && !d.split(['/', '\\']).any(|p| p == "." || p == "..")
    })
}

/// Decoded, `\` as `/`, `;params` cut, empty and `.` segments dropped, `..` applied.
fn normalize(path: &str) -> Vec<String> {
    let d = decode_repeatedly(path, false).replace('\\', "/");
    let mut out: Vec<String> = Vec::new();
    for s in d.split('/') {
        let s = s.split(';').next().unwrap_or("");
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s.to_string()),
        }
    }
    out
}

// --- queries and bodies --------------------------------------------------------------------------------

fn query_matches(q: &QueryMatch, raw: &str, ic: bool, mode: Mode) -> bool {
    let eq = |a: &str, b: &str| if ic { a.eq_ignore_ascii_case(b) } else { a == b };
    raw.split(['&', ';']).filter(|p| !p.is_empty()).any(|pair| {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let hit = |k: &str, v: &str| eq(k, &q.name) && (q.values.is_empty() || q.values.iter().any(|x| eq(v, x)));
        match mode {
            // Exceptions match only what was sent literally.
            Mode::Allow => hit(k, v),
            Mode::Scope => hit(k, v) || hit(&decode_repeatedly(k, true), &decode_repeatedly(v, true)),
        }
    })
}

fn body_matches(f: &JsonFieldMatch, b: &BodyView<'_>, mode: Mode) -> bool {
    let hit = match b {
        BodyView::Json(v) => v.pointer(&f.pointer).and_then(|x| x.as_str()).map(|s| f.values.iter().any(|x| x == s)),
        BodyView::Unread | BodyView::Unknown => None,
    };
    match mode {
        // Unreadable, or the field missing: assume the worst.
        Mode::Scope => hit.unwrap_or(true),
        Mode::Allow => hit.unwrap_or(false),
    }
}

// --- percent-decoding ----------------------------------------------------------------------------------

fn decode_repeatedly(s: &str, plus: bool) -> String {
    let mut cur = if plus { s.replace('+', " ") } else { s.to_string() };
    for _ in 0..DECODE_ROUNDS {
        let next = decode(&cur);
        if next == cur {
            break;
        }
        cur = next;
    }
    cur
}

/// One round of `%XX` decoding; anything malformed stays as it is. Invalid UTF-8 is replaced.
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && let (Some(h), Some(l)) = (b.get(i + 1).and_then(|c| (*c as char).to_digit(16)), b.get(i + 2).and_then(|c| (*c as char).to_digit(16)))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    //! Generic rules only: the hosts and paths here are made up, so nothing depends on a service.
    use super::*;
    use nest_protocol::model::HostPattern;

    fn m(methods: &[&str], path: Option<&str>) -> RequestMatch {
        RequestMatch { methods: methods.iter().map(|s| s.to_string()).collect(), path: path.map(str::to_string), ..Default::default() }
    }

    /// Writes under `/store/**` on `files.test` are refused except under `/store/mine/`.
    fn store_guard(ic: bool) -> RequestGuard {
        RequestGuard {
            name: "store-write".into(),
            hosts: vec![HostPattern("files.test".into()), HostPattern("*.files.test".into())],
            scope: vec![RequestMatch { methods_except: vec!["GET".into(), "HEAD".into()], ..Default::default() }],
            allow: vec![m(&[], Some("/store/mine/**")), m(&["POST"], Some("/*/read"))],
            reason: "writes only to mine".into(),
            ignore_case: ic,
        }
    }

    fn req<'a>(host: &'a str, method: &'a str, path: &'a str) -> Req<'a> {
        Req { host, method, path, query: None, injected: None }
    }

    fn refused(g: &RequestGuard, r: &Req<'_>) -> bool {
        refusing(std::slice::from_ref(g), r, &BodyView::Unread).is_some()
    }

    #[test]
    fn scope_exceptions_methods_and_hosts() {
        let g = store_guard(false);
        for (host, method, path, want) in [
            ("files.test", "GET", "/store/theirs/x", false), // out of scope: a read
            ("files.test", "head", "/store/theirs/x", false), // methods compare without case
            ("files.test", "POST", "/store/theirs/x", true),
            ("files.test", "PROPFIND", "/store/theirs/x", true), // any method but the excepted ones
            ("files.test", "post", "/store/theirs/x", true),
            ("files.test", "PUT", "/store/mine/x", false),
            ("files.test", "PUT", "/store/mine", false), // `**` matches nothing too
            ("files.test", "POST", "/a/read", false),
            ("files.test", "PUT", "/a/read", true), // the exception names POST only
            ("files.test", "POST", "/a/b/read", true), // `*` is one segment
            ("files.test", "POST", "//read", true), // and never an empty one
            ("eu.files.test", "POST", "/store/theirs/x", true), // a wildcard host
            ("FILES.test.", "POST", "/store/theirs/x", true),
            ("other.test", "POST", "/store/theirs/x", false), // not its host
        ] {
            assert_eq!(refused(&g, &req(host, method, path)), want, "{method} {host}{path}");
        }
    }

    #[test]
    fn case_follows_ignore_case() {
        assert!(refused(&store_guard(false), &req("files.test", "PUT", "/STORE/MINE/x")));
        assert!(!refused(&store_guard(true), &req("files.test", "PUT", "/STORE/MINE/x")));
    }

    #[test]
    fn encodings_and_dot_segments_never_reach_an_exception() {
        let g = store_guard(true);
        for path in [
            "/store/mi%6Ee/x",        // an encoded literal
            "/store/mine/../theirs/x", // dot segments
            "/store/mine/%2e%2e/theirs/x",
            "/store/mine/%252e%252e/theirs/x", // double-encoded
            "/store/mine/a%2F..%2F..%2Ftheirs", // an encoded slash hiding dot segments
            "/store//mine/x",
            "/store/mine\\..\\theirs",
            "/store/mine;x=1/x",
            "/store/mine/./x",
        ] {
            assert!(refused(&g, &req("files.test", "PUT", path)), "{path}");
        }
        // Encodings under a wildcard are fine (APIs encode their parameters).
        assert!(!refused(&g, &req("files.test", "PUT", "/store/mine/refs%2Fheads%2Fmain")));
        let long = format!("/store/mine/{}", "a".repeat(MAX_PATH));
        assert!(refused(&g, &req("files.test", "PUT", &long)));
    }

    /// A scope on a path, so it must catch the path however it's spelled.
    fn push_guard() -> RequestGuard {
        RequestGuard {
            name: "deposit".into(),
            hosts: vec![HostPattern("vault.test".into())],
            scope: vec![
                m(&[], Some("/**/deposit")),
                RequestMatch {
                    path: Some("/**/info".into()),
                    query: vec![QueryMatch { name: "op".into(), values: vec!["deposit".into()] }],
                    ..Default::default()
                },
            ],
            allow: vec![m(&[], Some("/me/box/**"))],
            reason: String::new(),
            ignore_case: true,
        }
    }

    #[test]
    fn a_path_scope_catches_every_spelling() {
        let g = push_guard();
        for path in [
            "/them/box/deposit",
            "/them/box/DEPOSIT",
            "/them/box/dep%6fsit",
            "/them/box/deposit/",
            "/them/box/deposit;x",
            "/them//box/deposit",
            "/me/box/../../them/box/deposit",
            "/me/box/%2e%2e/%2e%2e/them/deposit",
            "/them\\box\\deposit",
            "/deposit",
        ] {
            assert!(refused(&g, &req("vault.test", "POST", path)), "{path}");
        }
        assert!(!refused(&g, &req("vault.test", "POST", "/me/box/deposit")));
        assert!(!refused(&g, &req("vault.test", "POST", "/them/box/withdraw")));
    }

    #[test]
    fn query_scope_decodes_and_any_pair_counts() {
        let g = push_guard();
        let q = |query: &'static str| Req { host: "vault.test", method: "GET", path: "/them/box/info", query: Some(query), injected: None };
        for (query, want) in [
            ("op=deposit", true),
            ("OP=Deposit", true),
            ("op=dep%6Fsit", true),
            ("op=withdraw&op=deposit", true),
            ("x=1;op=deposit", true),
            ("op=withdraw", false),
            ("", false),
        ] {
            assert_eq!(refused(&g, &q(query)), want, "{query}");
        }
        let mine = Req { host: "vault.test", method: "GET", path: "/me/box/info", query: Some("op=deposit"), injected: None };
        assert!(!refused(&g, &mine));
    }

    #[test]
    fn query_exception_matches_only_literal_values() {
        let g = RequestGuard {
            name: "q".into(),
            hosts: vec![HostPattern("q.test".into())],
            scope: vec![m(&[], None)],
            allow: vec![RequestMatch { query: vec![QueryMatch { name: "mode".into(), values: vec!["read".into()] }], ..Default::default() }],
            reason: String::new(),
            ignore_case: false,
        };
        let q = |query: &'static str| Req { host: "q.test", method: "GET", path: "/", query: Some(query), injected: None };
        assert!(!refused(&g, &q("mode=read")));
        assert!(refused(&g, &q("mode=re%61d")));
        assert!(refused(&g, &q("mode=write")));
    }

    fn body_guard() -> RequestGuard {
        RequestGuard {
            name: "batch".into(),
            hosts: vec![HostPattern("b.test".into())],
            scope: vec![m(&["POST"], Some("/batch"))],
            allow: vec![RequestMatch {
                methods: vec!["POST".into()],
                path: Some("/batch".into()),
                body_json: Some(JsonFieldMatch { pointer: "/op".into(), values: vec!["read".into()] }),
                ..Default::default()
            }],
            reason: String::new(),
            ignore_case: false,
        }
    }

    #[test]
    fn body_field_exception_and_unreadable_bodies() {
        let g = body_guard();
        let r = req("b.test", "POST", "/batch");
        assert!(needs_body(std::slice::from_ref(&g), &r));
        assert!(!needs_body(std::slice::from_ref(&g), &req("b.test", "POST", "/other")));
        assert!(!needs_body(std::slice::from_ref(&g), &req("other.test", "POST", "/batch")));
        let read = serde_json::json!({"op": "read"});
        let write = serde_json::json!({"op": "write"});
        let missing = serde_json::json!({});
        let number = serde_json::json!({"op": 1});
        let decide = |b: BodyView<'_>| refusing(std::slice::from_ref(&g), &r, &b).is_some();
        assert!(!decide(BodyView::Json(&read)));
        assert!(decide(BodyView::Json(&write)));
        assert!(decide(BodyView::Json(&missing)));
        assert!(decide(BodyView::Json(&number)));
        assert!(decide(BodyView::Unknown));
        assert!(decide(BodyView::Unread));
    }

    #[test]
    fn body_scope_assumes_the_worst() {
        let g = RequestGuard {
            name: "uploads".into(),
            hosts: vec![HostPattern("b.test".into())],
            scope: vec![RequestMatch { body_json: Some(JsonFieldMatch { pointer: "/op".into(), values: vec!["write".into()] }), ..Default::default() }],
            allow: vec![],
            reason: String::new(),
            ignore_case: false,
        };
        let r = req("b.test", "POST", "/x");
        let read = serde_json::json!({"op": "read"});
        let decide = |b: BodyView<'_>| refusing(std::slice::from_ref(&g), &r, &b).is_some();
        assert!(!decide(BodyView::Json(&read)));
        assert!(decide(BodyView::Json(&serde_json::json!({"op": "write"}))));
        assert!(decide(BodyView::Unknown));
        assert!(decide(BodyView::Json(&serde_json::json!([]))));
    }

    #[test]
    fn injected_exception_needs_that_binding() {
        let g = RequestGuard {
            name: "api".into(),
            hosts: vec![HostPattern("api.test".into())],
            scope: vec![m(&["POST"], None)],
            allow: vec![RequestMatch { injected: Some("svc".into()), ..m(&["POST"], Some("/query")) }],
            reason: String::new(),
            ignore_case: false,
        };
        let r = |injected: Option<&'static str>| Req { host: "api.test", method: "POST", path: "/query", query: None, injected };
        assert!(!refused(&g, &r(Some("svc"))));
        assert!(refused(&g, &r(Some("other"))));
        assert!(refused(&g, &r(None)));
    }

    #[test]
    fn every_guard_must_pass_and_a_broken_pattern_refuses() {
        let a = store_guard(false);
        let mut b = store_guard(false);
        b.name = "second".into();
        b.allow = vec![];
        let guards = [a, b];
        let r = req("files.test", "PUT", "/store/mine/x");
        assert_eq!(refusing(&guards, &r, &BodyView::Unread).map(|g| g.name.as_str()), Some("second"));
        let broken = RequestGuard { scope: vec![m(&[], Some("no-slash"))], allow: vec![m(&[], Some("no-slash"))], ..store_guard(false) };
        assert!(refused(&broken, &req("files.test", "GET", "/anything")));
    }
}
