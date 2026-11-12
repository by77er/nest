//! Request guards (docs/sandbox/networking/egress/policy/#request-guards): generic request rules
//! evaluated on every inspected or plaintext request after credential injection. A guard names hosts,
//! a scope and exceptions; a request its scope covers is refused unless an exception covers it too.
//!
//! This module knows hosts, methods, paths, query parameters, one JSON body field and whether a
//! binding was substituted (a named one, or any: `injected: "*"`). It knows nothing about any
//! service: what a guard means (say, "pushes only to these repos") is built by a constructor in the
//! control plane.
//!
//! Matching errs towards refusing. A scope matches a request if it matches the path as sent **or**
//! the path decoded and normalized (percent-decoding, `\` as `/`, empty and dot segments, `;params`),
//! so an encoding can't step out of a scope. An exception matches only a clean path as sent: the
//! safe-path rules (no `\`, `#`, NUL, `//`, dot segments, raw or encoded), with its literals compared
//! to the segments as sent, so an encoded or `;`-suffixed name never equals one. A body the proxy can't read (encoded, too large, not JSON) is in scope and never
//! an exception.
//!
//! Cost: guards run on the proxy's shared workers, so a request is decoded and normalized once
//! ([`Req::prepare`]), not per matcher, and on a guarded host a path or query past the
//! `MAX_GUARDED_*` bounds is refused rather than decided. Each matcher then costs time linear in the
//! bounded path and query (a pattern with one `**`).

use nest_protocol::model::{INJECTED_ANY, JsonFieldMatch, QueryMatch, RequestGuard, RequestMatch};

/// The longest request path an exception can match (the injection safe-path limit).
const MAX_PATH: usize = 2048;
/// Decoding rounds for scope matching (`%252e` → `%2e` → `.`).
const DECODE_ROUNDS: usize = 3;

/// On a guarded host, the longest path the proxy decides (bytes as sent); a longer one is refused.
pub const MAX_GUARDED_PATH: usize = 4096;
/// On a guarded host, the most path segments, as sent or normalized; more are refused.
pub const MAX_GUARDED_SEGMENTS: usize = 256;
/// On a guarded host, the longest query string the proxy decides (bytes as sent); a longer one is refused.
pub const MAX_GUARDED_QUERY: usize = 8192;
/// On a guarded host, the most query parameters; more are refused.
pub const MAX_GUARDED_QUERY_PAIRS: usize = 256;

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

/// A request target over the bounds a guarded host's requests are decided within: refused, never
/// decided (deciding costs time in its length for every matcher).
#[derive(Debug, PartialEq, Eq)]
pub struct TooLong;

/// A request decoded once for every guard and matcher: its path's segments as sent and normalized,
/// whether it is clean (an exception can match it at all), and its query's pairs as sent and decoded.
pub struct Prepared<'a> {
    host: &'a str,
    method: &'a str,
    injected: Option<&'a str>,
    raw: Vec<&'a str>,
    norm: Vec<String>,
    clean: bool,
    pairs: Vec<(&'a str, &'a str)>,
    decoded: Vec<(String, String)>,
}

impl<'a> Req<'a> {
    /// Decode the request once, within the bounds a guarded host's requests are decided in.
    pub fn prepare(&self) -> Result<Prepared<'a>, TooLong> {
        let query = self.query.unwrap_or("");
        if self.path.len() > MAX_GUARDED_PATH || query.len() > MAX_GUARDED_QUERY {
            return Err(TooLong);
        }
        let raw: Vec<&'a str> = self.path.strip_prefix('/').unwrap_or(self.path).split('/').collect();
        let pairs: Vec<(&'a str, &'a str)> =
            query.split(['&', ';']).filter(|p| !p.is_empty()).map(|pair| pair.split_once('=').unwrap_or((pair, ""))).collect();
        if raw.len() > MAX_GUARDED_SEGMENTS || pairs.len() > MAX_GUARDED_QUERY_PAIRS {
            return Err(TooLong);
        }
        let norm = normalize(self.path);
        if norm.len() > MAX_GUARDED_SEGMENTS {
            return Err(TooLong);
        }
        let decoded = pairs.iter().map(|(k, v)| (decode_repeatedly(k, true), decode_repeatedly(v, true))).collect();
        Ok(Prepared {
            host: self.host,
            method: self.method,
            injected: self.injected,
            raw,
            norm,
            clean: clean_path(self.path),
            pairs,
            decoded,
        })
    }
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

