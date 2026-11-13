//! Placeholder credential injection. Sandboxes only ever hold placeholders; the proxy substitutes
//! real secrets on inspected (TLS-terminated) requests to the binding's own hosts.

use std::collections::HashMap;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use http::{HeaderMap, HeaderValue, Uri, header::AUTHORIZATION};

use nest_protocol::model::{InjectionBinding, InjectionLocation, InjectionSecret};

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// No placeholder present.
    Clean,
    /// Placeholder(s) substituted for this binding.
    Substituted(String),
    /// Placeholder sent to a host outside its binding: block + alert.
    WrongHost(String),
    /// Placeholder for a matching host but no usable secret (expired / fenced / missing):
    /// block + alert.
    Expired(String),
    /// Placeholder on plaintext HTTP: never substitute, block.
    Plaintext(String),
}

impl Verdict {
    pub fn blocks(&self) -> bool {
        matches!(self, Verdict::WrongHost(_) | Verdict::Expired(_) | Verdict::Plaintext(_))
    }
    pub fn binding(&self) -> Option<&str> {
        match self {
            Verdict::Clean => None,
            Verdict::Substituted(b) | Verdict::WrongHost(b) | Verdict::Expired(b) | Verdict::Plaintext(b) => Some(b),
        }
    }
}

pub struct Input<'a> {
    pub bindings: &'a [InjectionBinding],
    pub secrets: &'a HashMap<String, InjectionSecret>,
    pub host: &'a str,
    pub tls: bool,
    /// Lease valid and sandbox epoch current.
    pub live: bool,
    pub now_ms: i64,
}

/// A header the proxy wrote whole by substituting a binding's credential: the request as forwarded
/// carries exactly one field of it, and that field's whole value is what the substitution produced
/// (`Bearer <secret>`, `Basic <user:secret>`, or a named header that was exactly the placeholder).
/// What a guard's `at` asks about (docs/sandbox/networking/egress/policy/#any-injected-credential).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Whole {
    /// The header's name, lowercase.
    pub header: String,
    pub binding: String,
}

/// Inspect (and, when allowed, rewrite) request headers. The first blocking verdict wins.
pub fn apply(input: &Input<'_>, headers: &mut HeaderMap, uri: &Uri) -> Verdict {
    apply_whole(input, headers, uri).0
}

