//! The evaluator decodes a request once ([`Req::prepare`]) instead of per matcher. This checks that it
//! decides exactly as the evaluator before that change did (copied below as `reference`, unchanged),
//! over generated requests and guards: paths and queries built from the characters that matter to
//! decoding and normalization (`%`, `.`, `/`, `\`, `;`, `+`, `=`, `&`, case), against patterns with
//! literals, `*` and `**`, query and body matchers. Within the guarded bounds the two must agree on
//! every request, the body pre-pass aside: `needs_body` may now say no where the old one said yes
//! (a guard none of whose scope can match), never the other way round.
//!
//! `injected: "*"` (any substituted binding) came later: the new evaluator decides a guard naming it as
//! the previous one decides that guard with `*` replaced by the binding the request carries. The
//! previous one, which is also the previous release's nest-proxy (equal to it within the bounds, above),
//! reads `*` as a binding's name: `an_old_proxy_reads_any_as_a_name` shows that this refuses at least as
//! much where `*` is only in exceptions, and can refuse less where it is in a scope (why the control
//! plane gates `*` on hosts that know it).

use nest_protocol::model::{HostPattern, INJECTED_ANY, JsonFieldMatch, QueryMatch, RequestGuard, RequestMatch};
use nest_proxy::guard;

#[allow(dead_code, clippy::all)]
mod reference {

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
}

/// A small deterministic generator (xorshift), so a failure replays.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[self.below(xs.len())]
    }
}

const SEGS: &[&str] = &["a", "A", "b", "mine", "MINE", "x", "", ".", "..", "%2e", "%2E%2e", "%252e%252e", "a%2Fb", "%61", "a;p=1", "a\\b", "%5c", "deposit", "dep%6fsit"];
const PATS: &[&str] = &["a", "A", "b", "mine", "x", "*", "**", "deposit", "%61"];
const KEYS: &[&str] = &["op", "OP", "o%70", "x", "op+", "", "a"];
const VALS: &[&str] = &["read", "READ", "re%61d", "write", "", "w+r", "%2B"];

fn path(r: &mut Rng) -> String {
    let n = r.below(6);
    let mut p = String::new();
    for _ in 0..n.max(1) {
        p.push('/');
        p.push_str(r.pick(SEGS));
    }
    if r.below(5) == 0 {
        p.push('/');
    }
    p
}

fn query(r: &mut Rng) -> Option<String> {
    if r.below(3) == 0 {
        return None;
    }
    let n = r.below(4);
    let parts: Vec<String> = (0..n)
        .map(|_| match r.below(4) {
            0 => r.pick(KEYS).to_string(),
            _ => format!("{}={}", r.pick(KEYS), r.pick(VALS)),
        })
        .collect();
    Some(parts.join(if r.below(4) == 0 { ";" } else { "&" }))
}

fn pattern(r: &mut Rng) -> String {
    if r.below(12) == 0 {
        return "no-slash".into();
    }
    let n = 1 + r.below(4);
    (0..n).map(|_| format!("/{}", r.pick(PATS))).collect()
}

fn matcher(r: &mut Rng) -> RequestMatch {
    let mut m = RequestMatch::default();
    if r.below(3) == 0 {
        m.methods = vec![["GET", "POST", "put"][r.below(3)].into()];
    }
    if r.below(5) == 0 {
        m.methods_except = vec!["GET".into()];
    }
    if r.below(2) == 0 {
        m.path = Some(pattern(r));
    }
    if r.below(3) == 0 {
        let values = if r.below(2) == 0 { vec![] } else { vec![r.pick(VALS).to_string()] };
        m.query = vec![QueryMatch { name: r.pick(KEYS).to_string(), values }];
    }
    if r.below(4) == 0 {
        m.body_json = Some(JsonFieldMatch { pointer: "/op".into(), values: vec!["read".into()] });
    }
    if r.below(5) == 0 {
        m.injected = Some(["svc", "other", "*"][r.below(3)].into());
    }
    m
}

fn guard_(r: &mut Rng, i: usize) -> RequestGuard {
    RequestGuard {
        name: format!("g{i}"),
        hosts: vec![HostPattern(["h.test", "*.h.test"][r.below(2)].into())],
        scope: (0..1 + r.below(3)).map(|_| matcher(r)).collect(),
        allow: (0..r.below(4)).map(|_| matcher(r)).collect(),
        reason: String::new(),
        ignore_case: r.below(2) == 0,
    }
}