/// Whether deciding this request needs its body: a guard on its host has a scope matcher that matches
/// it whatever its body (a body matcher counted as matching), and a body matcher of that guard's scope
/// or exceptions matches everything else about it. A guard none of whose scope can match doesn't refuse,
/// whatever the body says.
pub fn needs_body(guards: &[RequestGuard], req: &Prepared<'_>) -> bool {
    guards.iter().filter(|g| covers(g, req.host)).any(|g| {
        g.scope.iter().any(|m| matches(m, req, None, g.ignore_case, Mode::Scope))
            && g.scope.iter().map(|m| (m, Mode::Scope)).chain(g.allow.iter().map(|m| (m, Mode::Allow))).any(|(m, mode)| {
                m.body_json.is_some() && matches(m, req, None, g.ignore_case, mode)
            })
    })
}

/// The first guard that refuses this request, if any.
pub fn refusing<'g>(guards: &'g [RequestGuard], req: &Prepared<'_>, body: &BodyView<'_>) -> Option<&'g RequestGuard> {
    guards.iter().find(|g| {
        covers(g, req.host)
            && g.scope.iter().any(|m| matches(m, req, Some(body), g.ignore_case, Mode::Scope))
            && !g.allow.iter().any(|m| matches(m, req, Some(body), g.ignore_case, Mode::Allow))
    })
}

/// `body: None` ignores the body matcher (the pre-pass that decides whether to read it).
fn matches(m: &RequestMatch, req: &Prepared<'_>, body: Option<&BodyView<'_>>, ic: bool, mode: Mode) -> bool {
    if !m.methods.is_empty() && !m.methods.iter().any(|x| x.eq_ignore_ascii_case(req.method)) {
        return false;
    }
    if m.methods_except.iter().any(|x| x.eq_ignore_ascii_case(req.method)) {
        return false;
    }
    if let Some(b) = &m.injected
        && !injected_matches(b, req.injected)
    {
        return false;
    }
    if let Some(p) = &m.path {
        let ok = match mode {
            Mode::Scope => path_in_scope(p, req, ic),
            Mode::Allow => path_excepted(p, req, ic),
        };
        if !ok {
            return false;
        }
    }
    if !m.query.iter().all(|q| query_matches(q, req, ic, mode)) {
        return false;
    }
    match (&m.body_json, body) {
        (None, _) | (Some(_), None) => true,
        (Some(f), Some(b)) => body_matches(f, b, mode),
    }
}