/// [`apply`], and the headers it wrote whole that are still so once every binding is done.
pub fn apply_whole(input: &Input<'_>, headers: &mut HeaderMap, uri: &Uri) -> (Verdict, Vec<Whole>) {
    let mut substituted: Option<String> = None;
    let mut written: Vec<(http::HeaderName, String, HeaderValue)> = Vec::new();
    for b in input.bindings {
        if b.placeholder.is_empty() || !present(&b.placeholder, headers, uri) {
            continue;
        }
        if !b.hosts.iter().any(|h| h.matches(input.host)) {
            return (Verdict::WrongHost(b.name.clone()), vec![]);
        }
        if !input.tls {
            return (Verdict::Plaintext(b.name.clone()), vec![]);
        }
        let secret = input.secrets.get(&b.name).filter(|s| s.expires_ms.is_none_or(|e| input.now_ms < e));
        let Some(secret) = secret.filter(|_| input.live) else {
            return (Verdict::Expired(b.name.clone()), vec![]);
        };
        let mut wrote = Vec::new();
        if substitute(b, &secret.value, headers, &mut wrote) {
            substituted = Some(b.name.clone());
        }
        written.extend(wrote.into_iter().map(|(name, value)| (name, b.name.clone(), value)));
    }
    // Whole only if nothing later changed it: still the one field of its header, with the value written.
    let whole = written
        .into_iter()
        .filter(|(name, _, value)| {
            let mut all = headers.get_all(name).iter();
            all.next() == Some(value) && all.next().is_none()
        })
        .map(|(name, binding, _)| Whole { header: name.as_str().to_string(), binding })
        .collect();
    (substituted.map_or(Verdict::Clean, Verdict::Substituted), whole)
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

/// Is the placeholder anywhere we can see: any header value (raw or basic-decoded) or the URI?
fn present(ph: &str, headers: &HeaderMap, uri: &Uri) -> bool {
    let needle = ph.as_bytes();
    if contains(uri.to_string().as_bytes(), needle) {
        return true;
    }
    headers.iter().any(|(name, v)| {
        contains(v.as_bytes(), needle)
            || (name == AUTHORIZATION || name.as_str().eq_ignore_ascii_case("proxy-authorization"))
                && basic_decode(v).is_some_and(|d| contains(&d, needle))
    })
}

fn basic_decode(v: &HeaderValue) -> Option<Vec<u8>> {
    let s = v.to_str().ok()?;
    let (scheme, rest) = s.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("basic") {
        return None;
    }
    B64.decode(rest.trim()).ok()
}

/// Substitute `b`'s secret at its locations; `wrote` gets each header field it wrote whole, with its value.
fn substitute(b: &InjectionBinding, secret: &str, headers: &mut HeaderMap, wrote: &mut Vec<(http::HeaderName, HeaderValue)>) -> bool {
    let mut done = false;
    for loc in &b.locations {
        match loc {
            InjectionLocation::AuthorizationBearer => {
                if let Some(v) = headers.get(AUTHORIZATION).and_then(|v| v.to_str().ok())
                    && let Some((scheme, token)) = v.split_once(' ')
                    && (scheme.eq_ignore_ascii_case("bearer") || scheme.eq_ignore_ascii_case("token"))
                    && token.trim() == b.placeholder
                    && let Ok(nv) = HeaderValue::from_str(&format!("{scheme} {secret}"))
                {
                    // `insert` replaces every Authorization field: the request then carries this one only.
                    let nv = sensitive(nv);
                    headers.insert(AUTHORIZATION, nv.clone());
                    wrote.push((AUTHORIZATION, nv));
                    done = true;
                }
            }
            InjectionLocation::AuthorizationBasicPassword => {
                if let Some(decoded) = headers.get(AUTHORIZATION).and_then(basic_decode)
                    && let Ok(decoded) = String::from_utf8(decoded)
                    && let Some((user, pass)) = decoded.split_once(':')
                    && pass == b.placeholder
                {
                    let enc = B64.encode(format!("{user}:{secret}"));
                    if let Ok(nv) = HeaderValue::from_str(&format!("Basic {enc}")) {
                        let nv = sensitive(nv);
                        headers.insert(AUTHORIZATION, nv.clone());
                        wrote.push((AUTHORIZATION, nv));
                        done = true;
                    }
                }
            }
            InjectionLocation::Header { name } => {
                let Ok(hn) = http::HeaderName::from_bytes(name.as_bytes()) else { continue };
                let values: Vec<HeaderValue> = headers.get_all(&hn).iter().cloned().collect();
                if values.iter().any(|v| contains(v.as_bytes(), b.placeholder.as_bytes())) {
                    headers.remove(&hn);
                    for v in values {
                        let nv = match v.to_str() {
                            Ok(s) if s.contains(&b.placeholder) => {
                                HeaderValue::from_str(&s.replace(&b.placeholder, secret)).map(sensitive).unwrap_or(v)
                            }
                            _ => v,
                        };
                        // Whole only when the field is now exactly the secret (it was exactly the
                        // placeholder): a value with anything beside the placeholder is partly the
                        // sandbox's. One field of several is dropped when `apply_whole` checks.
                        if nv.as_bytes() == secret.as_bytes() {
                            wrote.push((hn.clone(), nv.clone()));
                        }
                        headers.append(&hn, nv);
                    }
                    done = true;
                }
            }
        }
    }
    done
}

fn sensitive(mut v: HeaderValue) -> HeaderValue {
    v.set_sensitive(true);
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use nest_protocol::model::HostPattern;

    fn binding() -> InjectionBinding {
        InjectionBinding {
            name: "github".into(),
            hosts: vec![HostPattern("github.com".into()), HostPattern("*.githubusercontent.com".into())],
            placeholder: "nest-ph-github-7f3a".into(),
            locations: vec![
                InjectionLocation::AuthorizationBearer,
                InjectionLocation::AuthorizationBasicPassword,
                InjectionLocation::Header { name: "X-Api-Key".into() },
            ],
        }
    }

    fn secrets(expires: Option<i64>) -> HashMap<String, InjectionSecret> {
        [("github".to_string(), InjectionSecret { binding: "github".into(), value: "ghs_REAL".into(), expires_ms: expires })]
            .into()
    }

    fn run(host: &str, tls: bool, live: bool, sec: &HashMap<String, InjectionSecret>, h: &mut HeaderMap, uri: &str) -> Verdict {
        let b = [binding()];
        apply(&Input { bindings: &b, secrets: sec, host, tls, live, now_ms: 1000 }, h, &uri.parse().unwrap())
    }

    #[test]
    fn bearer_substituted_for_matching_host() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(run("github.com", true, true, &secrets(None), &mut h, "/"), Verdict::Substituted("github".into()));
        assert_eq!(h[AUTHORIZATION], "Bearer ghs_REAL");
        assert!(h[AUTHORIZATION].is_sensitive());
    }

    #[test]
    fn basic_password_substituted() {
        let mut h = HeaderMap::new();
        let enc = B64.encode("x-access-token:nest-ph-github-7f3a");
        h.insert(AUTHORIZATION, format!("Basic {enc}").parse().unwrap());
        assert_eq!(
            run("raw.githubusercontent.com", true, true, &secrets(None), &mut h, "/"),
            Verdict::Substituted("github".into())
        );
        let dec = B64.decode(h[AUTHORIZATION].to_str().unwrap().strip_prefix("Basic ").unwrap()).unwrap();
        assert_eq!(dec, b"x-access-token:ghs_REAL");
    }

    #[test]
    fn custom_header_substituted() {
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "k=nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(run("github.com", true, true, &secrets(None), &mut h, "/"), Verdict::Substituted("github".into()));
        assert_eq!(h["x-api-key"], "k=ghs_REAL");
    }

    #[test]
    fn wrong_host_blocks_even_in_url_or_basic() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(run("evil.com", true, true, &secrets(None), &mut h, "/"), Verdict::WrongHost("github".into()));
        assert_eq!(h[AUTHORIZATION], "Bearer nest-ph-github-7f3a", "untouched");

        let mut h = HeaderMap::new();
        assert_eq!(
            run("evil.com", true, true, &secrets(None), &mut h, "https://evil.com/x?t=nest-ph-github-7f3a"),
            Verdict::WrongHost("github".into())
        );
        let mut h = HeaderMap::new();
        h.insert("proxy-authorization", format!("Basic {}", B64.encode("u:nest-ph-github-7f3a")).parse().unwrap());
        assert!(run("evil.com", true, true, &secrets(None), &mut h, "/").blocks());
    }

    #[test]
    fn expired_fenced_or_plaintext_blocks() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(run("github.com", true, true, &secrets(Some(500)), &mut h.clone(), "/"), Verdict::Expired("github".into()));
        assert_eq!(run("github.com", true, false, &secrets(None), &mut h.clone(), "/"), Verdict::Expired("github".into()));
        assert_eq!(run("github.com", true, true, &HashMap::new(), &mut h.clone(), "/"), Verdict::Expired("github".into()));
        assert_eq!(run("github.com", false, true, &secrets(None), &mut h, "/"), Verdict::Plaintext("github".into()));
    }

    fn whole(host: &str, h: &mut HeaderMap) -> Vec<Whole> {
        let b = [binding()];
        apply_whole(&Input { bindings: &b, secrets: &secrets(None), host, tls: true, live: true, now_ms: 1000 }, h, &"/".parse().unwrap()).1
    }

    fn at(header: &str) -> Vec<Whole> {
        vec![Whole { header: header.into(), binding: "github".into() }]
    }

    #[test]
    fn a_header_is_whole_only_when_the_substitution_wrote_all_of_it() {
        // Bearer and Basic replace the Authorization header whole.
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), at("authorization"));
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, format!("Basic {}", B64.encode("x-access-token:nest-ph-github-7f3a")).parse().unwrap());
        assert_eq!(whole("github.com", &mut h), at("authorization"));
        // A named header that was exactly the placeholder.
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), at("x-api-key"));
        // Partly substituted: the rest of the value is the sandbox's.
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "planted nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), vec![]);
        assert_eq!(h["x-api-key"], "planted ghs_REAL");
        // A second field of the header beside the placeholder's: not whole.
        let mut h = HeaderMap::new();
        h.append("x-api-key", "nest-ph-github-7f3a".parse().unwrap());
        h.append("x-api-key", "planted".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), vec![]);
        // Only the substituted field is marked never-indexed; the other one is passed on as it was.
        let fields: Vec<_> = h.get_all("x-api-key").iter().map(|v| (v.to_str().unwrap().to_string(), v.is_sensitive())).collect();
        assert_eq!(fields, [("ghs_REAL".to_string(), true), ("planted".to_string(), false)]);
        // The reviewer's probe: the placeholder in another header, a planted Authorization. Substituted,
        // but Authorization isn't nest's.
        let mut h = HeaderMap::new();
        h.insert("x-api-key", "nest-ph-github-7f3a".parse().unwrap());
        h.insert(AUTHORIZATION, "Bearer planted".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), at("x-api-key"));
        assert_eq!(h[AUTHORIZATION], "Bearer planted");
    }

    #[test]
    fn repeated_authorization_fields_are_whole_only_when_the_placeholder_comes_first() {
        // The placeholder's field first: Bearer substitution replaces every field, the planted one dropped.
        let mut h = HeaderMap::new();
        h.append(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        h.append(AUTHORIZATION, "Bearer planted".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), at("authorization"));
        assert_eq!(h.get_all(AUTHORIZATION).iter().collect::<Vec<_>>(), ["Bearer ghs_REAL"]);
        // The planted field first: nothing replaces it, so Authorization isn't nest's.
        let mut h = HeaderMap::new();
        h.append(AUTHORIZATION, "Bearer planted".parse().unwrap());
        h.append(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), vec![]);
        // One field naming two credentials (a comma-joined list): no substitution, not whole.
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a, Bearer planted".parse().unwrap());
        assert_eq!(whole("github.com", &mut h), vec![]);
    }

    #[test]
    fn a_later_write_into_a_whole_header_unmakes_it() {
        // The first binding writes Authorization whole; the second, at a named-header location
        // `authorization`, then substitutes inside that value (here its placeholder is in the first's
        // secret): what the request carries is no longer what the first wrote.
        let first = InjectionBinding { locations: vec![InjectionLocation::AuthorizationBearer], ..binding() };
        let second = InjectionBinding {
            name: "other".into(),
            placeholder: "nest-ph-other".into(),
            locations: vec![InjectionLocation::Header { name: "authorization".into() }],
            ..binding()
        };
        let sec: HashMap<String, InjectionSecret> = [
            ("github".to_string(), InjectionSecret { binding: "github".into(), value: "A-nest-ph-other".into(), expires_ms: None }),
            ("other".to_string(), InjectionSecret { binding: "other".into(), value: "OTHER".into(), expires_ms: None }),
        ]
        .into();
        let run = |b: &[InjectionBinding]| {
            let mut h = HeaderMap::new();
            h.insert(AUTHORIZATION, "Bearer nest-ph-github-7f3a".parse().unwrap());
            let (_, w) = apply_whole(&Input { bindings: b, secrets: &sec, host: "github.com", tls: true, live: true, now_ms: 1000 }, &mut h, &"/".parse().unwrap());
            (w, h[AUTHORIZATION].to_str().unwrap().to_string())
        };
        assert_eq!(run(std::slice::from_ref(&first)), (at("authorization"), "Bearer A-nest-ph-other".to_string()));
        assert_eq!(run(&[first, second]), (vec![], "Bearer A-OTHER".to_string()));
    }

    #[test]
    fn clean_requests_untouched() {
        let mut h = HeaderMap::new();
        h.insert(AUTHORIZATION, "Bearer user-own-token".parse().unwrap());
        assert_eq!(run("github.com", true, true, &secrets(None), &mut h, "/"), Verdict::Clean);
        assert_eq!(h[AUTHORIZATION], "Bearer user-own-token");
    }
}