#[test]
fn decides_as_the_evaluator_before_it_did() {
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    let read = serde_json::json!({"op": "read"});
    let write = serde_json::json!({"op": "write"});
    for case in 0..40_000 {
        let guards: Vec<RequestGuard> = (0..1 + r.below(3)).map(|i| guard_(&mut r, i)).collect();
        let (p, q) = (path(&mut r), query(&mut r));
        let host = ["h.test", "x.h.test", "other.test"][r.below(3)];
        let method = ["GET", "POST", "PUT", "get"][r.below(4)];
        let injected = [None, Some("svc"), Some("other")][r.below(3)];
        let old = reference::Req { host, method, path: &p, query: q.as_deref(), injected };
        let new = guard::Req { host, method, path: &p, query: q.as_deref(), injected };
        let prep = new.prepare().expect("small requests are within the bounds");
        let ctx = format!("case {case}: {method} {host}{p}?{q:?} injected {injected:?} guards {guards:#?}");
        // What `*` means: the binding this request carries (with none, `*` names no binding it carries).
        let resolved = resolve_any(&guards, injected);
        let guards = &guards;
        let old_nb = reference::needs_body(&resolved, &old);
        let new_nb = guard::needs_body(guards, &prep);
        assert!(old_nb || !new_nb, "needs_body widened: {ctx}");
        for (ob, nb) in [
            (reference::BodyView::Unread, guard::BodyView::Unread),
            (reference::BodyView::Unknown, guard::BodyView::Unknown),
            (reference::BodyView::Json(&read), guard::BodyView::Json(&read)),
            (reference::BodyView::Json(&write), guard::BodyView::Json(&write)),
        ] {
            let o = reference::refusing(&resolved, &old, &ob).map(|g| g.name.clone());
            let n = guard::refusing(guards, &prep, &nb).map(|g| g.name.clone());
            assert_eq!(o, n, "{ctx}");
        }
        // Where the new pre-pass reads no body, the decision can't depend on it.
        if !new_nb {
            let decisions: Vec<_> = [guard::BodyView::Unread, guard::BodyView::Unknown, guard::BodyView::Json(&read), guard::BodyView::Json(&write)]
                .iter()
                .map(|b| guard::refusing(guards, &prep, b).map(|g| g.name.clone()))
                .collect();
            assert!(decisions.windows(2).all(|w| w[0] == w[1]), "body read skipped but it decides: {ctx}");
        }
    }
}

/// The guards with every `injected: "*"` replaced by the binding `injected` names (left as it is with
/// none: the previous evaluator matches no name against a request that carries none).
fn resolve_any(guards: &[RequestGuard], injected: Option<&str>) -> Vec<RequestGuard> {
    let fix = |m: &RequestMatch| RequestMatch {
        injected: m.injected.as_deref().map(|b| if b == INJECTED_ANY { injected.unwrap_or(b) } else { b }.to_string()),
        ..m.clone()
    };
    guards.iter().map(|g| RequestGuard { scope: g.scope.iter().map(fix).collect(), allow: g.allow.iter().map(fix).collect(), ..g.clone() }).collect()
}

/// `guards` with `injected: "*"` kept only in exceptions (a scope's becomes the name `svc`).
fn any_only_in_exceptions(guards: &[RequestGuard]) -> Vec<RequestGuard> {
    let named = |m: &RequestMatch| RequestMatch {
        injected: m.injected.as_deref().map(|b| if b == INJECTED_ANY { "svc" } else { b }.to_string()),
        ..m.clone()
    };
    guards.iter().map(|g| RequestGuard { scope: g.scope.iter().map(named).collect(), ..g.clone() }).collect()
}

/// A previous-release nest-proxy given `injected: "*"` (it reads `*` as a binding's name, which no
/// binding has). In an exception that only refuses more: it fails closed, so the control plane needn't
/// keep such a guard off an old host. In a scope it refuses less: it fails open, so the control plane
/// places a sandbox whose guards name `*` in a scope only on a host that says `guard_injected_any`.
#[test]
fn an_old_proxy_reads_any_as_a_name() {
    let mut r = Rng(0xD1B5_4A32_D192_ED03);
    let read = serde_json::json!({"op": "read"});
    let (mut stricter, mut looser) = (0, 0);
    for case in 0..40_000 {
        let generated: Vec<RequestGuard> = (0..1 + r.below(3)).map(|i| guard_(&mut r, i)).collect();
        let (p, q) = (path(&mut r), query(&mut r));
        let host = ["h.test", "x.h.test"][r.below(2)];
        let method = ["GET", "POST", "PUT"][r.below(3)];
        let injected = [None, Some("svc"), Some("other"), Some("client:svc")][r.below(4)];
        let old = reference::Req { host, method, path: &p, query: q.as_deref(), injected };
        let prep = guard::Req { host, method, path: &p, query: q.as_deref(), injected }.prepare().expect("small requests are within the bounds");
        for body in [reference::BodyView::Unread, reference::BodyView::Unknown, reference::BodyView::Json(&read)] {
            let new_body = match body {
                reference::BodyView::Unread => guard::BodyView::Unread,
                reference::BodyView::Unknown => guard::BodyView::Unknown,
                reference::BodyView::Json(v) => guard::BodyView::Json(v),
            };
            // Only in exceptions: whatever the new proxy refuses, the old one refuses too.
            let guards = any_only_in_exceptions(&generated);
            let (o, n) = (reference::refusing(&guards, &old, &body).is_some(), guard::refusing(&guards, &prep, &new_body).is_some());
            assert!(o || !n, "case {case}: an old proxy let through what a new one refuses, with * only in exceptions: {method} {host}{p}?{q:?} injected {injected:?} guards {guards:#?}");
            stricter += usize::from(o && !n);
            // Anywhere: an old proxy can let through what a new one refuses (a scope's `*` matches nothing there).
            looser += usize::from(!reference::refusing(&generated, &old, &body).is_some() && guard::refusing(&generated, &prep, &new_body).is_some());
        }
    }
    // Neither side is vacuous: an exception's `*` lets requests through on a new proxy that an old one
    // refuses, and a scope's `*` refuses requests on a new proxy that an old one lets through.
    assert!(stricter > 0 && looser > 0, "stricter {stricter}, looser {looser}");
}