/// `injected`: the request had that binding's credential substituted, or any binding's for
/// [`INJECTED_ANY`]. Never when nothing was substituted.
fn injected_matches(want: &str, substituted: Option<&str>) -> bool {
    substituted.is_some_and(|b| want == INJECTED_ANY || want == b)
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
fn glob<S: AsRef<str>>(pat: &[Seg<'_>], segs: &[S], ic: bool) -> bool {
    #[cfg(test)]
    GLOB_STEPS.with(|d| d.set(d.get() + 1));
    match pat.split_first() {
        None => segs.is_empty(),
        // A tail with no `**` matches exactly as many segments as it has, so only the split that leaves
        // that many can match: one `**` costs time linear in the path, not in the path times the tail.
        Some((Seg::Any, rest)) if !rest.iter().any(|s| matches!(s, Seg::Any)) => {
            segs.len() >= rest.len() && glob(rest, &segs[segs.len() - rest.len()..], ic)
        }
        Some((Seg::Any, rest)) => (0..=segs.len()).any(|i| glob(rest, &segs[i..], ic)),
        Some((Seg::One, rest)) => segs.split_first().is_some_and(|(s, tail)| !s.as_ref().is_empty() && glob(rest, tail, ic)),
        Some((Seg::Lit(l), rest)) => segs.split_first().is_some_and(|(s, tail)| {
            let s = s.as_ref();
            (if ic { s.eq_ignore_ascii_case(l) } else { s == *l }) && glob(rest, tail, ic)
        }),
    }
}

/// In scope if the pattern matches the path as sent or normalized. A pattern that isn't one
/// (no leading `/`) is in scope everywhere: a broken guard refuses rather than lets through.
fn path_in_scope(p: &str, req: &Prepared<'_>, ic: bool) -> bool {
    let Some(pat) = pattern(p) else { return true };
    glob(&pat, &req.raw, ic) || glob(&pat, &req.norm, ic)
}

/// An exception matches only a clean path, as sent.
fn path_excepted(p: &str, req: &Prepared<'_>, ic: bool) -> bool {
    let Some(pat) = pattern(p) else { return false };
    req.clean && glob(&pat, &req.raw, ic)
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

fn query_matches(q: &QueryMatch, req: &Prepared<'_>, ic: bool, mode: Mode) -> bool {
    let eq = |a: &str, b: &str| if ic { a.eq_ignore_ascii_case(b) } else { a == b };
    let hit = |k: &str, v: &str| eq(k, &q.name) && (q.values.is_empty() || q.values.iter().any(|x| eq(v, x)));
    match mode {
        // Exceptions match only what was sent literally.
        Mode::Allow => req.pairs.iter().any(|(k, v)| hit(k, v)),
        Mode::Scope => req.pairs.iter().zip(&req.decoded).any(|((k, v), (dk, dv))| hit(k, v) || hit(dk, dv)),
    }
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

#[cfg(test)]
thread_local! {
    /// Decodes on this thread: a test pins that matching decodes nothing (`prepare` decodes once).
    static DECODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    /// Glob steps on this thread: a test pins that one `**` costs time linear in the path.
    static GLOB_STEPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

fn decode_repeatedly(s: &str, plus: bool) -> String {
    #[cfg(test)]
    DECODES.with(|d| d.set(d.get() + 1));
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
        refusing(std::slice::from_ref(g), &r.prepare().unwrap(), &BodyView::Unread).is_some()
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
        let r = req("b.test", "POST", "/batch").prepare().unwrap();
        assert!(needs_body(std::slice::from_ref(&g), &r));
        assert!(!needs_body(std::slice::from_ref(&g), &req("b.test", "POST", "/other").prepare().unwrap()));
        assert!(!needs_body(std::slice::from_ref(&g), &req("other.test", "POST", "/batch").prepare().unwrap()));
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
        let r = req("b.test", "POST", "/x").prepare().unwrap();
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
    fn injected_any_needs_some_binding_substituted() {
        let any = || RequestMatch { injected: Some(INJECTED_ANY.into()), ..m(&["POST"], None) };
        let r = |injected: Option<&'static str>| Req { host: "api.test", method: "POST", path: "/query", query: None, injected };
        // In an exception: any substituted binding lets the write through; none doesn't.
        let floor = RequestGuard {
            name: "floor".into(),
            hosts: vec![HostPattern("api.test".into())],
            scope: vec![m(&["POST"], None)],
            allow: vec![any()],
            reason: String::new(),
            ignore_case: false,
        };
        for b in ["svc", "other", "client:svc"] {
            assert!(!refused(&floor, &r(Some(b))), "{b}");
        }
        assert!(refused(&floor, &r(None)));
        // In a scope: it covers a request with any substituted binding, and none without.
        let no_creds = RequestGuard { name: "no-creds".into(), scope: vec![any()], allow: vec![], ..floor.clone() };
        assert!(refused(&no_creds, &r(Some("svc"))) && refused(&no_creds, &r(Some("client:x"))));
        assert!(!refused(&no_creds, &r(None)));
        // Only `*` itself is the wildcard: a pattern-looking name is a name.
        let named = RequestGuard { allow: vec![RequestMatch { injected: Some("s*".into()), ..m(&["POST"], None) }], ..floor };
        assert!(refused(&named, &r(Some("svc"))));
    }

    #[test]
    fn a_guard_whose_scope_cannot_match_never_reads_the_body() {
        // Exceptions that look at the body, but a scope this request is outside: the body can't matter.
        let g = RequestGuard { scope: vec![m(&["PUT"], None)], ..body_guard() };
        assert!(!needs_body(std::slice::from_ref(&g), &req("b.test", "POST", "/batch").prepare().unwrap()));
        // In scope, but the only body exception is for another method.
        assert!(!needs_body(std::slice::from_ref(&g), &req("b.test", "PUT", "/batch").prepare().unwrap()));
        // In scope and the exception's other fields match: the body decides.
        let g = RequestGuard { scope: vec![m(&[], None)], ..body_guard() };
        assert!(needs_body(std::slice::from_ref(&g), &req("b.test", "POST", "/batch").prepare().unwrap()));
    }

    #[test]
    fn matching_decodes_nothing_the_request_was_decoded_once() {
        // Scope matchers this request misses, so each is tried in full (its path as sent and normalized,
        // its query as sent and decoded), and exceptions on queries: none decodes the request again.
        let path_scope = m(&[], Some("/**/deposit"));
        let query_scope = RequestMatch { query: vec![QueryMatch { name: "op".into(), values: vec!["deposit".into()] }], ..Default::default() };
        let g = RequestGuard {
            scope: (0..50).flat_map(|_| [path_scope.clone(), query_scope.clone()]).collect(),
            allow: (0..50).map(|_| RequestMatch { query: vec![QueryMatch { name: "op".into(), values: vec![] }], ..Default::default() }).collect(),
            ..push_guard()
        };
        let r = Req { host: "vault.test", method: "POST", path: "/a%2e/b%2Fc/withdraw", query: Some("op=with%64raw&x=%2541"), injected: None };
        let before = DECODES.with(|d| d.get());
        let p = r.prepare().unwrap();
        let prepared = DECODES.with(|d| d.get()) - before;
        assert!(prepared > 0);
        assert!(!needs_body(std::slice::from_ref(&g), &p));
        assert!(refusing(std::slice::from_ref(&g), &p, &BodyView::Unread).is_none());
        assert_eq!(DECODES.with(|d| d.get()) - before, prepared, "a matcher decoded the request again");
    }

    #[test]
    fn one_double_star_tries_only_the_split_its_tail_fits() {
        let g = RequestGuard { scope: vec![m(&[], Some("/**/a/*/a/b"))], allow: vec![], ..push_guard() };
        let path = "/a".repeat(MAX_GUARDED_SEGMENTS - 1);
        let r = Req { host: "vault.test", method: "GET", path: &path, query: None, injected: None }.prepare().unwrap();
        let before = GLOB_STEPS.with(|d| d.get());
        assert!(refusing(std::slice::from_ref(&g), &r, &BodyView::Unread).is_none());
        // Two forms (as sent and normalized), each one split of at most five steps.
        assert!(GLOB_STEPS.with(|d| d.get()) - before <= 12, "{}", GLOB_STEPS.with(|d| d.get()) - before);
        let hit = format!("{path}/b");
        let r = Req { host: "vault.test", method: "GET", path: &hit, query: None, injected: None }.prepare().unwrap();
        assert!(refusing(std::slice::from_ref(&g), &r, &BodyView::Unread).is_some());
    }

    #[test]
    fn targets_past_the_guarded_bounds_are_not_decided() {
        let ok = |path: &str, query: Option<&str>| Req { host: "h.test", method: "GET", path, query, injected: None }.prepare().is_ok();
        assert!(ok(&format!("/{}", "a".repeat(MAX_GUARDED_PATH - 1)), None));
        assert!(!ok(&format!("/{}", "a".repeat(MAX_GUARDED_PATH)), None));
        assert!(ok(&"/a".repeat(MAX_GUARDED_SEGMENTS), None));
        assert!(!ok(&"/a".repeat(MAX_GUARDED_SEGMENTS + 1), None));
        // Normalizing can make segments (an encoded `/`): counted too.
        assert!(!ok(&format!("/{}", "a%2F".repeat(MAX_GUARDED_SEGMENTS + 1)), None));
        assert!(ok(&format!("/{}", "a%2F".repeat(MAX_GUARDED_SEGMENTS)), None));
        assert!(ok("/", Some(&"x".repeat(MAX_GUARDED_QUERY))));
        assert!(!ok("/", Some(&"x".repeat(MAX_GUARDED_QUERY + 1))));
        assert!(ok("/", Some(&vec!["a=1"; MAX_GUARDED_QUERY_PAIRS].join("&"))));
        assert!(!ok("/", Some(&vec!["a=1"; MAX_GUARDED_QUERY_PAIRS + 1].join("&"))));
    }

    #[test]
    fn every_guard_must_pass_and_a_broken_pattern_refuses() {
        let a = store_guard(false);
        let mut b = store_guard(false);
        b.name = "second".into();
        b.allow = vec![];
        let guards = [a, b];
        let r = req("files.test", "PUT", "/store/mine/x").prepare().unwrap();
        assert_eq!(refusing(&guards, &r, &BodyView::Unread).map(|g| g.name.as_str()), Some("second"));
        let broken = RequestGuard { scope: vec![m(&[], Some("no-slash"))], allow: vec![m(&[], Some("no-slash"))], ..store_guard(false) };
        assert!(refused(&broken, &req("files.test", "GET", "/anything")));
    }
}
